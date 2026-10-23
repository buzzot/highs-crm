import { Router } from '../../lib/router.js';
import { admin } from '../../lib/supabase.js';
import { log } from '../../lib/activity.js';
import { summarizeRequest } from '../../lib/ai.js';
import { back, notFound, REQUEST_STATUSES } from '../../lib/util.js';
import { snapshot, diff } from '../../lib/request-revisions.js';
import { applyRevision, rejectRevision, notifyClientOfDecision } from '../../lib/request-changes.js';

const r = Router();
const like = q => String(q || '').replace(/[,()%]/g, ' ').trim();

// Sourcing pipeline: client requests → quotes → orders
r.get('/', async (req, res) => {
  let q = admin.from('requests')
    .select('*, organizations(id, name), assignee:profiles!requests_assigned_to_fkey(full_name, email), quotes(id, status)')
    .order('created_at', { ascending: false });
  const status = req.query.status;
  if (status === 'open' || !status) q = q.in('status', ['new', 'reviewing', 'quoted']);
  else if (status !== 'all') q = q.eq('status', status);
  if (req.query.mine) q = q.eq('assigned_to', req.user.id);
  const s = like(req.query.q);
  if (s) q = q.or(`title.ilike.%${s}%,ref.ilike.%${s}%`);
  const [{ data }, { data: counts }, { data: pend }, { data: poPend }] = await Promise.all([q, admin.from('requests').select('status'), admin.from('request_revisions').select('request_id').eq('status', 'pending'), admin.from('purchase_orders').select('request_id').eq('status', 'submitted')]);
  const byStatus = {};
  (counts || []).forEach(x => { byStatus[x.status] = (byStatus[x.status] || 0) + 1; });
  res.render('admin/sourcing/index', { title: 'Sourcing', requests: data || [], pendingIds: (pend || []).map(x => x.request_id), poIds: (poPend || []).map(x => x.request_id), byStatus, statuses: REQUEST_STATUSES, status: status || 'open' });
});

r.get('/:id', async (req, res) => {
  const id = req.params.id;
  const [{ data: request }, { data: quotes }, { data: docs }, { data: events }, { data: staff }, { data: orders }, { data: items }] = await Promise.all([
    admin.from('requests').select('*, organizations(*), creator:profiles!requests_created_by_fkey(full_name, email)').eq('id', id).single(),
    admin.from('quotes').select('*, products(id, name, sku), suppliers(id, name)').eq('request_id', id).order('created_at', { ascending: false }),
    admin.from('documents').select('*').eq('entity_type', 'request').eq('entity_id', id).order('created_at', { ascending: false }),
    admin.from('activity_log').select('*, profiles(full_name, email)').eq('entity_type', 'request').eq('entity_id', id).order('created_at', { ascending: false }),
    admin.from('profiles').select('id, full_name, email').in('role', ['admin', 'staff']).eq('active', true).order('full_name'),
    admin.from('orders').select('id, order_no, status, quote_id').eq('request_id', id),
    admin.from('request_items').select('*').eq('request_id', id).order('position'),
  ]);
  if (!request) return notFound(res, 'Request');
  const { data: briefUse } = await admin.from('ai_usage').select('*').eq('feature', 'sourcing_brief').eq('entity_type', 'request').eq('entity_id', id).eq('ok', true).order('created_at', { ascending: false }).limit(1).maybeSingle();
  const { data: pending } = await admin.from('request_revisions').select('*, creator:profiles!request_revisions_created_by_fkey(full_name, email)').eq('request_id', id).eq('status', 'pending').maybeSingle();
  const { data: pos } = await admin.from('purchase_orders').select('id, po_no, status, submitted_at, lines, currency, order_id').eq('request_id', id).order('created_at', { ascending: false });
  const { data: rfqs } = await admin.from('rfqs').select('id, ref, title, status, rfq_suppliers(status)').eq('request_id', id).order('created_at', { ascending: false }); // empty before migration 0029
  const allDocs = docs || [];
  res.render('admin/sourcing/detail', {
    rfqs: rfqs || [], pos: pos || [], title: request.ref, request, quotes: quotes || [], docs: allDocs.filter(d => !d.revision_id), items: items || [],
    pending: pending || null, briefUsage: briefUse ? { model: briefUse.model, input: briefUse.input_tokens, output: briefUse.output_tokens, cacheRead: briefUse.cache_read_tokens, cacheWrite: briefUse.cache_write_tokens, total: briefUse.input_tokens + briefUse.output_tokens + briefUse.cache_read_tokens + briefUse.cache_write_tokens, at: briefUse.created_at } : null, pendingDiff: pending ? diff(snapshot(request, items || []), pending.data) : null,
    pendingDocs: pending ? allDocs.filter(d => d.revision_id === pending.id) : [], events: events || [], staff: staff || [],
    orders: orders || [], statuses: REQUEST_STATUSES, msg: req.query.msg, err: req.query.err,
  });
});

r.post('/:id', async (req, res) => {
  const id = req.params.id;
  const { data: before } = await admin.from('requests').select('status').eq('id', id).single();
  if (!before) return notFound(res, 'Request');
  const patch = {
    status: REQUEST_STATUSES.includes(req.body.status) ? req.body.status : before.status,
    assigned_to: req.body.assigned_to || null,
    internal_notes: req.body.internal_notes ?? null,
  };
  await admin.from('requests').update(patch).eq('id', id);
  if (patch.status !== before.status) {
    await log({ entityType: 'request', entityId: id, action: `status_${patch.status}`, actorId: req.user.id, clientVisible: true, detail: { from: before.status, to: patch.status } });
  }
  back(res, `/admin/sourcing/${id}`, { msg: 'Saved.' });
});

// Approve or reject a client's change to the request
r.post('/:id/changes/:rid', async (req, res) => {
  const { data: rev } = await admin.from('request_revisions').select('*').eq('id', req.params.rid).eq('request_id', req.params.id).single();
  if (!rev) return notFound(res, 'Change');
  if (rev.status !== 'pending') return back(res, `/admin/sourcing/${req.params.id}`, { err: `This change was already ${rev.status}.` });
  const note = String(req.body.note || '').trim().slice(0, 1000);
  const approve = req.body.decision === 'approve';
  try {
    if (approve) await applyRevision(rev, req.user.id, note); else await rejectRevision(rev, req.user.id, note);
  } catch (e) {
    console.error(`[revision] ${rev.id}: ${e.message}`);
    return back(res, `/admin/sourcing/${req.params.id}`, { err: `Could not ${approve ? 'apply' : 'reject'} the change: ${e.message}` });
  }
  const { data: request } = await admin.from('requests').select('id, ref, title').eq('id', req.params.id).single();
  notifyClientOfDecision(request, rev, approve, note).catch(e => console.error(`[revision] notify client: ${e.message}`));
  back(res, `/admin/sourcing/${req.params.id}`, { msg: approve ? 'Changes applied. Outdated quotes are marked superseded — prepare the updated offer.' : 'Changes rejected; the client was notified.' });
});

// AI sourcing brief from the client's free-text request
r.post('/:id/brief', async (req, res) => {
  const { data: request } = await admin.from('requests').select('title, description, quantity, target_unit_price, target_currency, destination_country, needed_by, delivery_mode').eq('id', req.params.id).single();
  if (!request) return notFound(res, 'Request');
  const { data: products } = await admin.from('request_items').select('name, description, quantity, unit, target_unit_price').eq('request_id', req.params.id).order('position');
  if (products?.length) request.products = products;
  const result = await summarizeRequest(request, req.params.id);
  const brief = result?.text;
  if (!brief) return back(res, `/admin/sourcing/${req.params.id}`, { err: 'AI is not configured (set ANTHROPIC_API_KEY).' });
  await admin.from('requests').update({ ai_brief: brief }).eq('id', req.params.id);
  await admin.from('requests').update({ status: 'reviewing' }).eq('id', req.params.id).eq('status', 'new');
  back(res, `/admin/sourcing/${req.params.id}`, { msg: `AI brief generated — ${res.locals.aiLine(result.usage)}` });
});

// Accepted quote → order
r.post('/quotes/:qid/convert', async (req, res) => {
  const { data: q } = await admin.from('quotes').select('*, requests(id, org_id, title, description), products(name, hs_code), request_items(name)').eq('id', req.params.qid).single();
  if (!q) return notFound(res, 'Quote');
  const { data: existing } = await admin.from('orders').select('id').eq('quote_id', q.id).maybeSingle();
  if (existing) return res.redirect(`/admin/orders/${existing.id}`);
  if (q.status !== 'accepted' && req.user.role !== 'admin') {
    return back(res, `/admin/sourcing/${q.request_id}`, { err: 'Only accepted quotes can become orders (admins can override).' });
  }
  const unitCostSell = Number(q.unit_cost) * Number(q.fx_rate);
  const { data: order, error } = await admin.from('orders').insert({
    org_id: q.requests.org_id, request_id: q.request_id, quote_id: q.id, supplier_id: q.supplier_id,
    currency: q.sell_currency,
    subtotal: Math.round(Number(q.unit_price) * q.quantity * 100) / 100,
    cost_total: Math.round(unitCostSell * q.quantity * 100) / 100,
    expected_ship_date: q.lead_time_days ? new Date(Date.now() + q.lead_time_days * 864e5).toISOString().slice(0, 10) : null,
  }).select('id, order_no').single();
  if (error) return back(res, `/admin/sourcing/${q.request_id}`, { err: error.message });
  await admin.from('order_items').insert({
    order_id: order.id, product_id: q.product_id, description: q.products?.name || q.request_items?.name || q.requests.title,
    quantity: q.quantity, unit_cost: Math.round(unitCostSell * 10000) / 10000, unit_price: q.unit_price, hs_code: q.products?.hs_code || null,
  });
  if (q.status !== 'accepted') await admin.from('quotes').update({ status: 'accepted' }).eq('id', q.id);
  await admin.from('requests').update({ status: 'accepted' }).eq('id', q.request_id);
  await log({ entityType: 'order', entityId: order.id, action: 'order_confirmed', actorId: req.user.id, clientVisible: true, detail: { note: `from ${q.request_items?.name || q.requests.title}` } });
  await log({ entityType: 'request', entityId: q.request_id, action: 'order_created', actorId: req.user.id, clientVisible: true, detail: { order_no: order.order_no } });
  res.redirect(`/admin/orders/${order.id}`);
});

export default r;
