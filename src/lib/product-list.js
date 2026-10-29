// Products directory — filtering, sorting and paging (pure: takes rows that already carry their estimates in `m`).
const nz = (v, empty = Infinity) => (v == null ? empty : Number(v));
const txt = (a, b) => String(a || '').localeCompare(String(b || ''));
export const SORT_DEFS = {
  name: ['Name A–Z', (a, b) => txt(a.name, b.name)], name_desc: ['Name Z–A', (a, b) => txt(b.name, a.name)],
  newest: ['Newest first', (a, b) => String(b.created_at).localeCompare(String(a.created_at))],
  supplier: ['Supplier A–Z', (a, b) => txt(a.suppliers?.name || '￿', b.suppliers?.name || '￿')], supplier_desc: ['Supplier Z–A', (a, b) => txt(b.suppliers?.name, a.suppliers?.name)],
  category: ['Category A–Z', (a, b) => txt(a.category || '￿', b.category || '￿')],
  price: ['Factory price ↑', (a, b) => nz(a.m.priceUsd) - nz(b.m.priceUsd)], price_desc: ['Factory price ↓', (a, b) => nz(b.m.priceUsd, -1) - nz(a.m.priceUsd, -1)],
  landed: ['Landed ↑', (a, b) => nz(a.m.landedUsd) - nz(b.m.landedUsd)], landed_desc: ['Landed ↓', (a, b) => nz(b.m.landedUsd, -1) - nz(a.m.landedUsd, -1)],
  wholesale: ['Wholesale ↑', (a, b) => nz(a.m.wholesaleUsd) - nz(b.m.wholesaleUsd)], wholesale_desc: ['Wholesale ↓', (a, b) => nz(b.m.wholesaleUsd, -1) - nz(a.m.wholesaleUsd, -1)],
  moq: ['MOQ ↑', (a, b) => nz(a.moq) - nz(b.moq)], moq_desc: ['MOQ ↓', (a, b) => nz(b.moq, -1) - nz(a.moq, -1)],
  per40_asc: ['Units / 40HQ ↑', (a, b) => nz(a.m.unitsPer40hq) - nz(b.m.unitsPer40hq)], per40: ['Units / 40HQ ↓', (a, b) => nz(b.m.unitsPer40hq, -1) - nz(a.m.unitsPer40hq, -1)],
  issues: ['Most missing data', (a, b) => (b.m.critical.length - a.m.critical.length) || (b.m.issues.length - a.m.issues.length)],
};
export const PAGE_SIZE = 100;


/** Filter, sort and compute estimates for the products (pure — takes the loaded rows). */
export function filterProducts(all, query = {}) {
  const q = String(query.q || '').trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  let rows = all.filter(p => {
    const hay = [p.name, p.sku, p.supplier_sku, p.hs_code, p.category, p.description, p.suppliers?.name].map(x => String(x || '').toLowerCase()).join(' \n ');
    return words.every(w => hay.includes(w))
      && (!query.category || p.category === query.category)
      && (!query.supplier || p.supplier_id === query.supplier)
      && (!query.issues || (query.issues === 'critical' ? p.m.critical.length > 0 : p.m.issues.length > 0));
  });
  const sort = SORT_DEFS[query.sort] ? query.sort : 'name';
  rows = rows.sort(SORT_DEFS[sort][1]);
  return { rows, sort };
}


/** Page `want` (1-based, clamped) of the rows. */
export function paginate(rows, want, size = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(rows.length / size)), page = Math.min(pages, Math.max(1, parseInt(want, 10) || 1));
  return { pages, page, shown: rows.slice((page - 1) * size, page * size) };
}
