// نظام المفاتيح المتسلسلة — قلب المشروع
// القواعد الذهبية:
// 1) الترتيب تسلسلي صارم بترتيب الإضافة (created_at ASC, id ASC) — ليس round-robin
// 2) المفتاح المستنزف (exhausted) يبقى في القاعدة ولا يُستبعد — التعطيل اليدوي فقط يُقصي
// 3) إخفاء المفاتيح إلزامي في كل الاستجابات (maskKey)
import { randomUUID } from "node:crypto";
import { queryRows, runSql, ensureSchema } from "./turso";

export type ProviderId = "kie" | "cometapi";
export type KeyStatus = "active" | "exhausted" | "disabled";

export interface KeyRow {
  id: string;
  provider: ProviderId;
  label: string;
  api_key: string;
  status: KeyStatus;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

// جلب المفاتيح غير المعطّلة لهذه المزودات بالترتيب التسلسلي الصارم
export async function getKeyPool(providers: string[]): Promise<KeyRow[]> {
  await ensureSchema();
  const placeholders = providers.map(() => "?").join(", ");
  const rows = await queryRows(
    `SELECT * FROM api_keys
     WHERE status != 'disabled' AND provider IN (${placeholders})
     ORDER BY created_at ASC, id ASC`,
    providers
  );
  return rows as unknown as KeyRow[];
}

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

const RE_EXHAUSTED = /(insufficient|quota|balance|credit|out\s*of\s*credits|exhausted|充值|欠费|余额)/i;
const RE_DISABLED = /(invalid\s*api\s*key|incorrect\s*api\s*key|unauthorized|forbidden|authentication|api\s*key\s*(is\s*)?(invalid|expired|not\s*valid))/i;
const RE_MODEL = /(model\s*not\s*found|unsupported\s*model|no\s*such\s*model|model\s*does\s*not\s*exist|not\s*found.*model)/i;

// تصنيف موحد لأخطاء المزودين — الترتيب مهم:
// نفاد الرصيد يُفحص قبل 400 لأن بعض المزودين يرسلونه بحالة 400
export function classifyProviderError(status: number, message: string): ErrorClass {
  const msg = String(message || "");
  if (status === 402 || RE_EXHAUSTED.test(msg)) return "exhausted";
  if (status === 401 || status === 403 || RE_DISABLED.test(msg)) return "disabled";
  if ([400, 404, 422].includes(status) && RE_MODEL.test(msg)) return "provider";
  if (status === 400 || status === 422) return "params";
  // 429 / 5xx / انقطاع شبكة / مهلة / إلغاء → مؤقت
  return "temporary";
}

// تحديث عدّادات المفتاح دائمًا (نجاح أو فشل) + تسجيل آخر خطأ
export async function bumpKeyUsage(
  keyId: string,
  ok: boolean,
  opts: { errorClass?: ErrorClass; error?: string } = {}
): Promise<void> {
  await ensureSchema();
  await runSql(
    `UPDATE api_keys SET
       usage_count = usage_count + 1,
       success_count = success_count + ?,
       fail_count = fail_count + ?,
       last_used_at = datetime('now'),
       last_checked_at = datetime('now'),
       last_error = ?,
       status = CASE
         WHEN ? = 'disabled' THEN 'disabled'
         WHEN ? = 'exhausted' THEN 'exhausted'
         ELSE status END
     WHERE id = ?`,
    [
      ok ? 1 : 0,
      ok ? 0 : 1,
      ok ? null : String(opts.error || "").slice(0, 500),
      opts.errorClass === "disabled" ? "disabled" : "",
      opts.errorClass === "exhausted" ? "exhausted" : "",
      keyId,
    ]
  );
}

export async function listKeys(): Promise<KeyRow[]> {
  await ensureSchema();
  const rows = await queryRows("SELECT * FROM api_keys ORDER BY created_at ASC, id ASC");
  return rows as unknown as KeyRow[];
}

export async function addKey(provider: ProviderId, apiKey: string, label: string): Promise<KeyRow> {
  await ensureSchema();
  // رفض التكرار لنفس المزود
  const dup = await queryRows(
    "SELECT id FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1",
    [provider, apiKey]
  );
  if (dup.length) {
    throw new Error("DUPLICATE_KEY: هذا المفتاح مُضاف مسبقًا لنفس المزود");
  }
  const id = randomUUID();
  await runSql(
    "INSERT INTO api_keys (id, provider, label, api_key) VALUES (?, ?, ?, ?)",
    [id, provider, label, apiKey]
  );
  const rows = await queryRows("SELECT * FROM api_keys WHERE id = ? LIMIT 1", [id]);
  return rows[0] as unknown as KeyRow;
}

export async function setKeyStatus(id: string, status: KeyStatus): Promise<boolean> {
  await ensureSchema();
  const rs = await runSql("UPDATE api_keys SET status = ? WHERE id = ?", [status, id]);
  return true;
}

export async function deleteKey(id: string): Promise<boolean> {
  await ensureSchema();
  await runSql("DELETE FROM api_keys WHERE id = ?", [id]);
  return true;
}

// إخفاء المفتاح دائمًا — لا يُعاد المفتاح الكامل في أي استجابة
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length >= 12) return key.slice(0, 7) + "••••••••" + key.slice(-4);
  return key.slice(0, 3) + "••••";
}

export interface MaskedKey {
  id: string;
  provider: string;
  label: string;
  masked_key: string;
  status: string;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_error: string | null;
  created_at: string;
}

export function toMaskedKey(k: KeyRow): MaskedKey {
  return {
    id: k.id,
    provider: k.provider,
    label: k.label || "",
    masked_key: maskKey(k.api_key),
    status: k.status,
    usage_count: k.usage_count,
    success_count: k.success_count,
    fail_count: k.fail_count,
    last_used_at: k.last_used_at,
    last_error: k.last_error,
    created_at: k.created_at,
  };
}
