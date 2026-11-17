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
];

export function defaultDesign() {
  return {
    settings: {
      width: 600, bg: '#eef0f4', contentBg: '#ffffff', font: FONTS[0][0], fontSize: 17,
      color: '#1a1a1a', link: '#1b4fd8', dir: 'rtl',
    },
    blocks: [
      { type: 'heading', text: 'כותרת הגליון', level: 1, align: 'center' },
      { type: 'text', html: '<p>שלום {{name}},</p><p>כאן כותבים את תוכן הגליון.</p>', align: 'right' },
      { type: 'button', text: 'לקריאה באתר', href: 'https://', bg: '#1b4fd8', color: '#ffffff', radius: 6, align: 'center' },
      { type: 'footer', html: '<p>קיבלת מייל זה כי נרשמת לרשימת התפוצה שלנו.<br><a href="{{unsubscribe_url}}">להסרה מרשימת התפוצה</a> · <a href="{{webview_url}}">לצפייה בדפדפן</a></p>' },
    ],
  };
}

export const BLOCK_DEFAULTS = {
  heading: () => ({ type: 'heading', text: 'כותרת', level: 2, align: 'right' }),
  text: () => ({ type: 'text', html: '<p>טקסט</p>', align: 'right' }),
  image: () => ({ type: 'image', src: '', alt: '', href: '', widthPct: 100, align: 'center', fullBleed: false }),
  button: () => ({ type: 'button', text: 'לחץ כאן', href: 'https://', bg: '#1b4fd8', color: '#ffffff', radius: 6, align: 'center' }),
  columns: () => ({ type: 'columns', cols: [{ src: '', alt: '', html: '<p>טור ימני</p>' }, { src: '', alt: '', html: '<p>טור שמאלי</p>' }] }),
  divider: () => ({ type: 'divider', color: '#d9dce3' }),
  spacer: () => ({ type: 'spacer', height: 24 }),
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
      return `<tr><td class="pad${level === 1 ? ' h1' : ''}" align="${alignOf(b.align)}" style="${pad}${base}font-size:${size}px;line-height:1.3;font-weight:bold;text-align:${alignOf(b.align)};color:${color(b.color, s.color)};">${esc(b.text)}</td></tr>`;
    }
    case 'text':
      return `<tr><td class="pad" align="${alignOf(b.align)}" style="${pad}${base}font-size:${s.fontSize}px;line-height:1.6;text-align:${alignOf(b.align)};">${inlineRich(b.html, s)}</td></tr>`;
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
      const bg = color(b.bg, '#1b4fd8');
      const r = num(b.radius, 6, 0, 40);
      const al = alignOf(b.align, 'center');
      return `<tr><td class="pad" align="${al}" style="${pad}"><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${al}"><tr><td bgcolor="${bg}" style="background:${bg};border-radius:${r}px;"><a href="${esc(b.href)}" target="_blank" style="display:inline-block;padding:12px 28px;font-family:${s.font};font-size:${s.fontSize}px;font-weight:bold;color:${color(b.color, '#ffffff')};text-decoration:none;border-radius:${r}px;">${esc(b.text)}</a></td></tr></table></td></tr>`;
    }
    case 'columns': {
      const colW = Math.floor((s.width - 48) / 2) - 12;
      const cells = (b.cols || []).slice(0, 2).map((c) => {
        const img = c.src ? `<div style="margin:0 0 10px 0;">${imgTag(c.src, c.alt, colW, 100)}</div>` : '';
        return `<td class="col" width="50%" valign="top" style="width:50%;padding:0 6px 12px 6px;${base}font-size:${s.fontSize}px;line-height:1.6;text-align:right;">${img}${inlineRich(c.html, s)}</td>`;
      }).join('');
      return `<tr><td class="pad" style="padding:14px 18px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="${s.dir}"><tr>${cells}</tr></table></td></tr>`;
    }
    case 'divider':
      return `<tr><td class="pad" style="padding:8px 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid ${color(b.color, '#d9dce3')};font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>`;
    case 'spacer': {
      const hgt = num(b.height, 24, 4, 200);
      return `<tr><td style="height:${hgt}px;font-size:0;line-height:${hgt}px;">&nbsp;</td></tr>`;
    }
    case 'footer':
      return `<tr><td class="pad" align="center" style="${pad}font-family:${s.font};font-size:13px;line-height:1.6;color:#6b7280;text-align:center;">${inlineRich(b.html, { ...s, link: '#6b7280' })}</td></tr>`;
    default:
      return '';
  }
}

export function renderDesign(design, { subject = '', preheader = '' } = {}) {
  const d = design && design.settings ? design : defaultDesign();
  const s = { ...defaultDesign().settings, ...d.settings };
  s.width = num(s.width, 600, 320, 800);
  s.fontSize = num(s.fontSize, 17, 10, 30);
  s.bg = color(s.bg, '#eef0f4'); s.contentBg = color(s.contentBg, '#ffffff');
  s.color = color(s.color, '#1a1a1a'); s.link = color(s.link, '#1b4fd8');
  s.dir = s.dir === 'ltr' ? 'ltr' : 'rtl';
  const rows = (d.blocks || []).map((b) => renderBlock(b, s)).join('\n');
  const pre = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:${s.bg};">${esc(preheader)}</div>` : '';
  return `<!DOCTYPE html>
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
