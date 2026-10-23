// Supplier "Add product" wizard: field list, cleaning, completeness check, and the mapping to a real product row.

export const CURRENCIES = ['USD', 'CNY', 'EUR'];
export const INCOTERMS = ['EXW', 'FCA', 'FOB', 'CIF', 'CFR', 'DAP', 'DDP'];
export const CATEGORIES = ['Electronics', 'Lighting', 'Batteries', 'Home & kitchen', 'Toys', 'Tools & hardware', 'Auto parts', 'Packaging', 'Textiles & apparel', 'Rubber & plastics', 'Other'];

const TEXT = ['name', 'sku', 'category', 'subcategory', 'materials', 'size', 'packaging_type', 'certifications', 'hs_code', 'origin', 'brand', 'battery',
  'currency', 'incoterm', 'fob_port', 'payment_terms', 'valid_until', 'photo_link'];
const LONG = ['description', 'factory_notes'];
const NUM = ['unit_weight_kg', 'unit_price', 'moq', 'sample_days', 'lead_days', 'inner_pack', 'carton_qty', 'carton_l', 'carton_w', 'carton_h', 'net_kg', 'gross_kg', 'u20gp', 'u40gp', 'u40hq'];
export const FIELDS = [...TEXT, ...LONG, ...NUM];

const num = v => {
  const n = Number(String(v ?? '').replace(',', '.').trim());
  return String(v ?? '').trim() !== '' && Number.isFinite(n) && n >= 0 ? n : null;
};

/** Clean the posted form into the stored shape (trimmed strings, numbers or null). */
export function clean(body = {}) {
  const out = {};
  TEXT.forEach(k => { out[k] = String(body[k] ?? '').trim().slice(0, 300); });
  LONG.forEach(k => { out[k] = String(body[k] ?? '').trim().slice(0, 4000); });
  NUM.forEach(k => { out[k] = num(body[k]); });
  if (!CURRENCIES.includes(out.currency)) out.currency = 'USD';
  if (out.photo_link && !/^https?:\/\//i.test(out.photo_link)) out.photo_link = 'https://' + out.photo_link;
  return out;
}

/** What is still missing before the supplier submits (they may submit anyway; complete ones are reviewed first). `step` is the wizard step to jump to. */
export function missing(d = {}, photoCount = 0) {
  const m = [];
  if (!(d.unit_price > 0)) m.push({ key: 'unit_price', label: 'Unit price', step: 2 });
  if (!photoCount && !d.photo_link) m.push({ key: 'photos', label: 'Photos or a photo link', step: 0 });
  if (!(d.carton_qty > 0) || !(d.carton_l > 0 && d.carton_w > 0 && d.carton_h > 0)) m.push({ key: 'carton', label: 'Carton size and units per carton', step: 3 });
  if (!(d.gross_kg > 0)) m.push({ key: 'gross_kg', label: 'Carton gross weight', step: 3 });
  return m;
}

/** Carton volume in m³ and how many units fit in each standard container (by volume, 85% usable). */
export function containerFit(d = {}) {
  const cbm = d.carton_l > 0 && d.carton_w > 0 && d.carton_h > 0 ? d.carton_l * d.carton_w * d.carton_h / 1e6 : 0;
  if (!cbm || !(d.carton_qty > 0)) return null;
  const fit = cap => Math.floor(cap * 0.85 / cbm) * d.carton_qty;
  return { cartonCbm: Math.round(cbm * 10000) / 10000, gp20: fit(28), gp40: fit(58), hq40: fit(68) };
}

const parseSize = s => {
  const m = String(s || '').match(/(\d+(?:[.,]\d+)?)\s*[x×*]\s*(\d+(?:[.,]\d+)?)\s*[x×*]\s*(\d+(?:[.,]\d+)?)/i);
  return m ? m.slice(1, 4).map(v => Number(v.replace(',', '.'))) : [null, null, null];
};

/** The row for the products table. Extra details go into the product's "spec" notes (shown as Key: value lines). */
export function toProduct(d, supplierId) {
  const [ul, uw, uh] = parseSize(d.size);
  const cbm = d.carton_l > 0 && d.carton_w > 0 && d.carton_h > 0 ? Math.round(d.carton_l * d.carton_w * d.carton_h / 1e6 * 10000) / 10000 : null;
  const spec = {};
  const put = (k, v) => { if (v !== null && v !== undefined && String(v).trim() !== '') spec[k] = String(v); };
  put('Subcategory', d.subcategory); put('Materials', d.materials); put('Product size (cm)', d.size); put('Packaging type', d.packaging_type);
  put('Certifications', d.certifications); put('Country of origin', d.origin); put('Brand', d.brand); put('Battery / magnet / liquid', d.battery);
  put('Incoterm', d.incoterm); put('FOB port / delivery point', d.fob_port); put('Payment terms', d.payment_terms);
  put('Sample lead time (days)', d.sample_days); put('Production lead time (days)', d.lead_days); put('Quote valid until', d.valid_until);
  put('Inner pack (pcs)', d.inner_pack); put('Carton net weight (kg)', d.net_kg);
  put('Units per 20GP', d.u20gp); put('Units per 40GP', d.u40gp); put('Units per 40HQ', d.u40hq);
  put('Factory notes', d.factory_notes); put('Photo link', d.photo_link);
  return {
    name: d.name, supplier_sku: d.sku || null, category: d.category || null, description: d.description || null, supplier_id: supplierId, spec,
    unit_cost: d.unit_price, cost_currency: d.currency || 'USD', moq: d.moq != null ? Math.round(d.moq) : null, hs_code: d.hs_code || null,
    unit_weight_kg: d.unit_weight_kg, unit_length_cm: ul, unit_width_cm: uw, unit_height_cm: uh,
    carton_qty: d.carton_qty != null ? Math.round(d.carton_qty) : null, carton_length_cm: d.carton_l, carton_width_cm: d.carton_w, carton_height_cm: d.carton_h,
    carton_cbm: cbm, carton_weight_kg: d.gross_kg,
  };
}
