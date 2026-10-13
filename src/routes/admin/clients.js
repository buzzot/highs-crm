import { Router } from '../../lib/router.js';
import { admin } from '../../lib/supabase.js';
import { inviteUser } from '../../lib/invites.js';
import { requireAdmin } from '../../middleware/auth.js';

const r = Router();
const clean = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === '' ? null : v]));

// staff management (admin only) lives here too (declared before /:id so it isn't shadowed)
r.get('/staff/list', requireAdmin, async (req, res) => {
  const { data } = await admin.from('profiles').select('*').in('role', ['admin', 'staff']).order('created_at');
  res.render('admin/clients/staff', { title: 'Staff', staff: data || [], msg: req.query.msg, err: req.query.err });
});
r.post('/staff/invite', requireAdmin, async (req, res) => {
  try {
    await inviteUser({ email: req.body.email, role: req.body.role === 'admin' ? 'admin' : 'staff', invitedBy: req.user.id });
    res.redirect('/admin/clients/staff/list?msg=Invitation+sent');
  } catch (e) { res.redirect('/admin/clients/staff/list?err=' + encodeURIComponent(e.message)); }
});


r.get('/', async (req, res) => {
  const { data } = await admin.from('organizations').select('*, profiles(count), orders(count), requests(count)').order('name');
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
    admin.from('invitations').select('*').eq('org_id', req.params.id).is('accepted_at', null).order('created_at', { ascending: false }),
    admin.from('requests').select('*').eq('org_id', req.params.id).order('created_at', { ascending: false }),
    admin.from('order_overview').select('*').eq('org_id', req.params.id).order('created_at', { ascending: false }),
  ]);
  if (!client) return res.status(404).render('error', { title: 'Not found', message: 'Client not found.' });
  res.render('admin/clients/detail', { title: client.name, org: client, users: users || [], invites: invites || [], requests: requests || [], orders: orders || [], msg: req.query.msg, err: req.query.err });
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
    res.redirect(`/admin/clients/${req.params.id}?msg=` + encodeURIComponent(result.reinvited ? 'Existing user attached and sent a sign-in link.' : `Invitation sent to ${req.body.email}.`));
  } catch (e) {
    res.redirect(`/admin/clients/${req.params.id}?err=` + encodeURIComponent(e.message));
  }
});

r.post('/:id/users/:uid/toggle', async (req, res) => {
  const { data: p } = await admin.from('profiles').select('active').eq('id', req.params.uid).single();
  await admin.from('profiles').update({ active: !p.active }).eq('id', req.params.uid);
  res.redirect(`/admin/clients/${req.params.id}`);
});

export default r;
