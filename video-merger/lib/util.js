// أدوات مساعدة عامة لدوال الـ API — استجابات JSON موحدة وقراءة الأجسام وتحليل المدى
'use strict';

// استجابة JSON بمفتاح حالة صحيح
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

// قراءة الجسم كـ Buffer (ثنائي أو نص) بحد أقصى
function readBodyBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on('data', (c) => {
      size += c.length;
      if (maxBytes && size > maxBytes) {
        overflow = true;
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (overflow) return reject(Object.assign(new Error('BODY_TOO_LARGE'), { code: 'BODY_TOO_LARGE' }));
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

// تحليل ترويسة Range: bytes=start-end → {start, end} ضمن الحجم
function parseRange(header, totalSize) {
  if (!header || !totalSize) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null;
  let start = m[1] === '' ? null : parseInt(m[1], 10);
  let end = m[2] === '' ? null : parseInt(m[2], 10);
  if (start === null && end === null) return null;
  if (start === null) {
    // آخر N بايت
    const n = Math.min(end, totalSize);
    start = totalSize - n;
    end = totalSize - 1;
  } else if (end === null || end >= totalSize) {
    end = totalSize - 1;
  }
  if (start > end || start >= totalSize) return null; // مدى غير قابل للإشباع
  return { start, end };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// تنسيق المدة كنسبة تقدم — من 0 إلى 100
function clampPct(v) {
  const n = Number(v) || 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

module.exports = { sendJson, sendError, readBodyBuffer, parseRange, sleep, clampPct };
