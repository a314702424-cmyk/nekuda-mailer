import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);

export function chromePath() {
  return CANDIDATES.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null;
}

/** ממיר HTML ל-PDF בעזרת Chrome ללא ממשק. מחזיר Buffer, או null אם Chrome לא מותקן. */
export async function htmlToPdf(html) {
  const bin = chromePath();
  if (!bin) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-pdf-'));
  try {
    const input = path.join(dir, 'in.html');
    const output = path.join(dir, 'out.pdf');
    fs.writeFileSync(input, html);
    await new Promise((resolve, reject) => {
      const proc = spawn(bin, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--disable-extensions',
        `--user-data-dir=${path.join(dir, 'profile')}`, '--no-pdf-header-footer', '--virtual-time-budget=8000', `--print-to-pdf=${output}`, 'file://' + input],
      { stdio: 'ignore', env: { ...process.env, HOME: dir } });
      const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('ההמרה ל-PDF ארכה יותר מדי')); }, 45000);
      proc.on('error', (e) => { clearTimeout(timer); reject(e); });
      proc.on('exit', (code) => { clearTimeout(timer); if (fs.existsSync(output)) resolve(); else reject(new Error('Chrome נכשל בהמרה, קוד ' + code)); });
    });
    return fs.readFileSync(output);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
