// عمليات المهام في قاعدة البيانات — إدراج/قراءة/تحديث جزئي/قائمة/إحصائيات
import { queryRows, runSql, ensureSchema, type InValue } from "./turso";

export type TaskType = "image" | "video" | "merge";
export type TaskStatus = "pending" | "processing" | "completed" | "failed";

export interface AttemptRecord {
  provider: string;
  keyId: string;
  keyLabel: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: TaskType;
  prompt: string;
  params_json: string;
  status: TaskStatus;
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export function parseParams(task: TaskRow): Record<string, unknown> {
  try {
    return JSON.parse(task.params_json || "{}");
  } catch {
    return {};
  }
}

export function parseAttempts(task: TaskRow): AttemptRecord[] {
  try {
    const v = JSON.parse(task.attempts_json || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function parseResultUrls(task: TaskRow): string[] {
  try {
    const v = JSON.parse(task.result_urls_json || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export interface NewTask {
  id: string;
  model: string;
  type: TaskType;
  prompt?: string;
  params?: Record<string, unknown>;
  status?: TaskStatus;
}

export async function insertTask(t: NewTask): Promise<TaskRow> {
  await ensureSchema();
  await runSql(
    `INSERT INTO tasks (id, model, type, prompt, params_json, status, progress)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
    [t.id, t.model, t.type, t.prompt ?? "", JSON.stringify(t.params ?? {}), t.status ?? "pending"]
  );
  const row = await getTask(t.id);
  return row!;
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const rows = await queryRows("SELECT * FROM tasks WHERE id = ? LIMIT 1", [id]);
  if (!rows.length) return null;
  return rows[0] as unknown as TaskRow;
}

// تحديث جزئي: يضيف محاولة إلى attempts_json تلقائيًا عند تمرير attempt
// ويضبط completed_at تلقائيًا عند الوصول إلى حالة نهائية
export interface TaskPatch {
  provider?: string;
  provider_task_id?: string | null;
  key_id?: string | null;
  status?: TaskStatus;
  progress?: number;
  result_urls?: string[] | null;
  error_message?: string | null;
  params?: Record<string, unknown>;
  attempt?: AttemptRecord;
}

export async function updateTask(id: string, patch: TaskPatch): Promise<TaskRow | null> {
  await ensureSchema();
  const sets: string[] = [];
  const args: InValue[] = [];

  if (patch.attempt) {
    const current = await getTask(id);
    if (current) {
      const attempts = parseAttempts(current);
      attempts.push(patch.attempt);
      patch = { ...patch, attempt: undefined };
      sets.push("attempts_json = ?");
      args.push(JSON.stringify(attempts.slice(-50))); // حد أقصى 50 محاولة لتجنب تضخم الصف
    }
  }
  if (patch.provider !== undefined) { sets.push("provider = ?"); args.push(patch.provider); }
  if (patch.provider_task_id !== undefined) { sets.push("provider_task_id = ?"); args.push(patch.provider_task_id); }
  if (patch.key_id !== undefined) { sets.push("key_id = ?"); args.push(patch.key_id); }
  if (patch.status !== undefined) { sets.push("status = ?"); args.push(patch.status); }
  if (patch.progress !== undefined) { sets.push("progress = ?"); args.push(Math.max(0, Math.min(100, Math.round(patch.progress)))); }
  if (patch.result_urls !== undefined) { sets.push("result_urls_json = ?"); args.push(patch.result_urls ? JSON.stringify(patch.result_urls) : null); }
  if (patch.error_message !== undefined) { sets.push("error_message = ?"); args.push(patch.error_message); }
  if (patch.params !== undefined) { sets.push("params_json = ?"); args.push(JSON.stringify(patch.params)); }

  if (!sets.length) return getTask(id);

  // completed_at يُضبط تلقائيًا مرة واحدة عند أول حالة نهائية
  sets.push(
    "completed_at = CASE WHEN status IN ('completed','failed') AND completed_at IS NULL THEN datetime('now') ELSE completed_at END"
  );
  sets.push("updated_at = datetime('now')");
  args.push(id);
  await runSql(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, args);
  return getTask(id);
}

export async function listRecentTasks(
  limit = 20,
  filters: { type?: string; status?: string } = {}
): Promise<TaskRow[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: InValue[] = [];
  if (filters.type) { where.push("type = ?"); args.push(filters.type); }
  if (filters.status) { where.push("status = ?"); args.push(filters.status); }
  args.push(Math.max(1, Math.min(50, limit)));
  const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, id DESC LIMIT ?`;
  const rows = await queryRows(sql, args);
  return rows as unknown as TaskRow[];
}

export async function taskStats(): Promise<{ total: number; completed: number; failed: number; processing: number }> {
  await ensureSchema();
  const rows = await queryRows(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status IN ('processing','pending') THEN 1 ELSE 0 END) AS processing
     FROM tasks`
  );
  // عميل libSQL يعيد القيم مباشرة (وليس {type,value} كما في HTTP الخام)
  const r = rows[0] as unknown as Record<string, number | string | null>;
  const num = (v: number | string | null | undefined) =>
    v == null ? 0 : Number(v);
  return {
    total: num(r?.total),
    completed: num(r?.completed),
    failed: num(r?.failed),
    processing: num(r?.processing),
  };
}
