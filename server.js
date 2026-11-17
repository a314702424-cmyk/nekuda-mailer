import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './src/db.js';
import { Router, HttpError, json, send, readBody, serveFile } from './src/http.js';
import { registerApi, sessionUser } from './src/api.js';
import { registerPublic } from './src/public.js';
import { Worker } from './src/worker.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

export function createApp({ dataDir, startWorker = true, log = console } = {}) {
  const db = openDb(dataDir);
  const worker = new Worker(db, log);
  const router = new Router();
  const webDir = path.join(ROOT, 'web');
  registerApi(router, { db, worker, version: VERSION });
  registerPublic(router, { db });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const found = router.match(req.method, url.pathname);
      if (found) {
        const { route, params } = found;
        const ctx = { req, res, params, query: url.searchParams, body: {}, raw: null, user: null };
        if (route.opts.auth) {
          ctx.user = sessionUser(db, req);
          if (!ctx.user) throw new HttpError(401, 'נדרשת התחברות');
          if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'nm') throw new HttpError(403, 'בקשה לא מורשית');
          const perm = route.opts.perm;
          if (perm && ![].concat(perm).some((p) => ctx.user.can(p))) throw new HttpError(403, 'אין לך הרשאה לפעולה הזו');
        }
        if (req.method !== 'GET') {
          ctx.raw = await readBody(req, route.opts.bodyLimit || 1024 * 1024);
          if (!route.opts.rawBody && !route.opts.anyBody) {
            if (!route.opts.auth && req.headers['x-requested-with'] !== 'nm') throw new HttpError(403, 'בקשה לא מורשית');
            try { ctx.body = ctx.raw.length ? JSON.parse(ctx.raw.toString('utf8')) : {}; }
            catch { throw new HttpError(400, 'גוף הבקשה אינו JSON תקין'); }
            if (!ctx.body || typeof ctx.body !== 'object') ctx.body = {};
          }
        }
        await route.handler(ctx);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(404, 'לא נמצא');
      if (url.pathname.startsWith('/media/')) {
        if (serveFile(res, path.join(dataDir, 'uploads'), url.pathname.slice(7), 'public, max-age=31536000, immutable')) return;
        throw new HttpError(404, 'לא נמצא');
      }
      const rel = url.pathname === '/' || url.pathname === '/admin' ? 'index.html' : url.pathname;
      if (serveFile(res, webDir, rel)) return;
      throw new HttpError(404, 'לא נמצא');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log.error('[http]', req.method, req.url, e);
      if ((req.url || '').startsWith('/api/')) json(res, { error: status === 500 ? 'שגיאת שרת' : e.message }, status);
      else send(res, status, status === 500 ? 'Server error' : e.message, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
  });

  if (startWorker) worker.start();
  return { server, db, worker, close: () => new Promise((r) => { worker.stop(); server.close(() => { db.close(); r(); }); server.closeAllConnections?.(); }) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3080;
  const host = process.env.HOST || '127.0.0.1';
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
  const app = createApp({ dataDir });
  app.server.listen(port, host, () => console.log(`nekuda-mailer ${VERSION} מאזין על http://${host}:${port} (נתונים: ${dataDir})`));
  const stop = () => app.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
