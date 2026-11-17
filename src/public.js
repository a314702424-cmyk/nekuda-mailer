import crypto from 'node:crypto';
import { html, send, redirect, clientIp, parseCookies } from './http.js';
import { startSession } from './api.js';
import { now } from './db.js';
import { esc } from '../web/shared/render.js';
import { readToken, personalize } from './track.js';
import { isEmail } from './csv.js';

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const formHits = new Map();

const page = (title, body) => `<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;background:#eef0f4;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a}
.box{max-width:440px;margin:8vh auto;background:#fff;border-radius:12px;padding:32px 28px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.06)}
h1{font-size:22px;margin:0 0 12px}p{line-height:1.6;color:#4b5563}
input{width:100%;box-sizing:border-box;padding:12px;margin:6px 0;border:1px solid #cfd4dc;border-radius:8px;font-size:16px}
button{width:100%;padding:13px;margin-top:10px;border:0;border-radius:8px;background:#1b4fd8;color:#fff;font-size:16px;font-weight:bold;cursor:pointer}
.hp{position:absolute;width:1px;height:1px;padding:0;border:0;opacity:0;overflow:hidden;clip-path:inset(50%)}</style></head><body><div class="box">${body}</div></body></html>`;

export function registerPublic(router, { db }) {
  const secret = () => db.setting('secret');

  router.add('GET', '/o/:file', ({ res, params }) => {
    const ids = readToken(secret(), params.file.replace(/\.gif$/, ''));
    if (ids) {
      const t = now();
      const r = db.run('UPDATE deliveries SET opens=opens+1, opened_at=COALESCE(opened_at, ?) WHERE campaign_id=? AND subscriber_id=?', t, ids.campaignId, ids.subscriberId);
      if (r.changes) db.run('UPDATE subscribers SET last_open_at=? WHERE id=?', t, ids.subscriberId);
    }
    send(res, 200, GIF, { 'Content-Type': 'image/gif', 'Content-Length': GIF.length, 'Cache-Control': 'no-store, private' });
  });

  router.add('GET', '/c/:token/:link', ({ res, params }) => {
    const ids = readToken(secret(), params.token);
    const link = db.get('SELECT * FROM links WHERE id=?', Number(params.link) || 0);
    if (!link) return redirect(res, db.setting('baseUrl') || '/');
    if (ids && ids.campaignId === link.campaign_id) {
      const t = now();
      const r = db.run(`UPDATE deliveries SET clicks=clicks+1, clicked_at=COALESCE(clicked_at, ?),
        opened_at=COALESCE(opened_at, ?), opens=MAX(opens,1) WHERE campaign_id=? AND subscriber_id=?`, t, t, ids.campaignId, ids.subscriberId);
      if (r.changes) {
        db.run('UPDATE links SET clicks=clicks+1 WHERE id=?', link.id);
        db.run('INSERT OR IGNORE INTO link_clicks(link_id, subscriber_id) VALUES(?,?)', link.id, ids.subscriberId);
        db.run('UPDATE subscribers SET last_click_at=?, last_open_at=COALESCE(last_open_at, ?) WHERE id=?', t, t, ids.subscriberId);
      }
    }
    redirect(res, link.url);
  });

  const unsubscribe = (ids) => {
    const t = now();
    const r = db.run("UPDATE subscribers SET status='unsubscribed', unsubscribed_at=? WHERE id=? AND status<>'unsubscribed'", t, ids.subscriberId);
    if (r.changes) db.run('UPDATE deliveries SET unsubscribed_at=? WHERE campaign_id=? AND subscriber_id=?', t, ids.campaignId, ids.subscriberId);
  };

  router.add('GET', '/u/:token', ({ res, params }) => {
    const ids = readToken(secret(), params.token);
    if (!ids) return html(res, page('הסרה מרשימת התפוצה', '<h1>הקישור לא תקין</h1><p>ייתכן שהקישור נקטע. אפשר להשיב למייל ולבקש הסרה.</p>'), 400);
    html(res, page('הסרה מרשימת התפוצה', `<h1>להסיר אותך מרשימת התפוצה?</h1><p>לאחר האישור לא יישלחו אליך מיילים נוספים.</p>
      <form method="post" action="/u/${esc(params.token)}"><button type="submit">כן, הסירו אותי</button></form>`));
  });
  router.add('POST', '/u/:token', ({ res, params }) => {
    const ids = readToken(secret(), params.token);
    if (!ids) return html(res, page('הסרה מרשימת התפוצה', '<h1>הקישור לא תקין</h1>'), 400);
    unsubscribe(ids);
    html(res, page('הוסרת מרשימת התפוצה', '<h1>הוסרת מרשימת התפוצה</h1><p>לא יישלחו אליך מיילים נוספים.</p>'));
  }, { anyBody: true });

  router.add('GET', '/v/:token', ({ res, params }) => {
    const ids = readToken(secret(), params.token);
    const c = ids && db.get('SELECT prepared_html FROM campaigns WHERE id=?', ids.campaignId);
    if (!c || !c.prepared_html) return html(res, page('הגליון לא נמצא', '<h1>הגליון לא נמצא</h1>'), 404);
    const subscriber = db.get('SELECT id, email, name FROM subscribers WHERE id=?', ids.subscriberId) || { id: 0, email: '', name: '' };
    html(res, personalize(c.prepared_html, { baseUrl: db.setting('baseUrl').replace(/\/+$/, ''), token: params.token, subscriber, isHtml: true }));
  });

  const formPage = (msg = '', done = false) => {
    const f = db.settings();
    const color = /^#[0-9a-f]{6}$/i.test(f.formColor) ? f.formColor : '#1b4fd8';
    const logo = /^https?:\/\//.test(f.formLogo) ? `<img src="${esc(f.formLogo)}" alt="" style="max-width:220px;max-height:120px;margin-bottom:14px">` : '';
    const intro = f.formIntro ? `<p>${esc(f.formIntro).replace(/\n/g, '<br>')}</p>` : '';
    const body = done
      ? `${logo}<h1>${esc(f.formSuccess || 'תודה, נרשמת')}</h1>`
      : `${logo}<h1>${esc(f.formTitle || 'הרשמה לרשימת התפוצה')}</h1>${intro}${msg ? `<p style="color:#c0362c">${esc(msg)}</p>` : ''}
    <form method="post" action="/subscribe">${f.formAskName === '0' ? '' : '<input name="name" placeholder="שם" maxlength="120" autocomplete="name">'}
    <input name="email" type="email" placeholder="כתובת מייל" required autocomplete="email">
    <input class="hp" name="website" tabindex="-1" autocomplete="off">
    <button type="submit" style="background:${color}">${esc(f.formButton || 'הרשמה')}</button></form>`;
    return page(f.formTitle || 'הרשמה לרשימת התפוצה', body);
  };

  router.add('GET', '/subscribe', ({ res }) => html(res, formPage()));
  router.add('POST', '/subscribe', ({ req, res, raw }) => {
    const ip = clientIp(req);
    const hit = formHits.get(ip);
    const fresh = !hit || hit.reset < Date.now() ? { n: 0, reset: Date.now() + 3600000 } : hit;
    fresh.n++;
    formHits.set(ip, fresh);
    if (formHits.size > 5000) formHits.clear();
    if (fresh.n > 10) return html(res, formPage('יותר מדי ניסיונות. נסו שוב מאוחר יותר.'), 429);
    const f = new URLSearchParams(raw ? raw.toString('utf8') : '');
    const email = String(f.get('email') || '').trim().toLowerCase();
    if (f.get('website')) return html(res, formPage('', true));
    if (!isEmail(email)) return html(res, formPage('כתובת המייל לא תקינה.'), 400);
    const t = now();
    const note = `טופס הרשמה, ${new Date().toISOString()}, IP ${ip}`;
    const listId = Number(db.setting('formListId')) || 0;
    db.tx(() => {
      let row = db.get('SELECT id, status FROM subscribers WHERE email=?', email);
      if (!row) {
        row = { id: Number(db.run('INSERT INTO subscribers(email, name, status, source, consent_note, created_at) VALUES(?,?,?,?,?,?)',
          email, String(f.get('name') || '').slice(0, 120), 'active', 'form', note, t).lastInsertRowid) };
      } else if (row.status === 'unsubscribed') {
        db.run("UPDATE subscribers SET status='active', unsubscribed_at=NULL, consent_note=? WHERE id=?", note, row.id);
      }
      if (listId && db.get('SELECT 1 x FROM lists WHERE id=?', listId)) {
        db.run('INSERT OR IGNORE INTO subscriptions(subscriber_id, list_id, created_at) VALUES(?,?,?)', row.id, listId, t);
      }
    });
    html(res, formPage('', true));
  }, { anyBody: true });

  // ---------- כניסה עם Google ----------
  const authUrl = () => process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
  const tokenUrl = () => process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
  const callbackUrl = () => `${db.setting('baseUrl').replace(/\/+$/, '')}/auth/google/callback`;
  const authFail = (res, msg, status = 403) => html(res, page('כניסה עם Google', `<h1>הכניסה לא הצליחה</h1><p>${esc(msg)}</p><p><a href="/">חזרה לדף הכניסה</a></p>`), status);

  router.add('GET', '/auth/google', ({ res }) => {
    const clientId = db.setting('googleClientId');
    if (!clientId || !db.setting('googleClientSecret')) return authFail(res, 'כניסה עם Google לא הוגדרה במערכת.', 404);
    const state = crypto.randomBytes(24).toString('hex');
    const secure = db.setting('baseUrl').startsWith('https://') ? '; Secure' : '';
    res.setHeader('Set-Cookie', `nm_oauth=${state}; HttpOnly; Path=/auth; SameSite=Lax; Max-Age=600${secure}`);
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: callbackUrl(), response_type: 'code', scope: 'openid email', state, prompt: 'select_account' });
    redirect(res, `${authUrl()}?${q}`);
  });

  router.add('GET', '/auth/google/callback', async ({ req, res, query }) => {
    const state = parseCookies(req).nm_oauth;
    if (!state || state !== query.get('state') || !query.get('code')) return authFail(res, 'הבקשה לא תקינה או שפג תוקפה. נסה שוב.', 400);
    const clientId = db.setting('googleClientId');
    let claims;
    try {
      const r = await fetch(tokenUrl(), { method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code: query.get('code'), client_id: clientId, client_secret: db.setting('googleClientSecret'), redirect_uri: callbackUrl(), grant_type: 'authorization_code' }) });
      const data = await r.json();
      if (!r.ok || !data.id_token) throw new Error(data.error_description || data.error || 'אין אסימון');
      // האסימון התקבל ישירות מ-Google בחיבור מוצפן, ולכן אפשר לסמוך על תוכנו בלי לאמת חתימה
      claims = JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64url').toString('utf8'));
    } catch (e) {
      return authFail(res, 'Google לא אישר את הכניסה: ' + e.message, 502);
    }
    const okIssuer = ['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss) || !!process.env.GOOGLE_TOKEN_URL;
    if (claims.aud !== clientId || !okIssuer || !(claims.exp > Date.now() / 1000) || claims.email_verified !== true || !claims.email) {
      return authFail(res, 'פרטי החשבון שהתקבלו מ-Google לא תקינים.');
    }
    const u = db.get('SELECT id FROM users WHERE email=? COLLATE NOCASE AND active=1', String(claims.email).toLowerCase());
    if (!u) return authFail(res, `לחשבון ${claims.email} אין גישה למערכת. פנה למנהל כדי שיוסיף אותך.`);
    startSession(db, res, u.id);
    redirect(res, '/');
  });
}
