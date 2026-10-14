import { Router } from '../../lib/router.js';
import { admin } from '../../lib/supabase.js';
import { clean, bool, notFound } from '../../lib/util.js';
import { inviteUser, memberRows } from '../../lib/invites.js';
import { log } from '../../lib/activity.js';
import { COMPANY_TYPES } from '../../lib/supplier-company.js';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** Placeholder name until the supplier fills in their company details. */
export const placeholderName = email => `(${String(email).split('@')[1] || email})`;

const r = Router();
const FIELDS = ['name', 'country', 'city', 'address', 'contact_name', 'phone', 'email', 'wechat', 'website', 'payment_terms', 'lead_time_days', 'rating', 'can_export_official', 'notes',
  'company_type', 'main_products', 'certifications', 'registration_no', 'postal_code', 'year_established', 'employees'];
const body = b => ({ ...clean(b, FIELDS), can_export_official: bool(b.can_export_official) });
const like = q => String(q || '').replace(/[,()%]/g, ' ').trim();

r.get('/', async (req, res) => {
  let q = admin.from('suppliers').select('*, products(count), orders(count)').order('name');
  const s = like(req.query.q);
  if (s) q = q.or(`name.ilike.%${s}%,city.ilike.%${s}%,contact_name.ilike.%${s}%`);
  const [{ data }, { data: users }, { data: invites }] = await Promise.all([
    q,
    admin.from('profiles').select('supplier_id, accepted_at, active').eq('role', 'supplier'),
    admin.from('invitations').select('supplier_id, expires_at').eq('role', 'supplier').is('accepted_at', null).is('revoked_at', null),
  ]);
  // portal status per supplier: active users, open invitation, or nothing
  const portal = {};
  for (const u of users || []) if (u.supplier_id && u.accepted_at && u.active) portal[u.supplier_id] = 'active';
  for (const i of invites || []) if (i.supplier_id && !portal[i.supplier_id]) portal[i.supplier_id] = new Date(i.expires_at) > new Date() ? 'invited' : 'expired';
  res.render('admin/suppliers/index', { title: 'Suppliers', suppliers: data || [], portal });
});

r.get('/new', (req, res) => res.render('admin/suppliers/form', {
  title: 'New supplier', s: { country: 'China' }, error: null, mode: req.query.mode === 'manual' ? 'manual' : 'invite', inv: {},
}));
r.post('/', async (req, res) => {
  const { data, error } = await admin.from('suppliers').insert(body(req.body)).select('id').single();
  if (error) return res.render('admin/suppliers/form', { title: 'New supplier', s: req.body, error: error.message, mode: 'manual', inv: {} });
  res.redirect(`/admin/suppliers/${data.id}`);
});

// Add a supplier by inviting them: they confirm the email, fill in company + personal details and create a password.
r.post('/invite', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const name = String(req.body.name || '').trim();
  const contact = String(req.body.contact_name || '').trim();
  const again = error => res.status(400).render('admin/suppliers/form', { title: 'New supplier', s: { country: 'China' }, error, mode: 'invite', inv: req.body });
  if (!EMAIL.test(email)) return again('Enter the supplier’s email address.');
  const { data: dupe } = await admin.from('suppliers').select('id, name').ilike('email', email).limit(1).maybeSingle();
  if (dupe) return again(`${email} already belongs to supplier “${dupe.name}”. Open it and invite from there.`);
  const { data: sup, error } = await admin.from('suppliers')
    .insert({ name: name || placeholderName(email), email, contact_name: contact || null, country: 'China' }).select('id').single();
  if (error) return again(error.message);
  await log({ entityType: 'supplier', entityId: sup.id, action: 'supplier_invited', actorId: req.user.id, detail: { note: email } });
  if (!bool(req.body.send)) return res.redirect(`/admin/suppliers/${sup.id}?msg=` + encodeURIComponent('Supplier added. Send the invitation when you are ready.'));
  try {
    await inviteUser({ email, role: 'supplier', supplierId: sup.id, invitedBy: req.user.id });
    res.redirect(`/admin/suppliers/${sup.id}?msg=` + encodeURIComponent(`Invitation sent to ${email} — valid 14 days. The supplier fills in the company details.`));
  } catch (e) {
    res.redirect(`/admin/suppliers/${sup.id}?err=` + encodeURIComponent(`Supplier added, but the invitation was not sent: ${e.message}`));
  }
});

r.get('/:id', async (req, res) => {
  const id = req.params.id;
  const [{ data: s }, { data: products }, { data: orders }, { data: docs }, { data: users }, { data: invites }] = await Promise.all([
    admin.from('suppliers').select('*').eq('id', id).single(),
    admin.from('products').select('*').eq('supplier_id', id).order('name'),
    admin.from('order_overview').select('*').eq('supplier_id', id).order('created_at', { ascending: false }),
    admin.from('documents').select('*').eq('entity_type', 'supplier').eq('entity_id', id).order('created_at', { ascending: false }),
    admin.from('profiles').select('*').eq('supplier_id', id).order('created_at'),
    admin.from('invitations').select('*').eq('supplier_id', id),
  ]);
  if (!s) return notFound(res, 'Supplier');
  const spend = (orders || []).filter(o => o.status !== 'cancelled').reduce((t, o) => t + Number(o.cost_total || 0), 0);
  res.render('admin/suppliers/detail', {
    title: s.name, s, products: products || [], orders: orders || [], docs: docs || [], spend, types: COMPANY_TYPES,
    members: memberRows(users || [], invites || []), msg: req.query.msg, err: req.query.err,
  });
});

r.get('/:id/edit', async (req, res) => {
  const { data: s } = await admin.from('suppliers').select('*').eq('id', req.params.id).single();
  if (!s) return notFound(res, 'Supplier');
  res.render('admin/suppliers/form', { title: 'Edit supplier', s, error: null, mode: 'manual', inv: {} });
});
r.post('/:id', async (req, res) => {
  const { error } = await admin.from('suppliers').update(body(req.body)).eq('id', req.params.id);
  if (error) return res.render('admin/suppliers/form', { title: 'Edit supplier', s: { ...req.body, id: req.params.id }, error: error.message, mode: 'manual', inv: {} });
  res.redirect(`/admin/suppliers/${req.params.id}`);
});

// portal access for the supplier's people (several users per supplier)
r.post('/:id/invite', async (req, res) => {
  const { data: s } = await admin.from('suppliers').select('id').eq('id', req.params.id).single();
  if (!s) return notFound(res, 'Supplier');
  try {
    const result = await inviteUser({ email: req.body.email, role: 'supplier', supplierId: s.id, invitedBy: req.user.id });
    res.redirect(`/admin/suppliers/${s.id}?msg=` + encodeURIComponent(`${result.resent ? 'New invitation link sent' : 'Invitation sent'} to ${String(req.body.email).trim()} — valid 14 days.`));
  } catch (e) {
    res.redirect(`/admin/suppliers/${s.id}?err=` + encodeURIComponent(e.message));
  }
});

r.post('/:id/invites/cancel', async (req, res) => {
  const email = String(req.body.email || '').trim();
  await admin.from('invitations').update({ revoked_at: new Date().toISOString() })
    .eq('supplier_id', req.params.id).ilike('email', email).is('accepted_at', null).is('revoked_at', null);
  await admin.from('profiles').update({ active: false }).eq('supplier_id', req.params.id).ilike('email', email).is('accepted_at', null);
  res.redirect(`/admin/suppliers/${req.params.id}?msg=` + encodeURIComponent(`Invitation for ${email} cancelled.`));
});

r.post('/:id/users/:uid/toggle', async (req, res) => {
  const { data: p } = await admin.from('profiles').select('active').eq('id', req.params.uid).eq('supplier_id', req.params.id).single();
  if (p) await admin.from('profiles').update({ active: !p.active }).eq('id', req.params.uid);
  res.redirect(`/admin/suppliers/${req.params.id}`);
});

export default r;
