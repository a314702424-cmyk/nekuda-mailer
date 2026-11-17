import fs from 'node:fs';
import path from 'node:path';
import { now } from './db.js';
import { buildMessage, SmtpConnection, smtpOptions } from './mailer.js';
import { makeToken, prepareCampaign, personalize, addPixel } from './track.js';

const RETRY_DELAYS = [300, 1800, 7200]; // שניות: 5 דקות, חצי שעה, שעתיים
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const domainOf = (email) => String(email || '').split('@')[1] || 'localhost';

/** מוסיף לתור את כל הנמענים הפעילים ברשימות הגליון. מי שכבר בתור או קיבל, לא יתווסף שוב. */
export function enqueueCampaign(db, campaignId) {
  const c = db.get('SELECT * FROM campaigns WHERE id=?', campaignId);
  if (!c) throw new Error('הגליון לא נמצא');
  prepareCampaign(db, c);
  const r = db.run(`INSERT OR IGNORE INTO deliveries(campaign_id, subscriber_id)
    SELECT DISTINCT ?, s.id FROM subscriptions sp
    JOIN subscribers s ON s.id = sp.subscriber_id
    WHERE sp.list_id IN (SELECT list_id FROM campaign_lists WHERE campaign_id = ?) AND s.status = 'active'`,
  campaignId, campaignId);
  // בדיקת A/B: חצי מהנמענים מקבלים את הנושא החלופי. החלוקה לפי מזהה הנמען, כך שהיא יציבה גם בשליחה חוזרת
  if (String(c.subject_b || '').trim()) {
    db.run("UPDATE deliveries SET variant = CASE WHEN subscriber_id % 2 = 0 THEN 'a' ELSE 'b' END WHERE campaign_id=? AND variant=''", campaignId);
  }
  db.run("UPDATE campaigns SET status='sending', started_at=COALESCE(started_at, ?), finished_at=NULL, scheduled_at=NULL, updated_at=? WHERE id=?",
    now(), now(), campaignId);
  return Number(r.changes);
}

const attCache = new Map();
/** קובצי הגליון מקודדים ל-base64 פעם אחת, ונשמרים בזיכרון כל עוד רשימת הקבצים לא השתנתה. */
export function campaignAttachments(db, campaign) {
  const key = String(campaign.attachments || '[]');
  if (key === '[]') return [];
  const hit = attCache.get(campaign.id);
  if (hit && hit.key === key) return hit.list;
  let meta = [];
  try { meta = JSON.parse(key); } catch { meta = []; }
  const list = [];
  for (const a of meta) {
    try {
      const buf = fs.readFileSync(path.join(db.dataDir, 'attachments', String(campaign.id), a.id));
      list.push({ name: a.name, type: a.type, b64: buf.toString('base64').replace(/.{76}/g, '$&\r\n') });
    } catch { /* קובץ שנמחק מהדיסק: שולחים בלעדיו */ }
  }
  if (attCache.size > 20) attCache.clear();
  attCache.set(campaign.id, { key, list });
  return list;
}

/** מוסיף לתור של כל אוטומציה פעילה את מי שהצטרף לרשימה אחריה, כשהגיע זמנו. */
export function runAutomations(db) {
  let added = 0;
  for (const a of db.all('SELECT * FROM automations WHERE active=1')) {
    added += Number(db.run(`INSERT OR IGNORE INTO deliveries(campaign_id, subscriber_id)
      SELECT ?, s.id FROM subscriptions sp JOIN subscribers s ON s.id=sp.subscriber_id
      WHERE sp.list_id=? AND s.status='active' AND sp.created_at >= ? AND sp.created_at <= ?`,
    a.campaign_id, a.list_id, a.created_at, now() - a.delay_hours * 3600).changes);
  }
  return added;
}

export function buildFor(db, settings, campaign, subscriber, variant = '') {
  const baseUrl = settings.baseUrl.replace(/\/+$/, '');
  const token = makeToken(settings.secret, campaign.id, subscriber.id);
  const fromEmail = campaign.from_email || settings.fromEmail;
  const lists = String(campaign.prepared_html || '').includes('nm-if:')
    ? db.all('SELECT list_id FROM subscriptions WHERE subscriber_id=?', subscriber.id).map((r) => r.list_id) : [];
  const ctx = { baseUrl, token, subscriber, lists };
  const html = addPixel(personalize(campaign.prepared_html, { ...ctx, isHtml: true }), baseUrl, token);
  const text = personalize(campaign.prepared_text, { ...ctx, isHtml: false });
  const subject = personalize(variant === 'b' && campaign.subject_b ? campaign.subject_b : campaign.subject, { ...ctx, isHtml: false });
  const bounce = settings.bounceAddress || fromEmail;
  const envelopeFrom = settings.bounceAddress ? bounce.replace('@', `+${token}@`) : bounce;
  const raw = buildMessage({
    from: { name: campaign.from_name || settings.fromName, email: fromEmail },
    to: { name: subscriber.name, email: subscriber.email },
    replyTo: campaign.reply_to || settings.replyTo,
    subject, html, text,
    attachments: campaignAttachments(db, campaign),
    domain: domainOf(fromEmail),
    headers: {
      'List-Unsubscribe': `<${baseUrl}/u/${token}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'X-Campaign-ID': String(campaign.id),
      Precedence: 'bulk',
    },
  });
  return { raw, envelopeFrom, token };
}

export function sentToday(db) {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  return Number(db.get('SELECT COUNT(*) n FROM deliveries WHERE sent_at >= ?', Math.floor(d.getTime() / 1000)).n);
}

export class Worker {
  constructor(db, log = console) { this.db = db; this.log = log; this.running = false; this.state = { lastError: '', lastTick: 0 }; }

  start() { if (this.running) return; this.running = true; this.loop(); }
  stop() { this.running = false; }

  async loop() {
    while (this.running) {
      let worked = 0;
      try { worked = await this.tick(); }
      catch (e) { this.state.lastError = e.message; this.log.error('[worker]', e.message); await sleep(e.connection ? 30000 : 5000); }
      if (!worked) await sleep(1000);
    }
  }

  /** סבב אחד: מפעיל גליונות מתוזמנים ושולח אצווה אחת. מחזיר כמה הודעות טופלו. */
  async tick() {
    const db = this.db;
    this.state.lastTick = now();
    for (const c of db.all("SELECT id FROM campaigns WHERE status='scheduled' AND scheduled_at <= ?", now())) {
      const n = enqueueCampaign(db, c.id);
      this.log.info(`[worker] גליון ${c.id} התחיל, ${n} נמענים`);
    }
    runAutomations(db);
    const settings = db.settings();
    const rate = Math.max(0.1, Number(settings.sendPerSecond) || 5);
    const dailyLimit = Number(settings.dailyLimit) || 0;
    let handled = 0;

    for (const campaign of db.all("SELECT * FROM campaigns WHERE status='sending' ORDER BY started_at")) {
      let budget = Math.max(1, Math.round(rate * 10));
      if (dailyLimit > 0) budget = Math.min(budget, dailyLimit - sentToday(db));
      if (budget <= 0) return handled;

      const batch = db.all(`SELECT d.subscriber_id, d.tries, d.variant, s.email, s.name, s.status, s.fields FROM deliveries d
        JOIN subscribers s ON s.id = d.subscriber_id
        WHERE d.campaign_id=? AND d.status='pending' AND d.next_try <= ? LIMIT ?`, campaign.id, now(), budget);

      if (!batch.length) {
        const left = Number(db.get("SELECT COUNT(*) n FROM deliveries WHERE campaign_id=? AND status='pending'", campaign.id).n);
        if (!left && !campaign.auto) {
          db.run("UPDATE campaigns SET status='sent', finished_at=?, updated_at=? WHERE id=?", now(), now(), campaign.id);
          this.log.info(`[worker] גליון ${campaign.id} הסתיים`);
        }
        continue;
      }

      const conn = new SmtpConnection(smtpOptions(settings));
      await conn.connect();
      try {
        for (const row of batch) {
          if (!this.running) break;
          const started = Date.now();
          if (row.status !== 'active') {
            db.run("UPDATE deliveries SET status='skipped', error='הנמען כבר לא פעיל' WHERE campaign_id=? AND subscriber_id=?", campaign.id, row.subscriber_id);
            continue;
          }
          const sub = { id: row.subscriber_id, email: row.email, name: row.name, fields: row.fields };
          const { raw, envelopeFrom } = buildFor(db, settings, campaign, sub, row.variant);
          try {
            await conn.send(envelopeFrom, sub.email, raw);
            db.run("UPDATE deliveries SET status='sent', sent_at=?, error=NULL WHERE campaign_id=? AND subscriber_id=?", now(), campaign.id, sub.id);
          } catch (e) {
            if (e.connection) throw e;
            this.failDelivery(campaign.id, sub.id, row.tries, e);
          }
          handled++;
          const wait = 1000 / rate - (Date.now() - started);
          if (wait > 0) await sleep(wait);
        }
      } finally {
        await conn.quit();
      }
      this.state.lastError = '';
    }
    return handled;
  }

  failDelivery(campaignId, subscriberId, tries, e) {
    const db = this.db;
    const msg = String(e.message || e).slice(0, 500);
    if (e.permanent && e.stage === 'rcpt') {
      db.tx(() => {
        db.run("UPDATE deliveries SET status='bounced', error=? WHERE campaign_id=? AND subscriber_id=?", msg, campaignId, subscriberId);
        db.run("UPDATE subscribers SET status='bounced' WHERE id=? AND status='active'", subscriberId);
        db.run("INSERT INTO bounces(subscriber_id, campaign_id, type, detail, created_at) VALUES(?,?,'hard',?,?)", subscriberId, campaignId, msg, now());
      });
    } else if (e.permanent || tries >= RETRY_DELAYS.length) {
      db.run("UPDATE deliveries SET status='failed', tries=tries+1, error=? WHERE campaign_id=? AND subscriber_id=?", msg, campaignId, subscriberId);
    } else {
      db.run('UPDATE deliveries SET tries=tries+1, next_try=?, error=? WHERE campaign_id=? AND subscriber_id=?',
        now() + RETRY_DELAYS[tries], msg, campaignId, subscriberId);
    }
  }
}
