// طبقة قاعدة البيانات — Turso (libSQL) عبر HTTP
// كل شيء يُخزَّن هنا: بيانات المهام، أجزاء ملفات المصادر، والفيديو الناتج (Blobs)
// كل Blob يُقسَّم إلى صفوف 2MB (حد HTTP في Turso) ويُقرأ تدفقيًا بصفحات من 8 صفوف
'use strict';

const { createClient } = require('@libsql/client');

const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB لكل صف — حد آمن لضغط HTTP في Turso
const READ_PAGE_ROWS = 8; // صفوف لكل استعلام قراءة متتالي

let _client = null;
let _schemaPromise = null;

function db() {
  if (!_client) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) {
      throw new Error('متغيرات البيئة TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبة');
    }
    _client = createClient({ url, authToken: token });
  }
  return _client;
}

async function ensureSchema() {
  if (!_schemaPromise) {
    _schemaPromise = (async () => {
      const c = db();
      await c.execute(`
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'queued',
          progress INTEGER DEFAULT 0,
          error TEXT,
          sources_json TEXT DEFAULT '[]',
          result_size INTEGER,
          result_duration REAL,
          result_resolution TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          updated_at TEXT
        )`);
      await c.execute(`
        CREATE TABLE IF NOT EXISTS sources (
          job_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          kind TEXT NOT NULL,
          url TEXT,
          name TEXT,
          size INTEGER,
          mime TEXT,
          received INTEGER DEFAULT 0,
          ready INTEGER DEFAULT 0,
          PRIMARY KEY (job_id, seq)
        )`);
      await c.execute(`
        CREATE TABLE IF NOT EXISTS source_chunks (
          job_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          chunk INTEGER NOT NULL,
          data BLOB NOT NULL,
          PRIMARY KEY (job_id, seq, chunk)
        )`);
      await c.execute(`
        CREATE TABLE IF NOT EXISTS output_chunks (
          job_id TEXT NOT NULL,
          chunk INTEGER NOT NULL,
          data BLOB NOT NULL,
          PRIMARY KEY (job_id, chunk)
        )`);
    })().catch((e) => {
      _schemaPromise = null;
      throw e;
    });
  }
  return _schemaPromise;
}

async function sql(query, args = []) {
  const rs = await db().execute({ sql: query, args });
  return rs;
}

async function rows(query, args = []) {
  const rs = await db().execute({ sql: query, args });
  return rs.rows;
}

// ---------- المهام ----------

async function createJob(job) {
  await ensureSchema();
  await sql(
    `INSERT INTO jobs (id, status, progress, sources_json, created_at, expires_at, updated_at)
     VALUES (?, ?, 0, ?, ?, ?, ?)`,
    [job.id, job.status, JSON.stringify(job.sources || []), job.createdAt, job.expiresAt, job.createdAt]
  );
}

async function getJob(id) {
  await ensureSchema();
  const r = await rows('SELECT * FROM jobs WHERE id = ? LIMIT 1', [id]);
  if (!r.length) return null;
  const j = r[0];
  return {
    id: j.id,
    status: j.status,
    progress: Number(j.progress) || 0,
    error: j.error || null,
    sources: safeParse(j.sources_json, []),
    result_size: j.result_size == null ? null : Number(j.result_size),
    result_duration: j.result_duration == null ? null : Number(j.result_duration),
    result_resolution: j.result_resolution || null,
    created_at: j.created_at,
    expires_at: j.expires_at,
    updated_at: j.updated_at,
  };
}

async function updateJob(id, patch) {
  await ensureSchema();
  const sets = [];
  const args = [];
  if (patch.status !== undefined) { sets.push('status = ?'); args.push(patch.status); }
  if (patch.progress !== undefined) { sets.push('progress = ?'); args.push(Math.max(0, Math.min(100, Math.round(patch.progress)))); }
  if (patch.error !== undefined) { sets.push('error = ?'); args.push(patch.error); }
  if (patch.result_size !== undefined) { sets.push('result_size = ?'); args.push(patch.result_size); }
  if (patch.result_duration !== undefined) { sets.push('result_duration = ?'); args.push(patch.result_duration); }
  if (patch.result_resolution !== undefined) { sets.push('result_resolution = ?'); args.push(patch.result_resolution); }
  if (patch.sources_json !== undefined) { sets.push('sources_json = ?'); args.push(JSON.stringify(patch.sources_json)); }
  if (patch.updated_at !== undefined) { sets.push('updated_at = ?'); args.push(patch.updated_at); }
  if (!sets.length) return;
  args.push(id);
  await sql(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`, args);
}

// حذف شامل: jobs + sources + source_chunks + output_chunks في batch واحد
async function deleteJobCascade(id) {
  await ensureSchema();
  const c = db();
  await c.batch(
    [
      { sql: 'DELETE FROM source_chunks WHERE job_id = ?', args: [id] },
      { sql: 'DELETE FROM output_chunks WHERE job_id = ?', args: [id] },
      { sql: 'DELETE FROM sources WHERE job_id = ?', args: [id] },
      { sql: 'DELETE FROM jobs WHERE id = ?', args: [id] },
    ],
    'write'
  );
}

async function listExpiredJobs(nowIso) {
  await ensureSchema();
  const r = await rows('SELECT id FROM jobs WHERE expires_at < ?', [nowIso]);
  return r.map((x) => x.id);
}

// ---------- المصادر ----------

async function addSource(jobId, seq, src) {
  await ensureSchema();
  await sql(
    `INSERT INTO sources (job_id, seq, kind, url, name, size, mime, received, ready)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [jobId, seq, src.kind, src.url || null, src.name || null, src.size == null ? null : Number(src.size), src.mime || null, src.kind === 'url' ? 1 : 0]
  );
}

async function listSources(jobId) {
  await ensureSchema();
  const r = await rows('SELECT * FROM sources WHERE job_id = ? ORDER BY seq ASC', [jobId]);
  return r.map((s) => ({
    job_id: s.job_id,
    seq: Number(s.seq),
    kind: s.kind,
    url: s.url || null,
    name: s.name || null,
    size: s.size == null ? null : Number(s.size),
    mime: s.mime || null,
    received: Number(s.received) || 0,
    ready: Number(s.ready) === 1,
  }));
}

// ---------- أجزاء المصادر (رفع الملفات) ----------

// حفظ جزء 2MB وتحديث عدّاد البايتات المستلمة — عند اكتمال الحجم يُعلَّم المصدر جاهزًا
async function addSourceChunk(jobId, seq, chunkIndex, buf) {
  await ensureSchema();
  const c = db();
  await sql(
    'INSERT OR REPLACE INTO source_chunks (job_id, seq, chunk, data) VALUES (?, ?, ?, ?)',
    [jobId, seq, chunkIndex, buf]
  );
  await sql('UPDATE sources SET received = received + ?, ready = 0 WHERE job_id = ? AND seq = ?', [
    buf.length, jobId, seq,
  ]);
  const src = (await listSources(jobId)).find((s) => s.seq === Number(seq));
  if (src && src.size != null && src.received >= src.size) {
    await sql('UPDATE sources SET ready = 1 WHERE job_id = ? AND seq = ?', [jobId, seq]);
    return { complete: true, received: src.received };
  }
  return { complete: false, received: src ? src.received : 0 };
}

// تجميع مصدر مرفوع من أجزائه إلى مسار ملف محلي (تدفقيًا صفحة بصفحة)
async function assembleSourceToTmp(jobId, seq, destPath, fs) {
  await ensureSchema();
  const out = fs.createWriteStream(destPath);
  let page = 0;
  for (;;) {
    const r = await rows(
      'SELECT chunk, data FROM source_chunks WHERE job_id = ? AND seq = ? ORDER BY chunk ASC LIMIT ? OFFSET ?',
      [jobId, seq, READ_PAGE_ROWS, page * READ_PAGE_ROWS]
    );
    if (!r.length) break;
    for (const row of r) {
      const buf = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
      if (!out.write(buf)) {
        await new Promise((res) => out.once('drain', res));
      }
    }
    page++;
    if (r.length < READ_PAGE_ROWS) break;
  }
  await new Promise((res) => out.end(res));
}

async function deleteSourceChunks(jobId) {
  await sql('DELETE FROM source_chunks WHERE job_id = ?', [jobId]);
}

// ---------- الناتج ----------

// تقسيم ملف الناتج إلى صفوف 2MB وتخزينها
async function storeOutputFromFile(jobId, filePath, fs) {
  await ensureSchema();
  const c = db();
  const stat = fs.statSync(filePath);
  const totalChunks = Math.ceil(stat.size / CHUNK_SIZE);
  const batch = [];
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(CHUNK_SIZE);
  for (let i = 0; i < totalChunks; i++) {
    const read = fs.readSync(fd, buf, 0, CHUNK_SIZE, i * CHUNK_SIZE);
    const slice = Buffer.from(buf.subarray(0, read)); // نسخة مستقلة قبل إعادة الاستخدام
    batch.push({ sql: 'INSERT OR REPLACE INTO output_chunks (job_id, chunk, data) VALUES (?, ?, ?)', args: [jobId, i, slice] });
    if (batch.length >= 10) {
      await c.batch(batch.splice(0), 'write');
    }
  }
  fs.closeSync(fd);
  if (batch.length) await c.batch(batch, 'write');
  return stat.size;
}

// قراءة الناتج كتدفق Node مع تقليم أول/آخر جزء حسب المدى المطلوب (لدعم Range/206)
// rangeHeader: قيمة ترويسة Range الخام (مثل "bytes=0-1023") — يُحلَّل هنا حيث الحجم الفعلي معروف
async function streamOutput(jobId, res, rangeHeader, fs) {
  await ensureSchema();
  const totalRow = await rows(
    `SELECT COALESCE(SUM(LENGTH(data)), 0) AS total FROM output_chunks WHERE job_id = ?`,
    [jobId]
  );
  const total = Number(totalRow[0].total) || 0;
  if (!total) return false;

  let range = null;
  if (rangeHeader) {
    range = parseRangeHeader(rangeHeader, total);
    if (!range) {
      // مدى غير قابل للإشباع → 416
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return true;
    }
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : total - 1;
  const length = end - start + 1;

  const headers = {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  if (range) {
    headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
    res.writeHead(206, headers);
  } else {
    headers['Content-Length'] = total;
    res.writeHead(200, headers);
  }

  // صفحة صفحة: تجاوز الأجزاء قبل start ثم الكتابة حتى end
  let offset = 0;
  let page = 0;
  let written = 0;
  for (;;) {
    const r = await rows(
      'SELECT chunk, data FROM output_chunks WHERE job_id = ? ORDER BY chunk ASC LIMIT ? OFFSET ?',
      [jobId, READ_PAGE_ROWS, page * READ_PAGE_ROWS]
    );
    if (!r.length || written >= length) break;
    for (const row of r) {
      let buf = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
      const chunkStart = offset;
      const chunkEnd = offset + buf.length - 1;
      offset = chunkEnd + 1;
      if (chunkEnd < start) continue;
      let sliceStart = 0;
      let sliceEnd = buf.length - 1;
      if (chunkStart < start) sliceStart = start - chunkStart;
      if (chunkEnd > end) sliceEnd = end - chunkStart;
      const piece = buf.subarray(sliceStart, sliceEnd + 1);
      const remain = length - written;
      const out = remain < piece.length ? piece.subarray(0, remain) : piece;
      if (!res.write(out)) {
        await new Promise((res2) => res.once('drain', res2));
      }
      written += out.length;
      if (written >= length) break;
    }
    page++;
    if (r.length < READ_PAGE_ROWS) break;
  }
  res.end();
  return true;
}

async function deleteOutputChunks(jobId) {
  await sql('DELETE FROM output_chunks WHERE job_id = ?', [jobId]);
}

// التنظيف الكسول: حذف كل المهام المنتهية (يُستدعى عند الإنشاء/الدمج + نقطة cron)
async function cleanupExpired(nowIso) {
  const ids = await listExpiredJobs(nowIso);
  for (const id of ids) {
    try {
      await deleteJobCascade(id);
    } catch {
      /* تجاهل — cron القادم يعيد المحاولة */
    }
  }
  return ids.length;
}

function safeParse(s, dflt) {
  try {
    const v = JSON.parse(s || '[]');
    return v == null ? dflt : v;
  } catch {
    return dflt;
  }
}

// تحليل ترويسة Range ضمن الحجم الفعلي — يعيد null للمدى غير القابل للإشباع
function parseRangeHeader(header, totalSize) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m) return null;
  let start = m[1] === '' ? null : parseInt(m[1], 10);
  let end = m[2] === '' ? null : parseInt(m[2], 10);
  if (start === null && end === null) return null;
  if (start === null) {
    const n = Math.min(end, totalSize);
    start = totalSize - n;
    end = totalSize - 1;
  } else if (end === null || end >= totalSize) {
    end = totalSize - 1;
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= totalSize) return null;
  return { start, end };
}

function newJobId() {
  // معرّف قصير قابل للقراءة (12 حرفًا) — كافٍ وأنيق في الروابط
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let id = '';
  const bytes = require('node:crypto').randomBytes(12);
  for (const b of bytes) id += alphabet[b % alphabet.length];
  return id;
}

module.exports = {
  CHUNK_SIZE,
  READ_PAGE_ROWS,
  db,
  ensureSchema,
  sql,
  rows,
  createJob,
  getJob,
  updateJob,
  deleteJobCascade,
  listExpiredJobs,
  addSource,
  listSources,
  addSourceChunk,
  assembleSourceToTmp,
  deleteSourceChunks,
  storeOutputFromFile,
  streamOutput,
  deleteOutputChunks,
  cleanupExpired,
  newJobId,
};
