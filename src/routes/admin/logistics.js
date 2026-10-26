import { Router } from '../../lib/router.js';
import { admin } from '../../lib/supabase.js';
import { log } from '../../lib/activity.js';
import { fmt } from '../../lib/format.js';
import { clean, bool, back, notFound, getSettings, fxRate, SHIPMENT_STATUSES, SHIPMENT_MODES, FREIGHT_TYPES, INCOTERMS, CURRENCIES } from '../../lib/util.js';
import { landed } from '../../lib/landed.js';
import { defaultCurrency, sumIn } from '../../lib/currency.js';
import { saveResponse } from '../../lib/freight-store.js';
import { confirmedReceived } from '../../lib/payments-db.js';
import { cashProfit } from '../../lib/payments.js';
import multer from '../../lib/multer-utf8.js';
import { uploadDocument, deleteDocument } from '../../lib/storage.js';
import { getCompany, ciPdf, ciNo, packingListPdf } from '../../lib/purchase.js';
import { packingData } from '../../lib/packing-store.js';
import { draftRfqWorkbook, pkgSummary, qtySummary } from '../../lib/rfq-packing.js';
import { rfqWorkbook } from '../../lib/quote-form.js';
import { totals as packTotals } from '../../lib/packing.js';
import { sendEmail } from '../../lib/mailer.js';
import { bookingEmail } from '../../lib/email-templates.js';
import { replyAddress, subjectTag } from '../../lib/freight.js';

const quoteFiles = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 5 } }).array('files', 5);

const r = Router();
const SHIP_FIELDS = ['order_id', 'forwarder_id', 'mode', 'incoterm', 'origin_port', 'destination_port', 'container_no', 'tracking_no', 'bl_no',
  'export_declaration_no', 'etd', 'eta', 'atd', 'ata', 'status', 'gross_weight_kg', 'volume_cbm', 'cartons', 'notes'];
const shipBody = b => ({ ...clean(b, SHIP_FIELDS), export_official: bool(b.export_official), partial: bool(b.partial) });
const GONE = ['shipped', 'in_transit', 'customs', 'delivered', 'closed', 'cancelled'];
/** An order can take a (new) shipment unless it already shipped/closed/cancelled — partly shipped orders stay open until the last shipment. */
const shippable = (o, ships = []) => !GONE.includes(o.status) || (['shipped', 'in_transit', 'customs'].includes(o.status) && ships.some(x => x.partial));
const PAST_DEPARTURE = ['departed', 'arrived', 'customs', 'delivered'];

r.get('/', async (req, res) => {
  const showAll = req.query.status === 'all';
  let q = admin.from('shipments')
    .select('*, forwarders(name), orders(id, order_no, currency, organizations(name)), freight_costs(amount, fx_to_order, paid)')
    .order('eta', { ascending: true, nullsFirst: false });
  if (!showAll) q = q.neq('status', 'delivered');
  const [{ data: shipments }, { data: forwarders }, { data: rfqReqs }] = await Promise.all([
    q, admin.from('forwarders').select('*').order('name'),
    admin.from('freight_requests').select('*, orders(id, order_no, organizations(name)), freight_rfqs!freight_rfqs_request_id_fkey(id, status, quote_amount, quote_currency, sent_at, forwarders(name)), freight_responses!freight_responses_request_id_fkey(id, received_at)')
      .order('created_at', { ascending: false }).limit(20),
  ]);
  const [settingsC, defCur] = [await getSettings(admin), await defaultCurrency(admin)];
  const list = (shipments || []).map(s => {
    const costs = s.freight_costs || [];
    return {
      ...s,
      freight: costs.reduce((t, c) => t + Number(c.amount) * Number(c.fx_to_order || 1), 0),
      unpaid: costs.filter(c => !c.paid).reduce((t, c) => t + Number(c.amount) * Number(c.fx_to_order || 1), 0),
      exportMissing: s.export_official && !s.export_declaration_no && PAST_DEPARTURE.includes(s.status),
    };
  });
  const today = new Date().toISOString().slice(0, 10);
  const kpi = {
    active: list.filter(s => s.status !== 'delivered').length,
    late: list.filter(s => s.eta && s.eta < today && s.status !== 'delivered').length,
    unpaid: sumIn(settingsC, defCur, list.map(s => [s.unpaid, s.orders?.currency])),
    exportMissing: list.filter(s => s.exportMissing).length,
  };
  res.render('admin/logistics/index', { title: 'Logistics', shipments: list, forwarders: forwarders || [], kpi, showAll, today, quoteRequests: rfqReqs || [] });
});

// ---- freight quote requests ----
r.get('/quotes/:id', async (req, res) => {
  const { data: fr } = await admin.from('freight_requests').select('*, orders(id, order_no, organizations(name)), profiles(full_name, email)').eq('id', req.params.id).single();
  if (!fr) return notFound(res, 'Quote request');
  const [{ data: rfqs }, { data: responses }] = await Promise.all([
    admin.from('freight_rfqs').select('*, forwarders(id, name, contact_name, email, wechat)').eq('request_id', fr.id).order('sent_at'),
    admin.from('freight_responses').select('*, profiles(full_name, email)').eq('request_id', fr.id).order('received_at'),
  ]);
  const quoted = (rfqs || []).filter(x => x.quote_amount != null);
  const best = quoted.sort((a, b) => Number(a.quote_amount) - Number(b.quote_amount))[0] || null;
  const bookingText = {};
  const wcBooked = (rfqs || []).filter(x => x.channel === 'wechat' && x.shipment_id);
  if (wcBooked.length) {
    const { data: shs } = await admin.from('shipments').select('id, etd, eta').in('id', wcBooked.map(x => x.shipment_id));
    for (const x of wcBooked) {
      const sh = (shs || []).find(y => y.id === x.shipment_id) || {};
      bookingText[x.id] = bookingEmail({ order: { order_no: fr.orders?.order_no }, info: fr.info || {}, t: { cartons: fr.totals?.cartons, gross: fr.totals?.gross_kg, cbm: fr.totals?.cbm }, ref: fr.ref, quoteSummary: x.quote_notes, amount: fmt.money(x.quote_amount, x.quote_currency || 'USD'), etd: sh.etd, eta: sh.eta, forwarderName: x.forwarders?.contact_name || x.forwarders?.name }).text;
    }
  }
  res.render('admin/logistics/quote_request', {
    bookingText, title: fr.ref, fr, rfqs: rfqs || [], responses: responses || [], bestId: best?.id || null,
    inboundOn: !!process.env.QUOTE_REPLY_ADDRESS, msg: req.query.msg, err: req.query.err,
  });
});

// paste a reply (WeChat / email) or type the offer → AI reads it → saved as a response
r.post('/quotes/:id/response', quoteFiles, async (req, res) => {
  const { data: rfq } = await admin.from('freight_rfqs').select('*').eq('id', req.body.rfq_id).eq('request_id', req.params.id).single();
  if (!rfq) return back(res, `/admin/logistics/quotes/${req.params.id}`, { err: 'Choose the forwarder who answered.' });
  const text = String(req.body.text || '').trim();
  const manual = { amount: req.body.amount, currency: req.body.currency, transit_days: req.body.transit_days, valid_until: req.body.valid_until, notes: req.body.notes };
  const files = req.files || [];
  if (!text && !files.length && (manual.amount === '' || manual.amount == null)) return back(res, `/admin/logistics/quotes/${req.params.id}`, { err: 'Paste the reply, attach their quotation file, or type the price.' });
  try {
    const { extracted, usage } = await saveResponse({ rfq, channel: req.body.channel === 'email' ? 'email' : req.body.channel === 'manual' ? 'manual' : 'wechat', text, files, manual, userId: req.user.id });
    back(res, `/admin/logistics/quotes/${req.params.id}`, { msg: `Response saved${extracted?.summary ? ': ' + extracted.summary : ''}${usage ? ' — ' + res.locals.aiLine(usage) : ''}` });
  } catch (e) { back(res, `/admin/logistics/quotes/${req.params.id}`, { err: e.message }); }
});

// the quotation form + packing list for one forwarder (e.g. to send by WeChat) — tagged with their token
r.get('/quotes/:id/rfq/:rid/form.xlsx', async (req, res) => {
  const { data: rfq } = await admin.from('freight_rfqs').select('*, freight_requests!freight_rfqs_request_id_fkey(ref, info, cargo)').eq('id', req.params.rid).eq('request_id', req.params.id).maybeSingle();
  if (!rfq) return notFound(res, 'Quote request');
  const fr = rfq.freight_requests || {};
  let order, rows;
  if (rfq.order_id) {
    [{ data: order }, { data: rows }] = await Promise.all([
      admin.from('orders').select('id, order_no').eq('id', rfq.order_id).single(),
      admin.from('packing_lists').select('*').eq('order_id', rfq.order_id).order('position').order('carton_no'),
    ]);
  } else { order = { order_no: fr.ref }; rows = fr.cargo || []; }   // a draft packing list sent from an RFQ keeps its own lines
  const tt = packTotals(rows || []);
  if (!rfq.order_id) { tt.pkgSummary = pkgSummary(rows || []); tt.qtySummary = qtySummary(rows || []); }
  const buf = rfq.order_id ? rfqWorkbook({ order, info: fr.info || {}, rows: rows || [], t: tt, ref: fr.ref, token: rfq.token })
    : draftRfqWorkbook({ order, info: fr.info || {}, rows: rows || [], t: tt, ref: fr.ref, token: rfq.token });
  res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${fr.ref}-quotation-packing-list-${order.order_no}.xlsx"` });
  res.send(buf);
});

// book an accepted quote: create the shipment (shipping order) and email the forwarder the booking confirmation
const shipMode = m => (/fcl/i.test(m || '') ? 'sea_fcl' : /air/i.test(m || '') ? 'air' : /express/i.test(m || '') ? 'express' : /rail/i.test(m || '') ? 'rail' : /truck|auto|road|lorry/i.test(m || '') ? 'truck' : 'sea_lcl');
const dayOnly = v => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
r.post('/quotes/:id/rfq/:rid/book', async (req, res) => {
  const to = `/admin/logistics/quotes/${req.params.id}`;
  const { data: rfq } = await admin.from('freight_rfqs').select('*, forwarders(id, name, contact_name, email)').eq('id', req.params.rid).eq('request_id', req.params.id).maybeSingle();
  if (!rfq) return notFound(res, 'Quote request');
  if (rfq.status !== 'accepted' || rfq.quote_amount == null) return back(res, to, { err: 'Only an accepted quotation can be booked. Set its status to Accepted first.' });
  if (!rfq.order_id) return back(res, to, { err: 'This quote was requested from a draft packing list, so there is no order to ship yet. Create the order first.' });
  const [{ data: fr }, { data: order }, { data: rows }, { data: resp }] = await Promise.all([
    admin.from('freight_requests').select('*').eq('id', rfq.request_id).single(),
    admin.from('orders').select('id, order_no, currency').eq('id', rfq.order_id).single(),
    admin.from('packing_lists').select('*').eq('order_id', rfq.order_id).order('position').order('carton_no'),
    admin.from('freight_responses').select('extracted').eq('rfq_id', rfq.id).order('received_at', { ascending: false }),
  ]);
  const info = fr?.info || {}, t = packTotals(rows || []);
  const q = (resp || []).map(x => x.extracted || {}).find(e => e.is_quote) || {};
  const etd = dayOnly(req.body.etd), eta = dayOnly(req.body.eta);

  // 1. the shipment (created once; booking again only updates its dates and re-sends the email)
  let shipmentId = rfq.shipment_id;
  if (shipmentId) {
    await admin.from('shipments').update({ etd, eta }).eq('id', shipmentId);
  } else {
    const { data: sh, error } = await admin.from('shipments').insert({
      order_id: rfq.order_id, forwarder_id: rfq.forwarder_id, mode: shipMode(q.mode || info.mode), incoterm: info.incoterm || 'FOB',
      origin_port: info.pol || null, destination_port: info.pod || null, etd, eta, status: 'booked',
      gross_weight_kg: t.gross || null, volume_cbm: t.cbm || null, cartons: t.cartons || null,
      notes: `From quote ${fr?.ref}: ${rfq.quote_notes || ''}`.trim(),
    }).select('id').single();
    if (error) return back(res, to, { err: error.message });
    shipmentId = sh.id;
    await admin.from('freight_rfqs').update({ shipment_id: shipmentId }).eq('id', rfq.id); // link first, so a retry never creates a second shipment
    const settings = await getSettings(admin);
    await admin.from('freight_costs').insert({ shipment_id: shipmentId, type: 'main_freight', description: `Quote ${fr?.ref}${rfq.forwarders?.name ? ' · ' + rfq.forwarders.name : ''}`, amount: rfq.quote_amount, currency: rfq.quote_currency || 'USD', fx_to_order: fxRate(settings, rfq.quote_currency || 'USD', order?.currency || 'USD') });
    await log({ entityType: 'order', entityId: rfq.order_id, action: 'shipment_created', actorId: req.user.id, clientVisible: true, detail: { mode: shipMode(q.mode || info.mode) } });
  }
  await log({ entityType: 'order', entityId: rfq.order_id, action: 'freight_quote_booked', actorId: req.user.id, detail: { note: `${fr?.ref} · ${rfq.forwarders?.name || rfq.sent_to}: ${rfq.quote_notes || ''}` } });

  // 2. booking email: asks for loading port, direct or not, latest date of receiving the goods
  let sentMsg = '';
  if (rfq.channel === 'email' && /@/.test(rfq.sent_to || '')) {
    try {
      const m = bookingEmail({ order, info, t, ref: fr?.ref, quoteSummary: rfq.quote_notes, amount: fmt.money(rfq.quote_amount, rfq.quote_currency || 'USD'), etd, eta, forwarderName: rfq.forwarders?.contact_name || rfq.forwarders?.name });
      await sendEmail({ to: rfq.sent_to, ...m, subject: `${m.subject} ${subjectTag(fr.ref, rfq.token)}`, replyTo: replyAddress(rfq.token, req.user.email) });
      await admin.from('freight_rfqs').update({ booking_sent_at: new Date().toISOString() }).eq('id', rfq.id);
      sentMsg = ` Booking email sent to ${rfq.sent_to}.`;
    } catch (e) { return res.redirect(`/admin/logistics/shipments/${shipmentId}?err=` + encodeURIComponent(`Shipment created, but the booking email failed: ${e.message}. Press Book again on ${to} to retry.`)); }
  } else {
    await admin.from('freight_rfqs').update({ booking_sent_at: new Date().toISOString() }).eq('id', rfq.id);
    sentMsg = ' No email address — send the booking text by WeChat (it is on the quote request page).';
  }
  res.redirect(`/admin/logistics/shipments/${shipmentId}?msg=` + encodeURIComponent(`Booked — shipment created.${sentMsg}`));
});

r.post('/quotes/:id/rfq/:rid/status', async (req, res) => {
  const status = ['sent', 'quoted', 'declined', 'accepted'].includes(req.body.status) ? req.body.status : null;
  if (status) await admin.from('freight_rfqs').update({ status }).eq('id', req.params.rid).eq('request_id', req.params.id);
  back(res, `/admin/logistics/quotes/${req.params.id}`, { msg: 'Status updated.' });
});

// ---- forwarders ----
r.post('/forwarders', async (req, res) => {
  const b = clean(req.body, ['name', 'contact_name', 'email', 'phone', 'wechat', 'notes']);
  b.modes = [].concat(req.body.modes || []).filter(m => SHIPMENT_MODES.includes(m));
  const { error } = await admin.from('forwarders').insert(b);
  back(res, '/admin/logistics#forwarders', error ? { err: error.message } : { msg: 'Forwarder added.' });
});
r.post('/forwarders/:id', async (req, res) => {
  const b = clean(req.body, ['name', 'contact_name', 'email', 'phone', 'wechat', 'notes']);
  b.modes = [].concat(req.body.modes || []).filter(m => SHIPMENT_MODES.includes(m));
  await admin.from('forwarders').update(b).eq('id', req.params.id);
  back(res, '/admin/logistics#forwarders', { msg: 'Forwarder saved.' });
});

// ---- shipments ----
async function shipForm(res, { s, error = null, title }) {
  const [{ data: orders }, { data: forwarders }] = await Promise.all([
    admin.from('orders').select('id, order_no, status, organizations(name), shipments(partial)').order('created_at', { ascending: false }).limit(300),
    admin.from('forwarders').select('id, name').order('name'),
  ]);
  res.render('admin/logistics/shipment_form', {
    title, s, error, orders: (orders || []).filter(o => o.id === s.order_id || shippable(o, o.shipments)).map(o => ({ ...o, part: (o.shipments || []).length })), forwarders: forwarders || [],
    modes: SHIPMENT_MODES, statuses: SHIPMENT_STATUSES, incoterms: INCOTERMS,
  });
}

r.get('/shipments/new', async (req, res) => {
  const s = { order_id: req.query.order_id, mode: 'sea_lcl', incoterm: 'FOB', status: 'planned', export_official: true };
  if (req.query.order_id) {
    // pre-fill cargo totals from the packing list
    const { data: pk } = await admin.from('packing_lists').select('*').eq('order_id', req.query.order_id);
    if (pk?.length) {
      const c = p => Number(p.cartons || 1); // a line can cover several identical cartons
      s.cartons = pk.reduce((t, p) => t + c(p), 0);
      s.gross_weight_kg = Math.round(pk.reduce((t, p) => t + Number(p.gross_weight_kg || 0) * c(p), 0) * 1000) / 1000;
      s.volume_cbm = Math.round(pk.reduce((t, p) => t + Number(p.cbm || 0) * c(p), 0) * 10000) / 10000;
    }
  }
  await shipForm(res, { s, title: 'New shipment' });
});
async function orderOk(orderId, currentId) {
  if (!orderId || orderId === currentId) return true;
  const { data: o } = await admin.from('orders').select('status, shipments(partial)').eq('id', orderId).maybeSingle();
  return !!o && shippable(o, o.shipments);
}
r.post('/shipments', async (req, res) => {
  if (!(await orderOk(req.body.order_id))) return shipForm(res, { s: req.body, error: 'That order has already shipped (or is closed/cancelled). Tick "Partial shipment" on its earlier shipment if more goods are still to go.', title: 'New shipment' });
  const { data, error } = await admin.from('shipments').insert(shipBody(req.body)).select('id, order_id').single();
  if (error) return shipForm(res, { s: req.body, error: error.message, title: 'New shipment' });
  await log({ entityType: 'order', entityId: data.order_id, action: 'shipment_created', actorId: req.user.id, clientVisible: true, detail: { mode: req.body.mode } });
  res.redirect(`/admin/logistics/shipments/${data.id}`);
});

r.get('/shipments/:id', async (req, res) => {
  const id = req.params.id;
  const [{ data: s }, { data: costs }, { data: docs }, settings] = await Promise.all([
    admin.from('shipments').select('*, forwarders(*), orders(*, organizations(name))').eq('id', id).single(),
    admin.from('freight_costs').select('*').eq('shipment_id', id).order('created_at'),
    admin.from('documents').select('*').eq('entity_type', 'shipment').eq('entity_id', id).order('created_at', { ascending: false }),
    getSettings(admin),
  ]);
  if (!s) return notFound(res, 'Shipment');
  const { data: items } = await admin.from('order_items').select('*').eq('order_id', s.order_id);
  const { data: order } = await admin.from('orders').select('*').eq('id', s.order_id).single();
  // e-mail history of the documents + who the client is (for the "send" dialog)
  const docIds = (docs || []).map(d => d.id);
  const { data: sendRows } = docIds.length ? await admin.from('document_sends').select('*').in('document_id', docIds).order('sent_at', { ascending: false }) : { data: [] };
  const sends = {}; (sendRows || []).forEach(x => (sends[x.document_id] ||= []).push(x));
  const [{ data: people }, { data: pis }] = await Promise.all([
    order?.org_id ? admin.from('profiles').select('email, full_name').eq('org_id', order.org_id).eq('role', 'client') : { data: [] },
    admin.from('proforma_invoices').select('data').eq('order_id', s.order_id).order('created_at', { ascending: false }).limit(1),
  ]);
  const clientEmails = []; const seen = new Set();
  const addEmail = (email, label) => { const e = String(email || '').trim().toLowerCase(); if (e && !seen.has(e)) { seen.add(e); clientEmails.push({ email: e, label }); } };
  (people || []).forEach(p => addEmail(p.email, p.full_name));
  addEmail(pis?.[0]?.data?.buyer?.email, pis?.[0]?.data?.buyer?.contact);
  const totalCost = (costs || []).reduce((t, c) => t + Number(c.amount) * Number(c.fx_to_order || 1), 0);
  const byType = {};
  (costs || []).forEach(c => { byType[c.type] = (byType[c.type] || 0) + Number(c.amount) * Number(c.fx_to_order || 1); });
  res.render('admin/logistics/shipment', {
    title: `Shipment · ${s.orders?.order_no}`, s, costs: costs || [], docs: docs || [], sends, clientEmails, totalCost, byType,
    land: landed(order || {}, items || []), order: order || {},
    cash: cashProfit({ received: await confirmedReceived(s.order_id, order?.currency), cost: order?.cost_total, freight: order?.freight_total, due: order?.amount_due }),
    freightTypes: FREIGHT_TYPES, statuses: SHIPMENT_STATUSES, currencies: CURRENCIES,
    defaultFx: c => fxRate(settings, c, s.orders?.currency || 'USD'),
    fxTable: settings.fx, msg: req.query.msg, err: req.query.err,
  });
});

// ---- shipping documents generated from the order's data (commercial invoice, packing list) ----
// a shipment keeps one number per document type: its first version allocates the next sequential one, later versions are (002), (003)…
async function docNumber(shipmentId, kind, label, prefix, fallback) {
  const { data: docs } = await admin.from('documents').select('title').eq('entity_type', 'shipment').eq('entity_id', shipmentId).eq('kind', kind);
  const re = new RegExp(`^${label} (${prefix}-\\d{4}-\\d{4}) \\(\\d{3}\\)$`);
  for (const d of docs || []) { const m = d.title.match(re); if (m) return m[1]; }
  const { data, error } = await admin.rpc('next_doc_no', { p: prefix });
  if (error || !data) { console.error(`[numbering] ${error?.message || 'no number'} — run supabase/migrations/0027_sequential_numbers.sql`); return fallback; }
  return data;
}

async function storeGenerated(req, shipmentId, { kind, title, filename, build, orderId }) {
  // every new version gets the next serial number: "<title> (001)", "(002)", …  (earlier versions are kept)
  const { data: same } = await admin.from('documents').select('title').eq('entity_type', 'shipment').eq('entity_id', shipmentId).eq('kind', kind).like('title', `${title} (%)`);
  const serial = String(Math.max(0, ...(same || []).map(d => Number((d.title.match(/\((\d{3})\)$/) || [])[1] || 0))) + 1).padStart(3, '0');
  const pdf = build();
  await uploadDocument({ file: { originalname: `${filename}-${serial}.pdf`, mimetype: 'application/pdf', buffer: pdf, size: pdf.length }, entityType: 'shipment', entityId: shipmentId, kind, title: `${title} (${serial})`, clientVisible: true, uploadedBy: req.user.id });
  await log({ entityType: 'order', entityId: orderId, action: 'documents_uploaded', actorId: req.user.id, clientVisible: false, detail: { kind, count: 1, note: `${title} (${serial}) created` } });
  return serial;
}

r.post('/shipments/:id/docs/commercial-invoice', async (req, res) => {
  const to = `/admin/logistics/shipments/${req.params.id}`;
  const { data: s } = await admin.from('shipments').select('id, order_id, mode').eq('id', req.params.id).maybeSingle();
  if (!s) return notFound(res, 'Shipment');
  const [{ data: pis }, { data: order }, { info }] = await Promise.all([
    admin.from('proforma_invoices').select('*').eq('order_id', s.order_id).order('created_at', { ascending: false }),
    admin.from('orders').select('id, order_no').eq('id', s.order_id).single(),
    packingData(s.order_id),
  ]);
  const pi = (pis || []).find(x => x.status === 'sent') || (pis || [])[0];
  if (!pi) return back(res, to, { err: 'This order has no proforma invoice yet — create one first, the commercial invoice is built from it.' });
  try {
    const company = await getCompany(admin);
    var no = await docNumber(s.id, 'commercial_invoice', 'Commercial invoice', 'CI', ciNo(pi));
    var serial = await storeGenerated(req, s.id, { kind: 'commercial_invoice', title: `Commercial invoice ${no}`, filename: no, build: () => ciPdf(pi, order, company, { shipment: s, info, no }), orderId: s.order_id });
  } catch (e) { return back(res, to, { err: `Could not create the commercial invoice: ${e.message}` }); }
  back(res, to, { msg: `Commercial invoice ${no} (${serial}) created from ${pi.pi_no}.` });
});

r.post('/shipments/:id/docs/packing-list', async (req, res) => {
  const to = `/admin/logistics/shipments/${req.params.id}`;
  const { data: s } = await admin.from('shipments').select('id, order_id').eq('id', req.params.id).maybeSingle();
  if (!s) return notFound(res, 'Shipment');
  const { order, rows, t, info } = await packingData(s.order_id);
  if (!order) return notFound(res, 'Order');
  if (!rows.length) return back(res, to, { err: 'The order has no packing lines yet — add them on the packing list page first.' });
  try {
    const company = await getCompany(admin);
    var no = await docNumber(s.id, 'packing_list', 'Packing list', 'PL', order.order_no);
    var serial = await storeGenerated(req, s.id, { kind: 'packing_list', title: `Packing list ${no}`, filename: `packing-list-${no}`, build: () => packingListPdf({ company, order, info, rows, t, no }), orderId: s.order_id });
  } catch (e) { return back(res, to, { err: `Could not create the packing list: ${e.message}` }); }
  back(res, to, { msg: `Packing list ${no} (${serial}) created from the current packing lines.` });
});

r.get('/shipments/:id/edit', async (req, res) => {
  const { data: s } = await admin.from('shipments').select('*').eq('id', req.params.id).single();
  if (!s) return notFound(res, 'Shipment');
  await shipForm(res, { s, title: 'Edit shipment' });
});
r.post('/shipments/:id', async (req, res) => {
  const id = req.params.id;
  const { data: before } = await admin.from('shipments').select('status, order_id, export_declaration_no').eq('id', id).single();
  if (!before) return notFound(res, 'Shipment');
  const b = shipBody(req.body);
  if (!b.order_id) delete b.order_id;
  if (!(await orderOk(b.order_id, before.order_id))) return shipForm(res, { s: { ...req.body, id }, error: 'That order has already shipped (or is closed/cancelled), so it can’t be selected.', title: 'Edit shipment' });
  const { error } = await admin.from('shipments').update(b).eq('id', id);
  if (error) return shipForm(res, { s: { ...req.body, id }, error: error.message, title: 'Edit shipment' });
  if (b.order_id && b.order_id !== before.order_id) {
    // moved to another order: re-total freight on both
    for (const oid of [before.order_id, b.order_id]) {
      const { data: cs } = await admin.from('freight_costs').select('amount, fx_to_order, shipments!inner(order_id)').eq('shipments.order_id', oid);
      const total = (cs || []).reduce((t, c) => t + Number(c.amount) * Number(c.fx_to_order || 1), 0);
      await admin.from('orders').update({ freight_total: total }).eq('id', oid);
    }
    await log({ entityType: 'order', entityId: b.order_id, action: 'shipment_linked', actorId: req.user.id, clientVisible: true, detail: { shipment_id: id } });
    before.order_id = b.order_id;
  }
  if (b.status && b.status !== before.status) {
    await log({ entityType: 'order', entityId: before.order_id, action: `shipment_${b.status}`, actorId: req.user.id, clientVisible: true, detail: { shipment_id: id } });
    // keep order status roughly in sync with the shipment
    const map = { departed: 'shipped', arrived: 'in_transit', customs: 'customs', delivered: 'delivered' };
    if (map[b.status] && !b.partial) await admin.from('orders').update({ status: map[b.status] }).eq('id', before.order_id).not('status', 'in', '("closed","cancelled")');
  }
  if (b.export_declaration_no && b.export_declaration_no !== before.export_declaration_no) {
    await log({ entityType: 'order', entityId: before.order_id, action: 'export_declared', actorId: req.user.id, clientVisible: true, detail: { note: b.export_declaration_no } });
  }
  res.redirect(`/admin/logistics/shipments/${id}`);
});

// delete a shipment (e.g. created by mistake); its costs go with it
r.post('/shipments/:id/delete', async (req, res) => {
  const { data: s } = await admin.from('shipments').select('order_id').eq('id', req.params.id).maybeSingle();
  if (!s) return notFound(res, 'Shipment');
  const { error } = await admin.from('shipments').delete().eq('id', req.params.id);
  if (error) return back(res, `/admin/logistics/shipments/${req.params.id}`, { err: error.message });
  const { data: cs } = await admin.from('freight_costs').select('amount, fx_to_order, shipments!inner(order_id)').eq('shipments.order_id', s.order_id);
  await admin.from('orders').update({ freight_total: (cs || []).reduce((t, c) => t + Number(c.amount) * Number(c.fx_to_order || 1), 0) }).eq('id', s.order_id);
  await log({ entityType: 'order', entityId: s.order_id, action: 'shipment_deleted', actorId: req.user.id });
  res.redirect('/admin/logistics?msg=' + encodeURIComponent('Shipment deleted.'));
});

// quick status change from the list
r.post('/shipments/:id/status', async (req, res) => {
  const to = req.body.status;
  if (!SHIPMENT_STATUSES.includes(to)) return back(res, '/admin/logistics');
  const { data: s } = await admin.from('shipments').select('order_id, status').eq('id', req.params.id).single();
  if (s && s.status !== to) {
    const patch = { status: to };
    const today = new Date().toISOString().slice(0, 10);
    if (to === 'departed') patch.atd = today;
    if (to === 'arrived') patch.ata = today;
    await admin.from('shipments').update(patch).eq('id', req.params.id);
    await log({ entityType: 'order', entityId: s.order_id, action: `shipment_${to}`, actorId: req.user.id, clientVisible: true, detail: { shipment_id: req.params.id } });
  }
  back(res, req.body.redirect?.startsWith('/admin') ? req.body.redirect : '/admin/logistics');
});

// ---- freight costs ----
r.post('/shipments/:id/costs', async (req, res) => {
  const b = clean(req.body, ['type', 'description', 'amount', 'currency', 'fx_to_order', 'invoice_ref', 'paid_at']);
  b.paid = bool(req.body.paid);
  b.shipment_id = req.params.id;
  if (!FREIGHT_TYPES.includes(b.type)) b.type = 'other';
  const { error } = await admin.from('freight_costs').insert(b);
  back(res, `/admin/logistics/shipments/${req.params.id}#costs`, error ? { err: error.message } : { msg: 'Cost added.' });
});
// edit a cost line (typo, revised forwarder invoice, currency / FX, paid state); every change is written to the order's history
r.post('/costs/:cid/edit', async (req, res) => {
  const { data: c } = await admin.from('freight_costs').select('*, shipments(order_id)').eq('id', req.params.cid).single();
  if (!c) return notFound(res, 'Cost');
  const to = `/admin/logistics/shipments/${c.shipment_id}#costs`;
  const amount = Number(String(req.body.amount ?? '').replace(',', '.'));
  const fx = Number(String(req.body.fx_to_order ?? '1').replace(',', '.')) || 1;
  if (!Number.isFinite(amount) || amount < 0 || fx <= 0) return back(res, to, { err: 'Enter a valid amount and exchange rate.' });
  const today = new Date().toISOString().slice(0, 10);
  const paid = bool(req.body.paid);
  const patch = {
    type: FREIGHT_TYPES.includes(req.body.type) ? req.body.type : c.type,
    description: String(req.body.description || '').trim().slice(0, 300) || null,
    invoice_ref: String(req.body.invoice_ref || '').trim().slice(0, 100) || null,
    amount, currency: CURRENCIES.includes(req.body.currency) ? req.body.currency : c.currency, fx_to_order: fx,
    paid, paid_at: paid ? (/^\d{4}-\d{2}-\d{2}$/.test(req.body.paid_at || '') ? req.body.paid_at : c.paid_at || today) : null,
  };
  const { error } = await admin.from('freight_costs').update(patch).eq('id', c.id); // the database trigger refreshes the order's freight total
  if (error) return back(res, to, { err: error.message });
  const changes = [];
  if (Number(c.amount) !== amount || c.currency !== patch.currency) changes.push(`amount ${c.currency} ${Number(c.amount)} → ${patch.currency} ${amount}`);
  if (Number(c.fx_to_order) !== fx) changes.push(`FX ${Number(c.fx_to_order)} → ${fx}`);
  if (c.type !== patch.type) changes.push(`type ${c.type} → ${patch.type}`);
  if ((c.invoice_ref || null) !== patch.invoice_ref) changes.push(`invoice ref ${c.invoice_ref || '—'} → ${patch.invoice_ref || '—'}`);
  if ((c.description || null) !== patch.description) changes.push('description changed');
  if (!!c.paid !== paid) changes.push(paid ? 'marked paid' : 'marked unpaid');
  if (c.shipments?.order_id && changes.length) await log({ entityType: 'order', entityId: c.shipments.order_id, action: 'freight_cost_edited', actorId: req.user.id, clientVisible: false, detail: { note: `${fmt.status(c.type)}: ${changes.join('; ')}` } });
  back(res, to, { msg: changes.length ? 'Cost updated.' : 'No changes.' });
});
r.post('/costs/:cid/paid', async (req, res) => {
  const { data: c } = await admin.from('freight_costs').select('shipment_id, paid').eq('id', req.params.cid).single();
  if (!c) return notFound(res, 'Cost');
  await admin.from('freight_costs').update({ paid: !c.paid, paid_at: c.paid ? null : new Date().toISOString().slice(0, 10) }).eq('id', req.params.cid);
  back(res, `/admin/logistics/shipments/${c.shipment_id}#costs`);
});
r.post('/costs/:cid/delete', async (req, res) => {
  const { data: c } = await admin.from('freight_costs').select('shipment_id').eq('id', req.params.cid).single();
  if (!c) return notFound(res, 'Cost');
  await admin.from('freight_costs').delete().eq('id', req.params.cid);
  back(res, `/admin/logistics/shipments/${c.shipment_id}#costs`, { msg: 'Cost removed.' });
});

export default r;
