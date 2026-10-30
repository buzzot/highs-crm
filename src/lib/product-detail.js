// Product detail page — pure helpers (no database), so they are easy to test.

// Specification keys that really belong to sourcing (they are written into `spec` when a supplier submits a product).
// They are shown on the Sourcing & Costing tab instead of the technical specification table.
export const SOURCING = [
  ['incoterm', /^incoterm$/i, 'Price basis'],
  ['port', /^fob port( \/ delivery point)?$/i, 'Port / delivery point'],
  ['payment', /^payment terms$/i, 'Payment terms'],
  ['lead', /^production lead time( \(days\))?$/i, 'Production lead time'],
  ['sample', /^sample lead time( \(days\))?$/i, 'Sample lead time'],
  ['valid', /^quote valid until$/i, 'Quote valid until'],
];
export const TYPE_KEY = /^(product )?(type|kind)$/i;
const PACK_KEYS = [/^inner pack/i, /^carton net weight/i, /^units per (20|40)/i];

/** Splits the free-form specification into sourcing facts, packing extras and the technical rows. */
export function splitSpec(spec) {
  const src = spec && typeof spec === 'object' && !Array.isArray(spec) ? spec : {};
  const sourcing = {}, packing = [], tech = [];
  for (const [k, raw] of Object.entries(src)) {
    const v = String(raw ?? '').trim();
    if (!v) continue;
    const key = String(k).trim();
    const s = SOURCING.find(x => x[1].test(key));
    if (s) { sourcing[s[0]] = v; continue; }
    if (TYPE_KEY.test(key)) continue;                       // shown as the product type in the header
    if (PACK_KEYS.some(re => re.test(key))) { packing.push([key, v]); continue; }
    tech.push([key, v]);
  }
  return { sourcing, packing, tech };
}
export const SOURCING_LABELS = Object.fromEntries(SOURCING.map(([k, , l]) => [k, l]));

const n = v => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const trim = (x, d) => String(Math.round(x * 10 ** d) / 10 ** d);
/** "30 × 20 × 10 cm" — only when all three sides are known. */
export function sizeText(l, w, h) { const a = [l, w, h].map(n); return a.every(x => x > 0) ? `${a.map(x => trim(x, 1)).join(' × ')} cm` : ''; }

/** Unit and carton facts as label/value pairs (empty ones left out, never shown as blanks). */
export function physicalFacts(p) {
  const unit = [], carton = [];
  const add = (list, label, v) => { if (v) list.push([label, v]); };
  add(unit, 'Weight', n(p.unit_weight_kg) > 0 ? `${trim(n(p.unit_weight_kg), 3)} kg` : '');
  add(unit, 'Size', sizeText(p.unit_length_cm, p.unit_width_cm, p.unit_height_cm));
  add(carton, 'Pieces per carton', n(p.carton_qty) > 0 ? String(p.carton_qty) : '');
  add(carton, 'Carton size', sizeText(p.carton_length_cm, p.carton_width_cm, p.carton_height_cm));
  add(carton, 'Carton volume', n(p.carton_cbm) > 0 ? `${trim(n(p.carton_cbm), 4)} cbm` : '');
  add(carton, 'Carton weight', n(p.carton_weight_kg) > 0 ? `${trim(n(p.carton_weight_kg), 2)} kg` : '');
  return { unit, carton };
}

/** Quotes for this product. `margin_pct` on a quote is a MARKUP on cost: price = cost × FX × (1 + margin_pct/100). */
export function quoteRows(quotes = []) {
  return quotes.map(q => ({
    id: q.id, ref: q.requests?.ref || '', client: q.requests?.organizations?.name || '', requestId: q.requests?.id || null,
    qty: q.quantity, cost: n(q.unit_cost), costCur: q.cost_currency, price: n(q.unit_price), priceCur: q.sell_currency,
    markupPct: n(q.margin_pct), status: q.status, at: q.created_at, incoterm: q.incoterm || '',
  }));
}

/** The lines of this product in each supplier purchase order. */
export function poRows(pos = [], productId) {
  const out = [];
  for (const po of pos) {
    const lines = (Array.isArray(po.lines) ? po.lines : []).filter(l => l && l.product_id === productId);
    if (!lines.length) continue;
    const qty = lines.reduce((s, l) => s + (n(l.quantity) || 0), 0);
    const last = lines[lines.length - 1];
    out.push({ id: po.id, ref: po.ref, status: po.status, currency: po.currency, qty, unitPrice: n(last.unit_price), supplier: po.suppliers?.name || '', supplierId: po.supplier_id || null, orderNo: po.orders?.order_no || '', at: po.created_at });
  }
  return out;
}

/** Order lines of this product. */
export function orderRows(items = []) {
  return items.map(i => ({ id: i.orders?.id || i.order_id, orderNo: i.orders?.order_no || '', client: i.orders?.organizations?.name || '', status: i.orders?.status || '',
    qty: i.quantity, price: n(i.unit_price), cost: n(i.unit_cost), currency: i.orders?.currency || '', at: i.orders?.created_at || null })).filter(r => r.id);
}

/** Customer requests this product was quoted in: one row per request, newest first, with how often it was quoted. */
export function requestRows(quotes = []) {
  const by = new Map();
  for (const q of quoteRows(quotes)) {
    if (!q.requestId) continue;
    const cur = by.get(q.requestId) || { id: q.requestId, ref: q.ref, client: q.client, quotes: 0, qty: 0, at: q.at };
    cur.quotes++; cur.qty = Math.max(cur.qty, q.qty || 0); if (String(q.at) > String(cur.at)) cur.at = q.at;
    by.set(q.requestId, cur);
  }
  return [...by.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

const IMG_EXT = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;
/** An attachment is an image by its stored type — or, when the type was not saved, by its file name. */
export const isImageDoc = d => !!d && ((d.mime_type || '').startsWith('image/') || (!d.mime_type && (IMG_EXT.test(d.storage_path || '') || IMG_EXT.test(d.title || ''))));
/** Product photos: the chosen primary first (when the product has one), then the rest oldest first. */
export function productPhotos(docs = [], primaryId = null) {
  const all = docs.filter(d => d.kind === 'product_photo' && isImageDoc(d)).slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const i = primaryId ? all.findIndex(d => d.id === primaryId) : -1;
  return i > 0 ? [all[i], ...all.slice(0, i), ...all.slice(i + 1)] : all;       // a chosen primary goes first; otherwise the first uploaded is the primary
}
