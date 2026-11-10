// مزود kie.ai — Jobs API الموحد
// الأشكال المقاسة فعليًا بـ curl (التزم بها ولا تخترع حقولًا):
// POST /api/v1/jobs/createTask → {"code":200,"msg":"success","data":{"taskId":"..."}}
// GET  /api/v1/jobs/recordInfo?taskId= → {"code":200,"data":{"state":"waiting|queuing|generating|success|fail",
//        "resultJson":"{\"resultUrls\":[\"https://...\"]}", "failMsg":"..."}}
// انتبه: resultJson نص JSON داخل JSON يحتاج JSON.parse ثانيًا، وقد يرد الجسم بحالة HTTP 200 مع code داخلية != 200
import { type ProviderAdapter, makeProviderError, fetchWithTimeout } from "./types";

const BASE = "https://api.kie.ai";

interface KieBody {
  code?: number;
  msg?: string;
  data?: {
    taskId?: string;
    state?: string;
    resultJson?: string;
    failMsg?: string;
    progress?: number;
  } | null;
}

async function readBody(res: Response): Promise<KieBody | null> {
  try {
    return (await res.json()) as KieBody;
  } catch {
    return null;
  }
}

export const kieAdapter: ProviderAdapter = {
  async createTask(key, providerModel, input) {
    let res: Response;
    try {
      res = await fetchWithTimeout(`${BASE}/api/v1/jobs/createTask`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: providerModel, input }),
        timeoutMs: 30000,
      });
    } catch (e) {
      throw e; // ProviderError بحالة 0 (شبكة) — يُصنَّف temporary
    }
    const body = await readBody(res);
    // الشكل الفعلي: code/msg/data — نعتبر code الداخلية هي الحالة الفعلية
    const effective = body?.code ?? (res.ok ? 200 : res.status);
    if (effective !== 200) {
      throw makeProviderError(effective, body?.msg || `HTTP ${res.status}`);
    }
    const taskId = body?.data?.taskId;
    if (!taskId) throw makeProviderError(502, "kie: missing taskId in response");
    return { providerTaskId: taskId };
  },

  async checkTask(key, providerTaskId) {
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`,
        {
          headers: { Authorization: `Bearer ${key}` },
          timeoutMs: 20000,
        }
      );
    } catch (e) {
      throw e;
    }
    const body = await readBody(res);
    const effective = body?.code ?? (res.ok ? 200 : res.status);
    if (effective !== 200) {
      // فحص recordInfo قد يفشل مؤقتًا (مثلًا 422 recordInfo is null أثناء الإنشاء) — نرمي للتصنيف
      throw makeProviderError(effective, body?.msg || `HTTP ${res.status}`);
    }
    const d = body?.data ?? {};
    const state = String(d.state || "waiting");

    if (state === "success") {
      // resultJson نص JSON داخل JSON — تحليل ثانٍ دفاعي
      let urls: string[] = [];
      try {
        if (d.resultJson) {
          const parsed = JSON.parse(d.resultJson);
          if (Array.isArray(parsed?.resultUrls)) urls = parsed.resultUrls.filter((u: unknown) => typeof u === "string");
        }
      } catch {
        /* تجاهل — نفحص بدائل أدناه */
      }
      if (!urls.length) return { status: "failed", error: "kie: success بدون روابط نتيجة قابلة للقراءة" };
      return { status: "completed", urls, progress: 100 };
    }

    if (state === "fail") {
      return { status: "failed", error: d.failMsg || "kie: فشل التوليد لدى المزود" };
    }

    // waiting | queuing | generating — تقدّم تقديري حسب الحالة
    const progress = state === "generating" ? 55 : state === "queuing" ? 12 : 5;
    return { status: "processing", progress };
  },
};
