/**
 * Pricing rules (from the Sourcing brief):
 *  - Margin is calculated on PRODUCT COST only; logistics is excluded from the margin base.
 *  - Minimum margin 20%.
 *  - Landed price = sell price + (freight + duties + other) / quantity.
 */

export const MIN_MARGIN_PCT = 20;

const n = (v, d = 0) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
};

/**
 * @param {object} p
 * @param {number} p.unitCost         supplier cost per unit, in cost currency
 * @param {number} p.fxRate           cost currency -> sell currency (e.g. CNY->USD 0.138)
 * @param {number} p.marginPct        margin on product cost, percent
 * @param {number} p.quantity
 * @param {number} [p.freightTotal]   total freight, sell currency
 * @param {number} [p.dutiesTotal]    total duties/taxes, sell currency
 * @param {number} [p.otherTotal]     other logistics/handling, sell currency
 * @param {number} [p.minMarginPct]
 */
export function calcQuote(p) {
  const unitCost = n(p.unitCost);
  const fx = n(p.fxRate, 1);
  const qty = Math.max(1, Math.floor(n(p.quantity, 1)));
  const minMargin = n(p.minMarginPct, MIN_MARGIN_PCT);
  const marginPct = n(p.marginPct, minMargin);
  const freight = n(p.freightTotal);
  const duties = n(p.dutiesTotal);
  const other = n(p.otherTotal);

  const unitCostSell = unitCost * fx;                        // product cost in sell currency
  const unitPrice = unitCostSell * (1 + marginPct / 100);    // ex-logistics sell price
  const logisticsPerUnit = (freight + duties + other) / qty;
  const landedUnitPrice = unitPrice + logisticsPerUnit;

  const goodsTotal = unitPrice * qty;
  const costTotal = unitCostSell * qty;
  const grossProfit = goodsTotal - costTotal;                // logistics is pass-through
  const landedTotal = landedUnitPrice * qty;

  const warnings = [];
  if (marginPct < minMargin) warnings.push(`Margin ${marginPct}% is below the ${minMargin}% minimum.`);
  if (unitCost <= 0) warnings.push('Unit cost is zero or missing.');
  if (fx <= 0) warnings.push('FX rate is invalid.');
  if (logisticsPerUnit > unitPrice) warnings.push('Logistics per unit exceeds the product price — check freight inputs or quantity.');

  const r = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
  return {
    quantity: qty,
    marginPct,
    unitCostSell: r(unitCostSell),
    unitPrice: r(unitPrice),
    logisticsPerUnit: r(logisticsPerUnit),
    landedUnitPrice: r(landedUnitPrice),
    goodsTotal: r(goodsTotal, 2),
    costTotal: r(costTotal, 2),
    grossProfit: r(grossProfit, 2),
    logisticsTotal: r(freight + duties + other, 2),
    landedTotal: r(landedTotal, 2),
    effectiveMarginPct: unitCostSell > 0 ? r((unitPrice - unitCostSell) / unitCostSell * 100, 2) : 0,
    meetsMinimum: marginPct >= minMargin,
    warnings,
  };
}

/** Reverse: given a target sell price, what margin does it imply? */
export function marginFromPrice({ unitCost, fxRate, targetUnitPrice }) {
  const base = n(unitCost) * n(fxRate, 1);
  if (base <= 0) return null;
  return Math.round(((n(targetUnitPrice) - base) / base) * 10000) / 100;
}
