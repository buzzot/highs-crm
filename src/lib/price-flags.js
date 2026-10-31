// Price checks for one invoice / order line. Pure (no imports): the server tests it and the browser loads the same file (/js/price-flags.js).
// info = what the server knows about the product for this client, already converted into the document's currency:
//   { cur, cost: supplier price now | null, hist: [{ price, qty, date, order_no, cur_orig, price_orig, cost_then }] }   (hist: newest first)
export const TOLERANCE = 0.01;   // differences of 1% or less are ignored

export const pct = (a, b) => (Number(b) ? ((Number(a) - Number(b)) / Number(b)) * 100 : 0);
const sg = n => (n > 0 ? '+' : '') + n.toFixed(1) + '%';
export const money = (n, d = 2) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
export const trim4 = n => String(Math.round(Number(n) * 10000) / 10000);

/**
 * Flags for a price. Each flag: { code, kind: 'bad' | 'warn' | 'info', text, use? }
 *  - below_cost: price is under the supplier price (bad)
 *  - low_margin: margin under the minimum (warn)
 *  - last_diff: differs from the last price to this client (warn; info when that order was in another currency)
 *  - cost_changed: the supplier price is not the one the last order was made with (warn)
 *  - no_price: nothing entered yet (info)
 */
export function priceFlags({ price, info, tol = TOLERANCE, minMargin = 20 }) {
  const p = Number(price) || 0, out = [];
  if (!info) return out;
  const last = (info.hist || [])[0] || null, cost = info.cost != null ? Number(info.cost) : null, cur = info.cur || '';
  if (!(p > 0)) { out.push({ code: 'no_price', kind: 'info', text: last || cost != null ? 'No price yet — hover the clock to see earlier prices.' : 'No earlier price and no supplier price — enter the price.' }); return out; }
  if (cost != null && cost > 0) {
    if (p < cost) out.push({ code: 'below_cost', kind: 'bad', text: `Below the supplier price (${money(cost)} ${cur}) — a loss of ${money(cost - p)} per unit.` });
    else { const m = ((p - cost) / p) * 100; if (m < minMargin) out.push({ code: 'low_margin', kind: 'warn', text: `Margin ${m.toFixed(0)}% is below the minimum ${minMargin}%.` }); }
  }
  if (last && Number(last.price) > 0) {
    const d = pct(p, last.price);
    if (Math.abs(d) > tol * 100) {
      const other = last.cur_orig && last.cur_orig !== cur;
      out.push({ code: 'last_diff', kind: other ? 'info' : 'warn', use: Number(last.price),
        text: other ? `Last order ${last.order_no} was in ${last.cur_orig} (${money(last.price_orig)} ≈ ${money(last.price)} ${cur}): ${sg(d)} vs that price.`
          : `Differs from the last order ${last.order_no} (${last.qty} @ ${money(last.price)}): ${sg(d)}.` });
    }
    if (last.cost_then != null && cost != null && Number(last.cost_then) > 0 && Math.abs(pct(cost, last.cost_then)) > tol * 100) {
      const mNow = p > 0 ? ((p - cost) / p) * 100 : 0;
      out.push({ code: 'cost_changed', kind: 'warn', text: `Supplier price changed since the last order: ${money(last.cost_then)} → ${money(cost)} ${cur} (${sg(pct(cost, last.cost_then))}). Margin at this price: ${mNow.toFixed(0)}%.` });
    }
  }
  return out;
}

/** Margin in % at a price (staff only), or null when the supplier price is unknown. */
export const marginAt = (price, cost) => (Number(price) > 0 && cost != null && Number(cost) > 0 ? ((Number(price) - Number(cost)) / Number(price)) * 100 : null);
