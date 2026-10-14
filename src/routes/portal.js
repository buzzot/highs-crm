import { Router } from '../lib/router.js';
import multer from 'multer';
import { requireClient } from '../middleware/auth.js';
import { admin } from '../lib/supabase.js';
import { log } from '../lib/activity.js';
import { aiEnabled, extractProductInfo } from '../lib/ai.js';
import { uploadDocument, signedUrl } from '../lib/storage.js';
import { parseItems, validateItems, requestTitle, splitFiles, UNITS } from '../lib/request-items.js';
import { EDITABLE, DELIVERY, snapshot, buildRevision, diff } from '../lib/request-revisions.js';
import { dropRevisionFiles, notifyStaffOfChange } from '../lib/request-changes.js';
const deliveryOf = v => (DELIVERY[v] ? v : null);
const headerFrom = (f, items) => ({
  title: requestTitle(f.title, items), description: String(f.description || '').trim() || null,
  destination_country: String(f.destination_country || '').trim() || null, destination_city: String(f.destination_city || '').trim() || null,
  needed_by: f.needed_by || null, delivery_mode: deliveryOf(f.delivery_mode), target_currency: CURRENCY_OK.includes(f.target_currency) ? f.target_currency : 'USD',
});
const CURRENCY_OK = ['USD', 'EUR', 'GBP', 'CNY'];
import { validateCompany, COMPANY_FIELDS } from '../lib/company.js';

const r = Router();
// Explicit column lists: clients have column-level grants only (see migration 0002).
const REQ = 'id, ref, title, description, quantity, target_unit_price, target_currency, destination_country, destination_city, needed_by, delivery_mode, status, created_at, updated_at';
const QUOTE = 'id, request_id, request_item_id, quantity, sell_currency, unit_price, freight_estimate, duties_estimate, other_costs, landed_unit_price, incoterm, lead_time_days, valid_until, status, notes, created_at';
const ORDER = 'id, order_no, request_id, status, currency, subtotal, client_notes, expected_ship_date, created_at, updated_at';
const ITEM = 'id, description, quantity, unit_price, hs_code';
const SHIP = 'id, order_id, mode, incoterm, origin_port, destination_port, container_no, tracking_no, bl_no, export_declaration_no, export_official, etd, eta, atd, ata, status, gross_weight_kg, volume_cbm, cartons, created_at';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 40 } });
r.use(requireClient);
r.use((req, res, next) => { res.locals.aiOn = aiEnabled(); next(); });

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

// optional: read a product's photo / PDF with AI and suggest name, SKU and details (nothing is saved here)
r.post('/requests/ai-fill', upload.array('files', 4), async (req, res) => {
  if (!aiEnabled()) return res.status(503).json({ error: 'AI fill is not switched on.' });
  const IMG = /^image\/(png|jpe?g|gif|webp)$/i;
  const files = (req.files || []).flatMap(f => (f.mimetype === 'application/pdf' || /\.pdf$/i.test(f.originalname) ? [{ pdf: f.buffer }] : IMG.test(f.mimetype) ? [{ data: f.buffer, mediaType: f.mimetype.replace('jpg', 'jpeg') }] : []));
  if (!files.length) return res.status(400).json({ error: 'Add a photo or a PDF of the product first.' });
  try {
    const out = await extractProductInfo({ files, name: String(req.body.name || '').slice(0, 300), description: String(req.body.description || '').slice(0, 3000) }, { type: 'organization', id: req.user.org_id });
    res.json({ name: out.name, sku: out.sku, description: out.description });
  } catch (e) { res.status(502).json({ error: `AI could not read the files: ${e.message}` }); }
});

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
    delivery_mode: deliveryOf(f.delivery_mode),
  }).select('id').single();
  if (error) return again(error.message);

  const { data: saved, error: iErr } = await admin.from('request_items')
    .insert(items.map((it, i) => ({ request_id: data.id, position: i, name: it.name, sku: it.sku, description: it.description, quantity: it.quantity, unit: it.unit, target_unit_price: it.target_unit_price })))
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
  const [{ data: quotes }, { data: docs }, { data: events }, { data: items }, { data: revs }] = await Promise.all([
    req.db.from('quotes').select(QUOTE).eq('request_id', request.id).order('created_at', { ascending: false }),
    req.db.from('documents').select('*').eq('entity_type', 'request').eq('entity_id', request.id).order('created_at'),
    req.db.from('activity_log').select('*').eq('entity_type', 'request').eq('entity_id', request.id).order('created_at', { ascending: false }),
    req.db.from('request_items').select('*').eq('request_id', request.id).order('position'),
    req.db.from('request_revisions').select('*').eq('request_id', request.id).order('created_at', { ascending: false }).limit(1),
  ]);
  const last = revs?.[0] || null;
  const pending = last?.status === 'pending' ? last : null;
  const pendingDiff = pending ? diff(snapshot(request, items || []), pending.data) : null;
  res.render('portal/request_detail', {
    title: request.ref, request, quotes: quotes || [], docs: (docs || []).filter(d => !d.revision_id), events: events || [], items: items || [],
    pending, pendingDiff, lastDecision: last && ['approved', 'rejected'].includes(last.status) ? last : null, canEdit: EDITABLE.includes(request.status),
  });
});

// ---- client edits a request; an admin approves the change ----
async function editState(req, id) {
  const { data: request } = await req.db.from('requests').select(`${REQ}, org_id`).eq('id', id).single();
  if (!request) return {};
  const [{ data: items }, { data: docs }, { data: pend }] = await Promise.all([
    req.db.from('request_items').select('*').eq('request_id', id).order('position'),
    req.db.from('documents').select('id, title, mime_type, request_item_id, revision_id').eq('entity_type', 'request').eq('entity_id', id).order('created_at'),
    req.db.from('request_revisions').select('*').eq('request_id', id).eq('status', 'pending').maybeSingle(),
  ]);
  return { request, items: items || [], docs: docs || [], pending: pend || null };
}

function editView(res, st, extra = {}) {
  const { request, items, docs, pending } = st;
  const base = pending ? pending.data : snapshot(request, items);
  const legacy = !items.length && !pending; // request made before multi-product support
  const formItems = legacy ? [{ name: request.title, description: request.description, quantity: request.quantity, unit: 'pcs', target_unit_price: request.target_unit_price }] : base.items;
  const removing = new Set(pending?.data.remove_doc_ids || []);
  const newDocItem = Object.fromEntries((pending?.data.new_docs || []).map(n => [n.doc, n.item]));
  const files = docs
    .filter(d => !d.revision_id || d.revision_id === pending?.id)
    .map(d => ({ id: d.id, title: d.title, mime_type: d.mime_type, pending: !!d.revision_id, removing: removing.has(d.id),
      item: d.revision_id ? (newDocItem[d.id] || null) : (d.request_item_id || null) }));
  res.render('portal/request_form', {
    title: `Edit ${request.ref}`, mode: 'edit', request, error: null, units: UNITS, files,
    form: { ...base, title: base.title, description: legacy ? null : base.description }, items: formItems, ...extra,
  });
}

r.get('/requests/:id/edit', async (req, res) => {
  const st = await editState(req, req.params.id);
  if (!st.request) return res.status(404).render('error', { title: 'Not found', message: 'Request not found.' });
  if (!EDITABLE.includes(st.request.status)) return res.redirect(`/portal/requests/${st.request.id}?err=` + encodeURIComponent('This request can no longer be changed. Send us a new request instead.'));
  editView(res, st);
});

r.post('/requests/:id/edit', upload.any(), async (req, res) => {
  const st = await editState(req, req.params.id);
  const { request, items: curItems, docs, pending } = st;
  if (!request) return res.status(404).render('error', { title: 'Not found', message: 'Request not found.' });
  if (!EDITABLE.includes(request.status)) return res.redirect(`/portal/requests/${request.id}`);
  const f = req.body;
  const parsed = parseItems(f);
  const bad = validateItems(parsed) || ((req.files || []).length > 40 ? 'Too many files — up to 40 per change.' : null);
  if (bad) return editView(res.status(400), st, { error: bad, form: { ...f }, items: parsed.length ? parsed : [{}] });

  const data = buildRevision(headerFrom(f, parsed), parsed, curItems.map(i => i.id));
  const refOfKey = Object.fromEntries(data.items.map(it => [it.key, it.id || it.tmp]));
  const liveRefs = new Set(data.items.map(it => it.id || it.tmp));
  const ticked = new Set([].concat(f.remove_docs || []).map(String));

  // files already approved that the client wants gone (applied on approval)
  data.remove_doc_ids = docs.filter(d => !d.revision_id && ticked.has(d.id)).map(d => d.id);
  // files from the earlier pending version: keep unless ticked or their product was removed
  const dropNow = [];
  for (const nd of pending?.data.new_docs || []) {
    if (ticked.has(nd.doc) || (nd.item && !liveRefs.has(nd.item))) dropNow.push(nd.doc); else data.new_docs.push(nd);
  }
  data.items.forEach(it => { delete it.key; });

  const uploads = (req.files || []).length;
  const d = diff(snapshot(request, curItems), { ...data, new_docs: [...data.new_docs, ...Array(uploads).fill({})] });
  if (d.empty) {
    if (pending) {
      await dropRevisionFiles(pending.id);
      await admin.from('request_revisions').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', pending.id);
      return res.redirect(`/portal/requests/${request.id}?msg=` + encodeURIComponent('Nothing differs from the current request, so the pending change was withdrawn.'));
    }
    return res.redirect(`/portal/requests/${request.id}?msg=` + encodeURIComponent('Nothing changed.'));
  }

  let revId = pending?.id;
  if (pending) {
    if (dropNow.length) await dropRevisionFiles(pending.id, dropNow);
    const { error } = await admin.from('request_revisions').update({ data, created_by: req.user.id, updated_at: new Date().toISOString() }).eq('id', pending.id);
    if (error) return editView(res.status(400), st, { error: error.message });
  } else {
    const { data: rev, error } = await admin.from('request_revisions').insert({ request_id: request.id, created_by: req.user.id, data }).select('id').single();
    if (error) return editView(res.status(400), st, { error: /request_revisions/.test(error.message) ? 'Editing is not switched on yet (database update 0010 missing).' : error.message });
    revId = rev.id;
  }

  // new uploads belong to the pending change until it is approved
  const { general, byKey } = splitFiles(req.files);
  const ups = [...general.map(file => ({ file, item: null })), ...Object.entries(byKey).flatMap(([k, fs]) => fs.map(file => ({ file, item: refOfKey[k] || null })))];
  for (const { file, item } of ups) {
    try {
      const doc = await uploadDocument({ file, entityType: 'request', entityId: request.id, kind: file.mimetype?.startsWith('image/') ? 'product_photo' : 'other', uploadedBy: req.user.id });
      await admin.from('documents').update({ revision_id: revId }).eq('id', doc.id);
      data.new_docs.push({ doc: doc.id, item });
    } catch (e) { console.error(`[revision] upload ${file.originalname}: ${e.message}`); }
  }
  if (ups.length) await admin.from('request_revisions').update({ data }).eq('id', revId);

  await log({ entityType: 'request', entityId: request.id, action: pending ? 'changes_updated' : 'changes_submitted', actorId: req.user.id, clientVisible: true });
  notifyStaffOfChange(request, req.user).catch(e => console.error(`[revision] notify: ${e.message}`));
  res.redirect(`/portal/requests/${request.id}?msg=` + encodeURIComponent('Changes sent for approval. We will update the offer once they are approved.'));
});

r.post('/requests/:id/edit/withdraw', async (req, res) => {
  const { data: pend } = await req.db.from('request_revisions').select('id, request_id').eq('request_id', req.params.id).eq('status', 'pending').maybeSingle();
  if (pend) {
    await dropRevisionFiles(pend.id);
    await admin.from('request_revisions').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', pend.id);
    await log({ entityType: 'request', entityId: pend.request_id, action: 'changes_withdrawn', actorId: req.user.id, clientVisible: true });
  }
  res.redirect(`/portal/requests/${req.params.id}?msg=` + encodeURIComponent('Pending changes withdrawn.'));
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
