import { Router } from '../../lib/router.js';
import { admin } from '../../lib/supabase.js';
import { clean, bool, notFound, getSettings } from '../../lib/util.js';
import { defaultCurrency, sumIn } from '../../lib/currency.js';
import { requireAdmin } from '../../middleware/auth.js';
import { ACTIVITY_TYPES as BASE_TYPES, validateActivity, withLastLogin } from '../../lib/crm.js';
import { levelOf } from '../../lib/access.js';
import { validateSupplier, supplierPatch, mergeFollowUp, purchasingRows, deleteConfirmed } from '../../lib/supplier-detail.js';
import { inviteUser, memberRows, stashInvite, takeInvite, wantsLinkOnly } from '../../lib/invites.js';
import { log } from '../../lib/activity.js';
import { COMPANY_TYPES } from '../../lib/supplier-company.js';
import { usageSummary, setCompanyAi } from '../../lib/ai-access.js';
import { getPrices } from '../../lib/ai-usage.js';
import { buildSuppliers, portalMap } from '../../lib/suppliers.js';

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

// every row, page by page — a directory must never be cut short by the API's row limit
async function fetchAll(make) {
  const out = [];
  for (let from = 0; from < 100000; from += 1000) {
    const { data, error } = await make().range(from, from + 999);
    if (error || !data) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

r.get('/', async (req, res) => {
  const safe = async f => { try { return await f(); } catch { return []; } };
  const [suppliers, { data: users }, { data: invites }, products, pos] = await Promise.all([
    fetchAll(() => admin.from('suppliers').select('*').order('name').order('id')),
    admin.from('profiles').select('supplier_id, accepted_at, active, full_name, email').eq('role', 'supplier'),
    admin.from('invitations').select('supplier_id, expires_at').eq('role', 'supplier').is('accepted_at', null).is('revoked_at', null),
    safe(() => fetchAll(() => admin.from('products').select('id, supplier_id, name, category').not('supplier_id', 'is', null).order('id'))),
    // purchase orders to each supplier (any status); a Manager only sees the ones they created, like on the Purchasing page
    safe(() => fetchAll(() => admin.from('supplier_pos').select('id, supplier_id').not('supplier_id', 'is', null).order('id'))),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const q = req.query;
  // ?status= is the relationship filter; an old ?status=followup link opens the Follow-up due view
  const view = q.view === 'followup' || q.status === 'followup' ? 'followup' : q.view === 'invites' ? 'invites' : 'all';
  const rel = CRM_STATUSES[q.status] ? q.status : '', pf = ['active', 'invited', 'expired', 'none'].includes(q.portal) ? q.portal : '';
  const list = buildSuppliers({ suppliers, portal: portalMap(users || [], invites || []), products, pos, people: (users || []).filter(u => u.accepted_at), crmOrder: Object.keys(CRM_STATUSES) },
    { q: q.q, view, status: rel, portal: pf, sort: q.sort || (view === 'followup' ? 'followup' : ''), dir: q.dir }, today);
  res.render('admin/suppliers/index', { title: 'Suppliers', ...list, status: rel, crmStatuses: CRM_STATUSES, today, msg: q.msg, query: { q: q.q || '', status: rel, portal: pf } });
});

// change the relationship status straight from the list (same permission as editing the supplier: any staff member)
r.post('/:id/status', async (req, res) => {
  const backTo = String(req.body.back || '');
  const to = (m, k = 'msg') => {
    const u = new URL(backTo.startsWith('/admin/suppliers') && !backTo.startsWith('//') ? backTo : '/admin/suppliers', 'http://x');
    u.searchParams.delete('msg'); u.searchParams.delete('err'); u.searchParams.set(k, m);
    res.redirect(u.pathname + u.search);
  };
  const want = req.body.crm_status;
  if (!CRM_STATUSES[want]) return to('That relationship status does not exist.', 'err');
  const { data: before } = await admin.from('suppliers').select('name, crm_status').eq('id', req.params.id).maybeSingle();
  if (!before) return to('Supplier not found.', 'err');
  const was = before.crm_status || 'active';
  if (was === want) return to(`${before.name} is already “${CRM_STATUSES[want]}”.`);
  const { error } = await admin.from('suppliers').update({ crm_status: want }).eq('id', req.params.id);
  if (error) return to(error.message, 'err');
  await log({ entityType: 'supplier', entityId: req.params.id, action: 'crm_status', actorId: req.user.id, detail: { note: `${CRM_STATUSES[was] || was} → ${CRM_STATUSES[want]}` } });
  to(`${before.name}: ${CRM_STATUSES[was] || was} → ${CRM_STATUSES[want]}.`);
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

const EVENT_LIMIT = 200;
const isId = v => /^[0-9a-f-]{36}$/i.test(v || '');
const safeRows = async f => { try { const { data, error } = await f(); return error ? [] : data || []; } catch { return []; } };

async function renderDetail(req, res, extra = {}) {
  const id = req.params.id;
  if (!isId(id)) return notFound(res, 'Supplier');
  const [{ data: s }, { data: products }, pos, { data: docs }, { data: users }, { data: invites }, { data: events }, submitted] = await Promise.all([
    admin.from('suppliers').select('*').eq('id', id).single(),
    admin.from('products').select('*').eq('supplier_id', id).order('name'),
    // purchase orders placed with this supplier (a Manager only sees the ones they created, like on the Purchasing page)
    safeRows(() => admin.from('supplier_pos').select('*').eq('supplier_id', id).order('created_at', { ascending: false }).limit(300)),
    admin.from('documents').select('*').eq('entity_type', 'supplier').eq('entity_id', id).order('created_at', { ascending: false }),
    admin.from('profiles').select('*').eq('supplier_id', id).order('created_at'),
    admin.from('invitations').select('*').eq('supplier_id', id),
    admin.from('activity_log').select('*, profiles(full_name, email)').eq('entity_type', 'supplier').eq('entity_id', id).order('created_at', { ascending: false }).limit(EVENT_LIMIT),
    safeRows(() => admin.from('supplier_products').select('id').eq('supplier_id', id).eq('status', 'submitted')),
  ]);
  if (!s) return notFound(res, 'Supplier');
  await withLastLogin(users);
  const ids = (products || []).map(p => p.id), poIds = pos.map(p => p.id);
  const [photos, pis, payments] = await Promise.all([
    ids.length ? safeRows(() => admin.from('documents').select('id, entity_id').eq('entity_type', 'product').eq('kind', 'product_photo').in('entity_id', ids).order('created_at')) : [],
    poIds.length ? safeRows(() => admin.from('supplier_pis').select('id, po_id, pi_no, status, currency, lines, total, created_at').in('po_id', poIds)) : [],
    poIds.length ? safeRows(() => admin.from('supplier_payments').select('id, po_id, amount, currency').in('po_id', poIds)) : [],
  ]);
  const photoOf = {};
  photos.forEach(d => { photoOf[d.entity_id] ||= d.id; });
  const members = memberRows(users || [], invites || []);
  const aiUse = await usageSummary('supplier', id);
  res.status(extra.status || 200).render('admin/suppliers/detail', {
    aiUse, aiPrices: await getPrices(), title: s.name, s, products: products || [], photoOf, purch: purchasingRows(pos, pis, payments), docs: docs || [], types: COMPANY_TYPES,
    members, events: events || [], eventLimit: EVENT_LIMIT, crmStatuses: CRM_STATUSES, activityTypes: ACTIVITY_TYPES, nSubmitted: submitted.length,
    portalBlocked: members.some(m => m.state === 'accepted') && !members.some(m => m.state === 'accepted' && m.active !== false),
    invShow: takeInvite(req, res), msg: req.query.msg, err: req.query.err, isAdmin: levelOf(req.user) === 'admin',
    edit: null, act: null, openDlg: null, ...extra,
  });
}
r.get('/:id', (req, res) => renderDetail(req, res));

// log a call / WeChat / visit / note, optionally with a follow-up date. The supplier keeps one "next follow-up" (the earliest open date).
r.post('/:id/activity', async (req, res) => {
  const { errors, values } = validateActivity(req.body);
  if (Object.keys(errors).length) return renderDetail(req, res, { status: 422, act: { vals: values, errors }, openDlg: 'actdlg', tab: 'activity' });
  const type = req.body.type in ACTIVITY_TYPES ? req.body.type : 'note';
  await log({ entityType: 'supplier', entityId: req.params.id, action: `crm_${type}`, actorId: req.user.id, detail: { note: values.summary, date: values.date, follow_up: values.follow_up || null, ...(values.next_action ? { next_action: values.next_action } : {}) } });
  let note = 'Activity logged.';
  if (values.follow_up) {
    const { data: cur } = await admin.from('suppliers').select('next_follow_up').eq('id', req.params.id).maybeSingle();
    const next = mergeFollowUp(cur?.next_follow_up, values.follow_up);
    if (next !== (cur?.next_follow_up || null)) await admin.from('suppliers').update({ next_follow_up: next }).eq('id', req.params.id);
    else note = `Activity logged. The next follow-up stays ${cur.next_follow_up} (the earlier date) — use Reschedule to change it.`;
  }
  res.redirect(`/admin/suppliers/${req.params.id}?msg=` + encodeURIComponent(note) + '#activity');
});

// the one next follow-up: mark it done (clears the date, leaves a note in the timeline) or move it to another date
r.post('/:id/followup/done', async (req, res) => {
  const { data: cur } = await admin.from('suppliers').select('next_follow_up').eq('id', req.params.id).maybeSingle();
  const to = (k, m) => res.redirect(`/admin/suppliers/${req.params.id}?${k}=${encodeURIComponent(m)}#activity`);
  if (!cur?.next_follow_up) return to('msg', 'There is no follow-up to complete.');
  await admin.from('suppliers').update({ next_follow_up: null }).eq('id', req.params.id).eq('next_follow_up', cur.next_follow_up);
  await log({ entityType: 'supplier', entityId: req.params.id, action: 'followup_done', actorId: req.user.id, detail: { note: `Follow-up of ${cur.next_follow_up} completed` } });
  to('msg', 'Follow-up completed.');
});
r.post('/:id/followup/reschedule', async (req, res) => {
  const due = /^\d{4}-\d{2}-\d{2}$/.test(req.body.due_date || '') && !Number.isNaN(Date.parse(req.body.due_date)) ? req.body.due_date : null;
  const to = (k, m) => res.redirect(`/admin/suppliers/${req.params.id}?${k}=${encodeURIComponent(m)}#activity`);
  if (!due) return to('err', 'Choose a valid date for the follow-up.');
  const { data: cur } = await admin.from('suppliers').select('next_follow_up').eq('id', req.params.id).maybeSingle();
  if (cur?.next_follow_up === due) return to('msg', 'The follow-up already has that date.');
  await admin.from('suppliers').update({ next_follow_up: due }).eq('id', req.params.id);
  await log({ entityType: 'supplier', entityId: req.params.id, action: 'followup_rescheduled', actorId: req.user.id, detail: { note: 'Next follow-up', from: cur?.next_follow_up || null, to: due } });
  to('msg', 'Follow-up date saved.');
});

// details edited in the drawer: every field is checked and shown again with its message when something is wrong
r.post('/:id/details', async (req, res) => {
  const { data: before } = await admin.from('suppliers').select('crm_status').eq('id', req.params.id).maybeSingle();
  if (!before) return notFound(res, 'Supplier');
  const { errors, values } = validateSupplier(req.body, { statuses: Object.keys(CRM_STATUSES) });
  if (Object.keys(errors).length) return renderDetail(req, res, { status: 422, edit: { vals: values, errors }, openDlg: 'editdlg', tab: 'overview' });
  const { error } = await admin.from('suppliers').update(supplierPatch(values)).eq('id', req.params.id);
  if (error) return renderDetail(req, res, { status: 422, edit: { vals: values, errors: { name: error.message } }, openDlg: 'editdlg', tab: 'overview' });
  if (before.crm_status !== values.crm_status) await log({ entityType: 'supplier', entityId: req.params.id, action: 'crm_status', actorId: req.user.id, detail: { note: `${CRM_STATUSES[before.crm_status] || before.crm_status} → ${CRM_STATUSES[values.crm_status]}` } });
  await log({ entityType: 'supplier', entityId: req.params.id, action: 'details_updated', actorId: req.user.id });
  res.redirect(`/admin/suppliers/${req.params.id}?msg=` + encodeURIComponent('Supplier details saved.') + '#overview');
});

// block / restore portal access for everyone at this supplier
r.post('/:id/portal', async (req, res) => {
  const block = req.body.action === 'block';
  await admin.from('profiles').update({ active: !block }).eq('supplier_id', req.params.id).not('accepted_at', 'is', null);
  if (block) await admin.from('invitations').update({ revoked_at: new Date().toISOString() }).eq('supplier_id', req.params.id).is('accepted_at', null).is('revoked_at', null);
  await log({ entityType: 'supplier', entityId: req.params.id, action: block ? 'portal_blocked' : 'portal_restored', actorId: req.user.id });
  res.redirect(`/admin/suppliers/${req.params.id}?msg=` + encodeURIComponent(block ? 'Portal access blocked for all users of this supplier.' : 'Portal access restored.') + '#portal');
});

// delete — Admin only, name typed to confirm, and only while nothing depends on the supplier (orders, quotes and purchase orders keep their history)
r.post('/:id/delete', requireAdmin, async (req, res) => {
  const id = req.params.id;
  const bad = m => res.redirect(`/admin/suppliers/${id}?err=` + encodeURIComponent(m) + '#overview');
  const { data: sup } = await admin.from('suppliers').select('name').eq('id', id).maybeSingle();
  if (!sup) return notFound(res, 'Supplier');
  if (!deleteConfirmed(req.body.confirm_name, sup.name)) return bad('Not deleted — the name you typed does not match the supplier name.');
  const count = async t => (await admin.from(t).select('id', { count: 'exact', head: true }).eq('supplier_id', id)).count || 0;
  const [nOrders, nQuotes, nPos] = await Promise.all([count('orders'), count('quotes'), count('supplier_pos').catch(() => 0)]);
  if (nOrders || nQuotes || nPos) return bad(`Can't delete: this supplier has ${nOrders} order(s), ${nQuotes} quote(s) and ${nPos} purchase order(s). Set the status to “Blocked” instead.`);
  await log({ entityType: 'supplier', entityId: id, action: 'supplier_deleted', actorId: req.user.id, detail: { note: sup.name } });
  await admin.from('profiles').update({ active: false, supplier_id: null }).eq('supplier_id', id);
  const { error } = await admin.from('suppliers').delete().eq('id', id);
  if (error) return bad(error.message);
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
  if (error) return res.redirect(`/admin/suppliers/${req.params.id}?err=` + encodeURIComponent(/ai_enabled/.test(error.message) ? 'Run supabase/migrations/0018_ai_access.sql first.' : error.message) + '#portal');
  await log({ entityType: 'supplier', entityId: req.params.id, action: on ? 'ai_enabled' : 'ai_disabled', actorId: req.user.id });
  res.redirect(`/admin/suppliers/${req.params.id}?msg=` + encodeURIComponent(`AI ${on ? 'switched on' : 'switched off'} for this supplier.`) + '#portal');
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
    await log({ entityType: 'supplier', entityId: s.id, action: result.resent ? 'invite_resent' : 'invite_sent', actorId: req.user.id, detail: { note: to, link_only: !result.mailed } });   // never the link or code
    res.redirect(`/admin/suppliers/${s.id}?msg=` + encodeURIComponent(result.mailed ? `${result.resent ? 'New invitation link sent' : 'Invitation sent'} to ${to} — valid 14 days.` : `Invitation ready for ${to} — copy the link below and send it yourself.`) + '#portal');
  } catch (e) {
    res.redirect(`/admin/suppliers/${s.id}?err=` + encodeURIComponent(e.message) + '#portal');
  }
});

r.post('/:id/invites/cancel', async (req, res) => {
  const email = String(req.body.email || '').trim();
  const { data } = await admin.from('invitations').update({ revoked_at: new Date().toISOString() })
    .eq('supplier_id', req.params.id).ilike('email', email).is('accepted_at', null).is('revoked_at', null).select('id');
  await admin.from('profiles').update({ active: false }).eq('supplier_id', req.params.id).ilike('email', email).is('accepted_at', null);
  if (data?.length) await log({ entityType: 'supplier', entityId: req.params.id, action: 'invite_cancelled', actorId: req.user.id, detail: { note: email } });
  res.redirect(`/admin/suppliers/${req.params.id}?msg=` + encodeURIComponent(data?.length ? `Invitation for ${email} cancelled — its link no longer works.` : `There was no open invitation for ${email}.`) + '#portal');
});

// disable / re-enable a portal user — only people who belong to THIS supplier can be changed
r.post('/:id/users/:uid/toggle', async (req, res) => {
  const to = m => res.redirect(`/admin/suppliers/${req.params.id}?${m}#portal`);
  const { data: p } = await admin.from('profiles').select('id, active, email, supplier_id, role').eq('id', req.params.uid).maybeSingle();
  if (!p || p.supplier_id !== req.params.id || p.role !== 'supplier') return to('err=' + encodeURIComponent('That user does not belong to this supplier.'));
  await admin.from('profiles').update({ active: !p.active }).eq('id', p.id);
  await log({ entityType: 'supplier', entityId: req.params.id, action: p.active ? 'portal_blocked' : 'portal_restored', actorId: req.user.id, detail: { note: p.email } });
  to('msg=' + encodeURIComponent(p.active ? `${p.email} can no longer sign in to the portal.` : `${p.email} can sign in again.`));
});

export default r;
