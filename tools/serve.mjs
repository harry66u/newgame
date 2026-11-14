#!/usr/bin/env node
/* Fall Line: a small static file server for playing locally.
     node tools/serve.mjs [port]        default port 5173
   Serves the repository root on this machine only. Set HOST=0.0.0.0 to reach it from a phone on
   the same network. Nothing is cached, so a reload always shows the files as they are. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || process.env.PORT || 5173);
const HOST = process.env.HOST || '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

function send(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); return send(res, 405, 'Method not allowed\n'); }

  let pathname;
  try { pathname = decodeURIComponent(String(req.url).split(/[?#]/)[0]); } catch (e) { return send(res, 400, 'Bad request\n'); }
  // Nothing above the root, by any spelling: no "..", no backslashes, no NUL, no hidden files.
  const parts = pathname.split('/');
  if (!pathname.startsWith('/') || /[\\\0]/.test(pathname) || parts.includes('..') || parts.some((p) => p.startsWith('.') && p !== '.')) {
    return send(res, 403, 'Forbidden\n');
  }
  let file = path.join(ROOT, path.normalize(pathname));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return send(res, 403, 'Forbidden\n');

  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) { file = path.join(file, 'index.html'); return fs.stat(file, serve); }
    serve(err, st);
  });

  function serve(err, st) {
    if (err || !st.isFile()) return send(res, 404, 'Not found\n');
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }
});

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Try: node tools/serve.mjs ${PORT + 1}` : String(e.message || e));
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`Fall Line is at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/   (Ctrl+C to stop)`);
});
