// Interface language for the client portal. English is the default and costs nothing: pages are only touched when the
// signed-in client chose Russian (cookie "lang=ru"). The Russian dictionary is read once at start-up; each page is
// translated in one pass over its finished HTML (text between tags + a few attributes), so templates stay as they are.
import { RU, RU_PATTERNS } from './i18n-ru.js';
import { RU_EMAIL, RU_EMAIL_PATTERNS } from './i18n-email-ru.js';

export const LANGS = ['en', 'ru'];
export const LANG_COOKIE = 'lang';

const exact = new Map(Object.entries({ ...RU, ...RU_EMAIL }));
const lower = new Map(Object.entries(RU).map(([k, v]) => [k.toLowerCase(), v]));
const PATTERNS = [...RU_PATTERNS, ...RU_EMAIL_PATTERNS];
const MONTHS = { Jan: 'янв', Feb: 'фев', Mar: 'мар', Apr: 'апр', May: 'мая', Jun: 'июн', Jul: 'июл', Aug: 'авг', Sep: 'сен', Oct: 'окт', Nov: 'ноя', Dec: 'дек' };
const monthRe = /\b(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/g;
const unitRe = /(\d) ?(pcs|ctns?|cartons|kg|cbm|days|minutes)\b/g;
const UNITS = { pcs: 'шт', ctn: 'кор.', ctns: 'кор.', cartons: 'кор.', kg: 'кг', cbm: 'м³', days: 'дн.', minutes: 'мин.' };
const cap = (src, out) => (/^\p{Lu}/u.test(src) ? out.charAt(0).toUpperCase() + out.slice(1) : out);
const unesc = s => s.replace(/&rarr;/g, '→').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const LEAD = /^[\s←→·—•]+/, TAIL = /[\s←→·—•]+$/;

/** Russian for one piece of text, or null when we have none. `t` has no surrounding spaces. */
function tr(t) {
  if (!t || t.length > 400) return null;
  let r = exact.get(t);
  if (r !== undefined) return r;
  r = lower.get(t.toLowerCase());
  if (r !== undefined) return cap(t, r);
  for (const [re, to] of PATTERNS) if (re.test(t)) return t.replace(re, to).replace(monthRe, (m, d, mo) => d + ' ' + MONTHS[mo]);
  let m = /^(.*) · Lumi Trade$/.exec(t);                       // page titles
  if (m) { const x = tr(m[1]); return (x ?? m[1]) + ' · Lumi Trade'; }
  m = /^status (.+?)( — .*)?$/.exec(t);                        // timeline: "status in production — note"
  if (m) { const x = tr(m[1]); if (x) return 'статус ' + x + (m[2] || ''); }
  const a = LEAD.exec(t)?.[0] || '', b = TAIL.exec(t)?.[0] || '';   // "← Orders", "View all →", "— optional"
  if ((a || b) && t.length > a.length + b.length) { const x = tr(t.slice(a.length, t.length - b.length)); if (x) return a + x + b; }
  if (/\d/.test(t) && (monthRe.test(t) || unitRe.test(t))) {   // dates and quantities: "14 Oct, 11:35", "1,500 pcs"
    monthRe.lastIndex = 0; unitRe.lastIndex = 0;
    return t.replace(monthRe, (x, d, mo) => d + ' ' + MONTHS[mo]).replace(unitRe, (x, n, u) => n + ' ' + UNITS[u]);
  }
  monthRe.lastIndex = 0; unitRe.lastIndex = 0;
  return null;
}

function text(raw) {
  const core = raw.trim();
  if (!core) return raw;
  const r = tr(unesc(core).replace(/\s+/g, ' '));
  return r == null ? raw : raw.slice(0, raw.indexOf(core)) + esc(r) + raw.slice(raw.indexOf(core) + core.length);
}

/** Translate a rendered page to Russian. */
export function toRussian(html) {
  return html
    .replace('<html lang="en">', '<html lang="ru">')
    .replace(/>([^<>]+)</g, (m, t) => '>' + text(t) + '<')
    .replace(/\b(placeholder|title|aria-label|alt)="([^"]+)"/g, (m, k, v) => { const r = tr(unesc(v)); return r == null ? m : `${k}="${esc(r).replace(/"/g, '&quot;')}"`; })
    .replace(/confirm\('([^']*)'\)/g, (m, q) => { const r = tr(q); return r == null ? m : `confirm('${r.replace(/'/g, "\\'")}')`; })
    .replace(/'(Reading the files…|Filled from your files — please check it\.|Nothing new found in the files\.|AI could not read the files\.|Click again to remove)'/g, (m, q) => { const r = tr(q); return r == null ? m : `'${r}'`; });
}

const plain = html => html.replace(/<(br|\/p|\/li|\/tr)\b[^>]*>/gi, '\n').replace(/<(style|title)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();

/** Turn an email ({ subject, html, text }) into Russian when `lang` is "ru"; otherwise returned untouched. */
export function localizeEmail(msg, lang) {
  if (lang !== 'ru' || !msg) return msg;
  const html = toRussian(msg.html || '');
  return { ...msg, subject: tr(unesc(msg.subject || '')) ?? msg.subject, html, text: plain(html) };
}

/** Chosen language from the cookie header value ("en" unless the visitor picked another one we know). */
export { tr as translateText };
export const pickLang = cookieValue => (cookieValue === 'ru' ? 'ru' : 'en');
