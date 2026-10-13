import { Router } from '../../lib/router.js';
import { admin } from '../../lib/supabase.js';
import { clean, bool, notFound } from '../../lib/util.js';

const r = Router();
const FIELDS = ['name', 'country', 'city', 'address', 'contact_name', 'phone', 'email', 'wechat', 'website', 'payment_terms', 'lead_time_days', 'rating', 'can_export_official', 'notes'];
const body = b => ({ ...clean(b, FIELDS), can_export_official: bool(b.can_export_official) });
const like = q => String(q || '').replace(/[,()%]/g, ' ').trim();

r.get('/', async (req, res) => {
  let q = admin.from('suppliers').select('*, products(count), orders(count)').order('name');
  const s = like(req.query.q);
  if (s) q = q.or(`name.ilike.%${s}%,city.ilike.%${s}%,contact_name.ilike.%${s}%`);
  const { data } = await q;
  res.render('admin/suppliers/index', { title: 'Suppliers', suppliers: data || [] });
});

r.get('/new', (req, res) => res.render('admin/suppliers/form', { title: 'New supplier', s: { country: 'China' }, error: null }));
r.post('/', async (req, res) => {
  const { data, error } = await admin.from('suppliers').insert(body(req.body)).select('id').single();
  if (error) return res.render('admin/suppliers/form', { title: 'New supplier', s: req.body, error: error.message });
  res.redirect(`/admin/suppliers/${data.id}`);
});

r.get('/:id', async (req, res) => {
  const id = req.params.id;
  const [{ data: s }, { data: products }, { data: orders }, { data: docs }] = await Promise.all([
    admin.from('suppliers').select('*').eq('id', id).single(),
    admin.from('products').select('*').eq('supplier_id', id).order('name'),
    admin.from('order_overview').select('*').eq('supplier_id', id).order('created_at', { ascending: false }),
    admin.from('documents').select('*').eq('entity_type', 'supplier').eq('entity_id', id).order('created_at', { ascending: false }),
  ]);
  if (!s) return notFound(res, 'Supplier');
  const spend = (orders || []).filter(o => o.status !== 'cancelled').reduce((t, o) => t + Number(o.cost_total || 0), 0);
  res.render('admin/suppliers/detail', { title: s.name, s, products: products || [], orders: orders || [], docs: docs || [], spend });
});

r.get('/:id/edit', async (req, res) => {
  const { data: s } = await admin.from('suppliers').select('*').eq('id', req.params.id).single();
  if (!s) return notFound(res, 'Supplier');
  res.render('admin/suppliers/form', { title: 'Edit supplier', s, error: null });
});
r.post('/:id', async (req, res) => {
  const { error } = await admin.from('suppliers').update(body(req.body)).eq('id', req.params.id);
  if (error) return res.render('admin/suppliers/form', { title: 'Edit supplier', s: { ...req.body, id: req.params.id }, error: error.message });
  res.redirect(`/admin/suppliers/${req.params.id}`);
});

export default r;
