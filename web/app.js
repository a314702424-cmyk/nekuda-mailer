import { defaultDesign } from './shared/render.js';
import { mountBuilder, h } from './builder.js';
import { PERM_GROUPS } from './shared/perms.js';

const app = document.getElementById('app');
const state = { meta: null, lists: [] };

const SUB_STATUS = { active: ['פעיל', 'good'], unsubscribed: ['הוסר', 'warn'], bounced: ['קפיצה', 'bad'], blocked: ['חסום', 'bad'] };
const CAMP_STATUS = { draft: ['טיוטה', ''], scheduled: ['מתוזמן', 'warn'], sending: ['בשליחה', 'warn'], paused: ['מושהה', 'bad'], sent: ['נשלח', 'good'] };
const fmt = (n) => Number(n || 0).toLocaleString('he-IL');
const date = (ts) => (ts ? new Date(ts * 1000).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '');
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : '—');
const can = (perm) => !!state.meta?.user?.perms?.includes(perm);
const tag = (map, key) => h('span', { class: 'tag ' + (map[key]?.[1] || '') }, map[key]?.[0] || key);

export function toast(msg, bad = false) {
  const el = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), bad ? 7000 : 3500);
}

async function api(method, url, body, opts = {}) {
  const headers = { 'X-Requested-With': 'nm', ...(opts.headers || {}) };
  if (body !== undefined && !opts.raw) headers['Content-Type'] = 'application/json';
  const res = await fetch('/api' + url, { method, headers, body: body === undefined ? undefined : (opts.raw ? body : JSON.stringify(body)) });
  if (res.status === 401 && state.meta?.user) { state.meta.user = null; route(); throw new Error('נדרשת התחברות מחדש'); }
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || 'הפעולה נכשלה');
  return data;
}
/** מריץ פעולה ומציג שגיאה כהודעה במקום לקרוס. */
const safe = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message, true); return undefined; } };

const field = (label, control) => h('div', {}, h('label', {}, label), control);
const text = (value = '', attrs = {}) => h('input', { type: 'text', value, ...attrs });

function listChecks(selected = []) {
  const box = h('div', { class: 'checks' }, state.lists.map((l) => h('label', {},
    h('input', { type: 'checkbox', value: l.id, checked: selected.includes(l.id) }), `${l.name} (${fmt(l.active)})`)));
  if (!state.lists.length) box.append(h('span', { class: 'muted' }, 'עדיין אין רשימות תפוצה.'));
  box.values = () => [...box.querySelectorAll('input:checked')].map((i) => Number(i.value));
  return box;
}
const loadLists = async () => { state.lists = await api('GET', '/lists'); };

function dialog(title, body, actions) {
  const d = h('dialog', {}, h('h2', {}, title), body, h('div', { class: 'row end', style: 'margin-top:16px' }, actions(() => d.close())));
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
  return d;
}

// ---------- מסגרת וניווט ----------
const NAV = [['#/', 'לוח בקרה', null], ['#/campaigns', 'גליונות', 'campaigns.view'], ['#/queue', 'תור שליחה', 'campaigns.view'], ['#/subscribers', 'נמענים', 'subscribers.view'],
  ['#/lists', 'רשימות תפוצה', 'lists.view'], ['#/import', 'ייבוא', 'subscribers.import'], ['#/settings', 'הגדרות', 'settings.manage'], ['#/users', 'משתמשים', 'users.manage']];

function shell(content) {
  const here = location.hash || '#/';
  const on = (href) => (href === '#/' ? here === '#/' : here.startsWith(href) || (href === '#/campaigns' && /^#\/(campaign|stats)\//.test(here)));
  app.replaceChildren(h('div', { class: 'shell' },
    h('nav', { class: 'nav' }, h('div', { class: 'brand' }, 'מערכת הדיוור'),
      NAV.filter(([, , perm]) => !perm || can(perm)).map(([href, label]) => h('a', { href, class: on(href) ? 'on' : '' }, label)),
      h('div', { class: 'foot' }, `${state.meta.user.name} · גרסה ${state.meta.version}`, h('br'),
        h('button', { onclick: safe(async () => { await api('POST', '/logout', {}); state.meta.user = null; route(); }) }, 'התנתקות'))),
    h('main', { class: 'main' }, content)));
}

function authPage() {
  const setup = state.meta.needsSetup;
  const user = text('', { autocomplete: 'username' });
  const pass = h('input', { type: 'password', autocomplete: setup ? 'new-password' : 'current-password' });
  const form = h('form', { class: 'card', onsubmit: safe(async (e) => {
    e.preventDefault();
    await api('POST', setup ? '/setup' : '/login', { username: user.value, password: pass.value });
    state.meta = await api('GET', '/meta');
    route();
  }) },
  h('h1', {}, setup ? 'הקמת המערכת' : 'כניסה למערכת הדיוור'),
  setup ? h('p', { class: 'muted' }, 'זו ההפעלה הראשונה. בחר שם משתמש וסיסמה למנהל (10 תווים לפחות).') : null,
  field('שם משתמש', user), field('סיסמה', pass),
  h('div', { style: 'margin-top:16px' }, h('button', { class: 'primary', type: 'submit' }, setup ? 'יצירת מנהל' : 'כניסה')),
  !setup && state.meta.google ? h('a', { class: 'btn google-btn', href: '/auth/google' }, 'כניסה עם חשבון Google') : null);
  app.replaceChildren(h('div', { class: 'auth' }, form));
}

// ---------- לוח בקרה ----------
function campaignTable(rows) {
  if (!rows.length) return h('p', { class: 'muted' }, 'עדיין אין גליונות.');
  return h('div', { class: 'scroll' }, h('table', { class: 'data' },
    h('tr', {}, ['נושא', 'מצב', 'נשלחו', 'פתיחות', 'קליקים', 'תאריך', ''].map((t) => h('th', {}, t))),
    rows.map((c) => {
      const editable = ['draft', 'scheduled', 'paused'].includes(c.status);
      return h('tr', {},
        h('td', {}, h('a', { href: editable && can('campaigns.edit') ? `#/campaign/${c.id}` : `#/stats/${c.id}` }, c.subject || '(ללא נושא)')),
        h('td', {}, tag(CAMP_STATUS, c.status)),
        h('td', { class: 'num' }, `${fmt(c.stats.sent)} / ${fmt(c.stats.total)}`),
        h('td', { class: 'num' }, pct(c.stats.opened, c.stats.sent)),
        h('td', { class: 'num' }, pct(c.stats.clicked, c.stats.sent)),
        h('td', { class: 'num' }, date(c.startedAt || c.scheduledAt || c.updatedAt)),
        h('td', {}, h('div', { class: 'row' },
          h('a', { class: 'btn small', href: `#/stats/${c.id}` }, 'נתונים'),
          can('campaigns.edit') ? h('button', { class: 'small', onclick: safe(async () => { const r = await api('POST', `/campaigns/${c.id}/duplicate`, {}); location.hash = `#/campaign/${r.id}`; }) }, 'שכפול') : null,
          !can('campaigns.delete') ? null : h('button', { class: 'small danger', onclick: safe(async () => {
            if (!window.confirm(`למחוק את הגליון "${c.subject}"? הנתונים הסטטיסטיים שלו יימחקו.`)) return;
            await api('DELETE', `/campaigns/${c.id}`); route();
          }) }, 'מחיקה'))));
    })));
}

async function dashboardPage() {
  const d = await api('GET', '/dashboard');
  const stat = (n, label) => h('div', { class: 'stat' }, h('b', {}, n), h('span', {}, label));
  shell([
    h('h1', {}, 'לוח בקרה'),
    d.worker?.lastError ? h('div', { class: 'notice bad' }, 'בעיה בשליחה: ' + d.worker.lastError) : null,
    h('div', { class: 'cards' },
      stat(fmt(d.subscribers.active), 'נמענים פעילים'),
      stat(fmt((d.subscribers.unsubscribed || 0) + (d.subscribers.bounced || 0) + (d.subscribers.blocked || 0)), 'הוסרו או נחסמו'),
      stat(fmt(d.lists), 'רשימות תפוצה'),
      stat(d.dailyLimit ? `${fmt(d.sentToday)} / ${fmt(d.dailyLimit)}` : fmt(d.sentToday), 'נשלחו היום'),
      stat(fmt(d.queue), 'ממתינים בתור')),
    h('div', { class: 'bar' }, h('h2', { style: 'flex:1;margin:0' }, 'גליונות אחרונים'), h('a', { class: 'btn', href: '#/campaigns' }, 'לכל הגליונות')),
    campaignTable(d.recent),
  ]);
}

// ---------- גליונות ----------
async function campaignsPage() {
  const rows = await api('GET', '/campaigns');
  const create = (mode, template) => safe(async () => { const r = await api('POST', '/campaigns', { mode, template }); location.hash = `#/campaign/${r.id}`; });
  shell([
    h('div', { class: 'bar' }, h('h1', {}, 'גליונות'),
      can('campaigns.edit') ? [h('button', { onclick: create('html') }, 'גליון מ-HTML מוכן'), h('button', { title: 'טקסט פשוט בלי עיצוב כבד', onclick: create('blocks', 'letter') }, 'מכתב אישי'),
        h('button', { title: 'כותרת, דבר המערכת, מדורים וקריאה לפעולה', onclick: create('blocks', 'newsletter') }, 'תבנית גליון מלא'),
        h('button', { class: 'primary', onclick: create('blocks') }, 'גליון חדש')] : null),
    campaignTable(rows),
  ]);
}

function issueList(result) {
  const order = { error: 0, warn: 1, info: 2 };
  const items = [...result.issues].sort((x, y) => order[x.level] - order[y.level]);
  const kb = Math.round(result.stats.bytes / 1024);
  return h('div', {},
    h('p', { class: 'muted' }, `משקל: ${kb}KB · קישורים: ${result.stats.links} · תמונות: ${result.stats.images}`),
    items.length ? h('ul', { class: 'issues' }, items.map((i) => h('li', { class: i.level }, (i.level === 'error' ? 'לתקן: ' : i.level === 'warn' ? 'לשים לב: ' : '') + i.text)))
      : h('ul', { class: 'issues' }, h('li', { class: 'ok' }, 'לא נמצאו בעיות.')));
}

async function campaignPage(id) {
  const [c] = await Promise.all([api('GET', `/campaigns/${id}`), loadLists()]);
  if (!['draft', 'scheduled', 'paused'].includes(c.status)) { location.hash = `#/stats/${id}`; return; }
  const design = c.design || defaultDesign();
  const subject = text(c.subject);
  const preheader = text(c.preheader, { placeholder: 'השורה שמופיעה אחרי הנושא בתיבת הדואר' });
  const fromName = text(c.fromName);
  const fromEmail = h('input', { type: 'email', value: c.fromEmail, class: 'ltr' });
  const replyTo = h('input', { type: 'email', value: c.replyTo, class: 'ltr' });
  const utm = text(design.settings.utm || '', { class: 'ltr', placeholder: 'למשל issue-80. ריק = בלי UTM' });
  const lists = listChecks(c.listIds);
  const htmlArea = h('textarea', { class: 'code', value: c.html, placeholder: 'הדבק כאן את ה-HTML המלא של הגליון' });
  const saveState = h('span', { class: 'savestate' });
  let mode = c.mode;
  let builder = null;
  let dirty = false;
  let saving = false;
  const body = h('div');
  const here = location.hash;
  const touch = () => { dirty = true; saveState.textContent = 'יש שינויים שלא נשמרו'; };

  const payload = () => {
    design.settings.utm = utm.value.trim();
    return { subject: subject.value, preheader: preheader.value, fromName: fromName.value, fromEmail: fromEmail.value,
      replyTo: replyTo.value, listIds: lists.values(), mode, design, html: htmlArea.value };
  };
  const save = async (quiet, snapshot = false) => {
    if (saving) return;
    saving = true;
    try {
      await api('PUT', `/campaigns/${id}`, { ...payload(), snapshot });
      dirty = false;
      saveState.textContent = `נשמר ב-${new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`;
      if (!quiet) toast('הגליון נשמר');
    } finally { saving = false; }
  };
  // שמירה אוטומטית כל 20 שניות, כל עוד נמצאים במסך הזה
  const auto = setInterval(() => {
    if (location.hash !== here || !document.body.contains(body)) { clearInterval(auto); return; }
    if (dirty && !saving) save(true).catch(() => { saveState.textContent = 'השמירה האוטומטית נכשלה'; });
  }, 20000);

  const upload = safe(async (file) => (await api('POST', '/upload', file, { raw: true, headers: { 'X-Filename': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' } })).url);
  const store = {
    list: () => api('GET', '/blocks'),
    save: safe((name, block, synced) => api('POST', '/blocks', { name, block, synced })),
    update: safe((bid, block) => api('PUT', `/blocks/${bid}`, { block })),
    remove: safe((bid) => api('DELETE', `/blocks/${bid}`)),
  };

  async function drawBody() {
    if (mode === 'blocks') {
      builder = await mountBuilder(body, design, {
        upload, blocks: store, notify: toast, onChange: touch,
        meta: () => ({ subject: subject.value, preheader: preheader.value }),
        saveBrand: safe((settings) => api('PUT', '/brand', settings)),
      });
    } else {
      const frame = h('iframe', { title: 'תצוגה מקדימה', sandbox: '' });
      const wrap = h('div', { class: 'preview-frame' }, frame);
      const show = () => { frame.srcdoc = htmlArea.value.replace(/\{\{(name|first_name)\}\}/g, 'ישראל ישראלי').replace(/\{\{\w+\}\}/g, '#'); };
      htmlArea.oninput = () => { touch(); clearTimeout(show.t); show.t = setTimeout(show, 300); };
      body.replaceChildren(h('div', { class: 'builder' },
        h('div', {}, h('p', { class: 'muted' }, 'תגים זמינים: {{name}}, {{first_name}}, {{email}}, {{unsubscribe_url}}, {{webview_url}}. אם אין קישור הסרה, המערכת מוסיפה אחד אוטומטית.'), htmlArea),
        h('div', { class: 'preview-wrap' }, h('div', { class: 'row', style: 'margin-bottom:8px' }, h('b', { class: 'grow' }, 'תצוגה מקדימה'),
          h('button', { class: 'small', onclick: () => wrap.classList.remove('mobile') }, 'מחשב'), h('button', { class: 'small', onclick: () => wrap.classList.add('mobile') }, 'נייד'),
          h('button', { class: 'small', onclick: () => wrap.classList.toggle('dark') }, 'מצב כהה')), wrap)));
      show();
    }
  }
  [subject, preheader].forEach((el) => el.addEventListener('input', () => { touch(); builder?.refresh(); }));
  [fromName, fromEmail, replyTo, utm].forEach((el) => el.addEventListener('input', touch));

  const sendTest = safe(async () => {
    const emails = text('', { class: 'ltr', placeholder: 'name@example.com' });
    dialog('שליחת בדיקה', field('כתובות לבדיקה (עד חמש, מופרדות בפסיק)', emails), (close) => [
      h('button', { onclick: close }, 'ביטול'),
      h('button', { class: 'primary', onclick: safe(async () => {
        await save(true);
        const r = await api('POST', `/campaigns/${id}/test`, { emails: emails.value });
        const failed = r.results.filter((x) => !x.ok);
        toast(failed.length ? `נכשל: ${failed.map((x) => `${x.email} (${x.error})`).join(', ')}` : 'הבדיקה נשלחה', !!failed.length);
        close();
      }) }, 'שלח בדיקה')]);
  });

  const fullPreview = safe(async () => {
    await save(true);
    const as = text('', { class: 'ltr', placeholder: 'ריק = נמען לדוגמה' });
    dialog('תצוגה מלאה', field('להציג כפי שיראה נמען מסוים (כתובת מייל מהרשימה)', as), (close) => [
      h('button', { onclick: close }, 'ביטול'),
      h('button', { class: 'primary', onclick: () => { window.open(`/api/campaigns/${id}/preview${as.value.trim() ? '?as=' + encodeURIComponent(as.value.trim()) : ''}`, '_blank'); close(); } }, 'פתח בלשונית חדשה')]);
  });

  const downloadPdf = safe(async () => {
    await save(true);
    if (state.meta.pdf) { window.location = `/api/campaigns/${id}/pdf`; return; }
    toast('בשרת לא מותקן Chrome. נפתחת תצוגה מלאה, ומשם אפשר להדפיס ולבחור "שמירה כ-PDF".');
    window.open(`/api/campaigns/${id}/preview`, '_blank');
  });

  const runCheck = safe(async () => {
    await save(true);
    const box = h('div', {}, h('p', { class: 'muted' }, 'בודק, כולל פתיחה של כל קישור…'));
    dialog('בדיקה לפני שליחה', box, (close) => [h('button', { class: 'primary', onclick: close }, 'סגירה')]);
    const r = await api('POST', `/campaigns/${id}/check`, { links: true });
    box.replaceChildren(issueList(r));
  });

  const versions = safe(async () => {
    const rows = await api('GET', `/campaigns/${id}/versions`);
    dialog('גרסאות קודמות', rows.length ? h('table', { class: 'data' }, rows.map((v) => h('tr', {},
      h('td', { class: 'num' }, date(v.savedAt)), h('td', {}, v.subject || '(ללא נושא)'),
      h('td', {}, h('button', { class: 'small', onclick: safe(async () => {
        if (!window.confirm('לשחזר את הגרסה הזו? התוכן הנוכחי יוחלף (הוא נשמר כגרסה לפני כן).')) return;
        await save(true, true);
        await api('POST', `/campaigns/${id}/versions/${v.id}/restore`, {});
        document.querySelector('dialog')?.close();
        clearInterval(auto);
        route();
      }) }, 'שחזור'))))) : h('p', { class: 'muted' }, 'עדיין אין גרסאות שמורות. גרסה נשמרת בכל לחיצה על "שמירה", ובשמירה אוטומטית אחת לעשר דקות.'),
    (close) => [h('button', { onclick: close }, 'סגירה')]);
  });

  const sendDialog = safe(async () => {
    await save(true, true);
    const [rc, chk] = await Promise.all([api('GET', `/campaigns/${id}/recipients`), api('POST', `/campaigns/${id}/check`, { links: true })]);
    const errors = chk.issues.filter((i) => i.level === 'error').length;
    const when = h('input', { type: 'datetime-local' });
    const force = h('input', { type: 'checkbox' });
    const go = h('button', { class: 'primary', disabled: !rc.fresh || errors > 0, onclick: safe(async () => {
      const at = when.value ? Math.floor(new Date(when.value).getTime() / 1000) : 0;
      const r = await api('POST', `/campaigns/${id}/send`, { scheduledAt: at });
      toast(r.scheduled ? `הגליון תוזמן ל-${date(r.scheduled)}` : `${fmt(r.queued)} הודעות נכנסו לתור`);
      document.querySelector('dialog')?.close();
      clearInterval(auto);
      location.hash = `#/stats/${id}`;
    }) }, 'אישור שליחה');
    force.onchange = () => { go.disabled = !rc.fresh || (errors > 0 && !force.checked); };
    dialog('שליחת הגליון', h('div', {},
      h('p', {}, `הגליון יישלח ל-${fmt(rc.fresh)} נמענים פעילים.`, rc.already ? ` (${fmt(rc.already)} כבר קיבלו או נמצאים בתור ולא יקבלו שוב.)` : ''),
      issueList(chk),
      errors ? h('label', { class: 'inline-check', style: 'margin-top:8px' }, force, 'לשלוח למרות הבעיות שסומנו "לתקן"') : null,
      field('תזמון (להשאיר ריק לשליחה מיידית)', when)), (close) => [h('button', { onclick: close }, 'ביטול'), go]);
  });

  const modeBtn = h('button', { onclick: async () => {
    if (mode === 'blocks' && !window.confirm('לעבור לעריכת HTML? העיצוב בבלוקים יישמר, אבל הגליון יישלח לפי ה-HTML.')) return;
    mode = mode === 'blocks' ? 'html' : 'blocks'; touch(); builder = null;
    modeBtn.textContent = mode === 'blocks' ? 'מעבר ל-HTML מוכן' : 'מעבר לבונה הבלוקים';
    await drawBody();
  } }, mode === 'blocks' ? 'מעבר ל-HTML מוכן' : 'מעבר לבונה הבלוקים');

  shell([
    h('div', { class: 'bar' }, h('h1', {}, 'עריכת גליון'), saveState, tag(CAMP_STATUS, c.status), modeBtn,
      h('button', { onclick: versions }, 'גרסאות'), h('button', { onclick: fullPreview }, 'תצוגה מלאה'), h('button', { onclick: downloadPdf }, 'הורד כ-PDF'), h('button', { onclick: runCheck }, 'בדיקה'),
      h('button', { onclick: sendTest }, 'שליחת בדיקה'), h('button', { onclick: safe(() => save(false, true)) }, 'שמירה'),
      c.status === 'scheduled'
        ? h('button', { class: 'danger', onclick: safe(async () => { await api('POST', `/campaigns/${id}/unschedule`, {}); route(); }) }, 'ביטול תזמון')
        : c.status === 'paused'
          ? h('button', { class: 'primary', onclick: safe(async () => { await save(true); await api('POST', `/campaigns/${id}/resume`, {}); location.hash = `#/stats/${id}`; }) }, 'המשך שליחה')
          : h('button', { class: 'primary', onclick: sendDialog }, 'שליחה…')),
    c.status === 'scheduled' ? h('div', { class: 'notice' }, `הגליון מתוזמן ל-${date(c.scheduledAt)}. שינויים שתשמור עד אז ייכנסו לשליחה.`) : null,
    h('div', { class: 'card' },
      h('div', { class: 'row' }, h('div', { class: 'grow' }, field('נושא', subject)), h('div', { class: 'grow' }, field('תקציר', preheader))),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, field('שם השולח', fromName)), h('div', { class: 'grow' }, field('כתובת השולח', fromEmail)), h('div', { class: 'grow' }, field('כתובת לתשובה', replyTo)),
        h('div', { class: 'grow' }, field('שם קמפיין ל-UTM', utm))),
      h('label', {}, 'רשימות תפוצה'), lists),
    body,
  ]);
  lists.addEventListener('change', touch);
  await drawBody();
}

async function statsPage(id) {
  const d = await api('GET', `/campaigns/${id}/stats`);
  const c = d.campaign;
  const s = c.stats;
  const stat = (n, label, sub) => h('div', { class: 'stat' }, h('b', {}, n), h('span', {}, label), sub ? h('div', { class: 'muted num' }, sub) : null);
  const act = (label, path, cls = '') => h('button', { class: cls, onclick: safe(async () => { await api('POST', `/campaigns/${id}/${path}`, {}); route(); }) }, label);
  const segment = (kind, label) => h('button', { class: 'small', onclick: safe(async () => {
    const name = window.prompt('שם הרשימה החדשה:', `${label} · ${c.subject}`.slice(0, 80));
    if (!name) return;
    const r = await api('POST', '/lists/segment', { name, campaignId: c.id, kind });
    toast(`נוצרה רשימה עם ${fmt(r.added)} נמענים`);
  }) }, `רשימה חדשה: ${label}`);
  shell([
    h('div', { class: 'bar' }, h('h1', {}, c.subject || '(ללא נושא)'), tag(CAMP_STATUS, c.status),
      c.status === 'sending' ? act('השהיית השליחה', 'pause', 'danger') : null,
      c.status === 'paused' ? act('המשך שליחה', 'resume', 'primary') : null,
      ['draft', 'scheduled', 'paused'].includes(c.status) ? h('a', { class: 'btn', href: `#/campaign/${id}` }, 'עריכה') : null,
      state.meta.pdf && can('campaigns.view') ? h('a', { class: 'btn', href: `/api/campaigns/${id}/pdf` }, 'הורד כ-PDF') : null,
      h('button', { onclick: () => route() }, 'רענון')),
    h('p', { class: 'muted' }, [c.startedAt ? `התחיל: ${date(c.startedAt)}` : '', c.finishedAt ? `הסתיים: ${date(c.finishedAt)}` : '', c.scheduledAt ? `מתוזמן ל-${date(c.scheduledAt)}` : ''].filter(Boolean).join(' · ')),
    h('div', { class: 'cards' },
      stat(fmt(s.sent), 'נשלחו', `מתוך ${fmt(s.total)}`), stat(fmt(s.pending), 'ממתינים בתור'),
      stat(fmt(s.opened), 'פתחו', pct(s.opened, s.sent)), stat(fmt(s.clicked), 'לחצו', pct(s.clicked, s.sent)),
      stat(fmt(s.unsubscribed), 'הסירו את עצמם', pct(s.unsubscribed, s.sent)), stat(fmt(s.bounced), 'קפיצות', pct(s.bounced, s.sent)),
      stat(fmt(s.failed), 'נכשלו')),
    h('div', { class: 'card' }, h('h2', {}, 'פילוח לפי תגובה'), h('div', { class: 'row' }, segment('opened', 'פתחו'), segment('not_opened', 'לא פתחו'), segment('clicked', 'לחצו'))),
    h('div', { class: 'card' }, h('h2', {}, 'קישורים'), d.links.length ? h('div', { class: 'scroll' }, h('table', { class: 'data' },
      h('tr', {}, ['קישור', 'לחיצות', 'לוחצים ייחודיים'].map((t) => h('th', {}, t))),
      d.links.map((l) => h('tr', {}, h('td', { class: 'ltr', style: 'word-break:break-all' }, l.url), h('td', { class: 'num' }, fmt(l.clicks)), h('td', { class: 'num' }, fmt(l.uniq)))))) : h('p', { class: 'muted' }, 'אין קישורים במעקב.')),
    d.errors.length ? h('div', { class: 'card' }, h('h2', {}, 'שגיאות שליחה נפוצות'), h('table', { class: 'data' },
      d.errors.map((e) => h('tr', {}, h('td', { class: 'ltr' }, e.error), h('td', { class: 'num' }, fmt(e.n)))))) : null,
    peopleCard(id),
  ]);
}

function peopleCard(id) {
  const KINDS = [['opened', 'פתחו'], ['clicked', 'לחצו'], ['not_opened', 'לא פתחו'], ['unsubscribed', 'הסירו את עצמם'], ['bounced', 'קפיצות'], ['failed', 'נכשלו'], ['pending', 'ממתינים'], ['sent', 'כל מי שקיבל']];
  let kind = 'opened';
  let page = 1;
  const tabs = h('div', { class: 'tabs' });
  const out = h('div');
  const load = safe(async () => {
    tabs.replaceChildren(...KINDS.map(([k, label]) => h('button', { class: 'small' + (k === kind ? ' on' : ''), onclick: () => { kind = k; page = 1; load(); } }, label)));
    const d = await api('GET', `/campaigns/${id}/people?kind=${kind}&page=${page}`);
    const pages = Math.max(1, Math.ceil(d.total / d.size));
    out.replaceChildren(
      h('div', { class: 'row', style: 'margin-bottom:8px' }, h('span', { class: 'muted grow' }, `${fmt(d.total)} נמענים`),
        d.total ? h('a', { class: 'btn small', href: `/api/campaigns/${id}/people.csv?kind=${kind}` }, 'ייצוא הרשימה ל-CSV') : null),
      d.rows.length ? h('div', { class: 'scroll' }, h('table', { class: 'data' },
        h('tr', {}, ['כתובת מייל', 'שם', 'נשלח', 'נפתח', 'פתיחות', 'לחיצות', 'שגיאה'].map((t) => h('th', {}, t))),
        d.rows.map((r) => h('tr', {}, h('td', { class: 'ltr' }, r.email), h('td', {}, r.name), h('td', { class: 'num' }, date(r.sent_at)), h('td', { class: 'num' }, date(r.opened_at)),
          h('td', { class: 'num' }, fmt(r.opens)), h('td', { class: 'num' }, fmt(r.clicks)), h('td', { class: 'ltr muted' }, r.error || ''))))) : h('p', { class: 'muted' }, 'אין נמענים בקבוצה הזו.'),
      pages > 1 ? h('div', { class: 'pager' }, h('button', { disabled: page <= 1, onclick: () => { page--; load(); } }, 'הקודם'), `עמוד ${page} מתוך ${fmt(pages)}`,
        h('button', { disabled: page >= pages, onclick: () => { page++; load(); } }, 'הבא')) : null);
  });
  load();
  return h('div', { class: 'card' }, h('h2', {}, 'נמענים לפי תגובה'), tabs, out);
}

// ---------- תור שליחה ----------
async function queuePage() {
  const d = await api('GET', '/queue');
  const act = (cid, path, label, cls = 'small') => (can('campaigns.send') ? h('button', { class: cls, onclick: safe(async () => { await api('POST', `/campaigns/${cid}/${path}`, {}); route(); }) }, label) : null);
  shell([
    h('div', { class: 'bar' }, h('h1', {}, 'תור שליחה'), h('button', { onclick: () => route() }, 'רענון')),
    d.worker?.lastError ? h('div', { class: 'notice bad' }, 'בעיה בשליחה: ' + d.worker.lastError) : null,
    h('div', { class: 'cards' },
      h('div', { class: 'stat' }, h('b', {}, d.dailyLimit ? `${fmt(d.sentToday)} / ${fmt(d.dailyLimit)}` : fmt(d.sentToday)), h('span', {}, 'נשלחו היום' + (d.dailyLimit ? ' מתוך התקרה היומית' : ''))),
      h('div', { class: 'stat' }, h('b', {}, `${d.sendPerSecond}`), h('span', {}, 'הודעות בשנייה')),
      h('div', { class: 'stat' }, h('b', {}, fmt(d.campaigns.reduce((n, c) => n + c.pending, 0))), h('span', {}, 'ממתינים בסך הכול'))),
    d.dailyLimit && d.sentToday >= d.dailyLimit ? h('div', { class: 'notice' }, 'התקרה היומית מולאה. השליחה תמשיך מחר, או אחרי העלאת התקרה בהגדרות.') : null,
    d.campaigns.length ? h('div', { class: 'scroll' }, h('table', { class: 'data' },
      h('tr', {}, ['גליון', 'מצב', 'נשלחו', 'ממתינים', 'בניסיון חוזר', 'הניסיון הבא', ''].map((t) => h('th', {}, t))),
      d.campaigns.map((c) => h('tr', {}, h('td', {}, h('a', { href: `#/stats/${c.id}` }, c.subject || '(ללא נושא)')), h('td', {}, tag(CAMP_STATUS, c.status)),
        h('td', { class: 'num' }, fmt(c.sent)), h('td', { class: 'num' }, fmt(c.pending)), h('td', { class: 'num' }, fmt(c.retrying)),
        h('td', { class: 'num' }, c.status === 'scheduled' ? `מתוזמן ל-${date(c.scheduled_at)}` : date(c.next_retry)),
        h('td', {}, c.status === 'sending' ? act(c.id, 'pause', 'השהיה', 'small danger') : c.status === 'paused' ? act(c.id, 'resume', 'המשך') : act(c.id, 'unschedule', 'ביטול תזמון')))))) : h('p', { class: 'muted' }, 'התור ריק. אין גליונות בשליחה או בתזמון.'),
  ]);
}

// ---------- משתמשים והרשאות ----------
async function usersPage() {
  const rows = await api('GET', '/users');
  const edit = (u) => {
    const username = text(u?.username || '');
    const email = h('input', { type: 'email', value: u?.email || '', class: 'ltr', placeholder: 'name@gmail.com' });
    const password = h('input', { type: 'password', autocomplete: 'new-password', placeholder: u?.hasPassword ? 'להשאיר ריק כדי לא לשנות' : 'לא חובה אם נכנסים עם Google' });
    const role = h('select', {}, h('option', { value: 'user', selected: u?.role !== 'admin' }, 'משתמש עם הרשאות נבחרות'), h('option', { value: 'admin', selected: u?.role === 'admin' }, 'מנהל (כל ההרשאות)'));
    const active = h('input', { type: 'checkbox', checked: u ? u.active : true });
    const boxes = h('div', {}, PERM_GROUPS.map(([group, items]) => h('div', { class: 'perm-group' }, h('b', {}, group), h('div', { class: 'checks' },
      items.map(([key, label]) => h('label', {}, h('input', { type: 'checkbox', value: key, checked: !!u?.perms.includes(key) }), label))))));
    const syncRole = () => { boxes.style.display = role.value === 'admin' ? 'none' : ''; };
    role.onchange = syncRole; syncRole();
    dialog(u ? 'עריכת משתמש' : 'משתמש חדש', h('div', {},
      h('div', { class: 'row' }, h('div', { class: 'grow' }, field('שם משתמש', username)), h('div', { class: 'grow' }, field('כתובת Google (לכניסה עם חשבון Google)', email))),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, field('סיסמה (10 תווים לפחות)', password)), h('div', { class: 'grow' }, field('סוג', role))),
      h('label', { class: 'inline-check', style: 'margin-top:10px' }, active, 'חשבון פעיל'), boxes), (close) => [
      u ? h('button', { class: 'danger', onclick: safe(async () => { if (!window.confirm(`למחוק את המשתמש "${u.username}"?`)) return; await api('DELETE', `/users/${u.id}`); close(); route(); }) }, 'מחיקה') : null,
      h('button', { onclick: close }, 'ביטול'),
      h('button', { class: 'primary', onclick: safe(async () => {
        const body = { username: username.value, email: email.value, password: password.value, role: role.value, active: active.checked,
          perms: [...boxes.querySelectorAll('input:checked')].map((i) => i.value) };
        await api(u ? 'PUT' : 'POST', u ? `/users/${u.id}` : '/users', body);
        close(); route();
      }) }, 'שמירה')]);
  };
  shell([
    h('div', { class: 'bar' }, h('h1', {}, 'משתמשים והרשאות'), h('button', { class: 'primary', onclick: () => edit(null) }, 'משתמש חדש')),
    state.meta.google ? null : h('div', { class: 'notice' }, 'כניסה עם Google עדיין לא מופעלת. כדי להפעיל אותה צריך למלא Client ID ו-Client Secret במסך ההגדרות.'),
    h('div', { class: 'scroll' }, h('table', { class: 'data' },
      h('tr', {}, ['שם משתמש', 'כתובת Google', 'סוג', 'הרשאות', 'מצב'].map((t) => h('th', {}, t))),
      rows.map((u) => h('tr', { class: 'click', onclick: () => edit(u) }, h('td', {}, h('b', {}, u.username)), h('td', { class: 'ltr' }, u.email),
        h('td', {}, u.role === 'admin' ? 'מנהל' : 'משתמש'), h('td', { class: 'num' }, u.role === 'admin' ? 'הכול' : `${u.perms.length}`),
        h('td', {}, h('span', { class: 'tag ' + (u.active ? 'good' : 'bad') }, u.active ? 'פעיל' : 'מושבת')))))),
  ]);
}

// ---------- נמענים ----------
async function subscribersPage() {
  await loadLists();
  const q = h('input', { type: 'search', placeholder: 'חיפוש לפי מייל או שם' });
  const status = h('select', {}, h('option', { value: '' }, 'כל המצבים'), Object.entries(SUB_STATUS).map(([k, v]) => h('option', { value: k }, v[0])));
  const list = h('select', {}, h('option', { value: '' }, 'כל הרשימות'), state.lists.map((l) => h('option', { value: l.id }, l.name)));
  const table = h('div');
  let page = 1;
  const names = (ids) => ids.map((i) => state.lists.find((l) => l.id === i)?.name).filter(Boolean).join(', ');

  const edit = (row) => {
    const email = h('input', { type: 'email', value: row?.email || '', class: 'ltr' });
    const name = text(row?.name || '');
    const st = h('select', {}, Object.entries(SUB_STATUS).map(([k, v]) => h('option', { value: k, selected: (row?.status || 'active') === k }, v[0])));
    const lists = listChecks(row?.lists || []);
    dialog(row ? 'עריכת נמען' : 'נמען חדש', h('div', {}, field('כתובת מייל', email), field('שם', name), field('מצב', st), h('label', {}, 'רשימות'), lists), (close) => [
      row ? h('button', { class: 'danger', onclick: safe(async () => { if (!window.confirm('למחוק את הנמען לצמיתות?')) return; await api('DELETE', `/subscribers/${row.id}`); close(); load(); }) }, 'מחיקה') : null,
      h('button', { onclick: close }, 'ביטול'),
      h('button', { class: 'primary', onclick: safe(async () => {
        await api(row ? 'PUT' : 'POST', row ? `/subscribers/${row.id}` : '/subscribers', { email: email.value, name: name.value, status: st.value, listIds: lists.values() });
        close(); load();
      }) }, 'שמירה')]);
  };

  const load = safe(async () => {
    const p = new URLSearchParams({ q: q.value, status: status.value, list: list.value, page });
    const d = await api('GET', '/subscribers?' + p);
    const pages = Math.max(1, Math.ceil(d.total / d.size));
    table.replaceChildren(
      h('p', { class: 'muted' }, `${fmt(d.total)} נמענים`),
      h('div', { class: 'scroll' }, h('table', { class: 'data' },
        h('tr', {}, ['כתובת מייל', 'שם', 'מצב', 'רשימות', 'נוסף'].map((t) => h('th', {}, t))),
        d.rows.map((r) => h('tr', { class: 'click', onclick: () => edit(r) },
          h('td', { class: 'ltr' }, r.email), h('td', {}, r.name), h('td', {}, tag(SUB_STATUS, r.status)), h('td', {}, names(r.lists)), h('td', { class: 'num' }, date(r.created_at)))))),
      h('div', { class: 'pager' },
        h('button', { disabled: page <= 1, onclick: () => { page--; load(); } }, 'הקודם'), `עמוד ${page} מתוך ${fmt(pages)}`,
        h('button', { disabled: page >= pages, onclick: () => { page++; load(); } }, 'הבא')));
  });
  const bulk = safe(async () => {
    const filter = { q: q.value, status: status.value, list: list.value };
    const filtered = !!(q.value.trim() || status.value || list.value);
    const { count } = await api('POST', '/subscribers/bulk', { filter, all: true, dryRun: true });
    const action = h('select', {}, [['addToList', 'הוספה לרשימה'], ['removeFromList', 'הסרה מרשימה'], ['setStatus', 'שינוי מצב'], ...(can('subscribers.delete') ? [['delete', 'מחיקה לצמיתות']] : [])].map(([v, tx]) => h('option', { value: v }, tx)));
    const target = h('select', {}, state.lists.map((l) => h('option', { value: l.id }, l.name)));
    const st = h('select', {}, Object.entries(SUB_STATUS).map(([k, v]) => h('option', { value: k }, v[0])));
    const targetRow = field('רשימה', target);
    const stRow = field('מצב חדש', st);
    const sync = () => { targetRow.style.display = ['addToList', 'removeFromList'].includes(action.value) ? '' : 'none'; stRow.style.display = action.value === 'setStatus' ? '' : 'none'; };
    action.onchange = sync; sync();
    dialog('פעולה מרוכזת', h('div', {},
      h('p', {}, `הפעולה תחול על ${fmt(count)} נמענים`, filtered ? ' שמתאימים לסינון הנוכחי.' : '. לא נבחר סינון, כלומר על כל הנמענים במערכת.'),
      field('פעולה', action), targetRow, stRow), (close) => [h('button', { onclick: close }, 'ביטול'),
      h('button', { class: 'primary', disabled: !count, onclick: safe(async () => {
        if (!window.confirm(`לבצע את הפעולה על ${fmt(count)} נמענים?${action.value === 'delete' ? ' המחיקה אינה ניתנת לביטול.' : ''}`)) return;
        const r = await api('POST', '/subscribers/bulk', { filter, all: !filtered, action: action.value, listId: Number(target.value), status: st.value });
        toast(`הפעולה בוצעה על ${fmt(r.count)} נמענים`);
        close(); await loadLists(); load();
      }) }, 'ביצוע')]);
  });
  const reset = () => { page = 1; load(); };
  let t;
  q.oninput = () => { clearTimeout(t); t = setTimeout(reset, 300); };
  status.onchange = reset; list.onchange = reset;
  shell([
    h('div', { class: 'bar' }, h('h1', {}, 'נמענים'),
      can('subscribers.edit') ? h('button', { onclick: bulk }, 'פעולה על כל התוצאות') : null,
      can('subscribers.export') ? h('button', { onclick: () => { window.location = '/api/export?' + new URLSearchParams({ status: status.value, list: list.value }); } }, 'ייצוא ל-CSV') : null,
      can('subscribers.edit') ? h('button', { class: 'primary', onclick: () => edit(null) }, 'נמען חדש') : null),
    h('div', { class: 'row', style: 'margin-bottom:12px' }, h('div', { class: 'grow' }, q), h('div', {}, status), h('div', {}, list)),
    table,
  ]);
  load();
}

// ---------- רשימות ----------
async function listsPage() {
  await loadLists();
  const edit = (l) => {
    const name = text(l?.name || '');
    const desc = text(l?.description || '');
    dialog(l ? 'עריכת רשימה' : 'רשימה חדשה', h('div', {}, field('שם הרשימה', name), field('תיאור', desc)), (close) => [
      h('button', { onclick: close }, 'ביטול'),
      h('button', { class: 'primary', onclick: safe(async () => {
        await api(l ? 'PUT' : 'POST', l ? `/lists/${l.id}` : '/lists', { name: name.value, description: desc.value, color: l?.color });
        close(); route();
      }) }, 'שמירה')]);
  };
  shell([
    h('div', { class: 'bar' }, h('h1', {}, 'רשימות תפוצה'), h('button', { class: 'primary', onclick: () => edit(null) }, 'רשימה חדשה')),
    state.lists.length ? h('div', { class: 'scroll' }, h('table', { class: 'data' },
      h('tr', {}, ['שם', 'תיאור', 'פעילים', 'סך הכול', ''].map((t) => h('th', {}, t))),
      state.lists.map((l) => h('tr', {},
        h('td', {}, h('b', {}, l.name)), h('td', { class: 'muted' }, l.description), h('td', { class: 'num' }, fmt(l.active)), h('td', { class: 'num' }, fmt(l.total)),
        h('td', {}, h('div', { class: 'row' }, h('button', { class: 'small', onclick: () => edit(l) }, 'עריכה'),
          h('button', { class: 'small danger', onclick: safe(async () => {
            if (!window.confirm(`למחוק את הרשימה "${l.name}"? הנמענים עצמם לא יימחקו.`)) return;
            await api('DELETE', `/lists/${l.id}`); route();
          }) }, 'מחיקה'))))))) : h('p', { class: 'muted' }, 'עדיין אין רשימות. צור רשימה ואז ייבא אליה נמענים.'),
  ]);
}

// ---------- ייבוא ----------
async function importPage() {
  await loadLists();
  const area = h('textarea', { class: 'ltr', placeholder: 'email,name\nname@example.com,ישראל ישראלי' });
  let fileText = null;
  const fileInfo = h('span', { class: 'muted' });
  const file = h('input', { type: 'file', accept: '.csv,.txt,text/csv,text/plain', onchange: async () => {
    const f = file.files[0];
    if (!f) return;
    fileText = await f.text();
    fileInfo.textContent = `${f.name}, ${fmt(fileText.split('\n').length)} שורות`;
  } });
  const lists = listChecks();
  const status = h('select', {}, h('option', { value: 'active' }, 'נמענים פעילים'), h('option', { value: 'unsubscribed' }, 'רשימת הסרה (לא יקבלו מיילים לעולם)'));
  const source = text('', { placeholder: 'למשל: ייצוא מהמערכת הישנה, נובמבר 2026' });
  const result = h('div');
  const go = h('button', { class: 'primary', onclick: safe(async () => {
    go.disabled = true;
    try {
      const r = await api('POST', '/import', { text: fileText ?? area.value, listIds: lists.values(), status: status.value, source: source.value });
      result.replaceChildren(h('div', { class: 'notice good' }, `נוספו ${fmt(r.added)} נמענים חדשים. ${fmt(r.existing)} כבר היו במערכת. ${fmt(r.invalid)} שורות לא תקינות דולגו.`));
      await loadLists();
    } finally { go.disabled = false; }
  }) }, 'ייבוא');
  shell([
    h('h1', {}, 'ייבוא נמענים'),
    h('div', { class: 'card' },
      h('p', { class: 'muted' }, 'אפשר להעלות קובץ CSV (עם עמודות email ו-name, מופרדות בפסיק או בנקודה-פסיק) או להדביק רשימת כתובות, אחת בכל שורה. נמען שהוסר או נחסם בעבר לא יחזור להיות פעיל בייבוא.'),
      field('קובץ', h('div', { class: 'row' }, file, fileInfo)), field('או הדבקה ישירה', area),
      field('לייבא בתור', status), field('מקור הרשימה (נשמר כתיעוד להסכמה)', source),
      h('label', {}, 'לצרף לרשימות'), lists,
      h('div', { style: 'margin-top:16px' }, go)),
    result,
  ]);
}

// ---------- הגדרות ----------
async function settingsPage() {
  const [s] = await Promise.all([api('GET', '/settings'), loadLists()]);
  const f = {};
  const inp = (key, attrs = {}) => { f[key] = h('input', { type: 'text', value: s[key] ?? '', ...attrs }); return f[key]; };
  f.smtpSecure = h('select', {}, [['none', 'ללא הצפנה (שרת מקומי)'], ['starttls', 'STARTTLS (פורט 587)'], ['tls', 'TLS (פורט 465)']].map(([v, t]) => h('option', { value: v, selected: s.smtpSecure === v }, t)));
  f.formListId = h('select', {}, h('option', { value: '' }, 'ללא'), state.lists.map((l) => h('option', { value: l.id, selected: String(s.formListId) === String(l.id) }, l.name)));
  const cur = h('input', { type: 'password', autocomplete: 'current-password' });
  const next = h('input', { type: 'password', autocomplete: 'new-password' });
  shell([
    h('h1', {}, 'הגדרות'),
    h('div', { class: 'card' }, h('h2', {}, 'האתר והשולח'),
      field('כתובת האתר הציבורית (משמשת לקישורי מעקב, הסרה ותמונות)', inp('baseUrl', { class: 'ltr', placeholder: 'https://diur.example.org' })),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, field('שם השולח', inp('fromName'))), h('div', { class: 'grow' }, field('כתובת השולח', inp('fromEmail', { class: 'ltr' }))), h('div', { class: 'grow' }, field('כתובת לתשובה', inp('replyTo', { class: 'ltr' })))),
      field('כתובת לקפיצות (Return-Path). המערכת מוסיפה לה מזהה נמען אחרי סימן +', inp('bounceAddress', { class: 'ltr', placeholder: 'bounce@example.org' })),
      field('כתובת פיזית של העסק (מופיעה בתחתית אוטומטית)', inp('companyAddress')),
      ),
    h('div', { class: 'card' }, h('h2', {}, 'דף ההרשמה הציבורי'),
      h('p', { class: 'muted' }, 'הדף נמצא בכתובת ', h('a', { href: '/subscribe', target: '_blank' }, '/subscribe'), '. אחרי שמירה אפשר לפתוח אותו ולראות את השינוי.'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, field('כותרת', inp('formTitle'))), h('div', { class: 'grow' }, field('טקסט הכפתור', inp('formButton'))),
        h('div', {}, field('צבע הכפתור', inp('formColor', { type: 'color' })))),
      field('טקסט פתיחה (לא חובה)', (f.formIntro = h('textarea', { value: s.formIntro || '', style: 'min-height:70px' }))),
      field('הודעה אחרי הרשמה', inp('formSuccess')),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, field('כתובת תמונת לוגו (לא חובה)', inp('formLogo', { class: 'ltr', placeholder: 'https://…' }))),
        h('div', {}, field('העלאת לוגו', h('input', { type: 'file', accept: 'image/*', onchange: safe(async (e) => {
          const file = e.target.files[0]; if (!file) return;
          const r = await api('POST', '/upload', file, { raw: true, headers: { 'X-Filename': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' } });
          f.formLogo.value = r.url; toast('הלוגו הועלה. יש לשמור את ההגדרות.');
        }) })))),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, field('הנרשמים מצורפים לרשימה', f.formListId)),
        h('div', { class: 'grow' }, field('שדה שם', (f.formAskName = h('select', {}, h('option', { value: '1', selected: s.formAskName !== '0' }, 'לבקש שם'), h('option', { value: '0', selected: s.formAskName === '0' }, 'מייל בלבד')))))),
      h('label', {}, 'קוד להטמעת הטופס באתר אחר'),
      h('pre', { class: 'code' }, `<form action="${s.baseUrl}/subscribe" method="post">\n  <input name="name" placeholder="שם">\n  <input name="email" type="email" placeholder="כתובת מייל" required>\n  <input name="website" style="display:none" tabindex="-1" autocomplete="off">\n  <button type="submit">הרשמה</button>\n</form>`)),
    h('div', { class: 'card' }, h('h2', {}, 'כניסה עם Google'),
      h('p', { class: 'muted' }, 'יוצרים ב-Google Cloud Console מזהה מסוג "OAuth client ID" לאפליקציית רשת, ומוסיפים בו את כתובת ההפניה: ', h('span', { class: 'ltr' }, `${s.baseUrl}/auth/google/callback`),
        '. רק משתמשים שהוגדרו במסך "משתמשים" עם כתובת ה-Google שלהם יוכלו להיכנס.'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, field('Client ID', inp('googleClientId', { class: 'ltr', autocomplete: 'off' }))),
        h('div', { class: 'grow' }, field(s.hasGoogleSecret ? 'Client Secret (שמור. להשאיר ריק כדי לא לשנות)' : 'Client Secret', inp('googleClientSecret', { type: 'password', autocomplete: 'new-password' }))))),
    h('div', { class: 'card' }, h('h2', {}, 'שרת הדואר'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, field('שרת SMTP', inp('smtpHost', { class: 'ltr' }))), h('div', {}, field('פורט', inp('smtpPort', { class: 'ltr', style: 'width:90px' }))), h('div', { class: 'grow' }, field('הצפנה', f.smtpSecure))),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, field('משתמש (ריק לשרת מקומי)', inp('smtpUser', { class: 'ltr', autocomplete: 'off' }))),
        h('div', { class: 'grow' }, field(s.hasSmtpPass ? 'סיסמה (שמורה. להשאיר ריק כדי לא לשנות)' : 'סיסמה', inp('smtpPass', { type: 'password', autocomplete: 'new-password' }))),
        h('div', { class: 'grow' }, field('שם המארח ב-EHLO', inp('ehloName', { class: 'ltr' })))),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, field('קצב שליחה (הודעות בשנייה)', inp('sendPerSecond', { class: 'ltr' }))),
        h('div', { class: 'grow' }, field('תקרה יומית (0 = ללא). שימושי לחימום כתובת IP חדשה', inp('dailyLimit', { class: 'ltr' }))))),
    h('button', { class: 'primary', onclick: safe(async () => {
      const body = {};
      for (const [k, el] of Object.entries(f)) body[k] = el.value;
      await api('PUT', '/settings', body);
      toast('ההגדרות נשמרו');
    }) }, 'שמירת הגדרות'),
    h('div', { class: 'card', style: 'margin-top:20px' }, h('h2', {}, 'החלפת סיסמה'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, field('סיסמה נוכחית', cur)), h('div', { class: 'grow' }, field('סיסמה חדשה (10 תווים לפחות)', next))),
      h('div', { style: 'margin-top:12px' }, h('button', { onclick: safe(async () => { await api('POST', '/password', { current: cur.value, password: next.value }); cur.value = next.value = ''; toast('הסיסמה הוחלפה'); }) }, 'החלפה'))),
  ]);
}

// ---------- ניתוב ----------
async function route() {
  try {
    if (!state.meta) state.meta = await api('GET', '/meta');
    if (!state.meta.user) return authPage();
    const hash = location.hash || '#/';
    const m = /^#\/(campaign|stats)\/(\d+)$/.exec(hash);
    if (m) return await (m[1] === 'campaign' ? campaignPage(m[2]) : statsPage(m[2]));
    const pages = { '#/': dashboardPage, '#/campaigns': campaignsPage, '#/queue': queuePage, '#/subscribers': subscribersPage, '#/lists': listsPage, '#/import': importPage, '#/settings': settingsPage, '#/users': usersPage };
    return await (pages[hash] || dashboardPage)();
  } catch (e) {
    toast(e.message, true);
    if (state.meta?.user && !app.querySelector('.shell')) shell(h('div', { class: 'notice bad' }, e.message));
  }
}
window.addEventListener('hashchange', route);
route();
