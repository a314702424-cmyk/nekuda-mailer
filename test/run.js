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
    headers: { 'X-Requested-With': 'nm', ...(body !== undefined && !extra.rawBody ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(extra.headers || {}) },
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
  assert.equal((await ok('GET', '/api/meta')).user, 'admin');
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

  console.log(`\nכל ${passed} קבוצות הבדיקה עברו.`);
} finally {
  smtp.close();
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

function GIF_BYTES() { return Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'); }
