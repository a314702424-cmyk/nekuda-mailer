import crypto from 'node:crypto';
import { esc, renderDesign, htmlToText } from '../web/shared/render.js';

export function makeToken(secret, campaignId, subscriberId) {
  const body = `${campaignId.toString(36)}.${subscriberId.toString(36)}`;
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url').slice(0, 14);
  return `${body}.${sig}`;
}

export function readToken(secret, token) {
  const m = /^([0-9a-z]+)\.([0-9a-z]+)\.([\w-]{14})$/.exec(String(token || ''));
  if (!m) return null;
  const expected = crypto.createHmac('sha256', secret).update(`${m[1]}.${m[2]}`).digest('base64url').slice(0, 14);
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(m[3]))) return null;
  return { campaignId: parseInt(m[1], 36), subscriberId: parseInt(m[2], 36) };
}

const DEFAULT_FOOTER = (address) => `<div style="padding:16px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;color:#6b7280;text-align:center;" dir="rtl">${address ? esc(address) + '<br>' : ''}<a href="{{unsubscribe_url}}" style="color:#6b7280;">להסרה מרשימת התפוצה</a></div>`;

/** מקבל גליון, מחזיר HTML גולמי (לפני מעקב והתאמה אישית). */
export function syncedBlocks(db) {
  const map = {};
  for (const r of db.all('SELECT id, block FROM saved_blocks WHERE synced=1')) {
    try { map[r.id] = JSON.parse(r.block); } catch { /* מדלגים על בלוק פגום */ }
  }
  return map;
}

function designOf(c) {
  try { return JSON.parse(c.design || 'null'); } catch { return null; } // עיצוב פגום: נשתמש בברירת מחדל
}

export function campaignHtml(c, db) {
  if (c.mode === 'html') return c.html || '';
  return renderDesign(designOf(c), { subject: c.subject, preheader: c.preheader, synced: db ? syncedBlocks(db) : null });
}

/** מוסיף פרמטרי UTM לקישור חיצוני, אם הוגדר שם קמפיין ואין בו כבר UTM. */
export function withUtm(url, utm, baseUrl) {
  if (!utm || /[?&]utm_source=/i.test(url) || (baseUrl && url.startsWith(baseUrl))) return url;
  const i = url.indexOf('#');
  const head = i >= 0 ? url.slice(0, i) : url;
  const hash = i >= 0 ? url.slice(i) : '';
  return `${head}${head.includes('?') ? '&' : '?'}utm_source=newsletter&utm_medium=email&utm_campaign=${encodeURIComponent(utm)}${hash}`;
}

/** מכין תבנית לשליחה: מוסיף קישור הסרה אם חסר, ומחליף קישורים בקישורי מעקב. */
export function prepareCampaign(db, c) {
  let html = campaignHtml(c, db);
  const utm = String(designOf(c)?.settings?.utm || '').trim();
  const baseUrl = db.setting('baseUrl').replace(/\/+$/, '');
  if (!html.includes('{{unsubscribe_url}}')) {
    const footer = DEFAULT_FOOTER(db.setting('companyAddress'));
    html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, footer + '</body>') : html + footer;
  }
  // בגרסת הטקסט שומרים את סימוני התנאים, כדי שבלוק מותנה לא ידלוף למי שלא אמור לראות אותו
  const text = htmlToText(html.replace(/<!--nm-if:(!?L\d+)-->/g, '[[nm-if:$1]]').replace(/<!--nm-end-->/g, '[[nm-end]]'));
  const tracked = html.replace(/(<a\s[^>]*?href\s*=\s*")(https?:\/\/[^"]+)(")/gi, (m, pre, url, post) => {
    const clean = withUtm(url.replace(/&amp;/g, '&'), utm, baseUrl);
    db.run('INSERT OR IGNORE INTO links(campaign_id, url) VALUES(?,?)', c.id, clean);
    const id = db.get('SELECT id FROM links WHERE campaign_id=? AND url=?', c.id, clean).id;
    return `${pre}{{BASE}}/c/{{TOKEN}}/${id}${post}`;
  });
  db.run('UPDATE campaigns SET prepared_html=?, prepared_text=? WHERE id=?', tracked, text, c.id);
  return { html: tracked, text };
}

const COND = /(?:<!--nm-if:(!?)L(\d+)-->|\[\[nm-if:(!?)L(\d+)\]\])([\s\S]*?)(?:<!--nm-end-->|\[\[nm-end\]\])/g;

/**
 * מתאים תבנית לנמען: תגים, שדות מותאמים, ובלוקים שמוצגים רק לחברי רשימה מסוימת.
 * lists: מערך מזהי הרשימות של הנמען. בלי lists (תצוגה מקדימה כללית) כל הבלוקים המותנים מוצגים.
 */
export function personalize(tpl, { baseUrl, token, subscriber, isHtml, lists }) {
  const first = String(subscriber.name || '').trim().split(/\s+/)[0] || '';
  let fields = subscriber.fields || {};
  if (typeof fields === 'string') { try { fields = JSON.parse(fields) || {}; } catch { fields = {}; } }
  const vars = {
    BASE: baseUrl,
    TOKEN: token,
    name: subscriber.name || '',
    first_name: first,
    email: subscriber.email || '',
    unsubscribe_url: `${baseUrl}/u/${token}`,
    webview_url: `${baseUrl}/v/${token}`,
    preferences_url: `${baseUrl}/p/${token}`,
  };
  const builtin = new Set(Object.keys(vars));
  const safe = new Set(['BASE', 'TOKEN', 'unsubscribe_url', 'webview_url', 'preferences_url']);
  const body = String(tpl || '').replace(COND, (m, n1, l1, n2, l2, inner) => {
    if (!lists) return inner;
    const has = lists.includes(Number(l1 || l2));
    return (n1 || n2 ? !has : has) ? inner : '';
  });
  return body.replace(/\{\{(\w+)\}\}/g, (m, k) => {
    if (builtin.has(k)) return isHtml && !safe.has(k) ? esc(vars[k]) : vars[k];
    if (Object.hasOwn(fields, k)) return isHtml ? esc(String(fields[k] ?? '')) : String(fields[k] ?? '');
    return '';
  });
}

export function addPixel(html, baseUrl, token) {
  const px = `<img src="${baseUrl}/o/${token}.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;">`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, px + '</body>') : html + px;
}
