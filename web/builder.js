import { renderDesign, BLOCK_DEFAULTS, FONTS, youtubeThumb } from './shared/render.js';

const LABELS = {
  heading: 'כותרת', text: 'טקסט', image: 'תמונה', button: 'כפתור', columns: 'שני טורים', divider: 'קו מפריד', spacer: 'רווח',
  social: 'רשתות וקישורים', menu: 'תפריט', video: 'סרטון', poll: 'סקר', html: 'קוד HTML', footer: 'תחתית', synced: 'בלוק מסונכרן',
};
const ALIGNS = [['right', 'ימין'], ['center', 'מרכז'], ['left', 'שמאל'], ['justify', 'מיושר']];
const clone = (o) => JSON.parse(JSON.stringify(o));

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && k !== 'list' && k !== 'type') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

const field = (label, control) => h('div', {}, h('label', {}, label), control);

/**
 * מרכיב את בונה הגליונות בתוך container.
 * opts: upload(file), meta(), onChange(), saveBrand(settings), blocks: { list, save, update, remove }, notify(msg, bad)
 */
export async function mountBuilder(container, design, opts) {
  const { upload, meta, onChange, saveBrand, blocks: store, notify = () => {}, lists: allLists = [], ai = null } = opts;
  let saved = store ? await store.list() : [];
  const syncedMap = () => Object.fromEntries(saved.filter((b) => b.synced).map((b) => [b.id, b.block]));

  // ----- היסטוריה: ביטול וחזרה -----
  const history = [JSON.stringify(design)];
  let cursor = 0;
  let timer = 0;
  let histTimer = 0;
  const record = () => {
    const snap = JSON.stringify(design);
    if (snap === history[cursor]) return;
    history.splice(cursor + 1);
    history.push(snap);
    if (history.length > 60) history.shift();
    cursor = history.length - 1;
    syncHistButtons();
  };
  const changed = () => {
    clearTimeout(timer); timer = setTimeout(refresh, 250);
    clearTimeout(histTimer); histTimer = setTimeout(record, 700);
    onChange?.();
  };
  const jump = (to) => {
    clearTimeout(histTimer);
    record();
    if (to < 0 || to >= history.length) return;
    cursor = to;
    const snap = JSON.parse(history[cursor]);
    design.settings = snap.settings;
    design.blocks = snap.blocks;
    drawAll();
    onChange?.();
  };
  const undoBtn = h('button', { type: 'button', class: 'small', title: 'ביטול הפעולה האחרונה', onclick: () => jump(cursor - 1) }, '↶ בטל');
  const redoBtn = h('button', { type: 'button', class: 'small', title: 'חזרה על הפעולה שבוטלה', onclick: () => jump(cursor + 1) }, '↷ חזור');
  function syncHistButtons() { undoBtn.disabled = cursor <= 0; redoBtn.disabled = cursor >= history.length - 1; }

  // ----- פקדי קלט -----
  const input = (obj, key, type = 'text', extra = {}) => h('input', {
    type, value: obj[key] ?? '', ...extra,
    oninput: (e) => { obj[key] = type === 'number' ? Number(e.target.value) : e.target.value; changed(); },
  });
  const select = (obj, key, options) => h('select', { onchange: (e) => { obj[key] = e.target.value; changed(); } },
    options.map(([v, t]) => h('option', { value: v, selected: String(obj[key]) === String(v) }, t)));
  const check = (obj, key, text, onflip) => h('label', { class: 'inline-check' },
    h('input', { type: 'checkbox', checked: !!obj[key], onchange: (e) => { obj[key] = e.target.checked; onflip?.(); changed(); } }), text);

  const isImage = (f) => f && /^image\/(png|jpeg|gif|webp)$/.test(f.type);
  function imageField(obj, key = 'src') {
    const thumb = h('img', { class: 'thumb', alt: '' });
    const showThumb = () => { thumb.src = obj[key] || ''; thumb.style.display = obj[key] ? '' : 'none'; };
    const url = input(obj, key, 'url', { class: 'ltr', placeholder: 'https://… או גרירת תמונה לכאן' });
    url.addEventListener('input', showThumb);
    const busy = h('span', { class: 'muted', style: 'display:none' }, 'מעלה…');
    const take = async (f) => {
      if (!isImage(f)) { notify('אפשר להעלות תמונות מסוג PNG, JPG, GIF או WEBP', true); return; }
      if (f.size > 5 * 1024 * 1024) { notify('התמונה גדולה מ-5MB. כדאי להקטין אותה לפני ההעלאה', true); return; }
      busy.style.display = '';
      try { const link = await upload(f); if (link) { obj[key] = link; url.value = link; showThumb(); changed(); } } finally { busy.style.display = 'none'; }
    };
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', style: 'display:none', onchange: async () => { if (file.files[0]) await take(file.files[0]); file.value = ''; } });
    const zone = h('div', { class: 'dropzone',
      ondragover: (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); zone.classList.add('over'); } },
      ondragleave: () => zone.classList.remove('over'),
      ondrop: (e) => { zone.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) { e.preventDefault(); e.stopPropagation(); take(f); } },
      onpaste: (e) => { const f = [...e.clipboardData.files][0]; if (f) { e.preventDefault(); take(f); } } },
      thumb, h('div', { class: 'row grow' }, h('div', { class: 'grow' }, url), h('button', { type: 'button', class: 'small', onclick: () => file.click() }, 'העלאת תמונה'), busy, file));
    showThumb();
    return zone;
  }

  const CLEAN_KEEP = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'A', 'UL', 'OL', 'LI']);
  /** מנקה תוכן שהודבק מ-Word או מאתר: משאיר מבנה בסיסי, קישורים והדגשות, ומסיר עיצוב זר. */
  function cleanPaste(htmlStr) {
    const doc = new DOMParser().parseFromString(htmlStr, 'text/html');
    doc.querySelectorAll('script,style,meta,link,title,head,img,table,iframe,object,svg').forEach((n) => (n.tagName === 'TABLE' ? n.replaceWith(doc.createTextNode(n.textContent)) : n.remove()));
    const walk = (node) => {
      for (const el of [...node.children]) {
        walk(el);
        if (/^H[1-6]$/.test(el.tagName)) { const pEl = doc.createElement('p'); const bEl = doc.createElement('b'); bEl.append(...el.childNodes); pEl.append(bEl); el.replaceWith(pEl); continue; }
        if (el.tagName === 'DIV') { const pEl = doc.createElement('p'); pEl.append(...el.childNodes); el.replaceWith(pEl); continue; }
        if (!CLEAN_KEEP.has(el.tagName)) { el.replaceWith(...el.childNodes); continue; }
        const href = el.tagName === 'A' ? el.getAttribute('href') : null;
        for (const at of [...el.attributes]) el.removeAttribute(at.name);
        if (href && /^(https?:|mailto:|tel:|\{\{)/i.test(href)) el.setAttribute('href', href); else if (el.tagName === 'A') el.replaceWith(...el.childNodes);
      }
    };
    walk(doc.body);
    return doc.body.innerHTML.replace(/<p>(\s|&nbsp;)*<\/p>/g, '');
  }

  function richText(obj, key = 'html') {
    const sync = () => { obj[key] = area.innerHTML; changed(); };
    const area = h('div', { class: 'rte', contentEditable: 'true', html: obj[key] || '', dir: 'auto', oninput: sync,
      onpaste: (e) => {
        const img = [...e.clipboardData.files].find(isImage);
        if (img) { e.preventDefault(); insertImage(img); return; }
        const pasted = e.clipboardData.getData('text/html');
        if (!pasted) return;
        e.preventDefault();
        document.execCommand('insertHTML', false, cleanPaste(pasted));
        sync();
      },
      ondragover: (e) => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); },
      ondrop: (e) => { const f = [...e.dataTransfer.files].find(isImage); if (f) { e.preventDefault(); e.stopPropagation(); area.focus(); insertImage(f); } } });
    const run = (cmd, val) => { area.focus(); document.execCommand(cmd, false, val); sync(); };
    const insertImage = async (f) => {
      if (f.size > 5 * 1024 * 1024) { notify('התמונה גדולה מ-5MB', true); return; }
      const link = await upload(f);
      if (link) run('insertHTML', `<img src="${link}" alt="" style="max-width:100%;height:auto;border:0;">`);
    };
    const pick = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', style: 'display:none', onchange: async () => { if (pick.files[0]) await insertImage(pick.files[0]); pick.value = ''; } });
    const btn = (text, title, fn, style) => h('button', { type: 'button', title, style, onmousedown: (e) => e.preventDefault(), onclick: fn }, text);
    const currentLink = () => { let n = window.getSelection().anchorNode; while (n && n !== area) { if (n.tagName === 'A') return n; n = n.parentNode; } return null; };
    const size = h('select', { title: 'גודל הטקסט המסומן', onchange: () => {
      if (size.value) {
        run('fontSize', '7');
        area.querySelectorAll('font[size="7"]').forEach((f) => { const sp = document.createElement('span'); sp.style.fontSize = size.value + 'px'; sp.append(...f.childNodes); f.replaceWith(sp); });
        sync();
      }
      size.value = '';
    } }, h('option', { value: '' }, 'גודל'), [12, 14, 16, 18, 20, 24, 28, 34].map((n) => h('option', { value: n }, n)));
    const face = h('select', { title: 'גופן לטקסט המסומן', onchange: () => { if (face.value) run('fontName', face.value); face.value = ''; } },
      h('option', { value: '' }, 'גופן'), FONTS.map(([v, t]) => h('option', { value: v }, t)));
    // הבחירה האחרונה בתוך הבלוק נשמרת, כי פתיחת תפריט העוזר מעבירה את המיקוד ומבטלת את הסימון
    let lastRange = null;
    const remember = () => { const sel = window.getSelection(); if (sel.rangeCount && area.contains(sel.getRangeAt(0).commonAncestorContainer)) lastRange = sel.getRangeAt(0).cloneRange(); };
    document.addEventListener('selectionchange', () => { if (document.activeElement === area) remember(); });
    const liveRange = () => (lastRange && area.contains(lastRange.commonAncestorContainer) ? lastRange : null);
    const restore = (range) => { area.focus(); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range); };
    // תוצאה של פסקה אחת נכנסת לתוך הפסקה הקיימת בלי לשבור אותה
    const inline = (htmlStr) => { const m = /^\s*<p>([\s\S]*)<\/p>\s*$/.exec(htmlStr); return m && !/<\/?(p|ul|ol)\b/i.test(m[1]) ? m[1] : htmlStr; };
    const aiMenu = h('select', { class: 'ai-menu', title: 'עוזר AI. אם סימנת חלק מהטקסט, העוזר יעבוד רק עליו', onchange: async () => {
      const mode = aiMenu.value; aiMenu.value = '';
      if (!mode) return;
      const range = liveRange();
      const picked = range && !range.collapsed ? range : null;
      let pickedHtml = '';
      if (picked) { const box = document.createElement('div'); box.append(picked.cloneContents()); pickedHtml = box.innerHTML; }
      if (picked && !plain(pickedHtml)) { notify('הסימון ריק. סמן טקסט, או בטל את הסימון כדי לעבוד על כל הבלוק', true); return; }
      const has = plain(area.innerHTML);
      let prompt = '';
      if (mode === 'write' || mode === 'custom') {
        prompt = window.prompt(mode === 'write' ? 'על מה לכתוב? אפשר לפרט נקודות, אורך וסגנון:' : `מה לעשות עם ${picked ? 'הטקסט המסומן' : 'הטקסט'}? למשל: "הפוך לרשימת נקודות":`, '') || '';
        if (!prompt.trim()) return;
      } else if (!has) { notify('הבלוק ריק. קודם כותבים טקסט, או בוחרים "כתוב לפי הנחיה"', true); return; }
      aiMenu.disabled = true; area.classList.add('busy');
      try {
        const r = await ai(mode === 'write' ? { action: 'write', prompt, context: plain(design.blocks.map((x) => x.text || x.html || '').join(' ')).slice(0, 4000) }
          : { action: 'rewrite', mode: mode === 'custom' ? '' : mode, prompt, text: picked ? pickedHtml : area.innerHTML });
        if (!r || !r.html) return;
        if (picked) {
          // רק הקטע המסומן מוחלף. שאר הבלוק נשאר כמו שהוא
          restore(picked); document.execCommand('insertHTML', false, inline(r.html)); sync();
          notify('הקטע המסומן עודכן. אפשר לבטל בכפתור "בטל" למעלה');
        } else if (mode === 'write' && has) {
          // כתיבה חדשה בבלוק שכבר יש בו תוכן נכנסת במקום הסמן, או בסוף הבלוק, ולא מוחקת את הקיים
          if (range) { restore(range); document.execCommand('insertHTML', false, r.html); } else area.insertAdjacentHTML('beforeend', r.html);
          sync(); notify('הטקסט החדש נוסף לבלוק. אפשר לבטל בכפתור "בטל" למעלה');
        } else { area.innerHTML = r.html; sync(); notify('הטקסט עודכן. אפשר לבטל בכפתור "בטל" למעלה'); }
        lastRange = null;
      } finally { aiMenu.disabled = false; area.classList.remove('busy'); }
    } }, h('option', { value: '' }, '✨ עוזר AI'), [['write', 'כתוב לפי הנחיה…'], ['improve', 'שפר ניסוח (מסומן או הכול)'], ['shorten', 'קצר'], ['lengthen', 'הרחב'], ['proofread', 'הגהה בלבד'],
      ['formal', 'רשמי יותר'], ['friendly', 'חם ואישי יותר'], ['custom', 'הנחיה חופשית…']].map(([v, t]) => h('option', { value: v }, t)));
    const tools = h('div', { class: 'rte-tools' },
      btn('B', 'מודגש', () => run('bold'), 'font-weight:bold'), btn('I', 'נטוי', () => run('italic'), 'font-style:italic'), btn('U', 'קו תחתון', () => run('underline'), 'text-decoration:underline'),
      face, size,
      h('label', { class: 'swatch', title: 'צבע טקסט' }, 'A', h('input', { type: 'color', value: '#1a1a1a', oninput: (e) => run('foreColor', e.target.value) })),
      h('label', { class: 'swatch mark', title: 'צבע סימון (מרקר)' }, '▇', h('input', { type: 'color', value: '#fff3a3', oninput: (e) => run('hiliteColor', e.target.value) })),
      btn('🔗 קישור', 'הוספה או עריכה של קישור על הטקסט המסומן', () => {
        const cur = currentLink();
        const u = window.prompt('כתובת הקישור (אתר, או mailto: לכתובת מייל):', cur ? cur.getAttribute('href') : 'https://');
        if (u === null) return;
        if (cur) { if (u.trim()) cur.setAttribute('href', u.trim()); else cur.replaceWith(...cur.childNodes); sync(); return; }
        if (!u.trim() || u.trim() === 'https://') return;
        if (window.getSelection().isCollapsed) run('insertHTML', `<a href="${u.trim().replace(/"/g, '&quot;')}">${u.trim().replace(/</g, '&lt;')}</a>`); else run('createLink', u.trim());
      }),
      btn('בטל קישור', 'הסרת הקישור', () => run('unlink')),
      btn('🖼 תמונה', 'הוספת תמונה בתוך הטקסט. אפשר גם לגרור או להדביק תמונה', () => { area.focus(); pick.click(); }), pick,
      btn('• רשימה', 'רשימת תבליטים', () => run('insertUnorderedList')), btn('1. רשימה', 'רשימה ממוספרת', () => run('insertOrderedList')),
      btn('ימין', 'יישור לימין', () => run('justifyRight')), btn('מרכז', 'יישור למרכז', () => run('justifyCenter')), btn('שמאל', 'יישור לשמאל', () => run('justifyLeft')),
      btn('שם הנמען', 'הוספת שם הנמען', () => run('insertText', '{{name}}')),
      btn('שם פרטי', 'הוספת השם הפרטי', () => run('insertText', '{{first_name}}')),
      btn('נקה עיצוב', 'הסרת עיצוב מהטקסט המסומן', () => run('removeFormat')),
      ai ? aiMenu : null);
    return h('div', {}, tools, area);
  }

  function linksField(b) {
    const toText = () => (b.links || []).map((l) => `${l.label} | ${l.href}`).join('\n');
    return h('textarea', { class: 'ltr-mixed', value: toText(), style: 'min-height:84px', placeholder: 'טקסט | https://כתובת',
      oninput: (e) => {
        b.links = e.target.value.split('\n').map((line) => { const i = line.indexOf('|'); return i < 0 ? null : { label: line.slice(0, i).trim(), href: line.slice(i + 1).trim() }; }).filter(Boolean);
        changed();
      } });
  }

  /** צבע רקע לבלוק, עם אפשרות לחזור ל"ללא". */
  function bgField(b) {
    const c = h('input', { type: 'color', value: b.blockBg || design.settings.contentBg, oninput: (e) => { b.blockBg = e.target.value; changed(); } });
    return field('רקע הבלוק', h('div', { class: 'row' }, c, h('button', { type: 'button', class: 'small', onclick: () => { delete b.blockBg; c.value = design.settings.contentBg; changed(); } }, 'ללא')));
  }

  /**
   * מה קורה בלחיצה על הכפתור: קישור לאתר, פתיחת טיוטת מייל, חיוג או הודעת וואטסאפ.
   * הבחירה נשמרת בשדות נפרדים, ומהם נבנה הקישור עצמו (href), כך שהמייל שנשלח לא תלוי בעורך.
   */
  function buttonAction(b) {
    if (!b.action) b.action = /\/pdf\/\{\{TOKEN\}\}$/.test(b.href || '') ? 'pdf' : /^mailto:/i.test(b.href || '') ? 'mail' : /^tel:/i.test(b.href || '') ? 'tel' : /^https:\/\/wa\.me\//i.test(b.href || '') ? 'wa' : 'link';
    if (b.action === 'mail' && b.mailTo === undefined) {
      // כפתור ישן שהקישור שלו הוקלד ידנית כ-mailto: מפרקים אותו לשדות
      const m = /^mailto:([^?]*)\??(.*)$/i.exec(b.href || '') || [];
      const q = new URLSearchParams(m[2] || '');
      b.mailTo = decodeURIComponent(m[1] || ''); b.mailSubject = q.get('subject') || ''; b.mailBody = q.get('body') || '';
    }
    if (b.action === 'tel' && b.phone === undefined) b.phone = (b.href || '').replace(/^tel:/i, '');
    const digits = (x) => String(x || '').replace(/[^\d+]/g, '');
    const intl = (x) => { const d = digits(x).replace(/^\+/, ''); return d.startsWith('0') ? '972' + d.slice(1) : d; }; // מספר ישראלי מקומי הופך לבינלאומי
    const enc = (x) => encodeURIComponent(String(x || '')).replace(/%20/g, '%20');
    const build = () => {
      if (b.action === 'mail') {
        const parts = [b.mailSubject ? 'subject=' + enc(b.mailSubject) : '', b.mailBody ? 'body=' + enc(b.mailBody).replace(/%0A/g, '%0D%0A') : ''].filter(Boolean);
        b.href = 'mailto:' + String(b.mailTo || '').trim().replace(/\s+/g, '') + (parts.length ? '?' + parts.join('&') : '');
      } else if (b.action === 'tel') b.href = 'tel:' + digits(b.phone);
      else if (b.action === 'wa') b.href = 'https://wa.me/' + intl(b.phone) + (b.waText ? '?text=' + enc(b.waText) : '');
      else if (b.action === 'pdf') b.href = '{{BASE}}/pdf/{{TOKEN}}';
      changed();
    };
    const box = h('div', { class: 'btn-action' });
    const inp = (key, type, attrs = {}) => h('input', { type, value: b[key] || '', ...attrs, oninput: (e) => { b[key] = e.target.value; build(); } });
    const area = (key, attrs = {}) => h('textarea', { value: b[key] || '', style: 'min-height:60px', ...attrs, oninput: (e) => { b[key] = e.target.value; build(); } });
    const draw = () => {
      if (b.action === 'mail') {
        box.replaceChildren(h('div', { class: 'fields' }, field('לאיזו כתובת יישלח המייל', inp('mailTo', 'email', { class: 'ltr', placeholder: 'office@nekuda.org.il' })),
          field('מה יהיה רשום בנושא', inp('mailSubject', 'text', { placeholder: 'למשל: הרשמה לערב העיון' }))),
        field('טקסט שיופיע בגוף המייל (לא חובה)', area('mailBody', { placeholder: 'למשל: שלום, אני מעוניין להירשם. שמי:' })),
        h('p', { class: 'muted small-note' }, 'לחיצה על הכפתור פותחת אצל הנמען טיוטת מייל מוכנה, עם הכתובת, הנושא והטקסט שקבעת. הוא רק לוחץ "שלח". לחיצות על כפתור כזה לא נספרות בנתוני הגליון.'));
      } else if (b.action === 'tel') {
        box.replaceChildren(h('div', { class: 'fields' }, field('מספר טלפון לחיוג', inp('phone', 'tel', { class: 'ltr', placeholder: '02-1234567' }))),
          h('p', { class: 'muted small-note' }, 'בטלפון, לחיצה על הכפתור פותחת את החייגן עם המספר. במחשב היא תלויה בתוכנה שמותקנת אצל הנמען.'));
      } else if (b.action === 'wa') {
        box.replaceChildren(h('div', { class: 'fields' }, field('מספר וואטסאפ', inp('phone', 'tel', { class: 'ltr', placeholder: '050-1234567' })),
          field('הודעה מוכנה (לא חובה)', inp('waText', 'text', { placeholder: 'למשל: שלום, ראיתי את הגליון' }))),
        h('p', { class: 'muted small-note' }, 'לחיצה פותחת שיחת וואטסאפ עם המספר, וההודעה כבר כתובה. מספר שמתחיל ב-0 מומר לקידומת ישראל (972).'));
      } else if (b.action === 'pdf') {
        box.replaceChildren(h('p', { class: 'muted small-note' }, 'לחיצה על הכפתור מורידה לנמען את הגליון הזה כקובץ PDF. אין צורך בקישור: המערכת מפיקה את הקובץ לבד. בתצוגה המקדימה ובשליחת בדיקה הכפתור עדיין לא מוריד קובץ מהגליון הסופי.'));
      } else {
        box.replaceChildren(h('div', { class: 'fields' }, field('כתובת הקישור', h('input', { type: 'url', class: 'ltr', value: /^(mailto:|tel:)/i.test(b.href || '') ? 'https://' : (b.href || 'https://'), placeholder: 'https://', oninput: (e) => { b.href = e.target.value; changed(); } }))));
      }
    };
    const kind = h('select', { onchange: () => {
      b.action = kind.value;
      if (b.action === 'pdf' && (!b.text || b.text === 'לחץ כאן')) b.text = 'הורד כ-PDF';
      if (b.action === 'link') b.href = /^https?:\/\//i.test(b.href || '') && !/^https:\/\/wa\.me\//i.test(b.href) ? b.href : 'https://'; else build();
      draw(); changed();
    } }, [['link', 'מעבר לקישור (אתר או דף)'], ['pdf', 'הורדת הגליון כ-PDF'], ['mail', 'שליחת מייל (פותח טיוטה מוכנה)'], ['tel', 'חיוג לטלפון'], ['wa', 'הודעת וואטסאפ']].map(([v, t]) => h('option', { value: v, selected: b.action === v }, t)));
    draw();
    return h('div', {}, field('מה קורה בלחיצה על הכפתור', kind), box);
  }

  function blockBody(b) {
    switch (b.type) {
      case 'heading': return [field('טקסט הכותרת', input(b, 'text')), h('div', { class: 'fields' },
        field('רמה', select(b, 'level', [[1, 'ראשית'], [2, 'משנית'], [3, 'קטנה']])), field('יישור', select(b, 'align', ALIGNS.slice(0, 3))),
        field('צבע', input(b, 'color', 'color', { value: b.color || design.settings.color })),
        field('גודל (0 = לפי הרמה)', input(b, 'size', 'number', { min: 0, max: 60, value: b.size || 0 })), bgField(b))];
      case 'text': return [richText(b), h('div', { class: 'fields' }, field('יישור', select(b, 'align', ALIGNS)), bgField(b))];
      case 'image': return [field('תמונה', imageField(b)), h('div', { class: 'fields' },
        field('טקסט חלופי (alt)', input(b, 'alt')), field('קישור בלחיצה', input(b, 'href', 'url', { class: 'ltr' })),
        field('רוחב באחוזים', input(b, 'widthPct', 'number', { min: 10, max: 100 })), field('יישור', select(b, 'align', ALIGNS.slice(0, 3))),
        check(b, 'fullBleed', 'מקצה לקצה'))];
      case 'button': return [h('div', { class: 'fields' }, field('טקסט', input(b, 'text'))), buttonAction(b), h('div', { class: 'fields' },
        field('צבע רקע', input(b, 'bg', 'color', { value: b.bg || design.settings.btnBg })), field('צבע טקסט', input(b, 'color', 'color', { value: b.color || design.settings.btnColor })),
        field('עיגול פינות', input(b, 'radius', 'number', { min: 0, max: 40, value: b.radius ?? design.settings.btnRadius })), field('יישור', select(b, 'align', ALIGNS.slice(0, 3))),
        field('גודל', select(b, 'size', [['', 'רגיל'], ['s', 'קטן'], ['l', 'גדול']]))), check(b, 'full', 'כפתור לכל רוחב הגליון')];
      case 'columns': return [...b.cols.map((c, i) => h('div', { style: 'margin-bottom:10px' }, h('label', {}, i === 0 ? 'טור ימני' : 'טור שמאלי'), imageField(c), field('טקסט חלופי לתמונה', input(c, 'alt')), richText(c))),
        check(b, 'reverseMobile', 'בנייד: להציג את הטור השמאלי ראשון')];
      case 'divider': return [h('div', { class: 'fields' }, field('צבע הקו', input(b, 'color', 'color')))];
      case 'spacer': return [h('div', { class: 'fields' }, field('גובה בפיקסלים', input(b, 'height', 'number', { min: 4, max: 200 })))];
      case 'social':
      case 'menu': return [field('קישורים, שורה לכל קישור: טקסט | כתובת', linksField(b)), h('div', { class: 'fields' }, field('יישור', select(b, 'align', ALIGNS.slice(0, 3))))];
      case 'video': {
        const hint = h('p', { class: 'muted small-note' }, youtubeThumb(b.url) ? 'תמונת הסרטון תילקח אוטומטית מיוטיוב.' : 'לסרטון שאינו מיוטיוב כדאי להוסיף תמונה.');
        return [field('קישור לסרטון', input(b, 'url', 'url', { class: 'ltr' })), field('תמונה (לא חובה)', imageField(b, 'thumb')), field('כיתוב', input(b, 'caption')), hint,
          h('p', { class: 'muted small-note' }, 'תוכנות דואר לא מנגנות וידאו. הבלוק מציג תמונה שמובילה לסרטון.')];
      }
      case 'poll': return [field('השאלה', input(b, 'question')),
        field('תשובות, שורה לכל תשובה (עד שש)', h('textarea', { value: (b.options || []).join('\n'), style: 'min-height:84px', oninput: (e) => { b.options = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 6); changed(); } })),
        h('p', { class: 'muted small-note' }, 'כל תשובה היא כפתור במייל. לחיצה רושמת את התשובה, והתוצאות מופיעות במסך הנתונים של הגליון.')];
      case 'html': return [h('textarea', { class: 'code', style: 'min-height:120px', value: b.html || '', oninput: (e) => { b.html = e.target.value; changed(); } })];
      case 'footer': return [richText(b), h('p', { class: 'muted small-note' }, 'התג {{unsubscribe_url}} הוא קישור ההסרה. אם יוסר, המערכת תוסיף קישור הסרה אוטומטית.')];
      default: return [];
    }
  }

  const visibility = (b) => h('div', { class: 'row vis' },
    check(b, 'hideMobile', 'להסתיר בנייד', () => { if (b.hideMobile) b.hideDesktop = false; drawBlocks(); }),
    check(b, 'hideDesktop', 'להסתיר במחשב', () => { if (b.hideDesktop) b.hideMobile = false; drawBlocks(); }),
    allLists.length ? h('select', { class: 'cond', title: 'תנאי תצוגה לפי נמען', onchange: (e) => {
      const v = e.target.value; b.onlyList = Math.abs(Number(v)) || 0; b.notInList = v.startsWith('-'); if (!b.onlyList) { delete b.onlyList; delete b.notInList; } changed();
    } }, h('option', { value: '0' }, 'להציג לכל הנמענים'),
    allLists.map((l) => h('option', { value: l.id, selected: b.onlyList === l.id && !b.notInList }, `רק לחברי: ${l.name}`)),
    allLists.map((l) => h('option', { value: -l.id, selected: b.onlyList === l.id && !!b.notInList }, `רק למי שלא ב: ${l.name}`))) : null);

  const list = h('div', { class: 'b-side' });
  let dragFrom = null;
  const openSet = new WeakSet();
  const plain = (x) => String(x || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const summary = (b) => { const t = plain(b.text || b.html || b.caption || b.alt || (b.cols || []).map((c) => c.html).join(' ') || (b.links || []).map((l) => l.label).join(' · ')); return t.length > 46 ? t.slice(0, 46) + '…' : t; };
  function openBlock(i, scroll = true) {
    const b = design.blocks[i];
    if (!b) return;
    openSet.add(b);
    drawBlocks();
    const el = list.children[i + 1];
    if (el && scroll) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1200); }
  }
  function drawBlocks() {
    list.replaceChildren(...design.blocks.map((b, i) => {
      const move = (d) => { const j = i + d; if (j < 0 || j >= design.blocks.length) return; [design.blocks[i], design.blocks[j]] = [design.blocks[j], design.blocks[i]]; drawBlocks(); changed(); };
      const tool = (text, title, fn, cls = 'small') => h('button', { type: 'button', class: cls, title, onclick: fn }, text);
      const source = b.type === 'synced' ? saved.find((s) => s.id === b.ref) : null;
      let body;
      let title = LABELS[b.type] || b.type;
      if (b.type === 'synced') {
        title = `מסונכרן: ${source ? source.name : 'נמחק'}`;
        body = source
          ? [h('p', { class: 'muted small-note' }, 'שינוי כאן מתעדכן בכל הגליונות שמשתמשים בבלוק הזה, אחרי לחיצה על "עדכן בכל הגליונות".'),
            ...blockBody(source.block),
            h('div', { style: 'margin-top:8px' }, tool('עדכן בכל הגליונות', 'שמירת הבלוק המסונכרן', async () => { await store.update(source.id, source.block); notify('הבלוק המסונכרן עודכן'); }, 'small primary'))]
          : [h('p', { class: 'notice bad' }, 'הבלוק המקורי נמחק. אפשר למחוק את הבלוק הזה מהגליון.')];
      } else {
        body = [...blockBody(b), visibility(b)];
      }
      const saveBtn = store && b.type !== 'synced' ? tool('שמור', 'שמירה לשימוש חוזר', async () => {
        const name = window.prompt('שם לבלוק השמור:', LABELS[b.type]);
        if (!name) return;
        const synced = window.confirm('לשמור כבלוק מסונכרן?\n\nאישור: שינוי בו יתעדכן בכל הגליונות (מתאים לכותרת ולתחתית).\nביטול: יישמר כעותק רגיל.');
        const r = await store.save(name, clone(b), synced);
        if (!r) return;
        saved = await store.list();
        if (synced) design.blocks[i] = { type: 'synced', ref: r.id };
        drawAll(); changed();
        notify('הבלוק נשמר');
      }) : null;
      const isOpen = openSet.has(b);
      return h('section', { class: 'block' + (b.hideMobile || b.hideDesktop || b.onlyList ? ' partial' : '') + (isOpen ? ' open' : ''),
        ondragover: (e) => { if (dragFrom !== null && dragFrom !== i) { e.preventDefault(); e.currentTarget.classList.add('drop'); } },
        ondragleave: (e) => e.currentTarget.classList.remove('drop'),
        ondrop: (e) => {
          e.preventDefault();
          if (dragFrom === null || dragFrom === i) return;
          const [moved] = design.blocks.splice(dragFrom, 1);
          design.blocks.splice(i, 0, moved);
          dragFrom = null;
          drawBlocks(); changed();
        } },
        h('header', { draggable: true, title: 'גרור כדי לשנות מיקום', ondragstart: (e) => { dragFrom = i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); },
          ondragend: () => { dragFrom = null; list.querySelectorAll('.drop').forEach((el) => el.classList.remove('drop')); } }, h('span', { class: 'grip' }, '⠿'), h('b', { class: 'ttl', title: isOpen ? 'סגירה' : 'פתיחה לעריכה', onclick: () => { if (isOpen) openSet.delete(b); else openSet.add(b); drawBlocks(); } }, (isOpen ? '▾ ' : '◂ ') + title, isOpen ? null : h('span', { class: 'sum' }, summary(b))), b.hideMobile ? h('span', { class: 'tag' }, 'מחשב בלבד') : null, b.hideDesktop ? h('span', { class: 'tag' }, 'נייד בלבד') : null,
          tool('▲', 'העבר למעלה', () => move(-1)), tool('▼', 'העבר למטה', () => move(1)),
          tool('שכפל', 'שכפול הבלוק', () => { design.blocks.splice(i + 1, 0, clone(b)); drawBlocks(); changed(); }), saveBtn,
          tool('מחק', 'מחיקת הבלוק', () => { design.blocks.splice(i, 1); drawBlocks(); changed(); }, 'small danger')),
        isOpen ? h('div', { class: 'body' }, body) : null);
    }));
    list.prepend(h('div', { class: 'row' }, h('span', { class: 'muted grow small-note' }, 'לחיצה על בלוק בתצוגה המקדימה, או על שמו כאן, פותחת אותו לעריכה.'),
      h('button', { type: 'button', class: 'small', onclick: () => { design.blocks.forEach((b) => openSet.add(b)); drawBlocks(); } }, 'פתח הכול'),
      h('button', { type: 'button', class: 'small', onclick: () => { design.blocks.forEach((b) => openSet.delete(b)); drawBlocks(); } }, 'סגור הכול')));
    if (!design.blocks.length) list.append(h('p', { class: 'muted' }, 'אין בלוקים. הוסף בלוק מהכפתורים למעלה.'));
  }
  const insertAt = () => { const f = design.blocks.findIndex((b) => b.type === 'footer'); return f >= 0 ? f : design.blocks.length; };

  const settingsBox = h('div', { class: 'card', style: 'margin:0' });
  function drawSettings() {
    const s = design.settings;
    settingsBox.replaceChildren(h('div', { class: 'row' }, h('h2', { class: 'grow', style: 'margin:0' }, 'עיצוב כללי'), undoBtn, redoBtn), h('div', { class: 'fields', style: 'margin-top:10px' },
      field('גופן', select(s, 'font', FONTS)), field('גופן כותרות', select(s, 'headingFont', [['', 'כמו הטקסט'], ...FONTS])), field('גודל טקסט', input(s, 'fontSize', 'number', { min: 10, max: 30 })),
      field('גודל טקסט בנייד (0 = זהה)', input(s, 'mobileFontSize', 'number', { min: 0, max: 30 })),
      field('רוחב', input(s, 'width', 'number', { min: 320, max: 800 })), field('כיוון', select(s, 'dir', [['rtl', 'ימין לשמאל'], ['ltr', 'שמאל לימין']])),
      field('רקע חיצוני', input(s, 'bg', 'color')), field('רקע התוכן', input(s, 'contentBg', 'color')),
      field('צבע טקסט', input(s, 'color', 'color')), field('צבע קישורים', input(s, 'link', 'color')),
      field('רקע כפתורים', input(s, 'btnBg', 'color')), field('טקסט כפתורים', input(s, 'btnColor', 'color')),
      field('עיגול כפתורים', input(s, 'btnRadius', 'number', { min: 0, max: 40 }))),
    h('p', { class: 'muted small-note' }, 'גופן שמסומן "רשת" מוצג ב-Apple Mail ובחלק מתוכנות הדואר. ב-Gmail וב-Outlook יוצג במקומו Arial או גופן דומה.'),
    saveBrand ? h('div', { style: 'margin-top:10px' }, h('button', { type: 'button', class: 'small', title: 'גליונות חדשים ייפתחו עם העיצוב הזה',
      onclick: async () => { await saveBrand(design.settings); notify('ערכת המותג נשמרה. גליונות חדשים ייפתחו איתה.'); } }, 'שמור כערכת המותג')) : null);
  }

  const palette = h('div', { class: 'card', style: 'margin:0' });
  function drawPalette() {
    palette.replaceChildren(...[h('h2', {}, 'הוספת בלוק'), h('div', { class: 'palette' },
      Object.keys(BLOCK_DEFAULTS).map((t) => h('button', { type: 'button', onclick: () => {
        const b = BLOCK_DEFAULTS[t]();
        if (t === 'button') { delete b.bg; delete b.color; delete b.radius; }
        const at = t === 'footer' ? design.blocks.length : insertAt();
        design.blocks.splice(at, 0, b);
        changed(); openBlock(at);
      } }, '+ ' + LABELS[t]))),
    saved.length ? h('div', { style: 'margin-top:12px' }, h('label', {}, 'בלוקים שמורים'), h('div', { class: 'palette' }, saved.map((sb) => h('span', { class: 'saved' },
      h('button', { type: 'button', title: sb.synced ? 'בלוק מסונכרן' : 'עותק של בלוק שמור', onclick: () => {
        design.blocks.splice(insertAt(), 0, sb.synced ? { type: 'synced', ref: sb.id } : clone(sb.block));
        drawBlocks(); changed();
      } }, (sb.synced ? '⟳ ' : '+ ') + sb.name),
      h('button', { type: 'button', class: 'small danger', title: 'מחיקת הבלוק השמור', onclick: async () => {
        if (!window.confirm(`למחוק את הבלוק השמור "${sb.name}"?${sb.synced ? ' הוא ייעלם מכל הגליונות שמשתמשים בו.' : ''}`)) return;
        await store.remove(sb.id); saved = await store.list(); drawAll(); refresh();
      } }, '✕'))))) : null].filter(Boolean));
  }

  const frame = h('iframe', { title: 'תצוגה מקדימה', sandbox: 'allow-same-origin', onload: () => {
    const doc = frame.contentDocument;
    if (!doc) return;
    doc.head.append(Object.assign(doc.createElement('style'), { textContent: 'tr[data-b]{cursor:pointer}tr[data-b]:hover>td{outline:2px solid #1b4fd8;outline-offset:-2px}' }));
    doc.addEventListener('click', (e) => { e.preventDefault(); const row = e.target.closest('tr[data-b]'); if (row) openBlock(Number(row.dataset.b)); });
  } });
  const frameWrap = h('div', { class: 'preview-frame' }, frame);
  const modeBtn = (text, fn) => h('button', { type: 'button', class: 'small', onclick: fn }, text);
  const preview = h('div', { class: 'preview-wrap' }, h('div', { class: 'row', style: 'margin-bottom:8px' },
    h('b', { class: 'grow' }, 'תצוגה מקדימה'), modeBtn('מחשב', () => frameWrap.classList.remove('mobile')), modeBtn('נייד', () => frameWrap.classList.add('mobile')),
    modeBtn('מצב כהה', () => frameWrap.classList.toggle('dark'))), frameWrap,
  h('p', { class: 'muted small-note' }, 'מצב כהה הוא הדמיה בלבד. כל תוכנת דואר הופכת צבעים בדרך משלה.'));

  function refresh() {
    frame.srcdoc = renderDesign(design, { ...meta(), synced: syncedMap(), editor: true })
      .replace(/\{\{(name)\}\}/g, 'ישראל ישראלי').replace(/\{\{first_name\}\}/g, 'ישראל').replace(/\{\{email\}\}/g, 'name@example.com').replace(/\{\{\w+\}\}/g, '#');
  }
  function drawAll() { drawSettings(); drawPalette(); drawBlocks(); syncHistButtons(); refresh(); }

  container.replaceChildren(h('div', { class: 'builder' }, h('div', { class: 'b-side' }, settingsBox, palette, list), preview));
  drawAll();
  return { getDesign: () => design, refresh, syncedMap, reload: () => { drawBlocks(); changed(); }, text: () => design.blocks.map((b) => plain(b.text || b.html || (b.cols || []).map((c) => c.html).join(' ') || b.question || '')).filter(Boolean).join('\n') };
}
