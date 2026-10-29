// Per-product estimates for the product list and comparisons (no database access — easy to test).
//   units per 40HQ  = full cartons that fit by volume AND by weight × pcs per carton
//   landed (USD)    = factory price in USD + 40HQ sea freight spread over a full container
//   suggested wholesale = landed × (1 + wholesale markup %)
export const CONTAINER_DEFAULTS = { freight_40hq_usd: 4500, container_cbm: 68, container_max_kg: 26500, wholesale_markup_pct: 45 };

const num = v => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export function cartonCbm(p) {
  const given = num(p.carton_cbm);
  if (given > 0) return given;
  const [l, w, h] = [p.carton_length_cm, p.carton_width_cm, p.carton_height_cm].map(num);
  return l > 0 && w > 0 && h > 0 ? (l * w * h) / 1e6 : null;
}

export function unitsPer40hq(p, cfg = CONTAINER_DEFAULTS) {
  const cbm = cartonCbm(p), qty = num(p.carton_qty), kg = num(p.carton_weight_kg);
  if (!(cbm > 0) || !(qty > 0)) return null;
  let cartons = Math.floor(cfg.container_cbm / cbm);
  if (kg > 0) cartons = Math.min(cartons, Math.floor(cfg.container_max_kg / kg));
  return cartons * qty;
}

/** USD per 1 unit of a currency from the settings' rates — or null when no rate exists (the shared fxRate() falls back to 1,
 *  which would silently price a EUR or GBP product as if it were dollars). */
export function fxToUsdStrict(settings) {
  const fx = settings?.fx || {};
  return c => {
    if (!c || c === 'USD') return 1;
    const direct = Number(fx[`${c}_USD`]), inverse = Number(fx[`USD_${c}`]);
    if (direct > 0) return direct;
    if (inverse > 0) return 1 / inverse;
    return null;
  };
}

/** Product kind from the free-form specification ("Type: Service"). No schema change: only "service" and "freight" are
 *  non-physical — they skip carton and container costing. Everything else (samples, packaging…) is a physical item. */
export function productKind(p) {
  const spec = p?.spec && typeof p.spec === 'object' ? p.spec : {};
  const key = Object.keys(spec).find(k => /^(product )?(type|kind)$/i.test(String(k).trim()));
  const v = key ? String(spec[key]).trim().toLowerCase() : '';
  const physical = !/^(service|services|freight|freight item|shipping)$/.test(v);
  return { label: v ? v.charAt(0).toUpperCase() + v.slice(1) : '', physical };
}

// What is missing, split by how much it matters. Critical = the estimates and a quotation cannot be trusted without it.
// Optional = enrichment: it improves accuracy or searching but nothing is wrong without it. `field` = the form field to open.
const GAPS = {
  price: { level: 'critical', label: 'no price', field: 'unit_cost', hint: 'Factory price per unit' },
  zero_price: { level: 'critical', label: 'price is 0', field: 'unit_cost', hint: 'Factory price is zero — check it' },
  supplier: { level: 'critical', label: 'no supplier', field: 'supplier_id', hint: 'Who makes or sells it' },
  fx: { level: 'critical', label: 'no exchange rate', field: 'cost_currency', hint: 'No exchange rate to USD for this currency (Pricing → settings)' },
  carton_qty: { level: 'critical', label: 'no pcs/carton', field: 'carton_qty', hint: 'Pieces per carton — needed for container capacity' },
  carton_size: { level: 'critical', label: 'no carton size', field: 'carton_length_cm', hint: 'Carton length, width and height' },
  carton_fit: { level: 'critical', label: 'carton too big for a 40HQ', field: 'carton_length_cm', hint: 'The carton is larger than the container — check the size' },
  carton_weight: { level: 'optional', label: 'no carton weight', field: 'carton_weight_kg', hint: 'Without it the container load is counted by volume only' },
  moq: { level: 'optional', label: 'no MOQ', field: 'moq', hint: 'Minimum order quantity' },
  hs: { level: 'optional', label: 'no HS code', field: 'hs_code', hint: 'Needed for customs and duties' },
  category: { level: 'optional', label: 'no category', field: 'category', hint: 'Helps filtering' },
  cbm_mismatch: { level: 'optional', label: 'carton CBM ≠ size', field: 'carton_cbm', hint: 'The CBM entered differs from length × width × height' },
};

/** @param fxToUsd function(currency) → USD per 1 unit of that currency (null/0 = unknown rate) */
export function productMetrics(p, fxToUsd, cfg = CONTAINER_DEFAULTS) {
  const c = { ...CONTAINER_DEFAULTS, ...(cfg || {}) };
  const kind = productKind(p), physical = kind.physical;
  const cost = num(p.unit_cost);
  const rate = cost != null && cost >= 0 ? num(fxToUsd(p.cost_currency || 'CNY')) : null;
  const fxOk = rate != null && rate > 0;
  const priceUsd = cost != null && cost >= 0 && fxOk ? cost * rate : null;
  const cbm = cartonCbm(p), qty = num(p.carton_qty);
  const fits = (!(cbm > 0) || cbm <= c.container_cbm) && !(num(p.carton_weight_kg) > c.container_max_kg);
  const units = physical && fits ? unitsPer40hq(p, c) : null;
  const freightPerUnit = units > 0 ? c.freight_40hq_usd / units : null;
  const landed = priceUsd != null && freightPerUnit != null ? priceUsd + freightPerUnit : null;
  const wholesale = landed != null ? landed * (1 + c.wholesale_markup_pct / 100) : null;
  // the container load is by volume only when the carton weight is unknown, so the figure can be too optimistic: an estimate, flagged as such
  const landedBasis = landed == null ? null : num(p.carton_weight_kg) > 0 ? 'full' : 'volume';
  const r = (x, d) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
  const g = [];
  const add = k => g.push({ key: k, ...GAPS[k] });
  if (cost == null) add('price'); else if (cost === 0) add('zero_price');
  if (!p.supplier_id && p.suppliers == null) add('supplier');
  if (cost != null && cost > 0 && !fxOk) add('fx');
  if (physical) {
    if (!(qty > 0)) add('carton_qty');
    if (!cbm) add('carton_size'); else if (!fits) add('carton_fit');
    const [l, w, h] = [p.carton_length_cm, p.carton_width_cm, p.carton_height_cm].map(num);
    const given = num(p.carton_cbm);
    if (given > 0 && l > 0 && w > 0 && h > 0 && Math.abs(given - (l * w * h) / 1e6) / given > 0.05) add('cbm_mismatch');
    if (!(num(p.carton_weight_kg) > 0)) add('carton_weight');
  }
  if (!p.hs_code) add('hs');
  if (!(num(p.moq) > 0)) add('moq');
  if (!p.category) add('category');
  const critical = g.filter(x => x.level === 'critical'), optional = g.filter(x => x.level === 'optional');
  return {
    priceUsd: r(priceUsd, 4), unitsPer40hq: units, freightPerUnit: r(freightPerUnit, 4),
    landedUsd: r(landed, 4), landedBasis, wholesaleUsd: r(wholesale, 2), markupPct: c.wholesale_markup_pct,
    // wholesale = landed × (1 + markup): a MARKUP on cost. The gross margin it gives on the selling price is lower.
    impliedMarginPct: r(c.wholesale_markup_pct / (100 + c.wholesale_markup_pct) * 100, 1),
    fxRate: fxOk ? rate : null, fxOk, kind: kind.label, physical,
    moqValueUsd: priceUsd != null && num(p.moq) ? r(priceUsd * num(p.moq), 2) : null,
    gaps: g, critical, optional, issues: g.map(x => x.label),
  };
}

/** For a comparison table: which product is best on each numeric row (lowest or highest). */
export function bestOf(values, better = 'low') {
  const ok = values.map((v, i) => [v, i]).filter(([v]) => v != null && Number.isFinite(v));
  if (ok.length < 2) return new Set();
  const target = better === 'low' ? Math.min(...ok.map(([v]) => v)) : Math.max(...ok.map(([v]) => v));
  return new Set(ok.filter(([v]) => v === target).map(([, i]) => i));
}
