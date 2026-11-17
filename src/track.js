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
export function campaignHtml(c) {
  if (c.mode === 'html') return c.html || '';
  let design = null;
  try { design = JSON.parse(c.design || 'null'); } catch { /* עיצוב פגום, נשתמש בברירת מחדל */ }
  return renderDesign(design, { subject: c.subject, preheader: c.preheader });
}

/** מכין תבנית לשליחה: מוסיף קישור הסרה אם חסר, ומחליף קישורים בקישורי מעקב. */
export function prepareCampaign(db, c) {
  let html = campaignHtml(c);
  if (!html.includes('{{unsubscribe_url}}')) {
    const footer = DEFAULT_FOOTER(db.setting('companyAddress'));
    html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, footer + '</body>') : html + footer;
  }
  const text = htmlToText(html);
  const tracked = html.replace(/(<a\s[^>]*?href\s*=\s*")(https?:\/\/[^"]+)(")/gi, (m, pre, url, post) => {
    const clean = url.replace(/&amp;/g, '&');
    db.run('INSERT OR IGNORE INTO links(campaign_id, url) VALUES(?,?)', c.id, clean);
    const id = db.get('SELECT id FROM links WHERE campaign_id=? AND url=?', c.id, clean).id;
    return `${pre}{{BASE}}/c/{{TOKEN}}/${id}${post}`;
  });
  db.run('UPDATE campaigns SET prepared_html=?, prepared_text=? WHERE id=?', tracked, text, c.id);
  return { html: tracked, text };
}

export function personalize(tpl, { baseUrl, token, subscriber, isHtml }) {
  const first = String(subscriber.name || '').trim().split(/\s+/)[0] || '';
  const vars = {
    BASE: baseUrl,
    TOKEN: token,
    name: subscriber.name || '',
    first_name: first,
    email: subscriber.email || '',
    unsubscribe_url: `${baseUrl}/u/${token}`,
    webview_url: `${baseUrl}/v/${token}`,
  };
  return String(tpl || '').replace(/\{\{(\w+)\}\}/g, (m, k) => {
    if (!(k in vars)) return '';
    return isHtml && (k === 'name' || k === 'first_name' || k === 'email') ? esc(vars[k]) : vars[k];
  });
}

export function addPixel(html, baseUrl, token) {
  const px = `<img src="${baseUrl}/o/${token}.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;">`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, px + '</body>') : html + px;
}
