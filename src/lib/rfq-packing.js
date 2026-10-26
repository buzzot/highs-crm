// Draft packing list from a supplier's RFQ answer, before there is an order: packages = quantity wanted ÷ quantity per package (rounded up),
// size and weight per package as the supplier gave them. An estimate for freight calculations — the real list comes from the supplier later.
import { normalizeRows, totals, packingSheet } from './packing.js';
import { writeWorkbook } from './xlsx-write.js';

export function draftPacking({ rfq, resp }) {
  const lines = [], warnings = [], rows = [];
  for (const it of rfq.items || []) {
    const l = ((resp && resp.lines) || []).find(x => x.item_id === it.id);
    const row = { item: it, line: l || null, packages: null, problem: '' };
    lines.push(row);
    if (!l) { row.problem = 'No answer for this product'; continue; }
    const per = Number(l.carton_qty) || 0, qty = Number(it.quantity) || 0, unit = l.price_unit || it.unit || 'pcs';
    if (!qty) { row.problem = 'No quantity on the RFQ'; continue; }
    if (!per) { row.problem = 'The supplier did not say how many units go in one package'; continue; }
    if (unit !== (it.unit || 'pcs')) { row.problem = `Quantity is in ${it.unit || 'pcs'} but the supplier counts in ${unit} — convert by hand`; continue; }
    row.packages = Math.ceil(qty / per);
    row.exact = qty / per;
    rows.push({ cartons: row.packages, description: it.description + (l.package_type ? ` (${l.package_type})` : ''), sku: it.sku, quantity: per,
      length_cm: l.carton_l, width_cm: l.carton_w, height_cm: l.carton_h, gross_weight_kg: l.gross_kg });
  }
  const norm = normalizeRows(rows);
  const t = totals(norm);
  if (norm.length && t.missing.length) warnings.push(`Some products have no ${t.missing.join(' / ')} — totals are incomplete.`);
  return { lines, rows: norm, t, warnings };
}

/** Where the goods are: city (and country) of the supplier. Forwarders get this, never the supplier's name. */
export const factoryPlace = sup => [sup?.city, sup?.country].map(x => String(x || '').trim()).filter(Boolean).join(', ');

export function draftPackingText({ origin, d }) {
  const n = v => (v == null ? '' : Number(v).toLocaleString('en-US'));
  return ['Draft packing list (estimate)', origin ? `Goods location: ${origin}` : null, `Total: ${d.t.cartons} packages · GW ${d.t.gross} kg · ${d.t.cbm} cbm`, '',
    ...d.rows.map(x => `${x.cartons} × ${x.description}: ${n(x.quantity)} per package · ${x.length_cm ? `${x.length_cm}×${x.width_cm}×${x.height_cm} cm` : 'size ?'} · GW ${n(x.gross_weight_kg)} kg each`)].filter(l => l !== null).join('\n');
}

export function draftPackingWorkbook({ rfq, d }) {
  const pl = packingSheet({ order: { order_no: 'Draft estimate' }, rows: d.rows, t: d.t });
  const hdr = pl.findIndex(x => x[0] === 'CTN No.'), tot = pl.findIndex(x => x[0] === 'TOTAL');
  return writeWorkbook([{ name: 'Draft packing list', landscape: true, widths: [10, 8, 34, 14, 12, 9, 10, 8, 8, 8, 9, 10, 11, 12, 11, 12], freeze: hdr + 1,
    rows: pl.map((row, ri) => (row || []).map(v => (ri === hdr ? { v, s: 'header' } : (ri === 0 || ri === tot) && v !== '' && v != null ? { v, s: 'bold' } : v))) }]);
}
