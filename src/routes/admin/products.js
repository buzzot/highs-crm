import { Router } from '../../lib/router.js';
import { admin } from '../../lib/supabase.js';
import multer from 'multer';
import { clean, notFound } from '../../lib/util.js';
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

r.get('/', async (req, res) => {
  let q = admin.from('products').select('*, suppliers(id, name)').order('name');
  const s = like(req.query.q);
  if (s) q = q.or(`name.ilike.%${s}%,sku.ilike.%${s}%,supplier_sku.ilike.%${s}%,hs_code.ilike.%${s}%`);
  if (req.query.category) q = q.eq('category', req.query.category);
  if (req.query.supplier) q = q.eq('supplier_id', req.query.supplier);
  const [{ data }, { data: cats }, suppliers] = await Promise.all([q, admin.from('products').select('category'), formData()]);
  const categories = [...new Set((cats || []).map(c => c.category).filter(Boolean))].sort();
  // first photo per product for thumbnails
  const ids = (data || []).map(p => p.id);
  const { data: photos } = ids.length
    ? await admin.from('documents').select('id, entity_id').eq('entity_type', 'product').eq('kind', 'product_photo').in('entity_id', ids)
    : { data: [] };
  const thumb = {};
  (photos || []).forEach(p => { thumb[p.entity_id] ||= p.id; });
  res.render('admin/products/index', { title: 'Products', products: data || [], categories, suppliers, thumb });
});

r.get('/new', async (req, res) => res.render('admin/products/form', {
  title: 'New product', p: { cost_currency: 'CNY', supplier_id: req.query.supplier_id }, specText: '', suppliers: await formData(), photos: [], error: null,
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
