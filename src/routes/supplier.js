// Supplier portal: company details (required on first sign-in) and the supplier's own products.
// All reads go through the service client but are always filtered by the signed-in user's supplier_id.
import { Router } from '../lib/router.js';
import { admin } from '../lib/supabase.js';
import { requireSupplier } from '../middleware/auth.js';
import { log } from '../lib/activity.js';
import { signedUrl, uploadDocument, deleteDocument } from '../lib/storage.js';
import multer from '../lib/multer-utf8.js';
import { catalogItems, STATUS_LABEL, EDITABLE, fromProduct } from '../lib/supplier-product.js';
import { clean as cleanProduct, missing, containerFit, CURRENCIES, INCOTERMS, CATEGORIES } from '../lib/supplier-product.js';
import { cleanResponse, RS_LABEL } from '../lib/rfq.js';
import { forgetSupplierRfq } from '../lib/supplier-nav.js';
import { parseQuotation, gaps, MAX_PRODUCTS } from '../lib/supplier-bulk.js';
import { validateSupplierCompany, COMPANY_TYPES } from '../lib/supplier-company.js';

const r = Router();
r.use(requireSupplier);

const PRODUCT_COLS = 'id, name, description, supplier_sku, category, hs_code, unit_cost, cost_currency, moq, unit_weight_kg, carton_qty, carton_weight_kg, carton_length_cm, carton_width_cm, carton_height_cm, created_at';

r.get('/', async (req, res) => {
  const sid = req.user.supplier_id;
  const [{ data: s }, { data: products }, { data: team }] = await Promise.all([
    admin.from('suppliers').select('*').eq('id', sid).single(),
    admin.from('products').select('id, name, category, created_at').eq('supplier_id', sid).order('created_at', { ascending: false }),
    admin.from('profiles').select('full_name, email, job_title').eq('supplier_id', sid).eq('active', true).order('created_at'),
  ]);
  res.render('supplier/dashboard', { title: 'Overview', s, products: products || [], team: team || [], types: COMPANY_TYPES });
});

r.get('/company', async (req, res) => {
  const { data: s } = await admin.from('suppliers').select('*').eq('id', req.user.supplier_id).single();
  const first = !s?.details_completed_at;
  // first time: suggest the person's own contact details
  const form = { ...s };
  if (first) {
    form.contact_name ||= req.user.full_name; form.email ||= req.user.email;
    form.phone ||= req.user.phone; form.wechat ||= req.user.wechat;
    if (/^\(.*\)$/.test(form.name || '')) form.name = ''; // placeholder name from the invitation
  }
  res.render('supplier/company', { title: 'Company details', form, errors: {}, first, saved: req.query.saved, types: COMPANY_TYPES });
});

r.post('/company', async (req, res) => {
  const { data: s } = await admin.from('suppliers').select('id, details_completed_at').eq('id', req.user.supplier_id).single();
  const first = !s?.details_completed_at;
  const { data, errors } = validateSupplierCompany(req.body);
  if (Object.keys(errors).length) return res.status(400).render('supplier/company', { title: 'Company details', form: { ...req.body }, errors, first, saved: false, types: COMPANY_TYPES });
  const patch = { ...data };
  if (first) Object.assign(patch, { details_completed_at: new Date().toISOString(), details_completed_by: req.user.id });
  const { error } = await admin.from('suppliers').update(patch).eq('id', req.user.supplier_id);
  if (error) return res.status(400).render('supplier/company', { title: 'Company details', form: { ...req.body }, errors: { _: error.message }, first, saved: false, types: COMPANY_TYPES });
  await log({ entityType: 'supplier', entityId: req.user.supplier_id, action: first ? 'details_completed' : 'details_updated', actorId: req.user.id });
  res.redirect(first ? '/supplier?msg=' + encodeURIComponent('Thank you — your company is registered with Lumi Trade.') : '/supplier/company?saved=1');
});

r.get('/products', async (req, res) => {
  const sid = req.user.supplier_id;
  const { data: products } = await admin.from('products').select(PRODUCT_COLS).eq('supplier_id', sid).order('name');
  const ids = (products || []).map(p => p.id);
  const { data: photos } = ids.length
    ? await admin.from('documents').select('id, entity_id').eq('entity_type', 'product').eq('kind', 'product_photo').in('entity_id', ids).order('created_at')
    : { data: [] };
  const photoOf = {};
  (photos || []).forEach(d => { photoOf[d.entity_id] ||= d.id; });
  const { data: subs } = await admin.from('supplier_products').select('id, status, data, review_note, edit_reason, product_id, submitted_at, updated_at').eq('supplier_id', sid).neq('status', 'approved').order('updated_at', { ascending: false }); // empty before migration 0028
  const all = catalogItems({ products: products || [], photoOf, subs: subs || [] });
  const q = String(req.query.q || '').trim().toLowerCase(), cat = String(req.query.cat || ''), status = String(req.query.status || '');
  const items = all.filter(i => (!status || i.status === status) && (!cat || i.category === cat) && (!q || (i.name + ' ' + i.sku).toLowerCase().includes(q)));
  const counts = { all: all.length, catalog: all.filter(i => i.kind === 'product').length }; for (const k of Object.keys(STATUS_LABEL)) counts[k] = all.filter(i => i.status === k).length;
  const cats = [...new Set(all.map(i => i.category).filter(Boolean))].sort();
  const avg = all.length ? Math.round(all.reduce((t, i) => t + i.pct, 0) / all.length) : null;
  res.render('supplier/products', { title: 'My products', items, counts, cats, avg, q, cat, status, labels: STATUS_LABEL, msg: req.query.msg });
});

// ---- "Add product" wizard: a submission stays here (draft → submitted → approved/returned) until staff approve it as a real product ----
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 10 }, fileFilter: (req, file, cb) => cb(null, PHOTO_TYPES.includes(file.mimetype)) }).array('photos', 10);
const withUpload = (req, res, next) => upload(req, res, err => {
  if (err) req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'A photo is larger than 20 MB.' : err.code === 'LIMIT_FILE_COUNT' ? 'Up to 10 photos at a time.' : err.message;
  next();
});
const formLists = async sid => {
  const { data } = await admin.from('products').select('category').not('category', 'is', null).limit(500);
  return { categories: [...new Set([...CATEGORIES, ...(data || []).map(p => p.category).filter(Boolean)])].sort(), currencies: CURRENCIES, incoterms: INCOTERMS };
};
async function ownSubmission(req, id) {
  const { data } = await admin.from('supplier_products').select('*').eq('id', id).eq('supplier_id', req.user.supplier_id).maybeSingle();
  return data;
}
async function photosOf(ids) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return [];
  const { data } = await admin.from('documents').select('id, title').in('id', list);
  const by = Object.fromEntries((data || []).map(d => [d.id, d]));
  return list.map(i => by[i]).filter(Boolean);
}
async function renderForm(res, req, { sub, data, errors = {}, status = 200, step = 0 }) {
  const photos = await photosOf(data.photo_ids || sub?.data?.photo_ids);
  res.status(status).render('supplier/product_form', { title: sub?.id ? 'Edit product' : 'Add product', sub: sub || { id: null, status: 'draft' }, d: data, photos, errors, step, ...(await formLists(req.user.supplier_id)), miss: missing(data, photos.length), fit: containerFit(data) });
}

// ---- Bulk upload: one .xlsx (our quotation template) → one draft per row, photos included ----
const bulkUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024, files: 1 } }).single('file');
const bulkPage = (res, extra = {}) => res.status(extra.status || 200).render('supplier/bulk', { title: 'Bulk upload', result: null, error: null, ...extra });
const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

r.get('/products/bulk', (req, res) => bulkPage(res));

r.post('/products/bulk', (req, res, next) => bulkUpload(req, res, err => { req.uploadError = err ? (err.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 40 MB.' : err.message) : null; next(); }), async (req, res) => {
  const sid = req.user.supplier_id;
  if (req.uploadError) return bulkPage(res, { status: 400, error: req.uploadError });
  const f = req.file;
  if (!f) return bulkPage(res, { status: 400, error: 'Choose the filled-in Excel file first.' });
  if (!/\.xlsx$/i.test(f.originalname)) return bulkPage(res, { status: 400, error: 'Please upload an .xlsx file (Excel). CSV files lose the photos.' });
  let parsed;
  try { parsed = parseQuotation(f.buffer); } catch (e) { return bulkPage(res, { status: 400, error: e.message }); }
  if (!parsed.rows.length) return bulkPage(res, { status: 400, error: 'No products found. Fill one row per product (Product Name is required) starting under the grey example row.' });
  if (parsed.rows.length > MAX_PRODUCTS) return bulkPage(res, { status: 400, error: `Up to ${MAX_PRODUCTS} products per file. This file has ${parsed.rows.length} — please split it.` });
  const added = [], failed = [];
  // SKUs this supplier already has (catalog or earlier submissions), plus repeats inside the file
  const norm = v => String(v || '').trim().toLowerCase();
  const [{ data: have1 }, { data: have2 }] = await Promise.all([
    admin.from('products').select('supplier_sku').eq('supplier_id', sid).not('supplier_sku', 'is', null),
    admin.from('supplier_products').select('data').eq('supplier_id', sid),
  ]);
  const seen = new Set([...(have1 || []).map(x => norm(x.supplier_sku)), ...(have2 || []).map(x => norm(x.data && x.data.sku))].filter(Boolean));
  for (const row of parsed.rows) {
    const k = norm(row.data.sku);
    if (k && !row.problems.length) {
      if (seen.has(k)) row.problems.push(`SKU ${row.data.sku} is already on file or repeated in this file`);
      else seen.add(k);
    }
    if (row.problems.length) { failed.push({ row: row.row, name: row.data.name, why: row.problems.join('; ') }); continue; }
    try {
      const photo_ids = [];
      for (const [i, im] of row.images.entries()) {
        const mime = IMG_MIME[im.ext];
        if (!mime) continue;
        const doc = await uploadDocument({ file: { originalname: `${row.data.sku || row.data.name}-${i + 1}.${im.ext}`.replace(/[\\/]/g, '-'), buffer: im.data, mimetype: mime, size: im.data.length }, entityType: 'supplier', entityId: sid, kind: 'product_photo', title: row.data.name, clientVisible: false, uploadedBy: req.user.id });
        photo_ids.push(doc.id);
      }
      const data = { ...row.data, photo_ids };
      const { data: ins, error } = await admin.from('supplier_products').insert({ supplier_id: sid, created_by: req.user.id, data, status: 'draft' }).select('id').single();
      if (error) throw error;
      added.push({ id: ins.id, row: row.row, name: data.name, photos: photo_ids.length, gaps: gaps(data, photo_ids.length) });
    } catch (e) { failed.push({ row: row.row, name: row.data.name, why: e.message || 'Could not save' }); }
  }
  await log({ entityType: 'supplier', entityId: sid, action: 'product_bulk_upload', actorId: req.user.id, detail: { note: `${added.length} drafts from ${f.originalname}` } });
  bulkPage(res, { result: { file: f.originalname, added, failed, skipped: parsed.skipped } });
});

// send every listed draft to Lumi Trade for review
r.post('/products/bulk/submit', async (req, res) => {
  const ids = [].concat(req.body.ids || []).filter(Boolean);
  if (!ids.length) return res.redirect('/supplier/products');
  const { data, error } = await admin.from('supplier_products').update({ status: 'submitted', submitted_at: new Date().toISOString(), review_note: null, updated_at: new Date().toISOString() })
    .in('id', ids).eq('supplier_id', req.user.supplier_id).in('status', ['draft', 'returned']).select('id');
  if (error) return res.redirect('/supplier/products?msg=' + encodeURIComponent(error.message));
  await log({ entityType: 'supplier', entityId: req.user.supplier_id, action: 'product_submitted', actorId: req.user.id, detail: { note: `${(data || []).length} products (bulk)` } });
  res.redirect('/supplier/products?msg=' + encodeURIComponent(`Thank you — ${(data || []).length} products were sent to Lumi Trade for review.`));
});

// ---- RFQs: requests for quotation from Lumi Trade; the supplier answers in the portal ----
const rfqUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 8 } }).array('files', 8);
async function ownRfq(req, id) {
  if (!/^[0-9a-f-]{36}$/i.test(id || '')) return null;
  const { data: rs } = await admin.from('rfq_suppliers').select('*').eq('id', id).eq('supplier_id', req.user.supplier_id).neq('status', 'draft').maybeSingle();
  if (!rs) return null;
  const { data: rfq } = await admin.from('rfqs').select('*').eq('id', rs.rfq_id).single();
  if (rfq) { delete rfq.file_review; delete rfq.awarded; }   // staff notes about the files never reach the supplier
  const { data: resp } = await admin.from('rfq_responses').select('*').eq('rfq_supplier_id', rs.id).neq('status', 'parsed').order('created_at', { ascending: false }).limit(1);
  return { rs, rfq, resp: (resp || [])[0] || null };
}

r.get('/rfqs', async (req, res) => {
  const { data: list, error } = await admin.from('rfq_suppliers').select('id, status, sent_at, replied_at, rfqs(ref, title, deadline, status, items)').eq('supplier_id', req.user.supplier_id).neq('status', 'draft').order('sent_at', { ascending: false });
  res.render('supplier/rfqs', { title: 'RFQs', list: error ? [] : list || [], labels: RS_LABEL, msg: req.query.msg });
});

r.get('/rfqs/:id', async (req, res) => {
  const x = await ownRfq(req, req.params.id);
  if (!x) return res.status(404).send('Not found');
  const fids = x.rfq.file_ids || [];
  const { data: fdocs } = fids.length ? await admin.from('documents').select('id, title, mime_type').in('id', fids) : { data: [] };
  res.render('supplier/rfq', { title: x.rfq.ref, ...x, files: fids.map(id => (fdocs || []).find(d => d.id === id)).filter(Boolean), labels: RS_LABEL, err: req.query.err, msg: req.query.msg });
});

// a file Lumi Trade attached to this RFQ — only for suppliers that were sent the RFQ, and only files listed on it
r.get('/rfqs/:id/files/:doc', async (req, res) => {
  const x = await ownRfq(req, req.params.id);
  if (!x || !(x.rfq.file_ids || []).includes(req.params.doc)) return res.status(404).send('Not found');
  const { data: doc } = await admin.from('documents').select('storage_path').eq('id', req.params.doc).maybeSingle();
  if (!doc) return res.status(404).send('Not found');
  res.redirect(await signedUrl(doc.storage_path));
});

r.post('/rfqs/:id', (req, res, next) => rfqUpload(req, res, err => { req.uploadError = err ? err.message : null; next(); }), async (req, res) => {
  const x = await ownRfq(req, req.params.id);
  if (!x) return res.status(404).send('Not found');
  const to = `/supplier/rfqs/${x.rs.id}`;
  if (x.rfq.status === 'closed') return res.redirect(to + '?err=' + encodeURIComponent('This RFQ is closed.'));
  if (req.uploadError) return res.redirect(to + '?err=' + encodeURIComponent(req.uploadError));
  const declined = req.body.decline === '1';
  const parsed = cleanResponse(req.body, x.rfq.items, x.rfq.currency);
  if (!declined && parsed.problems.length) return res.redirect(to + '?err=' + encodeURIComponent(parsed.problems.join('; ')));
  const file_ids = [];
  for (const file of req.files || []) {
    const doc = await uploadDocument({ file, entityType: 'supplier', entityId: req.user.supplier_id, kind: 'other', title: file.originalname, clientVisible: false, uploadedBy: req.user.id });
    file_ids.push(doc.id);
  }
  const { error } = await admin.from('rfq_responses').insert({ rfq_id: x.rfq.id, rfq_supplier_id: x.rs.id, supplier_id: req.user.supplier_id, source: 'portal', status: declined ? 'declined' : 'confirmed',
    lines: declined ? [] : parsed.lines, terms: declined ? {} : parsed.terms, note: String(req.body.note || '').trim().slice(0, 2000) || null, file_ids, created_by: req.user.id });
  if (error) return res.redirect(to + '?err=' + encodeURIComponent(error.message));
  await admin.from('rfq_suppliers').update({ status: declined ? 'declined' : 'replied', replied_at: new Date().toISOString() }).eq('id', x.rs.id);
  forgetSupplierRfq(req.user.supplier_id);
  await log({ entityType: 'supplier', entityId: req.user.supplier_id, action: declined ? 'rfq_declined' : 'rfq_answered', actorId: req.user.id, detail: { note: x.rfq.ref } });
  res.redirect('/supplier/rfqs?msg=' + encodeURIComponent(declined ? 'Thank you — we noted that you can\'t quote this one.' : `Thank you — your prices for ${x.rfq.ref} were sent to Lumi Trade.`));
});

r.get('/products/new', async (req, res) => renderForm(res, req, { sub: null, data: { ...cleanProduct({}), photo_ids: [] } }));

r.get('/products/:id/edit', async (req, res) => {
  const sub = await ownSubmission(req, req.params.id);
  if (!sub) return res.status(404).send('Not found');
  if (!EDITABLE.includes(sub.status)) return res.redirect('/supplier/products');
  renderForm(res, req, { sub, data: { ...cleanProduct({}), ...sub.data }, step: Number(req.query.step) || 0 });
});

// create or update a draft; intent=submit also sends it to Lumi Trade for review
r.post('/products/save', withUpload, async (req, res) => {
  const sid = req.user.supplier_id;
  let sub = req.body.id ? await ownSubmission(req, req.body.id) : null;
  if (req.body.id && !sub) return res.status(404).send('Not found');
  if (sub && !EDITABLE.includes(sub.status)) return res.redirect('/supplier/products');
  const data = { ...cleanProduct(req.body), photo_ids: [...(sub?.data?.photo_ids || [])] };
  const submit = req.body.intent === 'submit';
  const fail = (msg, step = 1, key = 'name') => renderForm(res, req, { sub, data, errors: { [key]: msg }, status: 400, step });
  if (req.uploadError) return fail(req.uploadError, 0, 'photos');
  if (!data.name) return fail('Enter the product name.', 1);
  if (data.photo_ids.length + (req.files || []).length > 12) return fail('Up to 12 photos per product.', 0, 'photos');
  const row = { data, updated_at: new Date().toISOString() };
  if (!sub) {
    const { data: ins, error } = await admin.from('supplier_products').insert({ supplier_id: sid, created_by: req.user.id, data, status: 'draft' }).select('*').single();
    if (error) return fail(error.message, 0, '_');
    sub = ins;
  }
  for (const file of req.files || []) {
    const doc = await uploadDocument({ file, entityType: 'supplier', entityId: sid, kind: 'product_photo', title: file.originalname, clientVisible: false, uploadedBy: req.user.id });
    data.photo_ids.push(doc.id);
  }
  const reopened = sub.status === 'unlocked' || sub.status === 'updated';   // an approved product that staff released for editing
  const live = sub.status === 'submitted';                                    // still waiting for review: edits just replace the content
  if (reopened) Object.assign(row, { status: 'updated', submitted_at: new Date().toISOString(), review_note: null });
  else if (submit) Object.assign(row, { status: 'submitted', submitted_at: new Date().toISOString(), review_note: null });
  const { error } = await admin.from('supplier_products').update(row).eq('id', sub.id);
  if (error) return fail(error.message, 0, '_');
  await log({ entityType: 'supplier', entityId: sid, action: reopened ? 'product_updated' : submit ? 'product_submitted' : 'product_draft_saved', actorId: req.user.id, detail: { note: data.name } });
  if (reopened) return res.redirect('/supplier/products?msg=' + encodeURIComponent('Thank you — your changes to "' + data.name + '" were sent to Lumi Trade. The catalog is updated once they approve them.'));
  if (live) return res.redirect('/supplier/products?msg=' + encodeURIComponent('Changes saved — "' + data.name + '" is still waiting for Lumi Trade to review it.'));
  res.redirect('/supplier/products?msg=' + encodeURIComponent(submit ? 'Thank you — "' + data.name + '" was sent to Lumi Trade for review.' : 'Draft saved.'));
});

r.post('/products/:id/photos/:doc/delete', async (req, res) => {
  const sub = await ownSubmission(req, req.params.id);
  if (!sub || !EDITABLE.includes(sub.status)) return res.status(404).send('Not found');
  const ids = (sub.data.photo_ids || []);
  if (ids.includes(req.params.doc)) {
    if (!sub.product_id) await deleteDocument(req.params.doc);   // a live product's photo stays until staff apply the change
    await admin.from('supplier_products').update({ data: { ...sub.data, photo_ids: ids.filter(i => i !== req.params.doc) }, updated_at: new Date().toISOString() }).eq('id', sub.id);
  }
  res.redirect(`/supplier/products/${sub.id}/edit`);
});

// ask to change a product that is already in the catalog; staff release it for editing
r.post('/products/:id/request-edit', async (req, res) => {
  const sid = req.user.supplier_id;
  const { data: p } = await admin.from('products').select('*').eq('id', req.params.id).eq('supplier_id', sid).maybeSingle();
  if (!p) return res.status(404).send('Not found');
  const reason = String(req.body.reason || '').trim().slice(0, 1000);
  if (!reason) return res.redirect('/supplier/products?msg=' + encodeURIComponent('Please say what you want to change.'));
  const { data: cur } = await admin.from('supplier_products').select('id, status').eq('product_id', p.id).eq('supplier_id', sid).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (cur && ['edit_requested', 'unlocked', 'updated'].includes(cur.status)) return res.redirect('/supplier/products');
  const now = new Date().toISOString();
  if (cur) await admin.from('supplier_products').update({ status: 'edit_requested', edit_reason: reason, review_note: null, updated_at: now }).eq('id', cur.id);
  else {
    const { data: photos } = await admin.from('documents').select('id').eq('entity_type', 'product').eq('entity_id', p.id).eq('kind', 'product_photo').order('created_at');
    const { error } = await admin.from('supplier_products').insert({ supplier_id: sid, created_by: req.user.id, status: 'edit_requested', edit_reason: reason, product_id: p.id, data: fromProduct(p, (photos || []).map(d => d.id)), submitted_at: now });
    if (error) return res.redirect('/supplier/products?msg=' + encodeURIComponent(error.message));
  }
  await log({ entityType: 'supplier', entityId: sid, action: 'product_edit_requested', actorId: req.user.id, detail: { note: `${p.name}: ${reason}` } });
  res.redirect('/supplier/products?msg=' + encodeURIComponent('Request sent. Lumi Trade will release "' + p.name + '" for editing.'));
});

r.post('/products/:id/delete', async (req, res) => {
  const sub = await ownSubmission(req, req.params.id);
  if (!sub || !['draft', 'returned'].includes(sub.status)) return res.status(404).send('Not found');
  for (const d of sub.data.photo_ids || []) await deleteDocument(d);
  await admin.from('supplier_products').delete().eq('id', sub.id);
  res.redirect('/supplier/products?msg=' + encodeURIComponent('Draft deleted.'));
});

// product photos: only for this supplier's own products
r.get('/photos/:id', async (req, res) => {
  const { data: doc } = await admin.from('documents').select('storage_path, entity_type, entity_id, kind').eq('id', req.params.id).maybeSingle();
  if (doc && doc.entity_type === 'supplier' && doc.kind === 'product_photo' && doc.entity_id === req.user.supplier_id) return res.redirect(await signedUrl(doc.storage_path));
  if (!doc || doc.entity_type !== 'product') return res.status(404).send('Not found');
  const { data: p } = await admin.from('products').select('supplier_id').eq('id', doc.entity_id).maybeSingle();
  if (p?.supplier_id !== req.user.supplier_id) return res.status(404).send('Not found');
  res.redirect(await signedUrl(doc.storage_path));
});

export default r;
