// Clients directory: pure helpers (no database). Country names are standardised for display and filtering only — stored data is not changed.
const ALIAS = {
  usa: 'United States', us: 'United States', 'u.s.': 'United States', 'u.s.a.': 'United States', 'united states of america': 'United States', america: 'United States', сша: 'United States',
  uk: 'United Kingdom', 'u.k.': 'United Kingdom', 'great britain': 'United Kingdom', england: 'United Kingdom', britain: 'United Kingdom',
  rf: 'Russia', 'russian federation': 'Russia', россия: 'Russia', рф: 'Russia', 'р.ф.': 'Russia',
  prc: 'China', "people's republic of china": 'China', китай: 'China', 'p.r.c.': 'China',
  uae: 'United Arab Emirates', 'u.a.e.': 'United Arab Emirates', оаэ: 'United Arab Emirates',
  korea: 'South Korea', 'republic of korea': 'South Korea', holland: 'Netherlands', 'the netherlands': 'Netherlands',
  беларусь: 'Belarus', казахстан: 'Kazakhstan', германия: 'Germany', турция: 'Turkey', türkiye: 'Turkey', turkiye: 'Turkey', швеция: 'Sweden',
};
let names = null;
try { names = new Intl.DisplayNames(['en'], { type: 'region' }); } catch { /* old runtime: codes stay as typed */ }
/** "usa", "U.S.A", "us", "Russian Federation" → one spelling; two-letter ISO codes → English name; anything else is kept, trimmed */
export function normCountry(v) {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const k = t.toLowerCase();
  if (ALIAS[k]) return ALIAS[k];
  if (/^[A-Za-z]{2}$/.test(t) && names) { try { const n = names.of(t.toUpperCase()); if (n && n !== t.toUpperCase()) return n; } catch { /* not a region code */ } }
  return t.length > 3 && t === t.toLowerCase() ? t.replace(/(^|\s)\S/g, c => c.toUpperCase()) : t;
}

export const SORTS = { name: 'Client', country: 'Country', requests: 'Requests', orders: 'Orders', activity: 'Last activity' };
export const PAGE = 50;
const fold = s => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

/**
 * orgs: organizations rows; users: [{org_id, full_name, email}]; reqs: [{org_id, created_at}]; ords: [{org_id, updated_at|created_at}]
 * query: { q, country, currency, state (all|active|inactive), sort, dir (asc|desc), page }
 * → { rows, total, all, page, pages, from, to, countries, currencies, sort, dir }
 */
export function buildClients({ orgs = [], users = [], reqs = [], ords = [] }, query = {}) {
  const by = (list, f) => { const m = new Map(); list.forEach(x => { if (x.org_id) m.set(x.org_id, f(m.get(x.org_id), x)); }); return m; };
  const nUsers = by(users, c => (c || 0) + 1), nReq = by(reqs, c => (c || 0) + 1), nOrd = by(ords, c => (c || 0) + 1);
  const people = by(users, (c, u) => (c ? c + ' ' : '') + [u.full_name, u.email].filter(Boolean).join(' '));
  const last = new Map();
  [...reqs.map(r => [r.org_id, r.updated_at || r.created_at]), ...ords.map(o => [o.org_id, o.updated_at || o.created_at])].forEach(([id, t]) => { if (id && t && (!last.get(id) || t > last.get(id))) last.set(id, t); });
  const all = orgs.map(o => ({ ...o, countryName: normCountry(o.country), users: nUsers.get(o.id) || 0, requests: nReq.get(o.id) || 0, orders: nOrd.get(o.id) || 0, lastActivity: last.get(o.id) || null, people: people.get(o.id) || '' }));
  const countries = [...new Set(all.map(c => c.countryName).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const currencies = [...new Set(all.map(c => c.default_currency).filter(Boolean))].sort();
  const q = fold(query.q).trim(), words = q.split(/\s+/).filter(Boolean);
  let rows = all.filter(c => {
    if (query.country === '_none' ? c.countryName : query.country && c.countryName !== query.country) return false;
    if (query.currency && c.default_currency !== query.currency) return false;
    if (query.state === 'active' && c.active === false) return false;
    if (query.state === 'inactive' && c.active !== false) return false;
    if (!words.length) return true;
    const hay = fold([c.name, c.country, c.countryName, c.city, c.email, c.phone, c.people].join(' '));
    return words.every(w => hay.includes(w));
  });
  const sort = SORTS[query.sort] ? query.sort : 'name', dir = query.dir === 'desc' ? 'desc' : 'asc', k = dir === 'desc' ? -1 : 1;
  const text = (a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true });
  const cmp = { name: (a, b) => text(a.name, b.name), requests: (a, b) => a.requests - b.requests, orders: (a, b) => a.orders - b.orders,
    activity: (a, b) => (!a.lastActivity) - (!b.lastActivity) || String(a.lastActivity || '').localeCompare(String(b.lastActivity || '')) };
  rows = rows.slice().sort((a, b) => (sort === 'country' ? (!a.countryName) - (!b.countryName) || k * text(a.countryName, b.countryName) : sort === 'activity' ? (!a.lastActivity) - (!b.lastActivity) || k * cmp.activity(a, b) : k * cmp[sort](a, b)) || text(a.name, b.name));
  const total = rows.length, pages = Math.max(1, Math.ceil(total / PAGE)), page = Math.min(pages, Math.max(1, parseInt(query.page, 10) || 1));
  return { rows: rows.slice((page - 1) * PAGE, page * PAGE), total, all: all.length, page, pages, from: total ? (page - 1) * PAGE + 1 : 0, to: Math.min(total, page * PAGE), countries, currencies, hasNoCountry: all.some(c => !c.countryName), sort, dir };
}
