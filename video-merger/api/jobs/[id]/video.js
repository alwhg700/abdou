// GET /api/jobs/{id}/video — بث الناتج بدعم Range (206 + Content-Range) للتقديم/الترجيع
// ?download=1 → تنزيل كملف مرفق
'use strict';

const store = require('../../../lib/db');
const { sendError } = require('../../../lib/util');

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendError(res, 405, 'الطريقة غير مسموحة — استخدم GET');
  }
  const id = req.query.id;
  try {
    const job = await store.getJob(id);
    if (!job) return sendError(res, 404, 'المهمة غير موجودة (أو انتهت صلاحيتها بعد 24 ساعة)');
    if (job.status !== 'done') {
      return sendError(res, 409, `الناتج غير جاهز — حالة المهمة: ${job.status}`);
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' });
      return res.end();
    }
    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', `attachment; filename="merged-${id}.mp4"`);
    }
    const ok = await store.streamOutput(id, res, req.headers['range'], null);
    if (!ok && !res.headersSent) return sendError(res, 404, 'لا يوجد ناتج مخزن لهذه المهمة');
  } catch (e) {
    if (!res.headersSent) return sendError(res, 500, `خطأ في البث: ${e.message}`);
    try { res.end(); } catch { /* تجاهل */ }
  }
};
