import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS lists(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', color TEXT DEFAULT '#4f6bed',
  created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS subscribers(
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active', source TEXT DEFAULT '', consent_note TEXT DEFAULT '',
  created_at INTEGER NOT NULL, unsubscribed_at INTEGER, last_open_at INTEGER, last_click_at INTEGER,
  soft_bounces INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS subscribers_status ON subscribers(status);
CREATE TABLE IF NOT EXISTS subscriptions(
  subscriber_id INTEGER NOT NULL, list_id INTEGER NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(subscriber_id, list_id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS subscriptions_list ON subscriptions(list_id);
CREATE TABLE IF NOT EXISTS campaigns(
  id INTEGER PRIMARY KEY, subject TEXT NOT NULL DEFAULT '', preheader TEXT DEFAULT '',
  from_name TEXT DEFAULT '', from_email TEXT DEFAULT '', reply_to TEXT DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'blocks', design TEXT, html TEXT DEFAULT '',
  prepared_html TEXT, prepared_text TEXT,
  status TEXT NOT NULL DEFAULT 'draft', scheduled_at INTEGER, started_at INTEGER, finished_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS campaign_lists(
  campaign_id INTEGER NOT NULL, list_id INTEGER NOT NULL, PRIMARY KEY(campaign_id, list_id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS deliveries(
  campaign_id INTEGER NOT NULL, subscriber_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', tries INTEGER NOT NULL DEFAULT 0, next_try INTEGER NOT NULL DEFAULT 0,
  error TEXT, sent_at INTEGER, opened_at INTEGER, opens INTEGER NOT NULL DEFAULT 0,
  clicked_at INTEGER, clicks INTEGER NOT NULL DEFAULT 0, unsubscribed_at INTEGER,
  PRIMARY KEY(campaign_id, subscriber_id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS deliveries_pending ON deliveries(campaign_id, status, next_try);
CREATE INDEX IF NOT EXISTS deliveries_sent_at ON deliveries(sent_at);
CREATE TABLE IF NOT EXISTS links(
  id INTEGER PRIMARY KEY, campaign_id INTEGER NOT NULL, url TEXT NOT NULL, clicks INTEGER NOT NULL DEFAULT 0,
  UNIQUE(campaign_id, url));
CREATE TABLE IF NOT EXISTS link_clicks(
  link_id INTEGER NOT NULL, subscriber_id INTEGER NOT NULL, PRIMARY KEY(link_id, subscriber_id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS saved_blocks(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, block TEXT NOT NULL, synced INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS campaign_versions(
  id INTEGER PRIMARY KEY, campaign_id INTEGER NOT NULL, saved_at INTEGER NOT NULL, snapshot TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS campaign_versions_c ON campaign_versions(campaign_id, id);
CREATE TABLE IF NOT EXISTS bounces(
  id INTEGER PRIMARY KEY, subscriber_id INTEGER, campaign_id INTEGER, type TEXT NOT NULL, detail TEXT,
  created_at INTEGER NOT NULL);
`;

export const DEFAULT_SETTINGS = {
  baseUrl: 'http://localhost:3080',
  fromName: 'נקודה הוצאה לאור',
  fromEmail: '',
  replyTo: '',
  bounceAddress: '',
  companyAddress: '',
  smtpHost: '127.0.0.1',
  smtpPort: '25',
  smtpSecure: 'none',
  smtpUser: '',
  smtpPass: '',
  ehloName: 'localhost',
  sendPerSecond: '5',
  dailyLimit: '0',
  formListId: '',
};

export const now = () => Math.floor(Date.now() / 1000);

export function openDb(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  const raw = new DatabaseSync(path.join(dataDir, 'mailer.db'));
  raw.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;');
  raw.exec(SCHEMA);
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = raw.prepare(sql); cache.set(sql, s); }
    return s;
  };
  const db = {
    raw,
    dataDir,
    run: (sql, ...p) => stmt(sql).run(...p),
    get: (sql, ...p) => stmt(sql).get(...p),
    all: (sql, ...p) => stmt(sql).all(...p),
    tx(fn) {
      raw.exec('BEGIN IMMEDIATE');
      try { const r = fn(); raw.exec('COMMIT'); return r; }
      catch (e) { raw.exec('ROLLBACK'); throw e; }
    },
    setting(key) {
      const r = stmt('SELECT value FROM settings WHERE key=?').get(key);
      return r ? r.value : (DEFAULT_SETTINGS[key] ?? '');
    },
    settings() {
      const out = { ...DEFAULT_SETTINGS };
      for (const r of stmt('SELECT key, value FROM settings').all()) out[r.key] = r.value;
      return out;
    },
    setSetting(key, value) {
      stmt('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(key, String(value ?? ''));
    },
    close: () => raw.close(),
  };
  if (!db.get("SELECT value FROM settings WHERE key='secret'")) {
    db.setSetting('secret', crypto.randomBytes(32).toString('hex'));
  }
  return db;
}
