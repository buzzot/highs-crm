// Request for quotation (RFQ): one request sent to many suppliers, answers compared side by side.
import { layout, esc } from './email-templates.js';
import { fxRate } from './util.js';
import { cleanSpec, specFacts } from './request-spec.js';

export const RFQ_STATUS_LABEL = { draft: 'Draft', open: 'Open', closed: 'Closed' };
export const RS_LABEL = { draft: 'Not sent', sent: 'Waiting', replied: 'Answered', declined: 'Declined' };
export const RFQ_CURRENCIES = ['USD', 'CNY', 'EUR', 'GBP'];
const INCOTERMS = ['EXW', 'FCA', 'FOB', 'CIF', 'CFR', 'CPT', 'DAP', 'DDP'];

const numOrNull = v => {
  const s = String(v ?? '').trim().replace(',', '.');
  const n = Number(s);
  return s !== '' && Number.isFinite(n) && n >= 0 ? n : null;
};
const arr = v => (Array.isArray(v) ? v : Object.values(v || {}));
const txt = (v, n = 300) => String(v ?? '').trim().slice(0, n);

/** Items from the form (item[0][description] …) → stored lines with stable ids. */
export function cleanItems(body = {}) {
  const out = [];
  arr(body.item).forEach((x, i) => {
    if (!x) return;
    const description = txt(x.description, 400);
    if (!description) return;
    const quantity = numOrNull(String(x.quantity ?? '').replace(/[,\s]/g, '')); // "2,000" is two thousand
    out.push({ id: txt(x.id, 20) || 'i' + (i + 1) + Math.random().toString(36).slice(2, 5), description, sku: txt(x.sku, 80), quantity: quantity > 0 ? quantity : null, unit: txt(x.unit, 20) || 'pcs',
      notes: txt(x.notes, 600), spec: cleanSpec(x.spec), product_id: /^[0-9a-f-]{36}$/i.test(x.product_id || '') ? x.product_id : null, request_item_id: /^[0-9a-f-]{36}$/i.test(x.request_item_id || '') ? x.request_item_id : null });
  });
  return out;
}

/** A supplier's answer from the portal form (line[<item id>][unit_price] …) → { lines, terms, problems }. */
export function cleanResponse(body = {}, items = [], defaultCurrency = 'USD') {
  const lines = [], problems = [];
  const given = body.line || {};
  for (const it of items) {
    const x = given[it.id] || {};
    const price = numOrNull(x.unit_price);
    const filled = ['unit_price', 'moq', 'lead_days', 'carton_qty', 'note'].some(k => txt(x[k]) !== '');
    if (!filled) continue;
    if (txt(x.unit_price) !== '' && price == null) problems.push(`"${it.description}": unit price is not a number`);
    const cur = RFQ_CURRENCIES.includes(String(x.currency || '').toUpperCase()) ? String(x.currency).toUpperCase() : defaultCurrency;
    lines.push({ item_id: it.id, unit_price: price, currency: cur, moq: numOrNull(x.moq), lead_days: numOrNull(x.lead_days), carton_qty: numOrNull(x.carton_qty),
      carton_l: numOrNull(x.carton_l), carton_w: numOrNull(x.carton_w), carton_h: numOrNull(x.carton_h), gross_kg: numOrNull(x.gross_kg), note: txt(x.note, 600) });
  }
  const incoterm = String(body.incoterm || '').toUpperCase();
  const terms = { incoterm: INCOTERMS.includes(incoterm) ? incoterm : '', fob_port: txt(body.fob_port, 120), payment_terms: txt(body.payment_terms, 300), valid_until: /^\d{4}-\d{2}-\d{2}$/.test(body.valid_until || '') ? body.valid_until : '' };
  if (!lines.some(l => l.unit_price != null)) problems.push('Enter a unit price for at least one product, or choose "We can\'t quote".');
  return { lines, terms, problems };
}

/** Newest confirmed/declined answer per rfq_supplier (responses arrive newest first or in any order). */
export function currentResponses(responses = []) {
  const by = {};
  for (const x of [...responses].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))) {
    if (x.status === 'parsed') continue;
    by[x.rfq_supplier_id] ||= x;
  }
  return by;
}

/**
 * Comparison grid: one row per item, one cell per invited supplier. Prices are also shown in the RFQ currency
 * (settings fx) so a ¥ quote and a $ quote can be ranked; `best` marks the lowest per item.
 */
export function compare({ items = [], suppliers = [], responses = [], currency = 'USD', settings = {} }) {
  const cur = currentResponses(responses);
  const rows = items.map(it => {
    const cells = suppliers.map(s => {
      const resp = cur[s.id];
      const l = resp && resp.status === 'confirmed' ? (resp.lines || []).find(x => x.item_id === it.id) : null;
      if (!l || l.unit_price == null) return { rs: s.id, price: null };
      const conv = l.unit_price * fxRate(settings, l.currency || currency, currency);
      return { rs: s.id, price: l.unit_price, currency: l.currency || currency, converted: Math.round(conv * 10000) / 10000, moq: l.moq, lead_days: l.lead_days, carton_qty: l.carton_qty, note: l.note || '' };
    });
    const priced = cells.filter(c => c.converted != null);
    const min = priced.length ? Math.min(...priced.map(c => c.converted)) : null;
    cells.forEach(c => { c.best = min != null && c.converted === min && priced.length > 1; });
    return { item: it, cells };
  });
  const totals = suppliers.map(s => {
    let t = 0, n = 0;
    rows.forEach(r => { const c = r.cells.find(x => x.rs === s.id); if (c?.converted != null && r.item.quantity) { t += c.converted * r.item.quantity; n++; } });
    return { rs: s.id, total: Math.round(t * 100) / 100, quoted: n, of: items.length };
  });
  return { rows, totals };
}

/** The email a supplier receives: items table, deadline, and two ways to answer (portal button, or reply to the email). */
export function rfqSupplierEmail({ rfq, supplier, url, message, senderName, files = [], attached = false }) {
  const n = v => (v == null ? '' : Number(v).toLocaleString('en-US'));
  const td = (v, r) => `<td style="padding:7px 8px;border-bottom:1px solid #eef0f3;font-size:13px;color:#16202e;${r ? 'text-align:right;' : ''}">${esc(v ?? '')}</td>`;
  const th = (v, r) => `<th style="padding:7px 8px;border-bottom:2px solid #dfe3e8;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#7a8494;text-align:${r ? 'right' : 'left'};">${esc(v)}</th>`;
  const table = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:14px 0;"><tr>${th('Product')}${th('SKU')}${th('Qty', 1)}</tr>${rfq.items.map(i => `<tr>${td(i.description + (i.notes ? ' — ' + i.notes : '') + (specFacts(i.spec).length ? ' (' + specFacts(i.spec).map(([k, v]) => k + ': ' + v).join('; ') + ')' : ''))}${td(i.sku)}${td(i.quantity ? n(i.quantity) + ' ' + (i.unit || 'pcs') : '', 1)}</tr>`).join('')}</table>`;
  const intro = `Dear ${esc(supplier?.contact_name || supplier?.name || 'partner')},<br>we would like your best price for the products below${rfq.deadline ? `. Please answer by <strong>${esc(rfq.deadline)}</strong>` : ''}.`
    + (message ? `<br><br>${esc(message).replace(/\n/g, '<br>')}` : '') + table
    + (files.length ? `<div style="margin:0 0 14px;font-size:13px;color:#16202e;"><strong>Files for this request (${files.length}):</strong> ${files.map(esc).join(', ')}<br><span style="color:#4a5566;">${attached ? 'They are attached to this email and' : 'You can download them'} in the supplier portal.</span></div>` : '')
    + `<span style="font-size:13px;color:#4a5566;">Please include for each product: unit price and currency, MOQ, production lead time, carton size and weight, and your price validity, incoterm and payment terms.</span>`;
  return {
    subject: `Request for quotation ${rfq.ref} — ${rfq.title}`,
    html: layout({ preheader: `Please quote: ${rfq.title}`, eyebrow: `Request for quotation · ${rfq.ref}`, title: rfq.title, introHtml: intro, buttonText: 'Answer in the supplier portal', buttonUrl: url,
      fineHtml: `You can also simply <strong>reply to this email</strong> with your prices (attachments are fine). ${senderName ? 'Sent by ' + esc(senderName) + '.' : ''}` }),
    text: [`Request for quotation ${rfq.ref}: ${rfq.title}`, rfq.deadline ? `Please answer by ${rfq.deadline}.` : null, '', ...rfq.items.map(i => `- ${i.description}${i.sku ? ' (' + i.sku + ')' : ''}${i.quantity ? ' × ' + n(i.quantity) : ''}`), '', ...(files.length ? [`Files: ${files.join(', ')}${attached ? ' (attached)' : ' (download them in the portal)'}`, ''] : []), `Answer online: ${url}`, 'Or reply to this email with your prices.'].filter(x => x != null).join('\n'),
  };
}
