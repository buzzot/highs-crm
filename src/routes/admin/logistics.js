import { Router } from '../../lib/router.js';
import { admin } from '../../lib/supabase.js';
import { log } from '../../lib/activity.js';
import { clean, bool, back, notFound, getSettings, fxRate, SHIPMENT_STATUSES, SHIPMENT_MODES, FREIGHT_TYPES, INCOTERMS, CURRENCIES } from '../../lib/util.js';
import { landed } from '../../lib/landed.js';
import { saveResponse } from '../../lib/freight-store.js';
import multer from 'multer';
import { rfqWorkbook } from '../../lib/quote-form.js';
import { totals as packTotals } from '../../lib/packing.js';

const quoteFiles = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 5 } }).array('files', 5);

const r = Router();
const SHIP_FIELDS = ['order_id', 'forwarder_id', 'mode', 'incoterm', 'origin_port', 'destination_port', 'container_no', 'tracking_no', 'bl_no',
  'export_declaration_no', 'etd', 'eta', 'atd', 'ata', 'status', 'gross_weight_kg', 'volume_cbm', 'cartons', 'notes'];
const shipBody = b => ({ ...clean(b, SHIP_FIELDS), export_official: bool(b.export_official) });
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
    unpaid: list.reduce((t, s) => t + s.unpaid, 0),
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
  res.render('admin/logistics/quote_request', {
    title: fr.ref, fr, rfqs: rfqs || [], responses: responses || [], bestId: best?.id || null,
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
  const { data: rfq } = await admin.from('freight_rfqs').select('*, freight_requests!freight_rfqs_request_id_fkey(ref, info)').eq('id', req.params.rid).eq('request_id', req.params.id).maybeSingle();
  if (!rfq) return notFound(res, 'Quote request');
  const [{ data: order }, { data: rows }] = await Promise.all([
    admin.from('orders').select('id, order_no').eq('id', rfq.order_id).single(),
    admin.from('packing_lists').select('*').eq('order_id', rfq.order_id).order('position').order('carton_no'),
  ]);
  const fr = rfq.freight_requests || {};
  const buf = rfqWorkbook({ order, info: fr.info || {}, rows: rows || [], t: packTotals(rows || []), ref: fr.ref, token: rfq.token });
  res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${fr.ref}-quotation-packing-list-${order.order_no}.xlsx"` });
  res.send(buf);
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
    admin.from('orders').select('id, order_no, organizations(name)').not('status', 'in', '("closed","cancelled")').order('created_at', { ascending: false }),
    admin.from('forwarders').select('id, name').order('name'),
  ]);
  res.render('admin/logistics/shipment_form', {
    title, s, error, orders: orders || [], forwarders: forwarders || [],
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
r.post('/shipments', async (req, res) => {
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
  const totalCost = (costs || []).reduce((t, c) => t + Number(c.amount) * Number(c.fx_to_order || 1), 0);
  const byType = {};
  (costs || []).forEach(c => { byType[c.type] = (byType[c.type] || 0) + Number(c.amount) * Number(c.fx_to_order || 1); });
  res.render('admin/logistics/shipment', {
    title: `Shipment · ${s.orders?.order_no}`, s, costs: costs || [], docs: docs || [], totalCost, byType,
    land: landed(order || {}, items || []), order: order || {},
    freightTypes: FREIGHT_TYPES, statuses: SHIPMENT_STATUSES, currencies: CURRENCIES,
    defaultFx: c => fxRate(settings, c, s.orders?.currency || 'USD'),
    fxTable: settings.fx, msg: req.query.msg, err: req.query.err,
  });
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
  delete b.order_id;
  const { error } = await admin.from('shipments').update(b).eq('id', id);
  if (error) return shipForm(res, { s: { ...req.body, id }, error: error.message, title: 'Edit shipment' });
  if (b.status && b.status !== before.status) {
    await log({ entityType: 'order', entityId: before.order_id, action: `shipment_${b.status}`, actorId: req.user.id, clientVisible: true, detail: { shipment_id: id } });
    // keep order status roughly in sync with the shipment
    const map = { departed: 'shipped', arrived: 'in_transit', customs: 'customs', delivered: 'delivered' };
    if (map[b.status]) await admin.from('orders').update({ status: map[b.status] }).eq('id', before.order_id).not('status', 'in', '("closed","cancelled")');
  }
  if (b.export_declaration_no && b.export_declaration_no !== before.export_declaration_no) {
    await log({ entityType: 'order', entityId: before.order_id, action: 'export_declared', actorId: req.user.id, clientVisible: true, detail: { note: b.export_declaration_no } });
  }
  res.redirect(`/admin/logistics/shipments/${id}`);
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
