// GET /api/cron — حذف المهام المنتهية صلاحيتها (Cron يومي في vercel.json)
// التنظيف الكسول يعمل أيضًا عند كل إنشاء/دمج — هذه نقطة إضافية مضمونة الجدولة
'use strict';

const store = require('../lib/db');
const { sendJson, sendError } = require('../lib/util');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return sendError(res, 405, 'الطريقة غير مسموحة — GET فقط');
  try {
    const deleted = await store.cleanupExpired(new Date().toISOString());
    return sendJson(res, 200, { ok: true, deleted });
  } catch (e) {
    return sendError(res, 500, `فشل التنظيف: ${e.message}`);
  }
};
