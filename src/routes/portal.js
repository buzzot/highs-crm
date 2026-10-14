import { Router } from '../lib/router.js';
import multer from 'multer';
import { requireClient } from '../middleware/auth.js';
import { admin } from '../lib/supabase.js';
import { log } from '../lib/activity.js';
import { uploadDocument, signedUrl } from '../lib/storage.js';
import { parseItems, validateItems, requestTitle, splitFiles, UNITS } from '../lib/request-items.js';
const CURRENCY_OK = ['USD', 'EUR', 'GBP', 'CNY'];
import { validateCompany, COMPANY_FIELDS } from '../lib/company.js';

const r = Router();
// Explicit column lists: clients have column-level grants only (see migration 0002).
const REQ = 'id, ref, title, description, quantity, target_unit_price, target_currency, destination_country, destination_city, needed_by, status, created_at, updated_at';
const QUOTE = 'id, request_id, request_item_id, quantity, sell_currency, unit_price, freight_estimate, duties_estimate, other_costs, landed_unit_price, incoterm, lead_time_days, valid_until, status, notes, created_at';
const ORDER = 'id, order_no, request_id, status, currency, subtotal, client_notes, expected_ship_date, created_at, updated_at';
const ITEM = 'id, description, quantity, unit_price, hs_code';
const SHIP = 'id, order_id, mode, incoterm, origin_port, destination_port, container_no, tracking_no, bl_no, export_declaration_no, export_official, etd, eta, atd, ata, status, gross_weight_kg, volume_cbm, cartons, created_at';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 40 } });
r.use(requireClient);

// Everything here uses req.db (the user's token) so Supabase RLS enforces org scoping.

// ---- company details (required on the company's first sign-in) ----
r.get('/company', async (req, res) => {
  const { data: org } = await admin.from('organizations').select('*, completer:profiles!organizations_details_completed_by_fkey(full_name, email)').eq('id', req.user.org_id).single();
  res.render('portal/company', { title: 'Company details', org: org || {}, form: org || {}, errors: {}, first: !org?.details_completed_at, saved: req.query.saved });
});
r.post('/company', async (req, res) => {
  const { data: org } = await admin.from('organizations').select('*').eq('id', req.user.org_id).single();
  const { data, errors } = validateCompany(req.body);
  if (Object.keys(errors).length) {
    return res.status(400).render('portal/company', { title: 'Company details', org, form: { ...org, ...data }, errors, first: !org?.details_completed_at, saved: false });
  }
  const first = !org.details_completed_at;
  const patch = Object.fromEntries(COMPANY_FIELDS.map(k => [k, data[k]]));
  if (first) Object.assign(patch, { details_completed_at: new Date().toISOString(), details_completed_by: req.user.id });
  const { error } = await admin.from('organizations').update(patch).eq('id', req.user.org_id);
  if (error) return res.status(400).render('portal/company', { title: 'Company details', org, form: { ...org, ...data }, errors: { _: error.message }, first, saved: false });
  await log({ entityType: 'organization', entityId: req.user.org_id, action: first ? 'company_details_completed' : 'company_details_updated', actorId: req.user.id, detail: { note: data.name } });
  res.redirect(first ? '/portal?msg=' + encodeURIComponent('Thanks — your company details are saved. Welcome to Lumi Trade!') : '/portal/company?saved=1');
});

r.get('/', async (req, res) => {
  const [{ data: requests }, { data: orders }] = await Promise.all([
    req.db.from('requests').select(REQ).order('created_at', { ascending: false }).limit(10),
    req.db.from('orders').select(`${ORDER}, shipments(eta, status)`).order('created_at', { ascending: false }).limit(10),
  ]);
  const open = (orders || []).filter(o => !['delivered', 'closed', 'cancelled'].includes(o.status));
  // counts over everything, not just the 10 most recent
  const [{ data: allReq }, { data: allOrd }] = await Promise.all([
    req.db.from('requests').select('status'), req.db.from('orders').select('status'),
  ]);
  const kpi = {
    openRequests: (allReq || []).filter(x => ['new', 'reviewing'].includes(x.status)).length,
    quotesWaiting: (allReq || []).filter(x => x.status === 'quoted').length,
    inProgress: (allOrd || []).filter(x => ['confirmed', 'deposit_paid', 'in_production', 'qc', 'packed'].includes(x.status)).length,
    onTheWay: (allOrd || []).filter(x => ['shipped', 'in_transit', 'customs'].includes(x.status)).length,
  };
  res.render('portal/dashboard', { title: 'Overview', requests: requests || [], orders: orders || [], openCount: open.length, kpi });
});

// ---- requests ----
r.get('/requests', async (req, res) => {
  const { data } = await req.db.from('requests').select(REQ).order('created_at', { ascending: false });
  const all = data || [];
  const groups = {
    all: () => true,
    open: x => ['new', 'reviewing'].includes(x.status),
    quoted: x => x.status === 'quoted',
    accepted: x => x.status === 'accepted',
    closed: x => ['declined', 'cancelled'].includes(x.status),
  };
  const tab = groups[req.query.tab] ? req.query.tab : 'all';
  const q = String(req.query.q || '').trim().toLowerCase();
  const list = all.filter(groups[tab]).filter(x => !q || `${x.ref} ${x.title}`.toLowerCase().includes(q));
  const counts = Object.fromEntries(Object.entries(groups).map(([k, f]) => [k, all.filter(f).length]));
  res.render('portal/requests', { title: 'My requests', requests: list, counts, tab, q });
});

const newForm = (res, extra = {}) => res.render('portal/request_form', { title: 'New request', error: null, form: {}, items: [{}], units: UNITS, ...extra });
r.get('/requests/new', (req, res) => newForm(res));

r.post('/requests', upload.any(), async (req, res) => {
  const f = req.body;
  const items = parseItems(f);
  const bad = validateItems(items);
  const again = error => newForm(res.status(400), { error, form: f, items: items.length ? items : [{}] });
  if (bad) return again(bad);
  if ((req.files || []).length > 40) return again('Too many files — up to 40 per request.');
  const single = items.length === 1 ? items[0] : null;
  const { data, error } = await req.db.from('requests').insert({
    org_id: req.user.org_id, created_by: req.user.id,
    title: requestTitle(f.title, items), description: String(f.description || '').trim() || null,
    quantity: single?.quantity ?? null, target_unit_price: single?.target_unit_price ?? null,
    target_currency: CURRENCY_OK.includes(f.target_currency) ? f.target_currency : 'USD',
    destination_country: f.destination_country, destination_city: f.destination_city, needed_by: f.needed_by || null,
  }).select('id').single();
  if (error) return again(error.message);

  const { data: saved, error: iErr } = await admin.from('request_items')
    .insert(items.map((it, i) => ({ request_id: data.id, position: i, name: it.name, description: it.description, quantity: it.quantity, unit: it.unit, target_unit_price: it.target_unit_price })))
    .select('id, position');
  if (iErr) console.error(`[request] ${data.id}: products not saved: ${iErr.message}`);
  const idByKey = {};
  (saved || []).forEach(row => { idByKey[items[row.position].key] = row.id; });

  const { general, byKey } = splitFiles(req.files);
  const uploads = [...general.map(file => ({ file, itemId: null })),
    ...Object.entries(byKey).flatMap(([k, fs]) => fs.map(file => ({ file, itemId: idByKey[k] || null })))];
  for (const { file, itemId } of uploads) {
    const kind = file.mimetype?.startsWith('image/') ? 'product_photo' : 'other';
    try {
      const doc = await uploadDocument({ file, entityType: 'request', entityId: data.id, kind, uploadedBy: req.user.id });
      if (itemId) await admin.from('documents').update({ request_item_id: itemId }).eq('id', doc.id);
    } catch (e) { console.error(`[request] ${data.id}: upload ${file.originalname} failed: ${e.message}`); }
  }
  await log({ entityType: 'request', entityId: data.id, action: 'created', actorId: req.user.id, clientVisible: true, detail: { products: items.length } });
  res.redirect(`/portal/requests/${data.id}`);
});

r.get('/requests/:id', async (req, res) => {
  const { data: request } = await req.db.from('requests').select(REQ).eq('id', req.params.id).single();
  if (!request) return res.status(404).render('error', { title: 'Not found', message: 'Request not found.' });
  const [{ data: quotes }, { data: docs }, { data: events }, { data: items }] = await Promise.all([
    req.db.from('quotes').select(QUOTE).eq('request_id', request.id).order('created_at', { ascending: false }),
    req.db.from('documents').select('*').eq('entity_type', 'request').eq('entity_id', request.id).order('created_at'),
    req.db.from('activity_log').select('*').eq('entity_type', 'request').eq('entity_id', request.id).order('created_at', { ascending: false }),
    req.db.from('request_items').select('*').eq('request_id', request.id).order('position'),
  ]);
  res.render('portal/request_detail', { title: request.ref, request, quotes: quotes || [], docs: docs || [], events: events || [], items: items || [] });
});

// client accepts / rejects a sent quote
r.post('/quotes/:id/:decision(accept|reject)', async (req, res) => {
  const { data: quote } = await req.db.from('quotes').select('id, status, request_id').eq('id', req.params.id).single();
  if (!quote || quote.status !== 'sent') return res.status(400).render('error', { title: 'Not allowed', message: 'This quote cannot be changed.' });
  const accept = req.params.decision === 'accept';
  await admin.from('quotes').update({ status: accept ? 'accepted' : 'rejected' }).eq('id', quote.id);
  await admin.from('requests').update({ status: accept ? 'accepted' : 'quoted' }).eq('id', quote.request_id);
  await log({ entityType: 'request', entityId: quote.request_id, action: accept ? 'quote_accepted' : 'quote_rejected', actorId: req.user.id, clientVisible: true, detail: { quote_id: quote.id } });
  res.redirect(`/portal/requests/${quote.request_id}`);
});

// ---- orders ----
r.get('/orders', async (req, res) => {
  const { data } = await req.db.from('orders').select(`${ORDER}, shipments(eta, status, tracking_no)`).order('created_at', { ascending: false });
  const all = data || [];
  const groups = {
    all: () => true,
    production: x => ['confirmed', 'deposit_paid', 'in_production', 'qc', 'packed'].includes(x.status),
    shipping: x => ['shipped', 'in_transit', 'customs'].includes(x.status),
    delivered: x => ['delivered', 'closed'].includes(x.status),
  };
  const tab = groups[req.query.tab] ? req.query.tab : 'all';
  const q = String(req.query.q || '').trim().toLowerCase();
  const list = all.filter(groups[tab]).filter(x => !q || x.order_no.toLowerCase().includes(q));
  const counts = Object.fromEntries(Object.entries(groups).map(([k, f]) => [k, all.filter(f).length]));
  res.render('portal/orders', { title: 'My orders', orders: list, counts, tab, q });
});

r.get('/orders/:id', async (req, res) => {
  const { data: order } = await req.db.from('orders').select(`${ORDER}, order_items(${ITEM})`).eq('id', req.params.id).single();
  if (!order) return res.status(404).render('error', { title: 'Not found', message: 'Order not found.' });
  const [{ data: shipments }, { data: docs }, { data: events }, { data: packing }] = await Promise.all([
    req.db.from('shipments').select(SHIP).eq('order_id', order.id).order('created_at'),
    req.db.from('documents').select('*').in('entity_type', ['order', 'shipment']).order('created_at', { ascending: false }),
    req.db.from('activity_log').select('*').eq('entity_type', 'order').eq('entity_id', order.id).order('created_at', { ascending: false }),
    req.db.from('packing_lists').select('*').eq('order_id', order.id).order('carton_no'),
  ]);
  const shipIds = new Set((shipments || []).map(s => s.id));
  const documents = (docs || []).filter(d => (d.entity_type === 'order' && d.entity_id === order.id) || (d.entity_type === 'shipment' && shipIds.has(d.entity_id)));
  res.render('portal/order_detail', { title: order.order_no, order, shipments: shipments || [], documents, events: events || [], packing: packing || [] });
});

r.get('/documents/:id/download', async (req, res) => {
  const { data: doc } = await req.db.from('documents').select('*').eq('id', req.params.id).single(); // RLS-checked
  if (!doc) return res.status(404).send('Not found');
  res.redirect(await signedUrl(doc.storage_path));
});

export default r;
