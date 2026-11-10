// POST /api/jobs/{id}/process — تنفيذ الدمج كاملًا (متزامن): سحب ← ترميز ← تخزين
// نجاح → 200 {status:"done",...} | قيد المعالجة فعله → 202 | فشل → 500 {"error":"..."}
'use strict';

const { processJob, ProcessError } = require('../../../lib/process');
const { sendJson, sendError } = require('../../../lib/util');

function baseUrlOf(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
  return `${proto}://${host}`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return sendError(res, 405, 'الطريقة غير مسموحة — استخدم POST');
  }
  const id = req.query.id;
  try {
    const result = await processJob(id, baseUrlOf(req));
    if (result.status === 'processing') {
      return sendJson(res, 202, result); // المهمة قيد المعالجة فعله
    }
    return sendJson(res, 200, result);
  } catch (e) {
    if (e instanceof ProcessError) {
      const status = e.status === 404 || e.status === 400 || e.status === 409 || e.status === 413 ? e.status : 500;
      return sendError(res, status, e.message);
    }
    return sendError(res, 500, `فشل الدمج: ${e.message}`);
  }
};
