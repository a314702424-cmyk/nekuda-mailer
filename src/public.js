import crypto from 'node:crypto';
import { html, send, redirect, clientIp, parseCookies } from './http.js';
import { startSession } from './api.js';
import { now } from './db.js';
import { esc } from '../web/shared/render.js';
import { readToken, makeToken, personalize } from './track.js';
import { buildMessage, SmtpConnection, smtpOptions } from './mailer.js';
import { isEmail } from './csv.js';

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const formHits = new Map();

const page = (title, body) => `<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="alternate icon" href="/favicon.png" type="image/png"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>body{margin:0;background:#eef0f4;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a}
.box{max-width:440px;margin:8vh auto;background:#fff;border-radius:12px;padding:32px 28px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.06)}
h1{font-size:22px;margin:0 0 12px}p{line-height:1.6;color:#4b5563}
input{width:100%;box-sizing:border-box;padding:12px;margin:6px 0;border:1px solid #cfd4dc;border-radius:8px;font-size:16px}
button{width:100%;padding:13px;margin-top:10px;border:0;border-radius:8px;background:#1b4fd8;color:#fff;font-size:16px;font-weight:bold;cursor:pointer}
a{color:#1b4fd8}label.ck{display:block;text-align:right;margin:8px 0;color:#1a1a1a}label.ck input{width:auto;margin-left:8px}
button.ghost{background:#fff;color:#c0362c;border:1px solid #e3b7b2;font-weight:normal}
ul.arch{list-style:none;padding:0;margin:0;text-align:right}ul.arch li{padding:12px 0;border-bottom:1px solid #eceef2}ul.arch small{display:block;color:#6b7280}
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
      ? `${logo}<h1>${esc(typeof done === 'string' ? done : (f.formSuccess || 'תודה, נרשמת'))}</h1>`
      : `${logo}<h1>${esc(f.formTitle || 'הרשמה לרשימת התפוצה')}</h1>${intro}${msg ? `<p style="color:#c0362c">${esc(msg)}</p>` : ''}
    <form method="post" action="/subscribe">${f.formAskName === '0' ? '' : '<input name="name" placeholder="שם" maxlength="120" autocomplete="name">'}
    <input name="email" type="email" placeholder="כתובת מייל" required autocomplete="email">
    <input class="hp" name="website" tabindex="-1" autocomplete="off">
    <button type="submit" style="background:${color}">${esc(f.formButton || 'הרשמה')}</button></form>`;
    return page(f.formTitle || 'הרשמה לרשימת התפוצה', body);
  };

  router.add('GET', '/subscribe', ({ res }) => html(res, formPage()));
  router.add('POST', '/subscribe', async ({ req, res, raw }) => {
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
    const doubleOptIn = db.setting('formDoubleOptIn') === '1';
    const fresh2 = doubleOptIn ? 'pending' : 'active';
    let confirmId = 0;
    db.tx(() => {
      let row = db.get('SELECT id, status FROM subscribers WHERE email=?', email);
      if (!row) {
        row = { id: Number(db.run('INSERT INTO subscribers(email, name, status, source, consent_note, created_at) VALUES(?,?,?,?,?,?)',
          email, String(f.get('name') || '').slice(0, 120), fresh2, 'form', note, t).lastInsertRowid), status: fresh2 };
      } else if (row.status === 'unsubscribed') {
        db.run('UPDATE subscribers SET status=?, unsubscribed_at=NULL, consent_note=? WHERE id=?', fresh2, note, row.id);
        row.status = fresh2;
      }
      if (row.status === 'pending') confirmId = row.id;
      if (listId && db.get('SELECT 1 x FROM lists WHERE id=?', listId)) {
        db.run('INSERT OR IGNORE INTO subscriptions(subscriber_id, list_id, created_at) VALUES(?,?,?)', row.id, listId, t);
      }
    });
    if (confirmId) {
      try { await sendConfirmation(confirmId, email); } catch (e) {
        return html(res, formPage('לא הצלחנו לשלוח את מייל האישור. נסו שוב בעוד כמה דקות.'), 502);
      }
      return html(res, formPage('', db.setting('formPending')));
    }
    html(res, formPage('', true));
  }, { anyBody: true });

  // ---------- אישור הרשמה במייל ----------
  async function sendConfirmation(subscriberId, email) {
    const s = db.settings();
    const baseUrl = s.baseUrl.replace(/\/+$/, '');
    const link = `${baseUrl}/confirm/${makeToken(secret(), 0, subscriberId)}`;
    const color = /^#[0-9a-f]{6}$/i.test(s.formColor) ? s.formColor : '#1b4fd8';
    const body = `<!DOCTYPE html><html lang="he" dir="rtl"><body style="margin:0;background:#eef0f4;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:10px"><tr><td dir="rtl" style="padding:28px;text-align:right;color:#1a1a1a;font-size:16px;line-height:1.6">
<p style="margin:0 0 18px">${esc(s.confirmText).replace(/\n/g, '<br>')}</p>
<p style="margin:0 0 18px;text-align:center"><a href="${link}" style="display:inline-block;background:${color};color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 26px;border-radius:8px">אישור ההרשמה</a></p>
<p style="margin:0;font-size:13px;color:#6b7280">אם הכפתור לא עובד, אפשר להעתיק את הקישור: <span dir="ltr">${link}</span></p>
</td></tr></table></td></tr></table></body></html>`;
    const conn = new SmtpConnection(smtpOptions(s));
    try {
      await conn.connect();
      await conn.send(s.bounceAddress || s.fromEmail, email, buildMessage({
        from: { name: s.fromName, email: s.fromEmail }, to: { name: '', email }, replyTo: s.replyTo, subject: s.confirmSubject,
        html: body, text: `${s.confirmText}\n\n${link}`, domain: String(s.fromEmail).split('@')[1],
      }));
    } finally { await conn.quit(); }
  }

  router.add('GET', '/confirm/:token', ({ res, params }) => {
    const ids = readToken(secret(), params.token);
    if (!ids || ids.campaignId !== 0) return html(res, page('אישור הרשמה', '<h1>הקישור לא תקין</h1><p>ייתכן שהקישור נקטע. אפשר להירשם שוב.</p>'), 400);
    db.run("UPDATE subscribers SET status='active', consent_note=COALESCE(consent_note,'') || ? WHERE id=? AND status='pending'", ` | אושר במייל ${new Date().toISOString()}`, ids.subscriberId);
    html(res, formPage('', true));
  });

  // ---------- עדכון ההרשמה שלי ----------
  const prefsPage = (token, sub, msg = '') => {
    const lists = db.all('SELECT l.id, l.name FROM lists l JOIN subscriptions sp ON sp.list_id=l.id WHERE sp.subscriber_id=? ORDER BY l.name', sub.id);
    const off = sub.status !== 'active';
    return page('עדכון ההרשמה', `<h1>עדכון ההרשמה</h1><p dir="ltr">${esc(sub.email)}</p>${msg ? `<p style="color:#15803d">${esc(msg)}</p>` : ''}
      ${off ? '<p>הכתובת הזו אינה מקבלת מיילים כרגע.</p>' : `<form method="post" action="/p/${esc(token)}">
      <input name="name" placeholder="שם" maxlength="120" value="${esc(sub.name || '')}">
      ${lists.length ? '<p style="text-align:right;margin-bottom:0">הרשימות שלך. הסרת הסימון מפסיקה את קבלת המיילים מהרשימה:</p>' : ''}
      ${lists.map((l) => `<label class="ck"><input type="checkbox" name="list" value="${l.id}" checked>${esc(l.name)}</label>`).join('')}
      <button type="submit">שמירה</button></form>
      <form method="post" action="/u/${esc(token)}"><button type="submit" class="ghost">הסרה מכל הרשימות</button></form>`}`);
  };
  router.add('GET', '/p/:token', ({ res, params }) => {
    const ids = readToken(secret(), params.token);
    const sub = ids && db.get('SELECT id, email, name, status FROM subscribers WHERE id=?', ids.subscriberId);
    if (!sub) return html(res, page('עדכון ההרשמה', '<h1>הקישור לא תקין</h1>'), 400);
    html(res, prefsPage(params.token, sub));
  });
  router.add('POST', '/p/:token', ({ res, params, raw }) => {
    const ids = readToken(secret(), params.token);
    const sub = ids && db.get("SELECT id, email, name, status FROM subscribers WHERE id=? AND status='active'", ids.subscriberId);
    if (!sub) return html(res, page('עדכון ההרשמה', '<h1>הקישור לא תקין</h1>'), 400);
    const f = new URLSearchParams(raw ? raw.toString('utf8') : '');
    const keep = f.getAll('list').map(Number).filter((n) => n > 0);
    db.tx(() => {
      db.run('UPDATE subscribers SET name=? WHERE id=?', String(f.get('name') || '').slice(0, 120), sub.id);
      // אפשר רק לעזוב רשימות קיימות. הצטרפות לרשימות נעשית בטופס ההרשמה או על ידי מנהל
      db.run(`DELETE FROM subscriptions WHERE subscriber_id=?${keep.length ? ` AND list_id NOT IN (${keep.map(() => '?').join(',')})` : ''}`, sub.id, ...keep);
    });
    html(res, prefsPage(params.token, { ...sub, name: String(f.get('name') || '').slice(0, 120) }, 'השינויים נשמרו.'));
  }, { anyBody: true });

  // ---------- מדיניות פרטיות ----------
  const defaultPrivacy = (s) => `מדיניות זו מתארת איזה מידע נשמר במערכת הדיוור של ${s.fromName || 'האתר'} ולמה הוא משמש.

איזה מידע נשמר
כתובת המייל שלך, והשם אם מסרת אותו. בעת הרשמה נשמרים גם מועד ההרשמה וכתובת ה-IP, כתיעוד להסכמתך לקבל דיוור.
לגבי כל גליון שנשלח אליך נשמר אם הוא נפתח ועל אילו קישורים לחצת. המידע משמש לשיפור הגליונות ולתחזוקת רשימת התפוצה.

למה המידע משמש
לשליחת הגליונות שביקשת לקבל, ולא לשום מטרה אחרת. המידע לא נמכר ולא מועבר לגורם אחר.

הסרה ועדכון
בתחתית כל גליון יש קישור להסרה מרשימת התפוצה, והוא פועל מיד. אפשר גם לבקש לעיין במידע עליך, לתקן אותו או למחוק אותו, בפנייה לכתובת שלמטה.

כניסת צוות עם חשבון Google
אנשי הצוות שמנהלים את המערכת יכולים להיכנס עם חשבון Google. בכניסה כזו מתקבלת מ-Google כתובת המייל בלבד, והיא משמשת רק לזיהוי המשתמש. לא מתבקשת גישה לתיבת הדואר, לאנשי הקשר או לכל מידע אחר בחשבון.

יצירת קשר
${s.replyTo || s.fromEmail || ''}${s.companyAddress ? '\n' + s.companyAddress : ''}`;
  router.add('GET', '/privacy', ({ res }) => {
    const s = db.settings();
    const text = (s.privacyText || '').trim() || defaultPrivacy(s);
    const body = esc(text).split(/\n{2,}/).map((para) => {
      const [first, ...rest] = para.split('\n');
      return rest.length ? `<h2 style="font-size:17px;margin:22px 0 6px">${first}</h2><p style="margin:0">${rest.join('<br>')}</p>` : `<p>${first}</p>`;
    }).join('');
    html(res, page('מדיניות פרטיות', `<div style="text-align:right;color:#1a1a1a"><h1>מדיניות פרטיות</h1>${body}</div>`));
  });

  // ---------- סקר בתוך גליון ----------
  router.add('GET', '/poll/:token/:pid/:answer', ({ res, params }) => {
    const ids = readToken(secret(), params.token);
    const answer = Number(params.answer);
    const c = ids && db.get('SELECT design FROM campaigns WHERE id=?', ids.campaignId);
    let block = null;
    try { block = (JSON.parse(c?.design || '{}').blocks || []).find((b) => b && b.type === 'poll' && b.pid === params.pid); } catch { block = null; }
    const option = block && Number.isInteger(answer) ? (block.options || [])[answer] : undefined;
    if (!option) return html(res, page('סקר', '<h1>הקישור לא תקין</h1>'), 400);
    // נמען 0 הוא צפייה מהארכיון הציבורי: מציגים תודה בלי לרשום הצבעה
    if (ids.subscriberId > 0) {
      db.run(`INSERT INTO poll_votes(campaign_id, poll, subscriber_id, answer, created_at) VALUES(?,?,?,?,?)
        ON CONFLICT(campaign_id, poll, subscriber_id) DO UPDATE SET answer=excluded.answer, created_at=excluded.created_at`, ids.campaignId, params.pid, ids.subscriberId, answer, now());
    }
    html(res, page('תודה', `<h1>תודה, תשובתך נרשמה</h1><p>${esc(block.question)}</p><p><b>${esc(option)}</b></p><p>אפשר לשנות את התשובה בלחיצה על אפשרות אחרת במייל.</p>`));
  });

  // ---------- ארכיון ציבורי ----------
  router.add('GET', '/archive', ({ res }) => {
    if (db.setting('archiveEnabled') !== '1') return html(res, page('ארכיון', '<h1>הדף לא נמצא</h1>'), 404);
    const rows = db.all("SELECT id, subject, COALESCE(finished_at, started_at) at FROM campaigns WHERE public=1 AND status='sent' AND prepared_html IS NOT NULL ORDER BY at DESC LIMIT 300");
    const title = db.setting('archiveTitle') || 'ארכיון הגליונות';
    html(res, page(title, `<h1>${esc(title)}</h1>${rows.length ? `<ul class="arch">${rows.map((r) => `<li><a href="/archive/${r.id}">${esc(r.subject || '(ללא נושא)')}</a><small>${new Date(r.at * 1000).toLocaleDateString('he-IL')}</small></li>`).join('')}</ul>` : '<p>עדיין אין גליונות בארכיון.</p>'}
      <p><a href="/subscribe">להרשמה לרשימת התפוצה</a></p>`));
  });
  router.add('GET', '/archive/:id', ({ res, params }) => {
    const c = db.setting('archiveEnabled') === '1' && db.get("SELECT id, prepared_html FROM campaigns WHERE id=? AND public=1 AND status='sent'", Number(params.id) || 0);
    if (!c || !c.prepared_html) return html(res, page('הגליון לא נמצא', '<h1>הגליון לא נמצא</h1>'), 404);
    const baseUrl = db.setting('baseUrl').replace(/\/+$/, '');
    // נמען 0: קישורי המעקב וההסרה בעותק הציבורי לא משויכים לאף אחד
    html(res, personalize(c.prepared_html, { baseUrl, token: makeToken(secret(), c.id, 0), subscriber: { id: 0, email: '', name: '' }, isHtml: true }));
  });

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
