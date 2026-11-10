# 🎬 Video Merger — موقع دمج الفيديوهات مع API عام

موقع كامل لدمج الفيديوهات مع واجهة برمجية عامة (API) للمطورين، جاهز للنشر على **Vercel**.

- **Node.js خالص (CommonJS)** بدون Next.js أو React أو أي خطوة بناء: واجهة ثابتة في `public/` + دوال Vercel Serverless في `api/`.
- **Turso (libSQL)** تخزّن كل شيء: بيانات المهام، أجزاء ملفات المصادر، والفيديو الناتج (Blobs) — بلا S3 ولا خدمات خارجية.
- **ffmpeg + ffprobe داخل الدالة نفسها** (`ffmpeg-static` / `ffprobe-static`).
- واجهة عربية RTL بثيم داكن بتدرجات سماوي/بنفسجي، سحب وإفلات، إعادة ترتيب، شريط تقدم حقيقي، وعدّاد صلاحية 24 ساعة.

---

## المزايا بسرعة

| | |
|---|---|
| المخرج | MP4 (H.264 CRF 18 + AAC 192k) حتى 1080p، `+faststart` — يعمل فورًا على الويب |
| التوحيد | scale + pad إلى أكبر دقة بين المدخلات (حد 1920×1080، أبعاد زوجية)، fps=30، setsar=1، yuv420p |
| الصوت | مصدر بلا صوت؟ يُضاف مسار صامت `anullsrc` بنفس مدته بدل أن يفشل الدمج |
| الحدود | 10 مقاطع، 200MB لكل مصدر، 150MB للناتج، 600 ثانية مجموع المدد |
| الصلاحية | كل الملفات تُحذف تلقائيًا بعد **24 ساعة** (تنظيف كسول + Cron يومي) |
| البث | دعم **Range** (206 + Content-Range) للتقديم/الترجيع في المشغل |

---

## النشر على Vercel خطوة بخطوة

### 1) أنشئ قاعدة Turso مجانية

```bash
# ثبّت CLI: curl -sSfL https://get.tur.so/install.sh | bash
turso db create my-merger
turso db show my-merger --url        # ← هذا هو TURSO_DATABASE_URL
turso db tokens create my-merger     # ← هذا هو TURSO_AUTH_TOKEN
```

### 2) ارفع المشروع إلى GitHub واربطه بـ Vercel

1. ادفع هذا المجلد (`video-merger/`) إلى مستودع GitHub.
2. في Vercel: **Add New → Project** واختر المستودع.
3. في إعدادات المشروع اضبط **Root Directory** = `video-merger` (إن كان المجلد داخل مستودع أكبر).
4. **Settings → Environment Variables** أضف المتغيرين:

| المتغير | القيمة | ملاحظة |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://…` | إلزامي |
| `TURSO_AUTH_TOKEN` | `eyJ…` | إلزامي — بصلاحيات كتابة |
| `MAX_SOURCES` | `10` | اختياري |
| `SOURCE_MAX_MB` | `200` | اختياري |
| `OUTPUT_MAX_MB` | `150` | اختياري |
| `MAX_TOTAL_DURATION_SEC` | `600` | اختياري |
| `FFMPEG_PRESET` | `medium` | اختياري — `veryfast` أسرع للخطة المجانية |

5. اضغط **Deploy**. ملف `vercel.json` جاهز بمدة `maxDuration: 300` لكل الدوال + Cron يومي على `/api/cron` الساعة 3 فجرًا.

### 3) جرّب الـ API بـ curl بعد النشر

```bash
BASE=https://your-app.vercel.app

# أنشئ مهمة دمج من روابط
curl -X POST $BASE/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"videos":["https://www.w3schools.com/html/mov_bbb.mp4","https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"]}'
# → 201 {"jobId":"wkucdefoxwvd","status":"queued","statusUrl":"…","processUrl":"…","expiresAt":"…"}

# نفّذ الدمج (متزامن — يستغرق ~10-15 ثانية)
curl -X POST $BASE/api/jobs/wkucdefoxwvd/process
# → 200 {"status":"done","videoUrl":"https://…/api/jobs/wkucdefoxwvd/video","downloadUrl":"…?download=1","size":1234567,"duration":30.2,"resolution":"640x360","expiresAt":"…"}
# → 202 إذا كانت قيد المعالجة فعله

# تابع الحالة والتقدم (0-100)
curl $BASE/api/jobs/wkucdefoxwvd
# → {"jobId":"…","status":"done","progress":100,"videoUrl":"…","size":…,"duration":…,"resolution":"…","expiresAt":"…"}

# حمّل الناتج
curl -o merged.mp4 "$BASE/api/jobs/wkucdefoxwvd/video?download=1"

# مهمة بملف مرفوع: أنشئ بمصادر، ارفع أجزاء 4MB، ثم process
curl -X POST $BASE/api/jobs -H "Content-Type: application/json" \
  -d '{"sources":[{"kind":"url","url":"https://…/clip1.mp4"},{"kind":"file","name":"clip2.mp4","size":5242880,"mime":"video/mp4"}]}'
# → 201 مع uploads: [{seq, uploadUrl: "…/api/upload?job=…&seq=1&chunk=", uploadChunkBytes: 4194304}]
curl -X POST "$BASE/api/upload?job=JOB&seq=1&chunk=0" --data-binary @chunk0.bin

# احذف فورًا (اختياري)
curl -X DELETE $BASE/api/jobs/wkucdefoxwvd
```

### 4) توثيق API كامل

| Method | Endpoint | الوظيفة | الأكواد |
|---|---|---|---|
| `POST` | `/api/jobs` | إنشاء مهمة دمج — يقبل `{"videos":[…]}` أو `{"sources":[…]}` | 201 / 400 / 413 |
| `POST` | `/api/upload?job=&seq=&chunk=` | رفع أجزاء ثنائية ≤4MB | 200 / 400 / 404 / 409 / 413 |
| `POST` | `/api/jobs/{id}/process` | تنفيذ الدمج كاملًا → رابط الناتج | 200 / 202 / 400 / 404 / 409 / 500 |
| `GET` | `/api/jobs/{id}` | الحالة + التقدم + الرابط عند الاكتمال | 200 / 404 |
| `GET` | `/api/jobs/{id}/video` | بث الناتج بدعم Range — `?download=1` للتحميل | 200 / 206 / 404 / 409 / 416 |
| `DELETE` | `/api/jobs/{id}` | حذف فوري شامل (jobs + sources + chunks) | 200 / 404 |
| `GET` | `/api/config` | الحدود العامة + version | 200 |
| `GET` | `/api/cron` | حذف المهام المنتهية (Cron يومي) | 200 |

حالات المهمة: `queued` → (`uploading`) → `processing` → `done` | `failed` — مع عمود `progress` (0-40 سحب المصادر، 40-90 ترميز، 100 اكتمال).

الأخطاء دائمًا بصيغة `{"error":"رسالة عربية واضحة"}`. CORS مفتوح، بلا تسجيل دخول.

---

## التخزين والحذف التلقائي

- جداول: `jobs`, `sources`, `source_chunks`, `output_chunks` — تُنشأ بـ `CREATE TABLE IF NOT EXISTS` (بلا migrations).
- كل Blob يُقسَّم إلى صفوف **2MB** (حد HTTP في Turso) ويُقرأ تدفقيًا بصفحات من 8 صفوف.
- كل مهمة لها `expires_at = created_at + 24 ساعة`؛ التنظيف كسول عند كل إنشاء/دمج + نقطة `/api/cron` مجدولة يوميًا في `vercel.json`.
- بعد نجاح الدمج تُحذف `source_chunks` — الناتج فقط هو المطلوب.

## نقاط حرجة منفَّذة

- حد حجم الطلب في Vercel ≈ 4.5MB → الرفع أجزاء POST ثنائية 4MB (`application/octet-stream`) مع إعادة محاولة ×3 من الواجهة.
- بث الفيديو يدعم Range (206 + Content-Range) بتحويل صفوف الـ Blobs إلى تدفق مع تقليم أول/آخر جزء حسب المدى.
- `ensureExecutable` تنسخ ثنائي ffmpeg إلى `/tmp` بصلاحية 755 إن فقد صلاحيته في الاستضافة.
- لا نظام ملفات دائم — `/tmp` فقط أثناء المعالجة، ويُنظَّف في `finally`.
- ثنائي ffmpeg كبير (~80MB): قد يتجاوز حد حجم الدالة في خطة **Hobby** (50MB) — إن فشل النشر استخدم `FFMPEG_PRESET=veryfast` أو خطة تدعم حجمًا أكبر، أو استبدل الحزمة ببناء أصغر.

## التشغيل المحلي والاختبارات

```bash
cp .env.example .env       # وضّع متغيري Turso
npm install                # أو bun install
npm run dev                # خادم على 3001 يحاكي Vercel (يحلّل المسارات الديناميكية إلى req.query)
npm test                   # اختبارات الوحدات (14) + اختبارات HTTP الكاملة (19)
```

اختبار الوحدات يولّد فيديوهين مختلفي الدقة بـ ffmpeg، يدمجهما ويتحقق من الدقة/المدة/الصوت، ثم يختبر التخزين في Turso والاسترجاع بتطابق sha256، ومسار رفع الأجزاء، وحدود الحجم، والحذف الشامل.
اختبار HTTP يغطي: روابط → دمج → بث Range 206 → مهمة مختلطة (رابط + ملف) → الحدود → JSON تالف → حذف → 404 → 405.
