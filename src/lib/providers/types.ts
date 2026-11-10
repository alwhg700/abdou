// أنواع مشتركة لمزودي التوليد — كل خطأ يُرمى كـ ProviderError ليُصنَّف لاحقًا
export interface ProviderError extends Error {
  status: number; // 0 = خطأ شبكة/مهلة من عندنا
  message: string;
  network?: boolean;
}

export function makeProviderError(status: number, message: string): ProviderError {
  const err = new Error(message) as ProviderError;
  err.status = status;
  err.network = status === 0;
  return err;
}

export interface CreateResult {
  providerTaskId: string;
}

export interface CheckResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number;
}

export interface ProviderAdapter {
  // مهمة غير متزامنة (فيديو، وبعض الصور): تعيد providerTaskId
  createTask(key: string, providerModel: string, input: Record<string, unknown>): Promise<CreateResult>;
  // صور متزامنة إن كان المزود يدعمها (CometAPI تعيد النتيجة فورًا)
  createImageSync?(key: string, input: Record<string, unknown>): Promise<{ urls: string[] }>;
  // استعلام حالة مهمة جارية
  checkTask(key: string, providerTaskId: string): Promise<CheckResult>;
}

// غلاف fetch موحّد مع مهلة — أخطاء الشبكة/المهلة تصبح ProviderError بحالة 0
export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const { timeoutMs = 30000, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: ctrl.signal });
  } catch (e) {
    throw makeProviderError(0, `network error: ${(e as Error)?.message || e}`);
  } finally {
    clearTimeout(timer);
  }
}
