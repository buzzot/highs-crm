import { Router } from '../../lib/router.js';
import { admin } from '../../lib/supabase.js';
import { levelOf, canAssign } from '../../lib/access.js';
import { defaultCurrency } from '../../lib/currency.js';
import { getSettings } from '../../lib/util.js';
import { buildReport } from '../../lib/order-report.js';

const r = Router();
// Admin and Director only
r.use((req, res, next) => (canAssign(req.user) ? next() : res.status(403).render('error', { title: 'No access', message: 'The report is for admins and directors.' })));

r.get('/', async (req, res) => {
  const status = req.query.status || 'active';
  let q = admin.from('order_overview').select('*').order('created_at', { ascending: false });
  if (status === 'active') q = q.neq('status', 'cancelled');
  else if (status !== 'all') q = q.eq('status', status);
  if (req.query.from) q = q.gte('created_at', req.query.from);
  if (req.query.to) q = q.lte('created_at', req.query.to + 'T23:59:59');
  const s = String(req.query.q || '').replace(/[%,()*]/g, ' ').trim();
  if (s) q = q.or(`order_no.ilike.%${s}%,client_name.ilike.%${s}%,supplier_name.ilike.%${s}%`);
  const { data: list } = await q.limit(500);
  const orders = list || [], ids = orders.map(o => o.id);
  const none = { data: [] };
  const [own, pays, pos, ships, staff, cur, settings] = await Promise.all([
    ids.length ? admin.from('orders').select('id, owner_id, created_by').in('id', ids) : none,
    ids.length ? admin.from('order_payments').select('order_id, amount, currency, paid_on, created_at, label, status').in('order_id', ids) : none,
    ids.length ? admin.from('supplier_pos').select('order_id, total, currency, status, sent_at, confirmed_at, suppliers(name)').in('order_id', ids) : none,
    ids.length ? admin.from('shipments').select('id, order_id, forwarders(name)').in('order_id', ids) : none,
    admin.from('profiles').select('id, full_name, email').in('role', ['admin', 'staff']),
    defaultCurrency(admin), getSettings(admin),
  ]);
  const shipIds = (ships.data || []).map(x => x.id);
  const { data: costs } = shipIds.length ? await admin.from('freight_costs').select('shipment_id, amount, currency, description, paid, paid_at, created_at').in('shipment_id', shipIds) : { data: [] };
  const ownBy = new Map((own.data || []).map(o => [o.id, o]));
  const rep = buildReport({ orders: orders.map(o => ({ ...o, ...(ownBy.get(o.id) || {}) })), pays: pays.data || [], pos: pos.data || [], ships: ships.data || [], costs: costs || [], staff: staff.data || [], settings, cur });
  res.render('admin/report/index', { title: 'Report', ...rep, status, level: levelOf(req.user) });
});

export default r;
