// عميل خدمة دمج الفيديو — Video Merger API v2
// بلا مفاتيح أو توثيق. المخرجات: MP4 (H.264 + AAC) حتى 1080p بجودة CRF 18.
// القواعد الحاسمة:
// 1) POST .../process يُطلق خلفيًا وبمرة واحدة فقط (قفل في الذاكرة + علم محفوظ في params_json)
// 2) أي خطأ HTTP معلن من الخدمة (4xx/5xx بجسم error) = فشل نهائي فوري — لا إعادة محاولة
// 3) أخطاء شبكتنا (timeout/fetch) = مؤقتة → استمر بالاستعلام
// 4) 404 على GET /api/jobs/{id} = فشل نهائي (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)
// 5) progress قد يأتي كسرًا 0..1 → اضربه في 100
import { randomUUID } from "node:crypto";
import { insertTask, getTask, updateTask, parseParams, type TaskRow } from "./tasks";
import { runSql } from "./turso";
import {
  type ToolPayload,
  type Notifier,
  noopNotifier,
  fmtMergeCompleted,
  fmtProcessing,
  fmtFailed,
  fmtNotFound,
  fmtMergeNeedsTwo,
  fmtMergeMaxTen,
  fmtMergeNotPublic,
  fmtMerge24hGone,
} from "./format";

const MERGER_BASE = (process.env.MERGER_API_BASE || "").replace(/\/+$/, "");
const MERGER_MAX_DURATION_MS = 120000;

export function mergerConfigured(): boolean {
  return !!MERGER_BASE && !/x{3,}/i.test(MERGER_BASE) && /^https?:\/\//.test(MERGER_BASE);
}

// قفل في الذاكرة حتى لا يتزامن تنفيذ process مع get_task
const processInFlight = new Set<string>();

const DONE_STATES = new Set(["done", "completed", "complete", "success", "succeeded", "finished"]);
const FAILED_STATES = new Set(["error", "failed", "failure", "cancelled", "canceled"]);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// تحليل دفاعي للتقدم: كسر 0..1 → ×100
function normalizeProgress(p: unknown): number {
  const n = typeof p === "number" && Number.isFinite(p) ? p : 0;
  if (n <= 1) return Math.round(n * 100);
  return Math.round(Math.max(0, Math.min(100, n)));
}

async function mergerFetch(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{
  status: number;
  body: Record<string, unknown> | null;
  networkError?: string;
}> {
  const { timeoutMs = 20000, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${MERGER_BASE}${path}`, { ...rest, signal: ctrl.signal });
    let body: Record<string, unknown> | null = null;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: null, networkError: (e as Error)?.message || "network error" };
  } finally {
    clearTimeout(timer);
  }
}

function isPublicHttpUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const h = parsed.hostname.toLowerCase();
    if (h === "localhost" || h === "::1" || h.endsWith(".local")) return false;
    if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    return true;
  } catch {
    return false;
  }
}

// استخراج رابط النتيجة: فضّل videoUrl ثم downloadUrl ثم اضبط الرابط الافتراضي
function extractVideoUrl(jobId: string, body: Record<string, unknown> | null): string {
  const v = typeof body?.videoUrl === "string" ? body.videoUrl : "";
  const d = typeof body?.downloadUrl === "string" ? body.downloadUrl : "";
  if (v) return v;
  if (d) return d;
  return `${MERGER_BASE}/api/jobs/${jobId}/video`;
}

// إطلاق POST .../process خلفيًا وبمرة واحدة فقط (قفل في الذاكرة + علم في params_json)
async function fireProcessOnce(taskId: string, jobId: string): Promise<void> {
  if (processInFlight.has(jobId)) return;
  processInFlight.add(jobId);
  (async () => {
    try {
      const { status, body, networkError } = await mergerFetch(`/api/jobs/${jobId}/process`, {
        method: "POST",
        timeoutMs: MERGER_MAX_DURATION_MS,
      });
      if (status === 0) {
        // فشل شبكتنا — اسمح بإعادة الإطلاق في المرة القادمة (قد لا يكون الطلب وصل أصلًا)
        await unsetProcessFired(taskId);
        return;
      }
      if (status >= 400) {
        // خطأ معلن من الخدمة = فشل نهائي فوري
        const msg = String(body?.error || `HTTP ${status}`);
        await updateTask(taskId, { status: "failed", error_message: `خدمة الدمج: ${msg}` });
        return;
      }
      if (body?.status && DONE_STATES.has(String(body.status))) {
        await completeMergeTask(taskId, jobId, body);
      }
      // 202 أو غيره → استطلاع get_task هو من يتابع
    } catch {
      await unsetProcessFired(taskId);
    } finally {
      processInFlight.delete(jobId);
    }
  })();
}

async function unsetProcessFired(taskId: string) {
  const task = await getTask(taskId);
  if (!task) return;
  const params = parseParams(task);
  if (params.processFired) {
    params.processFired = false;
    await updateTask(taskId, { params });
  }
}

async function completeMergeTask(taskId: string, jobId: string, body: Record<string, unknown>): Promise<TaskRow> {
  const url = extractVideoUrl(jobId, body);
  const size = typeof body.size === "number" ? body.size : undefined;
  const duration = typeof body.duration === "number" ? body.duration : undefined;
  const resolution = typeof body.resolution === "string" ? body.resolution : undefined;
  return (
    (await updateTask(taskId, {
      status: "completed",
      progress: 100,
      result_urls: [url],
      params: { ...(await parseParamsTask(taskId)), resultSize: size, resultDuration: duration, resultResolution: resolution },
    })) as TaskRow
  );
}

async function parseParamsTask(taskId: string): Promise<Record<string, unknown>> {
  const t = await getTask(taskId);
  return t ? parseParams(t) : {};
}

// تحديث من GET /api/jobs/{id} — يعيد الحالة المحدثة ويصنف الأخطاء دفاعيًا
async function pollMergeOnce(task: TaskRow, notify?: Notifier): Promise<TaskRow> {
  const jobId = task.provider_task_id!;
  const params = parseParams(task);

  // إن لم يُنفَّذ process بعد نفّذه الآن (يدعم الاستئناف بعد انقطاع)
  if (!params.processFired) {
    await setProcessFired(task.id, params);
    await fireProcessOnce(task.id, jobId);
  }

  const { status, body, networkError } = await mergerFetch(`/api/jobs/${jobId}`);
  if (status === 0) return task; // شبكتنا → مؤقت، استمر بالاستعلام
  if (status === 404) {
    return (
      (await updateTask(task.id, { status: "failed", error_message: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)" })) ??
      task
    );
  }
  if (status >= 400) {
    // الجسم قد يحوي error بدون status → عاملها failed فورًا (فشل حتمي)
    const msg = String(body?.error || `HTTP ${status}`);
    return (await updateTask(task.id, { status: "failed", error_message: `خدمة الدمج: ${msg}` })) ?? task;
  }
  const raw = body?.status ? String(body.status) : "";
  if (body?.error && !raw) {
    return (await updateTask(task.id, { status: "failed", error_message: `خدمة الدمج: ${String(body.error)}` })) ?? task;
  }
  if (raw && DONE_STATES.has(raw)) {
    return await completeMergeTask(task.id, jobId, body ?? {});
  }
  if (raw && FAILED_STATES.has(raw)) {
    const msg = String(body?.error || "فشل الدمج لدى الخدمة");
    return (await updateTask(task.id, { status: "failed", error_message: `خدمة الدمج: ${msg}` })) ?? task;
  }
  const pct = normalizeProgress(body?.progress);
  const updated = pct > task.progress ? ((await updateTask(task.id, { progress: pct })) ?? task) : task;
  if (notify) await notify(updated.progress, 100, `قيد الدمج… ${updated.progress}%`);
  return updated;
}

async function setProcessFired(taskId: string, params: Record<string, unknown>) {
  if (params.processFired) return;
  await updateTask(taskId, { params: { ...params, processFired: true } });
}

// أداة merge_videos — التحقق الصارم ثم الإنشاء والانتظار
export async function runMerge(args: Record<string, unknown>, notify: Notifier = noopNotifier): Promise<ToolPayload> {
  if (!mergerConfigured()) {
    return { text: "❌ خدمة الدمج غير مُهيّأة — اضبط متغير البيئة MERGER_API_BASE في إعدادات السيرفر.", isError: true };
  }
  const waitSeconds = (() => {
    const n = typeof args.wait_seconds === "number" ? Math.round(args.wait_seconds) : NaN;
    return Number.isNaN(n) ? 60 : Math.max(0, Math.min(240, n));
  })();

  const directUrls = Array.isArray(args.urls) ? args.urls.map(String) : [];
  const taskIds = Array.isArray(args.task_ids) ? args.task_ids.map(String) : [];

  // حلّ روابط task_ids بالترتيب من قاعدة البيانات (مهام فيديو مكتملة فقط)
  const resolved: string[] = [];
  const failedDetails: string[] = [];
  for (const tid of taskIds) {
    const t = await getTask(tid);
    if (!t) {
      failedDetails.push(`- ${tid}: مهمة غير موجودة`);
      continue;
    }
    if (t.type !== "video") {
      failedDetails.push(`- ${tid}: النوع ${t.type} وليس video`);
      continue;
    }
    if (t.status !== "completed" || !t.result_urls_json) {
      failedDetails.push(`- ${tid}: الحالة ${t.status} (تُقبل المهمة المكتملة فقط)`);
      continue;
    }
    const urls = JSON.parse(t.result_urls_json);
    if (!urls?.length) {
      failedDetails.push(`- ${tid}: لا روابط مخزنة`);
      continue;
    }
    resolved.push(urls[0]);
  }

  const allUrls = [...resolved, ...directUrls];

  if (allUrls.length < 2) {
    return fmtMergeNeedsTwo(failedDetails.join("\n"));
  }
  if (allUrls.length > 10) {
    return fmtMergeMaxTen();
  }
  for (const u of allUrls) {
    if (!isPublicHttpUrl(u)) return fmtMergeNotPublic(u);
  }

  // سجّل مهمة الدمج في Turso أولًا
  const taskId = randomUUID();
  let task = await insertTask({
    id: taskId,
    model: "video-merger",
    type: "merge",
    prompt: `دمج ${allUrls.length} مقاطع`,
    params: { videos: allUrls, processFired: false, createRetryAt: null },
  });

  task = await createMergeJob(task);

  if (task.status === "failed") return fmtFailed(task.error_message || "فشل إنشاء مهمة الدمج");

  // نافذة الانتظار: استعلم كل 3 ثوانٍ مع بث التقدم
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    task = await pollMergeOnce(task, notify);
    if (task.status === "completed") return fmtMergeCompleted(task.result_urls_json ? JSON.parse(task.result_urls_json) : []);
    if (task.status === "failed") return fmtFailed(task.error_message || "فشل الدمج");
    await sleep(3000);
  }
  return fmtProcessing(task);
}

// إنشاء مهمة الدمج لدى الخدمة (POST /api/jobs) — فشل الشبكة قابل لإعادة المحاولة عبر get_task
async function createMergeJob(task: TaskRow): Promise<TaskRow> {
  const params = parseParams(task);
  const videos = (params.videos as string[]) || [];
  const { status, body, networkError } = await mergerFetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos }),
  });

  if (status === 0) {
    // شبكتنا → تبقى processing وتعاد المحاولة مع كل get_task (بتهدئة قصيرة)
    return (
      (await updateTask(task.id, {
        error_message: "بانتظار الاتصال بخدمة الدمج…",
        params: { ...params, createRetryAt: Date.now() + 15000 },
      })) ?? task
    );
  }
  if (status >= 400) {
    const msg = String(body?.error || `HTTP ${status}`);
    return (await updateTask(task.id, { status: "failed", error_message: `خدمة الدمج: ${msg}` })) ?? task;
  }
  const jobId = body?.jobId ? String(body.jobId) : "";
  if (!jobId) {
    return (await updateTask(task.id, { status: "failed", error_message: "خدمة الدمج: استجابة بلا jobId" })) ?? task;
  }
  const updated = await updateTask(task.id, {
    provider: "merger",
    provider_task_id: jobId,
    status: "processing",
    progress: 3,
  });
  // أطلق process خلفيًا وبمرة واحدة فقط
  await setProcessFired(task.id, { ...params });
  await fireProcessOnce(task.id, jobId);
  return updated ?? task;
}

// تتبع مهمة دمج بمعرّفها (get_task) — تحديث حي من خدمة الدمج
export async function refreshMergeTask(task: TaskRow): Promise<ToolPayload> {
  if (task.status === "completed" && task.result_urls_json) {
    return fmtMergeCompleted(JSON.parse(task.result_urls_json));
  }
  if (task.status === "failed") return fmtFailed(task.error_message || "سبب غير معروف");

  const params = parseParams(task);

  // لم تُنشأ بعد لدى الخدمة (فشل شبكة سابق) → أعد المحاولة بعد التهدئة
  if (!task.provider_task_id) {
    const retryAt = typeof params.createRetryAt === "number" ? params.createRetryAt : 0;
    if (Date.now() < retryAt) return fmtProcessing(task);
    const updated = await createMergeJob(task);
    if (updated.status === "failed") return fmtFailed(updated.error_message || "فشل إنشاء مهمة الدمج");
    return fmtProcessing(updated);
  }

  const updated = await pollMergeOnce(task);
  if (updated.status === "completed" && updated.result_urls_json) {
    return fmtMergeCompleted(JSON.parse(updated.result_urls_json));
  }
  if (updated.status === "failed") return fmtFailed(updated.error_message || "سبب غير معروف");
  return fmtProcessing(updated);
}
