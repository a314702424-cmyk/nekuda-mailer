import { renderDesign, BLOCK_DEFAULTS, FONTS } from './shared/render.js';

const LABELS = { heading: 'כותרת', text: 'טקסט', image: 'תמונה', button: 'כפתור', columns: 'שני טורים', divider: 'קו מפריד', spacer: 'רווח', footer: 'תחתית' };
const ALIGNS = [['right', 'ימין'], ['center', 'מרכז'], ['left', 'שמאל'], ['justify', 'מיושר']];

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

/** מרכיב את בונה הגליונות בתוך container. מחזיר { getDesign, refresh }. */
export function mountBuilder(container, design, { upload, meta, onChange }) {
  let timer = 0;
  const changed = () => { clearTimeout(timer); timer = setTimeout(refresh, 250); onChange?.(); };

  const input = (obj, key, type = 'text', extra = {}) => h('input', {
    type, value: obj[key] ?? '', ...extra,
    oninput: (e) => { obj[key] = type === 'number' ? Number(e.target.value) : e.target.value; changed(); },
  });
  const select = (obj, key, options) => h('select', { onchange: (e) => { obj[key] = e.target.value; changed(); } },
    options.map(([v, t]) => h('option', { value: v, selected: String(obj[key]) === String(v) }, t)));
  const check = (obj, key, text) => h('label', { style: 'display:flex;gap:6px;align-items:center;color:inherit' },
    h('input', { type: 'checkbox', checked: !!obj[key], onchange: (e) => { obj[key] = e.target.checked; changed(); } }), text);

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
      btn('נקה עיצוב', 'הסרת עיצוב', () => run('removeFormat')));
    return h('div', {}, tools, area);
  }

  function blockBody(b) {
    switch (b.type) {
      case 'heading': return [field('טקסט הכותרת', input(b, 'text')), h('div', { class: 'fields' },
        field('רמה', select(b, 'level', [[1, 'ראשית'], [2, 'משנית'], [3, 'קטנה']])), field('יישור', select(b, 'align', ALIGNS.slice(0, 3))),
        field('צבע', input(b, 'color', 'color', { value: b.color || design.settings.color })))];
      case 'text': return [richText(b), h('div', { class: 'fields' }, field('יישור', select(b, 'align', ALIGNS)))];
      case 'image': return [field('תמונה', imageField(b)), h('div', { class: 'fields' },
        field('טקסט חלופי', input(b, 'alt')), field('קישור בלחיצה', input(b, 'href', 'url', { class: 'ltr' })),
        field('רוחב באחוזים', input(b, 'widthPct', 'number', { min: 10, max: 100 })), field('יישור', select(b, 'align', ALIGNS.slice(0, 3))),
        check(b, 'fullBleed', 'מקצה לקצה'))];
      case 'button': return [h('div', { class: 'fields' }, field('טקסט', input(b, 'text')), field('קישור', input(b, 'href', 'url', { class: 'ltr' })),
        field('צבע רקע', input(b, 'bg', 'color')), field('צבע טקסט', input(b, 'color', 'color')),
        field('עיגול פינות', input(b, 'radius', 'number', { min: 0, max: 40 })), field('יישור', select(b, 'align', ALIGNS.slice(0, 3))))];
      case 'columns': return b.cols.map((c, i) => h('div', { style: 'margin-bottom:10px' }, h('label', {}, i === 0 ? 'טור ימני' : 'טור שמאלי'), imageField(c), richText(c)));
      case 'divider': return [h('div', { class: 'fields' }, field('צבע הקו', input(b, 'color', 'color')))];
      case 'spacer': return [h('div', { class: 'fields' }, field('גובה בפיקסלים', input(b, 'height', 'number', { min: 4, max: 200 })))];
      case 'footer': return [richText(b), h('p', { class: 'muted', style: 'font-size:13px;margin:6px 0 0' }, 'התג {{unsubscribe_url}} הוא קישור ההסרה. אם יוסר, המערכת תוסיף קישור הסרה אוטומטית.')];
      default: return [];
    }
  }

  const list = h('div', { class: 'b-side' });
  function drawBlocks() {
    list.replaceChildren(...design.blocks.map((b, i) => {
      const move = (d) => { const j = i + d; if (j < 0 || j >= design.blocks.length) return; [design.blocks[i], design.blocks[j]] = [design.blocks[j], design.blocks[i]]; drawBlocks(); changed(); };
      const tool = (text, title, fn, cls = 'small') => h('button', { type: 'button', class: cls, title, onclick: fn }, text);
      return h('section', { class: 'block' },
        h('header', {}, h('b', {}, LABELS[b.type] || b.type),
          tool('▲', 'העבר למעלה', () => move(-1)), tool('▼', 'העבר למטה', () => move(1)),
          tool('שכפל', 'שכפול הבלוק', () => { design.blocks.splice(i + 1, 0, JSON.parse(JSON.stringify(b))); drawBlocks(); changed(); }),
          tool('מחק', 'מחיקת הבלוק', () => { design.blocks.splice(i, 1); drawBlocks(); changed(); }, 'small danger')),
        h('div', { class: 'body' }, blockBody(b)));
    }));
    if (!design.blocks.length) list.append(h('p', { class: 'muted' }, 'אין בלוקים. הוסף בלוק מהכפתורים למעלה.'));
  }

  const s = design.settings;
  const settings = h('div', { class: 'card', style: 'margin:0' }, h('h2', {}, 'עיצוב כללי'), h('div', { class: 'fields' },
    field('גופן', select(s, 'font', FONTS)), field('גודל טקסט', input(s, 'fontSize', 'number', { min: 10, max: 30 })),
    field('רוחב', input(s, 'width', 'number', { min: 320, max: 800 })), field('כיוון', select(s, 'dir', [['rtl', 'ימין לשמאל'], ['ltr', 'שמאל לימין']])),
    field('רקע חיצוני', input(s, 'bg', 'color')), field('רקע התוכן', input(s, 'contentBg', 'color')),
    field('צבע טקסט', input(s, 'color', 'color')), field('צבע קישורים', input(s, 'link', 'color'))));

  const palette = h('div', { class: 'card', style: 'margin:0' }, h('h2', {}, 'הוספת בלוק'), h('div', { class: 'palette' },
    Object.keys(BLOCK_DEFAULTS).map((t) => h('button', { type: 'button', onclick: () => {
      const footerAt = design.blocks.findIndex((b) => b.type === 'footer');
      const at = t !== 'footer' && footerAt >= 0 ? footerAt : design.blocks.length;
      design.blocks.splice(at, 0, BLOCK_DEFAULTS[t]());
      drawBlocks(); changed();
    } }, '+ ' + LABELS[t]))));

  const frame = h('iframe', { title: 'תצוגה מקדימה', sandbox: '' });
  const frameWrap = h('div', { class: 'preview-frame' }, frame);
  const modeBtn = (text, mobile) => h('button', { type: 'button', class: 'small', onclick: () => frameWrap.classList.toggle('mobile', mobile) }, text);
  const preview = h('div', { class: 'preview-wrap' }, h('div', { class: 'row', style: 'margin-bottom:8px' },
    h('b', { class: 'grow' }, 'תצוגה מקדימה'), modeBtn('מחשב', false), modeBtn('נייד', true)), frameWrap);

  function refresh() {
    const m = meta();
    frame.srcdoc = renderDesign(design, m)
      .replace(/\{\{(name|first_name)\}\}/g, 'ישראל ישראלי').replace(/\{\{email\}\}/g, 'name@example.com').replace(/\{\{\w+\}\}/g, '#');
  }

  container.replaceChildren(h('div', { class: 'builder' }, h('div', { class: 'b-side' }, settings, palette, list), preview));
  drawBlocks();
  refresh();
  return { getDesign: () => design, refresh };
}
