// GET /api/config — الحدود العامة + version (يستخدمها السيرفر الأول لفحص الجهوزية)
'use strict';

const { LIMITS } = require('../lib/merge');
const { sendJson } = require('../lib/util');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'الطريقة غير مسموحة — GET فقط' });
  }
  try {
    await require('../lib/db').ensureSchema();
  } catch {
    return sendJson(res, 503, { error: 'قاعدة البيانات غير متاحة' });
  }
  return sendJson(res, 200, {
    version: '1.0.0',
    output: { format: 'mp4', video: 'h264 CRF 18', audio: 'aac 192k/44100Hz', maxResolution: '1080p', fps: 30 },
    limits: {
      maxSources: LIMITS.MAX_SOURCES,
      sourceMaxMB: LIMITS.SOURCE_MAX_MB,
      outputMaxMB: LIMITS.OUTPUT_MAX_MB,
      maxTotalDurationSec: LIMITS.MAX_TOTAL_DURATION_SEC,
      uploadChunkBytes: 4 * 1024 * 1024,
      retentionHours: 24,
    },
  });
};
