// اختبار منطق المفاتيح: تصنيف الأخطاء + المفتاح المستنزف يبقى في القاعدة دون عرقلة
// يشغَّل بـ bun مباشرة (يدعم TypeScript)
import { classifyProviderError, getKeyPool, addKey, deleteKey, maskKey, type ErrorClass } from "../src/lib/keys";

let PASS = 0, FAIL = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { PASS++; console.log(`  ✅ ${name}`); }
  else { FAIL++; console.log(`  ❌ ${name} ${extra}`); }
}

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  console.error("اضبط TURSO_DATABASE_URL و TURSO_AUTH_TOKEN قبل التشغيل");
  process.exit(1);
}
process.env.TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || "";

async function main() {
  console.log("\n🔑 اختبار منطق المفاتيح\n");

  // 1) تصنيف الأخطاء — جدول 4.2 بالترتيب المطلوب
  const cases: Array<[number, string, ErrorClass, string]> = [
    [401, "Unauthorized", "disabled", "401 → disabled"],
    [403, "Forbidden", "disabled", "403 → disabled"],
    [200, "invalid api key provided", "disabled", "رسالة invalid api key → disabled"],
    [402, "Payment Required", "exhausted", "402 → exhausted"],
    [400, "insufficient balance", "exhausted", "نفاد رصيد بحالة 400 → exhausted (يفحص قبل 400)"],
    [400, "quota exceeded for this key", "exhausted", "quota بحالة 400 → exhausted"],
    [400, "out of credits", "exhausted", "out of credits → exhausted"],
    [404, "model not found", "provider", "model not found + 404 → provider"],
    [400, "unsupported model name", "provider", "unsupported model + 400 → provider"],
    [400, "prompt is required", "params", "400 عادي → params (توقف فوري)"],
    [422, "aspect_ratio invalid", "params", "422 → params"],
    [429, "rate limit", "temporary", "429 → temporary"],
    [500, "internal server error", "temporary", "500 → temporary"],
    [0, "fetch failed", "temporary", "شبكة → temporary"],
    [502, "bad gateway", "temporary", "502 → temporary"],
  ];
  console.log("1) تصنيف الأخطاء (classifyProviderError):");
  for (const [status, msg, expected, label] of cases) {
    check(label, classifyProviderError(status, msg) === expected, `→ ${classifyProviderError(status, msg)}`);
  }

  // 2) maskKey — إخفاء إلزامي
  console.log("\n2) maskKey:");
  check("مفتاح طويل: أول 7 + نقاط + آخر 4", maskKey("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6") === "a1b2c3d••••••••c5d6");
  check("مفتاح قصير: أول 3 + نقاط", maskKey("abc12") === "abc••••");

  // 3) المفتاح المستنزف يبقى في القاعدة ولا يُستبعد من القائمة (التعطيل فقط يُقصي)
  console.log("\n3) المفتاح المستنزف (exhausted) يبقى في المجموعة:");
  const probeKey = "EXHAUSTED402TESTKEY0000";
  const added = await addKey("kie", probeKey, "اختبار 402");
  // محاكاة استنزاف المزود: نضع الحالة exhausted يدويًا (نفس مسار markKey بعد 402)
  const { runSql } = await import("../src/lib/turso");
  await runSql("UPDATE api_keys SET status='exhausted' WHERE id=?", [added.id]);

  const pool = await getKeyPool(["kie", "cometapi"]);
  const inPool = pool.some((k) => k.id === added.id);
  check("exhausted يبقى في getKeyPool (لا يُستبعد)", inPool);
  check("الترتيب تسلسلي بترتيب الإضافة (created_at ASC, id ASC)",
    pool.every((k, i) => i === 0 || String(pool[i - 1].created_at) <= String(k.created_at)));

  // معطّل يُقصي فعلاً
  await runSql("UPDATE api_keys SET status='disabled' WHERE id=?", [added.id]);
  const pool2 = await getKeyPool(["kie", "cometapi"]);
  check("disabled يُستبعد من المجموعة", !pool2.some((k) => k.id === added.id));

  // تنظيف مفتاح الاختبار
  await deleteKey(added.id);
  console.log(`\n📊 النتيجة: ${PASS} ناجح، ${FAIL} فاشل\n`);
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error("💥", e); process.exit(1); });
