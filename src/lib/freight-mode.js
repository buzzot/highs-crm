// Freight shown separately, or included in the unit prices the client sees (one switch per quotation, stored on each quote as freight_mode).
const r2 = x => Math.round(x * 100) / 100;
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
export const FREIGHT_MODES = ['separate', 'included'];
export const modeOf = v => (v === 'included' ? 'included' : 'separate');

/** What the client sees for one quote: freight shown separately, or spread into the unit price ("included"). Real figures stay on the quote for staff. */
export function shownOf(q) {
  const quantity = num(q.quantity), unit = num(q.unit_price), goods = r2(quantity * unit);
  const logistics = r2(num(q.freight_estimate) + num(q.duties_estimate) + num(q.other_costs)), total = r2(goods + logistics);
  if (q.freight_mode === 'included') return { included: true, unit_price: quantity > 0 ? Math.round(total / quantity * 10000) / 10000 : unit, goods: total, logistics: 0, total };
  return { included: false, unit_price: unit, goods, logistics, total };
}

