// עוזר AI מול Google AI Studio (Gemini API). בלי ספריות: קריאות fetch ישירות.
const base = () => (process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');

export class AiError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

const explain = (status, apiMessage) => {
  const m = String(apiMessage || '');
  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(m)) return 'המפתח לא תקין. כדאי להעתיק אותו שוב מ-Google AI Studio.';
  if (status === 401 || status === 403) return 'Google דחה את המפתח, או שאין לו הרשאה ל-Gemini API.';
  if (status === 404) return 'המנוע שנבחר לא זמין למפתח הזה. ' + m;
  if (status === 429) return 'חרגת מהמכסה של המפתח (בקשות לדקה או ליום). אפשר לנסות שוב מאוחר יותר או לבחור מנוע אחר.';
  if (status >= 500) return 'השירות של Google לא זמין כרגע. נסה שוב בעוד רגע.';
  return m || `שגיאה ${status} מ-Google`;
};

/** מנקה מפתח שהודבק: רווחים, ירידות שורה, מירכאות ותווי כיווניות נסתרים שנדבקים בהעתקה מדף בעברית. */
export const cleanKey = (key) => String(key || '').replace(/[\s"'`\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');

const vertexBase = () => (process.env.VERTEX_BASE || 'https://aiplatform.googleapis.com').replace(/\/+$/, '');

// vertex=true: מפתח של Vertex AI (Agent Platform), שפונה לכתובת אחרת של Google
async function once(key, path, body, inQuery, vertex) {
  const url = `${vertex ? vertexBase() + '/v1' : base() + '/v1beta'}/${path}${inQuery ? `${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}` : ''}`;
  let res;
  try {
    res = await fetch(url, {
      method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(60000),
      headers: { ...(inQuery ? {} : { 'x-goog-api-key': key }), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new AiError(e.name === 'TimeoutError' ? 'Google לא ענה בזמן. נסה שוב.' : 'אין חיבור מהשרת לשירות של Google: ' + (e.cause?.code || e.message));
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { res, data };
}

// המפתח נשלח בכותרת. אם Google דוחה את הזיהוי, מנסים פעם אחת גם בפרמטר key, כי לא כל סוגי המפתחות מתקבלים באותה דרך
async function call(key, path, body, vertex = false) {
  let r = await once(key, path, body, false, vertex);
  if ([400, 401, 403].includes(r.res.status) && /key|credential|auth|token|unauthenticated/i.test(JSON.stringify(r.data || ''))) {
    const alt = await once(key, path, body, true, vertex);
    if (alt.res.ok) r = alt;
  }
  if (!r.res.ok) {
    const raw = r.data?.error?.message || '';
    const err = new AiError(explain(r.res.status, raw));
    err.http = r.res.status;
    err.detail = `HTTP ${r.res.status}${r.data?.error?.status ? ' ' + r.data.error.status : ''}${raw ? ': ' + raw.slice(0, 300) : ''}`;
    throw err;
  }
  return r.data || {};
}

const NOT_TEXT = /embedding|tts|image|audio|live|veo|imagen|aqa|robotics|computer-use|speech|video/i;
/** כל המנועים שהמפתח רואה ושיודעים להפיק טקסט: Gemini לסוגיו וגם Gemma. */
export async function listModels(key) {
  const out = [];
  let pageToken = '';
  for (let i = 0; i < 5; i++) {
    const d = await call(key, `models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
    for (const m of d.models || []) {
      const id = String(m.name || '').replace(/^models\//, '');
      if (!id || !(m.supportedGenerationMethods || []).includes('generateContent') || NOT_TEXT.test(id)) continue;
      out.push({ id, name: m.displayName || id, family: id.startsWith('gemma') ? 'gemma' : 'gemini', output: m.outputTokenLimit || 0 });
    }
    pageToken = d.nextPageToken || '';
    if (!pageToken) break;
  }
  return out;
}

/**
 * מדרג את המנועים לבחירה אוטומטית, בלי להניח שמות קבועים, כי Google מחליפה דורות כל כמה חודשים:
 * גרסה יציבה לפני ניסיונית, משפחת Gemini לפני Gemma, מנוע מהיר (flash) לפני כבד, ואז הגרסה החדשה ביותר.
 */
export function rankModels(models) {
  const score = (m) => {
    const id = m.id;
    const ver = Number((/-(\d+(?:\.\d+)?)/.exec(id) || [])[1]) || 0;
    const unstable = /preview|exp|latest/.test(id) ? 1 : 0;
    const tier = /flash-lite|lite/.test(id) ? 1 : /flash/.test(id) ? 0 : /pro|ultra/.test(id) ? 2 : 1;
    return [m.family === 'gemini' ? 0 : 1, unstable, tier, -ver, /-\d{3}$/.test(id) ? 1 : 0, id.length];
  };
  return [...models].sort((a, b) => { const x = score(a); const y = score(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; });
}

/** שיחה אחת. messages: [{role:'user'|'model', text}]. מחזיר טקסט. */
export async function generate(key, model, { system = '', messages, maxTokens = 4096, temperature = 0.7 }, vertex = false) {
  const contents = messages.map((m) => ({ role: m.role === 'model' ? 'model' : 'user', parts: [{ text: String(m.text) }] }));
  const body = { contents, generationConfig: { temperature, maxOutputTokens: maxTokens } };
  // Gemma לא מקבל הנחיית מערכת נפרדת, ולכן ההנחיה נכנסת לתחילת ההודעה הראשונה
  if (system && model.startsWith('gemma')) contents[0].parts[0].text = `${system}\n\n${contents[0].parts[0].text}`;
  else if (system) body.systemInstruction = { parts: [{ text: system }] };
  const d = await call(key, `${vertex ? 'publishers/google/' : ''}models/${encodeURIComponent(model)}:generateContent`, body, vertex);
  if (d.promptFeedback?.blockReason) throw new AiError('Google חסם את הבקשה (' + d.promptFeedback.blockReason + '). נסה ניסוח אחר.', 422);
  const text = (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!text) throw Object.assign(new AiError('המנוע לא החזיר תשובה' + (d.candidates?.[0]?.finishReason ? ` (${d.candidates[0].finishReason})` : '') + '. נסה שוב או בחר מנוע אחר.', 502), { empty: true });
  return text;
}

// כינויים קבועים של Google למנוע העדכני. משמשים כשאי אפשר לקבל את רשימת המנועים
const FALLBACK = ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-pro-latest'].map((id) => ({ id, name: id, family: 'gemini', guessed: true }));
// ב-Vertex AI עם מפתח אין בקשה שמחזירה את רשימת המנועים, ולכן מנסים שמות מוכרים, מהחדש לישן
const VERTEX_TRY = ['gemini-flash-latest', 'gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'];

/** בודק אם המפתח הוא מפתח של Vertex AI: מנסה בקשה זעירה מול כל שם מנוע מוכר, עד הראשון שעובד. */
async function probeVertex(key, preferred) {
  let last = null;
  for (const id of [...new Set([preferred, ...VERTEX_TRY].filter(Boolean))]) {
    try { await generate(key, id, { messages: [{ role: 'user', text: 'hi' }], maxTokens: 64, temperature: 0 }, true); return { id }; } catch (e) {
      if (e.empty) return { id }; // המנוע ענה בלי טקסט: המפתח והמנוע תקינים
      last = e;
      if (e.http === 429) return { id, error: e }; // המפתח מזוהה, אבל המכסה נגמרה
      if (![404, 400].includes(e.http)) break; // דחייה של המפתח עצמו: אין טעם לנסות שמות נוספים
    }
  }
  return { id: null, error: last };
}

const cache = new Map(); // מפתח → { at, models }
async function modelsFor(key, preferred = '') {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.models.vertex ? 60 : 10) * 60 * 1000) return hit.models;
  let models;
  try { models = rankModels(await listModels(key)); } catch (e) {
    // מפתח שגוי ממש נכשל גם בהמשך. מפתח תקין שנחסם כאן הוא בדרך כלל מפתח של Vertex AI, או מפתח שלא מורשה לרשימת המנועים
    if (![401, 403, 404].includes(e.http)) throw e;
    const v = await probeVertex(key, preferred);
    if (v.id) {
      models = [v.id, ...VERTEX_TRY.filter((x) => x !== v.id)].map((id) => ({ id, name: id, family: 'gemini', guessed: id !== v.id }));
      models.vertex = true;
    } else { models = [...FALLBACK]; models.listError = e.detail || e.message; models.vertexError = v.error?.detail || ''; }
  }
  if (cache.size > 5) cache.clear();
  cache.set(key, { at: Date.now(), models });
  return models;
}

/**
 * מריץ בקשה עם המנוע שנבחר בהגדרות, או בבחירה אוטומטית.
 * בבחירה אוטומטית, מנוע שלא זמין למפתח או שמכסתו נגמרה מוחלף בבא בתור (עד שלושה ניסיונות).
 */
export async function ask(rawKey, chosen, request) {
  const key = cleanKey(rawKey);
  if (!key) throw new AiError('לא הוגדר מפתח של Google AI Studio. מנהל יכול להוסיף אותו במסך ההגדרות.', 400);
  const models = await modelsFor(key, chosen);
  const vertex = !!models.vertex;
  if (chosen) return { model: chosen, vertex, text: await generate(key, chosen, request, vertex) };
  if (!models.length) throw new AiError('המפתח תקין, אבל לא נמצא בו מנוע שמפיק טקסט.', 400);
  let last;
  for (const m of models.slice(0, 3)) {
    try { return { model: m.id, vertex, text: await generate(key, m.id, request, vertex) }; } catch (e) {
      last = e;
      if (![404, 429, 400].includes(e.http) && !models.listError) throw e;
    }
  }
  throw last;
}

/** בדיקת מפתח: רשימת המנועים, המנוע שייבחר, ובקשת ניסיון קצרה. */
export async function testKey(rawKey, chosen) {
  const key = cleanKey(rawKey);
  const format = key.startsWith('AQ.') ? 'מפתח בפורמט החדש של Google (AQ.)' : key.startsWith('AIza') ? 'מפתח בפורמט הישן (AIza)' : 'פורמט לא מוכר: מפתח של AI Studio מתחיל ב-AQ. או ב-AIza';
  const cleaned = key !== String(rawKey || '');
  cache.delete(key);
  let models;
  try { models = await modelsFor(key, chosen); } catch (e) { return { ok: false, models: [], error: e.message, detail: e.detail || '', format, cleaned }; }
  const started = Date.now();
  let reply = null; let error = ''; let detail = ''; let used = chosen || '';
  try { const r = await ask(key, chosen, { messages: [{ role: 'user', text: 'ענה במילה אחת: שלום' }], maxTokens: 1024, temperature: 0 }); reply = r.text.slice(0, 60); used = r.model; } catch (e) { error = e.message; detail = e.detail || ''; }
  const listed = models.listError || models.vertex ? [] : models;
  return { ok: !error, models: (error && models.listError ? [] : models).map((m) => ({ id: m.id, name: m.name, family: m.family })), listed: listed.length,
    vertex: !!models.vertex, vertexError: models.vertexError || '', listError: models.listError || '', auto: models[0]?.id || '', used, reply, error, detail, format: !error && format.startsWith('פורמט לא') ? '' : format, cleaned, ms: Date.now() - started };
}

const ALLOWED = new Set(['p', 'br', 'b', 'strong', 'i', 'em', 'u', 'a', 'ul', 'ol', 'li']);
/** מנקה HTML שחזר מהמנוע: רק תגי טקסט בסיסיים, וקישורים בטוחים בלבד. */
export function cleanHtml(input) {
  let s = String(input || '').replace(/^```(?:html)?\s*|\s*```$/g, '').replace(/<(script|style|iframe|object)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g, (m, tag, attrs) => {
    const t = tag.toLowerCase();
    if (/^h[1-6]$/.test(t)) return m.startsWith('</') ? '</b></p>' : '<p><b>';
    if (!ALLOWED.has(t)) return '';
    if (m.startsWith('</')) return `</${t}>`;
    if (t === 'a') {
      const href = (/href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs) || []).slice(1).find(Boolean) || '';
      return /^(https?:|mailto:|tel:|\{\{)/i.test(href) ? `<a href="${href.replace(/"/g, '&quot;')}">` : '<a>';
    }
    return `<${t}>`;
  });
  s = s.replace(/<a>([\s\S]*?)<\/a>/g, '$1').trim();
  if (s && !/<(p|ul|ol)\b/i.test(s)) s = s.split(/\n{2,}/).map((x) => `<p>${x.trim().replace(/\n/g, '<br>')}</p>`).join('');
  return s;
}

/** מחלץ JSON מתשובה, גם אם המנוע עטף אותו בטקסט או בגדר קוד. */
export function parseJson(text) {
  const s = String(text || '').replace(/```(?:json)?/g, '');
  const a = s.search(/[[{]/);
  if (a < 0) throw new AiError('המנוע החזיר תשובה במבנה לא צפוי. נסה שוב.');
  const close = s[a] === '{' ? '}' : ']';
  try { return JSON.parse(s.slice(a, s.lastIndexOf(close) + 1)); } catch { throw new AiError('המנוע החזיר תשובה במבנה לא צפוי. נסה שוב.'); }
}
