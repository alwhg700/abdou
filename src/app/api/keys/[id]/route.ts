// تعطيل/تنشيط/حذف مفتاح بالمعرّف
import { setKeyStatus, deleteKey } from "@/lib/keys";
import { ensureSchema } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureSchema();
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as { status?: string } | null;
    if (body?.status !== "active" && body?.status !== "disabled") {
      return Response.json({ error: "الحالة المسموحة: active أو disabled" }, { status: 400 });
    }
    await setKeyStatus(id, body.status);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: `تعذّر تحديث المفتاح: ${(e as Error).message}` }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureSchema();
    const { id } = await params;
    await deleteKey(id);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: `تعذّر حذف المفتاح: ${(e as Error).message}` }, { status: 500 });
  }
}
