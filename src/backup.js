import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { israelNow } from './pause.js';

const NAME = /^backup-\d{4}-\d{2}-\d{2}_\d{4}\.tar\.gz$/;
const dirOf = (db) => path.join(db.dataDir, 'backups');

export function listBackups(db) {
  let names = [];
  try { names = fs.readdirSync(dirOf(db)).filter((n) => NAME.test(n)); } catch { names = []; }
  return names.sort().reverse().map((name) => { const st = fs.statSync(path.join(dirOf(db), name)); return { name, size: st.size, at: Math.floor(st.mtimeMs / 1000) }; });
}

export function backupPath(db, name) {
  return NAME.test(String(name)) && fs.existsSync(path.join(dirOf(db), name)) ? path.join(dirOf(db), name) : null;
}

/**
 * גיבוי מלא: עותק עקבי של מסד הנתונים (כולל הגדרות, נמענים וגליונות), התמונות שהועלו והקבצים המצורפים.
 * נשמרים שבעת הגיבויים האחרונים.
 */
export function createBackup(db, keep = 7) {
  const dir = dirOf(db);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-backup-'));
  const t = israelNow();
  const name = `backup-${t.date}_${t.stamp.slice(11).replace(':', '')}.tar.gz`;
  try {
    db.run('VACUUM INTO ?', path.join(tmp, 'mailer.db'));
    const args = ['-czf', path.join(dir, name), '-C', tmp, 'mailer.db'];
    for (const sub of ['uploads', 'attachments']) if (fs.existsSync(path.join(db.dataDir, sub))) args.push('-C', db.dataDir, sub);
    const r = spawnSync('tar', args, { stdio: 'pipe' });
    if (r.status !== 0) { fs.rmSync(path.join(dir, name), { force: true }); throw new Error('יצירת קובץ הגיבוי נכשלה: ' + String(r.stderr || r.error?.message || '').slice(0, 200)); }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  for (const old of listBackups(db).slice(keep)) fs.rmSync(path.join(dir, old.name), { force: true });
  return listBackups(db).find((b) => b.name === name);
}

/** גיבוי יומי: אם עדיין אין גיבוי מהיום (לפי שעון ישראל) והשעה אחרי 02:00, יוצר אחד. */
export function dailyBackup(db, log) {
  const t = israelNow();
  if (t.hour < 2 || listBackups(db).some((b) => b.name.startsWith(`backup-${t.date}_`))) return null;
  try { const b = createBackup(db); log?.info?.(`[backup] נוצר גיבוי יומי ${b.name}`); return b; } catch (e) { log?.error?.('[backup] ' + e.message); return null; }
}
