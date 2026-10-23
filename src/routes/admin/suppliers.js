import { Router } from '../../lib/router.js';
import { admin } from '../../lib/supabase.js';
import { clean, bool, notFound, getSettings } from '../../lib/util.js';
import { defaultCurrency, sumIn } from '../../lib/currency.js';
import { requireAdmin } from '../../middleware/auth.js';
import { ACTIVITY_TYPES as BASE_TYPES, readActivity, withLastLogin } from '../../lib/crm.js';
import { inviteUser, memberRows, stashInvite, takeInvite, wantsLinkOnly } from '../../lib/invites.js';
import { log } from '../../lib/activity.js';
import { COMPANY_TYPES } from '../../lib/supplier-company.js';
import { usageSummary, setCompanyAi } from '../../lib/ai-access.js';
import { getPrices } from '../../lib/ai-usage.js';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** Placeholder name until the supplier fills in their company details. */
export const placeholderName = email => `(${String(email).split('@')[1] || email})`;

const r = Router();
const FIELDS = ['name', 'country', 'city', 'address', 'contact_name', 'phone', 'email', 'wechat', 'website', 'payment_terms', 'lead_time_days', 'rating', 'can_export_official', 'notes',
  'company_type', 'main_products', 'certifications', 'registration_no', 'postal_code', 'year_established', 'employees', 'crm_status', 'next_follow_up'];
export const CRM_STATUSES = { prospect: 'Prospect', contacted: 'Contacted', sampling: 'Sampling', approved: 'Approved', active: 'Active supplier', on_hold: 'On hold', blocked: 'Blocked' };
export const ACTIVITY_TYPES = { ...BASE_TYPES, visit: 'Factory visit' };
const body = b => ({ ...clean(b, FIELDS), can_export_official: bool(b.can_export_official) });
const like = q => String(q || '').replace(/[,()%]/g, ' ').trim();

r.get('/', async (req, res) => {
  let q = admin.from('suppliers').select('*, products(count), orders(count)').order('name');
  const s = like(req.query.q);
  if (s) q = q.or(`name.ilike.%${s}%,city.ilike.%${s}%,contact_name.ilike.%${s}%,email.ilike.%${s}%,main_products.ilike.%${s}%`);
  const [{ data }, { data: users }, { data: invites }] = await Promise.all([
    q,
    admin.from('profiles').select('supplier_id, accepted_at, active').eq('role', 'supplier'),
    admin.from('invitations').select('supplier_id, expires_at').eq('role', 'supplier').is('accepted_at', null).is('revoked_at', null),
  ]);
  // portal status per supplier: active users, open invitation, or nothing
  const portal = {};
  for (const u of users || []) if (u.supplier_id && u.accepted_at && u.active) portal[u.supplier_id] = 'active';
  for (const i of invites || []) if (i.supplier_id && !portal[i.supplier_id]) portal[i.supplier_id] = new Date(i.expires_at) > new Date() ? 'invited' : 'expired';
  const all = data || [];
  const counts = { all: all.length };
  for (const x of all) counts[x.crm_status || 'active'] = (counts[x.crm_status || 'active'] || 0) + 1;
  const today = new Date().toISOString().slice(0, 10);
  counts.followup = all.filter(x => x.next_follow_up && x.next_follow_up <= today).length;
  const status = req.query.status || 'all';
  const list = status === 'all' ? all : status === 'followup' ? all.filter(x => x.next_follow_up && x.next_follow_up <= today) : all.filter(x => (x.crm_status || 'active') === status);
  res.render('admin/suppliers/index', { title: 'Suppliers', suppliers: list, portal, counts, status, crmStatuses: CRM_STATUSES, today, msg: req.query.msg });
});

// change the CRM status straight from the list
r.post('/:id/status', async (req, res) => {
  if (CRM_STATUSES[req.body.crm_status]) {
    const { data: before } = await admin.from('suppliers').select('crm_status').eq('id', req.params.id).single();
    await admin.from('suppliers').update({ crm_status: req.body.crm_status }).eq('id', req.params.id);
    if (before && before.crm_status !== req.body.crm_status) {
      await log({ entityType: 'supplier', entityId: req.params.id, action: 'crm_status', actorId: req.user.id, detail: { note: `${CRM_STATUSES[before.crm_status] || before.crm_status} → ${CRM_STATUSES[req.body.crm_status]}` } });
    }
  }
  const backTo = String(req.body.back || '');
  res.redirect(backTo.startsWith('/admin/suppliers') ? backTo : '/admin/suppliers');
});

r.get('/new', (req, res) => res.render('admin/suppliers/form', {
  title: 'New supplier', s: { country: 'China', crm_status: 'prospect' }, error: null, mode: req.query.mode === 'manual' ? 'manual' : 'invite', inv: { crm_status: 'contacted' }, crmStatuses: CRM_STATUSES,
}));
r.post('/', async (req, res) => {
  const { data, error } = await admin.from('suppliers').insert(body(req.body)).select('id').single();
  if (error) return res.render('admin/suppliers/form', { title: 'New supplier', s: req.body, error: error.message, mode: 'manual', inv: {}, crmStatuses: CRM_STATUSES });
  res.redirect(`/admin/suppliers/${data.id}`);
});

// Add a supplier by inviting them: they confirm the email, fill in company + personal details and create a password.
r.post('/invite', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const name = String(req.body.name || '').trim();
  const contact = String(req.body.contact_name || '').trim();
  const again = error => res.status(400).render('admin/suppliers/form', { title: 'New supplier', s: { country: 'China' }, error, mode: 'invite', inv: req.body, crmStatuses: CRM_STATUSES });
  const crmStatus = CRM_STATUSES[req.body.crm_status] ? req.body.crm_status : 'contacted';
  if (!EMAIL.test(email)) return again('Enter the supplier’s email address.');
  const { data: dupe } = await admin.from('suppliers').select('id, name').ilike('email', email).limit(1).maybeSingle();
  if (dupe) return again(`${email} already belongs to supplier “${dupe.name}”. Open it and invite from there.`);
  const { data: sup, error } = await admin.from('suppliers')
    .insert({ name: name || placeholderName(email), email, contact_name: contact || null, country: 'China', crm_status: crmStatus }).select('id').single();
  if (error) return again(error.message);
  await log({ entityType: 'supplier', entityId: sup.id, action: 'supplier_invited', actorId: req.user.id, detail: { note: email } });
  if (!bool(req.body.send)) return res.redirect(`/admin/suppliers/${sup.id}?msg=` + encodeURIComponent('Supplier added. Send the invitation when you are ready.'));
  try {
    const r2 = await inviteUser({ email, role: 'supplier', supplierId: sup.id, invitedBy: req.user.id, mail: !wantsLinkOnly(req.body) });
    if (!r2.mailed) stashInvite(res, email, r2);
    res.redirect(`/admin/suppliers/${sup.id}?msg=` + encodeURIComponent(r2.mailed ? `Invitation sent to ${email} — valid 14 days. The supplier fills in the company details.` : `Invitation created for ${email} — copy the link below and send it yourself.`));
  } catch (e) {
    res.redirect(`/admin/suppliers/${sup.id}?err=` + encodeURIComponent(`Supplier added, but the invitation was not sent: ${e.message}`));
  }
});

r.get('/:id', async (req, res) => {
  const id = req.params.id;
  const [{ data: s }, { data: products }, { data: orders }, { data: docs }, { data: users }, { data: invites }, { data: events }] = await Promise.all([
    admin.from('suppliers').select('*').eq('id', id).single(),
    admin.from('products').select('*').eq('supplier_id', id).order('name'),
    admin.from('order_overview').select('*').eq('supplier_id', id).order('created_at', { ascending: false }),
    admin.from('documents').select('*').eq('entity_type', 'supplier').eq('entity_id', id).order('created_at', { ascending: false }),
    admin.from('profiles').select('*').eq('supplier_id', id).order('created_at'),
    admin.from('invitations').select('*').eq('supplier_id', id),
    admin.from('activity_log').select('*, profiles(full_name, email)').eq('entity_type', 'supplier').eq('entity_id', id).order('created_at', { ascending: false }).limit(50),
  ]);
  if (!s) return notFound(res, 'Supplier');
  await withLastLogin(users);
  const ids = (products || []).map(p => p.id);
  const { data: photos } = ids.length
    ? await admin.from('documents').select('id, entity_id').eq('entity_type', 'product').eq('kind', 'product_photo').in('entity_id', ids).order('created_at')
    : { data: [] };
  const photoOf = {};
  (photos || []).forEach(d => { photoOf[d.entity_id] ||= d.id; });
  const spend = sumIn(await getSettings(admin), await defaultCurrency(admin), (orders || []).filter(o => o.status !== 'cancelled').map(o => [o.cost_total, o.currency]));
  const members = memberRows(users || [], invites || []);
  const aiUse = await usageSummary('supplier', id);
  res.render('admin/suppliers/detail', {
    aiUse, aiPrices: await getPrices(), title: s.name, s, products: products || [], photoOf, orders: orders || [], docs: docs || [], spend, types: COMPANY_TYPES,
    members, events: events || [], crmStatuses: CRM_STATUSES, activityTypes: ACTIVITY_TYPES,
    portalBlocked: members.some(m => m.state === 'accepted') && !members.some(m => m.state === 'accepted' && m.active !== false),
    invShow: takeInvite(req, res), msg: req.query.msg, err: req.query.err,
  });
});

// CRM activity: a call, WeChat chat, visit… with an optional follow-up date
r.post('/:id/activity', async (req, res) => {
  const { type, summary, date, follow, error } = readActivity(req.body);
  if (error) return res.redirect(`/admin/suppliers/${req.params.id}?err=` + encodeURIComponent('Write a short summary of the activity.') + '#activity');
  await log({ entityType: 'supplier', entityId: req.params.id, action: `crm_${type}`, actorId: req.user.id, detail: { note: summary, date, follow_up: follow } });
  if (follow) await admin.from('suppliers').update({ next_follow_up: follow }).eq('id', req.params.id);
  res.redirect(`/admin/suppliers/${req.params.id}?msg=` + encodeURIComponent('Activity logged.') + '#activity');
});

// block / restore portal access for everyone at this supplier
r.post('/:id/portal', async (req, res) => {
  const block = req.body.action === 'block';
  await admin.from('profiles').update({ active: !block }).eq('supplier_id', req.params.id).not('accepted_at', 'is', null);
  if (block) await admin.from('invitations').update({ revoked_at: new Date().toISOString() }).eq('supplier_id', req.params.id).is('accepted_at', null).is('revoked_at', null);
  await log({ entityType: 'supplier', entityId: req.params.id, action: block ? 'portal_blocked' : 'portal_restored', actorId: req.user.id });
  res.redirect(`/admin/suppliers/${req.params.id}?msg=` + encodeURIComponent(block ? 'Portal access blocked for all users of this supplier.' : 'Portal access restored.'));
});

// delete — only while nothing depends on the supplier (orders / quotes keep their history)
r.post('/:id/delete', requireAdmin, async (req, res) => {
  const id = req.params.id;
  const [{ count: nOrders }, { count: nQuotes }] = await Promise.all([
    admin.from('orders').select('id', { count: 'exact', head: true }).eq('supplier_id', id),
    admin.from('quotes').select('id', { count: 'exact', head: true }).eq('supplier_id', id),
  ]);
  if (nOrders || nQuotes) return res.redirect(`/admin/suppliers/${id}?err=` + encodeURIComponent(`Can't delete: this supplier has ${nOrders || 0} order(s) and ${nQuotes || 0} quote(s). Set the status to “Blocked” instead.`));
  await admin.from('profiles').update({ active: false, supplier_id: null }).eq('supplier_id', id);
  const { error } = await admin.from('suppliers').delete().eq('id', id);
  if (error) return res.redirect(`/admin/suppliers/${id}?err=` + encodeURIComponent(error.message));
  res.redirect('/admin/suppliers?msg=' + encodeURIComponent('Supplier deleted. Its products were kept without a supplier.'));
});

r.get('/:id/edit', async (req, res) => {
  const { data: s } = await admin.from('suppliers').select('*').eq('id', req.params.id).single();
  if (!s) return notFound(res, 'Supplier');
  res.render('admin/suppliers/form', { title: 'Edit supplier', s, error: null, mode: 'manual', inv: {}, crmStatuses: CRM_STATUSES });
});
r.post('/:id/ai', requireAdmin, async (req, res) => {
  const on = req.body.ai_enabled === 'on';
  const { error } = await setCompanyAi('supplier', req.params.id, on);
  if (error) return res.redirect(`/admin/suppliers/${req.params.id}?err=` + encodeURIComponent(/ai_enabled/.test(error.message) ? 'Run supabase/migrations/0018_ai_access.sql first.' : error.message));
  await log({ entityType: 'supplier', entityId: req.params.id, action: on ? 'ai_enabled' : 'ai_disabled', actorId: req.user.id });
  res.redirect(`/admin/suppliers/${req.params.id}?msg=` + encodeURIComponent(`AI ${on ? 'switched on' : 'switched off'} for this supplier.`));
});
r.post('/:id', async (req, res) => {
  const { error } = await admin.from('suppliers').update(body(req.body)).eq('id', req.params.id);
  if (error) return res.render('admin/suppliers/form', { title: 'Edit supplier', s: { ...req.body, id: req.params.id }, error: error.message, mode: 'manual', inv: {}, crmStatuses: CRM_STATUSES });
  res.redirect(`/admin/suppliers/${req.params.id}?msg=` + encodeURIComponent('Details saved.'));
});

// portal access for the supplier's people (several users per supplier)
r.post('/:id/invite', async (req, res) => {
  const { data: s } = await admin.from('suppliers').select('id').eq('id', req.params.id).single();
  if (!s) return notFound(res, 'Supplier');
  try {
    const result = await inviteUser({ email: req.body.email, role: 'supplier', supplierId: s.id, invitedBy: req.user.id, mail: !wantsLinkOnly(req.body) });
    const to = String(req.body.email).trim();
    if (!result.mailed) stashInvite(res, to, result);
    res.redirect(`/admin/suppliers/${s.id}?msg=` + encodeURIComponent(result.mailed ? `${result.resent ? 'New invitation link sent' : 'Invitation sent'} to ${to} — valid 14 days.` : `Invitation ready for ${to} — copy the link below and send it yourself.`));
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
