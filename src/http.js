import fs from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function send(res, status, body = '', headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}
export const json = (res, obj, status = 200) =>
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
export const html = (res, body, status = 200) =>
  send(res, status, body, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
export const redirect = (res, url) => send(res, 302, '', { Location: url, 'Cache-Control': 'no-store' });

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'הקובץ או הבקשה גדולים מדי')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function clientIp(req) {
  const h = req.headers;
  return (h['cf-connecting-ip'] || (h['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '').toString();
}

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const rx = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    this.routes.push({ method, rx, keys, handler, opts });
  }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.rx.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return null;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

export function serveFile(res, rootDir, relPath, cache = 'no-cache') {
  const root = path.resolve(rootDir);
  const full = path.resolve(root, '.' + path.posix.normalize('/' + relPath));
  if (full !== root && !full.startsWith(root + path.sep)) return false;
  let st;
  try { st = fs.statSync(full); } catch { return false; }
  if (!st.isFile()) return false;
  const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(full).pipe(res);
  return true;
}
