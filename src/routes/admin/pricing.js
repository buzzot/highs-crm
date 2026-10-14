import { Router } from '../../lib/router.js';
import { admin } from '../../lib/supabase.js';
import { calcQuote } from '../../lib/pricing.js';
import { verifyQuote } from '../../lib/ai.js';
import { log } from '../../lib/activity.js';
import { sendEmail } from '../../lib/mailer.js';
import { quoteSentEmail } from '../../lib/email-templates.js';
import { requireAdmin } from '../../middleware/auth.js';
import { clean, bool, back, notFound, getSettings, fxRate, INCOTERMS, CURRENCIES } from '../../lib/util.js';

const r = Router();
const QUOTE_FIELDS = ['request_id', 'request_item_id', 'product_id', 'supplier_id', 'quantity', 'unit_cost', 'cost_currency', 'fx_rate', 'margin_pct', 'sell_currency',
  'freight_estimate', 'duties_estimate', 'other_costs', 'incoterm', 'lead_time_days', 'valid_until', 'notes'];

function compute(b, settings) {
  return calcQuote({
    unitCost: b.unit_cost, fxRate: b.fx_rate, marginPct: b.margin_pct, quantity: b.quantity,
    freightTotal: b.freight_estimate, dutiesTotal: b.duties_estimate, otherTotal: b.other_costs,
    minMarginPct: settings.pricing.min_margin_pct,
  });
}

async function context(q) {
  const [product, supplier, request] = await Promise.all([
    q.product_id ? admin.from('products').select('*').eq('id', q.product_id).single().then(x => x.data) : null,
    q.supplier_id ? admin.from('suppliers').select('*').eq('id', q.supplier_id).single().then(x => x.data) : null,
    q.request_id ? admin.from('requests').select('*').eq('id', q.request_id).single().then(x => x.data) : null,
  ]);
  return { product, supplier, request };
}

async function formLists() {
  let [{ data: products }, { data: suppliers }, { data: requests, error: rErr }] = await Promise.all([
    admin.from('products').select('id, name, sku, supplier_id, unit_cost, cost_currency, moq, hs_code, unit_weight_kg, carton_qty, carton_cbm').order('name'),
    admin.from('suppliers').select('id, name, lead_time_days').order('name'),
    admin.from('requests').select('id, ref, title, quantity, target_unit_price, target_currency, organizations(name), request_items(id, name, quantity, unit, target_unit_price, position)')
      .in('status', ['new', 'reviewing', 'quoted']).order('created_at', { ascending: false }),
  ]);
  if (rErr) { // migration 0009 not applied yet
    console.error(`[pricing] ${rErr.message} — run supabase/migrations/0009_request_items.sql`);
    ({ data: requests } = await admin.from('requests').select('id, ref, title, quantity, target_unit_price, target_currency, organizations(name)')
      .in('status', ['new', 'reviewing', 'quoted']).order('created_at', { ascending: false }));
  }
  return { products: products || [], suppliers: suppliers || [], requests: requests || [] };
}

// Pricing home: calculator + quotes register
r.get('/', async (req, res) => {
  const settings = await getSettings(admin);
  let q = admin.from('quotes').select('*, requests(id, ref, title, organizations(name)), products(name), suppliers(name)')
    .order('created_at', { ascending: false }).limit(100);
  if (req.query.status) q = q.eq('status', req.query.status);
  const [{ data: quotes }, lists] = await Promise.all([q, formLists()]);
  res.render('admin/pricing/index', { title: 'Pricing', quotes: quotes || [], settings, ...lists, currencies: CURRENCIES, msg: req.query.msg });
});

// Ad-hoc AI check from the calculator (nothing saved)
r.post('/check', async (req, res) => {
  const settings = await getSettings(admin);
  const b = req.body;
  const calc = compute(b, settings);
  const ctx = await context(b);
  try {
    const out = await verifyQuote({ quote: b, calc, ...ctx, settings });
    res.json({ ...out, usage_line: out.usage ? res.locals.aiLine(out.usage) : null });
  } catch (e) {
    res.status(502).json({ ok: false, score: 0, issues: [{ severity: 'high', field: 'ai', message: e.message }], summary: 'AI check failed.' });
  }
});

// ---- quotes ----
r.get('/quotes/new', async (req, res) => {
  const settings = await getSettings(admin);
  const lists = await formLists();
  const q = { quantity: '', margin_pct: settings.pricing.default_margin_pct, cost_currency: 'CNY', sell_currency: 'USD', incoterm: 'FOB',
    freight_estimate: 0, duties_estimate: 0, other_costs: 0, request_id: req.query.request_id || '', request_item_id: req.query.item_id || '', product_id: req.query.product_id || '',
    valid_until: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10) };
  const req0 = lists.requests.find(x => x.id === q.request_id);
  if (req0) {
    q.quantity = req0.quantity || ''; q.sell_currency = req0.target_currency || 'USD';
    const it = (req0.request_items || []).find(i => i.id === q.request_item_id) || (req0.request_items?.length === 1 ? req0.request_items[0] : null);
    if (it) { q.request_item_id = it.id; if (it.quantity) q.quantity = it.quantity; }
  }
  const p = lists.products.find(x => x.id === q.product_id);
  if (p) { q.unit_cost = p.unit_cost; q.cost_currency = p.cost_currency; q.supplier_id = p.supplier_id; }
  q.fx_rate = fxRate(settings, q.cost_currency, q.sell_currency);
  // request might not be open anymore — still allow quoting it
  if (q.request_id && !req0) {
    const { data } = await admin.from('requests').select('id, ref, title, quantity, target_unit_price, target_currency, organizations(name), request_items(id, name, quantity, unit, target_unit_price, position)').eq('id', q.request_id).single();
    if (data) lists.requests.unshift(data);
  }
  res.render('admin/pricing/quote_form', { title: 'New quote', q, settings, ...lists, incoterms: INCOTERMS, currencies: CURRENCIES, error: null });
});

async function saveQuote(req, res, id) {
  const settings = await getSettings(admin);
  const b = clean(req.body, QUOTE_FIELDS);
  if (!b.request_id) {
    const lists = await formLists();
    return res.status(400).render('admin/pricing/quote_form', { title: id ? 'Edit quote' : 'New quote', q: { ...req.body, id }, settings, ...lists, incoterms: INCOTERMS, currencies: CURRENCIES, error: 'Pick the client request this quote answers.' });
  }
  if (b.product_id) { // the supplier belongs to the product
    const { data: pr } = await admin.from('products').select('supplier_id').eq('id', b.product_id).maybeSingle();
    if (pr?.supplier_id) b.supplier_id = pr.supplier_id;
  }
  if (b.request_item_id) {
    const { data: it } = await admin.from('request_items').select('request_id').eq('id', b.request_item_id).maybeSingle();
    if (it?.request_id !== b.request_id) b.request_item_id = null;
  }
  if (!b.request_item_id && !id) delete b.request_item_id; // keeps working before migration 0009
  const calc = compute(b, settings);
  const row = {
    ...b, quantity: calc.quantity, margin_pct: calc.marginPct, fx_rate: Number(b.fx_rate) || 1,
    freight_estimate: Number(b.freight_estimate) || 0, duties_estimate: Number(b.duties_estimate) || 0, other_costs: Number(b.other_costs) || 0,
    unit_price: calc.unitPrice, landed_unit_price: calc.landedUnitPrice,
  };
  let qid = id;
  if (id) {
    const { data: cur } = await admin.from('quotes').select('status').eq('id', id).single();
    if (!cur) return notFound(res, 'Quote');
    if (!['draft', 'sent'].includes(cur.status)) return back(res, `/admin/pricing/quotes/${id}`, { err: `A ${cur.status} quote can't be edited — duplicate it instead.` });
    const { error } = await admin.from('quotes').update({ ...row, ai_check: null, status: 'draft' }).eq('id', id);
    if (error) return back(res, `/admin/pricing/quotes/${id}`, { err: error.message });
  } else {
    const { data, error } = await admin.from('quotes').insert({ ...row, created_by: req.user.id }).select('id').single();
    if (error) {
      const lists = await formLists();
      return res.status(400).render('admin/pricing/quote_form', { title: 'New quote', q: req.body, settings, ...lists, incoterms: INCOTERMS, currencies: CURRENCIES, error: error.message });
    }
    qid = data.id;
    await admin.from('requests').update({ status: 'reviewing' }).eq('id', b.request_id).eq('status', 'new');
  }
  if (req.body.action === 'verify') return verifyAndBack(req, res, qid);
  back(res, `/admin/pricing/quotes/${qid}`, { msg: 'Quote saved as draft.' });
}

r.post('/quotes', (req, res) => saveQuote(req, res, null));

r.get('/quotes/:id', async (req, res) => {
  const settings = await getSettings(admin);
  const { data: q } = await admin.from('quotes').select('*, requests(*, organizations(name)), products(*), suppliers(*)').eq('id', req.params.id).single();
  if (!q) return notFound(res, 'Quote');
  if (q.requests) {
    const { data: its } = await admin.from('request_items').select('id, name, quantity, unit, target_unit_price, position').eq('request_id', q.request_id);
    q.requests.request_items = its || [];
    q.item = (its || []).find(i => i.id === q.request_item_id) || null;
  }
  const calc = compute(q, settings);
  const lists = await formLists();
  if (q.requests && !lists.requests.find(x => x.id === q.request_id)) lists.requests.unshift(q.requests);
  const { data: order } = await admin.from('orders').select('id, order_no').eq('quote_id', q.id).maybeSingle();
  res.render('admin/pricing/quote', {
    title: 'Quote', q, calc, settings, order, ...lists, incoterms: INCOTERMS, currencies: CURRENCIES,
    msg: req.query.msg, err: req.query.err,
  });
});

r.post('/quotes/:id', (req, res) => saveQuote(req, res, req.params.id));

async function verifyAndBack(req, res, id) {
  const settings = await getSettings(admin);
  const { data: q } = await admin.from('quotes').select('*').eq('id', id).single();
  if (!q) return notFound(res, 'Quote');
  const calc = compute(q, settings);
  let result;
  try {
    result = await verifyQuote({ quote: q, calc, ...(await context(q)), settings });
  } catch (e) {
    return back(res, `/admin/pricing/quotes/${id}`, { err: `AI check failed: ${e.message}` });
  }
  await admin.from('quotes').update({ ai_check: result }).eq('id', id);
  back(res, `/admin/pricing/quotes/${id}`, { msg: result.ok ? 'AI check passed.' : 'AI check flagged issues — review below.' });
}
r.post('/quotes/:id/verify', (req, res) => verifyAndBack(req, res, req.params.id));

// Send to client: enforces the minimum margin (admins can override with a reason)
r.post('/quotes/:id/send', async (req, res) => {
  const settings = await getSettings(admin);
  const { data: q } = await admin.from('quotes').select('*').eq('id', req.params.id).single();
  if (!q) return notFound(res, 'Quote');
  if (q.status !== 'draft') return back(res, `/admin/pricing/quotes/${q.id}`, { err: 'Only draft quotes can be sent.' });
  const calc = compute(q, settings);
  const override = bool(req.body.override) && req.user.role === 'admin';
  if (!calc.meetsMinimum && !override) {
    return back(res, `/admin/pricing/quotes/${q.id}`, { err: `Margin ${calc.marginPct}% is below the ${settings.pricing.min_margin_pct}% minimum. An admin must override.` });
  }
  if (!q.ai_check && !bool(req.body.skip_ai)) {
    return back(res, `/admin/pricing/quotes/${q.id}`, { err: 'Run the AI check first (or tick "send without AI check").' });
  }
  await admin.from('quotes').update({ status: 'sent' }).eq('id', q.id);
  await admin.from('requests').update({ status: 'quoted' }).eq('id', q.request_id);
  await log({ entityType: 'request', entityId: q.request_id, action: 'quote_sent', actorId: req.user.id, clientVisible: true, detail: { quote_id: q.id } });
  if (override) await log({ entityType: 'request', entityId: q.request_id, action: 'margin_override', actorId: req.user.id, detail: { quote_id: q.id, margin: calc.marginPct, reason: req.body.reason } });
  // email the client: the person who made the request, otherwise everyone active in that company
  let sentTo = [];
  try {
    const { data: rq } = await admin.from('requests').select('id, ref, title, org_id, created_by').eq('id', q.request_id).single();
    let { data: people } = rq.created_by ? await admin.from('profiles').select('email').eq('id', rq.created_by).eq('active', true) : { data: [] };
    if (!people?.length) ({ data: people } = await admin.from('profiles').select('email').eq('org_id', rq.org_id).eq('role', 'client').eq('active', true));
    sentTo = [...new Set((people || []).map(p => p.email).filter(Boolean))];
    if (sentTo.length) await sendEmail({ to: sentTo, ...quoteSentEmail({ request: rq, validUntil: q.valid_until, leadTimeDays: q.lead_time_days, url: `${(process.env.APP_URL || '').replace(/\/+$/, '')}/portal/requests/${rq.id}` }) });
  } catch (e) { console.error(`[quote] email to client failed: ${e.message}`); return back(res, `/admin/pricing/quotes/${q.id}`, { msg: 'Quote sent — the client can see it in their portal, but the email notification failed.' }); }
  back(res, `/admin/pricing/quotes/${q.id}`, { msg: `Quote sent — the client can see it in their portal${sentTo.length ? ` and was notified by email (${sentTo.join(', ')}).` : '.'}` });
});

r.post('/quotes/:id/duplicate', async (req, res) => {
  const { data: q } = await admin.from('quotes').select('*').eq('id', req.params.id).single();
  if (!q) return notFound(res, 'Quote');
  const { id, created_at, status, ai_check, ...rest } = q; // eslint-disable-line no-unused-vars
  const { data } = await admin.from('quotes').insert({ ...rest, status: 'draft', created_by: req.user.id }).select('id').single();
  res.redirect(`/admin/pricing/quotes/${data.id}`);
});

r.post('/quotes/:id/withdraw', async (req, res) => {
  await admin.from('quotes').update({ status: 'expired' }).eq('id', req.params.id).in('status', ['draft', 'sent']);
  back(res, `/admin/pricing/quotes/${req.params.id}`, { msg: 'Quote withdrawn.' });
});

// ---- settings (FX + margin rules) ----
r.get('/settings', requireAdmin, async (req, res) => {
  res.render('admin/pricing/settings', { title: 'Pricing settings', settings: await getSettings(admin), msg: req.query.msg });
});
r.post('/settings', requireAdmin, async (req, res) => {
  const fx = {};
  [].concat(req.body.pair || []).forEach((pair, i) => {
    const v = Number([].concat(req.body.rate || [])[i]);
    if (/^[A-Z]{3}_[A-Z]{3}$/.test(pair) && v > 0) fx[pair] = v;
  });
  const pricing = {
    min_margin_pct: Math.max(0, Number(req.body.min_margin_pct) || 20),
    default_margin_pct: Math.max(0, Number(req.body.default_margin_pct) || 25),
  };
  const pos = (v, d) => (Number(v) > 0 ? Number(v) : d);
  const container = {
    freight_40hq_usd: pos(req.body.freight_40hq_usd, 4500), container_cbm: pos(req.body.container_cbm, 68),
    container_max_kg: pos(req.body.container_max_kg, 26500), wholesale_markup_pct: Math.max(0, Number(req.body.wholesale_markup_pct) || 45),
  };
  await admin.from('settings').upsert([
    { key: 'container', value: container, updated_at: new Date().toISOString() },
    { key: 'fx_rates', value: fx, updated_at: new Date().toISOString() },
    { key: 'pricing', value: pricing, updated_at: new Date().toISOString() },
  ]);
  back(res, '/admin/pricing/settings', { msg: 'Settings saved.' });
});

export default r;
