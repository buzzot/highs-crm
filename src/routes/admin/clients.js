import { Router } from '../../lib/router.js';
import { admin } from '../../lib/supabase.js';
import { inviteUser, memberRows } from '../../lib/invites.js';
import { requireAdmin } from '../../middleware/auth.js';

const r = Router();
const clean = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === '' ? null : v]));

// staff management (admin only) lives here too (declared before /:id so it isn't shadowed)
r.get('/staff/list', requireAdmin, async (req, res) => {
  const [{ data }, { data: invites }] = await Promise.all([
    admin.from('profiles').select('*').in('role', ['admin', 'staff']).order('created_at'),
    admin.from('invitations').select('*').in('role', ['admin', 'staff']),
  ]);
  res.render('admin/clients/staff', { title: 'Staff', staff: memberRows(data || [], invites || []), msg: req.query.msg, err: req.query.err });
});
r.post('/staff/invite', requireAdmin, async (req, res) => {
  try {
    const role = req.body.role === 'admin' ? 'admin' : req.body.role === 'staff' ? 'staff' : null;
    const { data: cur } = role ? { data: null } : await admin.from('invitations').select('role').ilike('email', String(req.body.email).trim()).order('created_at', { ascending: false }).limit(1).maybeSingle();
    await inviteUser({ email: req.body.email, role: role || cur?.role || 'staff', invitedBy: req.user.id });
    res.redirect('/admin/clients/staff/list?msg=' + encodeURIComponent(`Invitation sent to ${req.body.email} — valid 14 days.`));
  } catch (e) { res.redirect('/admin/clients/staff/list?err=' + encodeURIComponent(e.message)); }
});


r.get('/', async (req, res) => {
  const { data } = await admin.from('organizations').select('*, profiles!profiles_org_id_fkey(count), orders(count), requests(count)').order('name');
  res.render('admin/clients/index', { title: 'Clients', clients: data || [] });
});

r.get('/new', (req, res) => res.render('admin/clients/form', { title: 'New client', org: {}, error: null }));
r.post('/', async (req, res) => {
  const { data, error } = await admin.from('organizations').insert(clean(req.body)).select().single();
  if (error) return res.render('admin/clients/form', { title: 'New client', org: req.body, error: error.message });
  res.redirect(`/admin/clients/${data.id}`);
});

r.get('/:id', async (req, res) => {
  const [{ data: client }, { data: users }, { data: invites }, { data: requests }, { data: orders }] = await Promise.all([
    admin.from('organizations').select('*').eq('id', req.params.id).single(),
    admin.from('profiles').select('*').eq('org_id', req.params.id).order('created_at'),
    admin.from('invitations').select('*').eq('org_id', req.params.id),
    admin.from('requests').select('*').eq('org_id', req.params.id).order('created_at', { ascending: false }),
    admin.from('order_overview').select('*').eq('org_id', req.params.id).order('created_at', { ascending: false }),
  ]);
  if (!client) return res.status(404).render('error', { title: 'Not found', message: 'Client not found.' });
  res.render('admin/clients/detail', { title: client.name, org: client, members: memberRows(users || [], invites || []), requests: requests || [], orders: orders || [], msg: req.query.msg, err: req.query.err });
});

r.get('/:id/edit', async (req, res) => {
  const { data: client } = await admin.from('organizations').select('*').eq('id', req.params.id).single();
  res.render('admin/clients/form', { title: 'Edit client', org: client, error: null });
});
r.post('/:id', async (req, res) => {
  const { error } = await admin.from('organizations').update(clean(req.body)).eq('id', req.params.id);
  if (error) return res.render('admin/clients/form', { title: 'Edit client', org: { ...req.body, id: req.params.id }, error: error.message });
  res.redirect(`/admin/clients/${req.params.id}`);
});

// invite a user into this client (multiple users per client supported)
r.post('/:id/invite', async (req, res) => {
  try {
    const result = await inviteUser({ email: req.body.email, role: 'client', orgId: req.params.id, invitedBy: req.user.id });
    res.redirect(`/admin/clients/${req.params.id}?msg=` + encodeURIComponent(`${result.resent ? 'New invitation link sent' : 'Invitation sent'} to ${String(req.body.email).trim()} — valid 14 days.`));
  } catch (e) {
    res.redirect(`/admin/clients/${req.params.id}?err=` + encodeURIComponent(e.message));
  }
});

// cancel an open invitation (the link stops working; a login that never set a password is disabled)
r.post('/:id/invites/cancel', async (req, res) => {
  const email = String(req.body.email || '').trim();
  await admin.from('invitations').update({ revoked_at: new Date().toISOString() })
    .eq('org_id', req.params.id).ilike('email', email).is('accepted_at', null).is('revoked_at', null);
  await admin.from('profiles').update({ active: false }).eq('org_id', req.params.id).ilike('email', email).is('accepted_at', null);
  res.redirect(`/admin/clients/${req.params.id}?msg=` + encodeURIComponent(`Invitation for ${email} cancelled.`));
});

r.post('/:id/users/:uid/toggle', async (req, res) => {
  const { data: p } = await admin.from('profiles').select('active').eq('id', req.params.uid).single();
  await admin.from('profiles').update({ active: !p.active }).eq('id', req.params.uid);
  res.redirect(`/admin/clients/${req.params.id}`);
});

export default r;
