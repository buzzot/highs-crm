// Purchasing: purchase orders to suppliers (grouping order lines by supplier, the PO document, reading a supplier's reply).
// Pure functions — no database access here.
import { renderDocument } from './doc-pdf.js';
import { writeXlsx } from './xlsx-write.js';

const r2 = x => Math.round(x * 100) / 100;
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const day = d => new Date(d || Date.now()).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

export const SPO_STATUSES = ['draft', 'sent', 'replied', 'confirmed', 'declined', 'cancelled'];
export const SPO_LABEL = { draft: 'Draft', sent: 'Sent — waiting for reply', replied: 'Replied — check', confirmed: 'Confirmed', declined: 'Declined', cancelled: 'Cancelled' };

/**
 * One PO per supplier and currency. rows: [{ order_item_id, product_id, description, sku, quantity, unit, unit_price, currency, supplier_id }]
 * Rows without a supplier or quantity are returned in `skipped`.
 */
export function groupBySupplier(rows) {
  const groups = new Map(), skipped = [];
  for (const x of rows || []) {
    const quantity = num(x.quantity);
    if (!x.supplier_id || !(quantity > 0) || !String(x.description || '').trim()) { skipped.push(x); continue; }
    const currency = String(x.currency || 'CNY').toUpperCase();
    const key = `${x.supplier_id}|${currency}`;
    if (!groups.has(key)) groups.set(key, { supplier_id: x.supplier_id, currency, lines: [] });
    groups.get(key).lines.push({ description: String(x.description).trim(), sku: x.sku || '', quantity, unit: x.unit || 'pcs', unit_price: num(x.unit_price), product_id: x.product_id || null, order_item_id: x.order_item_id || null });
  }
  return { groups: [...groups.values()].map(g => ({ ...g, total: totalOf(g.lines) })), skipped };
}

export const totalOf = lines => r2((lines || []).reduce((t, l) => t + num(l.quantity) * num(l.unit_price), 0));

const companyBlock = c => ({ name: c.name, lines: [...String(c.address || '').split('\n').map(x => x.trim()).filter(Boolean), [c.email, c.phone].filter(Boolean).join(' · '), c.website].filter(Boolean) });

/** The PDF document (Latin-1 only — the PDF writer has no CJK font). */
export function spoDocument(po, { supplier, order, company }) {
  const s = supplier || {};
  return {
    title: 'PURCHASE ORDER', no: po.ref, date: day(po.sent_at || po.created_at),
    status: po.status === 'draft' ? 'Draft — not sent yet' : null,
    seller: companyBlock(company), partyLabel: 'To (supplier)',
    party: { name: s.name || '—', lines: [s.contact_name && `Attn: ${s.contact_name}`, [s.email, s.phone].filter(Boolean).join(' · '), s.city].filter(Boolean) },
    meta: [['Our order', order?.order_no], ['Required by', po.required_date ? day(po.required_date + 'T12:00:00') : null], ['Payment terms', po.payment_terms], ['Ship to', po.ship_to], ['Currency', po.currency]],
    currency: po.currency, lines: po.lines,
    sections: [
      { heading: 'Notes', text: po.notes },
      { heading: 'Please reply to this email to', text: ['1. Confirm this order (price, quantity, and the date the goods will be ready).', '2. Send your proforma invoice (PI).', po.want_packing ? '3. Send an ESTIMATED packing list: cartons, pieces per carton, carton size (cm), gross and net weight per carton, total CBM.' : null].filter(Boolean).join('\n') },
    ],
    footer: `${po.ref} · ${company.name}`,
  };
}
export const spoPdf = (po, ctx) => renderDocument(spoDocument(po, ctx));

/** An Excel the supplier fills in with the estimated packing list. */
export function packingTemplate(po, { order } = {}) {
  const rows = [
    ['ESTIMATED PACKING LIST — please fill in the yellow columns and send it back by replying to our email'],
    [`PO ${po.ref}`, order?.order_no ? `Order ${order.order_no}` : '', '', '', '', '', '', '', '', '', `ID:${po.token}`],
    [],
    ['No.', 'Product', 'SKU', 'Qty (pcs)', 'Cartons', 'Pcs / carton', 'Length cm', 'Width cm', 'Height cm', 'Net kg / carton', 'Gross kg / carton'],
    ...(po.lines || []).map((l, i) => [i + 1, l.description, l.sku || '', num(l.quantity), '', '', '', '', '', '', '']),
    [],
    ['Ready date (YYYY-MM-DD):', '', 'Notes:'],
  ];
  return writeXlsx(rows, { sheet: 'Packing list', boldRows: [0, 3], widths: [6, 38, 16, 12, 10, 12, 11, 11, 11, 14, 15] });
}

const has = (t, re) => re.test(t);
/**
 * Rule-based reading of a supplier's reply (used when AI is off or fails).
 * → 'confirmed' | 'declined' | 'question' | 'info'
 */
export function classifyReply(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return 'info';
  const no = has(t, /\b(cannot|can't|can not|unable|not able|out of stock|no longer|discontinued|reject(ed)?|decline(d)?|sorry)\b|无法|不能|缺货|没有库存|停产/);
  const yes = has(t, /\b(confirm(ed|ing)?|accepted?|agreed?|noted|received your (po|order)|will (arrange|produce|prepare)|in production|ok(ay)?)\b|已确认|确认|收到|好的|可以|安排生产/);
  if (no && !yes) return 'declined';
  if (yes) return 'confirmed';
  if (t.includes('?') || has(t, /\b(please (advise|confirm|clarify)|could you|can you|question)\b|请问|能否/)) return 'question';
  return 'info';
}

// ---- files in a supplier's reply ----
export const isXlsx = f => /\.xlsx$/i.test(f.originalname || '') || /spreadsheetml/.test(f.mimetype || '');
export const isPdf = f => /\.pdf$/i.test(f.originalname || '') || f.mimetype === 'application/pdf';
const isDoc = f => /\.(docx?|xls|csv)$/i.test(f.originalname || '');
export const isImg = f => /^image\/(png|jpe?g|gif|webp)$/i.test(f.mimetype || '') || /\.(png|jpe?g|webp|gif)$/i.test(f.originalname || '');
export const mediaOf = f => (/^image\//.test(f.mimetype || '') ? f.mimetype.replace('jpg', 'jpeg') : /\.png$/i.test(f.originalname) ? 'image/png' : /\.webp$/i.test(f.originalname) ? 'image/webp' : 'image/jpeg');

/** Keep the documents worth storing (PI, packing list, screenshots); skip logos and signatures. */
export function keepFiles(files = []) {
  return files.filter(f => f?.buffer?.length && (isXlsx(f) || isPdf(f) || isDoc(f) || (isImg(f) && f.buffer.length > 15000))).slice(0, 8);
}

/** Guess what a supplier's file is from its name. */
export const kindOf = name => (/proforma|invoice|\bpi\b|发票/i.test(name || '') ? 'proforma_invoice' : /packing|装箱/i.test(name || '') ? 'packing_list' : 'other');

