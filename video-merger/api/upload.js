// POST /api/upload?job=<id>&seq=<n>&chunk=<k> — رفع أجزاء الملفات (ثنائي ≤4MB)
// حد حجم الطلب في Vercel ≈ 4.5MB → الواجهة ترفع بأجزاء 4MB مع إعادة محاولة ×3
'use strict';

const store = require('../lib/db');
const { sendJson, sendError, readBodyBuffer } = require('../lib/util');

const MAX_CHUNK = 4 * 1024 * 1024; // 4MB لكل جزء

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return sendError(res, 405, 'الطريقة غير مسموحة — استخدم POST ثنائي');
  }
  const jobId = req.query.job;
  const seq = parseInt(req.query.seq, 10);
  const chunkIndex = parseInt(req.query.chunk, 10);
  if (!jobId || Number.isNaN(seq) || Number.isNaN(chunkIndex) || seq < 0 || chunkIndex < 0) {
    return sendError(res, 400, 'معطيات الرفع ناقصة أو تالفة — مطلوب job و seq و chunk');
  }
  try {
    const job = await store.getJob(jobId);
    if (!job) return sendError(res, 404, 'المهمة غير موجودة');
    if (job.status !== 'uploading' && job.status !== 'queued') {
      return sendError(res, 409, `حالة المهمة لا تسمح بالرفع: ${job.status}`);
    }
    const sources = await store.listSources(jobId);
    const src = sources.find((s) => s.seq === seq);
    if (!src) return sendError(res, 404, `لا يوجد مصدر بالترتيب ${seq}`);
    if (src.kind !== 'file') return sendError(res, 400, 'هذا المصدر رابط وليس ملفًا مرفوعًا');
    if (src.ready) return sendError(res, 409, 'هذا المصدر اكتمل رفعه مسبقًا');

    let buf;
    try {
      buf = await readBodyBuffer(req, MAX_CHUNK);
    } catch (e) {
      if (e.code === 'BODY_TOO_LARGE') return sendError(res, 413, `حجم الجزء يتجاوز ${MAX_CHUNK / 1048576}MB`);
      throw e;
    }
    if (!buf.length) return sendError(res, 400, 'الجزء فارغ');

    const r = await store.addSourceChunk(jobId, seq, chunkIndex, buf);

    // اكتمل كل شيء؟ إن جاهزت كل المصادر نحوّل المهمة إلى queued
    if (r.complete) {
      const all = await store.listSources(jobId);
      if (all.every((s) => s.kind === 'url' || s.ready)) {
        await store.updateJob(jobId, { status: 'queued', updated_at: new Date().toISOString() });
      }
    }
    return sendJson(res, 200, { ok: true, seq, chunk: chunkIndex, received: r.received, complete: r.complete });
  } catch (e) {
    return sendError(res, 500, `تعذّر حفظ الجزء: ${e.message}`);
  }
};
