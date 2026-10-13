import { Router } from '../lib/router.js';
import multer from 'multer';
import { requireClient } from '../middleware/auth.js';
import { admin } from '../lib/supabase.js';
import { log } from '../lib/activity.js';
import { uploadDocument, signedUrl } from '../lib/storage.js';
import { validateCompany, COMPANY_FIELDS } from '../lib/company.js';

const r = Router();
// Explicit column lists: clients have column-level grants only (see migration 0002).
const REQ = 'id, ref, title, description, quantity, target_unit_price, target_currency, destination_country, destination_city, needed_by, status, created_at, updated_at';
const QUOTE = 'id, request_id, quantity, sell_currency, unit_price, freight_estimate, duties_estimate, other_costs, landed_unit_price, incoterm, lead_time_days, valid_until, status, notes, created_at';
const ORDER = 'id, order_no, request_id, status, currency, subtotal, client_notes, expected_ship_date, created_at, updated_at';
const ITEM = 'id, description, quantity, unit_price, hs_code';
const SHIP = 'id, order_id, mode, incoterm, origin_port, destination_port, container_no, tracking_no, bl_no, export_declaration_no, export_official, etd, eta, atd, ata, status, gross_weight_kg, volume_cbm, cartons, created_at';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
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
  res.render('portal/dashboard', { title: 'Overview', requests: requests || [], orders: orders || [], openCount: open.length });
});

// ---- requests ----
r.get('/requests', async (req, res) => {
  const { data } = await req.db.from('requests').select(REQ).order('created_at', { ascending: false });
  res.render('portal/requests', { title: 'My requests', requests: data || [] });
});

r.get('/requests/new', (req, res) => res.render('portal/request_form', { title: 'New request', error: null, form: {} }));

r.post('/requests', upload.array('files', 10), async (req, res) => {
  const f = req.body;
  if (!f.title) return res.status(400).render('portal/request_form', { title: 'New request', error: 'Title is required.', form: f });
  const { data, error } = await req.db.from('requests').insert({
    org_id: req.user.org_id, created_by: req.user.id,
    title: f.title, description: f.description, quantity: f.quantity || null,
    target_unit_price: f.target_unit_price || null, target_currency: f.target_currency || 'USD',
    destination_country: f.destination_country, destination_city: f.destination_city, needed_by: f.needed_by || null,
  }).select('id').single();
  if (error) return res.status(400).render('portal/request_form', { title: 'New request', error: error.message, form: f });

  for (const file of req.files || []) {
    await uploadDocument({ file, entityType: 'request', entityId: data.id, kind: 'product_photo', uploadedBy: req.user.id });
  }
  await log({ entityType: 'request', entityId: data.id, action: 'created', actorId: req.user.id, clientVisible: true });
  res.redirect(`/portal/requests/${data.id}`);
});

r.get('/requests/:id', async (req, res) => {
  const { data: request } = await req.db.from('requests').select(REQ).eq('id', req.params.id).single();
  if (!request) return res.status(404).render('error', { title: 'Not found', message: 'Request not found.' });
  const [{ data: quotes }, { data: docs }, { data: events }] = await Promise.all([
    req.db.from('quotes').select(QUOTE).eq('request_id', request.id).order('created_at', { ascending: false }),
    req.db.from('documents').select('*').eq('entity_type', 'request').eq('entity_id', request.id),
    req.db.from('activity_log').select('*').eq('entity_type', 'request').eq('entity_id', request.id).order('created_at', { ascending: false }),
  ]);
  res.render('portal/request_detail', { title: request.ref, request, quotes: quotes || [], docs: docs || [], events: events || [] });
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
  res.render('portal/orders', { title: 'My orders', orders: data || [] });
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
