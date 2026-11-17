import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, json, html as sendHtml, clientIp, parseCookies } from './http.js';
import { now, DEFAULT_SETTINGS } from './db.js';
import { parseContacts, isEmail, csvCell } from './csv.js';
import { defaultDesign, htmlToText } from '../web/shared/render.js';
import { campaignHtml, makeToken, personalize } from './track.js';
import { enqueueCampaign, sentToday } from './worker.js';
import { buildMessage, SmtpConnection, smtpOptions } from './mailer.js';

const SESSION_DAYS = 30;
const COOKIE = 'nm_sess';
const STATUSES = ['active', 'unsubscribed', 'bounced', 'blocked'];
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
  const row = db.get('SELECT u.id, u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?', token, now());
  return row || null;
}

function startSession(db, res, userId) {
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
    stats: campaignStats(db, c.id),
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
  let h = campaignHtml(c);
  if (!h.includes('{{unsubscribe_url}}')) {
    h += '<div style="padding:16px;font:13px Arial;color:#6b7280;text-align:center" dir="rtl"><a href="{{unsubscribe_url}}" style="color:#6b7280">להסרה מרשימת התפוצה</a></div>';
  }
  const token = makeToken(settings.secret, c.id, subscriber.id);
  return { html: personalize(h, { baseUrl, token, subscriber, isHtml: true }), token, settings, baseUrl };
}

export function registerApi(router, { db, worker, version }) {
  const api = (method, pattern, handler, opts = {}) => router.add(method, '/api' + pattern, handler, { auth: true, ...opts });

  // ---------- מצב והתחברות ----------
  router.add('GET', '/api/meta', ({ req, res }) => {
    const user = sessionUser(db, req);
    json(res, { version, needsSetup: !db.get('SELECT 1 x FROM users LIMIT 1'), user: user ? user.username : null });
  });

  router.add('POST', '/api/setup', ({ res, body }) => {
    need(!db.get('SELECT 1 x FROM users LIMIT 1'), 'המערכת כבר הוגדרה', 409);
    const username = str(body.username, 60).trim();
    need(username.length >= 3, 'שם המשתמש קצר מדי');
    need(String(body.password || '').length >= 10, 'הסיסמה חייבת להיות באורך 10 תווים לפחות');
    const r = db.run('INSERT INTO users(username, pass_hash, created_at) VALUES(?,?,?)', username, hashPassword(body.password), now());
    startSession(db, res, Number(r.lastInsertRowid));
    json(res, { ok: true });
  });

  router.add('POST', '/api/login', ({ req, res, body }) => {
    const ip = clientIp(req);
    const f = loginFails.get(ip);
    if (f && f.until > Date.now() && f.n >= 5) throw new HttpError(429, 'יותר מדי ניסיונות. נסה שוב בעוד רבע שעה');
    const u = db.get('SELECT * FROM users WHERE username=?', str(body.username, 60).trim());
    if (!u || !checkPassword(String(body.password || ''), u.pass_hash)) {
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
    need(checkPassword(String(body.current || ''), u.pass_hash), 'הסיסמה הנוכחית שגויה', 403);
    need(String(body.password || '').length >= 10, 'הסיסמה חייבת להיות באורך 10 תווים לפחות');
    db.run('UPDATE users SET pass_hash=? WHERE id=?', hashPassword(body.password), user.id);
    json(res, { ok: true });
  });

  // ---------- לוח בקרה ----------
  api('GET', '/dashboard', ({ res }) => {
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
      recent: db.all('SELECT * FROM campaigns ORDER BY id DESC LIMIT 6').map((c) => campaignOut(db, c)),
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
    const rows = db.all(`SELECT s.id, s.email, s.name, s.status, s.source, s.created_at, s.last_open_at,
      (SELECT GROUP_CONCAT(list_id) FROM subscriptions sp WHERE sp.subscriber_id=s.id) lists
      FROM subscribers s ${w} ORDER BY s.id DESC LIMIT ? OFFSET ?`, ...p, size, (page - 1) * size)
      .map((r) => ({ ...r, lists: r.lists ? String(r.lists).split(',').map(Number) : [] }));
    json(res, { total, page, size, rows });
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
      db.run('DELETE FROM subscriptions WHERE subscriber_id=?', id);
      for (const l of lists) db.run('INSERT OR IGNORE INTO subscriptions(subscriber_id, list_id, created_at) VALUES(?,?,?)', id, l, now());
      return id;
    });
  };
  api('POST', '/subscribers', ({ res, body }) => json(res, { id: saveSubscriber(0, body) }));
  api('PUT', '/subscribers/:id', ({ res, body, params }) => json(res, { id: saveSubscriber(int(params.id), body) }));
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

  // ---------- גליונות ----------
  const getCampaign = (id) => { const c = db.get('SELECT * FROM campaigns WHERE id=?', int(id)); need(c, 'הגליון לא נמצא', 404); return c; };

  api('GET', '/campaigns', ({ res }) => json(res, db.all('SELECT * FROM campaigns ORDER BY id DESC LIMIT 300').map((c) => campaignOut(db, c))));
  api('POST', '/campaigns', ({ res, body }) => {
    const s = db.settings();
    const t = now();
    const r = db.run(`INSERT INTO campaigns(subject, from_name, from_email, reply_to, mode, design, html, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`, str(body.subject) || 'גליון חדש', s.fromName, s.fromEmail, s.replyTo,
    body.mode === 'html' ? 'html' : 'blocks', JSON.stringify(defaultDesign()), '', t, t);
    json(res, { id: Number(r.lastInsertRowid) });
  });
  api('GET', '/campaigns/:id', ({ res, params }) => json(res, campaignOut(db, getCampaign(params.id), true)));
  api('PUT', '/campaigns/:id', ({ res, body, params }) => {
    const c = getCampaign(params.id);
    need(['draft', 'scheduled', 'paused'].includes(c.status), 'אי אפשר לערוך גליון שנשלח או נמצא בשליחה', 409);
    need(!body.fromEmail || isEmail(body.fromEmail), 'כתובת השולח לא תקינה');
    need(!body.replyTo || isEmail(body.replyTo), 'כתובת התשובה לא תקינה');
    db.tx(() => {
      db.run(`UPDATE campaigns SET subject=?, preheader=?, from_name=?, from_email=?, reply_to=?, mode=?, design=?, html=?, updated_at=? WHERE id=?`,
        str(body.subject, 300), str(body.preheader, 300), str(body.fromName, 120), str(body.fromEmail, 254).trim(), str(body.replyTo, 254).trim(),
        body.mode === 'html' ? 'html' : 'blocks', JSON.stringify(body.design || defaultDesign()), String(body.html || '').slice(0, 2_000_000), now(), c.id);
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
    need(c.status !== 'sending', 'קודם יש להשהות את השליחה', 409);
    db.tx(() => {
      db.run('DELETE FROM link_clicks WHERE link_id IN (SELECT id FROM links WHERE campaign_id=?)', c.id);
      db.run('DELETE FROM links WHERE campaign_id=?', c.id);
      db.run('DELETE FROM deliveries WHERE campaign_id=?', c.id);
      db.run('DELETE FROM campaign_lists WHERE campaign_id=?', c.id);
      db.run('DELETE FROM campaigns WHERE id=?', c.id);
    });
    json(res, { ok: true });
  });

  api('GET', '/campaigns/:id/preview', ({ res, params, user }) => {
    const c = getCampaign(params.id);
    sendHtml(res, previewHtml(db, c, { id: 0, email: 'name@example.com', name: user.username }).html);
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
          domain: fromEmail.split('@')[1],
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
    json(res, {
      campaign: campaignOut(db, c),
      links: db.all(`SELECT l.id, l.url, l.clicks, (SELECT COUNT(*) FROM link_clicks lc WHERE lc.link_id=l.id) uniq
        FROM links l WHERE l.campaign_id=? ORDER BY l.clicks DESC`, c.id).map((l) => ({ ...l, uniq: Number(l.uniq) })),
      bounces: db.all('SELECT type, COUNT(*) n FROM bounces WHERE campaign_id=? GROUP BY type', c.id).map((b) => ({ type: b.type, n: Number(b.n) })),
      errors: db.all("SELECT error, COUNT(*) n FROM deliveries WHERE campaign_id=? AND status IN ('failed','bounced') AND error IS NOT NULL GROUP BY error ORDER BY n DESC LIMIT 10", c.id)
        .map((e) => ({ error: e.error, n: Number(e.n) })),
    });
  });

  // ---------- הגדרות והעלאות ----------
  api('GET', '/settings', ({ res }) => {
    const s = db.settings();
    const out = {};
    for (const k of Object.keys(DEFAULT_SETTINGS)) out[k] = s[k];
    out.hasSmtpPass = !!s.smtpPass;
    out.smtpPass = '';
    json(res, out);
  });
  api('PUT', '/settings', ({ res, body }) => {
    need(!body.baseUrl || /^https?:\/\/[^\s/]+/.test(body.baseUrl), 'כתובת האתר חייבת להתחיל ב-http:// או https://');
    for (const k of ['fromEmail', 'replyTo', 'bounceAddress']) need(!body[k] || isEmail(body[k]), 'אחת מכתובות המייל בהגדרות לא תקינה');
    db.tx(() => {
      for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (!(k in body)) continue;
        if (k === 'smtpPass' && !body.smtpPass && !body.clearSmtpPass) continue;
        db.setSetting(k, k === 'baseUrl' ? String(body[k]).replace(/\/+$/, '') : str(body[k], 500).trim());
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
