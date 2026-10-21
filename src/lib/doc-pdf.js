// PDF layout shared by the Purchase Order and the Proforma Invoice.
import { Pdf, A4, wrap, textWidth } from './pdf-write.js';

const INK = [27, 36, 48], MUTED = [102, 112, 128], LINE = [210, 215, 222], BRAND = [18, 94, 82], SOFT = [244, 246, 248];
const M = 42, W = A4.w - 2 * M, BOTTOM = A4.h - 60;

export const money = (v, cur) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return `${cur ? cur + ' ' : ''}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const qtyFmt = v => (v == null || v === '' ? '' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 3 }));
const priceFmt = v => (v == null || v === '' ? '' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: Number(v) !== 0 && Math.abs(Number(v)) < 0.1 ? 4 : 2 }));

/**
 * @param {{ title: string, no: string, date: string, status?: string,
 *   seller: { name: string, lines: string[] }, partyLabel: string, party: { name: string, lines: string[] },
 *   meta: [string, string][], currency: string, lines: { description: string, sku?: string, quantity: number, unit?: string, unit_price: number }[],
 *   sections?: { heading: string, text: string }[], footer?: string }} d
 */
export function renderDocument(d) {
  const pdf = new Pdf();
  let y = M;
  const ensure = h => { if (y + h > BOTTOM) { pdf.addPage(); y = M; return true; } return false; };

  // header: seller left, title right
  pdf.text(d.seller.name || 'Lumi Trade', M, y, { size: 17, bold: true, color: BRAND });
  let sy = y + 24;
  for (const l of d.seller.lines || []) { for (const w of wrap(l, 260, 9)) { pdf.text(w, M, sy, { size: 9, color: MUTED }); sy += 12; } }
  pdf.text(d.title, M + W, y, { size: 20, bold: true, align: 'right' });
  pdf.text(d.no, M + W, y + 28, { size: 11, bold: true, align: 'right' });
  pdf.text(`Date: ${d.date}`, M + W, y + 44, { size: 9, color: MUTED, align: 'right' });
  if (d.status) pdf.text(d.status, M + W, y + 58, { size: 9, bold: true, color: BRAND, align: 'right' });
  y = Math.max(sy, y + 74) + 8;
  pdf.line(M, y, M + W, y, { width: 1, color: BRAND }); y += 14;

  // party box (left) and details (right)
  const colW = (W - 20) / 2;
  const boxTop = y;
  pdf.text(d.partyLabel.toUpperCase(), M, y, { size: 8, bold: true, color: MUTED }); let py = y + 14;
  pdf.text(d.party.name || '—', M, py, { size: 11, bold: true }); py += 15;
  for (const l of d.party.lines || []) { for (const w of wrap(l, colW, 9.5)) { pdf.text(w, M, py, { size: 9.5 }); py += 12.5; } }
  const rx = M + colW + 20; let ry = y;
  pdf.text('DETAILS', rx, ry, { size: 8, bold: true, color: MUTED }); ry += 14;
  for (const [k, v] of d.meta || []) {
    if (v == null || v === '') continue;
    const vl = wrap(String(v), colW - 105, 9.5, true);
    pdf.text(k, rx, ry, { size: 9.5, color: MUTED });
    vl.forEach((t, i) => pdf.text(t, rx + 105, ry + i * 12.5, { size: 9.5, bold: true }));
    ry += Math.max(1, vl.length) * 12.5 + 2;
  }
  y = Math.max(py, ry, boxTop + 40) + 14;

  // items table
  const cols = { n: M + 6, desc: M + 30, qty: M + W - 205, price: M + W - 120, amt: M + W - 8 };
  const descW = cols.qty - cols.desc - 38;
  const head = () => {
    pdf.rect(M, y, W, 22, { fill: SOFT });
    pdf.text('#', cols.n, y + 6, { size: 8.5, bold: true, color: MUTED });
    pdf.text('DESCRIPTION', cols.desc, y + 6, { size: 8.5, bold: true, color: MUTED });
    pdf.text('QTY', cols.qty + 30, y + 6, { size: 8.5, bold: true, color: MUTED, align: 'right' });
    pdf.text(`PRICE (${d.currency})`, cols.price + 52, y + 6, { size: 8.5, bold: true, color: MUTED, align: 'right' });
    pdf.text('AMOUNT', cols.amt, y + 6, { size: 8.5, bold: true, color: MUTED, align: 'right' });
    y += 28;
  };
  head();
  let total = 0;
  (d.lines || []).forEach((l, i) => {
    const amount = Number(l.quantity || 0) * Number(l.unit_price || 0);
    total += amount;
    const dl = [...wrap(l.description || '', descW, 9.5, true), ...(l.sku ? [`SKU / part no.: ${l.sku}`] : [])];
    const h = dl.length * 12.5 + 10;
    if (ensure(h + 4)) head();
    pdf.text(String(i + 1), cols.n, y, { size: 9.5, color: MUTED });
    dl.forEach((t, k) => pdf.text(t, cols.desc, y + k * 12.5, { size: 9.5, color: l.sku && k === dl.length - 1 ? MUTED : INK }));
    pdf.text(`${qtyFmt(l.quantity)}${l.unit ? ' ' + l.unit : ''}`, cols.qty + 30, y, { size: 9.5, align: 'right' });
    pdf.text(priceFmt(l.unit_price), cols.price + 52, y, { size: 9.5, align: 'right' });
    pdf.text(money(amount), cols.amt, y, { size: 9.5, bold: true, align: 'right' });
    y += h;
    pdf.line(M, y - 5, M + W, y - 5, { color: LINE });
  });
  ensure(40);
  y += 4;
  pdf.rect(M + W - 230, y, 230, 26, { fill: BRAND });
  pdf.text('TOTAL', M + W - 218, y + 8, { size: 10, bold: true, color: [255, 255, 255] });
  pdf.text(money(total, d.currency), M + W - 10, y + 8, { size: 11, bold: true, color: [255, 255, 255], align: 'right' });
  y += 44;

  // text sections
  for (const s of d.sections || []) {
    if (!s.text || !String(s.text).trim()) continue;
    const lines = wrap(String(s.text), W, 9.5);
    ensure(30);
    pdf.text(s.heading.toUpperCase(), M, y, { size: 8, bold: true, color: MUTED }); y += 14;
    for (const t of lines) { if (ensure(14)) { /* continues on next page */ } pdf.text(t, M, y, { size: 9.5 }); y += 12.5; }
    y += 10;
  }

  // footer with page numbers on every page
  const n = pdf.pages.length;
  return finish(pdf, d, n);
}

function finish(pdf, d, n) {
  const all = pdf.pages;
  all.forEach((ops, i) => {
    pdf.pages = [ops];
    pdf.line(M, A4.h - 44, M + W, A4.h - 44, { color: LINE });
    pdf.text(d.footer || '', M, A4.h - 36, { size: 8, color: MUTED });
    pdf.text(`Page ${i + 1} of ${n}`, M + W, A4.h - 36, { size: 8, color: MUTED, align: 'right' });
  });
  pdf.pages = all;
  return pdf.toBuffer({ title: `${d.title} ${d.no}` });
}


// ---------------------------------------------------------------------------
// Packing list: A4 landscape, same look as the on-screen print view.
const n0 = v => (v == null || v === '' ? '' : Number(v).toLocaleString('en-US'));
const r2 = v => Math.round(Number(v) * 100) / 100;

/** @param {{ seller: { name: string }, orderNo: string, date: string, info?: object, rows: object[], t: object }} d */
export function renderPackingList(d) {
  const pdf = new Pdf({ landscape: true });
  const PM = 30, PW = pdf.w - 2 * PM, PBOTTOM = pdf.h - 46;
  const info = d.info || {};
  let y = PM;
  const ensure = h => { if (y + h > PBOTTOM) { pdf.addPage(); y = PM; return true; } return false; };

  pdf.text(d.seller?.name || 'Lumi Trade', PM, y, { size: 15, bold: true, color: BRAND });
  pdf.text('PACKING LIST', PM, y + 26, { size: 20, bold: true });
  const meta = [['No.', d.no], ['Order', d.orderNo], ['Date', d.date], ['Mode', info.mode], ['Port of loading', info.pol], ['Destination', info.pod], ['Incoterm', info.incoterm], ['Cargo ready', info.ready_date]].filter(([, v]) => v);
  let my = y;
  for (const [k, v] of meta) { pdf.text(k, PM + PW - 190, my, { size: 9, color: MUTED }); pdf.text(String(v), PM + PW, my, { size: 9, align: 'right' }); my += 13; }
  y = Math.max(y + 56, my) + 8;
  pdf.line(PM, y, PM + PW, y, { width: 1.2, color: BRAND }); y += 14;

  // columns: [label, width, align]
  const spec = [['CTN NO.', 44, 'l'], ['CTNS', 32, 'r'], ['DESCRIPTION', 0, 'l'], ['ITEM / SKU', 64, 'l'], ['PCS/CTN', 42, 'r'], ['TOTAL PCS', 50, 'r'], ['L × W × H CM', 86, 'r'], ['CBM', 42, 'r'], ['GW/CTN', 44, 'r'], ['TOTAL GW', 52, 'r'], ['TOTAL NW', 52, 'r']];
  const GAP = 8;
  const fixed = spec.reduce((a, c) => a + c[1], 0) + GAP * (spec.length - 1);
  spec[2][1] = PW - fixed;
  let x0 = PM; const cols = spec.map(([label, w, al]) => { const c = { label, w, al, x: x0 }; x0 += w + GAP; return c; });
  const put = (str, c, yy, o = {}) => pdf.text(str, c.al === 'r' ? c.x + c.w : c.x, yy, { size: o.size || 8.5, bold: o.bold, color: o.color, align: c.al === 'r' ? 'right' : 'left' });
  const head = () => {
    pdf.rect(PM - 4, y - 5, PW + 8, 20, { fill: SOFT });
    cols.forEach(c => put(c.label, c, y, { size: 7.5, bold: true, color: MUTED }));
    y += 22;
  };
  head();
  const dims = x => (x.length_cm ? `${Number(x.length_cm)} × ${Number(x.width_cm)} × ${Number(x.height_cm)}` : '—');
  for (const x of d.rows || []) {
    const c = Number(x.cartons || 1);
    const desc = [...wrap(x.description || '—', cols[2].w, 8.5), ...(x.hs_code ? [`HS ${x.hs_code}`] : [])];
    const h = Math.max(desc.length, 1) * 11.5 + 7;
    if (ensure(h + 2)) head();
    put(String(x.carton_no ?? ''), cols[0], y);
    put(String(c), cols[1], y);
    desc.forEach((t, i) => pdf.text(t, cols[2].x, y + i * 11.5, { size: 8.5, color: x.hs_code && i === desc.length - 1 ? MUTED : INK }));
    put(x.sku || '', cols[3], y);
    put(n0(x.quantity), cols[4], y);
    put(x.quantity != null ? n0(x.quantity * c) : '', cols[5], y);
    put(dims(x), cols[6], y);
    put(x.cbm ? (Number(x.cbm) * c).toFixed(3) : '', cols[7], y);
    put(x.gross_weight_kg != null ? String(Number(x.gross_weight_kg)) : '', cols[8], y);
    put(x.gross_weight_kg != null ? n0(r2(x.gross_weight_kg * c)) : '', cols[9], y);
    put(x.net_weight_kg != null ? n0(r2(x.net_weight_kg * c)) : '', cols[10], y);
    y += h;
    pdf.line(PM, y - 3, PM + PW, y - 3, { color: LINE });
  }
  ensure(30);
  const t = d.t || {};
  pdf.rect(PM - 4, y - 1, PW + 8, 20, { fill: SOFT });
  put('TOTAL', cols[0], y + 4, { bold: true });
  put(String(t.cartons ?? ''), cols[1], y + 4, { bold: true });
  put(n0(t.pieces), cols[5], y + 4, { bold: true });
  put(t.cbm != null ? String(t.cbm) : '', cols[7], y + 4, { bold: true });
  put(`${n0(t.gross)} kg`, cols[9], y + 4, { bold: true });
  put(`${n0(t.net)} kg`, cols[10], y + 4, { bold: true });
  y += 34;

  const notes = [];
  if (info.marks) notes.push(['Shipping marks:', info.marks]);
  if (info.remarks) notes.push(['Notes:', info.remarks]);
  for (const [k, v] of notes) {
    for (const [i, l] of wrap(String(v), PW - 90, 9).entries()) { ensure(14); if (i === 0) pdf.text(k, PM, y, { size: 9, color: MUTED }); pdf.text(l, PM + 90, y, { size: 9 }); y += 12.5; }
  }
  ensure(14);
  pdf.text(`For forwarders: air chargeable ~ ${n0(t.chargeableAir)} kg (volumetric ${n0(t.volumetricAir)} kg at 1:6000) · sea LCL W/M ${t.wm ?? ''}${t.missing?.length ? ' · missing on some lines: ' + t.missing.join(', ') : ''}`, PM, y + 4, { size: 8, color: MUTED });

  const all = pdf.pages, n = all.length;
  all.forEach((ops, i) => {
    pdf.pages = [ops];
    pdf.line(PM, pdf.h - 34, PM + PW, pdf.h - 34, { color: LINE });
    pdf.text(`${d.no ? 'Packing list ' + d.no : 'Packing list'} · ${d.orderNo}`, PM, pdf.h - 28, { size: 8, color: MUTED });
    pdf.text(`Page ${i + 1} of ${n}`, PM + PW, pdf.h - 28, { size: 8, color: MUTED, align: 'right' });
  });
  pdf.pages = all;
  return pdf.toBuffer({ title: `Packing list ${d.no || d.orderNo}` });
}
