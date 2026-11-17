#!/usr/bin/env node
// מקבל הודעת קפיצה ב-stdin (מ-Postfix) ומעדכן את מסד הנתונים.
// שימוש ב-/etc/aliases:  bounce: "|/usr/bin/node --disable-warning=ExperimentalWarning /opt/nekuda-mailer/bin/bounce-pipe.js"
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { parseBounce, applyBounce } from '../src/bounce.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  try {
    const db = openDb(dataDir);
    const result = applyBounce(db, parseBounce(Buffer.concat(chunks).toString('utf8')));
    db.close();
    console.log(result);
  } catch (e) {
    console.error('bounce-pipe:', e.message);
  }
  process.exit(0); // תמיד 0, כדי ש-Postfix לא יחזיר קפיצה על הקפיצה
});
