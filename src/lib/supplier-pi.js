// Supplier proforma invoice (PI): totals, the "does it match" checks, and payment shares.
const r2 = v => Math.round(Number(v || 0) * 100) / 100;
const num = v => { const x = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(x) ? x : 0; };
export const TOL = 0.01;

export const lineTotal = l => r2(num(l.quantity) * num(l.unit_price));
export const piTotal = lines => r2((lines || []).reduce((t, l) => t + lineTotal(l), 0));

/** The lines against the total printed on the supplier's PI, and the PI against our PO. */
export function checkPi({ lines, declared, poTotal }) {
  const total = piTotal(lines);
  const hasDeclared = declared != null && declared !== '' && Number.isFinite(Number(declared));
  const diff = hasDeclared ? r2(Number(declared) - total) : null;
  const vsPo = poTotal != null ? r2(total - Number(poTotal)) : null;
  return {
    total, declared: hasDeclared ? r2(declared) : null, diff,
    matches: hasDeclared && Math.abs(diff) <= TOL,       // lines add up to the printed total
    vsPo, samePo: vsPo == null ? null : Math.abs(vsPo) <= TOL,
  };
}

/** Payments against the PI total: each payment's share and what is still open. */
export function paymentPlan(total, payments) {
  const T = r2(total);
  let paid = 0;
  const rows = (payments || []).map(p => { paid = r2(paid + Number(p.amount || 0)); return { ...p, pct: T > 0 ? Math.round(Number(p.amount) / T * 1000) / 10 : null }; });
  const open = r2(T - paid);
  return { rows, total: T, paid, open, pctPaid: T > 0 ? Math.round(paid / T * 1000) / 10 : 0, status: T <= 0 || paid <= 0 ? 'unpaid' : open > TOL ? 'partial' : open < -TOL ? 'over' : 'paid' };
}

/** Match AI-read lines to products by SKU, then by name. */
export function matchProducts(lines, products) {
  const bySku = new Map(products.filter(p => p.sku).map(p => [String(p.sku).trim().toLowerCase(), p]));
  return lines.map(l => {
    const sku = String(l.sku || '').trim().toLowerCase();
    const name = String(l.description || '').trim().toLowerCase();
    const p = (sku && bySku.get(sku)) || (name && products.find(x => x.name && x.name.trim().toLowerCase() === name));
    return p ? { ...l, product_id: p.id } : l;
  });
}
