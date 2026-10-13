import { Router } from '../../lib/router.js';
import { admin } from '../../lib/supabase.js';
import { log } from '../../lib/activity.js';
import { clean, bool, back, notFound, ORDER_STATUSES, CURRENCIES } from '../../lib/util.js';
import { landed } from '../../lib/landed.js';

const r = Router();
const like = q => String(q || '').replace(/[,()%]/g, ' ').trim();
const r2 = x => Math.round(Number(x || 0) * 100) / 100;

async function recalc(orderId) {
  const { data: items } = await admin.from('order_items').select('quantity, unit_price, unit_cost').eq('order_id', orderId);
  const subtotal = (items || []).reduce((s, i) => s + i.quantity * Number(i.unit_price || 0), 0);
  const cost = (items || []).reduce((s, i) => s + i.quantity * Number(i.unit_cost || 0), 0);
  await admin.from('orders').update({ subtotal: r2(subtotal), cost_total: r2(cost) }).eq('id', orderId);
}

r.get('/', async (req, res) => {
  let q = admin.from('order_overview').select('*').order('created_at', { ascending: false });
  const status = req.query.status || 'open';
  if (status === 'open') q = q.not('status', 'in', '("delivered","closed","cancelled")');
  else if (status !== 'all') q = q.eq('status', status);
  if (req.query.client) q = q.eq('org_id', req.query.client);
  const s = like(req.query.q);
  if (s) q = q.or(`order_no.ilike.%${s}%,client_name.ilike.%${s}%,supplier_name.ilike.%${s}%`);
  const [{ data }, { data: all }, { data: clients }] = await Promise.all([
    q, admin.from('orders').select('status'), admin.from('organizations').select('id, name').order('name'),
  ]);
  const byStatus = {};
  (all || []).forEach(o => { byStatus[o.status] = (byStatus[o.status] || 0) + 1; });
  res.render('admin/orders/index', { title: 'Orders', orders: data || [], byStatus, statuses: ORDER_STATUSES, status, clients: clients || [] });
});

r.get('/new', async (req, res) => {
  const [{ data: clients }, { data: suppliers }] = await Promise.all([
    admin.from('organizations').select('id, name, default_currency').eq('active', true).order('name'),
    admin.from('suppliers').select('id, name').order('name'),
  ]);
  res.render('admin/orders/new', { title: 'New order', clients: clients || [], suppliers: suppliers || [], currencies: CURRENCIES, org: req.query.org_id || '' });
});
r.post('/', async (req, res) => {
  const b = clean(req.body, ['org_id', 'supplier_id', 'currency', 'expected_ship_date', 'client_notes', 'internal_notes']);
  const { data, error } = await admin.from('orders').insert(b).select('id').single();
  if (error) return back(res, '/admin/orders/new', { err: error.message });
  await log({ entityType: 'order', entityId: data.id, action: 'order_confirmed', actorId: req.user.id, clientVisible: true });
  res.redirect(`/admin/orders/${data.id}`);
});

r.get('/:id', async (req, res) => {
  const id = req.params.id;
  const [{ data: order }, { data: items }, { data: shipments }, { data: packing }, { data: events }, { data: suppliers }, { data: products }] = await Promise.all([
    admin.from('order_overview').select('*').eq('id', id).single(),
    admin.from('order_items').select('*, products(id, name, sku)').eq('order_id', id),
    admin.from('shipments').select('*, forwarders(name), freight_costs(amount, fx_to_order)').eq('order_id', id).order('created_at'),
    admin.from('packing_lists').select('*').eq('order_id', id).order('carton_no'),
    admin.from('activity_log').select('*, profiles(full_name, email)').eq('entity_type', 'order').eq('entity_id', id).order('created_at', { ascending: false }),
    admin.from('suppliers').select('id, name').order('name'),
    admin.from('products').select('id, name, sku, hs_code').order('name'),
  ]);
  if (!order) return notFound(res, 'Order');
  const shipIds = (shipments || []).map(s => s.id);
  const { data: docs } = await admin.from('documents').select('*')
    .or(`and(entity_type.eq.order,entity_id.eq.${id})${shipIds.length ? `,and(entity_type.eq.shipment,entity_id.in.(${shipIds.join(',')}))` : ''}`)
    .order('created_at', { ascending: false });
  res.render('admin/orders/detail', {
    title: order.order_no, order, items: items || [], shipments: shipments || [], packing: packing || [], events: events || [],
    docs: docs || [], suppliers: suppliers || [], products: products || [], statuses: ORDER_STATUSES,
    land: landed(order, items), msg: req.query.msg, err: req.query.err,
  });
});

// status change with optional client-visible note
r.post('/:id/status', async (req, res) => {
  const id = req.params.id;
  const { data: o } = await admin.from('orders').select('status').eq('id', id).single();
  if (!o) return notFound(res, 'Order');
  const to = ORDER_STATUSES.includes(req.body.status) ? req.body.status : o.status;
  if (to !== o.status) await admin.from('orders').update({ status: to }).eq('id', id);
  if (to !== o.status || req.body.note) {
    await log({
      entityType: 'order', entityId: id, action: to !== o.status ? `status_${to}` : 'note', actorId: req.user.id,
      clientVisible: bool(req.body.client_visible), detail: { from: o.status, to, note: req.body.note || undefined },
    });
  }
  back(res, `/admin/orders/${id}`, { msg: 'Status updated.' });
});

r.post('/:id', async (req, res) => {
  const b = clean(req.body, ['supplier_id', 'expected_ship_date', 'client_notes', 'internal_notes', 'currency']);
  const { error } = await admin.from('orders').update(b).eq('id', req.params.id);
  back(res, `/admin/orders/${req.params.id}`, error ? { err: error.message } : { msg: 'Saved.' });
});

// ---- items ----
r.post('/:id/items', async (req, res) => {
  const b = clean(req.body, ['product_id', 'description', 'quantity', 'unit_cost', 'unit_price', 'hs_code']);
  if (b.product_id && !b.description) {
    const { data: p } = await admin.from('products').select('name, hs_code').eq('id', b.product_id).single();
    b.description = p?.name; b.hs_code ||= p?.hs_code;
  }
  const { error } = await admin.from('order_items').insert({ ...b, order_id: req.params.id });
  if (!error) await recalc(req.params.id);
  back(res, `/admin/orders/${req.params.id}`, error ? { err: error.message } : { msg: 'Item added.' });
});
r.post('/:id/items/:iid/delete', async (req, res) => {
  await admin.from('order_items').delete().eq('id', req.params.iid).eq('order_id', req.params.id);
  await recalc(req.params.id);
  back(res, `/admin/orders/${req.params.id}`, { msg: 'Item removed.' });
});

// ---- packing list ----
r.post('/:id/packing', async (req, res) => {
  const b = clean(req.body, ['carton_no', 'product_id', 'description', 'quantity', 'length_cm', 'width_cm', 'height_cm', 'gross_weight_kg', 'net_weight_kg']);
  const copies = Math.min(Math.max(parseInt(req.body.copies || '1', 10) || 1, 1), 500);
  // "copies" lets you add N identical cartons at once: carton_no "1" × 20 → 1..20
  const start = parseInt(b.carton_no, 10);
  const rows = Array.from({ length: copies }, (_, i) => ({
    ...b, order_id: req.params.id,
    carton_no: copies > 1 && Number.isFinite(start) ? String(start + i) : b.carton_no,
  }));
  const { error } = await admin.from('packing_lists').insert(rows);
  back(res, `/admin/orders/${req.params.id}#packing`, error ? { err: error.message } : { msg: `${rows.length} carton(s) added.` });
});
r.post('/:id/packing/:pid/delete', async (req, res) => {
  await admin.from('packing_lists').delete().eq('id', req.params.pid).eq('order_id', req.params.id);
  back(res, `/admin/orders/${req.params.id}#packing`);
});

export default r;
