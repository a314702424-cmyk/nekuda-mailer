// בדיקה מקצה לקצה: מפעיל את השרת מול שרת SMTP מדומה ובודק את כל המסלול.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { parseBounce, applyBounce } from '../src/bounce.js';
import { parseContacts } from '../src/csv.js';
import { renderDesign, defaultDesign, htmlToText } from '../web/shared/render.js';
import { SmtpConnection, buildMessage } from '../src/mailer.js';

const received = [];
const authSeen = [];
const smtp = net.createServer((sock) => {
  let buf = '';
  let data = null;
  let cur = {};
  sock.setEncoding('utf8');
  sock.write('220 fake ESMTP\r\n');
  sock.on('data', (d) => {
    buf += d;
    for (;;) {
      if (data !== null) {
        const end = buf.indexOf('\r\n.\r\n');
        if (end < 0) return;
        cur.data = data + buf.slice(0, end);
        buf = buf.slice(end + 5);
        data = null;
        received.push(cur);
        cur = {};
        sock.write('250 queued\r\n');
        continue;
      }
      const i = buf.indexOf('\r\n');
      if (i < 0) return;
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (/^EHLO/i.test(line)) sock.write('250-fake\r\n250 8BITMIME\r\n');
      else if (/^AUTH PLAIN /i.test(line)) { authSeen.push(Buffer.from(line.slice(11), 'base64').toString('utf8')); sock.write('235 ok\r\n'); }
      else if (/^MAIL FROM/i.test(line)) { cur.from = line; sock.write('250 ok\r\n'); }
      else if (/^RCPT TO/i.test(line)) {
        if (line.includes('dead@')) sock.write('550 5.1.1 user unknown\r\n');
        else if (line.includes('later@')) sock.write('451 4.3.0 try later\r\n');
        else { cur.to = line; sock.write('250 ok\r\n'); }
      } else if (/^DATA/i.test(line)) { data = ''; sock.write('354 go\r\n'); }
      else if (/^RSET/i.test(line)) { cur = {}; sock.write('250 ok\r\n'); }
      else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
      else sock.write('500 unknown\r\n');
    }
  });
});

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const decodeParts = (raw) => [...raw.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/g)]
  .map((m) => Buffer.from(m[1].replace(/\s+/g, ''), 'base64').toString('utf8'));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-test-'));
const quiet = { info() {}, error: console.error };
const app = createApp({ dataDir, startWorker: false, log: quiet });
const smtpPort = await listen(smtp);
const port = await listen(app.server);
const base = `http://127.0.0.1:${port}`;
let cookie = '';

async function call(method, url, body, extra = {}) {
  const res = await fetch(base + url, {
    method, redirect: 'manual',
    headers: { 'X-Requested-With': 'nm', ...(method === 'DELETE' && !extra.noConfirm ? { 'X-Confirm-Delete': encodeURIComponent('מאושר למחיקה') } : {}), ...(body !== undefined && !extra.rawBody ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(extra.headers || {}) },
    body: body === undefined ? undefined : (extra.rawBody ? body : JSON.stringify(body)),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* לא JSON */ }
  return { status: res.status, data, headers: res.headers };
}
const ok = async (...a) => { const r = await call(...a); assert.ok(r.status < 300, `${a[0]} ${a[1]} -> ${r.status} ${JSON.stringify(r.data)}`); return r.data; };

let passed = 0;
const step = (name) => { passed++; console.log(`  ok  ${name}`); };

try {
  // --- יחידות ---
  const d = defaultDesign();
  d.blocks.push({ type: 'columns', cols: [{ src: 'https://x/a.png', alt: '', html: '<p>א</p>' }, { src: '', alt: '', html: '<p>ב</p>' }] });
  const rendered = renderDesign(d, { subject: 'נושא', preheader: 'תקציר' });
  assert.match(rendered, /@media only screen/);
  assert.match(rendered, /class="col txt"/);
  assert.match(rendered, /dir="rtl"/);
  assert.match(htmlToText(rendered), /כותרת הגליון/);
  step('בונה הגליון מפיק HTML רספונסיבי בעברית');

  const parsed = parseContacts('email;name\r\nA@x.co.il;אבי\r\nbad-address;x\r\na@x.co.il;כפול\r\n"Dan" <dan@y.com>');
  assert.deepEqual([parsed.rows.length, parsed.invalid, parsed.rows[0].email, parsed.rows[0].name], [1, 2, "a@x.co.il", "אבי"]);
  assert.deepEqual(parseContacts('a@x.com\nb@y.com\nnot an email').rows.map((r) => r.email), ['a@x.com', 'b@y.com']);
  assert.deepEqual(parseContacts('שם,כתובת מייל\nמשה,m@z.org').rows, [{ email: 'm@z.org', name: 'משה' }]);
  assert.deepEqual(parseContacts('"Dan K" <dan@y.com>').rows, [{ email: 'dan@y.com', name: 'Dan K' }]);
  step('ניתוח קובצי ייבוא');

  const direct = new SmtpConnection({ host: '127.0.0.1', port: smtpPort, secure: 'none', user: 'relay-user', pass: 'relay-pass', ehloName: 'test.local' });
  await direct.connect();
  await direct.send('from@x.test', 'to@y.test', buildMessage({ from: { name: 'א', email: 'from@x.test' }, to: { name: '', email: 'to@y.test' }, subject: 'בדיקה', html: '<p>.שורה שמתחילה בנקודה</p>', text: '.נקודה', domain: 'x.test' }));
  await assert.rejects(direct.send('from@x.test', 'dead@y.test', 'x'), (e) => e.permanent && e.stage === 'rcpt');
  await direct.send('from@x.test', 'again@y.test', 'Subject: x\r\n\r\n.leading dot\r\n');
  await direct.quit();
  assert.deepEqual(authSeen, ['\0relay-user\0relay-pass']);
  assert.equal(received.length, 2);
  assert.match(received[1].data, /\r\n\.\.leading dot/);
  received.length = 0;
  step('לקוח SMTP: הזדהות, שגיאת נמען והמשך באותו חיבור');

  // --- הקמה והתחברות ---
  assert.equal((await call('GET', '/api/lists')).status, 401);
  assert.equal((await ok('GET', '/api/meta')).needsSetup, true);
  assert.equal((await call('POST', '/api/setup', { username: 'admin', password: 'short' })).status, 400);
  await ok('POST', '/api/setup', { username: 'admin', password: 'correct-horse-battery' });
  assert.equal((await call('POST', '/api/setup', { username: 'x2x', password: 'correct-horse-battery' })).status, 409);
  cookie = '';
  assert.equal((await call('POST', '/api/login', { username: 'admin', password: 'wrong-password-1' })).status, 401);
  await ok('POST', '/api/login', { username: 'admin', password: 'correct-horse-battery' });
  assert.equal((await ok('GET', '/api/meta')).user.name, 'admin');
  const noCsrf = await fetch(base + '/api/lists', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{"name":"x"}' });
  assert.equal(noCsrf.status, 403);
  step('הקמה, התחברות והגנות גישה');

  // --- הגדרות, רשימות, ייבוא ---
  await ok('PUT', '/api/settings', { baseUrl: base + '/', fromEmail: 'office@nekuda.test', fromName: 'נקודה הוצאה לאור',
    bounceAddress: 'bounce@nekuda.test', smtpHost: '127.0.0.1', smtpPort: String(smtpPort), sendPerSecond: '200', smtpPass: 'secret-pass' });
  const settings = await ok('GET', '/api/settings');
  assert.equal(settings.baseUrl, base);
  assert.equal(settings.smtpPass, '');
  assert.equal(settings.hasSmtpPass, true);
  assert.equal(settings.secret, undefined);
  const listId = (await ok('POST', '/api/lists', { name: 'ראשית' })).id;
  const imp = await ok('POST', '/api/import', { listIds: [listId], text: 'email,name\nrina@a.test,רינה כהן\ndavid@b.test,דוד\ndead@c.test,מת\nlater@d.test,אחר כך\nquit@e.test,עוזב\nnot-an-email,x' });
  assert.deepEqual([imp.added, imp.invalid], [5, 1]);
  await ok('POST', '/api/import', { text: 'gone@f.test', status: 'unsubscribed', listIds: [listId] });
  assert.equal((await ok('POST', '/api/import', { text: 'gone@f.test', listIds: [listId] })).existing, 1);
  const subs = await ok('GET', '/api/subscribers?list=' + listId);
  assert.equal(subs.total, 6);
  assert.equal(subs.rows.find((r) => r.email === 'gone@f.test').status, 'unsubscribed');
  assert.equal((await ok('GET', '/api/lists'))[0].active, 5);
  const csv = await ok('GET', '/api/export?list=' + listId);
  assert.match(csv, /rina@a\.test,רינה כהן,active/);
  step('הגדרות, רשימות, ייבוא וייצוא');

  // --- גליון ---
  const cid = (await ok('POST', '/api/campaigns', { subject: 'טיוטה' })).id;
  const design = defaultDesign();
  design.blocks[2].href = 'https://nekuda.org.il/book?a=1&b=2';
  await ok('PUT', `/api/campaigns/${cid}`, { subject: 'שלום {{first_name}}, גליון 80', preheader: 'תקציר', fromName: 'נקודה הוצאה לאור',
    fromEmail: 'office@nekuda.test', replyTo: '', mode: 'blocks', design, html: '', listIds: [listId] });
  const rc = await ok('GET', `/api/campaigns/${cid}/recipients`);
  assert.equal(rc.total, 5);
  assert.match(await ok('GET', `/api/campaigns/${cid}/preview`), /להסרה מרשימת התפוצה/);
  const test = await ok('POST', `/api/campaigns/${cid}/test`, { emails: 'me@test.test' });
  assert.equal(test.results[0].ok, true);
  assert.equal(received.length, 1);
  assert.match(received[0].data, /Subject: =\?UTF-8\?B\?/);
  received.length = 0;
  step('יצירת גליון, תצוגה מקדימה ושליחת בדיקה');

  // --- שליחה ---
  assert.equal((await ok('POST', `/api/campaigns/${cid}/send`, {})).queued, 5);
  assert.equal((await call('PUT', `/api/campaigns/${cid}`, { subject: 'x' })).status, 409);
  app.worker.running = true;
  await app.worker.tick();
  assert.equal(received.length, 3, 'שלוש הודעות צריכות להגיע לשרת הדואר');
  const msg = received.find((m) => m.to.includes('rina@a.test'));
  assert.match(msg.from, /bounce\+[0-9a-z]+\.[0-9a-z]+\.[\w-]{14}@nekuda\.test/);
  assert.match(msg.data, /List-Unsubscribe: <http:\/\/127\.0\.0\.1:\d+\/u\//);
  assert.match(msg.data, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/);
  const subjWords = [...msg.data.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map((m) => Buffer.from(m[1], 'base64').toString('utf8')).join('');
  assert.match(subjWords, /שלום רינה, גליון 80/);
  const [textPart, htmlPart] = decodeParts(msg.data);
  assert.match(htmlPart, /שלום רינה כהן,/);
  assert.match(textPart, /שלום רינה כהן,/);
  assert.ok(!htmlPart.includes('{{'), 'לא נשארו תגים לא מוחלפים');
  const token = /\/u\/([0-9a-z]+\.[0-9a-z]+\.[\w-]{14})/.exec(htmlPart)[1];
  const clickUrl = new RegExp(`${base}/c/${token.replace(/\./g, '\\.')}/(\\d+)`).exec(htmlPart);
  assert.ok(clickUrl, 'הקישור הוחלף בקישור מעקב');
  assert.match(htmlPart, new RegExp(`/o/${token.replace(/\./g, '\\.')}\\.gif`));
  let st = (await ok('GET', `/api/campaigns/${cid}/stats`)).campaign.stats;
  assert.deepEqual([st.sent, st.bounced, st.pending], [3, 1, 1]);
  assert.equal((await ok('GET', '/api/subscribers?q=dead@')).rows[0].status, 'bounced');
  step('שליחה, כותרות הסרה, התאמה אישית וקפיצה קשה מיידית');

  // --- מעקב ---
  const gif = await fetch(`${base}/o/${token}.gif`);
  assert.equal(gif.headers.get('content-type'), 'image/gif');
  await fetch(`${base}/o/${token}.gif`);
  const click = await call('GET', `/c/${token}/${clickUrl[1]}`);
  assert.equal(click.status, 302);
  assert.equal(click.headers.get('location'), 'https://nekuda.org.il/book?a=1&b=2');
  assert.equal((await call('GET', `/c/${token}/999999`)).headers.get('location'), base);
  assert.equal((await call('GET', '/o/bad.token.gif')).status, 200);
  assert.match((await call('GET', `/v/${token}`)).data, /שלום רינה כהן/);
  const stats = await ok('GET', `/api/campaigns/${cid}/stats`);
  assert.deepEqual([stats.campaign.stats.opened, stats.campaign.stats.clicked], [1, 1]);
  assert.deepEqual([stats.links[0].clicks, stats.links[0].uniq], [1, 1]);
  step('מעקב פתיחות וקליקים, צפייה בדפדפן');

  // --- הסרה ---
  const quitMsg = received.find((m) => m.to.includes('quit@e.test'));
  const quitToken = /bounce\+([^@]+)@/.exec(quitMsg.from)[1];
  assert.match((await call('GET', `/u/${quitToken}`)).data, /להסיר אותך/);
  assert.equal((await ok('GET', '/api/subscribers?q=quit@')).rows[0].status, 'active', 'GET לא מסיר לבד');
  const oneClick = await fetch(`${base}/u/${quitToken}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
  assert.equal(oneClick.status, 200);
  assert.equal((await ok('GET', '/api/subscribers?q=quit@')).rows[0].status, 'unsubscribed');
  assert.equal((await call('POST', '/u/aa.bb.cccccccccccccc', undefined)).status, 400);
  assert.equal((await ok('GET', `/api/campaigns/${cid}/stats`)).campaign.stats.unsubscribed, 1);
  step('הסרה בלחיצה אחת');

  // --- קפיצות מאוחרות ---
  const davidMsg = received.find((m) => m.to.includes('david@b.test'));
  const davidToken = /bounce\+([^@]+)@/.exec(davidMsg.from)[1];
  const dsn = `Return-Path: <>\r\nTo: bounce+${davidToken}@nekuda.test\r\nContent-Type: multipart/report; report-type=delivery-status\r\n\r\nFinal-Recipient: rfc822; david@b.test\r\nAction: failed\r\nStatus: 5.1.1\r\nDiagnostic-Code: smtp; 550 5.1.1 The email account does not exist\r\n`;
  assert.equal(parseBounce(dsn).type, 'hard');
  applyBounce(app.db, parseBounce(dsn));
  assert.equal((await ok('GET', '/api/subscribers?q=david@')).rows[0].status, 'bounced');
  assert.equal(parseBounce('Subject: hello\r\n\r\njust a reply'), null);
  const soft = `To: bounce@nekuda.test\r\n\r\nFinal-Recipient: rfc822; rina@a.test\r\nStatus: 4.2.2\r\nDiagnostic-Code: smtp; 452 mailbox full\r\n`;
  applyBounce(app.db, parseBounce(soft));
  assert.equal((await ok('GET', '/api/subscribers?q=rina@')).rows[0].status, 'active', 'קפיצה רכה אחת לא חוסמת');
  applyBounce(app.db, parseBounce(soft)); applyBounce(app.db, parseBounce(soft));
  assert.equal((await ok('GET', '/api/subscribers?q=rina@')).rows[0].status, 'bounced', 'שלוש קפיצות רכות חוסמות');
  step('עיבוד הודעות קפיצה');

  // --- ניסיון חוזר, סיום, פילוח ---
  for (let i = 0; i < 4; i++) {
    app.db.run('UPDATE deliveries SET next_try=0 WHERE campaign_id=?', cid);
    await app.worker.tick();
  }
  await app.worker.tick();
  const done = (await ok('GET', `/api/campaigns/${cid}`));
  assert.equal(done.status, 'sent');
  assert.equal(done.stats.failed, 1);
  const seg = await ok('POST', '/api/lists/segment', { name: 'פותחים', campaignId: cid, kind: 'opened' });
  assert.equal(seg.added, 1);
  assert.equal((await ok('POST', '/api/lists/segment', { name: 'לא פתחו', campaignId: cid, kind: 'not_opened' })).added, 2);
  step('ניסיונות חוזרים, סיום גליון ופילוח לפי פתיחות');

  // --- שליחה חוזרת לא מכפילה, תזמון, טופס הרשמה, העלאה ---
  const before = received.length;
  await ok('POST', '/api/import', { text: 'new@g.test', listIds: [listId] });
  assert.equal((await ok('POST', `/api/campaigns/${cid}/send`, {})).queued, 1);
  await app.worker.tick(); await app.worker.tick();
  assert.equal(received.length, before + 1, 'רק הנמען החדש מקבל');

  const dup = (await ok('POST', `/api/campaigns/${cid}/duplicate`)).id;
  const at = Math.floor(Date.now() / 1000) + 3600;
  assert.equal((await ok('POST', `/api/campaigns/${dup}/send`, { scheduledAt: at })).scheduled, at);
  await app.worker.tick();
  assert.equal((await ok('GET', `/api/campaigns/${dup}`)).status, 'scheduled');
  await ok('POST', `/api/campaigns/${dup}/unschedule`);
  await ok('DELETE', `/api/campaigns/${dup}`);

  await ok('PUT', '/api/settings', { formListId: String(listId) });
  const form = await fetch(`${base}/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=%D7%99%D7%A2%D7%9C&email=yael@h.test&website=' });
  assert.match(await form.text(), /תודה, נרשמת/);
  const yael = (await ok('GET', '/api/subscribers?q=yael@')).rows[0];
  assert.deepEqual([yael.name, yael.source, yael.lists], ['יעל', 'form', [listId]]);
  await fetch(`${base}/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=bot@h.test&website=spam' });
  assert.equal((await ok('GET', '/api/subscribers?q=bot@')).total, 0, 'מלכודת הבוטים עובדת');

  const up = await ok('POST', '/api/upload', GIF_BYTES(), { rawBody: true, headers: { 'X-Filename': 'logo.gif', 'Content-Type': 'application/octet-stream' } });
  assert.equal((await fetch(up.url)).headers.get('content-type'), 'image/gif');
  assert.equal((await call('POST', '/api/upload', 'x', { rawBody: true, headers: { 'X-Filename': 'evil.html' } })).status, 400);
  assert.equal((await call('GET', '/media/..%2Fmailer.db')).status, 404);
  assert.equal((await call('GET', '/')).status, 200);
  const dash = await ok('GET', '/api/dashboard');
  assert.ok(dash.sentToday >= 4);
  step('שליחה חוזרת בלי כפילויות, תזמון, טופס הרשמה והעלאת תמונות');

  // --- גרסה 0.2.0: בדיקה לפני שליחה, מותג, בלוקים מסונכרנים, גרסאות, UTM ---
  const { checkEmail } = await import('../web/shared/check.js');
  const { withUtm } = await import('../src/track.js');
  const bad = checkEmail({ subject: '', preheader: '', html: '<a href="https://">x</a><a href="http://a.test/">y</a><img src="https://a.test/i.png"><p>{{nmae}}</p>', hasLists: false, fromEmail: '' });
  const texts = bad.issues.map((i) => i.text).join('|');
  for (const frag of ['חסרה שורת נושא', 'קישורים ריקים', 'בלי הצפנה', 'טקסט חלופי', 'תגים לא מוכרים', 'לא נבחרה רשימת', 'חסרה כתובת שולח', 'יתווסף', 'תוסיף אחד אוטומטית']) {
    if (frag === 'יתווסף') continue;
    assert.ok(texts.includes(frag), 'חסרה אזהרה: ' + frag);
  }
  assert.ok(checkEmail({ subject: 'x', preheader: 'y', html: 'a'.repeat(110 * 1024) }).issues.some((i) => i.level === 'error' && i.text.includes('102KB')));
  assert.equal(withUtm('https://a.test/p?x=1#top', 'issue 80', base), 'https://a.test/p?x=1&utm_source=newsletter&utm_medium=email&utm_campaign=issue%2080#top');
  assert.equal(withUtm('https://a.test/?utm_source=z', 'k', base), 'https://a.test/?utm_source=z');
  assert.equal(withUtm(base + '/subscribe', 'k', base), base + '/subscribe');

  await ok('PUT', '/api/brand', { bg: '#101010', btnBg: '#aa0000', font: 'Tahoma, Geneva, sans-serif', evil: 'x' });
  assert.deepEqual(Object.keys(await ok('GET', '/api/brand')).sort(), ['bg', 'btnBg', 'font']);
  const c2 = (await ok('POST', '/api/campaigns', { subject: 'גליון 81' })).id;
  const full = await ok('GET', `/api/campaigns/${c2}`);
  assert.equal(full.design.settings.bg, '#101010');
  const letter = await ok('GET', `/api/campaigns/${(await ok('POST', '/api/campaigns', { template: 'letter' })).id}`);
  assert.deepEqual(letter.design.blocks.map((b) => b.type), ['text', 'footer']);

  const blockId = (await ok('POST', '/api/blocks', { name: 'כותרת עליונה', synced: true, block: { type: 'heading', text: 'כותרת מסונכרנת', level: 2 } })).id;
  assert.equal((await call('POST', '/api/blocks', { name: 'x', block: { type: 'synced', ref: 1 } })).status, 400);
  const d2 = full.design;
  d2.settings.utm = 'issue-81';
  d2.blocks = [{ type: 'synced', ref: blockId }, { type: 'text', html: '<p>שלום {{name}}</p>', hideMobile: true },
    { type: 'button', text: 'קישור תקין', href: base + '/subscribe' }, { type: 'button', text: 'קישור שבור', href: base + '/no-such-page' },
    { type: 'button', text: 'חיצוני', href: 'https://nekuda.org.il/x' }, { type: 'image', src: base + '/media/none.png', alt: '' }];
  const put = (extra = {}) => ok('PUT', `/api/campaigns/${c2}`, { subject: 'גליון 81', preheader: '', fromName: 'נ', fromEmail: 'office@nekuda.test', replyTo: '', mode: 'blocks', design: d2, html: '', listIds: [listId], ...extra });
  await put({ snapshot: true });
  let prev = await ok('GET', `/api/campaigns/${c2}/preview`);
  assert.match(prev, /כותרת מסונכרנת/);
  assert.match(prev, /<tr class="hm">/);
  await ok('PUT', `/api/blocks/${blockId}`, { block: { type: 'heading', text: 'כותרת שעודכנה', level: 2 } });
  assert.match(await ok('GET', `/api/campaigns/${c2}/preview`), /כותרת שעודכנה/);
  assert.match(await ok('GET', `/api/campaigns/${c2}/preview?as=yael@h.test`), /שלום יעל/);
  assert.equal((await call('GET', `/api/campaigns/${c2}/preview?as=nobody@h.test`)).status, 404);

  const chk = await ok('POST', `/api/campaigns/${c2}/check`, { links: true });
  const ct = chk.issues.map((i) => i.text).join('|');
  assert.ok(ct.includes(`שגיאה 404: ${base}/no-such-page`), 'קישור שבור מזוהה');
  assert.ok(!ct.includes(`${base}/subscribe`), 'קישור תקין לא מסומן');
  assert.ok(ct.includes('טקסט חלופי') && ct.includes('אין תקציר'));
  assert.equal(chk.stats.linksChecked, 3);

  d2.blocks[1].html = '<p>גרסה שנייה</p>';
  await put({ snapshot: true, subject: 'גליון 81 ב' });
  const versions = await ok('GET', `/api/campaigns/${c2}/versions`);
  assert.equal(versions.length, 2);
  await put({ subject: 'שמירה אוטומטית' });
  assert.equal((await ok('GET', `/api/campaigns/${c2}/versions`)).length, 2, 'שמירה אוטומטית לא יוצרת גרסה בכל פעם');
  await ok('POST', `/api/campaigns/${c2}/versions/${versions[1].id}/restore`);
  assert.match(await ok('GET', `/api/campaigns/${c2}/preview`), /שלום admin/);

  d2.blocks = d2.blocks.filter((b) => b.type !== 'image' && b.text !== 'קישור שבור');
  await put();
  const sentBefore = received.length;
  await ok('POST', `/api/campaigns/${c2}/send`, {});
  await app.worker.tick();
  const m2 = decodeParts(received[sentBefore].data)[1];
  assert.match(m2, /כותרת שעודכנה/);
  const links2 = app.db.all('SELECT url FROM links WHERE campaign_id=?', c2).map((l) => l.url);
  assert.ok(links2.includes('https://nekuda.org.il/x?utm_source=newsletter&utm_medium=email&utm_campaign=issue-81'), 'UTM נוסף לקישור חיצוני');
  assert.ok(links2.includes(base + '/subscribe'), 'קישור פנימי בלי UTM');
  await ok('DELETE', `/api/blocks/${blockId}`);
  step('בדיקה לפני שליחה, ערכת מותג, בלוקים מסונכרנים, גרסאות, תצוגה כנמען ו-UTM');

  // --- גרסה 0.3.0: משתמשים והרשאות ---
  const adminCookie = cookie;
  const meta3 = await ok('GET', '/api/meta');
  assert.deepEqual([meta3.user.name, meta3.user.role, meta3.google], ['admin', 'admin', false]);
  assert.ok(meta3.user.perms.includes('users.manage'));
  const editorId = (await ok('POST', '/api/users', { username: 'editor', email: 'Editor@Gmail.com', password: 'editor-pass-123', role: 'user', perms: ['campaigns.view', 'subscribers.view', 'bogus'] })).id;
  assert.equal((await call('POST', '/api/users', { username: 'editor', password: 'another-pass-1' })).status, 409);
  assert.equal((await call('POST', '/api/users', { username: 'nobody' })).status, 400, 'משתמש בלי סיסמה ובלי מייל');
  const meId = meta3.user.id;
  assert.equal((await call('PUT', `/api/users/${meId}`, { username: 'admin', role: 'user', perms: [] })).status, 409, 'אי אפשר להוריד את המנהל האחרון');
  assert.equal((await call('DELETE', `/api/users/${meId}`)).status, 409);
  cookie = '';
  await ok('POST', '/api/login', { username: 'editor', password: 'editor-pass-123' });
  const editorCookie = cookie;
  const em = (await ok('GET', '/api/meta')).user;
  assert.deepEqual([em.name, em.role, em.perms], ['editor', 'user', ['campaigns.view', 'subscribers.view']]);
  await ok('GET', '/api/campaigns');
  await ok('GET', '/api/subscribers');
  await ok('GET', '/api/dashboard');
  for (const [m, u, b] of [['POST', '/api/campaigns', {}], ['GET', '/api/users'], ['GET', '/api/settings'], ['GET', '/api/lists'], ['GET', '/api/export'],
    ['POST', `/api/campaigns/${c2}/send`, {}], ['GET', `/api/campaigns/${c2}/stats`], ['DELETE', `/api/campaigns/${c2}`], ['POST', '/api/subscribers/bulk', { all: true, action: 'delete' }], ['POST', '/api/import', { text: 'q@q.com' }]]) {
    assert.equal((await call(m, u, b)).status, 403, `${m} ${u} חסום למשתמש בלי הרשאה`);
  }
  cookie = adminCookie;
  await ok('PUT', `/api/users/${editorId}`, { username: 'editor', email: 'editor@gmail.com', role: 'user', perms: ['campaigns.view'], active: false });
  cookie = editorCookie;
  assert.equal((await call('GET', '/api/campaigns')).status, 401, 'משתמש מושבת מנותק');
  assert.equal((await call('POST', '/api/login', { username: 'editor', password: 'editor-pass-123' })).status, 401);
  cookie = adminCookie;
  await ok('PUT', `/api/users/${editorId}`, { username: 'editor', email: 'editor@gmail.com', role: 'user', perms: ['campaigns.view'], active: true });
  step('משתמשים, הרשאות לפי פעולה, השבתה והגנה על המנהל האחרון');

  // --- כניסה עם Google מול ספק מדומה ---
  const http = await import('node:http');
  let tokenClaims = {};
  const fakeGoogle = http.createServer((req, res) => {
    const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id_token: `${part({ alg: 'none' })}.${part(tokenClaims)}.x` }));
  });
  const gPort = await listen(fakeGoogle);
  process.env.GOOGLE_TOKEN_URL = `http://127.0.0.1:${gPort}/token`;
  try {
    cookie = '';
    assert.equal((await call('GET', '/auth/google')).status, 404, 'כבוי עד שמגדירים');
    cookie = adminCookie;
    await ok('PUT', '/api/settings', { googleClientId: 'cid-1', googleClientSecret: 'secret-1' });
    const st = await ok('GET', '/api/settings');
    assert.deepEqual([st.googleClientSecret, st.hasGoogleSecret], ['', true], 'הסוד לא נחשף');
    cookie = '';
    assert.equal((await ok('GET', '/api/meta')).google, true);
    const go = async (claims) => {
      cookie = '';
      const start = await call('GET', '/auth/google');
      assert.equal(start.status, 302);
      const loc = new URL(start.headers.get('location'));
      assert.equal(loc.searchParams.get('redirect_uri'), base + '/auth/google/callback');
      tokenClaims = { iss: 'https://accounts.google.com', aud: 'cid-1', exp: Math.floor(Date.now() / 1000) + 300, email_verified: true, ...claims };
      return call('GET', `/auth/google/callback?code=abc&state=${loc.searchParams.get('state')}`);
    };
    assert.equal((await go({ email: 'stranger@gmail.com' })).status, 403, 'חשבון שלא הוגדר נדחה');
    assert.equal((await go({ email: 'editor@gmail.com', aud: 'other' })).status, 403, 'אסימון של אפליקציה אחרת נדחה');
    assert.equal((await go({ email: 'editor@gmail.com', email_verified: false })).status, 403);
    cookie = '';
    assert.equal((await call('GET', '/auth/google/callback?code=abc&state=forged')).status, 400, 'בלי state תואם');
    assert.equal((await go({ email: 'EDITOR@gmail.com' })).status, 302);
    assert.equal((await ok('GET', '/api/meta')).user.name, 'editor');
  } finally {
    delete process.env.GOOGLE_TOKEN_URL;
    fakeGoogle.close();
  }
  cookie = adminCookie;
  step('כניסה עם Google: רק למשתמשים שהוגדרו, עם בדיקת state ואסימון');

  // --- תור, נמענים לפי תגובה, פעולות מרוכזות, דף הרשמה ו-PDF ---
  const queue = await ok('GET', '/api/queue');
  assert.ok(Array.isArray(queue.campaigns) && typeof queue.sentToday === 'number');
  const sentPeople = await ok('GET', `/api/campaigns/${c2}/people?kind=sent`);
  assert.ok(sentPeople.total > 0 && sentPeople.rows[0].email);
  assert.equal((await ok('GET', `/api/campaigns/${c2}/people?kind=clicked`)).total, 0);
  const csv3 = await ok('GET', `/api/campaigns/${c2}/people.csv?kind=sent`);
  assert.ok(csv3.includes('email,name,status') && csv3.includes(sentPeople.rows[0].email));

  const bulkList = (await ok('POST', '/api/lists', { name: 'רשימה לפעולה מרוכזת' })).id;
  assert.equal((await call('POST', '/api/subscribers/bulk', { action: 'delete' })).status, 400, 'בלי סינון ובלי אישור מפורש');
  const dry = await ok('POST', '/api/subscribers/bulk', { filter: { status: 'active' }, dryRun: true });
  assert.ok(dry.count > 0);
  await ok('POST', '/api/subscribers/bulk', { filter: { status: 'active' }, action: 'addToList', listId: bulkList });
  assert.equal(Number(app.db.get('SELECT COUNT(*) n FROM subscriptions WHERE list_id=?', bulkList).n), dry.count);
  await ok('POST', '/api/subscribers/bulk', { filter: { list: bulkList }, action: 'removeFromList', listId: bulkList });
  assert.equal(Number(app.db.get('SELECT COUNT(*) n FROM subscriptions WHERE list_id=?', bulkList).n), 0);
  const subsBefore = Number(app.db.get('SELECT COUNT(*) n FROM subscribers').n);
  await ok('POST', '/api/import', { text: 'bulk1@del.com\nbulk2@del.com', listIds: [bulkList], status: 'active' });
  assert.equal((await ok('POST', '/api/subscribers/bulk', { filter: { list: bulkList }, action: 'delete', confirm: 'מאושר למחיקה' })).count, 2);
  assert.equal(Number(app.db.get('SELECT COUNT(*) n FROM subscribers').n), subsBefore);

  await ok('PUT', '/api/settings', { formTitle: 'הצטרפו לגליון <נקודה>', formIntro: 'שורה א\nשורה ב', formButton: 'אני בפנים', formSuccess: 'נרשמת בהצלחה', formColor: '#aa0000', formAskName: '0', formListId: String(bulkList) });
  const formHtml = await ok('GET', '/subscribe');
  assert.ok(formHtml.includes('הצטרפו לגליון &lt;נקודה&gt;') && formHtml.includes('שורה א<br>שורה ב') && formHtml.includes('אני בפנים') && formHtml.includes('#aa0000'));
  assert.ok(!formHtml.includes('name="name"'), 'שדה השם הוסתר');
  const posted = await fetch(base + '/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=form3@new.org' });
  assert.match(await posted.text(), /נרשמת בהצלחה/);
  assert.ok(app.db.get("SELECT 1 x FROM subscribers s JOIN subscriptions sp ON sp.subscriber_id=s.id WHERE s.email='form3@new.org' AND sp.list_id=?", bulkList));

  const nl = (await ok('POST', '/api/campaigns', { template: 'newsletter' })).id;
  assert.match(await ok('GET', `/api/campaigns/${nl}/preview`), /דבר המערכת/);
  const low = (await ok('GET', `/api/campaigns/${nl}`)).design;
  low.settings.color = '#cccccc'; low.settings.contentBg = '#ffffff'; low.settings.fontSize = 11;
  await ok('PUT', `/api/campaigns/${nl}`, { design: low, subject: 'בדיקת נגישות' });
  const acc = (await ok('POST', `/api/campaigns/${nl}/check`, {})).issues.map((i) => i.text).join('|');
  assert.ok(/ניגודיות/.test(acc) && /11px/.test(acc), 'בדיקות נגישות: ' + acc);

  const pdfRes = await fetch(`${base}/api/campaigns/${c2}/pdf`, { headers: { Cookie: cookie } });
  if (meta3.pdf) {
    assert.equal(pdfRes.status, 200);
    assert.equal(Buffer.from(await pdfRes.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  } else assert.equal(pdfRes.status, 501);
  step('תור שליחה, נמענים לפי תגובה, פעולות מרוכזות, דף הרשמה ערוך, נגישות ו-PDF' + (meta3.pdf ? '' : ' (בלי Chrome)'));

  // --- גרסה 0.4.0: אישור הרשמה במייל, עדכון הרשמה, ארכיון והיסטוריה ---
  await ok('PUT', '/api/settings', { formDoubleOptIn: '1', archiveEnabled: '1', archiveTitle: 'כל הגליונות' });
  const mailsBefore = received.length;
  const pendRes = await fetch(base + '/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=opt@in.org&name=' + encodeURIComponent('דני') });
  assert.match(await pendRes.text(), /כמעט סיימנו/);
  const optRow = () => app.db.get("SELECT id, status FROM subscribers WHERE email='opt@in.org'");
  assert.equal(optRow().status, 'pending');
  assert.equal(received.length, mailsBefore + 1, 'נשלח מייל אישור');
  const confirmMail = decodeParts(received.at(-1).data).join('\n');
  const confirmLink = confirmMail.match(/\/confirm\/[\w.-]+/)[0];
  assert.equal((await call('GET', '/confirm/0.zz.bad')).status, 400);
  assert.equal((await call('GET', confirmLink)).status, 200);
  assert.equal(optRow().status, 'active');
  await ok('PUT', '/api/settings', { formDoubleOptIn: '0' });

  const { makeToken } = await import('../src/track.js');
  const prefTok = makeToken(app.db.setting('secret'), c2, optRow().id);
  const twoLists = app.db.all('SELECT id FROM lists ORDER BY id LIMIT 2').map((l) => l.id);
  for (const l of twoLists) app.db.run('INSERT OR IGNORE INTO subscriptions(subscriber_id, list_id, created_at) VALUES(?,?,0)', optRow().id, l);
  const mine = () => app.db.all('SELECT list_id FROM subscriptions WHERE subscriber_id=? ORDER BY list_id', optRow().id).map((r) => r.list_id);
  const listsBefore = mine();
  assert.match(await ok('GET', '/p/' + prefTok), /עדכון ההרשמה/);
  const keepId = listsBefore[0];
  const prefPost = await fetch(`${base}/p/${prefTok}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `name=${encodeURIComponent('דני החדש')}&list=${keepId}&list=99999` });
  assert.match(await prefPost.text(), /השינויים נשמרו/);
  assert.deepEqual(mine(), [keepId], 'אפשר רק לעזוב רשימות, לא להצטרף');
  assert.equal(app.db.get('SELECT name FROM subscribers WHERE id=?', optRow().id).name, 'דני החדש');
  assert.equal((await call('GET', '/p/1.1.forged')).status, 400);

  for (let i = 0; i < 8 && app.db.get('SELECT status FROM campaigns WHERE id=?', c2).status !== 'sent'; i++) { app.db.run('UPDATE deliveries SET next_try=0 WHERE campaign_id=?', c2); await app.worker.tick(); }
  assert.equal(app.db.get('SELECT status FROM campaigns WHERE id=?', c2).status, 'sent');
  assert.equal((await call('GET', `/archive/${c2}`)).status, 404, 'גליון שלא סומן לא מוצג');
  await ok('POST', `/api/campaigns/${c2}/public`, { public: true });
  assert.ok((await ok('GET', '/api/campaigns')).find((x) => x.id === c2).public);
  const archList = await ok('GET', '/archive');
  assert.ok(archList.includes('כל הגליונות') && archList.includes(`/archive/${c2}`));
  const archOne = await ok('GET', `/archive/${c2}`);
  assert.ok(archOne.includes('כותרת שעודכנה') && !archOne.includes('{{'));
  await ok('PUT', '/api/settings', { archiveEnabled: '0' });
  assert.equal((await call('GET', '/archive')).status, 404);

  const someone = sentPeople.rows[0];
  const hist = await ok('GET', `/api/subscribers/${someone.id}/history`);
  assert.ok(hist.deliveries.length && hist.deliveries[0].subject && hist.subscriber.created_at);
  step('אישור הרשמה במייל, דף עדכון ההרשמה, ארכיון ציבורי והיסטוריית נמען');

  // --- גרסה 0.5.0: שדרוג העורך ---
  const d5 = defaultDesign();
  d5.settings.font = "'Heebo', Arial, sans-serif"; d5.settings.headingFont = "'Suez One', Georgia, serif";
  d5.blocks = [{ type: 'heading', text: 'כ', level: 1, size: 40, blockBg: '#fff0f0' }, { type: 'text', html: '<p>ט</p>', blockBg: 'javascript:1' },
    { type: 'button', text: 'לחץ', href: 'https://x.org', size: 'l', full: true }, { type: 'button', text: 'קטן', href: 'https://x.org', size: 's' }];
  const r5 = renderDesign(d5, {});
  assert.ok(r5.includes('family=Heebo:wght@400;700&family=Suez+One') && r5.indexOf('fonts.googleapis.com') < r5.indexOf('<style>'), 'קישור לגופני רשת בראש המייל');
  assert.ok(r5.includes("font-family:'Suez One', Georgia, serif;font-size:40px") && r5.includes('bgcolor="#fff0f0"') && !r5.includes('javascript'));
  assert.ok(r5.includes('padding:16px 36px') && r5.includes('width="100%" style="width:100%;"') && r5.includes('padding:8px 18px'));
  assert.ok(!r5.includes('data-b='), 'סימוני עריכה לא נכנסים למייל');
  const e5 = renderDesign(d5, { editor: true });
  assert.ok(e5.includes('<tr data-b="0"') && e5.includes('<tr data-b="3"') && e5.indexOf('fonts.googleapis.com') > e5.indexOf('<body'));
  assert.ok(!renderDesign(defaultDesign(), {}).includes('fonts.googleapis.com'), 'בלי גופן רשת אין טעינה חיצונית');
  d5.settings.font = 'Comic Sans; } body { display:none';
  assert.ok(!renderDesign(d5, {}).includes('Comic Sans'), 'גופן לא מוכר נדחה');
  step('עורך: גופני רשת, גופן כותרות, גדלי כפתור, רקע לבלוק וסימוני עריכה');

  {
  // --- גרסה 0.6.0: שדות מותאמים, קבצים מצורפים, A/B, תנאי תצוגה, סקר ואוטומציות ---
  await ok('PUT', '/api/settings', { customFields: 'city:עיר\nname:אסור\nBad Key:x\ncity:כפול' });
  assert.deepEqual((await ok('GET', '/api/meta')).fields, [{ key: 'city', label: 'עיר' }]);
  const L6 = (await ok('POST', '/api/lists', { name: 'רשימת 0.6' })).id;
  const Lvip = (await ok('POST', '/api/lists', { name: 'VIP' })).id;
  await ok('POST', '/api/import', { text: 'v1@six.org,אחת\nv2@six.org,שתיים\nv3@six.org,שלוש\nv4@six.org,ארבע', listIds: [L6], status: 'active' });
  const six = app.db.all("SELECT id, email FROM subscribers WHERE email LIKE '%@six.org' ORDER BY id");
  await ok('PUT', `/api/subscribers/${six[0].id}`, { email: six[0].email, name: 'אחת', status: 'active', listIds: [L6, Lvip], fields: { city: 'חיפה <b>', hack: 'x' } });
  assert.equal(app.db.get('SELECT fields FROM subscribers WHERE id=?', six[0].id).fields, '{"city":"חיפה <b>"}');
  const joined = app.db.get('SELECT created_at FROM subscriptions WHERE subscriber_id=? AND list_id=?', six[0].id, L6).created_at;
  assert.ok(joined > 0, 'מועד ההצטרפות לרשימה קיימת נשמר בעריכה');

  const c6 = (await ok('POST', '/api/campaigns', {})).id;
  const d6 = defaultDesign();
  d6.blocks = [{ type: 'text', html: '<p>גר ב{{city}}.</p>' }, { type: 'text', html: '<p>רק ל-VIP</p>', onlyList: Lvip },
    { type: 'text', html: '<p>לא ל-VIP</p>', onlyList: Lvip, notInList: true }, { type: 'poll', pid: 'poll01', question: 'איך היה?', options: ['טוב', 'רע'] }];
  await ok('PUT', `/api/campaigns/${c6}`, { subject: 'נושא א', subjectB: 'נושא ב', preheader: '', fromName: 'נ', fromEmail: 'office@nekuda.test', replyTo: '', mode: 'blocks', design: d6, listIds: [L6] });
  const up = await call('POST', `/api/campaigns/${c6}/attachments`, Buffer.from('%PDF-1.4 fake'), { rawBody: true, headers: { 'X-Filename': encodeURIComponent('תוכנית שנתית.pdf'), 'Content-Type': 'application/octet-stream' } });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal((await call('POST', `/api/campaigns/${c6}/attachments`, Buffer.from('MZ'), { rawBody: true, headers: { 'X-Filename': 'virus.exe', 'Content-Type': 'application/octet-stream' } })).status, 400);
  assert.equal((await ok('POST', `/api/campaigns/${c6}/check`, {})).issues.filter((i) => /city/.test(i.text)).length, 0, 'שדה מותאם הוא תג מוכר');
  const asVip = await ok('GET', `/api/campaigns/${c6}/preview?as=${six[0].email}`);
  assert.ok(asVip.includes('גר בחיפה &lt;b&gt;.') && asVip.includes('רק ל-VIP') && !asVip.includes('לא ל-VIP'));
  const from6 = received.length;
  await ok('POST', `/api/campaigns/${c6}/send`, {});
  await app.worker.tick();
  const got6 = received.slice(from6);
  assert.equal(got6.length, 4);
  const mailTo = (addr) => got6.find((m) => m.to.includes(addr)).data;
  const m1 = mailTo(six[0].email); const m2 = mailTo(six[1].email);
  assert.ok(/Content-Type: multipart\/mixed/.test(m1) && m1.includes("filename*=UTF-8''" + encodeURIComponent('תוכנית שנתית.pdf')) && m1.includes(Buffer.from('%PDF-1.4 fake').toString('base64')));
  const [t1, h1] = decodeParts(m1); const [t2, h2] = decodeParts(m2);
  assert.ok(h1.includes('רק ל-VIP') && !h1.includes('לא ל-VIP') && t1.includes('רק ל-VIP') && !t1.includes('לא ל-VIP') && !t1.includes('nm-if'));
  assert.ok(!h2.includes('רק ל-VIP') && h2.includes('לא ל-VIP') && !t2.includes('רק ל-VIP') && !h2.includes('nm-if'));
  assert.ok(h1.includes('גר בחיפה &lt;b&gt;.') && h2.includes('גר ב.'));
  const subj = (m) => Buffer.from(m.match(/Subject: =\?UTF-8\?B\?([^?]+)\?=/)[1], 'base64').toString('utf8');
  assert.deepEqual(got6.map((m) => subj(m.data)).sort(), ['נושא א', 'נושא א', 'נושא ב', 'נושא ב']);
  const pollLink = h1.match(/\/poll\/[\w.-]+\/poll01\/1/)[0];
  assert.match(await ok('GET', pollLink), /תשובתך נרשמה/);
  await ok('GET', pollLink.replace(/1$/, '0'));
  assert.equal((await call('GET', pollLink.replace(/1$/, '7'))).status, 400);
  const st6 = await ok('GET', `/api/campaigns/${c6}/stats`);
  assert.deepEqual(st6.polls[0].options.map((o) => o.votes), [1, 0], 'הצבעה חוזרת מחליפה את הקודמת');
  assert.deepEqual(st6.ab.map((v) => [v.subject, v.sent]), [['נושא א', 2], ['נושא ב', 2]]);

  const cw = (await ok('POST', '/api/campaigns', {})).id;
  await ok('PUT', `/api/campaigns/${cw}`, { subject: 'ברוך הבא {{first_name}}', preheader: '', fromName: 'נ', fromEmail: 'office@nekuda.test', replyTo: '', mode: 'blocks', design: defaultDesign(), listIds: [] });
  const au = (await ok('POST', '/api/automations', { name: 'ברוך הבא', listId: L6, campaignId: cw, delayHours: 0 })).id;
  assert.equal((await call('POST', '/api/automations', { name: 'כפול', listId: L6, campaignId: cw })).status, 409);
  app.db.run('UPDATE automations SET created_at=created_at-5 WHERE id=?', au);
  app.db.run('UPDATE subscriptions SET created_at=created_at-60 WHERE list_id=?', L6);
  await ok('POST', `/api/automations/${au}/toggle`, { active: true });
  assert.equal((await call('POST', `/api/campaigns/${cw}/send`, {})).status, 409);
  const fromA = received.length;
  await app.worker.tick();
  assert.equal(received.length, fromA, 'מי שכבר היה ברשימה לא מקבל');
  await ok('POST', '/api/import', { text: 'new@six.org,חדש בא', listIds: [L6], status: 'active' });
  await app.worker.tick();
  assert.equal(received.length, fromA + 1);
  assert.ok(received.at(-1).to.includes('new@six.org') && subj(received.at(-1).data) === 'ברוך הבא חדש');
  await app.worker.tick();
  assert.equal(received.length, fromA + 1, 'לא נשלח פעמיים');
  assert.equal(app.db.get('SELECT status FROM campaigns WHERE id=?', cw).status, 'sending', 'גליון אוטומציה נשאר פעיל');
  const autos = await ok('GET', '/api/automations');
  assert.deepEqual([autos[0].sent, autos[0].active], [1, true]);
  await ok('POST', `/api/automations/${au}/toggle`, { active: false });
  assert.equal(app.db.get('SELECT status FROM campaigns WHERE id=?', cw).status, 'paused');
  assert.equal((await call('DELETE', `/api/campaigns/${cw}`)).status, 409);
  await ok('DELETE', `/api/automations/${au}`);
  assert.deepEqual(Object.values(app.db.get('SELECT status, auto FROM campaigns WHERE id=?', cw)), ['sent', 0]);
  }
  step('שדות מותאמים, קבצים מצורפים, בדיקת A/B, תנאי תצוגה, סקר ואוטומציות');

  // --- גרסה 0.7.0: עוזר AI מול שרת Gemini מדומה ---
  {
    const { rankModels, cleanHtml, parseJson } = await import('../src/ai.js');
    assert.deepEqual(rankModels(['gemma-3-27b-it', 'gemini-2.5-pro', 'gemini-3.8-flash-preview', 'gemini-2.5-flash-lite', 'gemini-3.8-flash', 'gemini-4-argon', 'gemini-2.5-flash']
      .map((id) => ({ id, family: id.startsWith('gemma') ? 'gemma' : 'gemini' }))).map((m) => m.id).slice(0, 3), ['gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-4-argon'], 'מנוע מהיר, יציב וחדש קודם');
    assert.equal(cleanHtml('```html\n<h2 onclick="x()">כותרת</h2><p style="color:red">טקסט <a href="javascript:alert(1)">רע</a> <a href="https://ok.org" target="_blank">טוב</a></p><script>x()</script>\n```'),
      '<p><b>כותרת</b></p><p>טקסט רע <a href="https://ok.org">טוב</a></p>');
    assert.equal(cleanHtml('שורה א\n\nשורה ב'), '<p>שורה א</p><p>שורה ב</p>');
    assert.deepEqual(parseJson('הנה:\n```json\n[{"a":1}]\n```'), [{ a: 1 }]);

    const httpMod = await import('node:http');
    const seen = [];
    let failModel = '';
    const fake = httpMod.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        const sent = req.headers['x-goog-api-key'] || new URL(req.url, 'http://x').searchParams.get('key');
        if (sent === 'AQ.nolist' && req.method === 'GET') { res.statusCode = 403; return res.end(JSON.stringify({ error: { status: 'PERMISSION_DENIED', message: 'Auth keys cannot list models' } })); }
        if (sent === 'AQ.query' && req.headers['x-goog-api-key']) { res.statusCode = 401; return res.end(JSON.stringify({ error: { status: 'UNAUTHENTICATED', message: 'ACCESS_TOKEN_TYPE_UNSUPPORTED credential' } })); }
        if (sent === 'AQ.vertex') { res.statusCode = 403; return res.end(JSON.stringify({ error: { status: 'PERMISSION_DENIED', message: 'Requests to this API generativelanguage.googleapis.com method google.ai.generativelanguage.v1beta.GenerativeService.GenerateContent are blocked.' } })); }
        if (!['good-key', 'AQ.nolist', 'AQ.query'].includes(sent)) { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: 'API key not valid. Please pass a valid API key.' } })); }
        if (req.method === 'GET') {
          return res.end(JSON.stringify({ models: [
            { name: 'models/gemini-embedding-001', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
            { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-3.8-flash-image', displayName: 'Image', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemma-3-27b-it', displayName: 'Gemma 3', supportedGenerationMethods: ['generateContent'] }] }));
        }
        const model = decodeURIComponent(req.url).match(/models\/([^:]+):generateContent/)[1];
        const body = JSON.parse(raw);
        seen.push({ model, body });
        if (model === failModel) { res.statusCode = 429; return res.end(JSON.stringify({ error: { message: 'quota' } })); }
        const ask = body.contents[0].parts[0].text;
        const text = /חמש שורות נושא/.test(ask) ? '```json\n[{"subject":"נושא מוצע","preheader":"תקציר מוצע"},{"subject":""}]\n```'
          : /בנה טיוטת גליון/.test(ask) ? '{"subject":"גליון חנוכה","preheader":"חג שמח","blocks":[{"type":"heading","text":"חנוכה","level":1},{"type":"text","html":"<p onclick=\\"x\\">שלום</p><script>1</script>"},{"type":"button","text":"הרשמה","href":"javascript:1"},{"type":"video","url":"x"}]}'
            : '<p style="x">טקסט <b>משופר</b></p>';
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }));
      });
    });
    process.env.GEMINI_BASE = `http://127.0.0.1:${await listen(fake)}`;
    const vseen = [];
    const fakeVertex = httpMod.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        const model = (decodeURIComponent(req.url).match(/^\/v1\/publishers\/google\/models\/([^:]+):generateContent/) || [])[1];
        if (req.headers['x-goog-api-key'] !== 'AQ.vertex' || !model) { res.statusCode = 403; return res.end(JSON.stringify({ error: { status: 'PERMISSION_DENIED', message: 'blocked' } })); }
        if (!['gemini-3.5-flash', 'gemini-9-custom'].includes(model)) { res.statusCode = 404; return res.end(JSON.stringify({ error: { status: 'NOT_FOUND', message: 'Publisher model not found' } })); }
        vseen.push(model);
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: '<p>תשובה מ-Vertex</p>' }] } }] }));
      });
    });
    process.env.VERTEX_BASE = `http://127.0.0.1:${await listen(fakeVertex)}`;
    try {
      assert.equal((await ok('GET', '/api/meta')).ai, false);
      assert.equal((await call('POST', '/api/ai', { action: 'chat', prompt: 'שאלה' })).status, 400, 'בלי מפתח');
      const bad = await ok('POST', '/api/ai/test', { key: 'wrong' });
      assert.ok(!bad.ok && /המפתח לא תקין/.test(bad.error));
      assert.ok(/HTTP 400/.test(bad.detail) && /לא מוכר/.test(bad.format), 'חיווי מפורט: ' + JSON.stringify(bad));
      const messy = await ok('POST', '/api/ai/test', { key: ' "good-key"\u200f\n' });
      assert.deepEqual([messy.ok, messy.cleaned], [true, true], 'מפתח עם רווחים ותווים נסתרים מנוקה');
      const nolist = await ok('POST', '/api/ai/test', { key: 'AQ.nolist' });
      assert.deepEqual([nolist.ok, nolist.used, !!nolist.listError, /AQ\./.test(nolist.format)], [true, 'gemini-flash-latest', true, true], 'מפתח שלא מורשה לרשימת המנועים עדיין עובד');
      assert.equal((await ok('POST', '/api/ai/test', { key: 'AQ.query' })).ok, true, 'מפתח שמתקבל רק בפרמטר key');
      const vx = await ok('POST', '/api/ai/test', { key: 'AQ.vertex' });
      assert.deepEqual([vx.ok, vx.vertex, vx.used, vx.auto], [true, true, 'gemini-3.5-flash', 'gemini-3.5-flash'], 'מפתח של Vertex AI מזוהה לבד: ' + JSON.stringify(vx));
      await ok('PUT', '/api/settings', { aiKey: 'AQ.vertex', aiModel: '' });
      assert.deepEqual(await ok('POST', '/api/ai', { action: 'rewrite', mode: 'improve', text: '<p>א</p>' }), { model: 'gemini-3.5-flash', html: '<p>תשובה מ-Vertex</p>' });
      await ok('PUT', '/api/settings', { aiModel: 'gemini-9-custom' });
      assert.equal((await ok('POST', '/api/ai', { action: 'rewrite', mode: 'improve', text: '<p>א</p>' })).model, 'gemini-9-custom', 'שם מנוע שהוקלד ידנית');
      assert.equal(vseen.at(-1), 'gemini-9-custom');
      await ok('PUT', '/api/settings', { clearAiKey: true, aiKey: '', aiModel: '' });
      const good = await ok('POST', '/api/ai/test', { key: 'good-key' });
      assert.deepEqual([good.ok, good.auto, good.used, good.models.map((m) => m.id)], [true, 'gemini-3.8-flash', 'gemini-3.8-flash', ['gemini-3.8-flash', 'gemini-2.5-flash', 'gemma-3-27b-it']]);
      await ok('PUT', '/api/settings', { aiKey: ' good-key\u200e ', aiModel: '' });
      assert.equal(app.db.setting('aiKey'), 'good-key', 'המפתח נשמר נקי');
      const st7 = await ok('GET', '/api/settings');
      assert.deepEqual([st7.aiKey, st7.hasAiKey], ['', true], 'המפתח לא נחשף');
      assert.equal((await ok('GET', '/api/meta')).ai, true);
      const rw = await ok('POST', '/api/ai', { action: 'rewrite', mode: 'shorten', text: '<p>טקסט ארוך</p>' });
      assert.deepEqual([rw.html, rw.model], ['<p>טקסט <b>משופר</b></p>', 'gemini-3.8-flash']);
      assert.ok(seen.at(-1).body.systemInstruction.parts[0].text.includes('עברית') && /קצר את הטקסט/.test(seen.at(-1).body.contents[0].parts[0].text));
      failModel = 'gemini-3.8-flash';
      assert.equal((await ok('POST', '/api/ai', { action: 'write', prompt: 'כתוב ברכה' })).model, 'gemini-2.5-flash', 'כשנגמרת המכסה עוברים למנוע הבא');
      failModel = '';
      assert.deepEqual((await ok('POST', '/api/ai', { action: 'subjects', context: 'תוכן הגליון' })).subjects, [{ subject: 'נושא מוצע', preheader: 'תקציר מוצע' }]);
      const dr = await ok('POST', '/api/ai', { action: 'draft', prompt: 'גליון חנוכה' });
      assert.deepEqual(dr.blocks.map((b) => b.type), ['heading', 'text', 'button']);
      assert.deepEqual([dr.blocks[1].html, dr.blocks[2].href, dr.subject], ['<p>שלום</p>', 'https://', 'גליון חנוכה']);
      await ok('PUT', '/api/settings', { aiModel: 'gemma-3-27b-it' });
      await ok('POST', '/api/ai', { action: 'chat', prompt: 'מה דעתך?' });
      assert.ok(seen.at(-1).model === 'gemma-3-27b-it' && !seen.at(-1).body.systemInstruction && seen.at(-1).body.contents[0].parts[0].text.includes('עוזר כתיבה'), 'ל-Gemma ההנחיה בתוך ההודעה');
      cookie = '';
      await ok('POST', '/api/login', { username: 'editor', password: 'editor-pass-123' });
      assert.equal((await call('POST', '/api/ai', { action: 'chat', prompt: 'x' })).status, 403, 'בלי הרשאת עריכה אין עוזר');
      assert.equal((await call('POST', '/api/ai/test', { key: 'good-key' })).status, 403);
      cookie = adminCookie;
      await ok('PUT', '/api/settings', { clearAiKey: true, aiKey: '', aiModel: '' });
      assert.equal((await ok('GET', '/api/meta')).ai, false);
    } finally { delete process.env.GEMINI_BASE; delete process.env.VERTEX_BASE; fake.close(); fakeVertex.close(); }
  }
  step('עוזר AI: זיהוי מנועים, בדיקת מפתח, מעבר למנוע חלופי, ניקוי פלט והרשאות');

  // --- גרסה 0.7.1: דף מדיניות פרטיות ---
  cookie = '';
  const priv = await ok('GET', '/privacy');
  assert.ok(priv.includes('מדיניות פרטיות') && priv.includes('כניסת צוות עם חשבון Google') && priv.includes('כתובת המייל בלבד'));
  cookie = adminCookie;
  await ok('PUT', '/api/settings', { privacyText: 'פתיחה <b>\n\nכותרת\nגוף הפסקה' });
  const priv2 = await ok('GET', '/privacy');
  assert.ok(priv2.includes('<p>פתיחה &lt;b&gt;</p>') && priv2.includes('>כותרת</h2>') && !priv2.includes('כניסת צוות'));
  await ok('PUT', '/api/settings', { privacyText: '' });
  step('דף מדיניות פרטיות ציבורי, עם נוסח מובנה ואפשרות עריכה');

  // --- גרסה 0.7.2: אייקון ---
  cookie = '';
  for (const [f, type] of [['/favicon.svg', 'image/svg+xml'], ['/favicon.png', 'image/png'], ['/apple-touch-icon.png', 'image/png'], ['/icon-192.png', 'image/png'], ['/favicon.ico', 'image/png']]) {
    const r = await fetch(base + f);
    assert.equal(r.status, 200, f);
    assert.ok(String(r.headers.get('content-type')).startsWith(type), f);
  }
  assert.ok((await ok('GET', '/')).includes('rel="icon"') && (await ok('GET', '/privacy')).includes('rel="icon"'));
  cookie = adminCookie;
  step('אייקון לאתר: לשונית, סימניות ומסך הבית');

  // --- גרסה 0.7.6: כפתור ששולח מייל ---
  {
    const { prepareCampaign } = await import('../src/track.js');
    const cm = (await ok('POST', '/api/campaigns', {})).id;
    const dm = defaultDesign();
    const mailHref = 'mailto:office@nekuda.org.il?subject=' + encodeURIComponent('הרשמה & שאלה') + '&body=' + encodeURIComponent('שלום,') + '%0D%0A' + encodeURIComponent('אני מעוניין');
    dm.blocks = [{ type: 'button', text: 'כתבו לנו', action: 'mail', mailTo: 'office@nekuda.org.il', mailSubject: 'הרשמה & שאלה', href: mailHref },
      { type: 'button', text: 'וואטסאפ', action: 'wa', href: 'https://wa.me/972501234567?text=' + encodeURIComponent('שלום') }];
    await ok('PUT', `/api/campaigns/${cm}`, { subject: 'כפתור מייל', preheader: '', fromName: 'נ', fromEmail: 'office@nekuda.test', replyTo: '', mode: 'blocks', design: dm, listIds: [] });
    prepareCampaign(app.db, app.db.get('SELECT * FROM campaigns WHERE id=?', cm));
    const prepared = app.db.get('SELECT prepared_html, prepared_text FROM campaigns WHERE id=?', cm);
    const got = (prepared.prepared_html.match(/href="(mailto:[^"]+)"/) || [])[1].replace(/&amp;/g, '&');
    assert.equal(got, mailHref, 'קישור המייל נשאר שלם ולא עובר דרך מעקב הלחיצות');
    const parsed = new URL(got);
    assert.deepEqual([parsed.pathname, parsed.searchParams.get('subject'), parsed.searchParams.get('body')], ['office@nekuda.org.il', 'הרשמה & שאלה', 'שלום,\r\nאני מעוניין']);
    assert.ok(!prepared.prepared_html.includes('href="https://wa.me') && /\/c\/\{\{TOKEN\}\}\/\d+/.test(prepared.prepared_html), 'קישור וואטסאפ נספר כלחיצה');
    assert.equal(Number(app.db.get('SELECT COUNT(*) n FROM links WHERE campaign_id=?', cm).n), 1);
  }
  step('כפתור ששולח מייל: טיוטה עם כתובת, נושא וגוף, בלי לשבור את הקישור');

  // --- גרסה 0.8.0: הפסקות שליחה, PDF לנמענים, מחיקה מוגנת, גיבויים ועריכת ארכיון ---
  {
    const { pauseInfo, cleanRanges } = await import('../src/pause.js');
    const at = (iso) => Date.parse(iso); // 2026-11-20 הוא יום שישי. בנובמבר ישראל ב-UTC+2
    const sh = { pauseShabbat: '1', pauseRanges: '[]' };
    assert.equal(pauseInfo(sh, at('2026-11-20T09:59:00Z')).paused, false, 'שישי 11:59');
    assert.equal(pauseInfo(sh, at('2026-11-20T10:00:00Z')).paused, true, 'שישי 12:00');
    assert.equal(pauseInfo(sh, at('2026-11-21T21:59:00Z')).paused, true, 'שבת 23:59');
    assert.equal(pauseInfo(sh, at('2026-11-21T22:00:00Z')).paused, false, 'מוצאי שבת בחצות');
    assert.equal(pauseInfo({ pauseShabbat: '0', pauseRanges: '[]' }, at('2026-11-21T10:00:00Z')).paused, false);
    assert.equal(pauseInfo(sh, at('2026-07-10T08:59:00Z')).paused, false, 'בקיץ (UTC+3) שישי 11:59');
    assert.equal(pauseInfo(sh, at('2026-07-10T09:00:00Z')).paused, true, 'בקיץ שישי 12:00');
    const rg = { pauseShabbat: '0', pauseRanges: JSON.stringify([{ from: '2026-12-01T08:00', to: '2026-12-03T20:00', note: 'חג' }]) };
    assert.equal(pauseInfo(rg, at('2026-12-01T05:59:00Z')).paused, false);
    assert.match(pauseInfo(rg, at('2026-12-02T10:00:00Z')).reason, /חג.*03\/12\/2026 בשעה 20:00/);
    assert.equal(pauseInfo(rg, at('2026-12-03T18:00:00Z')).paused, false, 'בסוף הטווח השליחה מתחדשת');
    assert.deepEqual(cleanRanges([{ from: '2026-12-05T10:00', to: '2026-12-01T10:00' }, { from: 'x', to: 'y' }, { from: '2026-12-01T10:00', to: '2026-12-02T10:00', note: 'א' }]), [{ from: '2026-12-01T10:00', to: '2026-12-02T10:00', note: 'א' }]);

    // השהיה בפועל: הגליון נשאר בתור ולא יוצאות הודעות, ואחרי ההפסקה השליחה ממשיכה
    const Lp = (await ok('POST', '/api/lists', { name: 'רשימת הפסקה' })).id;
    await ok('POST', '/api/import', { text: 'p1@pause.org\np2@pause.org', listIds: [Lp], status: 'active' });
    const cp = (await ok('POST', '/api/campaigns', {})).id;
    const dp = defaultDesign();
    dp.blocks = [{ type: 'text', html: '<p>גליון עם PDF</p>' }, { type: 'button', text: 'הורד כ-PDF', action: 'pdf', href: '{{BASE}}/pdf/{{TOKEN}}' }];
    await ok('PUT', `/api/campaigns/${cp}`, { subject: 'גליון בהפסקה', preheader: '', fromName: 'נ', fromEmail: 'office@nekuda.test', replyTo: '', mode: 'blocks', design: dp, listIds: [Lp] });
    await ok('PUT', '/api/settings', { pauseShabbat: '1', pauseRanges: [{ from: '2026-12-01T08:00', to: '2026-12-03T20:00', note: 'חג' }, { from: 'bad', to: 'bad' }], archiveEnabled: '0' });
    assert.equal(JSON.parse((await ok('GET', '/api/settings')).pauseRanges).length, 1);
    await ok('POST', `/api/campaigns/${cp}/send`, { public: true });
    assert.equal(app.db.setting('archiveEnabled'), '1', 'סימון לארכיון מפעיל את הארכיון');
    const fromP = received.length;
    app.worker.clock = () => at('2026-11-21T08:00:00Z');
    assert.equal(await app.worker.tick(), 0);
    assert.equal(received.length, fromP, 'בשבת לא נשלח כלום');
    assert.match(app.worker.state.paused, /שבת/);
    assert.equal(app.db.get('SELECT status FROM campaigns WHERE id=?', cp).status, 'sending');
    app.worker.clock = () => at('2026-11-22T08:00:00Z');
    await app.worker.tick();
    assert.equal(received.length, fromP + 2, 'אחרי ההפסקה השליחה ממשיכה');
    assert.equal(app.worker.state.paused, '');
    await app.worker.tick();
    assert.equal(app.db.get('SELECT status FROM campaigns WHERE id=?', cp).status, 'sent');
    app.worker.clock = null;
    await ok('PUT', '/api/settings', { pauseShabbat: '0', pauseRanges: [] });

    // כפתור PDF בתוך הגליון
    const [, hp] = decodeParts(received.at(-1).data);
    const pdfLink = hp.match(/href="[^"]*(\/pdf\/[\w.-]+)"/)[1];
    const pr = await fetch(base + pdfLink);
    if (meta3.pdf) {
      assert.equal(pr.status, 200);
      assert.equal(Buffer.from(await pr.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
      assert.equal(fs.readdirSync(path.join(dataDir, 'pdf-cache')).filter((f) => f.startsWith(`${cp}-`)).length, 1, 'ה-PDF נשמר לשימוש חוזר');
    } else assert.equal(pr.status, 503);
    assert.equal((await fetch(base + '/pdf/1.1.forged')).status, 400);

    // ארכיון: הורדה כ-PDF, עריכת גליון שנשלח, והסרה
    const arch = await ok('GET', '/archive');
    assert.ok(arch.includes(`/archive/${cp}/pdf`) && arch.includes('גליון בהפסקה'));
    assert.equal((await fetch(`${base}/archive/${cp}/pdf`)).status, meta3.pdf ? 200 : 503);
    const preparedBefore = app.db.get('SELECT prepared_html FROM campaigns WHERE id=?', cp).prepared_html;
    dp.blocks[0].html = '<p>נוסח מתוקן לארכיון</p>';
    const ed = await ok('PUT', `/api/campaigns/${cp}`, { subject: 'גליון מתוקן', preheader: '', mode: 'blocks', design: dp, fromEmail: 'hacker@evil.test', listIds: [] });
    assert.equal(ed.archive, true);
    const after = app.db.get('SELECT prepared_html, subject, from_email, status FROM campaigns WHERE id=?', cp);
    assert.deepEqual([after.prepared_html === preparedBefore, after.subject, after.from_email, after.status], [true, 'גליון מתוקן', 'office@nekuda.test', 'sent'], 'מה שנשלח לא משתנה');
    const archOne2 = await ok('GET', `/archive/${cp}`);
    assert.ok(archOne2.includes('נוסח מתוקן לארכיון') && !archOne2.includes('{{') && !archOne2.includes('גליון עם PDF'));
    assert.ok((await ok('GET', `/v/${pdfLink.split('/').pop()}`)).includes('גליון עם PDF'), 'הקישור "צפייה בדפדפן" של הנמען מציג את מה שנשלח');
    await ok('POST', `/api/campaigns/${cp}/public`, { public: false });
    assert.equal((await call('GET', `/archive/${cp}`)).status, 404);

    // מחיקה: רק מנהל, ורק עם משפט האישור
    assert.equal((await call('DELETE', `/api/campaigns/${cp}`, undefined, { noConfirm: true })).status, 400, 'בלי משפט האישור');
    assert.equal((await call('DELETE', `/api/campaigns/${cp}`, undefined, { noConfirm: true, headers: { 'X-Confirm-Delete': encodeURIComponent('כן') } })).status, 400);
    assert.equal((await call('POST', '/api/subscribers/bulk', { filter: { list: Lp }, action: 'delete' })).status, 400);
    const someSub = app.db.get("SELECT id FROM subscribers WHERE email='p1@pause.org'").id;
    assert.equal((await call('DELETE', `/api/subscribers/${someSub}`, undefined, { noConfirm: true })).status, 400);
    await ok('PUT', `/api/users/${editorId}`, { username: 'editor', email: 'editor@gmail.com', role: 'user', active: true, perms: ['campaigns.view', 'campaigns.edit', 'subscribers.view', 'subscribers.edit', 'lists.view', 'lists.edit', 'users.manage', 'settings.manage'] });
    cookie = '';
    await ok('POST', '/api/login', { username: 'editor', password: 'editor-pass-123' });
    for (const u of [`/api/campaigns/${cp}`, `/api/subscribers/${someSub}`, `/api/lists/${Lp}`, `/api/users/${meId}`]) assert.equal((await call('DELETE', u)).status, 403, `${u}: מי שאינו מנהל לא מוחק גם עם כל ההרשאות`);
    assert.equal((await call('POST', '/api/subscribers/bulk', { filter: { list: Lp }, action: 'delete', confirm: 'מאושר למחיקה' })).status, 403);
    assert.equal((await call('GET', '/api/backups')).status, 403, 'גיבויים למנהל בלבד');
    cookie = adminCookie;
    await ok('DELETE', `/api/subscribers/${someSub}`);
    await ok('DELETE', `/api/campaigns/${cp}`);

    // גיבוי
    const bk = await ok('POST', '/api/backups', {});
    assert.match(bk.name, /^backup-\d{4}-\d{2}-\d{2}_\d{4}\.tar\.gz$/);
    assert.ok(bk.size > 1000 && (await ok('GET', '/api/backups'))[0].name === bk.name);
    const dl = await fetch(`${base}/api/backups/${bk.name}`, { headers: { Cookie: cookie } });
    const buf = Buffer.from(await dl.arrayBuffer());
    assert.ok(dl.status === 200 && buf[0] === 0x1f && buf[1] === 0x8b, 'קובץ gzip');
    const { spawnSync } = await import('node:child_process');
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-restore-'));
    fs.writeFileSync(path.join(out, 'b.tar.gz'), buf);
    assert.equal(spawnSync('tar', ['-xzf', path.join(out, 'b.tar.gz'), '-C', out]).status, 0);
    const { DatabaseSync } = await import('node:sqlite');
    const copy = new DatabaseSync(path.join(out, 'mailer.db'));
    assert.equal(Number(copy.prepare('SELECT COUNT(*) n FROM subscribers').get().n), Number(app.db.get('SELECT COUNT(*) n FROM subscribers').n), 'הגיבוי נפתח ומכיל את הנמענים');
    copy.close();
    assert.ok(fs.existsSync(path.join(out, 'uploads')) || !fs.existsSync(path.join(dataDir, 'uploads')));
    fs.rmSync(out, { recursive: true, force: true });
    assert.equal((await call('GET', '/api/backups/..%2Fmailer.db')).status, 404);
  }
  step('הפסקות שליחה, PDF לנמענים ובארכיון, עריכת גליון שנשלח, מחיקה מוגנת וגיבוי שנפתח');

  console.log(`\nכל ${passed} קבוצות הבדיקה עברו.`);
} finally {
  smtp.close();
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

function GIF_BYTES() { return Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'); }
