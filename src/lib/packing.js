// Packing list helpers (no database): normalise rows, read spreadsheets by their headers, totals, plain-text version.
//
// One row = one line of the packing list: `cartons` identical cartons (numbered e.g. "1-20"),
// `quantity` pieces in EACH carton, dimensions and weights PER CARTON.

const num = v => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/,/g, '').replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const s = v => (v === null || v === undefined ? '' : String(v).trim());
const r = (x, d) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

/** "1-20" → 20, "5" → 1, "1~3, 7" → 4 */
export function cartonCount(no) {
  const t = s(no);
  if (!t) return null;
  let n = 0;
  for (const part of t.split(/[,;，]/)) {
    const m = part.match(/(\d+)\s*(?:-|~|–|—|to|至)\s*(\d+)/i);
    if (m) n += Math.abs(Number(m[2]) - Number(m[1])) + 1;
    else if (/\d/.test(part)) n += 1;
  }
  return n || null;
}

/** "52x38x23", "52*38*23cm", "52 × 38 × 23" → [52, 38, 23] */
export function parseDims(v) {
  const m = s(v).replace(/[×*X]/g, 'x').match(/([\d.]+)\s*x\s*([\d.]+)\s*x\s*([\d.]+)/i);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Clean one row; fills carton count from the range and numbers the next free cartons when missing. */
export function normalizeRow(raw, next = 1) {
  let cartons = num(raw.cartons);
  const range = s(raw.carton_no);
  if (!cartons) cartons = cartonCount(range) || 1;
  cartons = Math.max(1, Math.round(cartons));
  let L = num(raw.length_cm), W = num(raw.width_cm), H = num(raw.height_cm);
  if ((L == null || W == null || H == null) && raw.dims) { const d = parseDims(raw.dims); if (d) [L, W, H] = d; }
  const row = {
    carton_no: range || (cartons > 1 ? `${next}-${next + cartons - 1}` : String(next)),
    cartons,
    description: s(raw.description) || null,
    sku: s(raw.sku) || null,
    hs_code: s(raw.hs_code) || null,
    quantity: num(raw.quantity) != null ? Math.round(num(raw.quantity)) : null,
    length_cm: L, width_cm: W, height_cm: H,
    gross_weight_kg: num(raw.gross_weight_kg),
    net_weight_kg: num(raw.net_weight_kg),
  };
  // totals given instead of per-carton values → divide
  if (row.quantity == null && num(raw.total_quantity) && cartons) row.quantity = Math.round(num(raw.total_quantity) / cartons);
  if (row.gross_weight_kg == null && num(raw.total_gross_weight_kg)) row.gross_weight_kg = r(num(raw.total_gross_weight_kg) / cartons, 3);
  if (row.net_weight_kg == null && num(raw.total_net_weight_kg)) row.net_weight_kg = r(num(raw.total_net_weight_kg) / cartons, 3);
  return row;
}

export function normalizeRows(list) {
  let next = 1;
  return (list || []).filter(x => x && (s(x.description) || num(x.quantity) || num(x.cartons) || s(x.carton_no) || num(x.gross_weight_kg)))
    .map(x => { const row = normalizeRow(x, next); next += row.cartons; return row; });
}

export const cartonCbm = row => (row.length_cm && row.width_cm && row.height_cm ? (row.length_cm * row.width_cm * row.height_cm) / 1e6 : null);

export function totals(rows) {
  const t = { lines: rows.length, cartons: 0, pieces: 0, gross: 0, net: 0, cbm: 0, missing: [] };
  for (const x of rows) {
    const c = Number(x.cartons || 1);
    t.cartons += c;
    t.pieces += (Number(x.quantity) || 0) * c;
    t.gross += (Number(x.gross_weight_kg) || 0) * c;
    t.net += (Number(x.net_weight_kg) || 0) * c;
    t.cbm += (cartonCbm(x) || Number(x.cbm) || 0) * c;
  }
  t.gross = r(t.gross, 2); t.net = r(t.net, 2); t.cbm = r(t.cbm, 3);
  if (rows.some(x => !x.length_cm || !x.width_cm || !x.height_cm)) t.missing.push('carton size');
  if (rows.some(x => !x.gross_weight_kg)) t.missing.push('gross weight');
  if (rows.some(x => !x.quantity)) t.missing.push('pcs per carton');
  // chargeable weight hints for forwarders
  t.volumetricAir = r(t.cbm * 167, 1);      // kg, IATA 1:6000
  t.chargeableAir = r(Math.max(t.gross, t.volumetricAir), 1);
  t.wm = r(Math.max(t.cbm, t.gross / 1000), 3); // sea LCL W/M (revenue tons)
  return t;
}

// ---------- reading spreadsheets by header names (fast path before AI) ----------
const HEADERS = [
  ['carton_no', /^(c\/?no|ctn\.?\s*no|carton\s*(no|number|#)|箱号|件号)/i],
  ['cartons', /^(ctns?|cartons?|no\.?\s*of\s*(ctns|cartons)|箱数|件数|total\s*ctns?)$/i],
  ['description', /(description|descr|goods|product|item\s*name|commodity|品名|货物|产品)/i],
  ['sku', /(sku|item\s*no|model|art(icle)?\.?\s*no|货号|型号)/i],
  ['hs_code', /(hs\s*code|h\.s|海关编码)/i],
  ['quantity', /^(qty|pcs|quantity)\s*(\/|per)\s*(ctn|carton)|^(pcs\/ctn|每箱|装箱数)/i],
  ['total_quantity', /^(total\s*(qty|pcs|quantity)|qty|quantity|pcs|数量|总数)$/i],
  ['dims', /(meas|dimension|size|carton\s*size|外箱尺寸|尺寸|规格)/i],
  ['length_cm', /^(l|length|长)(\s*\(?cm\)?)?$/i],
  ['width_cm', /^(w|width|宽)(\s*\(?cm\)?)?$/i],
  ['height_cm', /^(h|height|高)(\s*\(?cm\)?)?$/i],
  ['gross_weight_kg', /^(g\.?\s*w\.?|gross\s*weight|毛重)(\s*\/?\s*(ctn|carton))?(\s*\(?kgs?\)?)?$/i],
  ['net_weight_kg', /^(n\.?\s*w\.?|net\s*weight|净重)(\s*\/?\s*(ctn|carton))?(\s*\(?kgs?\)?)?$/i],
  ['total_gross_weight_kg', /^total\s*(g\.?\s*w|gross)/i],
  ['total_net_weight_kg', /^total\s*(n\.?\s*w|net)/i],
];

/** Find a header row and map columns. Returns rows or null when the layout isn't recognised. */
export function rowsFromSheet(rows) {
  for (let h = 0; h < Math.min(rows.length, 25); h++) {
    const head = rows[h];
    if (!head) continue;
    const map = {};
    head.forEach((cell, c) => {
      const t = s(cell).replace(/\s+/g, ' ');
      if (!t) return;
      for (const [field, re] of HEADERS) if (!(field in map) && re.test(t)) { map[field] = c; break; }
    });
    const enough = ('description' in map || 'sku' in map) && ('cartons' in map || 'carton_no' in map) && ('gross_weight_kg' in map || 'total_gross_weight_kg' in map || 'dims' in map || 'length_cm' in map);
    if (!enough) continue;
    const out = [];
    for (let i = h + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || !row.some(v => s(v))) continue;
      const first = s(row[map.description ?? map.sku]);
      if (/^(total|合计|总计)/i.test(first) || /^(total|合计|总计)/i.test(s(row[0]))) break;
      const raw = Object.fromEntries(Object.entries(map).map(([f, c]) => [f, row[c]]));
      out.push(raw);
    }
    const norm = normalizeRows(out);
    return norm.length ? norm : null;
  }
  return null;
}

// ---------- outputs ----------
const n0 = v => (v == null || v === '' ? '' : Number(v).toLocaleString('en-US'));
const dims = x => (x.length_cm ? `${Number(x.length_cm)}×${Number(x.width_cm)}×${Number(x.height_cm)}` : '');

/** Plain text for WeChat / copy-paste. */
export function packingText({ order, info = {}, rows, t }) {
  const lines = [
    `Freight quote request — ${order.order_no}`,
    info.mode ? `Mode: ${info.mode}` : null,
    [info.pol && `From: ${info.pol}`, info.pod && `To: ${info.pod}`].filter(Boolean).join(' → ') || null,
    info.incoterm ? `Incoterm: ${info.incoterm}` : null,
    info.ready_date ? `Cargo ready: ${info.ready_date}` : null,
    `Total: ${t.cartons} ctns · ${n0(t.pieces)} pcs · GW ${t.gross} kg · ${t.cbm} cbm`,
    '',
    ...rows.map(x => `CTN ${x.carton_no} (${x.cartons}): ${x.description || ''}${x.sku ? ' [' + x.sku + ']' : ''} · ${n0(x.quantity)} pcs/ctn · ${dims(x)} cm · GW ${n0(x.gross_weight_kg)} kg/ctn`),
    info.remarks ? `\nNotes: ${info.remarks}` : null,
  ];
  return lines.filter(l => l !== null).join('\n');
}

/** Rows for the Excel file (header + lines + total). */
export function packingSheet({ order, info = {}, rows, t, company = 'Lumi Trade' }) {
  const out = [
    [`${company} — PACKING LIST`],
    [`Order: ${order.order_no}`, '', '', `Date: ${new Date().toISOString().slice(0, 10)}`],
    [info.pol ? `Port of loading: ${info.pol}` : '', '', '', info.pod ? `Destination: ${info.pod}` : ''],
    [info.mode ? `Mode: ${info.mode}` : '', '', '', info.ready_date ? `Cargo ready: ${info.ready_date}` : ''],
    info.marks ? [`Shipping marks: ${info.marks}`] : [],
    [],
    ['CTN No.', 'Cartons', 'Description', 'Item / SKU', 'HS code', 'Pcs/ctn', 'Total pcs', 'L (cm)', 'W (cm)', 'H (cm)', 'CBM/ctn', 'Total CBM', 'GW/ctn (kg)', 'Total GW (kg)', 'NW/ctn (kg)', 'Total NW (kg)'],
  ];
  for (const x of rows) {
    const c = Number(x.cartons || 1), cbm = cartonCbm(x);
    out.push([x.carton_no, c, x.description || '', x.sku || '', x.hs_code || '', x.quantity ?? '', x.quantity != null ? x.quantity * c : '',
      x.length_cm ?? '', x.width_cm ?? '', x.height_cm ?? '', cbm != null ? r(cbm, 4) : '', cbm != null ? r(cbm * c, 3) : '',
      x.gross_weight_kg ?? '', x.gross_weight_kg != null ? r(x.gross_weight_kg * c, 2) : '', x.net_weight_kg ?? '', x.net_weight_kg != null ? r(x.net_weight_kg * c, 2) : '']);
  }
  out.push(['TOTAL', t.cartons, '', '', '', '', t.pieces, '', '', '', '', t.cbm, '', t.gross, '', t.net]);
  if (info.remarks) out.push([], [`Notes: ${info.remarks}`]);
  return out;
}
