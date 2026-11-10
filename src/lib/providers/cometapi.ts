// مزود CometAPI — الشكل الرسمي من التوثيق المقاس (apidoc.cometapi.com):
// الصور: POST /v1/images/generations (متوافق مع OpenAI) — تعيد النتيجة فورًا (url أو b64_json)
// الفيديو: POST /grok/v1/videos/generations → {"request_id":"..."}
//          GET  /grok/v1/videos/{request_id} → {"status":"pending|done|failed|expired","progress":35,
//               "video":{"url":"..."},"error":...}
import { type ProviderAdapter, makeProviderError, fetchWithTimeout } from "./types";

const BASE = "https://api.cometapi.com";

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function errFromOpenAIish(res: Response, body: Record<string, unknown> | null): never {
  // أخطاء OpenAI-Compatible: {"error":{"message","type","code"}} أو {"message": "..."}
  const e = body?.error as { message?: string; code?: number | string } | string | undefined;
  let msg = "";
  let status = res.status;
  if (typeof e === "string") msg = e;
  else if (e && typeof e === "object") {
    msg = e.message || "";
    const c = typeof e.code === "string" ? parseInt(e.code, 10) : e.code;
    if (typeof c === "number" && !Number.isNaN(c)) status = c;
  }
  if (!msg) msg = (body?.message as string) || `HTTP ${res.status}`;
  throw makeProviderError(status, msg);
}

export const cometapiAdapter: ProviderAdapter = {
  async createTask(key, providerModel, input) {
    // فيديو grok imagine — وفق التوثيق الرسمي
    const payload: Record<string, unknown> = {
      model: providerModel,
      prompt: input.prompt,
      duration: input.duration ?? 8,
      aspect_ratio: input.aspect_ratio && input.aspect_ratio !== "auto" ? input.aspect_ratio : "16:9",
      resolution: input.resolution ?? "480p",
    };
    if (input.image_url) payload.image = { url: input.image_url };

    let res: Response;
    try {
      res = await fetchWithTimeout(`${BASE}/grok/v1/videos/generations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        timeoutMs: 30000,
      });
    } catch (e) {
      throw e;
    }
    const body = await readJson(res);
    if (!res.ok) errFromOpenAIish(res, body);
    const requestId = body?.request_id ?? body?.taskId ?? body?.id;
    if (!requestId) throw makeProviderError(502, "cometapi: missing request_id in response");
    return { providerTaskId: String(requestId) };
  },

  async createImageSync(key, input) {
    // صور متزامنة عبر نقطة متوافقة مع OpenAI — نمرر فقط ما يدعمه
    const payload: Record<string, unknown> = {
      model: input.model,
      prompt: input.prompt,
      n: 1,
    };
    if (input.aspect_ratio && input.aspect_ratio !== "auto") payload.aspect_ratio = input.aspect_ratio;
    if (input.resolution) payload.resolution = input.resolution;

    let res: Response;
    try {
      res = await fetchWithTimeout(`${BASE}/v1/images/generations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        timeoutMs: 120000,
      });
    } catch (e) {
      throw e;
    }
    const body = await readJson(res);
    if (!res.ok) errFromOpenAIish(res, body);
    const data = body?.data as Array<{ url?: string; b64_json?: string }> | undefined;
    const urls = (data || []).map((d) => d.url).filter((u): u is string => typeof u === "string" && !!u);
    // ملاحظة: لا ننزّل أي وسائط — إذا أعاد المزود b64 فقط دون رابط نتعامل معها كخطأ مؤقت
    // (قاعدة ذهبية: روابط فقط في قاعدة البيانات)
    if (!urls.length) throw makeProviderError(502, "cometapi: no image url in response (b64-only not supported)");
    return { urls };
  },

  async checkTask(key, providerTaskId) {
    let res: Response;
    try {
      res = await fetchWithTimeout(`${BASE}/grok/v1/videos/${encodeURIComponent(providerTaskId)}`, {
        headers: { Authorization: `Bearer ${key}` },
        timeoutMs: 20000,
      });
    } catch (e) {
      throw e;
    }
    const body = await readJson(res);
    if (!res.ok) errFromOpenAIish(res, body);

    const status = String(body?.status || "pending");
    const progress = typeof body?.progress === "number" ? body.progress : undefined;
    const video = body?.video as { url?: string } | undefined;
    const error = body?.error;

    if (status === "done") {
      const url = video?.url;
      if (!url) return { status: "failed", error: "cometapi: done بدون رابط فيديو" };
      return { status: "completed", urls: [url], progress: 100 };
    }
    if (status === "failed" || status === "expired") {
      const msg =
        typeof error === "string" ? error : (error as { message?: string })?.message || `cometapi: ${status}`;
      return { status: "failed", error: msg };
    }
    return { status: "processing", progress: progress ?? 30 };
  },
};
