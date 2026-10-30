// Freight shown separately, or included in the unit prices the client sees (one switch per quotation, stored on each quote as freight_mode).
const r2 = x => Math.round(x * 100) / 100;
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
export const FREIGHT_MODES = ['separate', 'included', 'none'];   // none: the quotation carries no freight at all (staff keep the real figures)
export const modeOf = v => (v === 'included' ? 'included' : v === 'none' ? 'none' : 'separate');

/** What the client sees for one quote: freight shown separately, or spread into the unit price ("included"). Real figures stay on the quote for staff. */
export function shownOf(q) {
  const quantity = num(q.quantity), unit = num(q.unit_price), goods = r2(quantity * unit);
  const logistics = r2(num(q.freight_estimate) + num(q.duties_estimate) + num(q.other_costs)), total = r2(goods + logistics);
  if (q.freight_mode === 'none') { const other = r2(num(q.duties_estimate) + num(q.other_costs)); return { included: false, none: true, unit_price: unit, goods, logistics: other, total: r2(goods + other) }; }
  if (q.freight_mode === 'included') return { included: true, unit_price: quantity > 0 ? Math.round(total / quantity * 10000) / 10000 : unit, goods: total, logistics: 0, total };
  return { included: false, unit_price: unit, goods, logistics, total };
}


export const PI_FREIGHT_MODES = ['none', 'separate', 'included'];

/**
 * Lines of a proforma invoice as the client sees them. data.freight = { amount, mode }:
 *  - none / no amount: the lines as entered
 *  - separate: one extra "Freight & logistics" line
 *  - included: the freight is spread over the goods lines in proportion to their value (by quantity if they have no price yet),
 *    so each unit price carries its share and no freight line shows.
 */
export function piLines(d = {}) {
  const lines = (d.lines || []).map(l => ({ ...l }));
  const f = d.freight || {}, amount = r2(num(f.amount) * (1 + Math.max(0, num(f.buffer_pct)) / 100));
  if (!(amount > 0) || !lines.length || !PI_FREIGHT_MODES.includes(f.mode) || f.mode === 'none') return lines;
  if (f.mode === 'separate') return [...lines, { description: 'Freight & logistics', sku: '', quantity: 1, unit: '', unit_price: amount }];
  const value = l => num(l.quantity) * num(l.unit_price), weights = lines.map(value);
  let sum = weights.reduce((a, b) => a + b, 0), w = weights;
  if (!(sum > 0)) { w = lines.map(l => num(l.quantity)); sum = w.reduce((a, b) => a + b, 0); }
  if (!(sum > 0)) return lines;
  let left = amount;
  return lines.map((l, i) => {
    const last = i === lines.length - 1, share = last ? left : r2(amount * w[i] / sum);
    left = r2(left - share);
    const q = num(l.quantity);
    return q > 0 ? { ...l, unit_price: Math.round((num(l.unit_price) + share / q) * 10000) / 10000 } : l;
  });
}
