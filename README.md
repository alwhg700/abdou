# 🎙️ MCP Media Generator — خادم MCP لتوليد الصور والفيديو ودمج المقاطع

خادم MCP يجمع ثلاث قدرات في أداة واحدة، مع لوحة إدارة عربية RTL:

1. **توليد صور** من وصف نصي — الموديل المدمج: `gpt-image-2-6/flare-text-to-image`.
2. **توليد فيديو** مع صوت متزامن أصلي (حوار/مؤثرات/موسيقى) — الموديل المدمج: `grok-imagine-video-1-5-preview`.
3. **دمج عدة مقاطع فيديو** في مقطع واحد عالي الجودة وبالترتيب المطلوب (عبر خدمة الدمج المرفقة في `video-merger/`).

- **خادم MCP** على المسار `/mcp` (نقل Streamable HTTP وفق مواصفات MCP — SDK الرسمي) يعرض **5 أدوات** يستدعيها نموذج الذكاء الاصطناعي من أي عميل (ChatGPT Connectors / Claude Desktop / Cursor / Windsurf / Cline / GPT Agents SDK).
- **واجهة ويب عربية** لإدارة مفاتيح API، ومتابعة المهام حية كل ~5 ثوانٍ، وعرض إعدادات الربط جاهزة للنسخ لأي عميل MCP.

## القواعد الجوهرية المنفَّذة

- **روابط فقط** — لا يُنزَّل أي ملف وسائط على السيرفر إطلاقًا؛ تُخزَّن روابط النتائج في Turso.
- **تجربة تسلسلية صارمة** للمفاتيح بترتيب الإضافة (`created_at ASC, id ASC`) — وليست round-robin.
- **تبديل تلقائي فوري** عند أي خطأ أو نفاد رصيد دون توقف المهمة — نفس المهمة تُستأنف بنفس `task_id` على المفتاح التالي، ونموذج الذكاء الاصطناعي **لا يرى أخطاء المفاتيح أو الرصيد أبدًا**.
- مهمة فشلت على كل المفاتيح تبقى `processing` وتُعاد محاولتها تلقائيًا مع كل `get_task` (بتهدئة ~45 ثانية).
- أخطاء خدمة الدمج المعلنة (HTTP 4xx/5xx) = فشل حتمي فوري؛ أخطاء شبكتنا = مؤقتة وتستمر بالاستعلام.
- ملفات الدمج تُحذف بعد 24 ساعة — محدثة في وصف الأداة وفي تعليمات الخادم.
- إخفاء المفاتيح إلزامي في كل الاستجابات (`ABCD123••••••••WXYZ`).
- `.env*` مُستثنى من Git منذ اليوم الأول — لا أسرار في الكود إطلاقًا.

## الأدوات الخمس

| الأداة | الوظيفة |
|---|---|
| `generate_image` | توليد صورة — تعيد الرابط جاهزًا إذا اكتملت خلال نافذة الانتظار، وإلا `task_id` |
| `generate_video` | توليد فيديو بصوت متزامن + image-to-video اختياري — تعيد `task_id` وتُتابع بـ `get_task` |
| `merge_videos` | دمج 2-10 مقاطع بالترتيب — عبر `urls` مباشرة أو `task_ids` لمهام مكتملة |
| `get_task` | تتبع أي مهمة (توليد أو دمج) — يحدّث حيًا من المزود/خدمة الدمج |
| `list_media` | أحدث الوسائط المخزنة بروابطها (بدون إعادة توليد) |

أثناء نافذة الانتظار يُبَث تقدم حي (Progress notifications كل ~3 ثوانٍ) عند تزويد الطلب بـ `_meta.progressToken`.

## هيكل المستودع

```
├── src/lib/            طبقة الأعمال: turso, keys (التبديل التسلسلي), models,
│   │                   providers/ (kie + cometapi), generation (المنسّق), merger (عميل الدمج)
├── src/app/mcp/        خادم MCP — 5 أدوات بـ SDK الرسمي
├── src/app/api/        health / keys / tasks للوحة الإدارة
├── src/app/page.tsx    لوحة الإدارة العربية (RTL)
├── scripts/            أدوات اختبار ومساعدة (MCP curl، منطق المفاتيح، أدوات Turso)
└── video-merger/       مشروع دمج الفيديو المستقل (Node.js خالص + Vercel Serverless) — README خاص به
```

## التشغيل المحلي

```bash
bun install
cp .env.example .env.local   # وضّع القيم الحقيقية
bun run dev                  # http://localhost:3000
```

اختبار سريع لـ MCP:

```bash
# تهيئة جلسة
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl-test","version":"1.0"}}}'
# → خذ mcp-session-id من الترويسات ثم أرسل notifications/initialized ثم tools/list
```

## متغيرات البيئة (Vercel → Settings → Environment Variables)

| المتغير | إلزامي | الوصف |
|---|---|---|
| `TURSO_DATABASE_URL` | ✅ | `libsql://…` من `turso db show <name> --url` |
| `TURSO_AUTH_TOKEN` | ✅ | من `turso db tokens create <name>` — بصلاحيات كتابة |
| `MERGER_API_BASE` | ✅ | رابط خدمة الدمج المنشورة (مجلد `video-merger/`) |
| `MCP_ACCESS_TOKEN` | — | إن ضُبط يُطلب `Authorization: Bearer <token>` على `/mcp` |
| `KIE_IMAGE_MODEL` `KIE_VIDEO_MODEL` `COMETAPI_IMAGE_MODEL` `COMETAPI_VIDEO_MODEL` | — | تجاوز أسماء الموديلات |
| `MCP_STATELESS` | — | `1` لتعطيل الجلسات (توافق أفضل مع بنى متعددة النسخ) |

## النشر على Vercel

1. أنشئ قاعدة Turso مجانية واحصل على المتغيرين (الخطوات في `video-merger/README.md`).
2. اربط المستودع بـ Vercel → مشروع للمجلد الجذر (خادم MCP) مع المتغيرات الثلاثة.
3. مشروع ثانٍ بـ **Root Directory = `video-merger`** لمتغيري Turso فقط.
4. انسخ رابط مشروع الدمج إلى `MERGER_API_BASE` في المشروع الأول وأعد النشر.
5. افتح لوحة الإدارة → تبويب «ربط السيرفر» → انسخ JSON لأي عميل (ChatGPT / Claude / Cursor).

كل شيء يعمل بدون ملفات محلية: libSQL يتصل عبر HTTP ومناسب للـ serverless، ومسار `/mcp` يدعم البث.

## الحسابات والفحوصات المنفَّذة (سجل القبول)

- `tsc --noEmit` نظيف + `next build` ينجح.
- `GET /api/health` → `ok:true` و `database:"turso-connected"` و `merger.healthy:true`.
- `tools/list` يعرض الأدوات الخمس بمخططات مطابقة (merge بلا resolution/fps وبحد 10).
- توليد صورة حقيقي عبر kie.ai → رابط يعمل.
- توليد فيديو حقيقي → `task_id` تابعه `get_task` حتى رابط MP4 صالح.
- التبديل التسلسلي: مفتاح خاطئ أولًا + صحيح ثانٍ → المهمة اكتملت على الثاني، الخاطئ صار `disabled`، ولم يصل العميل أي ذكر للمفاتيح.
- مفتاح مستنزف (402): التصنيف → `exhausted` ويبقى في القاعدة دون عرقلة (اختبار منطقي 20/20).
- دمج حقيقي بمقطعين عامين → MP4 نهائي على نطاق خدمة الدمج.
- رفض مقطع واحد / أكثر من 10 برسائل عربية، وحل `task_ids` بالترتيب.
- `list_media` يعيد المهام مرتبة من الأحدث.
- الواجهة: إضافة/تعطيل/حذف مفتاح تعمل، لوحة المهام تتحدث تلقائيًا، بطاقة الربط تعرض JSON صحيحًا لكل تبويب، وكل الصفحة RTL عربية.
