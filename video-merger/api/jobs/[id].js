// GET /api/jobs/{id} — الحالة + التقدم + الرابط عند الاكتمال
// DELETE /api/jobs/{id} — حذف فوري شامل (jobs + sources + chunks)
'use strict';

const store = require('../../lib/db');
const { sendJson, sendError } = require('../../lib/util');

function baseUrlOf(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
  return `${proto}://${host}`;
}

module.exports = async (req, res) => {
  const id = req.query.id;
  try {
    if (req.method === 'GET') {
      const job = await store.getJob(id);
      if (!job) return sendError(res, 404, 'المهمة غير موجودة (أو انتهت صلاحيتها بعد 24 ساعة)');
      const base = baseUrlOf(req);
      const done = job.status === 'done';
      return sendJson(res, 200, {
        jobId: job.id,
        status: job.status,
        progress: job.progress,
        videoUrl: done ? `${base}/api/jobs/${job.id}/video` : undefined,
        downloadUrl: done ? `${base}/api/jobs/${job.id}/video?download=1` : undefined,
        size: job.result_size ?? undefined,
        duration: job.result_duration ?? undefined,
        resolution: job.result_resolution ?? undefined,
        error: job.error ?? undefined,
        expiresAt: job.expires_at,
      });
    }

    if (req.method === 'DELETE') {
      const job = await store.getJob(id);
      if (!job) return sendError(res, 404, 'المهمة غير موجودة');
      await store.deleteJobCascade(id);
      return sendJson(res, 200, { ok: true, deleted: id });
    }

    return sendError(res, 405, 'الطريقة غير مسموحة — GET أو DELETE فقط');
  } catch (e) {
    return sendError(res, 500, `خطأ داخلي: ${e.message}`);
  }
};
