// ייבוא גליונות מהמערכת הישנה (AcyMailing על Joomla), דרך הארכיון הציבורי שלה. בלי סיסמאות ובלי גישה למסד הנתונים הישן.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
const MONTHS = { ינואר: 1, פברואר: 2, מרס: 3, מרץ: 3, אפריל: 4, מאי: 5, יוני: 6, יולי: 7, אוגוסט: 8, ספטמבר: 9, אוקטובר: 10, נובמבר: 11, דצמבר: 12 };

/** "נשלח ב 24 אוקטובר 2026" → זמן יוניקס (צהרי אותו יום, כדי שהתאריך לא יזוז בגלל אזור זמן). */
export function parseHebrewDate(text) {
  const m = /(\d{1,2})\s+([א-ת]+)\s+(\d{4})/.exec(String(text || ''));
  if (!m || !MONTHS[m[2]]) return 0;
  return Math.floor(Date.UTC(Number(m[3]), MONTHS[m[2]] - 1, Number(m[1]), 10, 0, 0) / 1000);
}

/** בודק שכתובת מותרת לשליפה: http או https, ולא כתובת פנימית של השרת עצמו. */
export function safeUrl(input, base) {
  let u;
  try { u = new URL(input, base); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const h = u.hostname.toLowerCase();
  const local = h === 'localhost' || h.endsWith('.local') || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?f[cd])/.test(h);
  if (local && process.env.NM_ALLOW_LOCAL !== '1') return null;
  return u;
}

async function get(url, { binary = false, max = 3_000_000 } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'follow', headers: { 'User-Agent': 'nekuda-mailer-import' } });
  if (!res.ok) throw new Error(`האתר הישן החזיר שגיאה ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > max) throw new Error('התשובה מהאתר הישן גדולה מדי');
  return binary ? { buf, type: String(res.headers.get('content-type') || '') } : buf.toString('utf8');
}

/** מחלץ את רשימת הגליונות מדף ארכיון אחד של AcyMailing. */
export function parseListing(html, base) {
  const out = [];
  const rx = /<a\b([^>]*)>([\s\S]*?)<\/a>\s*(?:<\/span>)?\s*(?:<span[^>]*class="[^"]*sentondate[^"]*"[^>]*>([\s\S]*?)<\/span>)?/gi;
  let m;
  while ((m = rx.exec(html))) {
    const attrs = decode(m[1]);
    // הקישור לגליון נמצא ב-onclick (חלון קופץ) או ב-href. המזהה מופיע כ-mailid-200 בנתיב או כ-mailid=200 בפרמטר
    const link = /((?:https?:\/\/|\/|index\.php)[^'"\s,)]*mailid[-=](\d+)[^'"\s,)]*)/i.exec(attrs);
    if (!link) continue;
    const u = safeUrl(link[1], base);
    if (!u || u.host !== new URL(base).host) continue;
    u.searchParams.set('tmpl', 'component');
    const subject = decode(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (!subject) continue;
    out.push({ id: Number(link[2]), subject, at: parseHebrewDate(decode(m[3] || '')), url: u.toString() });
  }
  return out;
}

/** סורק את כל דפי הארכיון ומחזיר רשימה בלי כפילויות, מהחדש לישן. */
export async function scanArchive(archiveUrl) {
  const start = safeUrl(archiveUrl);
  if (!start) throw new Error('כתובת הארכיון לא תקינה');
  const seen = new Map();
  for (let page = 0; page < 15; page++) {
    const u = new URL(start);
    u.searchParams.set('limit', '100');
    u.searchParams.set('limitstart', String(page * 100));
    const items = parseListing(await get(u.toString()), start.toString());
    const before = seen.size;
    for (const it of items) if (!seen.has(it.id)) seen.set(it.id, it);
    if (seen.size === before || items.length < 100) break;
  }
  return [...seen.values()].sort((a, b) => (b.at - a.at) || (b.id - a.id));
}

/** מחלץ את תוכן האלמנט שה-id שלו נתון, כולל אלמנטים מקוננים מאותו סוג. */
function innerOf(html, id) {
  const open = new RegExp(`<(div|td|table)\\b[^>]*\\bid=["']${id}["'][^>]*>`, 'i').exec(html);
  if (!open) return null;
  const tag = open[1].toLowerCase();
  const rx = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  rx.lastIndex = open.index + open[0].length;
  let depth = 1; let m;
  while ((m = rx.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(open.index + open[0].length, m.index);
  }
  return null;
}

/** שולף גליון אחד, מנקה אותו, ומעתיק את התמונות שלו לשרת החדש כדי שלא יהיה תלוי באתר הישן. */
export async function fetchNewsletter(item, { uploadsDir, baseUrl }) {
  const page = await get(item.url);
  let body = innerOf(page, 'newsletter_preview_area');
  if (body === null) body = (/<body[^>]*>([\s\S]*)<\/body>/i.exec(page) || [null, null])[1];
  if (!body || body.replace(/<[^>]+>/g, '').trim().length < 20) throw new Error('לא נמצא תוכן גליון בדף');
  body = body.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<(iframe|object|embed|form)\b[\s\S]*?<\/\1>/gi, '').replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi, '');
  // קישורים ותמונות יחסיים הופכים למלאים, מול האתר הישן
  body = body.replace(/\b(src|href|background)\s*=\s*"([^"]*)"/gi, (m0, attr, val) => {
    const v = decode(val).trim();
    if (!v || /^(#|mailto:|tel:|data:|cid:|\{\{)/i.test(v)) return m0;
    const u = safeUrl(v, item.url);
    return u ? `${attr}="${u.toString().replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"` : `${attr}="#"`;
  });
  let copied = 0;
  const oldHost = new URL(item.url).host;
  const srcs = [...new Set([...body.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => decode(m[1])))].filter((s) => { try { return new URL(s).host === oldHost; } catch { return false; } }).slice(0, 40);
  for (const src of srcs) {
    try {
      const { buf, type } = await get(src, { binary: true, max: 5_000_000 });
      const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }[type.split(';')[0].trim().toLowerCase()];
      if (!ext || !buf.length) continue;
      const name = 'old-' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20) + ext;
      fs.mkdirSync(uploadsDir, { recursive: true });
      if (!fs.existsSync(path.join(uploadsDir, name))) fs.writeFileSync(path.join(uploadsDir, name), buf);
      body = body.split(src.replace(/&/g, '&amp;')).join(`${baseUrl}/media/${name}`).split(src).join(`${baseUrl}/media/${name}`);
      copied++;
    } catch { /* תמונה שלא ירדה נשארת בכתובת הישנה */ }
  }
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const html = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(item.subject)}</title>
<style>body{margin:0;padding:16px;background:#eef0f4;font-family:Arial,Helvetica,sans-serif}.old-wrap{max-width:700px;margin:0 auto;background:#ffffff;padding:16px;border-radius:8px}img{max-width:100%;height:auto}</style></head>
<body><div class="old-wrap" dir="rtl">${body}</div></body>
</html>`;
  return { html, images: copied, missing: srcs.length - copied };
}
