import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const git = (dir, args, timeout = 90000) => {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim().slice(-1500) || (r.error ? r.error.message : '') };
};
const versionIn = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version; } catch { return ''; } };

/** מה מותקן, ומה מחכה במאגר: מביא את המצב מהמאגר בלי לשנות את הקבצים. */
export function updateStatus(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) return { supported: false, reason: 'המערכת לא הותקנה מ-git, ולכן אי אפשר לעדכן אותה מכאן.', current: versionIn(dir) };
  const fetched = git(dir, ['fetch', '--quiet', 'origin']);
  if (!fetched.ok) return { supported: true, current: versionIn(dir), error: 'לא הצלחתי לבדוק את המאגר: ' + fetched.out };
  const behind = Number(git(dir, ['rev-list', '--count', 'HEAD..@{u}']).out) || 0;
  const remotePkg = git(dir, ['show', '@{u}:package.json']);
  let available = '';
  try { available = JSON.parse(remotePkg.out).version; } catch { available = ''; }
  const dirty = git(dir, ['status', '--porcelain', '--untracked-files=no']).out;
  return { supported: true, current: versionIn(dir), available, behind, dirty: !!dirty, remote: git(dir, ['remote', 'get-url', 'origin']).out };
}

/** מושך את הגרסה מהמאגר. רק קדימה (ff-only): אם יש שינויים מקומיים שמתנגשים, לא נוגע בכלום ומדווח. */
export function pullUpdate(dir) {
  const before = versionIn(dir);
  const r = git(dir, ['pull', '--ff-only', '--quiet', 'origin']);
  if (!r.ok) return { ok: false, error: 'העדכון נכשל, ושום קובץ לא שונה: ' + r.out };
  return { ok: true, from: before, to: versionIn(dir), changed: before !== versionIn(dir) || !!r.out };
}
