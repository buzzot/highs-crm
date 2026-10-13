import { Router } from '../../lib/router.js';
import { admin } from '../../lib/supabase.js';
import { clean, notFound } from '../../lib/util.js';

const r = Router();
const FIELDS = ['sku', 'name', 'category', 'description', 'supplier_id', 'unit_cost', 'cost_currency', 'moq', 'hs_code', 'unit_weight_kg', 'carton_qty', 'carton_cbm', 'carton_weight_kg'];
const like = q => String(q || '').replace(/[,()%]/g, ' ').trim();

// spec is edited as "Key: value" lines and stored as JSON
const parseSpec = txt => Object.fromEntries(String(txt || '').split('\n').map(l => l.split(':')).filter(p => p.length > 1 && p[0].trim())
  .map(([k, ...v]) => [k.trim(), v.join(':').trim()]));
const specText = spec => Object.entries(spec || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
const body = b => ({ ...clean(b, FIELDS), spec: parseSpec(b.spec) });

async function formData() {
  const { data } = await admin.from('suppliers').select('id, name').order('name');
  return data || [];
}

r.get('/', async (req, res) => {
  let q = admin.from('products').select('*, suppliers(id, name)').order('name');
  const s = like(req.query.q);
  if (s) q = q.or(`name.ilike.%${s}%,sku.ilike.%${s}%,hs_code.ilike.%${s}%`);
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
  title: 'New product', p: { cost_currency: 'CNY', supplier_id: req.query.supplier_id }, specText: '', suppliers: await formData(), error: null,
}));
r.post('/', async (req, res) => {
  const { data, error } = await admin.from('products').insert(body(req.body)).select('id').single();
  if (error) return res.render('admin/products/form', { title: 'New product', p: req.body, specText: req.body.spec, suppliers: await formData(), error: error.message });
  res.redirect(`/admin/products/${data.id}`);
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
  res.render('admin/products/form', { title: 'Edit product', p, specText: specText(p.spec), suppliers: await formData(), error: null });
});
r.post('/:id', async (req, res) => {
  const { error } = await admin.from('products').update(body(req.body)).eq('id', req.params.id);
  if (error) return res.render('admin/products/form', { title: 'Edit product', p: { ...req.body, id: req.params.id }, specText: req.body.spec, suppliers: await formData(), error: error.message });
  res.redirect(`/admin/products/${req.params.id}`);
});

export default r;
