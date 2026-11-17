import { now } from './db.js';
import { readToken } from './track.js';

const SOFT_LIMIT = 3;

/** מנתח הודעת קפיצה או תלונה גולמית. מחזיר { token, email, type, detail } או null. */
export function parseBounce(raw) {
  const text = String(raw || '');
  const headEnd = text.search(/\r?\n\r?\n/);
  const head = headEnd > 0 ? text.slice(0, headEnd) : text;
  const token = (/bounce\+([0-9a-z]+\.[0-9a-z]+\.[\w-]{14})@/i.exec(head) || /\/u\/([0-9a-z]+\.[0-9a-z]+\.[\w-]{14})/.exec(text) || [])[1] || null;
  const isComplaint = /report-type\s*=\s*"?feedback-report/i.test(text) || /^Feedback-Type:\s*abuse/im.test(text);
  const status = (/^Status:\s*([245])\.(\d+)\.(\d+)/im.exec(text) || [])[1];
  const diag = (/^Diagnostic-Code:\s*([^\r\n]+(?:\r?\n[ \t]+[^\r\n]+)*)/im.exec(text) || [])[1] || '';
  const rcpt = (/^(?:Final|Original)-Recipient:\s*rfc822;\s*<?([^\s>]+)>?/im.exec(text) || [])[1] || null;
  let type = null;
  if (isComplaint) type = 'complaint';
  else if (status === '5') type = 'hard';
  else if (status === '4') type = 'soft';
  else if (/\b5\d\d[ -]\d\.\d\.\d\b|user unknown|no such user|mailbox not found|does not exist/i.test(text)) type = 'hard';
  else if (/mailbox full|over quota|quota exceeded|temporar/i.test(text)) type = 'soft';
  if (!type || (!token && !rcpt)) return null;
  return { token, email: rcpt, type, detail: diag.replace(/\s+/g, ' ').slice(0, 500) };
}

/** מיישם תוצאת קפיצה על מסד הנתונים. מחזיר תיאור קצר של מה שנעשה. */
export function applyBounce(db, parsed) {
  if (!parsed) return 'לא זוהתה קפיצה';
  const ids = parsed.token ? readToken(db.setting('secret'), parsed.token) : null;
  let subscriberId = ids?.subscriberId ?? null;
  const campaignId = ids?.campaignId ?? null;
  if (!subscriberId && parsed.email) {
    subscriberId = db.get('SELECT id FROM subscribers WHERE email=?', parsed.email)?.id ?? null;
  }
  if (!subscriberId) return 'הנמען לא נמצא';
  db.tx(() => {
    db.run('INSERT INTO bounces(subscriber_id, campaign_id, type, detail, created_at) VALUES(?,?,?,?,?)',
      subscriberId, campaignId, parsed.type, parsed.detail, now());
    if (parsed.type === 'complaint') {
      db.run("UPDATE subscribers SET status='unsubscribed', unsubscribed_at=? WHERE id=?", now(), subscriberId);
    } else if (parsed.type === 'hard') {
      db.run("UPDATE subscribers SET status='bounced' WHERE id=? AND status='active'", subscriberId);
    } else {
      db.run('UPDATE subscribers SET soft_bounces=soft_bounces+1 WHERE id=?', subscriberId);
      db.run("UPDATE subscribers SET status='bounced' WHERE id=? AND status='active' AND soft_bounces>=?", subscriberId, SOFT_LIMIT);
    }
    if (campaignId && parsed.type !== 'complaint') {
      db.run("UPDATE deliveries SET status='bounced', error=? WHERE campaign_id=? AND subscriber_id=? AND status='sent'",
        parsed.detail || parsed.type, campaignId, subscriberId);
    }
  });
  return `${parsed.type} לנמען ${subscriberId}`;
}
