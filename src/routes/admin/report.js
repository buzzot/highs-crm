import { Router } from '../../lib/router.js';
import { admin } from '../../lib/supabase.js';
import { levelOf, canAssign } from '../../lib/access.js';
import { defaultCurrency, sumIn } from '../../lib/currency.js';
import { applyCashProfit } from '../../lib/order-profit.js';
import { monthBuckets, niceScale, compact } from '../../lib/dashboard.js';
import { getSettings, notFound } from '../../lib/util.js';
import { buildReport } from '../../lib/order-report.js';
import { buildOrderArchive } from '../../lib/order-archive-db.js';
import { createZip } from '../../lib/zip.js';
import { safeName } from '../../lib/order-archive.js';

const r = Router();
// Admin and Director only
r.use((req, res, next) => (canAssign(req.user) ? next() : res.status(403).render('error', { title: 'No access', message: 'The report is for admins and directors.' })));

const filtered = (req, status) => {
  let q = admin.from('order_overview').select('*').order('created_at', { ascending: false });
  if (status === 'active') q = q.neq('status', 'cancelled');
  else if (status !== 'all') q = q.eq('status', status);
  if (req.query.from) q = q.gte('created_at', req.query.from);
  if (req.query.to) q = q.lte('created_at', req.query.to + 'T23:59:59');
  const s = String(req.query.q || '').replace(/[%,()*]/g, ' ').trim();
  if (s) q = q.or(`order_no.ilike.%${s}%,client_name.ilike.%${s}%,supplier_name.ilike.%${s}%`);
  return q;
};

r.get('/', async (req, res) => {
  const status = req.query.status || 'active';
  const { data: list } = await filtered(req, status).limit(500);
  const orders = list || [], ids = orders.map(o => o.id);
  const none = { data: [] };
  const [own, pays, pos, ships, staff, cur, settings] = await Promise.all([
    ids.length ? admin.from('orders').select('id, owner_id, created_by').in('id', ids) : none,
    ids.length ? admin.from('order_payments').select('order_id, amount, currency, paid_on, created_at, label, status').in('order_id', ids) : none,
    ids.length ? admin.from('supplier_pos').select('id, order_id, total, currency, status, sent_at, confirmed_at, suppliers(name)').in('order_id', ids) : none,
    ids.length ? admin.from('shipments').select('id, order_id, forwarders(name)').in('order_id', ids) : none,
    admin.from('profiles').select('id, full_name, email').in('role', ['admin', 'staff']),
    defaultCurrency(admin), getSettings(admin),
  ]);
  const poOf = new Map((pos.data || []).map(x => [x.id, x]));
  const { data: spay } = poOf.size ? await admin.from('supplier_payments').select('po_id, amount, currency, paid_on, created_at').in('po_id', [...poOf.keys()]) : { data: [] };   // empty before migration 0037
  const supPays = (spay || []).map(x => ({ ...x, order_id: poOf.get(x.po_id)?.order_id, suppliers: poOf.get(x.po_id)?.suppliers }));
  const shipIds = (ships.data || []).map(x => x.id);
  const { data: costs } = shipIds.length ? await admin.from('freight_costs').select('shipment_id, amount, currency, description, paid, paid_at, created_at').in('shipment_id', shipIds) : { data: [] };
  const ownBy = new Map((own.data || []).map(o => [o.id, o]));
  const rep = buildReport({ orders: orders.map(o => ({ ...o, ...(ownBy.get(o.id) || {}) })), pays: pays.data || [], pos: pos.data || [], supPays, ships: ships.data || [], costs: costs || [], staff: staff.data || [], settings, cur });
  // financial performance: all non-cancelled orders (not narrowed by the list filters), same profit rule as the Orders list
  const PERIODS = { 30: 'Last 30 days', 90: 'Last 90 days', 365: 'Last 12 months' };
  const period = PERIODS[req.query.fp] ? Number(req.query.fp) : 30, since = new Date(Date.now() - period * 864e5).toISOString();
  const { data: allOrders } = await admin.from('order_overview').select('*').order('created_at', { ascending: false });
  const live = (allOrders || []).filter(o => o.status !== 'cancelled');
  await applyCashProfit(live);
  const inPeriod = live.filter(o => o.created_at >= since);
  const months = monthBuckets(live.map(o => ({ date: o.created_at, revenue: sumIn(settings, cur, [[o.subtotal, o.currency]]), profit: sumIn(settings, cur, [[o.gross_profit, o.currency]]) })), 6);
  const fin = { period, periods: PERIODS, months, scale: niceScale(Math.max(0, ...months.map(m => Math.max(m.revenue, m.profit)))), compact, orderCurs: [...new Set(live.map(o => o.currency).filter(Boolean))],
    kpi: { revenue: sumIn(settings, cur, inPeriod.map(o => [o.subtotal, o.currency])), profit: sumIn(settings, cur, inPeriod.map(o => [o.gross_profit, o.currency])), cashOnly: inPeriod.filter(o => !(Number(o.subtotal) > 0) && Number(o.gross_profit) !== 0).length } };
  res.render('admin/report/index', { title: 'Report', ...rep, status, fin, level: levelOf(req.user) });
});

const sendZip = (res, name, buffer) => {
  res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`, 'Content-Length': buffer.length });
  res.send(buffer);
};
const MAX_ALL = 20;
// every order of the current filter, one folder per order
r.get('/archive-all', async (req, res) => {
  const { data: list } = await filtered(req, req.query.status || 'active').limit(MAX_ALL + 1);
  if (!(list || []).length) return res.redirect('/admin/report');
  if (list.length > MAX_ALL) return res.redirect('/admin/report?err=' + encodeURIComponent(`Too many orders for one archive (max ${MAX_ALL}) — narrow the filter or dates.`));
  const files = [];
  for (const o of list) {
    const a = await buildOrderArchive(o.id, { prefix: '' });
    if (a) a.files.forEach(f => files.push({ ...f, name: `${a.name}/${f.name}` }));
  }
  sendZip(res, `Orders ${new Date().toISOString().slice(0, 10)}.zip`, createZip(files));
});
r.get('/:id/archive', async (req, res) => {
  const a = await buildOrderArchive(req.params.id);
  if (!a) return notFound(res, 'Order');
  sendZip(res, safeName(a.name) + '.zip', createZip(a.files));
});

export default r;
