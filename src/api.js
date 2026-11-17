import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, json, send, html as sendHtml, clientIp, parseCookies } from './http.js';
import { now, DEFAULT_SETTINGS } from './db.js';
import { parseContacts, isEmail, csvCell } from './csv.js';
import { defaultDesign, letterDesign, newsletterDesign, htmlToText } from '../web/shared/render.js';
import { checkEmail, extractLinks } from '../web/shared/check.js';
import { campaignHtml, makeToken, personalize, prepareCampaign } from './track.js';
import { enqueueCampaign, sentToday, campaignAttachments } from './worker.js';
import { buildMessage, SmtpConnection, smtpOptions } from './mailer.js';
import { ALL_PERMS, permFor } from '../web/shared/perms.js';
import { htmlToPdf, chromePath } from './pdf.js';

const FIELD_KEY = /^[a-z][a-z0-9_]{1,20}$/;
const RESERVED = ['name', 'first_name', 'email', 'unsubscribe_url', 'webview_url', 'preferences_url', 'base', 'token'];
/** שדות מותאמים מוגדרים בהגדרות, שורה לכל שדה: מפתח:כותרת */
export function customFields(db) {
  const out = [];
  for (const line of String(db.setting('customFields') || '').split('\n')) {
    const i = line.indexOf(':');
    const key = (i < 0 ? line : line.slice(0, i)).trim();
    if (!FIELD_KEY.test(key) || RESERVED.includes(key) || out.some((f) => f.key === key)) continue;
    out.push({ key, label: (i < 0 ? key : line.slice(i + 1).trim()) || key });
  }
  return out.slice(0, 20);
}
const ATTACH_TYPES = { '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.txt': 'text/plain',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ics': 'text/calendar' };

const SESSION_DAYS = 30;
const COOKIE = 'nm_sess';
const STATUSES = ['active', 'pending', 'unsubscribed', 'bounced', 'blocked'];
const loginFails = new Map();

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}
function checkPassword(password, stored) {
  const [, saltHex, hashHex] = String(stored).split('$');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

export function sessionUser(db, req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const u = db.get('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>? AND u.active=1', token, now());
  if (!u) return null;
  let perms = [];
  try { perms = JSON.parse(u.perms).filter((x) => ALL_PERMS.includes(x)); } catch { /* הרשאות פגומות: בלי הרשאות */ }
  if (u.role === 'admin') perms = [...ALL_PERMS];
  return { id: u.id, username: u.username, email: u.email, role: u.role, perms, can: (perm) => perms.includes(perm) };
}

export function startSession(db, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.run('DELETE FROM sessions WHERE expires_at<?', now());
  db.run('INSERT INTO sessions(token, user_id, expires_at) VALUES(?,?,?)', token, userId, now() + SESSION_DAYS * 86400);
  const secure = db.setting('baseUrl').startsWith('https://') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}

const need = (cond, msg, status = 400) => { if (!cond) throw new HttpError(status, msg); };
const int = (v) => { const n = Number(v); need(Number.isInteger(n) && n > 0, 'מזהה לא תקין'); return n; };
const str = (v, max = 500) => String(v ?? '').slice(0, max);

function campaignStats(db, id) {
  const r = db.get(`SELECT COUNT(*) total,
    COALESCE(SUM(sent_at IS NOT NULL),0) sent, COALESCE(SUM(status='pending'),0) pending,
    COALESCE(SUM(status='failed'),0) failed, COALESCE(SUM(status='bounced'),0) bounced,
    COALESCE(SUM(status='skipped'),0) skipped, COALESCE(SUM(opened_at IS NOT NULL),0) opened,
    COALESCE(SUM(clicked_at IS NOT NULL),0) clicked, COALESCE(SUM(unsubscribed_at IS NOT NULL),0) unsubscribed
    FROM deliveries WHERE campaign_id=?`, id);
  for (const k of Object.keys(r)) r[k] = Number(r[k]);
  return r;
}

function campaignOut(db, c, full = false) {
  const out = {
    id: c.id, subject: c.subject, preheader: c.preheader, fromName: c.from_name, fromEmail: c.from_email,
    replyTo: c.reply_to, mode: c.mode, status: c.status, scheduledAt: c.scheduled_at, startedAt: c.started_at,
    finishedAt: c.finished_at, createdAt: c.created_at, updatedAt: c.updated_at,
    listIds: db.all('SELECT list_id FROM campaign_lists WHERE campaign_id=?', c.id).map((r) => r.list_id),
    stats: campaignStats(db, c.id), public: !!c.public, auto: !!c.auto, subjectB: c.subject_b || '',
    attachments: (() => { try { return JSON.parse(c.attachments || '[]'); } catch { return []; } })(),
  };
  if (full) {
    out.html = c.html || '';
    try { out.design = JSON.parse(c.design || 'null') || defaultDesign(); } catch { out.design = defaultDesign(); }
  }
  return out;
}

function recipientCount(db, campaignId) {
  const total = Number(db.get(`SELECT COUNT(DISTINCT s.id) n FROM subscriptions sp JOIN subscribers s ON s.id=sp.subscriber_id
    WHERE sp.list_id IN (SELECT list_id FROM campaign_lists WHERE campaign_id=?) AND s.status='active'`, campaignId).n);
  const already = Number(db.get('SELECT COUNT(*) n FROM deliveries WHERE campaign_id=?', campaignId).n);
  const fresh = Number(db.get(`SELECT COUNT(DISTINCT s.id) n FROM subscriptions sp JOIN subscribers s ON s.id=sp.subscriber_id
    WHERE sp.list_id IN (SELECT list_id FROM campaign_lists WHERE campaign_id=?) AND s.status='active'
    AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.campaign_id=? AND d.subscriber_id=s.id)`, campaignId, campaignId).n);
  return { total, already, fresh };
}

function previewHtml(db, c, subscriber) {
  const settings = db.settings();
  const baseUrl = settings.baseUrl.replace(/\/+$/, '');
  let h = campaignHtml(c, db);
  if (!h.includes('{{unsubscribe_url}}')) {
    h += '<div style="padding:16px;font:13px Arial;color:#6b7280;text-align:center" dir="rtl"><a href="{{unsubscribe_url}}" style="color:#6b7280">להסרה מרשימת התפוצה</a></div>';
  }
  const token = makeToken(settings.secret, c.id, subscriber.id);
  const lists = subscriber.id ? db.all('SELECT list_id FROM subscriptions WHERE subscriber_id=?', subscriber.id).map((r) => r.list_id) : undefined;
  return { html: personalize(h, { baseUrl, token, subscriber, isHtml: true, lists }), token, settings, baseUrl };
}

export function registerApi(router, { db, worker, version }) {
  const api = (method, pattern, handler, opts = {}) => router.add(method, '/api' + pattern, handler, { auth: true, perm: permFor(method, pattern), ...opts });

  // ---------- מצב והתחברות ----------
  router.add('GET', '/api/meta', ({ req, res }) => {
    const user = sessionUser(db, req);
    json(res, {
      version, needsSetup: !db.get('SELECT 1 x FROM users LIMIT 1'),
      user: user ? { id: user.id, name: user.username, role: user.role, perms: user.perms } : null,
      google: !!(db.setting('googleClientId') && db.setting('googleClientSecret')),
      pdf: !!chromePath(),
      fields: user ? customFields(db) : [],
    });
  });

  router.add('POST', '/api/setup', ({ res, body }) => {
    need(!db.get('SELECT 1 x FROM users LIMIT 1'), 'המערכת כבר הוגדרה', 409);
    const username = str(body.username, 60).trim();
    need(username.length >= 3, 'שם המשתמש קצר מדי');
    need(String(body.password || '').length >= 10, 'הסיסמה חייבת להיות באורך 10 תווים לפחות');
    const r = db.run("INSERT INTO users(username, pass_hash, created_at, role) VALUES(?,?,?,'admin')", username, hashPassword(body.password), now());
    startSession(db, res, Number(r.lastInsertRowid));
    json(res, { ok: true });
  });

  router.add('POST', '/api/login', ({ req, res, body }) => {
    const ip = clientIp(req);
    const f = loginFails.get(ip);
    if (f && f.until > Date.now() && f.n >= 5) throw new HttpError(429, 'יותר מדי ניסיונות. נסה שוב בעוד רבע שעה');
    const u = db.get('SELECT * FROM users WHERE username=? AND active=1', str(body.username, 60).trim());
    if (!u || !u.pass_hash || !checkPassword(String(body.password || ''), u.pass_hash)) {
      const cur = f && f.until > Date.now() ? f : { n: 0, until: 0 };
      loginFails.set(ip, { n: cur.n + 1, until: Date.now() + 15 * 60000 });
      throw new HttpError(401, 'שם משתמש או סיסמה שגויים');
    }
    loginFails.delete(ip);
    startSession(db, res, u.id);
    json(res, { ok: true });
  });

  api('POST', '/logout', ({ req, res }) => {
    db.run('DELETE FROM sessions WHERE token=?', parseCookies(req)[COOKIE] || '');
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
    json(res, { ok: true });
  });

  api('POST', '/password', ({ user, body, res }) => {
    const u = db.get('SELECT * FROM users WHERE id=?', user.id);
    need(!u.pass_hash || checkPassword(String(body.current || ''), u.pass_hash), 'הסיסמה הנוכחית שגויה', 403);
    need(String(body.password || '').length >= 10, 'הסיסמה חייבת להיות באורך 10 תווים לפחות');
    db.run('UPDATE users SET pass_hash=? WHERE id=?', hashPassword(body.password), user.id);
    json(res, { ok: true });
  });

  // ---------- לוח בקרה ----------
  api('GET', '/dashboard', ({ res, user }) => {
    const byStatus = {};
    for (const r of db.all('SELECT status, COUNT(*) n FROM subscribers GROUP BY status')) byStatus[r.status] = Number(r.n);
    json(res, {
      subscribers: byStatus,
      lists: Number(db.get('SELECT COUNT(*) n FROM lists').n),
      campaigns: Number(db.get('SELECT COUNT(*) n FROM campaigns').n),
      sentToday: sentToday(db),
      dailyLimit: Number(db.setting('dailyLimit')) || 0,
      queue: Number(db.get("SELECT COUNT(*) n FROM deliveries WHERE status='pending'").n),
      worker: worker ? worker.state : null,
      recent: user.can('campaigns.view') ? db.all('SELECT * FROM campaigns ORDER BY id DESC LIMIT 6').map((c) => campaignOut(db, c)) : [],
    });
  });

  // ---------- משתמשים והרשאות ----------
  const userOut = (u) => { let perms = []; try { perms = JSON.parse(u.perms); } catch { /* ריק */ } return { id: u.id, username: u.username, email: u.email, role: u.role, perms, active: !!u.active, hasPassword: !!u.pass_hash, createdAt: u.created_at }; };
  const admins = (exceptId = 0) => Number(db.get("SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1 AND id<>?", exceptId).n);
  const userFields = (body, existing) => {
    const username = str(body.username, 60).trim();
    const email = str(body.email, 254).trim().toLowerCase();
    need(username.length >= 3, 'שם המשתמש קצר מדי');
    need(!email || isEmail(email), 'כתובת המייל לא תקינה');
    need(!body.password || String(body.password).length >= 10, 'הסיסמה חייבת להיות באורך 10 תווים לפחות');
    need(body.password || existing?.pass_hash || email, 'צריך סיסמה, או כתובת מייל של Google לכניסה');
    const clashName = db.get('SELECT id FROM users WHERE username=?', username);
    need(!clashName || clashName.id === existing?.id, 'שם המשתמש כבר קיים', 409);
    const clashMail = email && db.get('SELECT id FROM users WHERE email=? COLLATE NOCASE', email);
    need(!clashMail || clashMail.id === existing?.id, 'כתובת המייל כבר משויכת למשתמש אחר', 409);
    const role = body.role === 'admin' ? 'admin' : 'user';
    const perms = (Array.isArray(body.perms) ? body.perms : []).filter((x) => ALL_PERMS.includes(x));
    return { username, email, role, perms: JSON.stringify(perms), active: body.active === false ? 0 : 1 };
  };
  api('GET', '/users', ({ res }) => json(res, db.all('SELECT * FROM users ORDER BY id').map(userOut)));
  api('POST', '/users', ({ res, body }) => {
    const f = userFields(body, null);
    const r = db.run('INSERT INTO users(username, email, pass_hash, role, perms, active, created_at) VALUES(?,?,?,?,?,?,?)',
      f.username, f.email, body.password ? hashPassword(body.password) : '', f.role, f.perms, f.active, now());
    json(res, { id: Number(r.lastInsertRowid) });
  });
  api('PUT', '/users/:id', ({ res, body, params, user }) => {
    const existing = db.get('SELECT * FROM users WHERE id=?', int(params.id));
    need(existing, 'המשתמש לא נמצא', 404);
    const f = userFields(body, existing);
    const losesAdmin = existing.role === 'admin' && existing.active && (f.role !== 'admin' || !f.active);
    need(!losesAdmin || admins(existing.id) > 0, 'חייב להישאר לפחות מנהל פעיל אחד', 409);
    need(!(existing.id === user.id && !f.active), 'אי אפשר להשבית את החשבון שלך', 409);
    db.tx(() => {
      db.run('UPDATE users SET username=?, email=?, role=?, perms=?, active=? WHERE id=?', f.username, f.email, f.role, f.perms, f.active, existing.id);
      if (body.password) db.run('UPDATE users SET pass_hash=? WHERE id=?', hashPassword(body.password), existing.id);
      if (existing.id !== user.id && (!f.active || body.password)) db.run('DELETE FROM sessions WHERE user_id=?', existing.id);
    });
    json(res, { ok: true });
  });
  api('DELETE', '/users/:id', ({ res, params, user }) => {
    const existing = db.get('SELECT * FROM users WHERE id=?', int(params.id));
    need(existing, 'המשתמש לא נמצא', 404);
    need(existing.id !== user.id, 'אי אפשר למחוק את החשבון שלך', 409);
    need(!(existing.role === 'admin' && existing.active) || admins(existing.id) > 0, 'חייב להישאר לפחות מנהל פעיל אחד', 409);
    db.tx(() => { db.run('DELETE FROM sessions WHERE user_id=?', existing.id); db.run('DELETE FROM users WHERE id=?', existing.id); });
    json(res, { ok: true });
  });

  // ---------- תור שליחה ----------
  api('GET', '/queue', ({ res }) => {
    json(res, {
      worker: worker ? worker.state : null,
      sentToday: sentToday(db), dailyLimit: Number(db.setting('dailyLimit')) || 0, sendPerSecond: Number(db.setting('sendPerSecond')) || 0,
      campaigns: db.all(`SELECT c.id, c.subject, c.status, c.scheduled_at,
        (SELECT COUNT(*) FROM deliveries d WHERE d.campaign_id=c.id AND d.status='pending') pending,
        (SELECT COUNT(*) FROM deliveries d WHERE d.campaign_id=c.id AND d.status='pending' AND d.tries>0) retrying,
        (SELECT MIN(next_try) FROM deliveries d WHERE d.campaign_id=c.id AND d.status='pending' AND d.tries>0) next_retry,
        (SELECT COUNT(*) FROM deliveries d WHERE d.campaign_id=c.id AND d.sent_at IS NOT NULL) sent
        FROM campaigns c WHERE c.status IN ('sending','paused','scheduled') ORDER BY c.id`)
        .map((c) => ({ ...c, pending: Number(c.pending), retrying: Number(c.retrying), sent: Number(c.sent) })),
    });
  });

  // ---------- רשימות ----------
  api('GET', '/lists', ({ res }) => {
    json(res, db.all(`SELECT l.*,
      (SELECT COUNT(*) FROM subscriptions sp WHERE sp.list_id=l.id) total,
      (SELECT COUNT(*) FROM subscriptions sp JOIN subscribers s ON s.id=sp.subscriber_id WHERE sp.list_id=l.id AND s.status='active') active
      FROM lists l ORDER BY l.id DESC`).map((l) => ({ ...l, total: Number(l.total), active: Number(l.active) })));
  });
  api('POST', '/lists', ({ res, body }) => {
    need(str(body.name).trim(), 'חסר שם רשימה');
    const r = db.run('INSERT INTO lists(name, description, color, created_at) VALUES(?,?,?,?)',
      str(body.name, 120).trim(), str(body.description), str(body.color, 9) || '#4f6bed', now());
    json(res, { id: Number(r.lastInsertRowid) });
  });
  api('PUT', '/lists/:id', ({ res, body, params }) => {
    need(str(body.name).trim(), 'חסר שם רשימה');
    db.run('UPDATE lists SET name=?, description=?, color=? WHERE id=?', str(body.name, 120).trim(), str(body.description), str(body.color, 9) || '#4f6bed', int(params.id));
    json(res, { ok: true });
  });
  api('DELETE', '/lists/:id', ({ res, params }) => {
    const id = int(params.id);
    db.tx(() => {
      db.run('DELETE FROM subscriptions WHERE list_id=?', id);
      db.run('DELETE FROM campaign_lists WHERE list_id=?', id);
      db.run('DELETE FROM lists WHERE id=?', id);
    });
    json(res, { ok: true });
  });
  api('POST', '/lists/segment', ({ res, body }) => {
    const cid = int(body.campaignId);
    const cond = { opened: 'opened_at IS NOT NULL', not_opened: 'sent_at IS NOT NULL AND opened_at IS NULL', clicked: 'clicked_at IS NOT NULL' }[body.kind];
    need(cond, 'סוג פילוח לא מוכר');
    need(str(body.name).trim(), 'חסר שם רשימה');
    const out = db.tx(() => {
      const id = Number(db.run('INSERT INTO lists(name, description, created_at) VALUES(?,?,?)', str(body.name, 120).trim(), `פילוח מגליון ${cid}`, now()).lastInsertRowid);
      const n = db.run(`INSERT OR IGNORE INTO subscriptions(subscriber_id, list_id, created_at)
        SELECT subscriber_id, ?, ? FROM deliveries WHERE campaign_id=? AND ${cond}`, id, now(), cid).changes;
      return { id, added: Number(n) };
    });
    json(res, out);
  });

  // ---------- נמענים ----------
  api('GET', '/subscribers', ({ res, query }) => {
    const where = [];
    const p = [];
    const q = str(query.get('q'), 100).trim();
    if (q) { where.push('(s.email LIKE ? OR s.name LIKE ?)'); p.push(`%${q}%`, `%${q}%`); }
    const status = query.get('status');
    if (STATUSES.includes(status)) { where.push('s.status=?'); p.push(status); }
    const list = Number(query.get('list'));
    if (list > 0) { where.push('EXISTS (SELECT 1 FROM subscriptions sp WHERE sp.subscriber_id=s.id AND sp.list_id=?)'); p.push(list); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const page = Math.max(1, Number(query.get('page')) || 1);
    const size = 50;
    const total = Number(db.get(`SELECT COUNT(*) n FROM subscribers s ${w}`, ...p).n);
    const rows = db.all(`SELECT s.id, s.email, s.name, s.status, s.source, s.created_at, s.last_open_at, s.fields,
      (SELECT GROUP_CONCAT(list_id) FROM subscriptions sp WHERE sp.subscriber_id=s.id) lists
      FROM subscribers s ${w} ORDER BY s.id DESC LIMIT ? OFFSET ?`, ...p, size, (page - 1) * size)
      .map((r) => ({ ...r, fields: (() => { try { return JSON.parse(r.fields || '{}'); } catch { return {}; } })(), lists: r.lists ? String(r.lists).split(',').map(Number) : [] }));
    json(res, { total, page, size, rows });
  });

  const subscriberFilter = (get) => {
    const where = [];
    const p = [];
    const q = str(get('q'), 100).trim();
    if (q) { where.push('(s.email LIKE ? OR s.name LIKE ?)'); p.push(`%${q}%`, `%${q}%`); }
    if (STATUSES.includes(get('status'))) { where.push('s.status=?'); p.push(get('status')); }
    const list = Number(get('list'));
    if (list > 0) { where.push('EXISTS (SELECT 1 FROM subscriptions sp WHERE sp.subscriber_id=s.id AND sp.list_id=?)'); p.push(list); }
    return { w: where.length ? 'WHERE ' + where.join(' AND ') : '', p };
  };
  api('POST', '/subscribers/bulk', ({ res, body, user }) => {
    const f = body.filter || {};
    const { w, p } = subscriberFilter((k) => f[k]);
    need(w || body.all === true, 'לא נבחר סינון. כדי לפעול על כל הנמענים יש לאשר זאת במפורש');
    const ids = `SELECT s.id FROM subscribers s ${w}`;
    const count = Number(db.get(`SELECT COUNT(*) n FROM subscribers s ${w}`, ...p).n);
    if (body.dryRun) return json(res, { count });
    const listId = Number(body.listId) || 0;
    db.tx(() => {
      switch (body.action) {
        case 'addToList':
          need(db.get('SELECT 1 x FROM lists WHERE id=?', listId), 'הרשימה לא נמצאה', 404);
          db.run(`INSERT OR IGNORE INTO subscriptions(subscriber_id, list_id, created_at) SELECT id, ?, ? FROM (${ids})`, listId, now(), ...p);
          break;
        case 'removeFromList':
          db.run(`DELETE FROM subscriptions WHERE list_id=? AND subscriber_id IN (${ids})`, listId, ...p);
          break;
        case 'setStatus':
          need(STATUSES.includes(body.status), 'מצב לא מוכר');
          db.run(`UPDATE subscribers SET status=?, unsubscribed_at=CASE WHEN ?='unsubscribed' THEN COALESCE(unsubscribed_at, ?) ELSE NULL END WHERE id IN (${ids})`, body.status, body.status, now(), ...p);
          break;
        case 'delete':
          need(user.can('subscribers.delete'), 'אין לך הרשאה למחוק נמענים', 403);
          // קודם הנמענים ורק אחר כך השיוכים, כי הסינון עצמו עשוי להישען על השיוך לרשימה
          db.run(`DELETE FROM subscribers WHERE id IN (${ids})`, ...p);
          db.run('DELETE FROM subscriptions WHERE subscriber_id NOT IN (SELECT id FROM subscribers)');
          break;
        default: need(false, 'פעולה לא מוכרת');
      }
    });
    json(res, { count });
  });

  const saveSubscriber = (id, body) => {
    const email = str(body.email, 254).trim().toLowerCase();
    need(isEmail(email), 'כתובת המייל לא תקינה');
    const status = STATUSES.includes(body.status) ? body.status : 'active';
    const lists = Array.isArray(body.listIds) ? body.listIds.map(Number).filter((n) => n > 0) : [];
    return db.tx(() => {
      const clash = db.get('SELECT id FROM subscribers WHERE email=?', email);
      need(!clash || clash.id === id, 'הכתובת כבר קיימת במערכת', 409);
      if (id) {
        db.run('UPDATE subscribers SET email=?, name=?, status=?, unsubscribed_at=CASE WHEN ?=\'unsubscribed\' THEN COALESCE(unsubscribed_at, ?) ELSE NULL END WHERE id=?',
          email, str(body.name, 200), status, status, now(), id);
      } else {
        id = Number(db.run('INSERT INTO subscribers(email, name, status, source, created_at) VALUES(?,?,?,?,?)',
          email, str(body.name, 200), status, 'manual', now()).lastInsertRowid);
      }
      if (body.fields && typeof body.fields === 'object') {
        const clean = {};
        for (const f of customFields(db)) { const v = str(body.fields[f.key], 300).trim(); if (v) clean[f.key] = v; }
        db.run('UPDATE subscribers SET fields=? WHERE id=?', JSON.stringify(clean), id);
      }
      // שומרים את מועד ההצטרפות של רשימות קיימות, כי אוטומציות נשענות עליו
      const keep = lists.length ? ` AND list_id NOT IN (${lists.map(() => '?').join(',')})` : '';
      db.run(`DELETE FROM subscriptions WHERE subscriber_id=?${keep}`, id, ...lists);
      for (const l of lists) db.run('INSERT OR IGNORE INTO subscriptions(subscriber_id, list_id, created_at) VALUES(?,?,?)', id, l, now());
      return id;
    });
  };
  api('POST', '/subscribers', ({ res, body }) => json(res, { id: saveSubscriber(0, body) }));
  api('PUT', '/subscribers/:id', ({ res, body, params }) => json(res, { id: saveSubscriber(int(params.id), body) }));
  api('GET', '/subscribers/:id/history', ({ res, params }) => {
    const id = int(params.id);
    const s = db.get('SELECT created_at, source, consent_note, unsubscribed_at, last_open_at, last_click_at FROM subscribers WHERE id=?', id);
    need(s, 'הנמען לא נמצא', 404);
    json(res, {
      subscriber: s,
      deliveries: db.all(`SELECT c.id, c.subject, d.status, d.sent_at, d.opened_at, d.opens, d.clicked_at, d.clicks, d.unsubscribed_at, d.error
        FROM deliveries d JOIN campaigns c ON c.id=d.campaign_id WHERE d.subscriber_id=? ORDER BY COALESCE(d.sent_at, 0) DESC, c.id DESC LIMIT 100`, id),
      bounces: db.all('SELECT type, detail, created_at FROM bounces WHERE subscriber_id=? ORDER BY id DESC LIMIT 30', id),
    });
  });

  api('DELETE', '/subscribers/:id', ({ res, params }) => {
    const id = int(params.id);
    db.tx(() => {
      db.run('DELETE FROM subscriptions WHERE subscriber_id=?', id);
      db.run('DELETE FROM subscribers WHERE id=?', id);
    });
    json(res, { ok: true });
  });

  api('POST', '/import', ({ res, body }) => {
    const { rows, invalid } = parseContacts(body.text);
    need(rows.length, invalid ? 'לא נמצאה אף כתובת תקינה' : 'לא התקבל תוכן לייבוא');
    const status = body.status === 'unsubscribed' ? 'unsubscribed' : 'active';
    const lists = Array.isArray(body.listIds) ? body.listIds.map(Number).filter((n) => n > 0) : [];
    const source = str(body.source, 100) || 'import';
    let added = 0;
    let existing = 0;
    const t = now();
    db.tx(() => {
      for (const r of rows) {
        let row = db.get('SELECT id FROM subscribers WHERE email=?', r.email);
        if (row) {
          existing++;
          if (r.name) db.run("UPDATE subscribers SET name=? WHERE id=? AND name=''", r.name, row.id);
          if (status === 'unsubscribed') db.run("UPDATE subscribers SET status='unsubscribed', unsubscribed_at=COALESCE(unsubscribed_at, ?) WHERE id=?", t, row.id);
        } else {
          added++;
          row = { id: Number(db.run('INSERT INTO subscribers(email, name, status, source, created_at, unsubscribed_at) VALUES(?,?,?,?,?,?)',
            r.email, r.name, status, source, t, status === 'unsubscribed' ? t : null).lastInsertRowid) };
        }
        for (const l of lists) db.run('INSERT OR IGNORE INTO subscriptions(subscriber_id, list_id, created_at) VALUES(?,?,?)', row.id, l, t);
      }
    });
    json(res, { added, existing, invalid, total: rows.length });
  }, { bodyLimit: 80 * 1024 * 1024 });

  api('GET', '/export', ({ res, query }) => {
    const where = ['s.id > ?'];
    const p = [];
    const status = query.get('status');
    if (STATUSES.includes(status)) { where.push('s.status=?'); p.push(status); }
    const list = Number(query.get('list'));
    if (list > 0) { where.push('EXISTS (SELECT 1 FROM subscriptions sp WHERE sp.subscriber_id=s.id AND sp.list_id=?)'); p.push(list); }
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="subscribers.csv"', 'Cache-Control': 'no-store' });
    res.write('﻿email,name,status,created,source\r\n');
    let last = 0;
    for (;;) {
      const rows = db.all(`SELECT s.id, s.email, s.name, s.status, s.created_at, s.source FROM subscribers s WHERE ${where.join(' AND ')} ORDER BY s.id LIMIT 5000`, last, ...p);
      if (!rows.length) break;
      last = rows[rows.length - 1].id;
      res.write(rows.map((r) => [r.email, r.name, r.status, new Date(r.created_at * 1000).toISOString(), r.source].map(csvCell).join(',')).join('\r\n') + '\r\n');
    }
    res.end();
  });

  // ---------- ערכת מותג, בלוקים שמורים ----------
  const brand = () => { try { return JSON.parse(db.setting('brand') || '{}') || {}; } catch { return {}; } };
  const newDesign = (template) => {
    const d = template === 'letter' ? letterDesign() : template === 'newsletter' ? newsletterDesign() : defaultDesign();
    const b = brand();
    if (template === 'letter') { delete b.bg; delete b.contentBg; }
    d.settings = { ...d.settings, ...b, utm: '' };
    return d;
  };
  api('GET', '/brand', ({ res }) => json(res, brand()));
  api('PUT', '/brand', ({ res, body }) => {
    const keep = ['width', 'bg', 'contentBg', 'font', 'fontSize', 'color', 'link', 'dir', 'mobileFontSize', 'btnBg', 'btnColor', 'btnRadius'];
    const out = {};
    for (const k of keep) if (body[k] !== undefined && body[k] !== null) out[k] = body[k];
    db.setSetting('brand', JSON.stringify(out));
    json(res, { ok: true });
  });

  const blockOut = (r) => { let block = null; try { block = JSON.parse(r.block); } catch { /* בלוק פגום */ } return { id: r.id, name: r.name, synced: !!r.synced, block, updatedAt: r.updated_at }; };
  api('GET', '/blocks', ({ res }) => json(res, db.all('SELECT * FROM saved_blocks ORDER BY name').map(blockOut).filter((b) => b.block)));
  api('POST', '/blocks', ({ res, body }) => {
    need(str(body.name).trim(), 'חסר שם לבלוק');
    need(body.block && typeof body.block === 'object' && body.block.type && body.block.type !== 'synced', 'הבלוק לא תקין');
    const r = db.run('INSERT INTO saved_blocks(name, block, synced, updated_at) VALUES(?,?,?,?)', str(body.name, 100).trim(), JSON.stringify(body.block), body.synced ? 1 : 0, now());
    json(res, { id: Number(r.lastInsertRowid) });
  }, { bodyLimit: 1024 * 1024 });
  api('PUT', '/blocks/:id', ({ res, body, params }) => {
    need(body.block && typeof body.block === 'object' && body.block.type && body.block.type !== 'synced', 'הבלוק לא תקין');
    const r = db.run('UPDATE saved_blocks SET block=?, name=COALESCE(?, name), updated_at=? WHERE id=?', JSON.stringify(body.block), body.name ? str(body.name, 100).trim() : null, now(), int(params.id));
    need(r.changes, 'הבלוק לא נמצא', 404);
    json(res, { ok: true });
  }, { bodyLimit: 1024 * 1024 });
  api('DELETE', '/blocks/:id', ({ res, params }) => { db.run('DELETE FROM saved_blocks WHERE id=?', int(params.id)); json(res, { ok: true }); });

  // ---------- גליונות ----------
  const getCampaign = (id) => { const c = db.get('SELECT * FROM campaigns WHERE id=?', int(id)); need(c, 'הגליון לא נמצא', 404); return c; };

  api('GET', '/campaigns', ({ res }) => json(res, db.all('SELECT * FROM campaigns ORDER BY id DESC LIMIT 300').map((c) => campaignOut(db, c))));
  api('POST', '/campaigns', ({ res, body }) => {
    const s = db.settings();
    const t = now();
    const r = db.run(`INSERT INTO campaigns(subject, from_name, from_email, reply_to, mode, design, html, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`, str(body.subject) || 'גליון חדש', s.fromName, s.fromEmail, s.replyTo,
    body.mode === 'html' ? 'html' : 'blocks', JSON.stringify(newDesign(body.template)), '', t, t);
    json(res, { id: Number(r.lastInsertRowid) });
  });
  api('GET', '/campaigns/:id', ({ res, params }) => json(res, campaignOut(db, getCampaign(params.id), true)));
  api('PUT', '/campaigns/:id', ({ res, body, params }) => {
    const c = getCampaign(params.id);
    need(['draft', 'scheduled', 'paused'].includes(c.status), 'אי אפשר לערוך גליון שנשלח או נמצא בשליחה', 409);
    need(!body.fromEmail || isEmail(body.fromEmail), 'כתובת השולח לא תקינה');
    need(!body.replyTo || isEmail(body.replyTo), 'כתובת התשובה לא תקינה');
    db.tx(() => {
      db.run(`UPDATE campaigns SET subject=?, subject_b=?, preheader=?, from_name=?, from_email=?, reply_to=?, mode=?, design=?, html=?, updated_at=? WHERE id=?`,
        str(body.subject, 300), str(body.subjectB, 300).trim(), str(body.preheader, 300), str(body.fromName, 120), str(body.fromEmail, 254).trim(), str(body.replyTo, 254).trim(),
        body.mode === 'html' ? 'html' : 'blocks', JSON.stringify(body.design || defaultDesign()), String(body.html || '').slice(0, 2_000_000), now(), c.id);
      const snap = JSON.stringify({ subject: str(body.subject, 300), preheader: str(body.preheader, 300), mode: body.mode === 'html' ? 'html' : 'blocks', design: body.design || defaultDesign(), html: String(body.html || '').slice(0, 2_000_000) });
      const last = db.get('SELECT saved_at, snapshot FROM campaign_versions WHERE campaign_id=? ORDER BY id DESC LIMIT 1', c.id);
      if ((!last || last.snapshot !== snap) && (body.snapshot || !last || now() - last.saved_at >= 600)) {
        db.run('INSERT INTO campaign_versions(campaign_id, saved_at, snapshot) VALUES(?,?,?)', c.id, now(), snap);
        db.run('DELETE FROM campaign_versions WHERE campaign_id=? AND id NOT IN (SELECT id FROM campaign_versions WHERE campaign_id=? ORDER BY id DESC LIMIT 15)', c.id, c.id);
      }
      if (Array.isArray(body.listIds)) {
        db.run('DELETE FROM campaign_lists WHERE campaign_id=?', c.id);
        for (const l of body.listIds.map(Number).filter((n) => n > 0)) db.run('INSERT OR IGNORE INTO campaign_lists(campaign_id, list_id) VALUES(?,?)', c.id, l);
      }
    });
    json(res, { ok: true });
  }, { bodyLimit: 5 * 1024 * 1024 });
  api('POST', '/campaigns/:id/duplicate', ({ res, params }) => {
    const c = getCampaign(params.id);
    const t = now();
    const id = db.tx(() => {
      const nid = Number(db.run(`INSERT INTO campaigns(subject, preheader, from_name, from_email, reply_to, mode, design, html, created_at, updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`, c.subject + ' (עותק)', c.preheader, c.from_name, c.from_email, c.reply_to, c.mode, c.design, c.html, t, t).lastInsertRowid);
      db.run('INSERT INTO campaign_lists(campaign_id, list_id) SELECT ?, list_id FROM campaign_lists WHERE campaign_id=?', nid, c.id);
      return nid;
    });
    json(res, { id });
  });
  api('DELETE', '/campaigns/:id', ({ res, params }) => {
    const c = getCampaign(params.id);
    need(!db.get('SELECT 1 x FROM automations WHERE campaign_id=?', c.id), 'הגליון משמש אוטומציה. קודם יש למחוק את האוטומציה', 409);
    need(c.status !== 'sending', 'קודם יש להשהות את השליחה', 409);
    fs.rmSync(path.join(db.dataDir, 'attachments', String(c.id)), { recursive: true, force: true });
    db.tx(() => {
      db.run('DELETE FROM poll_votes WHERE campaign_id=?', c.id);
      db.run('DELETE FROM link_clicks WHERE link_id IN (SELECT id FROM links WHERE campaign_id=?)', c.id);
      db.run('DELETE FROM links WHERE campaign_id=?', c.id);
      db.run('DELETE FROM deliveries WHERE campaign_id=?', c.id);
      db.run('DELETE FROM campaign_lists WHERE campaign_id=?', c.id);
      db.run('DELETE FROM campaign_versions WHERE campaign_id=?', c.id);
      db.run('DELETE FROM campaigns WHERE id=?', c.id);
    });
    json(res, { ok: true });
  });

  api('GET', '/campaigns/:id/preview', ({ res, params, user, query }) => {
    const c = getCampaign(params.id);
    const as = str(query.get('as'), 254).trim();
    let who = { id: 0, email: 'name@example.com', name: user.username };
    if (as) {
      who = db.get('SELECT id, email, name, fields FROM subscribers WHERE email=?', as);
      need(who, 'לא נמצא נמען עם הכתובת הזו', 404);
    }
    sendHtml(res, previewHtml(db, c, who).html);
  });

  api('GET', '/campaigns/:id/versions', ({ res, params }) => {
    const c = getCampaign(params.id);
    json(res, db.all('SELECT id, saved_at, snapshot FROM campaign_versions WHERE campaign_id=? ORDER BY id DESC', c.id).map((v) => {
      let subject = ''; try { subject = JSON.parse(v.snapshot).subject; } catch { /* גרסה פגומה */ }
      return { id: v.id, savedAt: v.saved_at, subject };
    }));
  });
  api('POST', '/campaigns/:id/versions/:vid/restore', ({ res, params }) => {
    const c = getCampaign(params.id);
    need(['draft', 'scheduled', 'paused'].includes(c.status), 'אי אפשר לשחזר גליון שנשלח', 409);
    const v = db.get('SELECT snapshot FROM campaign_versions WHERE id=? AND campaign_id=?', int(params.vid), c.id);
    need(v, 'הגרסה לא נמצאה', 404);
    const s = JSON.parse(v.snapshot);
    db.run('UPDATE campaigns SET subject=?, preheader=?, mode=?, design=?, html=?, updated_at=? WHERE id=?',
      s.subject, s.preheader, s.mode, JSON.stringify(s.design), s.html, now(), c.id);
    json(res, { ok: true });
  });

  const isPrivateHost = (h) => /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1|\[?f[cd])/i.test(h);
  api('POST', '/campaigns/:id/check', async ({ res, params, body }) => {
    const c = getCampaign(params.id);
    const settings = db.settings();
    const html = campaignHtml(c, db);
    const out = checkEmail({
      subject: c.subject, preheader: c.preheader, html, fromEmail: c.from_email || settings.fromEmail,
      design: c.mode === 'html' ? null : (() => { try { return JSON.parse(c.design); } catch { return null; } })(),
      extraTags: customFields(db).map((f) => f.key),
      hasLists: !!db.get('SELECT 1 x FROM campaign_lists WHERE campaign_id=?', c.id),
    });
    if (body.links) {
      const baseHost = (() => { try { return new URL(settings.baseUrl).host; } catch { return ''; } })();
      const links = extractLinks(html).slice(0, 40);
      const results = await Promise.all(links.map(async (url) => {
        try {
          const u = new URL(url);
          if (isPrivateHost(u.hostname) && u.host !== baseHost) return null;
          const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(7000), headers: { 'User-Agent': 'Mozilla/5.0 (nekuda-mailer link check)' } });
          await r.body?.cancel();
          return r.status >= 400 ? { level: r.status === 404 || r.status === 410 ? 'error' : 'warn', text: `הקישור מחזיר שגיאה ${r.status}: ${url}` } : null;
        } catch {
          return { level: 'warn', text: `לא הצלחתי לפתוח את הקישור: ${url}` };
        }
      }));
      out.issues.push(...results.filter(Boolean));
      out.stats.linksChecked = links.length;
    }
    json(res, out);
  });
  api('GET', '/campaigns/:id/recipients', ({ res, params }) => json(res, recipientCount(db, getCampaign(params.id).id)));

  api('POST', '/campaigns/:id/test', async ({ res, params, body }) => {
    const c = getCampaign(params.id);
    const emails = (Array.isArray(body.emails) ? body.emails : String(body.emails || '').split(/[\s,;]+/)).map((e) => String(e).trim()).filter(Boolean);
    need(emails.length && emails.length <= 5, 'יש להזין בין כתובת אחת לחמש');
    need(emails.every(isEmail), 'אחת הכתובות לא תקינה');
    const settings = db.settings();
    const fromEmail = c.from_email || settings.fromEmail;
    need(isEmail(fromEmail), 'חסרה כתובת שולח. הגדר אותה בגליון או בהגדרות');
    const conn = new SmtpConnection(smtpOptions(settings));
    const results = [];
    try {
      await conn.connect();
      for (const email of emails) {
        const p = previewHtml(db, c, { id: 0, email, name: 'בדיקה' });
        const raw = buildMessage({
          from: { name: c.from_name || settings.fromName, email: fromEmail }, to: { name: '', email },
          replyTo: c.reply_to || settings.replyTo, subject: '[בדיקה] ' + c.subject, html: p.html, text: htmlToText(p.html),
          domain: fromEmail.split('@')[1], attachments: campaignAttachments(db, c),
          headers: { 'List-Unsubscribe': `<${p.baseUrl}/u/${p.token}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        });
        try { await conn.send(settings.bounceAddress || fromEmail, email, raw); results.push({ email, ok: true }); }
        catch (e) { if (e.connection) throw e; results.push({ email, ok: false, error: e.message }); }
      }
    } catch (e) {
      throw new HttpError(502, 'שרת הדואר לא זמין: ' + e.message);
    } finally { await conn.quit(); }
    json(res, { results });
  });

  api('POST', '/campaigns/:id/send', ({ res, params, body }) => {
    const c = getCampaign(params.id);
    need(!c.auto, 'הגליון הזה משמש אוטומציה ונשלח לבד למצטרפים חדשים', 409);
    need(['draft', 'scheduled', 'sent'].includes(c.status), 'הגליון כבר בשליחה', 409);
    need(c.subject.trim(), 'חסר נושא לגליון');
    need(isEmail(c.from_email || db.setting('fromEmail')), 'חסרה כתובת שולח');
    need(db.get('SELECT 1 x FROM campaign_lists WHERE campaign_id=?', c.id), 'לא נבחרה רשימת תפוצה');
    const at = Number(body.scheduledAt) || 0;
    if (at > now() + 30) {
      db.run("UPDATE campaigns SET status='scheduled', scheduled_at=?, updated_at=? WHERE id=?", at, now(), c.id);
      return json(res, { scheduled: at });
    }
    json(res, { queued: enqueueCampaign(db, c.id) });
  });
  const flip = (from, to) => ({ res, params }) => {
    const c = getCampaign(params.id);
    need(c.status === from, 'הפעולה לא מתאימה למצב הגליון', 409);
    db.run('UPDATE campaigns SET status=?, scheduled_at=NULL, updated_at=? WHERE id=?', to, now(), c.id);
    json(res, { ok: true });
  };
  api('POST', '/campaigns/:id/pause', flip('sending', 'paused'));
  api('POST', '/campaigns/:id/resume', flip('paused', 'sending'));
  api('POST', '/campaigns/:id/unschedule', flip('scheduled', 'draft'));

  api('GET', '/campaigns/:id/stats', ({ res, params }) => {
    const c = getCampaign(params.id);
    const t0 = c.started_at || 0;
    const series = (col) => (t0 ? db.all(`SELECT (${col} - ?) / 3600 h, COUNT(*) n FROM deliveries WHERE campaign_id=? AND ${col} IS NOT NULL AND ${col} >= ? AND ${col} < ? GROUP BY h`, t0, c.id, t0, t0 + 72 * 3600) : [])
      .map((r) => ({ h: Number(r.h), n: Number(r.n) }));
    json(res, {
      campaign: campaignOut(db, c),
      timeline: { opens: series('opened_at'), clicks: series('clicked_at') },
      ab: c.subject_b ? ['a', 'b'].map((v) => {
        const r = db.get("SELECT COUNT(sent_at) sent, COUNT(opened_at) opened, COUNT(clicked_at) clicked FROM deliveries WHERE campaign_id=? AND variant=?", c.id, v);
        return { variant: v, subject: v === 'a' ? c.subject : c.subject_b, sent: Number(r.sent), opened: Number(r.opened), clicked: Number(r.clicked) };
      }) : null,
      polls: (() => {
        let blocks = [];
        try { blocks = (JSON.parse(c.design || '{}').blocks || []).filter((b) => b && b.type === 'poll' && b.pid); } catch { blocks = []; }
        return blocks.map((b) => {
          const votes = db.all('SELECT answer, COUNT(*) n FROM poll_votes WHERE campaign_id=? AND poll=? GROUP BY answer', c.id, b.pid);
          return { question: b.question, options: (b.options || []).map((o, i) => ({ text: o, votes: Number(votes.find((v) => v.answer === i)?.n || 0) })) };
        });
      })(),
      links: db.all(`SELECT l.id, l.url, l.clicks, (SELECT COUNT(*) FROM link_clicks lc WHERE lc.link_id=l.id) uniq
        FROM links l WHERE l.campaign_id=? ORDER BY l.clicks DESC`, c.id).map((l) => ({ ...l, uniq: Number(l.uniq) })),
      bounces: db.all('SELECT type, COUNT(*) n FROM bounces WHERE campaign_id=? GROUP BY type', c.id).map((b) => ({ type: b.type, n: Number(b.n) })),
      errors: db.all("SELECT error, COUNT(*) n FROM deliveries WHERE campaign_id=? AND status IN ('failed','bounced') AND error IS NOT NULL GROUP BY error ORDER BY n DESC LIMIT 10", c.id)
        .map((e) => ({ error: e.error, n: Number(e.n) })),
    });
  });

  // ---------- קבצים מצורפים ----------
  const attList = (c) => { try { return JSON.parse(c.attachments || '[]'); } catch { return []; } };
  api('POST', '/campaigns/:id/attachments', ({ req, res, params, raw }) => {
    const c = getCampaign(params.id);
    need(['draft', 'scheduled', 'paused'].includes(c.status), 'אי אפשר לשנות קבצים בגליון שנשלח או נמצא בשליחה', 409);
    let name = '';
    try { name = decodeURIComponent(String(req.headers['x-filename'] || '')); } catch { name = ''; }
    name = path.basename(name.replace(/\\/g, '/')).replace(/[\x00-\x1f"<>|:*?]/g, '').slice(0, 120);
    const type = ATTACH_TYPES[path.extname(name).toLowerCase()];
    need(name && type, 'אפשר לצרף קובצי PDF, Word, Excel, טקסט, ICS ותמונות PNG או JPG');
    need(raw && raw.length, 'הקובץ ריק');
    const list = attList(c);
    need(list.length < 5, 'אפשר לצרף עד חמישה קבצים');
    need(list.reduce((n, a) => n + a.size, 0) + raw.length <= 6 * 1024 * 1024, 'סך הקבצים המצורפים מוגבל ל-6MB');
    const id = crypto.randomBytes(8).toString('hex');
    const dir = path.join(db.dataDir, 'attachments', String(c.id));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, id), raw);
    list.push({ id, name, type, size: raw.length });
    db.run('UPDATE campaigns SET attachments=?, updated_at=? WHERE id=?', JSON.stringify(list), now(), c.id);
    json(res, { attachments: list });
  }, { bodyLimit: 6 * 1024 * 1024, rawBody: true });
  api('DELETE', '/campaigns/:id/attachments/:aid', ({ res, params }) => {
    const c = getCampaign(params.id);
    need(['draft', 'scheduled', 'paused'].includes(c.status), 'אי אפשר לשנות קבצים בגליון שנשלח או נמצא בשליחה', 409);
    const list = attList(c);
    const hit = list.find((a) => a.id === params.aid);
    need(hit, 'הקובץ לא נמצא', 404);
    fs.rmSync(path.join(db.dataDir, 'attachments', String(c.id), hit.id), { force: true });
    const rest = list.filter((a) => a !== hit);
    db.run('UPDATE campaigns SET attachments=?, updated_at=? WHERE id=?', JSON.stringify(rest), now(), c.id);
    json(res, { attachments: rest });
  }, { perm: 'campaigns.edit' });

  // ---------- אוטומציות: מייל שנשלח לבד למי שמצטרף לרשימה ----------
  const autoOut = (a) => ({
    id: a.id, name: a.name, listId: a.list_id, campaignId: a.campaign_id, delayHours: a.delay_hours, active: !!a.active, createdAt: a.created_at,
    subject: db.get('SELECT subject FROM campaigns WHERE id=?', a.campaign_id)?.subject || '',
    sent: Number(db.get('SELECT COUNT(sent_at) n FROM deliveries WHERE campaign_id=?', a.campaign_id).n),
    pending: Number(db.get("SELECT COUNT(*) n FROM deliveries WHERE campaign_id=? AND status='pending'", a.campaign_id).n),
  });
  const getAuto = (id) => { const a = db.get('SELECT * FROM automations WHERE id=?', int(id)); need(a, 'האוטומציה לא נמצאה', 404); return a; };
  api('GET', '/automations', ({ res }) => json(res, db.all('SELECT * FROM automations ORDER BY list_id, delay_hours, id').map(autoOut)));
  api('POST', '/automations', ({ res, body }) => {
    const name = str(body.name, 120).trim();
    need(name, 'חסר שם לאוטומציה');
    need(db.get('SELECT 1 x FROM lists WHERE id=?', int(body.listId)), 'הרשימה לא נמצאה', 404);
    const c = getCampaign(body.campaignId);
    need(c.status === 'draft', 'אפשר לבחור רק גליון במצב טיוטה', 409);
    need(!db.get('SELECT 1 x FROM automations WHERE campaign_id=?', c.id), 'הגליון כבר משמש אוטומציה אחרת', 409);
    const delay = Math.min(24 * 365, Math.max(0, Math.round(Number(body.delayHours) || 0)));
    const r = db.tx(() => {
      db.run('UPDATE campaigns SET auto=1 WHERE id=?', c.id);
      return db.run('INSERT INTO automations(name, list_id, campaign_id, delay_hours, active, created_at) VALUES(?,?,?,?,0,?)', name, int(body.listId), c.id, delay, now());
    });
    json(res, { id: Number(r.lastInsertRowid) });
  });
  api('POST', '/automations/:id/toggle', ({ res, params, body }) => {
    const a = getAuto(params.id);
    const c = getCampaign(a.campaign_id);
    if (body.active) {
      need(c.subject.trim(), 'חסר נושא לגליון של האוטומציה');
      need(isEmail(c.from_email || db.setting('fromEmail')), 'חסרה כתובת שולח');
      prepareCampaign(db, c);
      // מועד ההפעלה הראשון קובע ממתי סופרים מצטרפים. הפעלה מחדש אחרי השהיה לא שולחת למי שהצטרף לפניה
      db.tx(() => {
        db.run("UPDATE campaigns SET status='sending', started_at=COALESCE(started_at, ?), updated_at=? WHERE id=?", now(), now(), c.id);
        db.run('UPDATE automations SET active=1 WHERE id=?', a.id);
      });
    } else {
      db.tx(() => {
        db.run("UPDATE campaigns SET status='paused', updated_at=? WHERE id=?", now(), c.id);
        db.run('UPDATE automations SET active=0 WHERE id=?', a.id);
      });
    }
    json(res, { ok: true });
  });
  api('DELETE', '/automations/:id', ({ res, params }) => {
    const a = getAuto(params.id);
    db.tx(() => {
      db.run('DELETE FROM automations WHERE id=?', a.id);
      db.run("UPDATE campaigns SET auto=0, status=CASE WHEN EXISTS (SELECT 1 FROM deliveries d WHERE d.campaign_id=campaigns.id AND d.sent_at IS NOT NULL) THEN 'sent' ELSE 'draft' END WHERE id=?", a.campaign_id);
      db.run("DELETE FROM deliveries WHERE campaign_id=? AND status='pending'", a.campaign_id);
    });
    json(res, { ok: true });
  });

  api('POST', '/campaigns/:id/public', ({ res, params, body }) => {
    const c = getCampaign(params.id);
    db.run('UPDATE campaigns SET public=? WHERE id=?', body.public ? 1 : 0, c.id);
    json(res, { ok: true });
  });

  const PEOPLE = {
    sent: 'd.sent_at IS NOT NULL', opened: 'd.opened_at IS NOT NULL', not_opened: 'd.sent_at IS NOT NULL AND d.opened_at IS NULL',
    clicked: 'd.clicked_at IS NOT NULL', unsubscribed: 'd.unsubscribed_at IS NOT NULL', bounced: "d.status='bounced'",
    failed: "d.status='failed'", pending: "d.status='pending'",
  };
  const peopleSql = (kind) => `FROM deliveries d JOIN subscribers s ON s.id=d.subscriber_id WHERE d.campaign_id=? AND ${PEOPLE[kind]}`;
  api('GET', '/campaigns/:id/people', ({ res, params, query }) => {
    const c = getCampaign(params.id);
    const kind = PEOPLE[query.get('kind')] ? query.get('kind') : 'opened';
    const page = Math.max(1, Number(query.get('page')) || 1);
    const total = Number(db.get(`SELECT COUNT(*) n ${peopleSql(kind)}`, c.id).n);
    const rows = db.all(`SELECT s.id, s.email, s.name, d.status, d.sent_at, d.opened_at, d.opens, d.clicked_at, d.clicks, d.error ${peopleSql(kind)}
      ORDER BY COALESCE(d.clicked_at, d.opened_at, d.sent_at, 0) DESC LIMIT 50 OFFSET ?`, c.id, (page - 1) * 50);
    json(res, { kind, total, page, size: 50, rows });
  });
  api('GET', '/campaigns/:id/people.csv', ({ res, params, query }) => {
    const c = getCampaign(params.id);
    const kind = PEOPLE[query.get('kind')] ? query.get('kind') : 'opened';
    const iso = (t) => (t ? new Date(t * 1000).toISOString() : '');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="campaign-${c.id}-${kind}.csv"`, 'Cache-Control': 'no-store' });
    res.write('\uFEFFemail,name,status,sent,opened,opens,clicked,clicks,error\r\n');
    for (let offset = 0; ; offset += 5000) {
      const rows = db.all(`SELECT s.email, s.name, d.status, d.sent_at, d.opened_at, d.opens, d.clicked_at, d.clicks, d.error ${peopleSql(kind)} ORDER BY s.id LIMIT 5000 OFFSET ?`, c.id, offset);
      if (!rows.length) break;
      res.write(rows.map((r) => [r.email, r.name, r.status, iso(r.sent_at), iso(r.opened_at), r.opens, iso(r.clicked_at), r.clicks, r.error || ''].map(csvCell).join(',')).join('\r\n') + '\r\n');
    }
    res.end();
  });

  api('GET', '/campaigns/:id/pdf', async ({ res, params, user }) => {
    const c = getCampaign(params.id);
    const page = previewHtml(db, c, { id: 0, email: 'name@example.com', name: user.username }).html
      .replace(/<\/head>/i, '<style>@page{size:A4;margin:10mm}body{-webkit-print-color-adjust:exact;print-color-adjust:exact}</style></head>');
    let pdf;
    try { pdf = await htmlToPdf(page); } catch (e) { throw new HttpError(500, 'ההמרה ל-PDF נכשלה: ' + e.message); }
    need(pdf, 'בשרת לא מותקן Chrome, ולכן אי אפשר להפיק PDF. אפשר להדפיס ל-PDF מהתצוגה המלאה', 501);
    send(res, 200, pdf, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length, 'Content-Disposition': `attachment; filename="newsletter-${c.id}.pdf"`, 'Cache-Control': 'no-store' });
  }, { perm: 'campaigns.view' });

  // ---------- הגדרות והעלאות ----------
  api('GET', '/settings', ({ res }) => {
    const s = db.settings();
    const out = {};
    for (const k of Object.keys(DEFAULT_SETTINGS)) out[k] = s[k];
    out.hasSmtpPass = !!s.smtpPass;
    out.smtpPass = '';
    out.hasGoogleSecret = !!s.googleClientSecret;
    out.googleClientSecret = '';
    json(res, out);
  });
  api('PUT', '/settings', ({ res, body }) => {
    need(!body.baseUrl || /^https?:\/\/[^\s/]+/.test(body.baseUrl), 'כתובת האתר חייבת להתחיל ב-http:// או https://');
    for (const k of ['fromEmail', 'replyTo', 'bounceAddress']) need(!body[k] || isEmail(body[k]), 'אחת מכתובות המייל בהגדרות לא תקינה');
    db.tx(() => {
      for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (!(k in body)) continue;
        if (k === 'smtpPass' && !body.smtpPass && !body.clearSmtpPass) continue;
        if (k === 'googleClientSecret' && !body.googleClientSecret && !body.clearGoogleSecret) continue;
        if (k === 'formColor' && !/^#[0-9a-f]{6}$/i.test(body[k])) continue;
        db.setSetting(k, k === 'baseUrl' ? String(body[k]).replace(/\/+$/, '') : str(body[k], ['formIntro', 'confirmText', 'customFields'].includes(k) ? 2000 : 500).trim());
      }
    });
    json(res, { ok: true });
  });

  api('POST', '/upload', ({ req, res, raw }) => {
    const ext = path.extname(String(req.headers['x-filename'] || '')).toLowerCase();
    need(['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext), 'אפשר להעלות רק תמונות מסוג PNG, JPG, GIF או WEBP');
    need(raw && raw.length, 'הקובץ ריק');
    const name = crypto.randomBytes(10).toString('hex') + ext;
    fs.writeFileSync(path.join(db.dataDir, 'uploads', name), raw);
    json(res, { url: `${db.setting('baseUrl').replace(/\/+$/, '')}/media/${name}` });
  }, { bodyLimit: 5 * 1024 * 1024, rawBody: true });

}
