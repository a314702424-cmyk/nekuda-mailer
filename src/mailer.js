import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

// ---------- בניית הודעת MIME ----------

function encodeWord(str) {
  if (/^[\x20-\x7e]*$/.test(str)) return str;
  const words = [];
  let chunk = '';
  for (const ch of str) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 42) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

const cleanHeader = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
const cleanAddr = (s) => String(s ?? '').replace(/[\r\n<>\s]/g, '');

function address(name, email) {
  const n = cleanHeader(name);
  const e = cleanAddr(email);
  if (!n) return `<${e}>`;
  const enc = /^[\x20-\x7e]*$/.test(n) ? `"${n.replace(/["\\]/g, '')}"` : encodeWord(n);
  return `${enc} <${e}>`;
}

const b64Lines = (str) => Buffer.from(str, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');

export function buildMessage({ from, to, replyTo, subject, html, text, headers = {}, domain, attachments = [] }) {
  const boundary = 'nm_' + crypto.randomBytes(12).toString('hex');
  const msgId = `<${crypto.randomBytes(16).toString('hex')}@${domain || 'localhost'}>`;
  const lines = [
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `From: ${address(from.name, from.email)}`,
    `To: ${address(to.name, to.email)}`,
  ];
  if (replyTo) lines.push(`Reply-To: <${cleanAddr(replyTo)}>`);
  lines.push(`Subject: ${encodeWord(cleanHeader(subject))}`, `Message-ID: ${msgId}`);
  for (const [k, v] of Object.entries(headers)) if (v) lines.push(`${k}: ${cleanHeader(v)}`);
  const body = [
    `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64Lines(text || ''),
    `--${boundary}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64Lines(html || ''),
    `--${boundary}--`];
  if (!attachments.length) {
    lines.push('MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`, '', ...body, '');
    return lines.join('\r\n');
  }
  // עם קבצים מצורפים: מעטפת mixed, ובתוכה גוף ההודעה ואחריו הקבצים. b64 מחושב מראש פעם אחת לכל גליון
  const outer = 'nmx_' + crypto.randomBytes(12).toString('hex');
  lines.push('MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${outer}"`, '',
    `--${outer}`, `Content-Type: multipart/alternative; boundary="${boundary}"`, '', ...body);
  for (const a of attachments) {
    const ascii = cleanHeader(a.name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
    const star = "UTF-8''" + encodeURIComponent(cleanHeader(a.name));
    lines.push(`--${outer}`, `Content-Type: ${cleanHeader(a.type) || 'application/octet-stream'}; name="${ascii}"`,
      `Content-Disposition: attachment; filename="${ascii}"; filename*=${star}`, 'Content-Transfer-Encoding: base64', '', a.b64);
  }
  lines.push(`--${outer}--`, '');
  return lines.join('\r\n');
}

// ---------- לקוח SMTP ----------

export class SmtpError extends Error {
  constructor(message, code, stage) {
    super(message);
    this.code = code;           // קוד SMTP או 0 לשגיאת חיבור
    this.stage = stage;         // connect | mail | rcpt | data
    this.permanent = code >= 500 && code < 600;
    this.connection = !code || stage === 'connect';
  }
}

export class SmtpConnection {
  constructor(opts) { this.opts = opts; this.sock = null; this.buf = ''; this.waiters = []; this.closed = true; }

  async connect() {
    const { host, port, secure, ehloName, user, pass } = this.opts;
    await new Promise((resolve, reject) => {
      const onErr = (e) => reject(new SmtpError('חיבור לשרת הדואר נכשל: ' + e.message, 0, 'connect'));
      this.sock = secure === 'tls'
        ? tls.connect({ host, port, servername: host }, resolve)
        : net.connect({ host, port }, resolve);
      this.sock.once('error', onErr);
      this.sock.setTimeout(30000, () => this.sock.destroy(new Error('timeout')));
    });
    this.closed = false;
    this._attach();
    await this._expect(220, 'connect');
    let caps = await this._cmd(`EHLO ${ehloName || 'localhost'}`, 250, 'connect');
    if (secure === 'starttls') {
      await this._cmd('STARTTLS', 220, 'connect');
      this.sock.removeAllListeners('data');
      this.sock = await new Promise((resolve, reject) => {
        const s = tls.connect({ socket: this.sock, servername: host }, () => resolve(s));
        s.once('error', (e) => reject(new SmtpError('TLS נכשל: ' + e.message, 0, 'connect')));
      });
      this._attach();
      caps = await this._cmd(`EHLO ${ehloName || 'localhost'}`, 250, 'connect');
    }
    if (user) {
      const token = Buffer.from(`\0${user}\0${pass || ''}`, 'utf8').toString('base64');
      await this._cmd(`AUTH PLAIN ${token}`, 235, 'connect');
    }
    return caps;
  }

  _attach() {
    this.sock.setEncoding('utf8');
    this.sock.on('data', (d) => { this.buf += d; this._drain(); });
    const fail = (e) => {
      this.closed = true;
      const err = new SmtpError('החיבור לשרת הדואר נסגר' + (e?.message ? ': ' + e.message : ''), 0, 'connect');
      for (const w of this.waiters.splice(0)) w.reject(err);
    };
    this.sock.on('error', fail);
    this.sock.on('close', () => fail());
  }

  _drain() {
    for (;;) {
      const m = /^(?:\d{3}-[^\r\n]*\r?\n)*(\d{3})(?: [^\r\n]*)?\r?\n/.exec(this.buf);
      if (!m || !this.waiters.length) return;
      this.buf = this.buf.slice(m[0].length);
      this.waiters.shift().resolve({ code: Number(m[1]), text: m[0].trim() });
    }
  }

  _read() {
    if (this.closed) return Promise.reject(new SmtpError('החיבור לשרת הדואר סגור', 0, 'connect'));
    return new Promise((resolve, reject) => { this.waiters.push({ resolve, reject }); this._drain(); });
  }

  async _expect(code, stage) {
    const r = await this._read();
    if (r.code !== code) throw new SmtpError(r.text, r.code, stage);
    return r.text;
  }

  _cmd(line, code, stage) { this.sock.write(line + '\r\n'); return this._expect(code, stage); }

  async send(envelopeFrom, rcpt, raw) {
    await this._cmd(`MAIL FROM:<${cleanAddr(envelopeFrom)}>`, 250, 'mail');
    try {
      await this._cmd(`RCPT TO:<${cleanAddr(rcpt)}>`, 250, 'rcpt');
      await this._cmd('DATA', 354, 'data');
    } catch (e) {
      if (!this.closed) await this._cmd('RSET', 250, 'mail').catch(() => {});
      throw e;
    }
    const body = raw.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    this.sock.write(body + (body.endsWith('\r\n') ? '' : '\r\n') + '.\r\n');
    return this._expect(250, 'data');
  }

  async quit() {
    if (this.closed) return;
    try { await this._cmd('QUIT', 221, 'connect'); } catch { /* מתעלמים */ }
    this.sock.destroy();
    this.closed = true;
  }
}

export function smtpOptions(settings) {
  return {
    host: settings.smtpHost || '127.0.0.1',
    port: Number(settings.smtpPort) || 25,
    secure: settings.smtpSecure || 'none',
    user: settings.smtpUser || '',
    pass: settings.smtpPass || '',
    ehloName: settings.ehloName || 'localhost',
  };
}
