// POST /api/jobs — إنشاء مهمة دمج | GET غير مسموح على المجموعة
// يقبل {"videos":["رابط1","رابط2"]} أو {"sources":[{"kind":"url","url":...},{"kind":"file","name":...,"size":...,"mime":...}]}
'use strict';

const store = require('../lib/db');
const { LIMITS } = require('../lib/merge');
const { sendJson, sendError, readBodyBuffer } = require('../lib/util');

const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024 - 256 * 1024; // أقل من حد 4.5MB في Vercel بأمان

function baseUrlOf(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
  return `${proto}://${host}`;
}

function isHttpUrl(u) {
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch {
    return false;
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return sendError(res, 405, 'الطريقة غير مسموحة — استخدم POST لإنشاء مهمة');
  }

  let body;
  try {
    const raw = await readBodyBuffer(req, 1024 * 1024);
    body = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    return sendError(res, 400, 'جسم الطلب ليس JSON صالحًا');
  }

  try {
    // التنظيف الكسول للمهام المنتهية
    await store.cleanupExpired(new Date().toISOString());

    // توحيد المصادر من الشكلين المقبولين
    let sources = [];
    if (Array.isArray(body.videos)) {
      sources = body.videos.map((u) => ({ kind: 'url', url: String(u || '').trim() }));
    } else if (Array.isArray(body.sources)) {
      sources = body.sources.map((s) => {
        if (s && s.kind === 'file') {
          return {
            kind: 'file',
            name: String(s.name || `file-${Date.now()}`).slice(0, 200),
            size: Number(s.size) || null,
            mime: String(s.mime || 'video/mp4').slice(0, 100),
          };
        }
        return { kind: 'url', url: String((s && s.url) || '').trim() };
      });
    }
    sources = sources.filter((s) => (s.kind === 'url' ? s.url : true));

    if (sources.length < 2) {
      return sendError(res, 400, 'الدمج يحتاج مقطعَين على الأقل — مرّر روابط فيديو مباشرة أو ملفات');
    }
    if (sources.length > LIMITS.MAX_SOURCES) {
      return sendError(res, 400, `أقصى عدد مقاطع للدمج هو ${LIMITS.MAX_SOURCES}`);
    }
    for (const s of sources) {
      if (s.kind === 'url' && !isHttpUrl(s.url)) {
        return sendError(res, 400, `الرابط يجب أن يكون رابط فيديو مباشر http/https: ${s.url || '(فارغ)'}`);
      }
      if (s.kind === 'file') {
        if (!s.size || s.size <= 0) return sendError(res, 400, 'حجم الملف (size) مطلوب لمصادر الملفات');
        if (s.size > LIMITS.SOURCE_MAX_MB * 1048576) {
          return sendError(res, 413, `حجم الملف يتجاوز الحد ${LIMITS.SOURCE_MAX_MB}MB: ${s.name}`);
        }
      }
    }

    const id = store.newJobId();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 3600 * 1000).toISOString(); // تُحذف تلقائيًا بعد 24 ساعة
    const hasFiles = sources.some((s) => s.kind === 'file');
    const status = hasFiles ? 'uploading' : 'queued';

    await store.createJob({
      id,
      status,
      sources,
      createdAt: now.toISOString(),
      expiresAt,
    });
    for (let i = 0; i < sources.length; i++) {
      await store.addSource(id, i, sources[i]);
    }

    const base = baseUrlOf(req);
    const payload = {
      jobId: id,
      status,
      statusUrl: `${base}/api/jobs/${id}`,
      processUrl: `${base}/api/jobs/${id}/process`,
      expiresAt,
    };
    if (hasFiles) {
      payload.uploads = sources.map((s, i) =>
        s.kind === 'file'
          ? { seq: i, uploadUrl: `${base}/api/upload?job=${id}&seq=${i}&chunk=`, uploadChunkBytes: UPLOAD_CHUNK_BYTES }
          : { seq: i, uploadUrl: null }
      );
    }
    return sendJson(res, 201, payload);
  } catch (e) {
    return sendError(res, 500, `تعذّر إنشاء المهمة: ${e.message}`);
  }
};
