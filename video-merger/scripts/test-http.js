// اختبار HTTP كامل ضد خادم التطوير (localhost:3001):
// إنشاء مهمة من روابط → دمج → بث مع Range 206 → مهمة مختلطة (رابط + ملف مرفوع)
// → حذف → 404 → JSON تالف → قائمة فارغة → حدود (مقطع واحد / أكثر من 10)
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const BASE = process.env.BASE || 'http://localhost:3001';
let PASS = 0, FAIL = 0;
function check(name, cond, extra = '') {
  if (cond) { PASS++; console.log(`  ✅ ${name}`); }
  else { FAIL++; console.log(`  ❌ ${name} ${extra}`); }
}

async function jfetch(pathname, opts = {}) {
  const r = await fetch(BASE + pathname, opts);
  let j = null;
  try { j = await r.json(); } catch { /* بث أو جسم فارغ */ }
  return { status: r.status, j, res: r };
}

(async () => {
  console.log(`\n🌐 اختبار HTTP كامل ضد ${BASE}\n`);

  // 0) /api/config
  const cfg = await jfetch('/api/config');
  check('GET /api/config يعيد الحدود', cfg.status === 200 && cfg.j?.limits?.maxSources >= 2);

  // روابط مقاطع عامة صغيرة للدمج — مع مقطعين محليين احتياطيين إن فشل الوصول للخارج
  let PUBLIC1 = 'https://www.w3schools.com/html/mov_bbb.mp4';
  let PUBLIC2 = 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4';
  try {
    const t = await fetch(PUBLIC1, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    if (!t.ok) throw new Error('HEAD ' + t.status);
  } catch {
    console.log('  ℹ️ الروابط العامة غير قابلة للوصول من هذه البيئة — نستخدم مقاطع محلية بديلة');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-http-'));
    const { getBinaries } = require('../lib/merge');
    const { ffmpeg } = getBinaries();
    PUBLIC1 = `http://localhost:3001/samples/s1.mp4`;
    PUBLIC2 = `http://localhost:3001/samples/s2.mp4`;
    fs.mkdirSync(path.join(__dirname, '..', 'public', 'samples'), { recursive: true });
    execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=640x360:rate=30', '-pix_fmt', 'yuv420p', path.join(__dirname, '..', 'public', 'samples', 's1.mp4')], { stdio: 'ignore' });
    execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=3:size=480x270:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=523:duration=3', '-shortest', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(__dirname, '..', 'public', 'samples', 's2.mp4')], { stdio: 'ignore' });
  }

  // 1) إنشاء مهمة من روابط → دمج → بث Range 206
  console.log('1) مهمة كاملة من روابط:');
  const cr = await jfetch('/api/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videos: [PUBLIC1, PUBLIC2] }),
  });
  check('POST /api/jobs → 201 مع jobId', cr.status === 201 && !!cr.j?.jobId, JSON.stringify(cr.j));
  const jobId = cr.j.jobId;
  check('استجابة الإنشاء تحتوي statusUrl و processUrl و expiresAt', !!cr.j.statusUrl && !!cr.j.processUrl && !!cr.j.expiresAt);

  const pr = await jfetch(`/api/jobs/${jobId}/process`, { method: 'POST' });
  check('POST process → 200 done', pr.status === 200 && pr.j?.status === 'done', JSON.stringify(pr.j)?.slice(0, 200));
  check('الناتج يحمل videoUrl و downloadUrl و resolution و duration', !!pr.j?.videoUrl && !!pr.j?.downloadUrl && !!pr.j?.resolution && pr.j?.duration > 0);

  // بث مع Range
  const head = await fetch(BASE + `/api/jobs/${jobId}/video`, { headers: { Range: 'bytes=0-1023' } });
  const buf = Buffer.from(await head.arrayBuffer());
  check('بث الناتج مع Range → 206 + Content-Range + طول صحيح',
    head.status === 206 && (head.headers.get('content-range') || '').startsWith('bytes 0-1023/') && buf.length === 1024,
    `status=${head.status} len=${buf.length}`);

  const full = await fetch(BASE + `/api/jobs/${jobId}/video`);
  const fullBuf = Buffer.from(await full.arrayBuffer());
  check('بث كامل 200 بحجم الناتج المعلن', full.status === 200 && fullBuf.length === pr.j.size, `len=${fullBuf.length} vs ${pr.j.size}`);

  const dl = await fetch(BASE + `/api/jobs/${jobId}/video?download=1`);
  check('download=1 يعيد ترويسة مرفق', dl.status === 200 && (dl.headers.get('content-disposition') || '').includes('attachment'));

  // 2) مهمة مختلطة: رابط + ملف مرفوع بالأجزاء
  console.log('\n2) مهمة مختلطة (رابط + ملف مرفوع):');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-http2-'));
  const upFile = path.join(tmpDir, 'up.mp4');
  const { getBinaries } = require('../lib/merge');
  const { ffmpeg } = getBinaries();
  execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=30', '-pix_fmt', 'yuv420p', upFile], { stdio: 'ignore' });
  const upBuf = fs.readFileSync(upFile);

  const mr = await jfetch('/api/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sources: [
        { kind: 'url', url: PUBLIC1 },
        { kind: 'file', name: 'up.mp4', size: upBuf.length, mime: 'video/mp4' },
      ],
    }),
  });
  check('إنشاء مهمة مختلطة → 201 مع uploads', mr.status === 201 && Array.isArray(mr.j?.uploads), JSON.stringify(mr.j)?.slice(0, 150));
  const mixedId = mr.j.jobId;
  const upRec = mr.j.uploads.find((u) => u.uploadUrl);
  const CH = mr.j.uploads.find((u) => u.uploadUrl).uploadChunkBytes;
  let uploaded = 0, allOk = true;
  for (let k = 0; k * CH < upBuf.length; k++) {
    const piece = upBuf.subarray(k * CH, (k + 1) * CH);
    const ur = await fetch(upRec.uploadUrl + k, { method: 'POST', body: piece, headers: { 'Content-Type': 'application/octet-stream' } });
    if (!ur.ok) allOk = false;
    uploaded++;
  }
  check(`رفع ${uploaded} جزءًا بنجاح`, allOk && uploaded > 0);

  const mpr = await jfetch(`/api/jobs/${mixedId}/process`, { method: 'POST' });
  check('دمج المهمة المختلطة → done', mpr.status === 200 && mpr.j?.status === 'done', JSON.stringify(mpr.j)?.slice(0, 200));

  // 3) الحدود: مقطع واحد وأكثر من 10
  console.log('\n3) حدود عدد المقاطع:');
  const one = await jfetch('/api/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videos: [PUBLIC1] }),
  });
  check('مقطع واحد → 400 برسالة عربية', one.status === 400 && /مقطع/.test(one.j?.error || ''));

  const eleven = await jfetch('/api/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videos: Array.from({ length: 11 }, () => PUBLIC1) }),
  });
  check('أكثر من 10 → 400 برسالة عربية', eleven.status === 400 && /أقصى/.test(eleven.j?.error || ''));

  // 4) JSON تالف → 400
  const bad = await fetch(BASE + '/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{تالف' });
  const badJ = await bad.json().catch(() => null);
  check('JSON تالف → 400', bad.status === 400 && badJ?.error, JSON.stringify(badJ));

  // 5) حذف → 404 بعده
  console.log('\n4) الحذف وال404:');
  const del = await jfetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
  check('DELETE → ok:true', del.status === 200 && del.j?.ok === true);
  const gone = await jfetch(`/api/jobs/${jobId}`);
  check('GET بعد الحذف → 404', gone.status === 404);
  const goneProcess = await jfetch(`/api/jobs/${jobId}/process`, { method: 'POST' });
  check('process بعد الحذف → 404', goneProcess.status === 404);
  const missing = await jfetch('/api/jobs/nonexistent999');
  check('GET مهمة غير موجودة → 404', missing.status === 404);
  const wrongMethod = await jfetch(`/api/jobs/${mixedId}`, { method: 'PUT' });
  check('PUT على مهمة → 405', wrongMethod.status === 405);

  // 6) تنظيف المهمة المختلطة + الملفات
  await jfetch(`/api/jobs/${mixedId}`, { method: 'DELETE' });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  try { fs.rmSync(path.join(__dirname, '..', 'public', 'samples'), { recursive: true, force: true }); } catch {}

  console.log(`\n📊 النتيجة: ${PASS} ناجح، ${FAIL} فاشل\n`);
  process.exit(FAIL ? 1 : 0);
})().catch((e) => {
  console.error('💥 فشل الاختبار:', e);
  process.exit(1);
});
