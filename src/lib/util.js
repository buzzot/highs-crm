/** Turn empty form strings into null so Postgres gets proper NULLs. */
export const clean = (o, allow) => Object.fromEntries(
  Object.entries(o || {})
    .filter(([k]) => !allow || allow.includes(k))
    .map(([k, v]) => [k, v === '' ? null : v]),
);

/** Checkbox → boolean. */
export const bool = v => v === 'on' || v === 'true' || v === true || v === '1';

/** Redirect back with a flash message in the query string. */
export const back = (res, url, { msg, err } = {}) => {
  const q = msg ? `msg=${encodeURIComponent(msg)}` : err ? `err=${encodeURIComponent(err)}` : '';
  res.redirect(q ? `${url}${url.includes('?') ? '&' : '?'}${q}` : url);
};

export const notFound = (res, what = 'Record') => res.status(404).render('error', { title: 'Not found', message: `${what} not found.` });

export async function getSettings(db) {
  const { data } = await db.from('settings').select('key, value');
  const s = Object.fromEntries((data || []).map(r => [r.key, r.value]));
  return {
    fx: s.fx_rates || { CNY_USD: 0.138 },
    pricing: { min_margin_pct: 20, default_margin_pct: 25, ...(s.pricing || {}) },
    // product-list estimates: 40HQ sea freight, usable volume / weight, wholesale markup
    container: { freight_40hq_usd: 4500, container_cbm: 68, container_max_kg: 26500, wholesale_markup_pct: 45, ...(s.container || {}) },
  };
}

/** FX lookup from settings: fxRate(settings, 'CNY', 'USD'). */
export function fxRate(settings, from, to) {
  if (!from || !to || from === to) return 1;
  const fx = settings?.fx || {};
  if (fx[`${from}_${to}`]) return Number(fx[`${from}_${to}`]);
  if (fx[`${to}_${from}`]) return 1 / Number(fx[`${to}_${from}`]);
  // no direct rate: go through USD (e.g. EUR -> CNY = EUR -> USD -> CNY)
  const toUsd = c => (c === 'USD' ? 1 : fx[`${c}_USD`] ? Number(fx[`${c}_USD`]) : fx[`USD_${c}`] ? 1 / Number(fx[`USD_${c}`]) : null);
  const a = toUsd(from), b = toUsd(to);
  if (a && b) return a / b;
  return 1;
}

export const ORDER_STEPS = ['new', 'confirmed', 'deposit_paid', 'in_production', 'qc', 'packed', 'shipped', 'in_transit', 'customs', 'delivered', 'closed'];
export const ORDER_STATUSES = [...ORDER_STEPS, 'cancelled'];
export const REQUEST_STATUSES = ['new', 'reviewing', 'quoted', 'accepted', 'declined', 'cancelled'];
export const SHIPMENT_STATUSES = ['planned', 'booked', 'picked_up', 'departed', 'arrived', 'customs', 'delivered'];
export const SHIPMENT_MODES = ['sea_fcl', 'sea_lcl', 'air', 'rail', 'express'];
export const FREIGHT_TYPES = ['origin_handling', 'export_declaration', 'main_freight', 'insurance', 'destination_handling', 'import_duty', 'import_vat', 'customs_brokerage', 'last_mile', 'other'];
export const DOC_KINDS = ['product_photo', 'packing_photo', 'proforma_invoice', 'commercial_invoice', 'packing_list', 'bill_of_lading', 'airway_bill', 'export_declaration', 'certificate', 'qc_report', 'other'];
export const INCOTERMS = ['EXW', 'FOB', 'FCA', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DDP'];
export const CURRENCIES = ['USD', 'EUR', 'GBP', 'CNY'];

/** Where each kind of user lands after signing in. */
export const homeFor = role => (role === 'client' ? '/portal' : role === 'supplier' ? '/supplier' : '/admin');
