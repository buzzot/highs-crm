import { buildClients } from '../../lib/clients.js';
import { Router } from '../../lib/router.js';
import { admin } from '../../lib/supabase.js';
import { inviteUser, memberRows, stashInvite, takeInvite, wantsLinkOnly } from '../../lib/invites.js';
import { requireAdmin } from '../../middleware/auth.js';
import { normLang } from '../../lib/lang.js';
import { log } from '../../lib/activity.js';
import { usageSummary, setCompanyAi } from '../../lib/ai-access.js';
import { getPrices } from '../../lib/ai-usage.js';
import { ACTIVITY_TYPES, validateActivity, validateCompany, withLastLogin } from '../../lib/crm.js';
import { clientFollowups, canActOn, isoDate } from '../../lib/followups.js';
import { canAssign, levelOf } from '../../lib/access.js';

const ORG_FIELDS = ['name', 'registration_no', 'tax_id', 'address', 'postal_code', 'city', 'country', 'delivery_address', 'phone', 'email', 'website', 'default_currency', 'notes'];

const r = Router();
const withLang = b => ('language' in b ? { ...b, language: normLang(b.language) } : b);
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
    const pick = String(req.body.role || '');
    const role = pick === 'admin' ? 'admin' : ['staff', 'director', 'manager'].includes(pick) ? 'staff' : null;   // Director / Manager are both role 'staff' with a staff_level
    const { data: cur } = role ? { data: null } : await admin.from('invitations').select('role').ilike('email', String(req.body.email).trim()).order('created_at', { ascending: false }).limit(1).maybeSingle();
    await inviteUser({ email: req.body.email, role: role || cur?.role || 'staff', invitedBy: req.user.id });
    if (['director', 'manager'].includes(pick)) {   // needs migration 0036; ignored (everyone is a Director) until it has been run
      const { error } = await admin.from('profiles').update({ staff_level: pick }).ilike('email', String(req.body.email).trim());
      if (error && pick === 'manager') throw new Error(`Invitation sent, but the Manager level could not be saved — run supabase/migrations/0036_access_levels.sql first. (${error.message})`);
    }
    const nm = String(req.body.full_name || '').trim().slice(0, 80);
    if (nm) await admin.from('profiles').update({ full_name: nm }).ilike('email', String(req.body.email).trim()).is('full_name', null);
    res.redirect('/admin/clients/staff/list?msg=' + encodeURIComponent(`Invitation sent to ${req.body.email} — valid 14 days.`));
  } catch (e) { res.redirect('/admin/clients/staff/list?err=' + encodeURIComponent(e.message)); }
});


// rename a team member (the name is what shows as the owner of records)
r.post('/staff/:uid/name', requireAdmin, async (req, res) => {
  const name = String(req.body.full_name || '').trim().slice(0, 80);
  const to = '/admin/clients/staff/list';
  if (!name) return res.redirect(`${to}?err=${encodeURIComponent('Enter a name.')}`);
  const { error } = await admin.from('profiles').update({ full_name: name }).eq('id', req.params.uid).in('role', ['admin', 'staff']);
  res.redirect(`${to}?${error ? 'err=' + encodeURIComponent(error.message) : 'msg=' + encodeURIComponent('Name saved.')}`);
});

// change a team member's access level (Admin / Director / Manager)
r.post('/staff/:uid/level', requireAdmin, async (req, res) => {
  const to = '/admin/clients/staff/list';
  const level = String(req.body.level || '');
  if (!['admin', 'director', 'manager'].includes(level)) return res.redirect(`${to}?err=${encodeURIComponent('Unknown level.')}`);
  if (req.params.uid === req.user.id && level !== 'admin') return res.redirect(`${to}?err=${encodeURIComponent('You cannot lower your own access — ask another Admin.')}`);
  const patch = level === 'admin' ? { role: 'admin' } : { role: 'staff', staff_level: level };
  const { error } = await admin.from('profiles').update(patch).eq('id', req.params.uid).in('role', ['admin', 'staff']);
  res.redirect(`${to}?${error ? 'err=' + encodeURIComponent(/staff_level/.test(error.message) ? 'Run supabase/migrations/0036_access_levels.sql first.' : error.message) : 'msg=' + encodeURIComponent('Access level changed — it applies from their next page load.')}`);
});

// every row of a table, page by page — a client list must never be cut short by the API's row limit
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
  const orgs = await fetchAll(() => admin.from('organizations').select('*').order('name').order('id'));
  const ids = new Set(orgs.map(o => o.id));
  // portal users = people who can log in to the client portal; requests / orders = every record of the client (cancelled ones included, as in the linked lists)
  const [users, reqs, ords] = await Promise.all([
    fetchAll(() => admin.from('profiles').select('id, org_id, full_name, email').not('org_id', 'is', null).order('id')),
    fetchAll(() => admin.from('requests').select('id, org_id, created_at, updated_at').not('org_id', 'is', null).order('id')),
    fetchAll(() => admin.from('orders').select('id, org_id, created_at, updated_at').not('org_id', 'is', null).order('id')),
  ]);
  const q = req.query;
  const list = buildClients({ orgs, users: users.filter(u => ids.has(u.org_id)), reqs: reqs.filter(x => ids.has(x.org_id)), ords: ords.filter(x => ids.has(x.org_id)) }, q);
  res.render('admin/clients/index', { title: 'Clients', ...list, query: { q: q.q || '', country: q.country || '', currency: q.currency || '', state: q.state || '' } });
});

r.get('/new', (req, res) => res.render('admin/clients/form', { title: 'New client', org: {}, error: null }));
r.post('/', async (req, res) => {
  const { data, error } = await admin.from('organizations').insert(clean(withLang(req.body))).select().single();
  if (error) return res.render('admin/clients/form', { title: 'New client', org: req.body, error: error.message });
  res.redirect(`/admin/clients/${data.id}`);
});

// staff who can own a follow-up (Admin / Director can pick anyone; a Manager only themselves)
async function staffChoices(user) {
  if (!canAssign(user)) return [{ id: user.id, name: user.full_name || user.email }];
  const { data } = await admin.from('profiles').select('id, full_name, email').in('role', ['admin', 'staff']).order('full_name');
  return (data || []).map(p => ({ id: p.id, name: p.full_name || p.email }));
}

async function renderDetail(req, res, extra = {}) {
  const id = req.params.id;
  const [{ data: client }, { data: users }, { data: invites }, { data: requests }, { data: orders }, { data: events }, fu, staff] = await Promise.all([
    admin.from('organizations').select('*').eq('id', id).single(),
    admin.from('profiles').select('*').eq('org_id', id).order('created_at'),
    admin.from('invitations').select('*').eq('org_id', id),
    admin.from('requests').select('*, request_items(count), quotes(id, status)').eq('org_id', id).order('created_at', { ascending: false }),
    admin.from('order_overview').select('*').eq('org_id', id).order('created_at', { ascending: false }),
    admin.from('activity_log').select('*, profiles(full_name, email)').eq('entity_type', 'organization').eq('entity_id', id).order('created_at', { ascending: false }).limit(EVENT_LIMIT),
    clientFollowups(id),
    staffChoices(req.user),
  ]);
  if (!client) return res.status(404).render('error', { title: 'Not found', message: 'Client not found.' });
  await withLastLogin(users);
  const live = (orders || []).filter(o => o.status !== 'cancelled');
  // Record scopes used everywhere on this page: "requests" / "orders" = every record of the client (cancelled and closed included);
  // "open requests" = new, reviewing or quoted; "active orders" = not delivered, closed or cancelled.
  const kpi = {
    openRequests: (requests || []).filter(q => ['new', 'reviewing', 'quoted'].includes(q.status)).length,
    activeOrders: live.filter(o => !['delivered', 'closed'].includes(o.status)).length,
    sales: live.reduce((t, o) => t + Number(o.subtotal || 0), 0),
    profit: live.reduce((t, o) => t + Number(o.gross_profit ?? (Number(o.subtotal || 0) - Number(o.cost_total || 0))), 0),
    lastLogin: (users || []).map(u => u.last_login_at).filter(Boolean).sort().pop() || null,
  };
  // last meaningful activity: a request or order changed, or a call / meeting / note logged by the team (system events such as sign-ins are not counted)
  const stamps = [...(requests || []).map(q => q.updated_at || q.created_at), ...(orders || []).map(o => o.updated_at || o.created_at), ...(events || []).filter(e => String(e.action).startsWith('crm_')).map(e => e.detail?.date ? e.detail.date + 'T12:00:00Z' : e.created_at)].filter(Boolean).sort();
  kpi.lastActivity = stamps.pop() || null;
  const aiUse = await usageSummary('organization', id);
  const names = Object.fromEntries(staff.map(x => [x.id, x.name]));
  res.status(extra.status || 200).render('admin/clients/detail', {
    aiUse, aiPrices: await getPrices(), title: client.name, org: client, members: memberRows(users || [], invites || []), invShow: takeInvite(req, res), requests: requests || [], orders: orders || [],
    events: events || [], eventLimit: EVENT_LIMIT, activityTypes: ACTIVITY_TYPES, kpi, msg: req.query.msg, err: req.query.err,
    followups: fu.rows.map(f => ({ ...f, owner_name: names[f.owner_id] || null })), followReady: fu.ready, staffChoices: staff, canEdit: true,
    canAssignOwner: canAssign(req.user), meId: req.user.id, edit: null, act: null, openDlg: null, ...extra,
  });
}
const EVENT_LIMIT = 200;
r.get('/:id', (req, res) => renderDetail(req, res));

// log a call / meeting / note, optionally with a follow-up that becomes a real task (owner, due date, status)
r.post('/:id/activity', async (req, res) => {
  const id = req.params.id, { errors, values } = validateActivity(req.body);
  let owner = values.owner_id || req.user.id;
  const staff = await staffChoices(req.user);
  if (!staff.some(x => x.id === owner)) owner = req.user.id;   // a Manager can only assign themselves
  if (Object.keys(errors).length) return renderDetail(req, res, { status: 422, act: { vals: values, errors }, openDlg: 'actdlg', tab: 'activity' });
  const actId = await log({ entityType: 'organization', entityId: id, action: `crm_${req.body.type in ACTIVITY_TYPES ? req.body.type : 'note'}`, actorId: req.user.id, detail: { note: values.summary, date: values.date, follow_up: values.follow_up || null, ...(values.next_action ? { next_action: values.next_action } : {}) } });
  let note = 'Activity logged.';
  if (values.follow_up) {
    const { error } = await admin.from('client_followups').insert({ org_id: id, activity_id: actId, title: values.next_action || values.summary.slice(0, 200), due_date: values.follow_up, original_due: values.follow_up, owner_id: owner, created_by: req.user.id });
    if (error) note = 'Activity logged. The follow-up date is saved on the activity, but it cannot be completed or rescheduled until supabase/migrations/0038_client_followups.sql is run.';
  }
  res.redirect(`/admin/clients/${id}?msg=` + encodeURIComponent(note) + '#activity');
});

// follow-up tasks: complete / reopen / reschedule — the activity they came from is never changed, and every change leaves an audit event
async function followupOr(req, res) {
  const back = (k, m) => res.redirect(`/admin/clients/${req.params.id}?${k}=${encodeURIComponent(m)}#activity`);
  const { data: fu, error } = await admin.from('client_followups').select('*').eq('id', req.params.fid).eq('org_id', req.params.id).maybeSingle();
  if (error) { back('err', 'Run supabase/migrations/0038_client_followups.sql first.'); return null; }
  if (!fu) { back('err', 'That follow-up no longer exists.'); return null; }
  if (!canActOn(req.user, fu, canAssign(req.user))) { back('err', 'Only the person responsible, an Admin or a Director can change this follow-up.'); return null; }
  return { fu, back };
}
const audit = (req, action, fu, extra = {}) => log({ entityType: 'organization', entityId: req.params.id, action, actorId: req.user.id, detail: { note: fu.title, followup_id: fu.id, ...extra } });
r.post('/:id/followups/:fid/complete', async (req, res) => {
  const c = await followupOr(req, res); if (!c) return;
  const { data } = await admin.from('client_followups').update({ status: 'done', completed_at: new Date().toISOString(), completed_by: req.user.id, updated_at: new Date().toISOString() }).eq('id', c.fu.id).eq('status', 'open').select('id');
  if (data?.length) await audit(req, 'followup_done', c.fu);   // a double click completes it once
  c.back('msg', 'Follow-up completed.');
});
r.post('/:id/followups/:fid/reopen', async (req, res) => {
  const c = await followupOr(req, res); if (!c) return;
  const { data } = await admin.from('client_followups').update({ status: 'open', completed_at: null, completed_by: null, updated_at: new Date().toISOString() }).eq('id', c.fu.id).eq('status', 'done').select('id');
  if (data?.length) await audit(req, 'followup_reopened', c.fu);
  c.back('msg', 'Follow-up reopened.');
});
r.post('/:id/followups/:fid/reschedule', async (req, res) => {
  const c = await followupOr(req, res); if (!c) return;
  const due = isoDate(req.body.due_date);
  if (!due) return c.back('err', 'Choose a valid new date for the follow-up.');
  const patch = { due_date: due, original_due: c.fu.original_due || c.fu.due_date, rescheduled_count: (c.fu.rescheduled_count || 0) + 1, updated_at: new Date().toISOString() };
  const wantOwner = String(req.body.owner_id || '');
  if (wantOwner && wantOwner !== c.fu.owner_id && canAssign(req.user) && (await staffChoices(req.user)).some(x => x.id === wantOwner)) patch.owner_id = wantOwner;
  if (due === c.fu.due_date && !patch.owner_id) return c.back('msg', 'The follow-up already has that date.');
  const { data } = await admin.from('client_followups').update(patch).eq('id', c.fu.id).eq('status', 'open').select('id');
  if (data?.length) await audit(req, 'followup_rescheduled', c.fu, { from: c.fu.due_date, to: due });
  c.back('msg', data?.length ? 'Follow-up rescheduled.' : 'A completed follow-up cannot be rescheduled — reopen it first.');
});

// details edited in the drawer: every field is checked and shown again with its message when something is wrong
r.post('/:id/details', async (req, res) => {
  const { data: cur } = await admin.from('organizations').select('default_currency').eq('id', req.params.id).single();
  const { errors, values } = validateCompany(req.body, { keepCurrency: cur?.default_currency || null });
  if (Object.keys(errors).length) return renderDetail(req, res, { status: 422, edit: { vals: { ...values, language: values.language }, errors }, openDlg: 'editdlg', tab: 'overview' });
  const patch = Object.fromEntries(ORG_FIELDS.filter(k => k in values).map(k => [k, values[k] || null]));
  patch.default_currency = values.default_currency || res.locals.defCur || 'CNY';
  patch.active = values.active;
  if ('language' in req.body) patch.language = normLang(req.body.language);
  let { error } = await admin.from('organizations').update(patch).eq('id', req.params.id);
  let note = 'Details saved.';
  if (error && /language/i.test(error.message) && 'language' in patch) {   // migration 0032 not run yet: save everything else
    delete patch.language;
    ({ error } = await admin.from('organizations').update(patch).eq('id', req.params.id));
    note = 'Details saved, but the language was not — run migration 0032_language.sql in Supabase first.';
  }
  res.redirect(`/admin/clients/${req.params.id}?` + (error ? 'err=' + encodeURIComponent(error.message) : 'msg=' + encodeURIComponent(note)) + '#overview');
});

r.get('/:id/edit', async (req, res) => {
  const { data: client } = await admin.from('organizations').select('*').eq('id', req.params.id).single();
  res.render('admin/clients/form', { title: 'Edit client', org: client, error: null });
});
r.post('/:id/ai', requireAdmin, async (req, res) => {
  const on = req.body.ai_enabled === 'on';
  const { error } = await setCompanyAi('organization', req.params.id, on);
  if (error) return res.redirect(`/admin/clients/${req.params.id}?err=` + encodeURIComponent(/ai_enabled/.test(error.message) ? 'Run supabase/migrations/0018_ai_access.sql first.' : error.message) + '#portal');
  await log({ entityType: 'organization', entityId: req.params.id, action: on ? 'ai_enabled' : 'ai_disabled', actorId: req.user.id });
  res.redirect(`/admin/clients/${req.params.id}?msg=` + encodeURIComponent(`AI ${on ? 'switched on' : 'switched off'} for this client.`) + '#portal');
});
r.post('/:id', async (req, res) => {
  const { error } = await admin.from('organizations').update(clean(withLang(req.body))).eq('id', req.params.id);
  if (error) return res.render('admin/clients/form', { title: 'Edit client', org: { ...req.body, id: req.params.id }, error: error.message });
  res.redirect(`/admin/clients/${req.params.id}`);
});

// invite a user into this client (multiple users per client supported)
r.post('/:id/invite', async (req, res) => {
  try {
    const result = await inviteUser({ email: req.body.email, role: 'client', orgId: req.params.id, invitedBy: req.user.id, mail: !wantsLinkOnly(req.body) });
    const to = String(req.body.email).trim();
    if (!result.mailed) stashInvite(res, to, result);
    await log({ entityType: 'organization', entityId: req.params.id, action: result.resent ? 'invite_resent' : 'invite_sent', actorId: req.user.id, detail: { note: to, link_only: !result.mailed } });   // never the link or code
    res.redirect(`/admin/clients/${req.params.id}?msg=` + encodeURIComponent(result.mailed ? `${result.resent ? 'New invitation link sent' : 'Invitation sent'} to ${to} — valid 14 days.` : `Invitation ready for ${to} — copy the link below and send it yourself.`) + '#portal');
  } catch (e) {
    res.redirect(`/admin/clients/${req.params.id}?err=` + encodeURIComponent(e.message) + '#portal');
  }
});

// cancel an open invitation (the link stops working; a login that never set a password is disabled)
r.post('/:id/invites/cancel', async (req, res) => {
  const email = String(req.body.email || '').trim();
  const { data } = await admin.from('invitations').update({ revoked_at: new Date().toISOString() })
    .eq('org_id', req.params.id).ilike('email', email).is('accepted_at', null).is('revoked_at', null).select('id');
  await admin.from('profiles').update({ active: false }).eq('org_id', req.params.id).ilike('email', email).is('accepted_at', null);
  if (data?.length) await log({ entityType: 'organization', entityId: req.params.id, action: 'invite_cancelled', actorId: req.user.id, detail: { note: email } });
  res.redirect(`/admin/clients/${req.params.id}?msg=` + encodeURIComponent(data?.length ? `Invitation for ${email} cancelled — its link no longer works.` : `There was no open invitation for ${email}.`) + '#portal');
});

// disable / re-enable a portal user — only people who belong to THIS client can be changed
r.post('/:id/users/:uid/toggle', async (req, res) => {
  const to = m => res.redirect(`/admin/clients/${req.params.id}?${m}#portal`);
  const { data: p } = await admin.from('profiles').select('id, active, email, org_id, role, accepted_at').eq('id', req.params.uid).maybeSingle();
  if (!p || p.org_id !== req.params.id || p.role !== 'client') return to('err=' + encodeURIComponent('That user does not belong to this client.'));
  await admin.from('profiles').update({ active: !p.active }).eq('id', p.id);
  await log({ entityType: 'organization', entityId: req.params.id, action: p.active ? 'portal_blocked' : 'portal_restored', actorId: req.user.id, detail: { note: p.email } });
  to('msg=' + encodeURIComponent(p.active ? `${p.email} can no longer sign in to the portal.` : `${p.email} can sign in again.`));
});

export default r;
