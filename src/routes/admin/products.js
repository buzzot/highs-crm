import { Router } from '../../lib/router.js';
import { admin } from '../../lib/supabase.js';
import multer from '../../lib/multer-utf8.js';
import { clean, notFound, getSettings, fxRate, back } from '../../lib/util.js';
import { log } from '../../lib/activity.js';
import { canAssign } from '../../lib/access.js';
import { clean as cleanSub, missing as subMissing, toProduct, containerFit, changes, fromProduct } from '../../lib/supplier-product.js';
import { productMetrics } from '../../lib/product-metrics.js';
import { compareProducts, extractProductCard, aiEnabled } from '../../lib/ai.js';
import { uploadDocument, deleteDocument } from '../../lib/storage.js';

// product photos: up to 12 images per save, 10 MB each, stored in Supabase Storage (bucket "documents")
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const photos = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 12 },
  fileFilter: (req, file, cb) => cb(null, PHOTO_TYPES.includes(file.mimetype)),
}).array('photos', 12);
const withPhotos = (req, res, next) => photos(req, res, err => {
  if (err) req.photoError = err.code === 'LIMIT_FILE_SIZE' ? 'A photo is larger than 10 MB.' : err.code === 'LIMIT_FILE_COUNT' ? 'Up to 12 photos at a time.' : err.message;
  next();
});
async function savePhotos(req, productId) {
  let n = 0;
  for (const file of req.files || []) {
    await uploadDocument({ file, entityType: 'product', entityId: productId, kind: 'product_photo', title: file.originalname, clientVisible: true, uploadedBy: req.user.id });
    n++;
  }
  return n;
}
async function productPhotos(id) {
  if (!id) return [];
  const { data } = await admin.from('documents').select('id, title, created_at').eq('entity_type', 'product').eq('entity_id', id).eq('kind', 'product_photo').order('created_at');
  return data || [];
}

const r = Router();
r.use((req, res, next) => { res.locals.aiOn = aiEnabled(); next(); }); // shows the AI scan box on the product form
const FIELDS = ['sku', 'supplier_sku', 'name', 'category', 'description', 'supplier_id', 'unit_cost', 'cost_currency', 'moq', 'hs_code', 'unit_weight_kg',
  'unit_length_cm', 'unit_width_cm', 'unit_height_cm', 'carton_qty', 'carton_cbm', 'carton_weight_kg', 'carton_length_cm', 'carton_width_cm', 'carton_height_cm'];
const like = q => String(q || '').replace(/[,()%]/g, ' ').trim();

// spec is edited as "Key: value" lines and stored as JSON
const parseSpec = txt => Object.fromEntries(String(txt || '').split('\n').map(l => l.split(':')).filter(p => p.length > 1 && p[0].trim())
  .map(([k, ...v]) => [k.trim(), v.join(':').trim()]));
const specText = spec => Object.entries(spec || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
const body = b => {
  const out = { ...clean(b, FIELDS), spec: parseSpec(b.spec) };
  // carton CBM follows the carton size when all three sides are given
  const [l, w, h] = ['carton_length_cm', 'carton_width_cm', 'carton_height_cm'].map(k => Number(out[k]));
  if (l > 0 && w > 0 && h > 0) out.carton_cbm = Math.round(l * w * h / 1e6 * 10000) / 10000;
  return out;
};

async function formData() {
  const { data } = await admin.from('suppliers').select('id, name').order('name');
  return data || [];
}

// ---------- list (filters, sort, estimates), CSV export and comparison ----------
const SORTS = {
  name: ['Name A–Z', (a, b) => a.name.localeCompare(b.name)],
  newest: ['Newest first', (a, b) => String(b.created_at).localeCompare(String(a.created_at))],
  price: ['Factory price ↑', (a, b) => nz(a.m.priceUsd) - nz(b.m.priceUsd)],
  price_desc: ['Factory price ↓', (a, b) => nz(b.m.priceUsd, -1) - nz(a.m.priceUsd, -1)],
  landed: ['Landed ↑', (a, b) => nz(a.m.landedUsd) - nz(b.m.landedUsd)],
  moq: ['MOQ ↑', (a, b) => nz(a.moq) - nz(b.moq)],
  per40: ['Units / 40HQ ↓', (a, b) => nz(b.m.unitsPer40hq, -1) - nz(a.m.unitsPer40hq, -1)],
  issues: ['Most issues', (a, b) => b.m.issues.length - a.m.issues.length],
};
const nz = (v, empty = Infinity) => (v == null ? empty : Number(v));

async function listProducts(query) {
  const settings = await getSettings(admin);
  const toUsd = c => fxRate(settings, c, 'USD');
  const [{ data }, suppliers] = await Promise.all([
    admin.from('products').select('*, suppliers(id, name, rating, lead_time_days, can_export_official, company_type, city)').order('name'),
    formData(),
  ]);
  const all = (data || []).map(p => ({ ...p, m: productMetrics(p, toUsd, settings.container) }));
  const categories = [...new Set(all.map(p => p.category).filter(Boolean))].sort();
  const q = String(query.q || '').trim().toLowerCase();
  let rows = all.filter(p => (!q || [p.name, p.sku, p.supplier_sku, p.hs_code, p.category, p.description, p.suppliers?.name].some(x => String(x || '').toLowerCase().includes(q)))
    && (!query.category || p.category === query.category)
    && (!query.supplier || p.supplier_id === query.supplier)
    && (!query.issues || p.m.issues.length > 0));
  const sort = SORTS[query.sort] ? query.sort : 'name';
  rows = rows.sort(SORTS[sort][1]);
  return { rows, total: all.length, categories, suppliers, settings, sort };
}

async function firstPhotos(ids) {
  if (!ids.length) return {};
  const { data } = await admin.from('documents').select('id, entity_id').eq('entity_type', 'product').eq('kind', 'product_photo').in('entity_id', ids).order('created_at');
  const out = {}, count = {};
  (data || []).forEach(d => { out[d.entity_id] ||= d.id; count[d.entity_id] = (count[d.entity_id] || 0) + 1; });
  return { first: out, count };
}

r.get('/', async (req, res) => {
  const { rows, total, categories, suppliers, settings, sort } = await listProducts(req.query);
  const photos = await firstPhotos(rows.map(p => p.id));
  const { count: pendingSubs } = await admin.from('supplier_products').select('id', { count: 'exact', head: true }).in('status', ['submitted', 'edit_requested', 'updated']); // null before migration 0028
  res.render('admin/products/index', { pendingSubs: pendingSubs || 0,
    title: 'Products', products: rows, total, categories, suppliers, thumb: photos.first || {}, photoCount: photos.count || {},
    sorts: Object.fromEntries(Object.entries(SORTS).map(([k, [label]]) => [k, label])), sort, container: settings.container,
  });
});

r.get('/export.csv', async (req, res) => {
  const { rows } = await listProducts(req.query);
  const cols = [['Name', p => p.name], ['SKU', p => p.sku], ['Supplier SKU', p => p.supplier_sku], ['Supplier', p => p.suppliers?.name], ['Category', p => p.category],
    ['Factory price', p => p.unit_cost], ['Currency', p => p.cost_currency], ['Factory price USD', p => p.m.priceUsd], ['Landed USD (FCL 40HQ)', p => p.m.landedUsd],
    ['Suggested wholesale USD', p => p.m.wholesaleUsd], ['MOQ', p => p.moq], ['Units per 40HQ', p => p.m.unitsPer40hq], ['HS code', p => p.hs_code],
    ['Pcs per carton', p => p.carton_qty], ['Carton cbm', p => p.carton_cbm], ['Carton kg', p => p.carton_weight_kg], ['Missing data', p => p.m.issues.join('; ')]];
  const cell = v => { const t = v == null ? '' : String(v); return /[",\n;]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const csv = '﻿' + [cols.map(c => c[0]).join(','), ...rows.map(p => cols.map(c => cell(c[1](p))).join(','))].join('\r\n');
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="lumi-trade-products-${new Date().toISOString().slice(0, 10)}.csv"` });
  res.send(csv);
});

// Compare 2–6 products side by side; with ai=1 the AI ranks them as well.
r.get('/compare', async (req, res) => {
  const ids = [...new Set([].concat(req.query.ids || []).flatMap(x => String(x).split(',')).filter(x => /^[0-9a-f-]{36}$/i.test(x)))].slice(0, 6);
  if (ids.length < 2) return res.redirect('/admin/products?err=' + encodeURIComponent('Tick at least two products to compare (up to six).'));
  const settings = await getSettings(admin);
  const toUsd = c => fxRate(settings, c, 'USD');
  const { data } = await admin.from('products').select('*, suppliers(id, name, rating, lead_time_days, can_export_official, company_type, city, country)').in('id', ids);
  const products = ids.map(id => (data || []).find(p => p.id === id)).filter(Boolean).map(p => ({ ...p, m: productMetrics(p, toUsd, settings.container) }));
  const photos = await firstPhotos(products.map(p => p.id));
  let ai = null, aiError = null;
  if (req.query.ai) {
    try {
      ai = await compareProducts({
        purpose: String(req.query.purpose || '').slice(0, 500),
        products: products.map(p => ({
          id: p.id, name: p.name, category: p.category, description: p.description, specs: p.spec,
          supplier: p.suppliers ? { name: p.suppliers.name, rating: p.suppliers.rating, lead_time_days: p.suppliers.lead_time_days, export_rights: p.suppliers.can_export_official, type: p.suppliers.company_type } : null,
          factory_price: p.unit_cost, currency: p.cost_currency, factory_price_usd: p.m.priceUsd, landed_usd_fcl40hq: p.m.landedUsd,
          suggested_wholesale_usd: p.m.wholesaleUsd, moq: p.moq, money_at_moq_usd: p.m.moqValueUsd, units_per_40hq: p.m.unitsPer40hq,
          pcs_per_carton: p.carton_qty, carton_cbm: p.carton_cbm, carton_kg: p.carton_weight_kg, unit_weight_kg: p.unit_weight_kg, hs_code: p.hs_code,
          missing_data: p.m.issues,
        })),
      });
    } catch (e) { aiError = e.message; console.error('[compare ai]', e.message); }
  }
  const specKeys = [...new Set(products.flatMap(p => Object.keys(p.spec || {})))];
  res.render('admin/products/compare', { title: 'Compare products', products, thumb: photos.first || {}, specKeys, ai, aiError, container: settings.container, purpose: req.query.purpose || '' });
});

r.get('/new', async (req, res) => res.render('admin/products/form', {
  title: 'New product', p: { cost_currency: 'CNY', supplier_id: req.query.supplier_id }, specText: '', suppliers: await formData(), photos: [], error: null, aiOn: aiEnabled(),
}));

// AI scan: read photos / a PDF and SUGGEST field values. Nothing is saved here — the form shows the suggestions and staff approve each one.
const scanUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 6 } }).array('files', 6);
r.post('/ai-scan', (req, res) => scanUpload(req, res, async err => {
  if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'A file is larger than 10 MB.' : err.message });
  if (!aiEnabled()) return res.status(503).json({ error: 'AI is not switched on (no API key).' });
  const IMG = /^image\/(png|jpe?g|gif|webp)$/i;
  const files = (req.files || []).flatMap(f => (f.mimetype === 'application/pdf' || /\.pdf$/i.test(f.originalname) ? [{ pdf: f.buffer }] : IMG.test(f.mimetype) ? [{ data: f.buffer, mediaType: f.mimetype.replace('jpg', 'jpeg') }] : []));
  if (!files.length) return res.status(400).json({ error: 'Add a photo or a PDF of the product first.' });
  try {
    const out = await extractProductCard({ files, name: String(req.body.name || '').slice(0, 300), description: String(req.body.description || '').slice(0, 3000) });
    const { usage, ...card } = out;
    res.json({ card, tokens: usage?.total ?? null });
  } catch (e) { console.error('[product ai-scan]', e.message); res.status(502).json({ error: `AI could not read the files: ${e.message}` }); }
}));
r.post('/', withPhotos, async (req, res) => {
  const again = async error => res.status(400).render('admin/products/form', { title: 'New product', p: req.body, specText: req.body.spec, suppliers: await formData(), photos: [],
    error: `${error}${req.files?.length ? ' Please add the photos again.' : ''}` });
  if (req.photoError) return again(req.photoError);
  const { data, error } = await admin.from('products').insert(body(req.body)).select('id').single();
  if (error) return again(error.message);
  const n = await savePhotos(req, data.id);
  res.redirect(`/admin/products/${data.id}` + (n ? `?msg=${encodeURIComponent(`Product created with ${n} photo${n === 1 ? '' : 's'}.`)}` : ''));
});

// quick-add a supplier from the product form (JSON): name is enough; an existing supplier with the same name is reused
r.post('/quick-supplier', async (req, res) => {
  const t = k => String(req.body[k] || '').trim().slice(0, 200) || null;
  const name = t('name');
  if (!name) return res.status(400).json({ error: 'Enter the supplier name.' });
  const { data: same } = await admin.from('suppliers').select('id, name').ilike('name', name.replace(/[%_,()]/g, ' ')).limit(5);
  const dup = (same || []).find(x => x.name.trim().toLowerCase() === name.toLowerCase());
  if (dup) return res.json({ id: dup.id, name: dup.name, existing: true });
  const { data, error } = await admin.from('suppliers').insert({ name, contact_name: t('contact_name'), email: t('email'), phone: t('phone'), wechat: t('wechat'), city: t('city'), country: t('country') || 'China' }).select('id, name').single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ id: data.id, name: data.name, existing: false });
});

// quick-add from the quote form (JSON): name is enough
r.post('/quick', async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Enter a product name.' });
  const num = v => (String(v ?? '').trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);
  const row = { name: name.slice(0, 200), sku: String(req.body.sku || '').trim().slice(0, 80) || null, supplier_id: req.body.supplier_id || null, supplier_sku: String(req.body.supplier_sku || '').trim().slice(0, 80) || null, description: String(req.body.description || '').trim().slice(0, 1000) || null,
    unit_cost: num(req.body.unit_cost), cost_currency: ['CNY', 'USD', 'EUR'].includes(req.body.cost_currency) ? req.body.cost_currency : 'CNY', moq: num(req.body.moq), hs_code: String(req.body.hs_code || '').trim().slice(0, 40) || null };
  const { data, error } = await admin.from('products').insert(row)
    .select('id, name, sku, supplier_sku, description, supplier_id, unit_cost, cost_currency, moq, hs_code, unit_weight_kg, carton_qty, carton_cbm').single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ---------- products submitted by suppliers (supplier portal "Add product") ----------
const SUB_TABS = [['submitted', 'To review'], ['edit_requested', 'Edit requests'], ['updated', 'Updated'], ['unlocked', 'Open for editing'], ['returned', 'Sent back'], ['draft', 'Drafts'], ['approved', 'Approved']];
// delete the ticked products (Admin / Director). A product used by an order, quote or request stays — only unused ones go.
r.post('/delete', async (req, res) => {
  const to = '/admin/products';
  if (!canAssign(req.user)) return back(res, to, { err: 'Only an Admin or Director can delete products.' });
  const ids = [].concat(req.body.ids || []).filter(v => /^[0-9a-f-]{36}$/i.test(v));
  if (!ids.length) return back(res, to, { err: 'Tick the products to delete.' });
  const { data: prods } = await admin.from('products').select('id, name').in('id', ids);
  const gone = [], kept = [];
  for (const p of prods || []) {
    const { error } = await admin.from('products').delete().eq('id', p.id);
    if (error) { kept.push(p.name); continue; }
    const { data: docs } = await admin.from('documents').select('id').eq('entity_type', 'product').eq('entity_id', p.id);
    for (const d of docs || []) await deleteDocument(d.id).catch(() => {});
    await log({ entityType: 'product', entityId: p.id, action: 'product_deleted', actorId: req.user.id, detail: { note: p.name } });
    gone.push(p.name);
  }
  const short = a => a.slice(0, 3).join(', ') + (a.length > 3 ? ` +${a.length - 3} more` : '');
  if (!gone.length) return back(res, to, { err: `Not deleted — ${short(kept)} ${kept.length > 1 ? 'are' : 'is'} used in orders, quotes or requests.` });
  back(res, to, { msg: `Deleted ${gone.length} product${gone.length > 1 ? 's' : ''}${kept.length ? `. Kept (used in orders, quotes or requests): ${short(kept)}` : ''}.` });
});
r.get('/submissions', async (req, res) => {
  const status = req.query.status === 'all' || SUB_TABS.some(t => t[0] === req.query.status) ? req.query.status : 'submitted';
  let rq = admin.from('supplier_products').select('id, status, data, submitted_at, updated_at, product_id, suppliers(id, name)').order('updated_at', { ascending: false });
  if (status !== 'all') rq = rq.eq('status', status);
  const [{ data: rows }, { data: all }] = await Promise.all([rq, admin.from('supplier_products').select('status')]);
  const counts = { all: (all || []).length }; (all || []).forEach(x => { counts[x.status] = (counts[x.status] || 0) + 1; });
  res.render('admin/products/submissions', { title: 'Supplier products', rows: rows || [], status, counts, tabs: [['all', 'All'], ...SUB_TABS], labels: Object.fromEntries(SUB_TABS), miss: x => subMissing(x.data, (x.data.photo_ids || []).length) });
});

r.get('/submissions/:id', async (req, res) => {
  const { data: sub } = await admin.from('supplier_products').select('*, suppliers(id, name, city, country, contact_name, email)').eq('id', req.params.id).maybeSingle();
  if (!sub) return notFound(res, 'Submission');
  const d = { ...cleanSub({}), ...sub.data };
  const ids = (d.photo_ids || []).filter(Boolean);
  const { data: docs } = ids.length ? await admin.from('documents').select('id, title').in('id', ids) : { data: [] };
  // same supplier SKU already on file?
  const dup = d.sku && !sub.product_id ? (await admin.from('products').select('id, name').eq('supplier_id', sub.supplier_id).ilike('supplier_sku', d.sku.replace(/[%_]/g, c => '\\' + c)).limit(1)).data?.[0] || null : null;
  let prod = null, diff = [];
  if (sub.product_id) {
    prod = (await admin.from('products').select('*').eq('id', sub.product_id).maybeSingle()).data;
    if (prod && ['updated', 'edit_requested', 'unlocked'].includes(sub.status)) diff = changes(fromProduct(prod), d);
  }
  res.render('admin/products/submission', { title: d.name || 'Submission', sub, d, prod, diff, photos: docs || [], miss: subMissing(d, (docs || []).length), fit: containerFit(d), sameSku: dup, msg: req.query.msg, err: req.query.err });
});

r.post('/submissions/:id/approve', async (req, res) => {
  const { data: sub } = await admin.from('supplier_products').select('*').eq('id', req.params.id).maybeSingle();
  if (!sub) return notFound(res, 'Submission');
  if (sub.status === 'approved' && sub.product_id) return res.redirect(`/admin/products/${sub.product_id}`);
  if (sub.status !== 'submitted') return back(res, `/admin/products/submissions/${sub.id}`, { err: 'Only submitted products can be approved.' });
  const d = { ...cleanSub({}), ...sub.data };
  const { data: prod, error } = await admin.from('products').insert(toProduct(d, sub.supplier_id)).select('id').single();
  if (error) return back(res, `/admin/products/submissions/${sub.id}`, { err: error.message });
  // the supplier's photos become the product's photos
  const ids = (d.photo_ids || []).filter(Boolean);
  if (ids.length) await admin.from('documents').update({ entity_type: 'product', entity_id: prod.id, client_visible: true }).in('id', ids);
  await admin.from('supplier_products').update({ status: 'approved', product_id: prod.id, decided_at: new Date().toISOString(), decided_by: req.user.id, review_note: null, updated_at: new Date().toISOString() }).eq('id', sub.id);
  await log({ entityType: 'supplier', entityId: sub.supplier_id, action: 'product_approved', actorId: req.user.id, detail: { note: d.name } });
  res.redirect(`/admin/products/${prod.id}?msg=` + encodeURIComponent('Approved — the product is now in your list.'));
});

r.post('/submissions/:id/return', async (req, res) => {
  const { data: sub } = await admin.from('supplier_products').select('id, supplier_id, status, data').eq('id', req.params.id).maybeSingle();
  if (!sub) return notFound(res, 'Submission');
  const note = String(req.body.note || '').trim().slice(0, 1000);
  if (!note) return back(res, `/admin/products/submissions/${sub.id}`, { err: 'Write what the supplier should fix.' });
  if (!['submitted', 'updated'].includes(sub.status)) return back(res, `/admin/products/submissions/${sub.id}`, { err: 'Only submitted products can be sent back.' });
  await admin.from('supplier_products').update({ status: sub.status === 'updated' ? 'unlocked' : 'returned', review_note: note, decided_at: new Date().toISOString(), decided_by: req.user.id, updated_at: new Date().toISOString() }).eq('id', sub.id);
  await log({ entityType: 'supplier', entityId: sub.supplier_id, action: 'product_returned', actorId: req.user.id, detail: { note: `${sub.data?.name || 'product'}: ${note}` } });
  res.redirect('/admin/products/submissions?msg=' + encodeURIComponent('Sent back to the supplier.'));
});

// ---- changing a product that is already in the catalog: supplier asks → staff release → supplier edits ("updated") → staff apply ----
const subRow = async id => (await admin.from('supplier_products').select('*').eq('id', id).maybeSingle()).data;
const setSub = (id, patch) => admin.from('supplier_products').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
r.post('/submissions/:id/release', async (req, res) => {
  const sub = await subRow(req.params.id);
  if (!sub) return notFound(res, 'Submission');
  if (sub.status !== 'edit_requested') return back(res, `/admin/products/submissions/${sub.id}`, { err: 'Nothing to release.' });
  await setSub(sub.id, { status: 'unlocked', review_note: null, decided_at: new Date().toISOString(), decided_by: req.user.id });
  await log({ entityType: 'supplier', entityId: sub.supplier_id, action: 'product_edit_released', actorId: req.user.id, detail: { note: sub.data?.name } });
  res.redirect(`/admin/products/submissions/${sub.id}?msg=` + encodeURIComponent('Released — the supplier can edit this product now.'));
});
r.post('/submissions/:id/decline', async (req, res) => {
  const sub = await subRow(req.params.id);
  if (!sub) return notFound(res, 'Submission');
  if (!['edit_requested', 'unlocked'].includes(sub.status)) return back(res, `/admin/products/submissions/${sub.id}`, { err: 'Nothing to decline.' });
  const note = String(req.body.note || '').trim().slice(0, 500);
  await setSub(sub.id, { status: 'approved', edit_reason: null, review_note: note || null, decided_at: new Date().toISOString(), decided_by: req.user.id });
  await log({ entityType: 'supplier', entityId: sub.supplier_id, action: 'product_edit_declined', actorId: req.user.id, detail: { note: sub.data?.name } });
  res.redirect('/admin/products/submissions?msg=' + encodeURIComponent(sub.status === 'unlocked' ? 'Locked again.' : 'Request declined.'));
});
r.post('/submissions/:id/apply', async (req, res) => {
  const sub = await subRow(req.params.id);
  if (!sub) return notFound(res, 'Submission');
  if (sub.status !== 'updated' || !sub.product_id) return back(res, `/admin/products/submissions/${sub.id}`, { err: 'Only updated products can be applied.' });
  const d = { ...cleanSub({}), ...sub.data };
  const { supplier_id, ...fields } = toProduct(d, sub.supplier_id);
  const { error } = await admin.from('products').update(fields).eq('id', sub.product_id);
  if (error) return back(res, `/admin/products/submissions/${sub.id}`, { err: error.message });
  // photos: the supplier's list is the truth — new ones join the product, removed ones are deleted
  const keep = (d.photo_ids || []).filter(Boolean);
  const { data: have } = await admin.from('documents').select('id').eq('entity_type', 'product').eq('entity_id', sub.product_id).eq('kind', 'product_photo');
  for (const x of have || []) if (!keep.includes(x.id)) await deleteDocument(x.id);
  const fresh = keep.filter(id => !(have || []).some(x => x.id === id));
  if (fresh.length) await admin.from('documents').update({ entity_type: 'product', entity_id: sub.product_id, client_visible: true }).in('id', fresh);
  await setSub(sub.id, { status: 'approved', edit_reason: null, review_note: null, decided_at: new Date().toISOString(), decided_by: req.user.id });
  await log({ entityType: 'supplier', entityId: sub.supplier_id, action: 'product_update_applied', actorId: req.user.id, detail: { note: d.name } });
  res.redirect(`/admin/products/${sub.product_id}?msg=` + encodeURIComponent('Changes applied to the product.'));
});

r.get('/:id', async (req, res) => {
  const id = req.params.id;
  const [{ data: p }, { data: docs }, { data: quotes }] = await Promise.all([
    admin.from('products').select('*, suppliers(*)').eq('id', id).single(),
    admin.from('documents').select('*').eq('entity_type', 'product').eq('entity_id', id).order('created_at', { ascending: false }),
    admin.from('quotes').select('id, quantity, unit_cost, cost_currency, unit_price, sell_currency, margin_pct, status, created_at, requests(id, ref, organizations(name))')
      .eq('product_id', id).order('created_at', { ascending: false }).limit(20),
  ]);
  if (!p) return notFound(res, 'Product');
  res.render('admin/products/detail', { title: p.name, p, docs: docs || [], quotes: quotes || [], specText: specText(p.spec) });
});

r.get('/:id/edit', async (req, res) => {
  const { data: p } = await admin.from('products').select('*').eq('id', req.params.id).single();
  if (!p) return notFound(res, 'Product');
  res.render('admin/products/form', { title: 'Edit product', p, specText: specText(p.spec), suppliers: await formData(), photos: await productPhotos(p.id), error: null });
});
r.post('/:id', withPhotos, async (req, res) => {
  const id = req.params.id;
  const again = async error => res.status(400).render('admin/products/form', { title: 'Edit product', p: { ...req.body, id }, specText: req.body.spec, suppliers: await formData(),
    photos: await productPhotos(id), error: `${error}${req.files?.length ? ' Please add the new photos again.' : ''}` });
  if (req.photoError) return again(req.photoError);
  const { error } = await admin.from('products').update(body(req.body)).eq('id', id);
  if (error) return again(error.message);
  // photos ticked for removal (only this product's photos)
  const remove = [].concat(req.body.remove_photo || []);
  if (remove.length) {
    const { data: own } = await admin.from('documents').select('id').eq('entity_type', 'product').eq('entity_id', id).in('id', remove);
    for (const d of own || []) await deleteDocument(d.id);
  }
  await savePhotos(req, id);
  res.redirect(`/admin/products/${id}`);
});

export default r;
