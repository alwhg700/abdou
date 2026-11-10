// محرك الدمج — توحيد المصادر ودمجها بجودة عالية عبر ffmpeg داخل الدالة نفسها
// القواعد الإلزامية:
// - ffprobe لكل مصدر: الدقة، معدل الإطارات، المدة، وجود صوت
// - filter_complex: scale + pad إلى أكبر دقة (حد أقصى 1920×1080، أبعاد زوجية) + fps=30 + setsar=1 + yuv420p
// - مصدر بلا صوت → مسار صامت anullsrc بنفس مدته بدل أن يفشل الدمج
// - الترميز النهائي: libx264 CRF 18 + AAC 192k/44100Hz + +faststart → MP4 يعمل فورًا على الويب
// - تقدم الترميز يُقرأ من -progress pipe:1 (out_time_us) ويُحسب من المدة الإجمالية
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const LIMITS = {
  MAX_SOURCES: parseInt(process.env.MAX_SOURCES || '10', 10),
  SOURCE_MAX_MB: parseInt(process.env.SOURCE_MAX_MB || '200', 10),
  OUTPUT_MAX_MB: parseInt(process.env.OUTPUT_MAX_MB || '150', 10),
  MAX_TOTAL_DURATION_SEC: parseInt(process.env.MAX_TOTAL_DURATION_SEC || '600', 10),
  FFMPEG_PRESET: process.env.FFMPEG_PRESET || 'medium',
};

function even(n) {
  const v = Math.round(n);
  return v % 2 === 0 ? v : v - 1;
}

// ثنائيات ffmpeg/ffprobe قد تفقد صلاحية التنفيذ في الاستضافة — نسخ إلى /tmp بصلاحية 755 عند الحاجة
function ensureExecutable(binPath) {
  try {
    fs.accessSync(binPath, fs.constants.X_OK);
    return binPath;
  } catch {
    const tmp = path.join(os.tmpdir(), path.basename(binPath));
    fs.copyFileSync(binPath, tmp);
    fs.chmodSync(tmp, 0o755);
    return tmp;
  }
}

function getBinaries() {
  const ffmpeg = process.env.FFMPEG_PATH || require('ffmpeg-static');
  const ffprobePkg = require('ffprobe-static');
  const ffprobe = process.env.FFPROBE_PATH || (ffprobePkg && ffprobePkg.path);
  if (!ffmpeg || !ffprobe) throw new Error('ffmpeg/ffprobe غير متوفرين — ثبّت ffmpeg-static و ffprobe-static');
  return { ffmpeg: ensureExecutable(ffmpeg), ffprobe: ensureExecutable(ffprobe) };
}

function run(bin, args, timeoutMs = 240000) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error('انتهت المهلة أثناء تنفيذ ffmpeg/ffprobe'));
    }, timeoutMs);
    p.stdout.on('data', (d) => (stdout += d.toString()));
    p.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`ffmpeg/ffprobe خرج بكود ${code}: ${stderr.slice(-1500)}`));
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// فحص مصدر: الدقة، fps، المدة، وجود صوت
async function probe(file) {
  const { ffprobe } = getBinaries();
  const { stdout } = await run(
    ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file],
    60000
  );
  const info = JSON.parse(stdout);
  const v = (info.streams || []).find((s) => s.codec_type === 'video');
  const a = (info.streams || []).find((s) => s.codec_type === 'audio');
  if (!v) throw new Error(`لا يوجد مسار فيديو في الملف: ${path.basename(file)}`);
  let fps = 30;
  if (v.avg_frame_rate && v.avg_frame_rate !== '0/0') {
    const [num, den] = v.avg_frame_rate.split('/').map(Number);
    if (den) fps = num / den;
  } else if (v.r_frame_rate && v.r_frame_rate !== '0/0') {
    const [num, den] = v.r_frame_rate.split('/').map(Number);
    if (den) fps = num / den;
  }
  const duration = Number(v.duration || info.format?.duration || 0);
  return {
    width: v.width,
    height: v.height,
    fps,
    duration,
    hasAudio: !!a,
    codec: v.codec_name,
  };
}

// تنزيل مصدر رابط إلى /tmp مع فحص الحجم أثناء التنزيل (بمعدّل البايتات)
async function downloadUrlToTmp(url, destPath, maxBytes) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`فشل تنزيل المصدر (HTTP ${res.status}): ${url}`);
    const sizeHeader = parseInt(res.headers.get('content-length') || '0', 10);
    if (sizeHeader && sizeHeader > maxBytes) {
      throw new Error(`حجم المصدر يتجاوز الحد (${Math.round(sizeHeader / 1048576)}MB > ${Math.round(maxBytes / 1048576)}MB)`);
    }
    const out = fs.createWriteStream(destPath);
    let written = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      written += value.byteLength;
      if (written > maxBytes) {
        ctrl.abort();
        throw new Error(`حجم المصدر يتجاوز الحد (${Math.round(maxBytes / 1048576)}MB)`);
      }
      if (!out.write(Buffer.from(value))) {
        await new Promise((r) => out.once('drain', r));
      }
    }
    await new Promise((r) => out.end(r));
    return { bytes: written };
  } finally {
    clearTimeout(timer);
  }
}

// بناء filter_complex كامل لعدد N مصدر — يعيد سلسلة الفلاتر
function buildFilterChain(n, W, H, inputs) {
  // inputs: [{hasAudio, duration}] بالترتيب — المصادر الصامتة حصلت على مدخل lavfi إضافي بعد المدخلات الحقيقية
  const parts = [];
  const concatItems = [];
  let lavfiIndex = n; // مدخلات anullsrc تبدأ بعد المدخلات الحقيقية
  for (let i = 0; i < n; i++) {
    // فيديو: توحيد إلى W×H مع pad و fps=30 و SAR=1 و yuv420p
    parts.push(
      `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1,format=yuv420p[v${i}]`
    );
    let audioLabel;
    if (inputs[i].hasAudio) {
      // صوت موجود: إعادة تشكيل موحدة
      parts.push(`[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
      audioLabel = `[a${i}]`;
    } else {
      // بلا صوت: مدخل anullsrc صامت بنفس مدة المصدر
      const dur = Math.max(0.1, inputs[i].duration || 1);
      audioLabel = `[a${i}]`;
      parts.push(`[${i}:v]anull` /* placeholder لا يُستخدم — يُزال أدناه */);
      parts.pop();
      // المدخل الصامت (lavfi) كُتب كمدخل مستقل؛ نربط تسميته هنا
      parts.push(`[${lavfiIndex}:a]aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
      lavfiIndex++;
    }
    concatItems.push(`[v${i}]${audioLabel}`);
  }
  parts.push(`${concatItems.join('')}concat=n=${n}:v=1:a=1[vout][aout]`);
  return parts.join(';');
}

// الدمج الفعلي: paths بالترتيب، probes من ffprobe — يكتب المخرج ويحدّث التقدم (0-40 سحب، 40-90 ترميز)
async function mergeFiles(filePaths, probes, destPath, onProgress) {
  const { ffmpeg } = getBinaries();
  const args = ['-y', '-nostdin'];

  // أكبر دقة بين المدخلات مع الحدود (أبعاد زوجية)
  const maxW = Math.max(...probes.map((p) => p.width || 0));
  const maxH = Math.max(...probes.map((p) => p.height || 0));
  const W = Math.min(1920, even(maxW || 1280));
  const H = Math.min(1080, even(maxH || 720));

  // المدخلات الحقيقية
  for (const f of filePaths) args.push('-i', f);
  // مدخلات anullsrc للمصادر الصامتة (بنفس مدتها)
  const silent = probes.filter((p) => !p.hasAudio);
  for (const p of silent) {
    const dur = Math.max(0.1, p.duration || 1);
    args.push('-f', 'lavfi', '-t', dur.toFixed(3), '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
  }

  const inputsMeta = probes.map((p) => ({ hasAudio: p.hasAudio, duration: p.duration }));
  const filter = buildFilterChain(filePaths.length, W, H, inputsMeta);

  args.push(
    '-filter_complex', filter,
    '-map', '[vout]',
    '-map', '[aout]',
    '-c:v', 'libx264',
    '-preset', LIMITS.FFMPEG_PRESET,
    '-crf', '18',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '44100',
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    '-nostats',
    destPath
  );

  const total = probes.reduce((s, p) => s + (p.duration || 0), 0);
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let buf = '';
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error('انتهت المهلة أثناء الترميز (300 ثانية)'));
    }, 290000);

    p.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line.trim());
        if (m && total > 0 && onProgress) {
          const t = Number(m[1]) / 1e6;
          const pct = 40 + Math.min(50, (t / total) * 50); // 40 → 90 أثناء الترميز
          onProgress(Math.round(pct));
        }
      }
    });
    p.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ width: W, height: H });
      else reject(new Error(`فشل الترميز (كود ${code}): ${stderr.slice(-1200)}`));
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

module.exports = { LIMITS, getBinaries, probe, downloadUrlToTmp, buildFilterChain, mergeFiles, even };
