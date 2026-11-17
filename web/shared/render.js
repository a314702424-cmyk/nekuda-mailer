// מודול משותף לשרת ולדפדפן: הופך עיצוב בלוקים ל-HTML רספונסיבי למייל.

export const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const FONTS = [
  ['Arial, Helvetica, sans-serif', 'Arial'],
  ['Tahoma, Geneva, sans-serif', 'Tahoma'],
  ['Verdana, Geneva, sans-serif', 'Verdana'],
  ["'David', 'Times New Roman', serif", 'David'],
  ["'Times New Roman', Times, serif", 'Times New Roman'],
  ['Georgia, serif', 'Georgia'],
  // גופני רשת בעברית. נטענים מ-Google Fonts. תוכנת דואר שלא תומכת בהם (למשל Gmail) תציג את הגופן החלופי שאחריהם.
  ["'Heebo', Arial, sans-serif", 'Heebo (רשת)', 'Heebo:wght@400;700'],
  ["'Assistant', Arial, sans-serif", 'Assistant (רשת)', 'Assistant:wght@400;700'],
  ["'Rubik', Arial, sans-serif", 'Rubik (רשת)', 'Rubik:wght@400;700'],
  ["'Alef', Arial, sans-serif", 'Alef (רשת)', 'Alef:wght@400;700'],
  ["'Varela Round', Arial, sans-serif", 'Varela Round (רשת)', 'Varela+Round'],
  ["'Secular One', Arial, sans-serif", 'Secular One (רשת, לכותרות)', 'Secular+One'],
  ["'Suez One', Georgia, serif", 'Suez One (רשת, לכותרות)', 'Suez+One'],
  ["'Frank Ruhl Libre', 'Times New Roman', serif", 'Frank Ruhl Libre (רשת)', 'Frank+Ruhl+Libre:wght@400;700'],
  ["'David Libre', 'David', 'Times New Roman', serif", 'David Libre (רשת)', 'David+Libre:wght@400;700'],
];
const fontOk = (v, d) => (FONTS.some((f) => f[0] === v) ? v : d);
/** תגי הטעינה של גופני הרשת שמופיעים ב-HTML בפועל. */
function fontLinks(htmlStr) {
  const used = (f) => new RegExp(`(font-family:|face=")[^;>]*?${f[0].split(',')[0].replace(/'/g, '')}`, 'i').test(htmlStr);
  const fams = FONTS.filter((f) => f[2] && used(f)).map((f) => 'family=' + f[2]);
  return fams.length ? `<link href="https://fonts.googleapis.com/css2?${fams.join('&')}&display=swap" rel="stylesheet">\n` : '';
}

export function defaultDesign() {
  return {
    settings: {
      width: 600, bg: '#eef0f4', contentBg: '#ffffff', font: FONTS[0][0], fontSize: 17,
      color: '#1a1a1a', link: '#1b4fd8', dir: 'rtl',
      mobileFontSize: 0, btnBg: '#1b4fd8', btnColor: '#ffffff', btnRadius: 6, utm: '',
    },
    blocks: [
      { type: 'heading', text: 'כותרת הגליון', level: 1, align: 'center' },
      { type: 'text', html: '<p>שלום {{name}},</p><p>כאן כותבים את תוכן הגליון.</p>', align: 'right' },
      { type: 'button', text: 'לקריאה באתר', href: 'https://', bg: '#1b4fd8', color: '#ffffff', radius: 6, align: 'center' },
      { type: 'footer', html: '<p>קיבלת מייל זה כי נרשמת לרשימת התפוצה שלנו.<br><a href="{{unsubscribe_url}}">להסרה מרשימת התפוצה</a> · <a href="{{webview_url}}">לצפייה בדפדפן</a></p>' },
    ],
  };
}

/** תבנית "מכתב אישי": טקסט פשוט בלי עיצוב כבד. */
export function letterDesign() {
  const d = defaultDesign();
  d.settings.bg = '#ffffff';
  d.blocks = [
    { type: 'text', html: '<p>שלום {{first_name}},</p><p>כאן כותבים את המכתב, בשפה פשוטה ואישית.</p><p>בברכה,<br>נקודה הוצאה לאור</p>', align: 'right' },
    { type: 'footer', html: '<p><a href="{{unsubscribe_url}}">להסרה מרשימת התפוצה</a></p>' },
  ];
  return d;
}

/** תבנית "גליון מלא": כותרת, דבר המערכת, מדורים וקריאה לפעולה. */
export function newsletterDesign() {
  const d = defaultDesign();
  d.blocks = [
    { type: 'menu', align: 'center', links: [{ label: 'גליון מספר', href: '{{webview_url}}' }, { label: 'דף הבית', href: 'https://nekuda.org.il/' }] },
    { type: 'heading', text: 'דבר המערכת', level: 1, align: 'center' },
    { type: 'text', html: '<p>שלום {{first_name}},</p><p>פתיחה קצרה: על מה הגליון הזה ולמה כדאי לקרוא אותו.</p>', align: 'justify' },
    { type: 'divider', color: '#d9dce3' },
    { type: 'heading', text: 'שם המדור', level: 2, align: 'center' },
    { type: 'text', html: '<p>תוכן המדור.</p>', align: 'justify' },
    { type: 'divider', color: '#d9dce3' },
    { type: 'heading', text: 'מדור נוסף', level: 2, align: 'center' },
    { type: 'text', html: '<p>תוכן המדור.</p>', align: 'justify' },
    { type: 'button', text: 'יש לך שאלה? כתוב לנו', href: 'https://', align: 'center' },
    { type: 'footer', html: '<p>קיבלת מייל זה כי נרשמת לרשימת התפוצה שלנו.<br><a href="{{unsubscribe_url}}">להסרה מרשימת התפוצה</a> · <a href="{{webview_url}}">לצפייה בדפדפן</a></p>' },
  ];
  return d;
}

export const youtubeThumb = (url) => {
  const m = /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{6,})/.exec(String(url || ''));
  return m ? `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg` : '';
};

export const BLOCK_DEFAULTS = {
  heading: () => ({ type: 'heading', text: 'כותרת', level: 2, align: 'right' }),
  text: () => ({ type: 'text', html: '<p>טקסט</p>', align: 'right' }),
  image: () => ({ type: 'image', src: '', alt: '', href: '', widthPct: 100, align: 'center', fullBleed: false }),
  button: () => ({ type: 'button', text: 'לחץ כאן', href: 'https://', bg: '#1b4fd8', color: '#ffffff', radius: 6, align: 'center' }),
  columns: () => ({ type: 'columns', cols: [{ src: '', alt: '', html: '<p>טור ימני</p>' }, { src: '', alt: '', html: '<p>טור שמאלי</p>' }] }),
  divider: () => ({ type: 'divider', color: '#d9dce3' }),
  spacer: () => ({ type: 'spacer', height: 24 }),
  social: () => ({ type: 'social', align: 'center', links: [{ label: 'האתר שלנו', href: 'https://' }, { label: 'פייסבוק', href: '' }, { label: 'וואטסאפ', href: '' }] }),
  menu: () => ({ type: 'menu', align: 'center', links: [{ label: 'דף הבית', href: 'https://' }, { label: 'צור קשר', href: 'https://' }] }),
  video: () => ({ type: 'video', url: '', thumb: '', caption: 'לצפייה בסרטון' }),
  poll: () => ({ type: 'poll', pid: Math.random().toString(36).slice(2, 10), question: 'מה דעתך על הגליון?', options: ['מצוין', 'טוב', 'אפשר לשפר'] }),
  html: () => ({ type: 'html', html: '<p>קוד HTML חופשי</p>' }),
  footer: () => ({ type: 'footer', html: '<p><a href="{{unsubscribe_url}}">להסרה מרשימת התפוצה</a></p>' }),
};

const color = (v, d) => (/^#[0-9a-f]{3,8}$/i.test(v || '') ? v : d);
const num = (v, d, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
const alignOf = (v, d = 'right') => (['right', 'center', 'left', 'justify'].includes(v) ? v : d);

function inlineRich(htmlStr, s, extraP = '') {
  return String(htmlStr || '')
    .replace(/<p(\s[^>]*)?>/gi, (m, a = '') => (/style\s*=/i.test(a) ? m : `<p${a} style="margin:0 0 1em 0;${extraP}">`))
    .replace(/<a(\s[^>]*)?>/gi, (m, a = '') => (/style\s*=/i.test(a) ? m : `<a${a} style="color:${s.link};text-decoration:underline;">`))
    .replace(/<img(\s[^>]*)?>/gi, (m, a = '') => (/style\s*=/i.test(a) ? m : `<img${a} style="max-width:100%;height:auto;border:0;">`));
}

function imgTag(src, alt, px, pct) {
  return `<img src="${esc(src)}" alt="${esc(alt)}" width="${px}" style="display:block;width:${pct}%;max-width:${px}px;height:auto;border:0;outline:none;text-decoration:none;">`;
}

function renderBlock(b, s) {
  const base = `font-family:${s.font};color:${s.color};`;
  const pad = 'padding:14px 24px;';
  switch (b.type) {
    case 'heading': {
      const level = num(b.level, 2, 1, 3);
      const size = num(b.size, [0, 30, 24, 20][level], 12, 60);
      return `<tr><td class="pad${level === 1 ? ' h1' : ''}" align="${alignOf(b.align)}" style="${pad}font-family:${s.headingFont || s.font};font-size:${size}px;line-height:1.3;font-weight:bold;text-align:${alignOf(b.align)};color:${color(b.color, s.color)};">${esc(b.text)}</td></tr>`;
    }
    case 'text':
      return `<tr><td class="pad txt" align="${alignOf(b.align)}" style="${pad}${base}font-size:${s.fontSize}px;line-height:1.6;text-align:${alignOf(b.align)};">${inlineRich(b.html, s)}</td></tr>`;
    case 'image': {
      if (!b.src) return '';
      const pct = num(b.widthPct, 100, 10, 100);
      const inner = b.fullBleed ? s.width : s.width - 48;
      const px = Math.round(inner * pct / 100);
      const al = alignOf(b.align, 'center');
      let img = imgTag(b.src, b.alt, px, 100);
      if (b.href && b.href !== 'https://') img = `<a href="${esc(b.href)}" target="_blank" style="text-decoration:none;">${img}</a>`;
      const cell = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${al}" width="${px}" style="width:${pct}%;max-width:${px}px;"><tr><td>${img}</td></tr></table>`;
      return `<tr><td class="${b.fullBleed ? '' : 'pad'}" align="${al}" style="${b.fullBleed ? 'padding:0;' : pad}">${cell}</td></tr>`;
    }
    case 'button': {
      const bg = color(b.bg, s.btnBg);
      const fg = color(b.color, s.btnColor);
      const r = num(b.radius, s.btnRadius, 0, 40);
      const al = alignOf(b.align, 'center');
      const [padY, padX, fs] = { s: [8, 18, 14], l: [16, 36, 19] }[b.size] || [12, 26, 16];
      const full = b.full ? ' width="100%"' : '';
      return `<tr><td class="pad" align="${al}" style="${pad}"><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${al}"${full}${b.full ? ' style="width:100%;"' : ''}><tr><td bgcolor="${bg}" align="center" style="background:${bg};border-radius:${r}px;text-align:center;"><a href="${esc(b.href)}" target="_blank" style="display:block;padding:${padY}px ${padX}px;font-family:${s.font};font-size:${fs}px;font-weight:bold;color:${fg};text-decoration:none;border-radius:${r}px;">${esc(b.text)}</a></td></tr></table></td></tr>`;
    }
    case 'columns': {
      const colW = Math.floor((s.width - 48) / 2) - 12;
      const cells = (b.cols || []).slice(0, 2).map((c, i) => {
        const img = c.src ? `<div style="margin:0 0 10px 0;">${imgTag(c.src, c.alt, colW, 100)}</div>` : '';
        const cls = b.reverseMobile ? (i === 0 ? 'colA' : 'colB') : 'col';
        return `<td class="${cls} txt" width="50%" valign="top" style="width:50%;padding:0 6px 12px 6px;${base}font-size:${s.fontSize}px;line-height:1.6;text-align:right;">${img}${inlineRich(c.html, s)}</td>`;
      }).join('');
      return `<tr><td class="pad" style="padding:14px 18px;"><table role="presentation" class="${b.reverseMobile ? 'revt' : ''}" width="100%" cellpadding="0" cellspacing="0" border="0" dir="${s.dir}"><tr>${cells}</tr></table></td></tr>`;
    }
    case 'divider':
      return `<tr><td class="pad" style="padding:8px 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid ${color(b.color, '#d9dce3')};font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>`;
    case 'spacer': {
      const hgt = num(b.height, 24, 4, 200);
      return `<tr><td style="height:${hgt}px;font-size:0;line-height:${hgt}px;">&nbsp;</td></tr>`;
    }
    case 'social': {
      const links = (b.links || []).filter((l) => l.href && l.href !== 'https://' && l.label);
      if (!links.length) return '';
      const al = alignOf(b.align, 'center');
      return `<tr><td class="pad" align="${al}" style="${pad}text-align:${al};">${links.map((l) => `<a href="${esc(l.href)}" target="_blank" style="display:inline-block;margin:0 3px 6px 3px;padding:7px 16px;border:1px solid ${s.link};border-radius:99px;font-family:${s.font};font-size:14px;color:${s.link};text-decoration:none;">${esc(l.label)}</a>`).join('')}</td></tr>`;
    }
    case 'menu': {
      const links = (b.links || []).filter((l) => l.href && l.href !== 'https://' && l.label);
      if (!links.length) return '';
      const al = alignOf(b.align, 'center');
      return `<tr><td class="pad" align="${al}" style="padding:10px 24px;${base}font-size:15px;font-weight:bold;text-align:${al};">${links.map((l) => `<a href="${esc(l.href)}" target="_blank" style="color:${s.link};text-decoration:none;">${esc(l.label)}</a>`).join(' &nbsp;·&nbsp; ')}</td></tr>`;
    }
    case 'video': {
      if (!b.url) return '';
      const thumb = b.thumb || youtubeThumb(b.url);
      const px = s.width - 48;
      const cap = `<a href="${esc(b.url)}" target="_blank" style="font-family:${s.font};font-size:${s.fontSize}px;font-weight:bold;color:${s.link};text-decoration:none;">&#9654; ${esc(b.caption || 'לצפייה בסרטון')}</a>`;
      const pic = thumb ? `<a href="${esc(b.url)}" target="_blank" style="text-decoration:none;">${imgTag(thumb, b.caption || 'סרטון', px, 100)}</a><div style="height:10px;line-height:10px;font-size:0;">&nbsp;</div>` : '';
      return `<tr><td class="pad" align="center" style="${pad}text-align:center;">${pic}${cap}</td></tr>`;
    }
    case 'poll': {
      const pid = /^[a-z0-9]{4,12}$/.test(b.pid || '') ? b.pid : '';
      const opts = (b.options || []).map((o) => String(o || '').trim()).filter(Boolean).slice(0, 6);
      if (!pid || !opts.length) return '';
      const btns = opts.map((o, i) => `<a href="{{BASE}}/poll/{{TOKEN}}/${pid}/${i}" target="_blank" style="display:inline-block;margin:0 4px 8px 4px;padding:9px 18px;border:2px solid ${s.btnBg};border-radius:${s.btnRadius}px;font-family:${s.font};font-size:15px;font-weight:bold;color:${s.btnBg};text-decoration:none;">${esc(o)}</a>`).join('');
      return `<tr><td class="pad" align="center" style="${pad}${base}text-align:center;"><div style="font-size:${s.fontSize + 1}px;font-weight:bold;line-height:1.5;margin:0 0 12px 0;">${esc(b.question)}</div>${btns}</td></tr>`;
    }
    case 'html':
      return `<tr><td class="pad txt" style="${pad}${base}font-size:${s.fontSize}px;line-height:1.6;">${b.html || ''}</td></tr>`;
    case 'footer':
      return `<tr><td class="pad" align="center" style="${pad}font-family:${s.font};font-size:13px;line-height:1.6;color:#6b7280;text-align:center;">${inlineRich(b.html, { ...s, link: '#6b7280' })}</td></tr>`;
    default:
      return '';
  }
}

function renderOne(b, s, synced, depth = 0) {
  if (!b) return '';
  if (b.type === 'synced') return depth > 2 ? '' : renderOne(synced && synced[b.ref], s, synced, depth + 1);
  let row = renderBlock(b, s);
  if (!row) return '';
  const blockBg = color(b.blockBg, '');
  if (blockBg && ['heading', 'text', 'image', 'button', 'columns', 'menu', 'social', 'video', 'footer'].includes(b.type)) {
    row = row.replace(/^<tr><td([^>]*?)style="/, `<tr><td$1bgcolor="${blockBg}" style="background:${blockBg};`);
  }
  if (b.hideMobile) row = row.replace(/^<tr/, '<tr class="hm"');
  else if (b.hideDesktop) row = row.replace(/^<tr/, '<tr class="hd" style="display:none;mso-hide:all;"');
  // תנאי תצוגה: הבלוק נשלח רק לחברי רשימה מסוימת, או רק למי שאינו חבר בה. השרת מסנן לפי הנמען
  const onlyList = Number(b.onlyList) || 0;
  if (onlyList > 0) row = `<!--nm-if:${b.notInList ? '!' : ''}L${onlyList}-->${row}<!--nm-end-->`;
  return row;
}

export function renderDesign(design, { subject = '', preheader = '', synced = null, editor = false } = {}) {
  const d = design && design.settings ? design : defaultDesign();
  const s = { ...defaultDesign().settings, ...d.settings };
  s.width = num(s.width, 600, 320, 800);
  s.fontSize = num(s.fontSize, 17, 10, 30);
  s.bg = color(s.bg, '#eef0f4'); s.contentBg = color(s.contentBg, '#ffffff');
  s.color = color(s.color, '#1a1a1a'); s.link = color(s.link, '#1b4fd8');
  s.dir = s.dir === 'ltr' ? 'ltr' : 'rtl';
  s.btnBg = color(s.btnBg, '#1b4fd8'); s.btnColor = color(s.btnColor, '#ffffff'); s.btnRadius = num(s.btnRadius, 6, 0, 40);
  const mfs = num(s.mobileFontSize, 0, 0, 30);
  s.font = fontOk(s.font, FONTS[0][0]);
  s.headingFont = s.headingFont ? fontOk(s.headingFont, '') : '';
  // במצב עריכה כל בלוק מסומן במספרו, כדי שלחיצה עליו בתצוגה המקדימה תפתח אותו לעריכה
  const rows = (d.blocks || []).map((b, i) => { const r = renderOne(b, s, synced); return editor && r ? r.replace(/<tr/, `<tr data-b="${i}"`) : r; }).join('\n');
  // הריפוד אחרי התקציר מונע מתוכנת הדואר למשוך טקסט מגוף המייל לשורת התצוגה המקדימה
  const pre = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:${s.bg};">${esc(preheader)}${'&#847;&zwnj;&nbsp;'.repeat(70)}</div>` : '';
  const out = `<!DOCTYPE html>
<html lang="${s.dir === 'rtl' ? 'he' : 'en'}" dir="${s.dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${esc(subject)}</title>
<style>
body{margin:0;padding:0;}
table{border-collapse:collapse;}
img{border:0;}
@media only screen and (max-width:${s.width + 20}px){
  .wrap{width:100% !important;}
  .col{display:block !important;width:100% !important;box-sizing:border-box;}
  .pad{padding-left:16px !important;padding-right:16px !important;}
  .h1{font-size:25px !important;}
  .hm{display:none !important;}
  .hd{display:table-row !important;}
  .revt{display:table !important;width:100% !important;}
  .colA{display:table-footer-group !important;width:100% !important;}
  .colB{display:table-header-group !important;width:100% !important;}${mfs ? `\n  .txt{font-size:${mfs}px !important;}` : ''}
}
</style>
</head>
<body style="margin:0;padding:0;background:${s.bg};">
${pre}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${s.bg}" style="background:${s.bg};">
<tr><td align="center" style="padding:16px 8px;">
<table role="presentation" class="wrap" width="${s.width}" cellpadding="0" cellspacing="0" border="0" dir="${s.dir}" bgcolor="${s.contentBg}" style="width:${s.width}px;max-width:100%;background:${s.contentBg};">
${rows}
</table>
</td></tr>
</table>
</body>
</html>`;
  const links = fontLinks(out);
  // בתצוגת העריכה הקישור לגופנים בסוף הגוף, כדי שתצוגה מקדימה לא תיתקע אם Google Fonts חסום או איטי
  return editor ? out.replace('</body>', links + '</body>') : out.replace('<style>', links + '<style>');
}

const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", middot: '·', ndash: '–', mdash: '—' };

export function htmlToText(htmlStr) {
  return String(htmlStr || '')
    .replace(/<(style|script|head|title)[\s\S]*?<\/\1>/gi, '')
    .replace(/<div style="display:none[\s\S]*?<\/div>/gi, '')
    .replace(/<a\s[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, text) => {
      const t = text.replace(/<[^>]+>/g, '').trim();
      if (!t) return '';
      return /^mailto:/i.test(href) || t === href ? t : `${t} ( ${href} )`;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#?\w+);/g, (m, e) => ENT[e] ?? (e[0] === '#' ? String.fromCodePoint(Number(e.slice(1)) || 32) : m))
    .replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n').trim();
}
