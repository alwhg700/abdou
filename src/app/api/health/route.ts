// فحص صحة النظام — قاعدة البيانات + نقطة MCP + الموديلات + خدمة الدمج
import { dbHealthy, ensureSchema } from "@/lib/turso";
import { MODELS } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let database = "turso-connected";
  try {
    await ensureSchema();
    const ok = await dbHealthy();
    if (!ok) database = "unavailable";
  } catch {
    database = "unavailable";
  }

  // فحص خدمة الدمج: GET {MERGER_API_BASE}/api/config بمهلة 4 ثوانٍ
  const base = (process.env.MERGER_API_BASE || "").replace(/\/+$/, "");
  let mergerHealthy = false;
  if (base && !/x{3,}/i.test(base)) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(`${base}/api/config`, { signal: ctrl.signal });
      clearTimeout(timer);
      mergerHealthy = res.ok;
    } catch {
      mergerHealthy = false;
    }
  }

  return Response.json({
    ok: database === "turso-connected",
    database,
    mcpEndpoint: "/mcp",
    models: MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers })),
    merger: { base: base || null, healthy: mergerHealthy },
    authRequired: !!process.env.MCP_ACCESS_TOKEN,
  });
}
