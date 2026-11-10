// خادم تطوير محلي يحاكي بيئة Vercel Serverless:
// - يحمّل .env يدويًا
// - يحلّل المسارات الديناميكية ويضعها في req.query (مثل Vercel: req.query.id)
// - يقدّم الواجهة الثابتة من public/
// - يستدعي دوال api/ مباشرة بنفس توقيع Vercel (req, res)
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// تحميل .env يدويًا (بدون اعتماديات خارجية)
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnv();

const PORT = parseInt(process.env.PORT || '3001', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');

// جداول المسارات: نمط → دالة، مع استخراج المعاملات الديناميكية إلى req.query
const routes = [
  { method: null, pattern: /^\/api\/jobs\/([^/]+)\/video$/, file: './api/jobs/[id]/video.js', params: ['id'] },
  { method: null, pattern: /^\/api\/jobs\/([^/]+)\/process$/, file: './api/jobs/[id]/process.js', params: ['id'] },
  { method: null, pattern: /^\/api\/jobs\/([^/]+)$/, file: './api/jobs/[id].js', params: ['id'] },
  { method: null, pattern: /^\/api\/jobs$/, file: './api/jobs.js', params: [] },
  { method: null, pattern: /^\/api\/upload$/, file: './api/upload.js', params: [] },
  { method: null, pattern: /^\/api\/config$/, file: './api/config.js', params: [] },
  { method: null, pattern: /^\/api\/cron$/, file: './api/cron.js', params: [] },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  req.query = Object.fromEntries(url.searchParams);

  // API
  for (const r of routes) {
    const m = r.pattern.exec(url.pathname);
    if (m) {
      r.params.forEach((name, i) => {
        req.query[name] = decodeURIComponent(m[i + 1]);
      });
      try {
        const handler = require(r.file);
        await handler(req, res);
      } catch (e) {
        console.error('[api error]', r.file, e);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        }
        if (!res.writableEnded) {
          res.end(JSON.stringify({ error: `خطأ داخلي: ${e.message}` }));
        }
      }
      return;
    }
  }

  // ثابت: الواجهة
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const abs = path.normalize(path.join(PUBLIC_DIR, file));
  if (abs.startsWith(PUBLIC_DIR) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
    fs.createReadStream(abs).pipe(res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'المسار غير موجود' }));
});

server.listen(PORT, () => {
  console.log(`[video-merger] dev server يعمل على http://localhost:${PORT} (يحاكي بيئة Vercel)`);
});
