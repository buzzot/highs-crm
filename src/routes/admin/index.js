import { Router } from '../../lib/router.js';
import { requireAdmin } from '../../middleware/auth.js';
import { sendEmail, emailDiagnostics } from '../../lib/mailer.js';
import { codeEmail } from '../../lib/email-templates.js';
import { requireStaff } from '../../middleware/auth.js';
import { admin, rawDb } from '../../lib/supabase.js';
import { levelOf, isManager, canDelete, canAssign, guardFor, LEVEL_LABEL } from '../../lib/access.js';
import { defaultCurrency, sumIn } from '../../lib/currency.js';
import { getSettings } from '../../lib/util.js';
import { applyCashProfit } from '../../lib/order-profit.js';
import { needsAttention, paymentsOpen, shipmentFlag, statusSummary, groupCounts, isOpenOrder, groupActivity, elapsed } from '../../lib/dashboard.js';
import clients from './clients.js';
import suppliers from './suppliers.js';
import products from './products.js';
import imports from './imports.js';
import sourcing from './sourcing.js';
import logistics from './logistics.js';
import pricing from './pricing.js';
import purchasing from './purchasing.js';
import rfqs from './rfqs.js';
import documents from './documents.js';
import orders from './orders.js';
import report from './report.js';
import { po as poRoutes, pi as piRoutes } from './po.js';
import { FEATURES, costOf, clearPriceCache, getPrices } from '../../lib/ai-usage.js';

const r = Router();
r.use(requireStaff);
r.use(async (req, res, next) => { res.locals.defCur = await defaultCurrency(admin); next(); }); // the company's default currency, for forms and totals

// access levels: who the user is, a Manager only reaches their own records, and only an Admin deletes what somebody else created
const DELETE_ROUTES = [
  { re: /^\/rfqs\/([0-9a-f-]{36})\/delete$/, table: 'rfqs' },
  { re: /^\/logistics\/shipments\/([0-9a-f-]{36})\/delete$/, table: 'shipments' },
  { re: /^\/purchasing\/([0-9a-f-]{36})\/delete$/, table: 'supplier_pos' },
];
const denied = (res, status, message) => res.status(status).render('error', { title: status === 404 ? 'Not found' : 'Not allowed', message });
r.use(async (req, res, next) => {
  const u = req.user, lvl = levelOf(u);
  Object.assign(res.locals, { level: lvl, levelLabel: LEVEL_LABEL[lvl], isManager: isManager(u), canDelete: rec => canDelete(u, rec), canAssign: canAssign(u) });
  if (isManager(u)) {
    const g = guardFor(req.path);
    if (g) {
      const { data } = await rawDb.from(g.table).select('id').eq('id', g.id).eq('owner_id', u.id).maybeSingle();
      if (!data) return denied(res, 404, 'This record does not exist, or it belongs to someone else.');
    }
  }
  if (req.method === 'POST' && lvl !== 'admin') {
    const d = DELETE_ROUTES.map(x => ({ x, m: req.path.match(x.re) })).find(y => y.m);
    if (d) {
      const { data } = await rawDb.from(d.x.table).select('created_by').eq('id', d.m[1]).maybeSingle();
      if (data && data.created_by !== u.id) return denied(res, 403, 'You can only delete records you created yourself. Ask an Admin.');
    }
  }
  next();
});

// owner box on the main page of a record: who owns it, and (Admin / Director) a way to hand it to someone else
const OWNER_PAGE = [
  { re: /^\/clients\/([0-9a-f-]{36})$/, table: 'organizations' }, { re: /^\/sourcing\/([0-9a-f-]{36})$/, table: 'requests' },
  { re: /^\/orders\/([0-9a-f-]{36})$/, table: 'orders' }, { re: /^\/rfqs\/([0-9a-f-]{36})$/, table: 'rfqs' },
  { re: /^\/logistics\/shipments\/([0-9a-f-]{36})$/, table: 'shipments' }, { re: /^\/pricing\/quotes\/([0-9a-f-]{36})$/, table: 'quotes' },
];
r.use(async (req, res, next) => {
  if (req.method !== 'GET') return next();
  const o = OWNER_PAGE.map(x => ({ x, m: req.path.match(x.re) })).find(y => y.m);
  if (!o) return next();
  try {
    const [{ data: rec, error }, { data: staff }] = await Promise.all([
      rawDb.from(o.x.table).select('owner_id, created_by').eq('id', o.m[1]).maybeSingle(),
      rawDb.from('profiles').select('id, full_name, email, role, staff_level').in('role', ['admin', 'staff']).eq('active', true).order('email'),
    ]);
    if (!error) {
      const name = id => { const p = (staff || []).find(x => x.id === id); return p ? (p.full_name || p.email) : null; };
      res.locals.ownerBox = { table: o.x.table, id: o.m[1], ownerId: rec?.owner_id || null, ownerName: name(rec?.owner_id), createdByName: name(rec?.created_by), staff: staff || [], redirect: req.originalUrl.split('?')[0] };
    }
  } catch { /* migration 0036 not applied yet: no owner box */ }
  next();
});

// hand a record (and what belongs to it) to another team member — Admin / Director only
const OWNER_TABLES = ['organizations', 'requests', 'quotes', 'orders', 'shipments', 'rfqs'];
r.post('/owner', async (req, res) => {
  const back = u => res.redirect(u);
  const to = typeof req.body.redirect === 'string' && req.body.redirect.startsWith('/admin') ? req.body.redirect : '/admin';
  if (!canAssign(req.user)) return denied(res, 403, 'Only an Admin or Director can assign records.');
  const { table, id } = req.body;
  if (!OWNER_TABLES.includes(table) || !/^[0-9a-f-]{36}$/.test(String(id))) return back(`${to}?err=${encodeURIComponent('Unknown record.')}`);
  const owner = req.body.owner_id ? String(req.body.owner_id) : null;
  if (owner) { const { data: p } = await rawDb.from('profiles').select('id').eq('id', owner).in('role', ['admin', 'staff']).maybeSingle(); if (!p) return back(`${to}?err=${encodeURIComponent('Choose a team member.')}`); }
  const set = (t, col, val) => rawDb.from(t).update({ owner_id: owner }).eq(col, val);
  const { error } = await set(table, 'id', id);
  if (error) return back(`${to}?err=${encodeURIComponent(/owner_id/.test(error.message) ? 'Run supabase/migrations/0036_access_levels.sql first.' : error.message)}`);
  if (req.body.cascade) {   // what belongs to it follows
    const ids = async (t, col, val) => ((await rawDb.from(t).select('id').eq(col, val)).data || []).map(x => x.id);
    if (table === 'organizations') for (const t of ['requests', 'orders']) await set(t, 'org_id', id);
    const reqIds = table === 'organizations' ? await ids('requests', 'org_id', id) : table === 'requests' ? [id] : [];
    for (const rid of reqIds) for (const t of ['quotes', 'rfqs', 'orders']) await set(t, 'request_id', rid);
    const orderIds = table === 'orders' ? [id] : table === 'organizations' || table === 'requests' ? (await Promise.all((reqIds.length ? reqIds : [id]).map(rid => ids('orders', 'request_id', rid)))).flat() : [];
    for (const oid of orderIds) await set('shipments', 'order_id', oid);
    if (table === 'organizations') for (const oid of await ids('orders', 'org_id', id)) await set('shipments', 'order_id', oid);
  }
  back(`${to}?msg=${encodeURIComponent(owner ? 'Owner changed.' : 'Owner removed — only Admin and Director can see it now.')}`);
});

r.get('/', async (req, res) => {
  const now = Date.now(), today = new Date(now).toISOString().slice(0, 10);
  const [settings, defCur] = await Promise.all([getSettings(admin), defaultCurrency(admin)]);
  // a table that does not exist yet (migration not run) must not break the dashboard
  const safe = async q => { try { const x = await q; return x.error ? { data: [], count: 0 } : x; } catch { return { data: [], count: 0 }; } };
  const [reqs, orders, shipments, activity, exportGaps, pos, pis, pays, quotes, rfqs, rfqReplies] = await Promise.all([
    admin.from('requests').select('id, ref, title, status, created_at, owner_id, organizations(name)').in('status', ['new', 'reviewing']).order('created_at', { ascending: false }).limit(300),
    admin.from('order_overview').select('*').order('created_at', { ascending: false }),
    admin.from('shipments').select('id, status, eta, ata, mode, tracking_no, owner_id, orders(order_no, owner_id, organizations(name))').not('status', 'in', '("delivered")').order('eta').limit(300),
    (isManager(req.user) ? admin.from('activity_log').select('*, profiles(full_name, email)').eq('actor_id', req.user.id) : admin.from('activity_log').select('*, profiles(full_name, email)')).order('created_at', { ascending: false }).limit(40),
    // shipped without a government export declaration number on file
    admin.from('shipments').select('id, status, owner_id, orders(order_no, owner_id)').eq('export_official', true).is('export_declaration_no', null)
      .in('status', ['departed', 'arrived', 'customs', 'delivered']),
    safe(admin.from('supplier_pos').select('id, ref, status, currency, total, sent_at, last_reply_at, created_by, orders(owner_id), suppliers(name)').in('status', ['sent', 'replied', 'confirmed']).order('created_at', { ascending: false }).limit(1000)),
    safe(admin.from('supplier_pis').select('id, po_id, status, currency, total, created_at').limit(400)),
    safe(admin.from('supplier_payments').select('po_id, amount, currency').limit(1000)),
    safe(admin.from('quotes').select('id, status, valid_until, owner_id, requests(ref, organizations(name))').eq('status', 'sent').limit(100)),
    safe(admin.from('rfqs').select('id, ref, title, deadline, owner_id').eq('status', 'open').limit(100)),
    safe(admin.from('rfq_responses').select('rfq_id, rfqs(id, ref, title, owner_id)').eq('status', 'parsed').limit(100)),
  ]);
  const all = orders.data || [];
  await applyCashProfit(all);   // same profit rule as the Orders list (logistics-only orders: cash profit)
  const open = all.filter(isOpenOrder);
  const me = req.user.id, mgr = isManager(req.user);
  // a supplier PO belongs to the owner of its order, else to whoever created it (there is no owner column on supplier POs)
  const poMine = p => (p.orders?.owner_id || p.created_by) === me;
  const poList = (pos.data || []).filter(p => !mgr || poMine(p));       // a Manager only works with their own supplier POs
  const poIds = new Set(poList.map(p => p.id));
  const piList = (pis.data || []).filter(p => poIds.has(p.po_id)), payList = (pays.data || []).filter(p => poIds.has(p.po_id));
  // outstanding supplier money = approved PI totals − payments recorded, per PO, converted with the Settings rates
  const owing = paymentsOpen({ pis: piList, pays: payList, pos: poList }).filter(x => x.open > 0.004);
  const rfqReplyMap = new Map();
  (rfqReplies.data || []).forEach(x => { const k = x.rfq_id; const e = rfqReplyMap.get(k) || { ...(x.rfqs || {}), n: 0 }; e.n++; rfqReplyMap.set(k, e); });
  const reqList = reqs.data || [];
  const attentionAll = needsAttention({
    now, today, pos: poList, pis: piList, pays: payList, requests: reqList, quotes: quotes.data || [], rfqs: rfqs.data || [],
    rfqReplies: [...rfqReplyMap.values()], shipments: shipments.data || [],
    exportGaps: exportGaps.data || [], lowMargin: all.filter(o => o.margin_pct != null && o.margin_pct < 20 && !['closed', 'cancelled', 'delivered'].includes(o.status)),
  });
  // My tasks = rows on records I own (orders, requests, quotes, RFQs, shipments by their owner; supplier POs as above). A Manager only ever sees their own.
  const scope = mgr || req.query.scope === 'mine' ? 'mine' : 'all';
  const mine = attentionAll.filter(a => a.owner === me);
  const attention = scope === 'mine' ? mine : attentionAll;
  const inTransit = (shipments.data || []).filter(s => ['picked_up', 'departed'].includes(s.status));
  const sCount = st => poList.filter(p => p.status === st).length;
  const kpi = {
    openOrders: open.length, shippingOrders: open.filter(o => ['shipped', 'in_transit', 'customs'].includes(o.status)).length,
    toPrice: reqList.length,
    rfqAction: (rfqs.data || []).length, rfqParsed: rfqReplyMap.size,
    poWait: sCount('sent'), poReplied: sCount('replied'),
    piPending: piList.filter(p => p.status === 'draft').length,        // draft PIs of live supplier POs
    owingN: owing.length, owingTotal: sumIn(settings, defCur, owing.map(x => [x.open, x.currency])), owingCurs: [...new Set(owing.map(x => x.currency))],
    inTransit: inTransit.length,
    arriving: inTransit.filter(s => shipmentFlag(s, today)?.kind === 'soon').length,        // a subset of in transit: ETA within 7 days, not yet arrived
    lowMargin: all.filter(o => o.margin_pct != null && o.margin_pct < 20 && !['closed', 'cancelled'].includes(o.status)).length,
  };
  const shipRows = (shipments.data || []).map(s => ({ ...s, flag: shipmentFlag(s, today) }))
    .sort((a, b) => ({ late: 0, soon: 1, notrack: 2 }[a.flag?.kind] ?? 3) - ({ late: 0, soon: 1, notrack: 2 }[b.flag?.kind] ?? 3));
  res.render('admin/dashboard', {
    title: 'Dashboard', kpi, today, attention,
    groups: groupCounts(open, all), summary: statusSummary(open),
    taskScope: scope, scopeCounts: { mine: mine.length, all: attentionAll.length }, canSwitch: !mgr, generatedAt: new Date(now).toISOString(),
    shipments: shipRows.slice(0, 6), shipTotal: shipRows.length, activity: groupActivity(activity.data || [], 8),
    orders: open.slice(0, 8), openTotal: open.length, ago: t => elapsed(t, now), 
  });
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

// AI usage report: tokens per day, feature, person and model (last 30 days) + optional cost estimate
r.get('/ai-usage', requireAdmin, async (req, res) => {
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const [{ data: rows, error }, { data: people }, prices] = await Promise.all([
    admin.from('ai_usage').select('*').gte('created_at', since).order('created_at', { ascending: false }).limit(10000),
    admin.from('profiles').select('id, full_name, email').in('role', ['admin', 'staff']),
    getPrices(),
  ]);
  const who = Object.fromEntries((people || []).map(p => [p.id, p.full_name || p.email]));
  const list = (rows || []).map(x => {
    const u = { model: x.model, input: x.input_tokens, output: x.output_tokens, cacheRead: x.cache_read_tokens, cacheWrite: x.cache_write_tokens };
    u.total = u.input + u.output + u.cacheRead + u.cacheWrite;
    return { ...x, u, cost: costOf(u, prices), who: who[x.user_id] || (x.user_id ? 'former user' : 'system') };
  });
  const sum = xs => xs.reduce((a, x) => ({ calls: a.calls + 1, failed: a.failed + (x.ok ? 0 : 1), input: a.input + x.u.input + x.u.cacheRead + x.u.cacheWrite, output: a.output + x.u.output, total: a.total + x.u.total, cost: x.cost == null ? a.cost : (a.cost || 0) + x.cost }), { calls: 0, failed: 0, input: 0, output: 0, total: 0, cost: null });
  const day = d => new Date(d).toISOString().slice(0, 10);
  const today = day(Date.now());
  const group = key => Object.entries(list.reduce((m, x) => ((m[key(x)] ||= []).push(x), m), {})).map(([k, xs]) => ({ key: k, ...sum(xs) })).sort((a, b) => b.total - a.total);
  const days = Array.from({ length: 30 }, (_, i) => day(Date.now() - (29 - i) * 864e5)).map(d => ({ key: d, ...sum(list.filter(x => day(x.created_at) === d)) }));
  res.render('admin/ai_usage', {
    title: 'AI usage', missing: !!error, prices: prices || {}, features: FEATURES,
    totals: { today: sum(list.filter(x => day(x.created_at) === today)), week: sum(list.filter(x => x.created_at >= new Date(Date.now() - 7 * 864e5).toISOString())), month: sum(list) },
    byFeature: group(x => x.feature), byUser: group(x => x.who), byModel: group(x => x.model || '—'), days, recent: list.slice(0, 60),
    msg: req.query.msg,
  });
});
r.post('/ai-usage/prices', requireAdmin, async (req, res) => {
  const v = k => (Number(req.body[k]) >= 0 ? Number(req.body[k]) : 0);
  await admin.from('settings').upsert({ key: 'ai_prices', value: { input_per_m: v('input_per_m'), output_per_m: v('output_per_m') }, updated_at: new Date().toISOString() });
  clearPriceCache();
  res.redirect('/admin/ai-usage?msg=' + encodeURIComponent('Prices saved — costs are estimates from these prices.'));
});
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
r.use('/purchasing', purchasing);
r.use('/rfqs', rfqs);
r.use('/logistics', logistics);
r.use('/pricing', pricing);
r.use('/documents', documents);
r.use('/orders', orders);
r.use('/report', report);
r.use('/po', poRoutes);
r.use('/pi', piRoutes);

export default r;
