import { Router } from '../../lib/router.js';
import { requireAdmin } from '../../middleware/auth.js';
import { sendEmail, emailDiagnostics } from '../../lib/mailer.js';
import { codeEmail } from '../../lib/email-templates.js';
import { requireStaff } from '../../middleware/auth.js';
import { admin } from '../../lib/supabase.js';
import clients from './clients.js';
import suppliers from './suppliers.js';
import products from './products.js';
import imports from './imports.js';
import sourcing from './sourcing.js';
import logistics from './logistics.js';
import pricing from './pricing.js';
import documents from './documents.js';
import orders from './orders.js';

const r = Router();
r.use(requireStaff);

r.get('/', async (req, res) => {
  const since30 = new Date(Date.now() - 30 * 864e5).toISOString();
  const [reqs, orders, shipments, activity, clientsCount, exportGaps, draftQuotes] = await Promise.all([
    admin.from('requests').select('id, ref, title, status, created_at, organizations(name)').order('created_at', { ascending: false }).limit(8),
    admin.from('order_overview').select('*').order('created_at', { ascending: false }),
    admin.from('shipments').select('id, status, eta, mode, tracking_no, orders(order_no, organizations(name))').not('status', 'in', '("delivered")').order('eta').limit(8),
    admin.from('activity_log').select('*, profiles(full_name, email)').order('created_at', { ascending: false }).limit(15),
    admin.from('organizations').select('id', { count: 'exact', head: true }).eq('active', true),
    // shipped without a government export declaration number on file
    admin.from('shipments').select('id, status, orders(order_no)').eq('export_official', true).is('export_declaration_no', null)
      .in('status', ['departed', 'arrived', 'customs', 'delivered']),
    admin.from('quotes').select('id', { count: 'exact', head: true }).eq('status', 'draft'),
  ]);
  const all = orders.data || [];
  const open = all.filter(o => !['delivered', 'closed', 'cancelled'].includes(o.status));
  const byStatus = {};
  open.forEach(o => { byStatus[o.status] = (byStatus[o.status] || 0) + 1; });
  const recent = all.filter(o => o.created_at >= since30);
  const kpi = {
    clients: clientsCount.count || 0,
    openRequests: (reqs.data || []).filter(q => ['new', 'reviewing'].includes(q.status)).length,
    openOrders: open.length,
    revenue30: recent.reduce((s, o) => s + Number(o.subtotal || 0), 0),
    profit30: recent.reduce((s, o) => s + Number(o.gross_profit || 0), 0),
    lowMargin: all.filter(o => o.margin_pct != null && o.margin_pct < 20 && !['closed', 'cancelled'].includes(o.status)).length,
    draftQuotes: draftQuotes.count || 0,
  };
  // revenue & profit by month, last 6 months
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - i);
    months.push({ key: d.toISOString().slice(0, 7), label: d.toLocaleString('en-GB', { month: 'short' }), revenue: 0, profit: 0 });
  }
  all.filter(o => o.status !== 'cancelled').forEach(o => {
    const m = months.find(x => x.key === String(o.created_at).slice(0, 7));
    if (m) { m.revenue += Number(o.subtotal || 0); m.profit += Number(o.gross_profit || 0); }
  });
  res.render('admin/dashboard', { title: 'Dashboard', kpi, byStatus, requests: reqs.data || [], shipments: shipments.data || [], activity: activity.data || [], orders: open.slice(0, 8), months, exportGaps: exportGaps.data || [] });
});

// ---- Email check (admin): settings, Resend domain, database, test email ----
async function emailCheck(req, res, extra = {}) {
  const diag = await emailDiagnostics();
  const tables = {};
  for (const [name, q] of Object.entries({
    'auth_codes table (migration 0007)': admin.from('auth_codes').select('id', { head: true, count: 'exact' }),
    'profile columns (migrations 0004/0006)': admin.from('profiles').select('accepted_at, invited_at, job_title').limit(1),
    'invitation columns (migrations 0004/0006)': admin.from('invitations').select('token, expires_at, verified_at').limit(1),
  })) { const { error } = await q; tables[name] = error ? error.message : 'ok'; }
  const { data: recent } = await admin.from('auth_codes').select('email, purpose, created_at, used_at, attempts').order('created_at', { ascending: false }).limit(8);
  res.render('admin/email_check', { title: 'Email check', diag, tables, recent: recent || [], appUrl: process.env.APP_URL || null,
    twoFa: !/^(off|false|0|no)$/i.test(process.env.LOGIN_2FA || ''), ...extra });
}
r.get('/email-check', requireAdmin, (req, res) => emailCheck(req, res));
r.post('/email-check/test', requireAdmin, async (req, res) => {
  const to = String(req.body.to || req.user.email).trim();
  try {
    const m = codeEmail({ url: `${(process.env.APP_URL || '').replace(/\/+$/, '')}/login`, code: '123456', minutes: 15 });
    const r2 = await sendEmail({ to, ...m, subject: 'Lumi Trade — test email' });
    await emailCheck(req, res, { test: { ok: true, to, id: r2.id } });
  } catch (e) {
    await emailCheck(req, res, { test: { ok: false, to, error: e.message } });
  }
});

r.use('/clients', clients);
r.use('/suppliers', suppliers);
r.use('/products/import', imports);
r.use('/products', products);
r.use('/sourcing', sourcing);
r.use('/logistics', logistics);
r.use('/pricing', pricing);
r.use('/documents', documents);
r.use('/orders', orders);

export default r;
