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

/** @param fxToUsd function(currency) → USD per 1 unit of that currency */
export function productMetrics(p, fxToUsd, cfg = CONTAINER_DEFAULTS) {
  const c = { ...CONTAINER_DEFAULTS, ...(cfg || {}) };
  const cost = num(p.unit_cost);
  const priceUsd = cost != null ? cost * fxToUsd(p.cost_currency || 'CNY') : null;
  const units = unitsPer40hq(p, c);
  const freightPerUnit = units ? c.freight_40hq_usd / units : null;
  const landed = priceUsd != null && freightPerUnit != null ? priceUsd + freightPerUnit : null;
  const wholesale = landed != null ? landed * (1 + c.wholesale_markup_pct / 100) : null;
  const r = (x, d) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
  // data gaps that make the estimates unreliable
  const issues = [];
  if (cost == null) issues.push('no price');
  if (!num(p.carton_qty)) issues.push('no pcs/carton');
  if (!cartonCbm(p)) issues.push('no carton size');
  if (!num(p.carton_weight_kg)) issues.push('no carton weight');
  if (!p.hs_code) issues.push('no HS code');
  if (!num(p.moq)) issues.push('no MOQ');
  return {
    priceUsd: r(priceUsd, 4), unitsPer40hq: units, freightPerUnit: r(freightPerUnit, 4),
    landedUsd: r(landed, 4), wholesaleUsd: r(wholesale, 2), markupPct: c.wholesale_markup_pct,
    moqValueUsd: priceUsd != null && num(p.moq) ? r(priceUsd * num(p.moq), 2) : null,
    issues,
  };
}

/** For a comparison table: which product is best on each numeric row (lowest or highest). */
export function bestOf(values, better = 'low') {
  const ok = values.map((v, i) => [v, i]).filter(([v]) => v != null && Number.isFinite(v));
  if (ok.length < 2) return new Set();
  const target = better === 'low' ? Math.min(...ok.map(([v]) => v)) : Math.max(...ok.map(([v]) => v));
  return new Set(ok.filter(([v]) => v === target).map(([, i]) => i));
}
