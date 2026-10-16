// Cargo estimate for a quote: cartons, gross weight and volume from the products' packing data.
// Pure functions (the quote page repeats the same arithmetic in the browser while quantities change).
import { cartonCbm } from './product-metrics.js';

export const AIR_KG_PER_CBM = 167; // volumetric weight: 1 CBM = 167 kg (L×W×H cm ÷ 6000)

const num = v => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const r = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

/** One product line. `missing` lists what is not filled in on the product, so the estimate can be marked as incomplete. */
export function cargoLine(p, quantity) {
  const qty = Math.max(0, Math.floor(num(quantity) || 0));
  const perCtn = num(p.carton_qty), ctnKg = num(p.carton_weight_kg), unitKg = num(p.unit_weight_kg), ctnCbm = cartonCbm(p);
  const missing = [];
  const cartons = perCtn > 0 ? Math.ceil(qty / perCtn) : null;
  if (!(perCtn > 0)) missing.push('pcs per carton');
  let kg = null, kgNote = null;
  if (cartons != null && ctnKg > 0) kg = cartons * ctnKg;
  else if (unitKg > 0) { kg = qty * unitKg; kgNote = 'net weight, without packing'; if (cartons != null) missing.push('carton weight'); }
  else missing.push('weight');
  let cbm = null;
  if (cartons != null && ctnCbm > 0) cbm = cartons * ctnCbm;
  else missing.push('carton size');
  return { quantity: qty, cartons, kg: kg == null ? null : r(kg, 1), cbm: cbm == null ? null : r(cbm, 3), kgNote, missing };
}

/** Totals over lines (from cargoLine), plus air/sea figures. */
export function cargoTotals(lines, cfg = {}) {
  const cbmPerContainer = num(cfg.container_cbm) || 68;
  const sum = k => lines.reduce((t, l) => t + (l[k] || 0), 0);
  const kg = sum('kg'), cbm = sum('cbm'), cartons = sum('cartons');
  const volKg = cbm * AIR_KG_PER_CBM;
  return {
    cartons, kg: r(kg, 1), cbm: r(cbm, 3), volumetricKg: r(volKg, 1), airChargeableKg: r(Math.max(kg, volKg), 1),
    airBasis: volKg > kg ? 'volume' : 'weight', containerPct: r(cbm / cbmPerContainer * 100, 1),
    incomplete: lines.some(l => l.missing.length),
  };
}

/**
 * Spread one total freight amount over quote lines.
 * lines: [{ cbm, kg, value }] (cbm/kg from cargoLine, value = goods value for the fallback)
 * mode 'sea' → by volume, 'air' → by chargeable weight (greater of gross and volumetric kg).
 * locked: { [index]: amount } lines the user set by hand; the rest share what is left.
 * If any free line has no packing data for the chosen basis, everything is spread by goods value (estimated).
 */
export function allocateFreight(lines, total, mode = 'sea', locked = {}) {
  const T = Math.max(0, Number(total) || 0);
  const free = lines.map((_, i) => i).filter(i => locked[i] == null);
  const left = Math.max(0, T - Object.values(locked).reduce((t, v) => t + (Number(v) || 0), 0));
  const w = l => (mode === 'air' ? Math.max(l.kg || 0, (l.cbm || 0) * AIR_KG_PER_CBM) : l.cbm || 0);
  let basis = mode === 'air' ? 'chargeable weight' : 'volume', weights = free.map(i => w(lines[i]));
  if (weights.some(x => !(x > 0))) { basis = 'goods value'; weights = free.map(i => Math.max(0, lines[i].value || 0)); }
  if (!(weights.reduce((a, b) => a + b, 0) > 0)) weights = free.map(() => 1); // nothing to go by: equal split
  const sumW = weights.reduce((a, b) => a + b, 0);
  const out = lines.map((_, i) => (locked[i] != null ? Number(locked[i]) || 0 : 0));
  let given = 0;
  free.forEach((i, k) => {
    out[i] = k === free.length - 1 ? r(left - given, 2) : r(left * weights[k] / sumW, 2);
    given += out[i];
  });
  return { freight: out, basis, estimated: basis === 'goods value' };
}
