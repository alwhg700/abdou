// خط معالجة الدمج الكامل — يُستدعى من نقطة /api/jobs/{id}/process
// التدفق: سحب المصادر (0-40) → ترميز (40-90) → تخزين الناتج (100)
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('./db');
const { probe, downloadUrlToTmp, mergeFiles, LIMITS } = require('./merge');

class ProcessError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// القاعدة الحتمية: فشل واضح برسالة عربية — لا انهيارات صامتة
async function processJob(jobId, baseUrl) {
  const job = await store.getJob(jobId);
  if (!job) throw new ProcessError(404, 'المهمة غير موجودة');
  if (job.status === 'processing') return { status: 'processing', progress: job.progress };
  if (job.status === 'done') return donePayload(job, baseUrl);
  if (job.status === 'failed') throw new ProcessError(409, `المهمة فاشلة سابقًا: ${job.error || 'سبب غير معروف'}`);

  const sources = await store.listSources(jobId);
  if (sources.length < 2) throw new ProcessError(400, 'الدمج يحتاج مقطعَين على الأقل');
  if (sources.length > LIMITS.MAX_SOURCES) {
    throw new ProcessError(400, `أقصى عدد مقاطع للدمج هو ${LIMITS.MAX_SOURCES}`);
  }
  const notReady = sources.filter((s) => s.kind === 'file' && !s.ready);
  if (notReady.length) {
    throw new ProcessError(409, `الملفات المرفوعة غير مكتملة بعد (${notReady.map((s) => s.seq + 1).join('، ')})`);
  }

  await store.updateJob(jobId, { status: 'processing', progress: 2, error: null, updated_at: new Date().toISOString() });
  const workDir = path.join(os.tmpdir(), `merge-${jobId}`);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    // 1) سحب المصادر — روابط تُنزَّل، ملفات تُجمَّع من أجزاء Turso (0 → 40)
    const filePaths = [];
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      const dest = path.join(workDir, `src-${String(i).padStart(2, '0')}.bin`);
      if (s.kind === 'url') {
        await store.updateJob(jobId, { progress: Math.round(5 + (30 * i) / sources.length), updated_at: new Date().toISOString() });
        await downloadUrlToTmp(s.url, dest, LIMITS.SOURCE_MAX_MB * 1048576);
      } else {
        await store.assembleSourceToTmp(jobId, s.seq, dest, fs);
      }
      filePaths.push(dest);
    }
    await store.updateJob(jobId, { progress: 35, updated_at: new Date().toISOString() });

    // 2) فحص كل مصدر بـ ffprobe + التحقق من المدة الإجمالية
    const probes = [];
    let totalDuration = 0;
    for (const f of filePaths) {
      const p = await probe(f);
      probes.push(p);
      totalDuration += p.duration || 0;
    }
    if (probes.some((p) => !p.duration || p.duration <= 0)) {
      throw new ProcessError(400, 'تعذّر تحديد مدة أحد المصادر — الملف قد يكون تالفًا');
    }
    if (totalDuration > LIMITS.MAX_TOTAL_DURATION_SEC) {
      throw new ProcessError(400, `مجموع مدد المقاطع يتجاوز ${LIMITS.MAX_TOTAL_DURATION_SEC} ثانية (${Math.round(totalDuration)} ث)`);
    }

    // 3) الترميز (40 → 90) — يقرأ out_time_us من ffmpeg
    const outPath = path.join(workDir, 'output.mp4');
    await mergeFiles(filePaths, probes, outPath, (pct) => {
      store.updateJob(jobId, { progress: pct, updated_at: new Date().toISOString() }).catch(() => {});
    });

    // 4) فحص حجم الناتج
    const stat = fs.statSync(outPath);
    if (stat.size > LIMITS.OUTPUT_MAX_MB * 1048576) {
      throw new ProcessError(413, `حجم الناتج يتجاوز ${LIMITS.OUTPUT_MAX_MB}MB (${Math.round(stat.size / 1048576)}MB)`);
    }

    // 5) تخزين الناتج في Turso (صفوف 2MB) ثم حذف أجزاء المصادر — الناتج فقط هو المطلوب
    const size = await store.storeOutputFromFile(jobId, outPath, fs);
    await store.deleteSourceChunks(jobId);
    const finalProbe = await probe(outPath);
    await store.updateJob(jobId, {
      status: 'done',
      progress: 100,
      result_size: size,
      result_duration: finalProbe.duration,
      result_resolution: `${finalProbe.width}x${finalProbe.height}`,
      updated_at: new Date().toISOString(),
    });

    const updated = await store.getJob(jobId);
    return donePayload(updated, baseUrl);
  } catch (e) {
    const status = e instanceof ProcessError ? e.status : 500;
    const msg = e.message || 'فشل الدمج لسبب غير معروف';
    await store
      .updateJob(jobId, { status: 'failed', error: msg, updated_at: new Date().toISOString() })
      .catch(() => {});
    throw new ProcessError(status, msg);
  } finally {
    // لا نظام ملفات دائم — نظّف /tmp دائمًا
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* تجاهل */
    }
  }
}

function donePayload(job, baseUrl) {
  const videoUrl = `${baseUrl}/api/jobs/${job.id}/video`;
  return {
    status: 'done',
    videoUrl,
    downloadUrl: `${videoUrl}?download=1`,
    size: job.result_size,
    duration: job.result_duration,
    resolution: job.result_resolution,
    expiresAt: job.expires_at,
  };
}

module.exports = { processJob, ProcessError, donePayload };
