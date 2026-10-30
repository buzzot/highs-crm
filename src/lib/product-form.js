// Edit-product form — pure helpers (no database): the structured specification editor, record type, supplier terms,
// carton volume and validation. The page posts the same fields as before; the specification travels as key/value pairs.
import { SOURCING, TYPE_KEY } from './product-detail.js';

export const RECORD_TYPES = [['', 'Physical product'], ['Sample', 'Sample'], ['Packaging', 'Packaging'], ['Service', 'Service'], ['Freight', 'Freight item']];
export const NON_PHYSICAL = /^(service|services|freight|freight item|shipping)$/i;
export const INCOTERMS = ['EXW', 'FCA', 'FOB', 'CIF', 'CFR', 'DAP', 'DDP'];
export const CURRENCIES = ['CNY', 'USD', 'EUR'];
const find = k => SOURCING.find(x => x[0] === k)[1];
const RES = { incoterm: find('incoterm'), lead: find('lead'), valid: find('valid') };
const CANON = { incoterm: 'Incoterm', lead: 'Production lead time (days)', valid: 'Quote valid until' };

/** The stored specification split for the form: record type, three supplier terms (kept under their own key) and the other rows. Nothing is dropped. */
export function specParts(spec) {
  const src = spec && typeof spec === 'object' && !Array.isArray(spec) ? spec : {};
  const out = { type: '', typeKey: 'Type', incoterm: { key: CANON.incoterm, value: '' }, lead: { key: CANON.lead, value: '' }, valid: { key: CANON.valid, value: '' }, rows: [] };
  for (const [k, raw] of Object.entries(src)) {
    const key = String(k).trim(), v = String(raw ?? '');
    const sk = Object.keys(RES).find(n => RES[n].test(key) && !out[n].value && out[n].key === CANON[n]);
    if (TYPE_KEY.test(key) && !out.type) { out.type = v.trim(); out.typeKey = key; }
    else if (sk) out[sk] = { key, value: v.trim() };
    else out.rows.push([key, v]);
  }
  return out;
}
/** The record-type option for a stored spec: a known type in its canonical spelling, or the stored text itself (kept, never dropped). */
export function recordTypeOf(spec) {
  const t = specParts(spec).type, l = t.toLowerCase();
  if (/^(service|services)$/.test(l)) return 'Service';
  if (/^(freight|freight item|shipping)$/.test(l)) return 'Freight';
  return RECORD_TYPES.find(([v]) => v && v.toLowerCase() === l)?.[0] ?? t;
}
export const isNonPhysical = type => NON_PHYSICAL.test(String(type || '').trim());

const toArr = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
/** Spec rows as posted (spec_k[] / spec_v[]); falls back to the old "Key: value" text so nothing that posts `spec` breaks. */
export function postedRows(b) {
  if (b.spec_k !== undefined) {
    const ks = toArr(b.spec_k), vs = toArr(b.spec_v);
    return ks.map((k, i) => [String(k ?? '').trim(), String(vs[i] ?? '').replace(/\s*\n\s*/g, ' ').trim()]).filter(([k, v]) => k || v);
  }
  return String(b.spec || '').split('\n').map(l => l.split(':')).filter(p => p.length > 1 && p[0].trim()).map(([k, ...v]) => [k.trim(), v.join(':').trim()]);
}
/** Everything the form posts about the specification → the object to store. Existing keys keep their own spelling. */
export function buildSpec(b, existing = {}) {
  const was = specParts(existing), spec = {};
  const type = String(b.record_type ?? '').trim();
  if (type) spec[was.typeKey || 'Type'] = type;
  for (const n of ['incoterm', 'lead', 'valid']) { const v = String(b['src_' + n] ?? '').trim(); if (v) spec[was[n].key] = v; }
  for (const [k, v] of postedRows(b)) if (k) spec[k] = v;
  return spec;
}

/** Carton volume from the three sides (m³, 4 decimals) or null. */
export function cbmFromSize(l, w, h) { const [a, b, c] = [l, w, h].map(Number); return a > 0 && b > 0 && c > 0 ? Math.round(a * b * c / 1e6 * 10000) / 10000 : null; }
/** Entered CBM that disagrees with the size-calculated one by more than 5%. */
export function cbmDiffers(entered, calc) { const e = Number(entered), c = Number(calc); return e > 0 && c > 0 && Math.abs(e - c) / c > 0.05; }

/** Carton CBM to store: the size-calculated value, unless the person ticked "keep the entered CBM" (then their number stays) or the record is non-physical. */
export function cartonCbmToStore(b, physical = true) {
  const calc = cbmFromSize(b.carton_length_cm, b.carton_width_cm, b.carton_height_cm), entered = b.carton_cbm === '' || b.carton_cbm == null ? null : Number(b.carton_cbm);
  if (!physical) return entered;
  if (calc == null) return entered;
  if (entered != null && (b.keep_cbm === 'on' || b.keep_cbm === true) && cbmDiffers(entered, calc)) return entered;
  return calc;
}

const NUMS = [['unit_cost', 'Unit cost', 1e9], ['moq', 'MOQ', 1e9, true], ['unit_weight_kg', 'Unit weight', 100000], ['unit_length_cm', 'Length', 100000], ['unit_width_cm', 'Width', 100000], ['unit_height_cm', 'Height', 100000],
  ['carton_qty', 'Pieces per carton', 1e7, true], ['carton_weight_kg', 'Gross weight', 100000], ['carton_length_cm', 'Length', 100000], ['carton_width_cm', 'Width', 100000], ['carton_height_cm', 'Height', 100000], ['carton_cbm', 'CBM', 1000]];
/** Field-level errors ({ field: message }); an empty object means it can be saved. */
export function validateProduct(b = {}, existing = null) {
  const e = {}, s = k => String(b[k] ?? '').trim();
  const was = specParts(existing || {}), same = (k, n) => s(k) === was[n].value;     // an older free-text value that was not changed is left alone
  if (!s('name')) e.name = 'Enter the product name.'; else if (s('name').length > 300) e.name = 'Keep the name under 300 characters.';
  for (const k of ['sku', 'supplier_sku']) if (s(k).length > 100) e[k] = 'Keep this under 100 characters.';
  if (s('category').length > 100) e.category = 'Keep this under 100 characters.';
  if (s('description').length > 5000) e.description = 'Keep the description under 5,000 characters.';
  for (const [k, label, max, whole] of NUMS) {
    if (!s(k)) continue;
    const v = Number(s(k));
    if (!Number.isFinite(v)) e[k] = `${label} must be a number.`;
    else if (v < 0) e[k] = `${label} cannot be negative.`;
    else if (v > max) e[k] = `${label} is too large.`;
    else if (whole && !Number.isInteger(v)) e[k] = `${label} must be a whole number.`;
  }
  if (s('hs_code') && !/^[0-9][0-9 .\-]{3,18}$/.test(s('hs_code'))) e.hs_code = 'Use digits with dots or spaces, e.g. 9617.00 or 9617.00.10.';
  if (s('cost_currency') && !/^[A-Z]{3}$/.test(s('cost_currency'))) e.cost_currency = 'Choose a currency.';
  if (s('src_incoterm') && !same('src_incoterm', 'incoterm') && !/^[A-Za-z]{3}$/.test(s('src_incoterm'))) e.src_incoterm = 'Use a 3-letter price basis such as FOB or EXW.';
  if (s('src_lead') && !same('src_lead', 'lead') && !/^\d{1,3}(\s*[-–]\s*\d{1,3})?$/.test(s('src_lead'))) e.src_lead = 'Days as a number, e.g. 30 or 25-30.';
  if (s('src_valid') && !same('src_valid', 'valid') && !/^\d{4}-\d{2}-\d{2}$/.test(s('src_valid'))) e.src_valid = 'Use a date, e.g. 2026-12-31.';
  const keys = postedRows(b).map(([k]) => k);
  if (postedRows(b).some(([k, v]) => !k && v)) e.spec = 'Give every attribute a name.';
  else if (keys.some(k => k.length > 80)) e.spec = 'Attribute names must be under 80 characters.';
  else if (keys.some(k => k.includes(':'))) e.spec = 'Attribute names cannot contain a colon.';
  else if (new Set(keys.map(k => k.toLowerCase())).size !== keys.length) e.spec = 'Two attributes have the same name.';
  return e;
}
