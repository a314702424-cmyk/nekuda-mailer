const EMAIL_RX = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;
export const isEmail = (s) => EMAIL_RX.test(String(s || '').trim()) && String(s).length <= 254;

function splitLine(line, delim) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false; } else cur += ch;
    } else if (ch === '"' && cur === '') quoted = true;
    else if (ch === delim) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** מקבל טקסט (CSV, רשימת כתובות, או "שם <כתובת>") ומחזיר { rows:[{email,name}], invalid }. */
export function parseContacts(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const rows = [];
  let invalid = 0;
  if (!lines.length) return { rows, invalid };
  const first = lines[0];
  const delim = [';', '\t', ','].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const head = splitLine(first, delim).map((h) => h.toLowerCase());
  let emailCol = head.findIndex((h) => /^(e-?mail|email address|כתובת מייל|מייל|דוא"?ל|אימייל)$/.test(h));
  let nameCol = head.findIndex((h) => /^(name|full ?name|שם|שם מלא)$/.test(h));
  const hasHeader = emailCol >= 0;
  const seen = new Set();
  for (let i = hasHeader ? 1 : 0; i < lines.length; i++) {
    let email = '';
    let name = '';
    const angle = /^\s*"?([^"<]*?)"?\s*<([^<>\s]+)>\s*$/.exec(lines[i]);
    if (angle && !hasHeader) { name = angle[1].trim(); email = angle[2]; } else {
      const cols = splitLine(lines[i], delim);
      if (!hasHeader && emailCol < 0) {
        emailCol = cols.findIndex((c) => c.includes('@'));
        if (emailCol >= 0 && cols.length > 1) nameCol = emailCol === 0 ? 1 : 0;
      }
      const ec = hasHeader ? emailCol : cols.findIndex((c) => c.includes('@'));
      email = cols[ec] || '';
      name = nameCol >= 0 && nameCol !== ec ? (cols[nameCol] || '') : '';
      if (name.includes('@')) name = '';
    }
    email = email.trim().toLowerCase();
    if (!isEmail(email)) { invalid++; continue; }
    if (seen.has(email)) continue;
    seen.add(email);
    rows.push({ email, name: name.slice(0, 200) });
  }
  return { rows, invalid };
}

export const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // מניעת הזרקת נוסחאות ב-Excel
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
