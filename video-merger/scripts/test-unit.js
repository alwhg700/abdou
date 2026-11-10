// اختبار وحدات لمحرك الدمج والتخزين — يولّد فيديوهين مختلفي الدقة بـ ffmpeg، يدمجهما، ويتحقق
// من: اكتمال الدمج، الدقة = أكبر دقة مدخل، المدة ≈ مجموع المدد، وجود الصوت
// ثم يختبر: التخزين في Turso والاسترجاع بتطابق sha256، مسار رفع الأجزاء، حدود الحجم، الحذف الشامل
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');

let PASS = 0, FAIL = 0;
function check(name, cond, extra = '') {
  if (cond) { PASS++; console.log(`  ✅ ${name}`); }
  else { FAIL++; console.log(`  ❌ ${name} ${extra}`); }
}

(async () => {
  // تحميل .env يدويًا (نفس منطق dev-server — دون تشغيل الخادم)
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      if (!process.env[k]) process.env[k] = t.slice(eq + 1).trim();
    }
  }

  const store = require('../lib/db');
  const { probe, mergeFiles, LIMITS, getBinaries } = require('../lib/merge');

  const { ffmpeg } = getBinaries();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-unit-'));
  console.log('\n🧪 اختبار الوحدات — محرك الدمج والتخزين\n');

  // 1) توليد فيديوهين مختلفين: 320x240 بلا صوت (4 ث) و 640x360 بصوت (3 ث)
  console.log('1) توليد مقطعين مختلفي الدقة بـ ffmpeg:');
  const clipA = path.join(tmp, 'a.mp4');
  const clipB = path.join(tmp, 'b.mp4');
  execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=30', '-pix_fmt', 'yuv420p', clipA], { stdio: 'ignore' });
  execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-shortest', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clipB], { stdio: 'ignore' });
  const pA = await probe(clipA);
  const pB = await probe(clipB);
  check('المقطع الأول 320x240 بلا صوت', pA.width === 320 && pA.height === 240 && !pA.hasAudio);
  check('المقطع الثاني 640x360 بصوت', pB.width === 640 && pB.height === 360 && pB.hasAudio);

  // 2) الدمج المباشر عبر المحرك
  console.log('\n2) دمج المحرك مباشرة:');
  const out = path.join(tmp, 'out.mp4');
  await mergeFiles([clipA, clipB], [pA, pB], out, () => {});
  const po = await probe(out);
  check('اكتمال الدمج (الملف موجود)', fs.existsSync(out) && fs.statSync(out).size > 0);
  check(`الدقة = أكبر دقة مدخل (${pB.width}x${pB.height})`, po.width === pB.width && po.height === pB.height, `→ ${po.width}x${po.height}`);
  const sumDur = pA.duration + pB.duration;
  check(`المدة ≈ مجموع المدد (${sumDur.toFixed(2)}ث)`, Math.abs(po.duration - sumDur) < 0.6, `→ ${po.duration.toFixed(2)}ث`);
  check('وجود الصوت في الناتج', po.hasAudio);
  check('المدة الكلية ضمن الحد', sumDur <= LIMITS.MAX_TOTAL_DURATION_SEC);

  // 3) تخزين الناتج في Turso والاسترجاع بتطابق sha256
  console.log('\n3) التخزين في Turso والاسترجاع (sha256):');
  const jobId = store.newJobId();
  const size = await store.storeOutputFromFile(jobId, out, fs);
  check(`تخزين الناتج (${fmt(size)} بايت عبر ${Math.ceil(size / store.CHUNK_SIZE)} صف 2MB)`, size === fs.statSync(out).size);

  // استرجاع تدفقي عبر خادم وهمي صغير
  const http = require('node:http');
  const fakeResChunks = [];
  const fakeRes = {
    headersSent: false,
    writeHead(code, headers) { this.code = code; this.headers = headers; this.headersSent = true; },
    write(b) { fakeResChunks.push(Buffer.isBuffer(b) ? b : Buffer.from(b)); return true; },
    end() { this.ended = true; },
    once() {},
    on() {},
  };
  await store.streamOutput(jobId, fakeRes, null, null);
  const retrieved = Buffer.concat(fakeResChunks);
  const sha1 = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
  const sha2 = crypto.createHash('sha256').update(retrieved).digest('hex');
  check('الاسترجاع الكامل بتطابق sha256', sha1 === sha2 && retrieved.length === size);

  // استرجاع بمدى Range جزئي
  fakeResChunks.length = 0;
  await store.streamOutput(jobId, fakeRes, 'bytes=0-1023', null);
  const partial = Buffer.concat(fakeResChunks);
  check('دعم Range جزئي (206 + 1024 بايت)', fakeRes.code === 206 && partial.length === 1024 && partial.equals(fs.readFileSync(out).subarray(0, 1024)));

  // 4) مسار رفع الأجزاء: تقسيم ملف إلى أجزاء 1MB وإعادة تجميعها
  console.log('\n4) مسار رفع الأجزاء (chunks):');
  const jobId2 = store.newJobId();
  await store.createJob({ id: jobId2, status: 'uploading', sources: [{ kind: 'file', name: 'up.mp4', size: out.length }], createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 864e5).toISOString() });
  await store.addSource(jobId2, 0, { kind: 'file', name: 'up.mp4', size: out.length });
  const raw = fs.readFileSync(out);
  const CH = 1048576;
  let done = false;
  for (let i = 0; i * CH < raw.length; i++) {
    const piece = raw.subarray(i * CH, (i + 1) * CH);
    const r = await store.addSourceChunk(jobId2, 0, i, piece);
    done = r.complete;
  }
  check('اكتمال المصدر عند استلام الحجم المعلن', done);
  const reassembled = path.join(tmp, 're.bin');
  await store.assembleSourceToTmp(jobId2, 0, reassembled, fs);
  const sha3 = crypto.createHash('sha256').update(fs.readFileSync(reassembled)).digest('hex');
  check('إعادة تجميع الأجزاء بتطابق sha256', sha3 === sha1);

  // 5) حدود الحجم: مصدر يتجاوز الحد أثناء التنزيل (خادم محلي صغير يرسل أكثر من الحد)
  console.log('\n5) حدود الحجم:');
  const { downloadUrlToTmp } = require('../lib/merge');
  const bigSrv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp4' });
    const chunk = Buffer.alloc(1048576, 1);
    const total = 6; // 6MB
    let i = 0;
    const iv = setInterval(() => {
      if (i++ >= total) { clearInterval(iv); res.end(); return; }
      res.write(chunk);
    }, 20);
  });
  await new Promise((r) => bigSrv.listen(0, '127.0.0.1', r));
  const bigPort = bigSrv.address().port;
  const LIMIT_MB = 2;
  let limitErr = null;
  try {
    await downloadUrlToTmp(`http://127.0.0.1:${bigPort}/big.mp4`, path.join(tmp, 'big.mp4'), LIMIT_MB * 1048576);
  } catch (e) { limitErr = e; }
  bigSrv.close();
  check(`رفض مصدر يتجاوز ${LIMIT_MB}MB أثناء التنزيل`, !!limitErr, limitErr ? '' : '(لم يُرفض!)');

  // 6) الحذف الشامل
  console.log('\n6) الحذف الشامل:');
  await store.deleteJobCascade(jobId);
  await store.deleteJobCascade(jobId2);
  const gone1 = await store.getJob(jobId);
  const leftover = await store.rows('SELECT COUNT(*) AS c FROM output_chunks WHERE job_id = ?', [jobId]);
  check('حذف المهمة وجميع صفوفها', !gone1 && Number(leftover[0].c) === 0);

  // تنظيف الملفات المؤقتة
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n📊 النتيجة: ${PASS} ناجح، ${FAIL} فاشل\n`);
  process.exit(FAIL ? 1 : 0);
})().catch((e) => {
  console.error('💥 فشل الاختبار:', e);
  process.exit(1);
});

function fmt(n) { return Number(n).toLocaleString('en-US'); }
