// Draft packing list from a supplier's RFQ answer, before there is an order: packages = quantity wanted ÷ quantity per package (rounded up),
// size and weight per package as the supplier gave them. An estimate for freight calculations — the real list comes from the supplier later.
import { normalizeRows, totals } from './packing.js';
import { writeWorkbook } from './xlsx-write.js';
import { quoteFormSheet } from './quote-form.js';

const n0 = v => (v == null || v === '' ? '' : Number(v).toLocaleString('en-US'));
/** "190 Roll + 16 Drum / reel" and "95,000 m + 4,000 kg" — packages and quantities counted per type / unit, never mixed. */
export function pkgSummary(rows) {
  const by = {};
  for (const x of rows) by[x.package_type || 'package'] = (by[x.package_type || 'package'] || 0) + Number(x.cartons || 1);
  return Object.entries(by).map(([k, v]) => `${n0(v)} ${k}`).join(' + ');
}
export function qtySummary(rows) {
  const by = {};
  for (const x of rows) by[x.unit || 'pcs'] = (by[x.unit || 'pcs'] || 0) + (Number(x.quantity) || 0) * Number(x.cartons || 1);
  return Object.entries(by).map(([k, v]) => `${n0(v)} ${k}`).join(' + ');
}

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
    rows.push({ cartons: row.packages, description: it.description, package_type: l.package_type || '', unit, sku: it.sku, quantity: per,
      length_cm: l.carton_l, width_cm: l.carton_w, height_cm: l.carton_h, gross_weight_kg: l.gross_kg });
  }
  const norm = normalizeRows(rows).map((x, i) => ({ ...x, package_type: rows[i]?.package_type || '', unit: rows[i]?.unit || 'pcs' }));   // rows keep their order
  const t = totals(norm);
  t.pkgSummary = pkgSummary(norm); t.qtySummary = qtySummary(norm);
  if (norm.length && t.missing.length) warnings.push(`Some products have no ${t.missing.join(' / ')} — totals are incomplete.`);
  return { lines, rows: norm, t, warnings };
}

/** Where the goods are: city (and country) of the supplier. Forwarders get this, never the supplier's name. */
export const factoryPlace = sup => [sup?.city, sup?.country].map(x => String(x || '').trim()).filter(Boolean).join(', ');

export function draftPackingText({ origin, d }) {
  const n = v => (v == null ? '' : Number(v).toLocaleString('en-US'));
  return ['Draft packing list (estimate)', origin ? `Goods location: ${origin}` : null, `Total: ${d.t.pkgSummary} · ${d.t.qtySummary} · GW ${d.t.gross} kg · ${d.t.cbm} cbm`, '',
    ...d.rows.map(x => `${x.cartons} × ${x.package_type || 'package'} — ${x.description}: ${n(x.quantity)} ${x.unit} per ${(x.package_type || 'package').toLowerCase()} · ${x.length_cm ? `${x.length_cm}×${x.width_cm}×${x.height_cm} cm` : 'size ?'} · GW ${n(x.gross_weight_kg)} kg each`)].filter(l => l !== null).join('\n');
}

const r2 = (v, d) => (v == null ? '' : Math.round(v * 10 ** d) / 10 ** d);
/** Packing sheet by package type and unit (Roll / 500 m, not carton / pcs). */
export function draftSheet({ rows, t, title = 'PACKING LIST (draft estimate)' }) {
  const head = ['Pkg No.', 'Packages', 'Package', 'Description', 'Item / SKU', 'Qty/pkg', 'Unit', 'Total qty', 'L (cm)', 'W (cm)', 'H (cm)', 'CBM/pkg', 'Total CBM', 'GW/pkg (kg)', 'Total GW (kg)'];
  const body = rows.map(x => { const c = Number(x.cartons || 1), cbm = x.length_cm && x.width_cm && x.height_cm ? x.length_cm * x.width_cm * x.height_cm / 1e6 : null;
    return [x.carton_no, c, x.package_type || '', x.description || '', x.sku || '', x.quantity ?? '', x.unit || '', x.quantity != null ? x.quantity * c : '', x.length_cm ?? '', x.width_cm ?? '', x.height_cm ?? '',
      cbm != null ? r2(cbm, 4) : '', cbm != null ? r2(cbm * c, 3) : '', x.gross_weight_kg ?? '', x.gross_weight_kg != null ? r2(x.gross_weight_kg * c, 2) : '']; });
  const total = ['TOTAL', t.cartons, t.pkgSummary, '', '', '', '', t.qtySummary, '', '', '', '', t.cbm, '', t.gross];
  const out = [[`Lumi Trade — ${title}`], [`Date: ${new Date().toISOString().slice(0, 10)}`], [], head, ...body, total];
  const H = 3, T = out.length - 1;
  return { name: 'Packing list 装箱单', landscape: true, widths: [10, 9, 14, 34, 14, 9, 7, 12, 8, 8, 8, 9, 10, 11, 12], freeze: H + 1,
    rows: out.map((row, ri) => (row || []).map(v => (ri === H ? { v, s: 'header' } : (ri === 0 || ri === T) && v !== '' && v != null ? { v, s: 'bold' } : v))) };
}

export function draftPackingWorkbook({ d }) {
  return writeWorkbook([draftSheet({ rows: d.rows, t: d.t })]);
}

/** What a forwarder gets: quotation form first, draft packing list second. */
export function draftRfqWorkbook({ order, info = {}, rows, t, ref = '—', token = '—' }) {
  return writeWorkbook([quoteFormSheet({ order: { ...order, order_no: '' }, info, t: { ...t, pkgWord: 'packages' }, ref, token }), draftSheet({ rows, t })]);
}
