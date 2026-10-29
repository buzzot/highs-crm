// Suppliers directory: pure helpers (no database). Country spelling is standardised for display and search only — stored data is never changed.
import { normCountry } from './clients.js';

export const ROLE = { factory: 'Manufacturer', trading: 'Trading company', both: 'Manufacturer + trading' };
export const SORTS = { name: 'Supplier', status: 'Relationship', location: 'Location', followup: 'Next follow-up', products: 'Products', pos: 'Purchase orders', rating: 'Rating', lead: 'Lead time' };
export const PORTAL_LABEL = { active: 'Portal active', invited: 'Invited', expired: 'Invitation expired', none: 'No portal access' };
const fold = s => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const dom = e => String(e || '').split('@')[1] || '';

/** Portal state per supplier: active (someone signed up and is enabled) > invited (open invitation) / expired > none. */
export function portalMap(users = [], invites = [], now = Date.now()) {
  const m = {};
  for (const u of users) if (u.supplier_id && u.accepted_at && u.active) m[u.supplier_id] = 'active';
  for (const i of invites) if (i.supplier_id && !m[i.supplier_id]) m[i.supplier_id] = new Date(i.expires_at) > now ? 'invited' : 'expired';
  return m;
}

/**
 * suppliers: supplier rows; portal: portalMap(); products: [{supplier_id, name, category}]; pos: [{supplier_id}]; people: portal users [{supplier_id, full_name, email}]
 * query: { q, view (all|followup|invites), status (''|<relationship status>), portal (''|active|invited|expired|none), sort, dir }; crmOrder: the relationship statuses in workflow order
 * Quick views: followup = an outstanding follow-up date that is due today or past; invites = a portal invitation that is still open or has expired without the supplier registering.
 * → { rows, total, all, counts, hasFollow, sort, dir }
 */
export function buildSuppliers({ suppliers = [], portal = {}, products = [], pos = [], people = [], crmOrder = [] }, query = {}, today = new Date().toISOString().slice(0, 10)) {
  const tally = (list, f) => { const m = new Map(); list.forEach(x => { if (x.supplier_id) m.set(x.supplier_id, f(m.get(x.supplier_id), x)); }); return m; };
  const nProd = tally(products, c => (c || 0) + 1), nPo = tally(pos, c => (c || 0) + 1);
  const prodText = tally(products, (c, p) => (c ? c + ' ' : '') + [p.name, p.category].filter(Boolean).join(' '));
  const ppl = new Map(); people.forEach(p => { if (p.supplier_id) (ppl.get(p.supplier_id) || ppl.set(p.supplier_id, []).get(p.supplier_id)).push(p); });
  const all = suppliers.map(s => {
    const ps = portal[s.id] || 'none', status = s.crm_status || 'active';
    const placeholder = !s.details_completed_at && /^\(.*\)$/.test(String(s.name || '').trim());   // "(domain.com)" made when the supplier was invited
    const awaiting = !s.details_completed_at && (ps === 'invited' || ps === 'expired');
    const known = [s.contact_name, s.email].filter(Boolean).map(x => String(x).toLowerCase());
    // portal users who are not the primary contact (a second buyer, a sales assistant…)
    const others = (ppl.get(s.id) || []).filter(p => !known.includes(String(p.email || '').toLowerCase()) && !known.includes(String(p.full_name || '').toLowerCase()));
    const countryName = normCountry(s.country);
    return { ...s, status, portal: ps, placeholder, awaiting, shownName: placeholder ? String(s.name).trim().replace(/^\(|\)$/g, '') : s.name, domain: dom(s.email), role: ROLE[s.company_type] || '',
      countryName, place: [s.city, countryName].filter(Boolean).join(', '), nProducts: nProd.get(s.id) || 0, nPos: nPo.get(s.id) || 0, otherContacts: others,
      overdue: !!s.next_follow_up && s.next_follow_up < today, dueToday: s.next_follow_up === today,
      hay: fold([s.name, s.country, countryName, s.city, s.contact_name, s.email, s.phone, s.wechat, s.main_products, ROLE[s.company_type], prodText.get(s.id), others.map(p => [p.full_name, p.email].join(' ')).join(' ')].join(' ')) };
  });
  const isDue = x => !!x.next_follow_up && x.next_follow_up <= today, isInvite = x => x.portal === 'invited' || x.portal === 'expired';
  const counts = { all: all.length, followup: all.filter(isDue).length, invites: all.filter(isInvite).length };
  all.forEach(x => { counts[x.status] = (counts[x.status] || 0) + 1; });
  const words = fold(query.q).trim().split(/\s+/).filter(Boolean), view = ['followup', 'invites'].includes(query.view) ? query.view : 'all';
  let rows = all.filter(x => {
    if (view === 'followup' && !isDue(x)) return false;
    if (view === 'invites' && !isInvite(x)) return false;
    if (query.status && x.status !== query.status) return false;
    if (query.portal && x.portal !== query.portal) return false;
    return words.every(w => x.hay.includes(w));
  });
  const sort = SORTS[query.sort] ? query.sort : 'name', dir = query.dir === 'desc' ? 'desc' : 'asc', k = dir === 'desc' ? -1 : 1;
  const text = (a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true });
  const nulls = (a, b) => (a == null || a === '') - (b == null || b === '');   // missing values always last
  const key = { name: x => x.shownName, status: x => crmOrder.indexOf(x.status), location: x => x.countryName ? x.countryName + ' ' + (x.city || '') : '', followup: x => x.next_follow_up || '',
    products: x => x.nProducts, pos: x => x.nPos, rating: x => x.rating || null, lead: x => x.lead_time_days || null }[sort];
  rows = rows.slice().sort((a, b) => nulls(key(a), key(b)) || k * (typeof key(a) === 'number' ? key(a) - key(b) : text(key(a), key(b))) || text(a.shownName, b.shownName));
  return { rows, total: rows.length, all: all.length, counts, hasFollow: all.some(x => x.next_follow_up), view, sort, dir };
}
