// Freight quotation form: the Excel sheet forwarders fill in (sent with the packing list),
// and the reader that turns a filled form back into a structured quote — no AI needed for that.
import { writeWorkbook } from './xlsx-write.js';
import { packingSheet } from './packing.js';

export const FORM_ID = 'LUMI-QF1';
export const CURRENCIES = ['USD', 'CNY', 'EUR'];
export const SERVICE_MODES = ['Sea LCL', 'Sea FCL 20GP', 'Sea FCL 40GP', 'Sea FCL 40HQ', 'Air', 'Express', 'Rail', 'Truck'];
export const SCOPES = ['Port to port', 'Door to port', 'Port to door', 'Door to door DDU', 'Door to door DDP'];
export const HANDOVER = ['Pickup from supplier 上门提货', 'Supplier delivers to our warehouse 送货入仓'];
export const BASIS = ['per kg', 'per cbm', 'per shipment', 'per carton', 'per container', 'per B/L'];

// [key, "English 中文" label, kind, list] — the English part is how the reader finds the row again
const FORWARDER = [
  ['company', 'Company name 公司名称'],
  ['contact_person', 'Quoted by 报价人'],
  ['email', 'Email 邮箱'],
  ['phone', 'Phone / WeChat 电话/微信'],
];
const QUOTE = [
  ['quote_date', 'Date quoted 报价日期', 'date'],
  ['valid_until', 'Valid until 有效期至', 'date'],
  ['currency', 'Currency 币种', 'list', CURRENCIES],
  ['mode', 'Service / mode 运输方式', 'list', SERVICE_MODES],
  ['scope', 'Service scope 服务范围', 'list', SCOPES],
  ['transit_days', 'Transit time (days) 时效（天）', 'num'],
  ['etd', 'Shipping date (ETD) 开船/起飞日期', 'date'],
  ['handover', 'Cargo handover 交货方式', 'list', HANDOVER],
];
// [item "English 中文", default basis, default qty: 'main' | 1 | null]
const CHARGES = [
  ['Main freight 主运费', null, 'main'],
  ['Documentation 文件费', 'per shipment', 1],
  ['Extra service 其他服务', null, null],
];
const TAIL = [['remarks', 'Remarks / not included 备注/不含费用', 'wrap']];

const isAir = mode => /air|express/i.test(mode || '');
const fmtDate = d => (d ? String(d).slice(0, 10) : '');

/** Sheet definition for writeWorkbook(). Compact: our request (4 lines), forwarder, quote, 3 charges, total. */
export function quoteFormSheet({ order, info = {}, t, ref, token }) {
  const rows = [], merges = [], validations = [], heights = {};
  const add = (cells, h) => { rows.push(cells); if (h) heights[rows.length - 1] = h; return rows.length; }; // returns 1-based row number
  const wide = r => merges.push(`B${r}:E${r}`);
  const label = text => ({ v: text, s: 'label' });

  let r = add([{ v: 'FREIGHT QUOTATION · 运费报价单', s: 'title' }], 26); merges.push(`A${r}:E${r}`);

  const route = [info.pol, info.pod].filter(Boolean).join(' → ');
  const cargo = [`${t.cartons} ${t.pkgWord || 'ctns'}`, `${t.gross} kg`, `${t.cbm} cbm`, isAir(info.mode) && t.chargeableAir ? `chargeable ${t.chargeableAir} kg` : null].filter(Boolean).join(' · ');
  const facts = [
    ['Request 询价', [ref, order.order_no, info.mode].filter(Boolean).join(' · ')],
    ['Route 路线', [route, info.incoterm].filter(Boolean).join(' · ')],
    ['Cargo 货物', [cargo, info.ready_date ? `ready ${fmtDate(info.ready_date)}` : null].filter(Boolean).join(' · ')],
    ['Notes 说明', info.remarks],
  ].filter(x => x[1]);
  for (const [k, v] of facts) { r = add([label(k), { v, s: 'value' }, { s: 'value' }, { s: 'value' }, { s: 'value' }], 20); wide(r); }

  const field = ([, text, kind, list]) => {
    const st = kind === 'date' ? 'inputDate' : kind === 'num' ? 'inputNum' : kind === 'wrap' ? 'inputWrap' : 'input';
    const rr = add([label(text), { s: st }, { s: st }, { s: st }, { s: st }], kind === 'wrap' ? 34 : 20);
    wide(rr);
    if (list) validations.push({ ref: `B${rr}`, list });
    return rr;
  };
  add([{ v: 'FORWARDER · 货代', s: 'section' }]);
  FORWARDER.forEach(field);
  add([{ v: 'QUOTATION · 报价', s: 'section' }]);
  const rowOf = {};
  QUOTE.forEach(f => { rowOf[f[0]] = field(f); });

  add([{ v: 'Charge 项目', s: 'header' }, { v: 'Basis 计费方式', s: 'header' }, { v: 'Unit price 单价', s: 'header' }, { v: 'Qty 数量', s: 'header' }, { v: 'Amount 金额', s: 'header' }], 20);
  const first = rows.length + 1;
  for (const [item, basis, qty] of CHARGES) {
    const n = rows.length + 1;
    const q = qty === 'main' ? (isAir(info.mode) ? t.chargeableAir : t.wm) : qty;
    add([label(item), { v: qty === 'main' ? (isAir(info.mode) ? 'per kg' : 'per cbm') : basis, s: 'input' }, { s: 'inputNum' }, { v: q ?? '', s: 'inputNum' },
      { f: `IF(OR(C${n}="",D${n}=""),"",C${n}*D${n})`, s: 'num' }], 24);
    validations.push({ ref: `B${n}`, list: BASIS });
  }
  const last = rows.length;
  add([{ v: 'TOTAL 总价', s: 'total' }, { f: `B${rowOf.currency}&""`, s: 'total' }, { s: 'total' }, { s: 'total' }, { f: `SUM(E${first}:E${last})`, s: 'total' }], 22);
  TAIL.forEach(field);
  r = add([{ v: `Form ${FORM_ID} · ${ref} · #${token} — please keep this line. 请保留此行。`, s: 'note' }]); merges.push(`A${r}:E${r}`);

  return { name: 'Quotation 报价单', rows, widths: [38, 20, 16, 12, 18], merges, validations, heights };
}

// ---------- reading a filled form back ----------
const s = v => (v === undefined || v === null ? '' : String(v).trim());
const num = v => { if (v === '' || v == null) return null; const n = Number(String(v).replace(/[,\s]/g, '').replace(/[^\d.\-]/g, '')); return Number.isFinite(n) && String(v).match(/\d/) ? n : null; };
/** Excel serial, "2026-10-31", "2026/10/31", "31.10.2026" → YYYY-MM-DD (or the text as typed). */
export function toDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && v > 30000 && v < 80000) return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  const t = s(v);
  let m = t.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = t.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return t || null;
}
// "Main freight 主运费" → "main freight" (also reads older two-line labels)
const enText = v => s(v).split('\n')[0].replace(/[^\x00-\x7F].*$/, '').trim();
const firstLine = v => enText(v).toLowerCase();

/** Find our form in a workbook (from readXlsx) and read it. Returns null when it isn't our form. */
export function parseQuoteForm(wb) {
  const sheet = (wb?.sheets || []).find(sh => Array.from(sh.rows).some(row => Array.from(row || []).some(c => s(c).includes(FORM_ID))));
  if (!sheet) return null;
  const rows = Array.from(sheet.rows, r => Array.from(r || [], c => c ?? ""));
  const byLabel = {};
  for (const row of rows) { const k = firstLine(row[0]); if (k && !(k in byLabel)) byLabel[k] = row; }
  const val = en => byLabel[en.toLowerCase()]?.[1];
  const out = { source: 'form' };
  for (const [key, text, kind] of [...FORWARDER, ...QUOTE, ...TAIL]) {
    const v = val(enText(text));
    out[key] = kind === 'date' ? toDate(v) : kind === 'num' ? num(v) : (s(v) || null);
  }
  const tokenCell = rows.flat().map(s).find(c => c.includes(FORM_ID)) || '';
  out.token = (tokenCell.match(/#([a-z0-9]{6,16})/i) || [])[1]?.toLowerCase() || null;
  out.handover = /warehouse|入仓/i.test(out.handover || '') ? 'warehouse' : /pickup|提货/i.test(out.handover || '') ? 'pickup' : out.handover;

  // charges: rows after the "Item" header up to TOTAL
  const h = rows.findIndex(row => /^(charge|item)$/.test(firstLine(row[0])) && /basis/i.test(s(row[1])));
  const charges = [];
  let total = null;
  if (h >= 0) {
    for (let i = h + 1; i < rows.length; i++) {
      const row = rows[i];
      if (/^total/i.test(s(row[0]))) { total = num(row[4]); break; }
      const unit = num(row[2]), qty = num(row[3]);
      const amount = num(row[4]) ?? (unit != null && qty != null ? Math.round(unit * qty * 100) / 100 : null);
      if (unit == null && amount == null) continue;
      charges.push({ item: enText(row[0]), per: s(row[1]) || null, unit_price: unit, qty, amount, currency: out.currency || null, notes: s(row[5]) || null });
    }
  }
  const sum = charges.reduce((a, c) => a + (c.amount || 0), 0);
  out.breakdown = charges;
  out.amount = total ?? (charges.length ? Math.round(sum * 100) / 100 : null);
  const main = charges.find(c => /main freight/i.test(c.item));
  out.unit_price = main?.unit_price ?? null;
  out.unit_basis = main?.per ?? null;
  out.is_quote = out.amount != null;
  out.summary = summaryOf(out);
  return out;
}

const n2 = v => Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
/** One line like "USD 1,850 · Sea LCL door to door · 32 days · ETD 2026-11-02 · valid to 2026-10-31 · pickup from supplier". */
export function summaryOf(q) {
  if (!q || q.amount == null) return q?.summary || 'No price in the form yet';
  return [
    `${q.currency || ''} ${n2(q.amount)}`.trim(),
    [q.mode, q.scope].filter(Boolean).join(' · '),
    q.unit_price != null && q.unit_basis ? `${n2(q.unit_price)} ${q.unit_basis}` : null,
    q.transit_days ? `${q.transit_days} days` : null,
    q.etd ? `ETD ${q.etd}` : null,
    q.valid_until ? `valid to ${q.valid_until}` : null,
    q.handover === 'pickup' ? 'pickup from supplier' : q.handover === 'warehouse' ? 'delivered to their warehouse' : null,
  ].filter(Boolean).join(' · ');
}

/** The Excel sent to a forwarder: quotation form first (opens there), packing list second. */
export function rfqWorkbook({ order, info = {}, rows, t, ref = '—', token = '—' }) {
  const pl = packingSheet({ order, info, rows, t });
  const hi = new Set([0, pl.findIndex(x => x[0] === 'CTN No.'), pl.findIndex(x => x[0] === 'TOTAL')]);
  const hdr = pl.findIndex(x => x[0] === 'CTN No.');
  return writeWorkbook([
    quoteFormSheet({ order, info, t, ref, token }),
    { name: 'Packing list 装箱单', landscape: true, widths: [10, 8, 34, 14, 12, 9, 10, 8, 8, 8, 9, 10, 11, 12, 11, 12], freeze: hdr + 1,
      rows: pl.map((row, ri) => (row || []).map(v => (ri === hdr ? { v, s: 'header' } : hi.has(ri) && v !== '' && v != null ? { v, s: 'bold' } : v))) },
  ]);
}
