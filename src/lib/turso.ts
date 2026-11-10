// طبقة قاعدة البيانات — Turso (libSQL) عبر HTTP حصريًا للتوافق مع Vercel serverless
// لا نستخدم أي ملف SQLite محلي؛ العميل يُنشأ مرة واحدة ويعاد استخدامه
import { createClient, type Client, type InValue } from "@libsql/client";

export type { InValue };

let _client: Client | null = null;

export function getDb(): Client {
  if (!_client) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) {
      throw new Error("MISSING_TURSO_ENV: TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبان");
    }
    _client = createClient({ url, authToken: token });
  }
  return _client;
}

// إنشاء الجداول عند أول وصول فقط (بدون أداة migrations)
let _schemaPromise: Promise<void> | null = null;
export function ensureSchema(): Promise<void> {
  if (!_schemaPromise) {
    _schemaPromise = (async () => {
      const db = getDb();
      await db.execute(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          provider TEXT,
          provider_task_id TEXT,
          key_id TEXT,
          model TEXT NOT NULL,
          type TEXT NOT NULL,
          prompt TEXT DEFAULT '',
          params_json TEXT DEFAULT '{}',
          status TEXT NOT NULL,
          progress INTEGER DEFAULT 0,
          result_urls_json TEXT,
          error_message TEXT,
          attempts_json TEXT DEFAULT '[]',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          completed_at TEXT
        )
      `);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS api_keys (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          label TEXT DEFAULT '',
          api_key TEXT NOT NULL,
          status TEXT DEFAULT 'active',
          usage_count INTEGER DEFAULT 0,
          success_count INTEGER DEFAULT 0,
          fail_count INTEGER DEFAULT 0,
          last_used_at TEXT,
          last_checked_at TEXT,
          last_error TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
    })().catch((e) => {
      _schemaPromise = null; // اسمح بإعادة المحاولة لاحقًا
      throw e;
    });
  }
  return _schemaPromise;
}

export async function dbHealthy(): Promise<boolean> {
  try {
    await getDb().execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export async function queryRows(sql: string, params: InValue[] = []) {
  const rs = await getDb().execute({ sql, args: params });
  return rs.rows;
}

export async function runSql(sql: string, params: InValue[] = []) {
  await getDb().execute({ sql, args: params });
}
