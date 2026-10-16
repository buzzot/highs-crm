// Purchase orders (client → Lumi Trade) and proforma invoices (Lumi Trade → client): data helpers and PDF documents.
import { renderDocument } from './doc-pdf.js';
import { withAmounts } from './payments.js';
import { shownOf } from './freight-mode.js';

export const COMPANY_DEFAULTS = { name: 'Lumi Trade', address: '', email: '', phone: '', website: '', bank: '', payment_terms: '30% deposit with the order, 70% balance before shipment' };

export async function getCompany(db) {
  const { data } = await db.from('settings').select('value').eq('key', 'company').maybeSingle();
  return { ...COMPANY_DEFAULTS, ...(data?.value || {}) };
}

const day = d => new Date(d || Date.now()).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
const lines = s => String(s || '').split('\n').map(x => x.trim()).filter(Boolean);
const join = (...x) => x.filter(Boolean).join(' · ');

const companyBlock = c => ({ name: c.name, lines: [...lines(c.address), join(c.email, c.phone), c.website].filter(Boolean) });

/** Client header (company, contact person, email / phone, addresses) as shown on the PO and PI. */
export function clientLines(c = {}, { delivery = true } = {}) {
  return [c.contact && `Attn: ${c.contact}`, join(c.email, c.phone), ...lines(c.address), delivery && c.delivery_address ? `Deliver to: ${c.delivery_address.replace(/\s*\n\s*/g, ', ')}` : null].filter(Boolean);
}

export const totalOf = lines_ => Math.round((lines_ || []).reduce((t, l) => t + Number(l.quantity || 0) * Number(l.unit_price || 0), 0) * 100) / 100;

/** Initial PO content from an accepted quote (sell prices, ex-logistics). */
export function poFromQuote({ quote, item, product, request, org, profile }) {
  const address = [org?.address, [org?.postal_code, org?.city].filter(Boolean).join(' '), org?.country].filter(Boolean).join('\n');
  // freight included in the price: one all-in unit price; otherwise freight, duties and other costs go in as one estimated line, so the PO total matches the quotation total
  const sh = shownOf(quote), logistics = sh.logistics;
  const lines = [{ description: item?.name || product?.name || request?.title || 'Goods', sku: item?.sku || product?.sku || '', quantity: Number(quote.quantity), unit: item?.unit || 'pcs', unit_price: sh.included ? sh.unit_price : Number(quote.unit_price) }];
  if (logistics > 0) lines.push({ description: 'Freight & logistics (estimate)', sku: '', quantity: 1, unit: 'lot', unit_price: logistics });
  return {
    client: { company: org?.name || '', contact: profile?.full_name || '', email: profile?.email || '', phone: org?.phone || '', address, delivery_address: org?.delivery_address || '', ref: '' },
    lines,
    currency: quote.sell_currency || 'USD', incoterm: quote.incoterm || null, lead_time_days: quote.lead_time_days || null,
  };
}

export function poDocument(po, company, { quoteRef } = {}) {
  const c = po.client || {};
  const lc = companyBlock(company);
  return {
    title: 'PURCHASE ORDER', no: po.po_no, date: day(po.submitted_at || po.created_at),
    status: ({ draft: 'Draft — not sent yet', submitted: 'Sent to ' + company.name, approved: 'Approved', rejected: 'Not accepted' })[po.status],
    seller: { name: c.company || 'Client', lines: clientLines(c, { delivery: false }) },
    partyLabel: 'To (seller)', party: lc,
    meta: [['Client PO ref', c.ref], ['Quotation', quoteRef], ['Incoterm', po.incoterm], ['Lead time', po.lead_time_days ? `${po.lead_time_days} days` : null], ['Deliver to', c.delivery_address ? c.delivery_address.replace(/\s*\n\s*/g, ', ') : null], ['Currency', po.currency]],
    currency: po.currency, lines: po.lines,
    sections: [{ heading: 'Notes from the buyer', text: po.client_notes }, { heading: 'Comments', text: po.status === 'approved' || po.status === 'rejected' ? po.admin_note : '' }, { heading: 'Terms', text: po.terms }],
    footer: `${po.po_no} · ${c.company || ''} to ${company.name}`,
  };
}

export function scheduleText(d, pi) {
  const rows = withAmounts(d.schedule, totalOf(d.lines || []));
  return rows.map(x => `${x.label} ${Number(x.percent)}% · ${d.currency} ${Number(x.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${x.due ? ' · due ' + day(x.due + 'T12:00:00') : ''}`).join('\n') || null;
}

export function piDocument(pi, order, company) {
  const d = pi.data || {};
  const b = d.buyer || {};
  return {
    title: 'PROFORMA INVOICE', no: pi.pi_no, date: day(pi.sent_at || pi.created_at),
    seller: companyBlock(company),
    partyLabel: 'Bill to', party: { name: b.company || '—', lines: clientLines(b) },
    meta: [['Order', order?.order_no], ['Client PO ref', d.po_ref], ['Incoterm', d.incoterm], ['Lead time', d.lead_time_days ? `${d.lead_time_days} days` : null], ['Valid until', d.valid_until ? day(d.valid_until) : null], ['Currency', d.currency]],
    currency: d.currency, lines: d.lines,
    sections: [{ heading: 'Payment terms', text: d.payment_terms }, { heading: 'Payment schedule', text: scheduleText(d, pi) }, { heading: 'Bank details', text: d.bank }, { heading: 'Notes', text: d.notes }],
    footer: `${pi.pi_no} · ${company.name}`,
  };
}

export const poPdf = (po, company, opts) => renderDocument(poDocument(po, company, opts));
export const piPdf = (pi, order, company) => renderDocument(piDocument(pi, order, company));

/** Lines from a posted form: lines[0][description] … */
export function parseLines(body) {
  const raw = body?.lines;
  const arr = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : [];
  const n = v => { const x = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(x) && x >= 0 ? x : 0; };
  return arr.map(l => ({ description: String(l?.description || '').trim().slice(0, 500), sku: String(l?.sku || '').trim().slice(0, 80), quantity: n(l?.quantity), unit: String(l?.unit || 'pcs').trim().slice(0, 20) || 'pcs', unit_price: n(l?.unit_price), ...(/^[0-9a-f-]{36}$/i.test(l?.product_id || '') ? { product_id: l.product_id } : {}) }))
    .filter(l => l.description && l.quantity > 0);
}
export const text = (v, max = 4000) => (String(v ?? '').trim().slice(0, max) || null);
