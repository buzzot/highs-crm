// Supplier portal: company details (required on first sign-in) and the supplier's own products.
// All reads go through the service client but are always filtered by the signed-in user's supplier_id.
import { Router } from '../lib/router.js';
import { admin } from '../lib/supabase.js';
import { requireSupplier } from '../middleware/auth.js';
import { log } from '../lib/activity.js';
import { signedUrl, uploadDocument, deleteDocument } from '../lib/storage.js';
import multer from '../lib/multer-utf8.js';
import { clean as cleanProduct, missing, containerFit, CURRENCIES, INCOTERMS, CATEGORIES } from '../lib/supplier-product.js';
import { parseQuotation, gaps, MAX_PRODUCTS } from '../lib/supplier-bulk.js';
import { validateSupplierCompany, COMPANY_TYPES } from '../lib/supplier-company.js';

const r = Router();
r.use(requireSupplier);

const PRODUCT_COLS = 'id, name, supplier_sku, category, hs_code, unit_cost, cost_currency, moq, unit_weight_kg, carton_qty, carton_weight_kg, carton_length_cm, carton_width_cm, carton_height_cm, created_at';

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
  const { data: subs } = await admin.from('supplier_products').select('id, status, data, review_note, submitted_at, updated_at').eq('supplier_id', sid).neq('status', 'approved').order('updated_at', { ascending: false }); // empty before migration 0028
  res.render('supplier/products', { title: 'My products', products: products || [], photoOf, subs: subs || [], msg: req.query.msg });
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
  for (const row of parsed.rows) {
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

r.get('/products/new', async (req, res) => renderForm(res, req, { sub: null, data: { ...cleanProduct({}), photo_ids: [] } }));

r.get('/products/:id/edit', async (req, res) => {
  const sub = await ownSubmission(req, req.params.id);
  if (!sub) return res.status(404).send('Not found');
  if (sub.status === 'approved' || sub.status === 'submitted') return res.redirect('/supplier/products');
  renderForm(res, req, { sub, data: { ...cleanProduct({}), ...sub.data }, step: Number(req.query.step) || 0 });
});

// create or update a draft; intent=submit also sends it to Lumi Trade for review
r.post('/products/save', withUpload, async (req, res) => {
  const sid = req.user.supplier_id;
  let sub = req.body.id ? await ownSubmission(req, req.body.id) : null;
  if (req.body.id && !sub) return res.status(404).send('Not found');
  if (sub && !['draft', 'returned'].includes(sub.status)) return res.redirect('/supplier/products');
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
  if (submit) Object.assign(row, { status: 'submitted', submitted_at: new Date().toISOString(), review_note: null });
  const { error } = await admin.from('supplier_products').update(row).eq('id', sub.id);
  if (error) return fail(error.message, 0, '_');
  await log({ entityType: 'supplier', entityId: sid, action: submit ? 'product_submitted' : 'product_draft_saved', actorId: req.user.id, detail: { note: data.name } });
  res.redirect('/supplier/products?msg=' + encodeURIComponent(submit ? 'Thank you — "' + data.name + '" was sent to Lumi Trade for review.' : 'Draft saved.'));
});

r.post('/products/:id/photos/:doc/delete', async (req, res) => {
  const sub = await ownSubmission(req, req.params.id);
  if (!sub || !['draft', 'returned'].includes(sub.status)) return res.status(404).send('Not found');
  const ids = (sub.data.photo_ids || []);
  if (ids.includes(req.params.doc)) {
    await deleteDocument(req.params.doc);
    await admin.from('supplier_products').update({ data: { ...sub.data, photo_ids: ids.filter(i => i !== req.params.doc) }, updated_at: new Date().toISOString() }).eq('id', sub.id);
  }
  res.redirect(`/supplier/products/${sub.id}/edit`);
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
