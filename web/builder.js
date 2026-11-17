import { renderDesign, BLOCK_DEFAULTS, FONTS, youtubeThumb } from './shared/render.js';

const LABELS = {
  heading: 'כותרת', text: 'טקסט', image: 'תמונה', button: 'כפתור', columns: 'שני טורים', divider: 'קו מפריד', spacer: 'רווח',
  social: 'רשתות וקישורים', menu: 'תפריט', video: 'סרטון', html: 'קוד HTML', footer: 'תחתית', synced: 'בלוק מסונכרן',
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
  const { upload, meta, onChange, saveBrand, blocks: store, notify = () => {} } = opts;
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

  function imageField(obj, key = 'src') {
    const url = input(obj, key, 'url', { class: 'ltr', placeholder: 'https://…' });
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', style: 'display:none', onchange: async () => {
      if (!file.files[0]) return;
      const link = await upload(file.files[0]);
      if (link) { obj[key] = link; url.value = link; changed(); }
      file.value = '';
    } });
    return h('div', { class: 'row' }, h('div', { class: 'grow' }, url), h('button', { type: 'button', class: 'small', onclick: () => file.click() }, 'העלאת תמונה'), file);
  }

  function richText(obj, key = 'html') {
    const area = h('div', { class: 'rte', contentEditable: 'true', html: obj[key] || '', dir: 'auto',
      oninput: () => { obj[key] = area.innerHTML; changed(); } });
    const run = (cmd, val) => { area.focus(); document.execCommand(cmd, false, val); obj[key] = area.innerHTML; changed(); };
    const btn = (text, title, fn) => h('button', { type: 'button', title, onmousedown: (e) => e.preventDefault(), onclick: fn }, text);
    const tools = h('div', { class: 'rte-tools' },
      btn('B', 'מודגש', () => run('bold')), btn('I', 'נטוי', () => run('italic')), btn('U', 'קו תחתון', () => run('underline')),
      btn('קישור', 'הוספת קישור', () => { const u = window.prompt('כתובת הקישור:', 'https://'); if (u) run('createLink', u); }),
      btn('בטל קישור', 'הסרת קישור', () => run('unlink')),
      btn('• רשימה', 'רשימת תבליטים', () => run('insertUnorderedList')), btn('1. רשימה', 'רשימה ממוספרת', () => run('insertOrderedList')),
      btn('ימין', 'יישור לימין', () => run('justifyRight')), btn('מרכז', 'יישור למרכז', () => run('justifyCenter')), btn('שמאל', 'יישור לשמאל', () => run('justifyLeft')),
      h('input', { type: 'color', title: 'צבע טקסט', value: '#1a1a1a', oninput: (e) => run('foreColor', e.target.value) }),
      btn('שם הנמען', 'הוספת שם הנמען', () => run('insertText', '{{name}}')),
      btn('שם פרטי', 'הוספת השם הפרטי', () => run('insertText', '{{first_name}}')),
      btn('נקה עיצוב', 'הסרת עיצוב', () => run('removeFormat')));
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

  function blockBody(b) {
    switch (b.type) {
      case 'heading': return [field('טקסט הכותרת', input(b, 'text')), h('div', { class: 'fields' },
        field('רמה', select(b, 'level', [[1, 'ראשית'], [2, 'משנית'], [3, 'קטנה']])), field('יישור', select(b, 'align', ALIGNS.slice(0, 3))),
        field('צבע', input(b, 'color', 'color', { value: b.color || design.settings.color })))];
      case 'text': return [richText(b), h('div', { class: 'fields' }, field('יישור', select(b, 'align', ALIGNS)))];
      case 'image': return [field('תמונה', imageField(b)), h('div', { class: 'fields' },
        field('טקסט חלופי (alt)', input(b, 'alt')), field('קישור בלחיצה', input(b, 'href', 'url', { class: 'ltr' })),
        field('רוחב באחוזים', input(b, 'widthPct', 'number', { min: 10, max: 100 })), field('יישור', select(b, 'align', ALIGNS.slice(0, 3))),
        check(b, 'fullBleed', 'מקצה לקצה'))];
      case 'button': return [h('div', { class: 'fields' }, field('טקסט', input(b, 'text')), field('קישור', input(b, 'href', 'url', { class: 'ltr' })),
        field('צבע רקע', input(b, 'bg', 'color', { value: b.bg || design.settings.btnBg })), field('צבע טקסט', input(b, 'color', 'color', { value: b.color || design.settings.btnColor })),
        field('עיגול פינות', input(b, 'radius', 'number', { min: 0, max: 40, value: b.radius ?? design.settings.btnRadius })), field('יישור', select(b, 'align', ALIGNS.slice(0, 3))))];
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
      case 'html': return [h('textarea', { class: 'code', style: 'min-height:120px', value: b.html || '', oninput: (e) => { b.html = e.target.value; changed(); } })];
      case 'footer': return [richText(b), h('p', { class: 'muted small-note' }, 'התג {{unsubscribe_url}} הוא קישור ההסרה. אם יוסר, המערכת תוסיף קישור הסרה אוטומטית.')];
      default: return [];
    }
  }

  const visibility = (b) => h('div', { class: 'row vis' },
    check(b, 'hideMobile', 'להסתיר בנייד', () => { if (b.hideMobile) b.hideDesktop = false; drawBlocks(); }),
    check(b, 'hideDesktop', 'להסתיר במחשב', () => { if (b.hideDesktop) b.hideMobile = false; drawBlocks(); }));

  const list = h('div', { class: 'b-side' });
  let dragFrom = null;
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
      return h('section', { class: 'block' + (b.hideMobile || b.hideDesktop ? ' partial' : ''),
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
          ondragend: () => { dragFrom = null; list.querySelectorAll('.drop').forEach((el) => el.classList.remove('drop')); } }, h('span', { class: 'grip' }, '⠿'), h('b', {}, title), b.hideMobile ? h('span', { class: 'tag' }, 'מחשב בלבד') : null, b.hideDesktop ? h('span', { class: 'tag' }, 'נייד בלבד') : null,
          tool('▲', 'העבר למעלה', () => move(-1)), tool('▼', 'העבר למטה', () => move(1)),
          tool('שכפל', 'שכפול הבלוק', () => { design.blocks.splice(i + 1, 0, clone(b)); drawBlocks(); changed(); }), saveBtn,
          tool('מחק', 'מחיקת הבלוק', () => { design.blocks.splice(i, 1); drawBlocks(); changed(); }, 'small danger')),
        h('div', { class: 'body' }, body));
    }));
    if (!design.blocks.length) list.append(h('p', { class: 'muted' }, 'אין בלוקים. הוסף בלוק מהכפתורים למעלה.'));
  }
  const insertAt = () => { const f = design.blocks.findIndex((b) => b.type === 'footer'); return f >= 0 ? f : design.blocks.length; };

  const settingsBox = h('div', { class: 'card', style: 'margin:0' });
  function drawSettings() {
    const s = design.settings;
    settingsBox.replaceChildren(h('div', { class: 'row' }, h('h2', { class: 'grow', style: 'margin:0' }, 'עיצוב כללי'), undoBtn, redoBtn), h('div', { class: 'fields', style: 'margin-top:10px' },
      field('גופן', select(s, 'font', FONTS)), field('גודל טקסט', input(s, 'fontSize', 'number', { min: 10, max: 30 })),
      field('גודל טקסט בנייד (0 = זהה)', input(s, 'mobileFontSize', 'number', { min: 0, max: 30 })),
      field('רוחב', input(s, 'width', 'number', { min: 320, max: 800 })), field('כיוון', select(s, 'dir', [['rtl', 'ימין לשמאל'], ['ltr', 'שמאל לימין']])),
      field('רקע חיצוני', input(s, 'bg', 'color')), field('רקע התוכן', input(s, 'contentBg', 'color')),
      field('צבע טקסט', input(s, 'color', 'color')), field('צבע קישורים', input(s, 'link', 'color')),
      field('רקע כפתורים', input(s, 'btnBg', 'color')), field('טקסט כפתורים', input(s, 'btnColor', 'color')),
      field('עיגול כפתורים', input(s, 'btnRadius', 'number', { min: 0, max: 40 }))),
    saveBrand ? h('div', { style: 'margin-top:10px' }, h('button', { type: 'button', class: 'small', title: 'גליונות חדשים ייפתחו עם העיצוב הזה',
      onclick: async () => { await saveBrand(design.settings); notify('ערכת המותג נשמרה. גליונות חדשים ייפתחו איתה.'); } }, 'שמור כערכת המותג')) : null);
  }

  const palette = h('div', { class: 'card', style: 'margin:0' });
  function drawPalette() {
    palette.replaceChildren(...[h('h2', {}, 'הוספת בלוק'), h('div', { class: 'palette' },
      Object.keys(BLOCK_DEFAULTS).map((t) => h('button', { type: 'button', onclick: () => {
        const b = BLOCK_DEFAULTS[t]();
        if (t === 'button') { delete b.bg; delete b.color; delete b.radius; }
        design.blocks.splice(t === 'footer' ? design.blocks.length : insertAt(), 0, b);
        drawBlocks(); changed();
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

  const frame = h('iframe', { title: 'תצוגה מקדימה', sandbox: '' });
  const frameWrap = h('div', { class: 'preview-frame' }, frame);
  const modeBtn = (text, fn) => h('button', { type: 'button', class: 'small', onclick: fn }, text);
  const preview = h('div', { class: 'preview-wrap' }, h('div', { class: 'row', style: 'margin-bottom:8px' },
    h('b', { class: 'grow' }, 'תצוגה מקדימה'), modeBtn('מחשב', () => frameWrap.classList.remove('mobile')), modeBtn('נייד', () => frameWrap.classList.add('mobile')),
    modeBtn('מצב כהה', () => frameWrap.classList.toggle('dark'))), frameWrap,
  h('p', { class: 'muted small-note' }, 'מצב כהה הוא הדמיה בלבד. כל תוכנת דואר הופכת צבעים בדרך משלה.'));

  function refresh() {
    frame.srcdoc = renderDesign(design, { ...meta(), synced: syncedMap() })
      .replace(/\{\{(name)\}\}/g, 'ישראל ישראלי').replace(/\{\{first_name\}\}/g, 'ישראל').replace(/\{\{email\}\}/g, 'name@example.com').replace(/\{\{\w+\}\}/g, '#');
  }
  function drawAll() { drawSettings(); drawPalette(); drawBlocks(); syncHistButtons(); refresh(); }

  container.replaceChildren(h('div', { class: 'builder' }, h('div', { class: 'b-side' }, settingsBox, palette, list), preview));
  drawAll();
  return { getDesign: () => design, refresh, syncedMap };
}
