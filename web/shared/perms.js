// רשימת ההרשאות. משותפת לשרת ולדפדפן.
export const PERM_GROUPS = [
  ['גליונות', [
    ['campaigns.view', 'צפייה בגליונות'], ['campaigns.edit', 'יצירה ועריכה, בלוקים שמורים, ושליחת בדיקה לכתובות הקבועות'],
    ['campaigns.send', 'שליחה, תזמון, השהיה ואוטומציות'], ['stats.view', 'נתוני שליחה ורשימות נמענים לפי תגובה'],
  ]],
  ['נמענים', [
    ['subscribers.view', 'צפייה בנמענים'], ['subscribers.edit', 'הוספה, עריכה ופעולות מרוכזות'],
    ['subscribers.import', 'ייבוא'], ['subscribers.export', 'ייצוא'],
  ]],
  ['רשימות תפוצה', [['lists.view', 'צפייה ברשימות'], ['lists.edit', 'יצירה ועריכה']]],
  ['ניהול', [['settings.manage', 'הגדרות המערכת ודף ההרשמה'], ['users.manage', 'ניהול משתמשים והרשאות']]],
];
export const ALL_PERMS = PERM_GROUPS.flatMap(([, items]) => items.map(([key]) => key));

const RULES = [
  [/^\/(logout|password|dashboard)$/, null],
  [/^\/users/, 'users.manage'],
  [/^\/settings/, 'settings.manage'],
  [/^\/backups/, 'settings.manage'],
  [/^\/system/, 'settings.manage'],
  [/^\/legacy/, 'campaigns.edit'],
  [/^\/upload$/, ['campaigns.edit', 'settings.manage']],
  [/^\/lists/, { GET: 'lists.view', _: 'lists.edit' }],
  [/^\/import$/, 'subscribers.import'],
  [/^\/export$/, 'subscribers.export'],
  [/^\/subscribers/, { GET: 'subscribers.view', _: 'subscribers.edit' }],
  [/^\/(brand|blocks)/, { GET: 'campaigns.view', _: 'campaigns.edit' }],
  [/^\/campaigns\/:id\/(send|pause|resume|unschedule)$/, 'campaigns.send'],
  [/^\/campaigns\/:id\/(stats|people|people\.csv)$/, 'stats.view'],
  [/^\/campaigns\/:id\/check$/, 'campaigns.view'],
  [/^\/campaigns/, { GET: 'campaigns.view', _: 'campaigns.edit' }],
  [/^\/ai\/test$/, 'settings.manage'],
  [/^\/ai$/, 'campaigns.edit'],
  [/^\/queue$/, 'campaigns.view'],
  [/^\/automations/, { GET: 'campaigns.view', _: 'campaigns.send' }],
];

/** ההרשאה הנדרשת לנתיב API. נתיב שלא מופיע בכללים פתוח למנהלים בלבד. */
export function permFor(method, pattern) {
  for (const [rx, rule] of RULES) {
    if (!rx.test(pattern)) continue;
    if (rule === null || typeof rule === 'string' || Array.isArray(rule)) return rule;
    return rule[method] || rule._;
  }
  return 'users.manage';
}
