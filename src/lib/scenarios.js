// Side-by-side pricing scenarios: the same quantity bought / shipped in different ways (supplier, freight mode, duty), with the numbers that decide between them.
import { calcQuote, MIN_MARGIN_PCT } from './pricing.js';

const n = (v, d = 0) => { const x = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(x) && String(v ?? '').trim() !== '' ? x : d; };
const r = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * Duty is charged on the customs value = what the importer pays for the goods (our sell price, ex-logistics),
 * plus freight when the destination counts CIF. VAT is charged on customs value + duty, only if the scenario says we carry it.
 */
export function dutyOf({ goodsTotal, freightTotal, dutyPct, vatPct, base }) {
  const customsValue = goodsTotal + (base === 'cif' ? freightTotal : 0);
  const duty = customsValue * n(dutyPct) / 100;
  const vat = (customsValue + duty) * n(vatPct) / 100;
  return { customsValue: r(customsValue), duty: r(duty), vat: r(vat), total: r(duty + vat) };
}

/** @param {{ quantity: number, minMarginPct?: number, fxOf: (cur: string) => number, scenarios: object[] }} p  scenarios: { label, unitCost, costCurrency, marginPct, freightTotal, otherTotal, dutyPct, vatPct, dutyBase, leadDays } */
export function compareScenarios({ quantity, minMarginPct = MIN_MARGIN_PCT, fxOf, scenarios }) {
  const qty = Math.max(1, Math.floor(n(quantity, 1)));
  const rows = scenarios.filter(s => n(s.unitCost) > 0).map((s, i) => {
    const fx = fxOf(s.costCurrency || 'CNY');
    const freight = n(s.freightTotal), other = n(s.otherTotal);
    const marginPct = n(s.marginPct, minMarginPct);
    const goodsTotal = n(s.unitCost) * fx * (1 + marginPct / 100) * qty;
    const d = dutyOf({ goodsTotal, freightTotal: freight, dutyPct: s.dutyPct, vatPct: s.vatPct, base: s.dutyBase });
    const c = calcQuote({ unitCost: s.unitCost, fxRate: fx, marginPct, quantity: qty, freightTotal: freight, dutiesTotal: d.total, otherTotal: other, minMarginPct });
    return { key: s.key ?? i, label: s.label || `Option ${i + 1}`, leadDays: s.leadDays ? n(s.leadDays) : null, fx, freight, other, ...d, ...c,
      profitOnLanded: c.landedTotal > 0 ? r(c.grossProfit / c.landedTotal * 100, 1) : 0 };
  });
  const best = (key, dir) => rows.length > 1 && new Set(rows.map(x => x[key])).size > 1 ? rows.reduce((a, b) => ((dir > 0 ? b[key] > a[key] : b[key] < a[key]) ? b : a)).key : null;
  const lowest = best('landedUnitPrice', -1), profit = best('grossProfit', 1);
  const fastest = rows.filter(x => x.leadDays != null).length > 1 ? rows.filter(x => x.leadDays != null).reduce((a, b) => (b.leadDays < a.leadDays ? b : a)).key : null;
  const base = rows.find(x => x.key === lowest) || rows[0];
  rows.forEach(x => { x.cheapestForClient = x.key === lowest; x.mostProfit = x.key === profit; x.fastest = x.key === fastest; x.vsCheapest = base ? r(x.landedUnitPrice - base.landedUnitPrice, 4) : 0; });
  return { quantity: qty, rows };
}
