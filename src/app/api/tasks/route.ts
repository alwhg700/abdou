// لوحة المهام — أحدث المهام + الإحصائيات (تُحدَّث من الواجهة كل ~5 ثوانٍ)
import { listRecentTasks, taskStats } from "@/lib/tasks";
import { ensureSchema } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    await ensureSchema();
    const url = new URL(req.url);
    const limit = parseInt(url.searchParams.get("limit") || "20", 10);
    const type = url.searchParams.get("type") || undefined;
    const status = url.searchParams.get("status") || undefined;
    const [tasks, stats] = await Promise.all([listRecentTasks(limit, { type, status }), taskStats()]);
    return Response.json({ stats, tasks });
  } catch (e) {
    return Response.json({ error: `خطأ في جلب المهام: ${(e as Error).message}` }, { status: 500 });
  }
}
