// Supplier portal: company details (required on first sign-in) and the supplier's own products.
// All reads go through the service client but are always filtered by the signed-in user's supplier_id.
import { Router } from '../lib/router.js';
import { admin } from '../lib/supabase.js';
import { requireSupplier } from '../middleware/auth.js';
import { log } from '../lib/activity.js';
import { signedUrl } from '../lib/storage.js';
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
  res.render('supplier/products', { title: 'My products', products: products || [], photoOf });
});

// product photos: only for this supplier's own products
r.get('/photos/:id', async (req, res) => {
  const { data: doc } = await admin.from('documents').select('storage_path, entity_type, entity_id').eq('id', req.params.id).maybeSingle();
  if (!doc || doc.entity_type !== 'product') return res.status(404).send('Not found');
  const { data: p } = await admin.from('products').select('supplier_id').eq('id', doc.entity_id).maybeSingle();
  if (p?.supplier_id !== req.user.supplier_id) return res.status(404).send('Not found');
  res.redirect(await signedUrl(doc.storage_path));
});

export default r;
