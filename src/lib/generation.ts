// منسّق التوليد — منطق التبديل التسلسلي «لا توقف أبدًا»
// القواعد:
// 1) المرشحون يُجرَّبون بالترتيب الصارم (ترتيب الإضافة)
// 2) عند خطأ مفتاح/رصيد: انتقال تلقائي للمفتاح التالي واستئناف نفس المهمة بنفس task_id
// 3) نموذج الذكاء الاصطناعي لا يرى أخطاء مفاتيح/رصيد أبدًا
// 4) مهمة فشلت على كل المفاتيح تبقى processing وتُعاد مع كل get_task (بتهدئة ~45 ثانية)
import { randomUUID } from "node:crypto";
import {
  getKeyPool,
  bumpKeyUsage,
  classifyProviderError,
  type KeyRow,
  type ErrorClass,
  type ProviderId,
} from "./keys";
import { normalizeModel, findModelByCanonical, modelProviderModel, type ModelDef } from "./models";
import {
  insertTask,
  getTask,
  updateTask,
  parseParams,
  type TaskRow,
  type AttemptRecord,
} from "./tasks";
import { kieAdapter } from "./providers/kie";
import { cometapiAdapter } from "./providers/cometapi";
import { type ProviderAdapter, type ProviderError } from "./providers/types";
import {
  type ToolPayload,
  type Notifier,
  noopNotifier,
  fmtImageCompleted,
  fmtVideoCompleted,
  fmtProcessing,
  fmtFailed,
  fmtNotFound,
  fmtNoKeys,
  fmtUnknownModel,
} from "./format";

const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometapiAdapter,
};

// أنماط أخطاء مفتاح/رصيد في منتصف المهمة (قسم 4.3.2)
const RE_KEYISH = /(insufficient|balance|credit|quota|402|401|unauthorized|exhausted|充值|forbidden|invalid\s*api\s*key)/i;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// بناء مدخلات المزود حسب نوع الموديل
function buildProviderInput(model: ModelDef, args: Record<string, unknown>, providerModel: string) {
  if (model.type === "image") {
    return {
      prompt: String(args.prompt ?? ""),
      aspect_ratio: args.aspect_ratio ?? "auto",
      resolution: args.resolution ?? "1K",
      background: args.background,
      output_format: args.output_format ?? "png",
      model: providerModel, // يحتاجه المزود المتزامن (CometAPI)
    };
  }
  return {
    prompt: String(args.prompt ?? ""),
    image_url: args.image_url,
    aspect_ratio: args.aspect_ratio ?? "auto",
    resolution: args.resolution ?? "480p",
    enable_audio: args.enable_audio !== false,
    duration: typeof args.duration === "number" ? Math.max(1, Math.min(15, Math.round(args.duration))) : 8,
  };
}

interface CreationOk {
  ok: true;
  key: KeyRow;
  provider: ProviderId;
  providerTaskId?: string;
  syncUrls?: string[];
}
interface CreationFail {
  ok: false;
  paramsError?: string;
}
type CreationOutcome = CreationOk | CreationFail;

// محاولة إنشاء المهمة على المرشحين بدءًا من startIndex بالترتيب — تسجل كل محاولة وعدّادات كل مفتاح
async function attemptCreation(
  taskId: string,
  model: ModelDef,
  args: Record<string, unknown>,
  keys: KeyRow[],
  startIndex: number
): Promise<CreationOutcome> {
  for (let i = startIndex; i < keys.length; i++) {
    const key = keys[i];
    const provider = key.provider as ProviderId;
    const adapter = ADAPTERS[provider];
    const providerModel = modelProviderModel(model, provider);
    const input = buildProviderInput(model, args, providerModel);
    const baseAttempt: AttemptRecord = {
      provider,
      keyId: key.id,
      keyLabel: key.label || "",
      ok: false,
      at: new Date().toISOString(),
    };

    // صور CometAPI متزامنة؛ البقية مهام غير متزامنة
    const useSync = model.type === "image" && typeof adapter.createImageSync === "function";

    try {
      if (useSync) {
        const { urls } = await adapter.createImageSync!(key.api_key, input);
        await bumpKeyUsage(key.id, true);
        await updateTask(taskId, {
          attempt: { ...baseAttempt, ok: true },
          provider,
          key_id: key.id,
          status: "completed",
          progress: 100,
          result_urls: urls,
        });
        return { ok: true, key, provider, syncUrls: urls };
      } else {
        const { providerTaskId } = await adapter.createTask(key.api_key, providerModel, input);
        await bumpKeyUsage(key.id, true);
        await updateTask(taskId, {
          attempt: { ...baseAttempt, ok: true },
          provider,
          provider_task_id: providerTaskId,
          key_id: key.id,
          status: "processing",
          progress: 5,
        });
        return { ok: true, key, provider, providerTaskId };
      }
    } catch (e) {
      const pe = e as ProviderError;
      const cls: ErrorClass = classifyProviderError(pe?.status ?? 0, pe?.message ?? String(e));
      await bumpKeyUsage(key.id, false, { errorClass: cls, error: pe?.message });
      await updateTask(taskId, {
        attempt: { ...baseAttempt, ok: false, errorClass: cls, error: String(pe?.message || e).slice(0, 400) },
      });
      // خطأ معطيات → توقف فوري (تبديل المفاتيح لن يحل خطأ المعطيات)
      if (cls === "params") return { ok: false, paramsError: pe?.message || "معطيات الطلب مرفوضة" };
      // disabled / exhausted / provider / temporary → انتقل للمفتاح التالي
      continue;
    }
  }
  return { ok: false };
}

// استعلام حالة مهمة توليد جارية وتحديثها حية (يُستخدم في نافذة الانتظار وفي get_task)
export async function pollGenerationOnce(
  task: TaskRow,
  model: ModelDef,
  args: Record<string, unknown>,
  keys: KeyRow[]
): Promise<TaskRow> {
  const provider = task.provider as ProviderId;
  const adapter = ADAPTERS[provider];
  const key = keys.find((k) => k.id === task.key_id);
  if (!adapter || !task.provider_task_id || !key) return task;

  let check;
  try {
    check = await adapter.checkTask(key.api_key, task.provider_task_id);
  } catch (e) {
    // خطأ شبكة/مهلة أثناء الفحص → مؤقت؛ تبقى المهمة كما هي
    return task;
  }

  if (check.status === "completed" && check.urls?.length) {
    return (await updateTask(task.id, { status: "completed", progress: 100, result_urls: check.urls })) ?? task;
  }

  if (check.status === "failed") {
    const msg = String(check.error || "فشل غير معروف لدى المزود");
    if (RE_KEYISH.test(msg)) {
      // فشل مرتبط بمفتاح/رصيد في منتصف المهمة → أعد إنشاء نفس المهمة بنفس task_id على المفتاح التالي
      const cursor = keys.findIndex((k) => k.id === task.key_id);
      const outcome = await attemptCreation(task.id, model, args, keys, cursor + 1);
      if (outcome.ok) return (await getTask(task.id)) ?? task;
      if (!outcome.ok && outcome.paramsError) {
        return (
          (await updateTask(task.id, { status: "failed", error_message: `معطيات الطلب مرفوضة: ${outcome.paramsError}` })) ??
          task
        );
      }
      // لا مفاتيح متبقية → تبقى processing بانتظار مفتاح صالح (بتهدئة 45 ثانية)
      const params = parseParams(task);
      return (
        (await updateTask(task.id, {
          status: "processing",
          error_message: "بانتظار توفر مفتاح صالح…",
          params: { ...params, nextKeyRetryAt: Date.now() + 45000, keyCursor: keys.length },
        })) ?? task
      );
    }
    // فشل حقيقي (انتهاك سياسة/معطيات لدى المزود)
    return (await updateTask(task.id, { status: "failed", error_message: msg })) ?? task;
  }

  // قيد المعالجة → حدّث التقدم
  const pct = check.progress ?? Math.max(task.progress, 30);
  if (pct > task.progress) {
    return (await updateTask(task.id, { progress: pct })) ?? task;
  }
  return task;
}

// إعادة إنشاء المهمة على كل المفاتيح (تُستدعى من get_task بعد التهدئة)
async function retryCreation(task: TaskRow, model: ModelDef, args: Record<string, unknown>): Promise<TaskRow> {
  // أعد قراءة المجموعة من جديد — قد تكون أُضيفت مفاتيح جديدة أو شُحن رصيد
  const keys = await getKeyPool(model.providers);
  if (!keys.length) return task;
  const outcome = await attemptCreation(task.id, model, args, keys, 0);
  if (outcome.ok) return (await getTask(task.id)) ?? task;
  if (outcome.paramsError) {
    return (await updateTask(task.id, { status: "failed", error_message: `معطيات الطلب مرفوضة: ${outcome.paramsError}` })) ?? task;
  }
  const params = parseParams(task);
  return (
    (await updateTask(task.id, {
      error_message: "بانتظار توفر مفتاح صالح…",
      params: { ...params, nextKeyRetryAt: Date.now() + 45000 },
    })) ?? task
  );
}

// نافذة الانتظار القصيرة مع بث التقدم (~كل 3 ثوانٍ)
async function waitWindow(
  task: TaskRow,
  model: ModelDef,
  args: Record<string, unknown>,
  keys: KeyRow[],
  waitSeconds: number,
  notify: Notifier
): Promise<TaskRow> {
  const deadline = Date.now() + waitSeconds * 1000;
  let current = task;
  while (Date.now() < deadline) {
    current = await pollGenerationOnce(current, model, args, keys);
    if (current.status === "completed" || current.status === "failed") return current;
    const msg =
      current.status === "processing" && current.provider_task_id
        ? `قيد التوليد… ${current.progress}%`
        : "بانتظار توفر مفتاح صالح…";
    await notify(current.progress, 100, msg);
    await sleep(3000);
  }
  return current;
}

function clampWait(v: unknown, dflt: number): number {
  const n = typeof v === "number" ? Math.round(v) : NaN;
  if (Number.isNaN(n)) return dflt;
  return Math.max(0, Math.min(240, n));
}

// نقطة الدخول لأداتي generate_image / generate_video
export async function runGeneration(
  type: "image" | "video",
  args: Record<string, unknown>,
  notify: Notifier = noopNotifier
): Promise<ToolPayload> {
  const model = normalizeModel(args.model as string) ?? (type === "image" ? normalizeModel("gpt-image-2-6/flare-text-to-image") : normalizeModel("grok-imagine-video-1-5-preview"));
  if (!model || model.type !== type) return fmtUnknownModel(String(args.model ?? "?"));

  const prompt = String(args.prompt ?? "").trim();
  if (!prompt) return { text: "❌ الوصف (prompt) مطلوب ولا يمكن أن يكون فارغًا.", isError: true };

  const waitSeconds = clampWait(args.wait_seconds, type === "image" ? 90 : 25);

  // سجّل المهمة في Turso قبل أي نداء خارجي — تبقى قابلة للتتبع حتى لو انقطع الاتصال
  const keys = await getKeyPool(model.providers);
  if (!keys.length) return fmtNoKeys(model.canonical);

  const task = await insertTask({
    id: randomUUID(),
    model: model.canonical,
    type,
    prompt,
    params: { ...args, wait_seconds: waitSeconds, nextKeyRetryAt: null, keyCursor: 0 },
  });

  const outcome = await attemptCreation(task.id, model, args, keys, 0);
  if (!outcome.ok) {
    const fresh = (await getTask(task.id)) ?? task;
    if (outcome.paramsError) {
      // خطأ معطيات — فشل حقيقي يُعرض للعميل (لا علاقة له بالمفاتيح)
      await updateTask(task.id, {
        status: "failed",
        error_message: `معطيات الطلب مرفوضة: ${outcome.paramsError}`,
      });
      return fmtFailed(`معطيات الطلب مرفوضة: ${outcome.paramsError}`);
    }
    // فشل على كل المفاتيح → تبقى processing وتُعاد المحاولة تلقائيًا مع كل get_task
    return fmtProcessing(fresh);
  }

  if (outcome.syncUrls) {
    const done = (await getTask(task.id)) ?? task;
    return fmtImageCompleted(done.result_urls_json ? JSON.parse(done.result_urls_json) : outcome.syncUrls);
  }

  const final = await waitWindow((await getTask(task.id)) ?? task, model, args, keys, waitSeconds, notify);
  if (final.status === "completed") {
    const urls = final.result_urls_json ? JSON.parse(final.result_urls_json) : [];
    return type === "image" ? fmtImageCompleted(urls) : fmtVideoCompleted(urls);
  }
  if (final.status === "failed") return fmtFailed(final.error_message || "سبب غير معروف");
  return fmtProcessing(final);
}

// تتبع أي مهمة بمعرّفها — تحديث حي من المزود ثم صياغة عربية
export async function refreshTask(taskId: string): Promise<ToolPayload> {
  let task = await getTask(taskId);
  if (!task) return fmtNotFound(taskId);

  if (task.status === "completed" || task.status === "failed") {
    const urls = task.result_urls_json ? JSON.parse(task.result_urls_json) : [];
    if (task.status === "completed" && task.type === "image") return fmtImageCompleted(urls);
    if (task.status === "completed" && task.type === "video") return fmtVideoCompleted(urls);
    if (task.status === "completed" && task.type === "merge") {
      return {
        text: `✅ تم دمج المقاطع بنجاح\n\nالرابط المباشر:\n${urls.map((u: string) => `- ${u}`).join("\n")}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`,
      };
    }
    return fmtFailed(task.error_message || "سبب غير معروف");
  }

  const params = parseParams(task);

  // مهمة دمج → منطق الدمج
  if (task.type === "merge") {
    const { refreshMergeTask } = await import("./merger");
    return refreshMergeTask(task);
  }

  const model = findModelByCanonical(task.model);
  if (!model) return fmtFailed(`موديل غير معروف في السجل: ${task.model}`);

  // مهمة جارية بلا مهمة مزود → بانتظار مفتاح صالح (بتهدئة ~45 ثانية)
  if (!task.provider_task_id) {
    const retryAt = typeof params.nextKeyRetryAt === "number" ? params.nextKeyRetryAt : 0;
    if (Date.now() < retryAt) return fmtProcessing(task);
    task = await retryCreation(task, model, params);
    return task.status === "completed" && task.result_urls_json
      ? fmtImageCompleted(JSON.parse(task.result_urls_json))
      : fmtProcessing(task);
  }

  // مهمة جارية لدى مزود → فحص حي واحد
  const keys = await getKeyPool(model.providers);
  task = await pollGenerationOnce(task, model, params, keys);
  if (task.status === "completed" && task.result_urls_json) {
    const urls = JSON.parse(task.result_urls_json);
    return task.type === "image" ? fmtImageCompleted(urls) : fmtVideoCompleted(urls);
  }
  if (task.status === "failed") return fmtFailed(task.error_message || "سبب غير معروف");
  return fmtProcessing(task);
}
