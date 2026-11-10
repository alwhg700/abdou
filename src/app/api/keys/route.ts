// واجهة إدارة المفاتيح — القائمة (مقنعة دائمًا) والإضافة
import { listKeys, toMaskedKey, addKey, type ProviderId } from "@/lib/keys";
import { ensureSchema } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await ensureSchema();
    const keys = await listKeys();
    return Response.json({ keys: keys.map(toMaskedKey) });
  } catch (e) {
    return Response.json({ error: `خطأ في جلب المفاتيح: ${(e as Error).message}` }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    await ensureSchema();
    const body = (await req.json().catch(() => null)) as
      | { provider?: string; api_key?: string; label?: string }
      | null;
    if (!body?.provider || !body?.api_key) {
      return Response.json({ error: "المزود (provider) والمفتاح (api_key) مطلوبان" }, { status: 400 });
    }
    if (body.provider !== "kie" && body.provider !== "cometapi") {
      return Response.json({ error: "المزود يجب أن يكون kie أو cometapi" }, { status: 400 });
    }
    const apiKey = String(body.api_key).trim();
    if (apiKey.length < 8) {
      return Response.json({ error: "المفتاح قصير جدًا — تأكد من نسخه كاملًا" }, { status: 400 });
    }
    const created = await addKey(body.provider as ProviderId, apiKey, String(body.label || "").slice(0, 100));
    return Response.json({ key: toMaskedKey(created) }, { status: 201 });
  } catch (e) {
    const msg = (e as Error).message || "";
    if (msg.startsWith("DUPLICATE_KEY")) {
      return Response.json({ error: "هذا المفتاح مُضاف مسبقًا لنفس المزود" }, { status: 409 });
    }
    return Response.json({ error: `تعذّر إضافة المفتاح: ${msg}` }, { status: 500 });
  }
}
