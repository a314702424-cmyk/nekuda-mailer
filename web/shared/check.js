// בדיקה לפני שליחה. משותף לשרת ולדפדפן.
import { htmlToText } from './render.js';

const KNOWN_TAGS = ['name', 'first_name', 'email', 'unsubscribe_url', 'webview_url', 'BASE', 'TOKEN'];
const GMAIL_CLIP = 102 * 1024;

export function extractLinks(html) {
  const out = new Set();
  for (const m of String(html || '').matchAll(/<a\s[^>]*?href\s*=\s*"(https?:\/\/[^"]+)"/gi)) out.add(m[1].replace(/&amp;/g, '&'));
  return [...out];
}

/** מחזיר { issues:[{level:'error'|'warn'|'info', text}], stats }. */
const lum = (hex) => {
  const h = String(hex || '').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** יחס ניגודיות לפי WCAG, בין 1 ל-21. */
export function contrast(a, b) {
  const x = lum(a); const y = lum(b);
  if (x === null || y === null) return 21;
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export function checkEmail({ subject = '', preheader = '', html = '', hasLists = true, fromEmail = 'x', design = null } = {}) {
  const issues = [];
  const add = (level, text) => issues.push({ level, text });
  const body = String(html || '');
  const bytes = new TextEncoder().encode(body).length;
  const text = htmlToText(body).replace(/\( https?:\/\/\S+ \)/g, '');
  const textChars = text.replace(/\s+/g, '').length;

  if (!subject.trim()) add('error', 'חסרה שורת נושא.');
  else if (subject.length > 70) add('warn', `שורת הנושא ארוכה (${subject.length} תווים). בנייד רואים בערך 40 עד 50.`);
  if (/!{2,}|\?{3,}/.test(subject)) add('warn', 'סימני קריאה או שאלה כפולים בנושא מעלים את הסיכוי לסינון כספאם.');
  if (!preheader.trim()) add('warn', 'אין תקציר (preheader). תוכנת הדואר תציג במקומו את תחילת הגליון.');
  if (!fromEmail) add('error', 'חסרה כתובת שולח.');
  if (!hasLists) add('error', 'לא נבחרה רשימת תפוצה.');

  const anchors = [...body.matchAll(/<a\s[^>]*?href\s*=\s*"([^"]*)"/gi)].map((m) => m[1].trim());
  const empty = anchors.filter((h) => !h || h === '#' || /^https?:\/\/$/i.test(h)).length;
  if (empty) add('error', `${empty} קישורים ריקים או לא גמורים (כתובת חסרה).`);
  const plain = anchors.filter((h) => /^http:\/\//i.test(h)).length;
  if (plain) add('warn', `${plain} קישורים בלי הצפנה (http). עדיף https.`);

  const imgs = [...body.matchAll(/<img\s[^>]*>/gi)].map((m) => m[0]).filter((t) => !/width="1"\s+height="1"/.test(t));
  const noSrc = imgs.filter((t) => !/src\s*=\s*"[^"]+"/i.test(t)).length;
  if (noSrc) add('error', `${noSrc} תמונות בלי כתובת מקור.`);
  const noAlt = imgs.filter((t) => !/alt\s*=\s*"[^"]+"/i.test(t)).length;
  if (noAlt) add('warn', `${noAlt} תמונות בלי טקסט חלופי (alt). הוא מוצג כשהתמונות חסומות ומשמש קוראי מסך.`);
  if (imgs.some((t) => /src\s*=\s*"http:\/\//i.test(t))) add('warn', 'יש תמונות בכתובת http. חלק מתוכנות הדואר לא יציגו אותן.');

  if (bytes > GMAIL_CLIP) add('error', `ה-HTML שוקל ${Math.round(bytes / 1024)}KB. מעל 102KB בערך Gmail חותך את המייל ומסתיר את קישור ההסרה.`);
  else if (bytes > 80 * 1024) add('warn', `ה-HTML שוקל ${Math.round(bytes / 1024)}KB, קרוב לגבול החיתוך של Gmail (כ-102KB).`);

  if (imgs.length && textChars < 150 * imgs.length && textChars < 400) add('warn', 'הרבה תמונות ומעט טקסט. מיילים כאלה נוטים להסתנן כפרסומת או כספאם.');
  if (!imgs.length && textChars < 40) add('warn', 'הגליון כמעט ריק.');

  const unknown = [...new Set([...body.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).filter((t) => !KNOWN_TAGS.includes(t)))];
  if (unknown.length) add('error', `תגים לא מוכרים שיישלחו ריקים: ${unknown.map((t) => `{{${t}}}`).join(', ')}.`);
  const s = design && design.settings;
  if (s) {
    if (Number(s.fontSize) < 14) add('warn', `גודל הטקסט ${s.fontSize}px קטן לקריאה נוחה. מומלץ 16 ומעלה.`);
    if (Number(s.mobileFontSize) > 0 && Number(s.mobileFontSize) < 14) add('warn', `גודל הטקסט בנייד ${s.mobileFontSize}px קטן מדי.`);
    if (contrast(s.color, s.contentBg) < 4.5) add('warn', 'הניגודיות בין צבע הטקסט לרקע התוכן נמוכה, והטקסט יהיה קשה לקריאה.');
    if (contrast(s.link, s.contentBg) < 3) add('warn', 'צבע הקישורים כמעט לא נבדל מהרקע.');
    for (const b of design.blocks || []) {
      if (b.type === 'button' && contrast(b.color || s.btnColor, b.bg || s.btnBg) < 3) { add('warn', `בכפתור "${b.text}" הטקסט כמעט לא נראה על הרקע.`); break; }
    }
  }
  if (!body.includes('{{unsubscribe_url}}')) add('info', 'אין קישור הסרה בגליון. המערכת תוסיף אחד אוטומטית בתחתית.');

  return { issues, stats: { bytes, links: extractLinks(body).length, images: imgs.length, textChars } };
}
