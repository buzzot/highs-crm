// Extra product details on a request line. Keys match supplier-product.js (wizard fields) so answers convert to products.
export const SPEC_FIELDS = [
  ['category', 'Category'], ['materials', 'Materials'], ['size', 'Size (cm)'], ['certifications', 'Certifications'], ['packaging_type', 'Packaging'],
  ['incoterm', 'Incoterm'], ['payment_terms', 'Payment terms'], ['etd', 'Needed by (ETD)'], ['valid_until', 'Quote valid until'],
];
const KEYS = SPEC_FIELDS.map(([k]) => k);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INCOTERMS = ['EXW', 'FCA', 'FOB', 'CIF', 'CFR', 'CPT', 'DAP', 'DDP'];

/** Whitelist + trim. Unknown keys are dropped; bad dates / incoterms are ignored. */
export function cleanSpec(raw) {
  let o = raw;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { o = null; } }
  const out = {};
  if (!o || typeof o !== 'object') return out;
  for (const k of KEYS) {
    let v = String(o[k] ?? '').trim();
    if (!v) continue;
    if (k === 'etd' || k === 'valid_until') { if (!DATE.test(v)) continue; }
    else if (k === 'incoterm') { v = v.toUpperCase(); if (!INCOTERMS.includes(v)) continue; }
    else v = v.slice(0, k === 'payment_terms' || k === 'certifications' || k === 'materials' ? 300 : 120);
    out[k] = v;
  }
  return out;
}

/** [[label, value]] of what is filled in, in display order. */
export const specFacts = spec => SPEC_FIELDS.map(([k, label]) => [label, spec?.[k]]).filter(([, v]) => v);
