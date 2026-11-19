// הפסקות שליחה: שבת (מיום שישי בצהריים עד מוצאי שבת בחצות) וטווחי תאריכים שהוגדרו ידנית. הכול לפי שעון ישראל.
const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** השעה בישראל כמחרוזת YYYY-MM-DDTHH:mm, ויום בשבוע. מחרוזות בצורה הזו אפשר להשוות ישירות. */
export function israelNow(ms = Date.now()) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { stamp: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`, weekday: p.weekday, hour: Number(p.hour), date: `${p.year}-${p.month}-${p.day}` };
}

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
/** מנקה רשימת טווחים שהגיעה מהממשק: רק טווחים תקינים שסופם אחרי תחילתם, עד 30. */
export function cleanRanges(input) {
  let list = input;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = []; } }
  return (Array.isArray(list) ? list : []).map((r) => ({ from: String(r?.from || '').slice(0, 16), to: String(r?.to || '').slice(0, 16), note: String(r?.note || '').slice(0, 80) }))
    .filter((r) => STAMP.test(r.from) && STAMP.test(r.to) && r.to > r.from).slice(0, 30);
}

/** האם השליחה מושהית עכשיו, ולמה. */
export function pauseInfo(settings, ms = Date.now()) {
  const t = israelNow(ms);
  if (settings.pauseShabbat === '1' && ((t.weekday === 'Fri' && t.hour >= 12) || t.weekday === 'Sat')) {
    return { paused: true, reason: 'הפסקת שבת: השליחה תתחדש במוצאי שבת בחצות' };
  }
  const hit = cleanRanges(settings.pauseRanges).find((r) => t.stamp >= r.from && t.stamp < r.to);
  if (hit) return { paused: true, reason: `הפסקה שהוגדרה${hit.note ? ` (${hit.note})` : ''}: השליחה תתחדש ב-${hit.to.slice(8, 10)}/${hit.to.slice(5, 7)}/${hit.to.slice(0, 4)} בשעה ${hit.to.slice(11)}` };
  return { paused: false, reason: '' };
}
