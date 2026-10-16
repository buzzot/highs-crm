import { Router } from '../../lib/router.js';
import { admin } from '../../lib/supabase.js';
import { calcQuote } from '../../lib/pricing.js';
import { verifyQuote } from '../../lib/ai.js';
import { log } from '../../lib/activity.js';
import { sendEmail } from '../../lib/mailer.js';
import { getCompany } from '../../lib/purchase.js';
import { combineQuotes, dropReplaced, quotationPdf, LIVE } from '../../lib/combined-quote.js';
import { quoteSentEmail } from '../../lib/email-templates.js';
import { requireAdmin } from '../../middleware/auth.js';
import { cargoLine, cargoTotals, AIR_KG_PER_CBM } from '../../lib/cargo.js';
import { CONTAINER_DEFAULTS } from '../../lib/product-metrics.js';
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
  const { data: orgs } = await admin.from('organizations').select('id, name').eq('active', true).order('name');
  return { products: products || [], suppliers: suppliers || [], requests: requests || [], orgs: orgs || [] };
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

// ---- one quote for several products (picked on the Products list), possibly from different suppliers ----
const refIRQ = () => `IRQ-${new Date().toISOString().slice(2, 7).replace('-', '')}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
const productIds = v => [...new Set([].concat(v || []).join(',').split(',').map(x => x.trim()).filter(x => /^[0-9a-f-]{36}$/i.test(x)))].slice(0, 30);

r.get('/quotes/multi', async (req, res) => {
  const ids = productIds(req.query.ids);
  if (!ids.length) return back(res, '/admin/products', { err: 'Tick at least one product to quote.' });
  const settings = await getSettings(admin);
  const [{ data: prods }, { data: orgs }, { data: reqs }] = await Promise.all([
    admin.from('products').select('id, name, sku, supplier_id, unit_cost, cost_currency, moq, unit_weight_kg, carton_qty, carton_weight_kg, carton_cbm, carton_length_cm, carton_width_cm, carton_height_cm, suppliers(name, lead_time_days)').in('id', ids),
    admin.from('organizations').select('id, name').eq('active', true).order('name'),
    admin.from('requests').select('id, ref, title, organizations(name)').in('status', ['new', 'reviewing', 'quoted']).order('created_at', { ascending: false }),
  ]);
  const order = new Map(ids.map((id, i) => [id, i]));
  const products = (prods || []).sort((a, b) => order.get(a.id) - order.get(b.id));
  const container = { ...CONTAINER_DEFAULTS, ...(settings.container || {}) };
  const cargo = products.map(pr => cargoLine(pr, pr.moq || 1));
  res.render('admin/pricing/quote_multi', {
    cargo, cargoTotal: cargoTotals(cargo, container), container, airKgPerCbm: AIR_KG_PER_CBM,
    title: 'Quote several products', products, orgs: orgs || [], requests: reqs || [], settings, incoterms: INCOTERMS, currencies: CURRENCIES,
    valid_until: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10), error: req.query.err || null,
  });
});

// destination details typed on a staff-initiated request (needed for freight)
const destFields = (country, city, needed) => ({
  destination_country: String(country || '').trim().slice(0, 80) || null,
  destination_city: String(city || '').trim().slice(0, 80) || null,
  needed_by: /^\d{4}-\d{2}-\d{2}$/.test(needed || '') ? needed : null,
});

r.post('/quotes/multi', async (req, res) => {
  const settings = await getSettings(admin);
  const b = req.body;
  const rows = (Array.isArray(b.line) ? b.line : Object.values(b.line || {})).filter(l => l && /^[0-9a-f-]{36}$/i.test(l.product_id || ''));
  const bad = msg => back(res, `/admin/pricing/quotes/multi?ids=${rows.map(l => l.product_id).join(',')}`, { err: msg });
  if (!rows.length) return back(res, '/admin/products', { err: 'No products to quote.' });
  const sell = CURRENCIES.includes(b.sell_currency) ? b.sell_currency : 'USD';
  let requestId = null, ref = null;
  if (/^[0-9a-f-]{36}$/i.test(b.request_id || '')) requestId = b.request_id;
  else if (!/^[0-9a-f-]{36}$/i.test(b.org_id || '')) return bad('Choose the client, or an existing request.');
  const { data: prods } = await admin.from('products').select('id, name, sku, supplier_id, hs_code').in('id', rows.map(l => l.product_id));
  const byId = new Map((prods || []).map(p => [p.id, p]));
  const lines = rows.filter(l => byId.has(l.product_id)).map(l => {
    const p = byId.get(l.product_id), cur = CURRENCIES.includes(l.cost_currency) ? l.cost_currency : 'CNY', fx = fxRate(settings, cur, sell);
    const row = { product_id: p.id, supplier_id: p.supplier_id, quantity: Math.max(1, Math.round(Number(l.quantity) || 0)), unit_cost: Number(String(l.unit_cost).replace(',', '.')) || 0, cost_currency: cur, fx_rate: fx,
      margin_pct: Number(l.margin_pct) || settings.pricing.default_margin_pct, sell_currency: sell, freight_estimate: Number(l.freight) || 0, duties_estimate: 0, other_costs: 0,
      incoterm: b.incoterm || 'FOB', lead_time_days: Number(b.lead_time_days) > 0 ? Math.round(Number(b.lead_time_days)) : null, valid_until: /^\d{4}-\d{2}-\d{2}$/.test(b.valid_until || '') ? b.valid_until : null };
    return { p, row, calc: compute(row, settings) };
  });
  if (!lines.length) return bad('No valid products.');
  if (lines.some(x => !(x.row.unit_cost > 0))) return bad('Every product needs a factory price — enter it in the Cost column.');
  if (!requestId) {
    let made = null, lastErr = null;
    for (let n = 0; n < 6 && !made; n++) {
      ref = refIRQ();
      const title = String(b.title || '').trim().slice(0, 200) || (lines.length === 1 ? lines[0].p.name : `${lines[0].p.name} + ${lines.length - 1} more`);
      const { data, error } = await admin.from('requests').insert({ ref, org_id: b.org_id, created_by: req.user.id, assigned_to: req.user.id, title, description: 'Initiated by staff — no client request.', quantity: null, target_currency: sell, ...destFields(b.dest_country, b.dest_city, b.needed_by), status: 'reviewing' }).select('id').single();
      if (!error) made = data; else lastErr = error;
    }
    if (!made) return bad(lastErr?.message || 'Could not create the request.');
    requestId = made.id;
    await log({ entityType: 'request', entityId: requestId, action: 'request_initiated_by_staff', actorId: req.user.id, detail: { note: ref } });
  }
  const { data: have } = await admin.from('request_items').select('position').eq('request_id', requestId).order('position', { ascending: false }).limit(1);
  let pos = (have?.[0]?.position ?? -1) + 1;
  for (const x of lines) {
    const { data: item } = await admin.from('request_items').insert({ request_id: requestId, position: pos++, name: x.p.name, description: x.p.sku ? `SKU ${x.p.sku}` : null, quantity: x.calc.quantity, unit: 'pcs' }).select('id').single();
    await admin.from('quotes').insert({ ...x.row, request_id: requestId, request_item_id: item?.id || null, quantity: x.calc.quantity, margin_pct: x.calc.marginPct,
      unit_price: x.calc.unitPrice, landed_unit_price: x.calc.landedUnitPrice, created_by: req.user.id, status: 'draft' });
  }
  res.redirect(`/admin/pricing/requests/${requestId}/quote?msg=` + encodeURIComponent(`${lines.length} quote line${lines.length > 1 ? 's' : ''} created as drafts. Check the total, then send the quote to the client.`));
});


// ---- one combined quotation for a whole request: preview with totals, PDF, send together ----
// sending a new quote for a request line replaces an older one that was sent but not answered
async function supersedeOlder(rid, fresh) {
  const items = fresh.map(q => q.request_item_id).filter(Boolean);
  if (!items.length) return;
  await admin.from('quotes').update({ status: 'superseded' }).eq('request_id', rid).eq('status', 'sent').in('request_item_id', items).not('id', 'in', `(${fresh.map(q => q.id).join(',')})`);
}

async function loadCombined(rid, statuses = LIVE) {
  const { data: request } = await admin.from('requests').select('*, organizations(*)').eq('id', rid).maybeSingle();
  if (!request) return null;
  const [{ data: quotes }, { data: items }] = await Promise.all([
    admin.from('quotes').select('*, products(id, name, sku), suppliers(id, name)').eq('request_id', rid).in('status', statuses).order('created_at'),
    admin.from('request_items').select('id, name, sku').eq('request_id', rid),
  ]);
  const item = id => (items || []).find(i => i.id === id);
  const nameOf = q => item(q.request_item_id)?.name || q.products?.name || 'Item';
  const skuOf = q => item(q.request_item_id)?.sku || q.products?.sku || '';
  const list = dropReplaced(quotes || []);
  return { request, org: request.organizations, quotes: list, combined: combineQuotes(list, { nameOf, skuOf }) };
}

r.get('/requests/:rid/quote', async (req, res) => {
  const settings = await getSettings(admin);
  const x = await loadCombined(req.params.rid);
  if (!x) return notFound(res, 'Request');
  const lines = x.quotes.map(q => ({ q, c: compute(q, settings) }));
  res.render('admin/pricing/quote_combined', { title: `Quote ${x.request.ref}`, ...x, lines, min: settings.pricing.min_margin_pct, msg: req.query.msg, err: req.query.err,
    drafts: x.quotes.filter(q => q.status === 'draft'), noAi: x.quotes.filter(q => q.status === 'draft' && !q.ai_check).length, low: lines.filter(l => l.q.status === 'draft' && !l.c.meetsMinimum).length });
});

r.get('/requests/:rid/quote.pdf', async (req, res) => {
  const x = await loadCombined(req.params.rid);
  if (!x || !x.quotes.length) return notFound(res, 'Quote');
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${x.request.ref}-quotation.pdf"` });
  res.send(Buffer.from(quotationPdf({ request: x.request, combined: x.combined, org: x.org, company: await getCompany(admin) })));
});

// AI check on every draft line of a request (the lines that already have a check are kept unless "again" is ticked)
r.post('/requests/:rid/verify-all', async (req, res) => {
  const settings = await getSettings(admin);
  const to = `/admin/pricing/requests/${req.params.rid}/quote`;
  const { data: drafts } = await admin.from('quotes').select('*').eq('request_id', req.params.rid).eq('status', 'draft').order('created_at');
  const todo = (drafts || []).filter(q => bool(req.body.again) || !q.ai_check);
  if (!todo.length) return back(res, to, { msg: drafts?.length ? 'Every draft line already has an AI check.' : 'No draft lines to check.' });
  let passed = 0, flagged = 0, failed = null;
  for (const q of todo) {
    try {
      const result = await verifyQuote({ quote: q, calc: compute(q, settings), ...(await context(q)), settings });
      await admin.from('quotes').update({ ai_check: result }).eq('id', q.id);
      if (result.ok) passed++; else flagged++;
    } catch (e) { failed = e.message; break; }
  }
  const done = passed + flagged;
  const msg = `AI check: ${done} of ${todo.length} line${todo.length > 1 ? 's' : ''} checked — ${passed} passed, ${flagged} flagged.`;
  if (failed) return back(res, to, { err: `${msg} Stopped: ${failed}` });
  back(res, to, { msg: flagged ? `${msg} Open the flagged lines to read the issues.` : msg });
});

// send every draft quote of a request in one go (one email to the client)
r.post('/requests/:rid/send-all', async (req, res) => {
  const settings = await getSettings(admin);
  const rid = req.params.rid, to = `/admin/pricing/requests/${rid}/quote`;
  const { data: drafts } = await admin.from('quotes').select('*').eq('request_id', rid).eq('status', 'draft');
  if (!drafts?.length) return back(res, to, { err: 'No draft quotes to send.' });
  const override = bool(req.body.override) && req.user.role === 'admin';
  const low = drafts.filter(q => !compute(q, settings).meetsMinimum);
  if (low.length && !override) return back(res, to, { err: `${low.length} line${low.length > 1 ? 's are' : ' is'} below the ${settings.pricing.min_margin_pct}% minimum margin. Raise the margin, or an admin can tick the override.` });
  if (drafts.some(q => !q.ai_check) && !bool(req.body.skip_ai)) return back(res, to, { err: 'Some lines have no AI check yet. Run it on each line, or tick "send without AI check".' });
  await supersedeOlder(rid, drafts);
  await admin.from('quotes').update({ status: 'sent' }).in('id', drafts.map(q => q.id));
  await admin.from('requests').update({ status: 'quoted' }).eq('id', rid);
  await log({ entityType: 'request', entityId: rid, action: 'quote_sent', actorId: req.user.id, clientVisible: true, detail: { note: `${drafts.length} lines` } });
  if (low.length) await log({ entityType: 'request', entityId: rid, action: 'margin_override', actorId: req.user.id, detail: { lines: low.length, reason: req.body.reason } });
  let sentTo = [];
  try {
    const { data: rq } = await admin.from('requests').select('id, ref, title, org_id, created_by').eq('id', rid).single();
    let { data: people } = rq.created_by ? await admin.from('profiles').select('email, role').eq('id', rq.created_by).eq('active', true) : { data: [] };
    people = (people || []).filter(p => p.role === 'client'); // staff-initiated: the creator is us, so write to the company's users
    if (!people.length) ({ data: people } = await admin.from('profiles').select('email').eq('org_id', rq.org_id).eq('role', 'client').eq('active', true));
    sentTo = [...new Set((people || []).map(p => p.email).filter(Boolean))];
    if (sentTo.length) {
      const x = await loadCombined(rid, ['sent', 'accepted']), c = x.combined;
      let attachments;
      try { attachments = [{ filename: `${rq.ref}-quotation.pdf`, content: Buffer.from(quotationPdf({ request: x.request, combined: c, org: x.org, company: await getCompany(admin) })) }]; } catch (e) { console.error(`[quote] pdf failed: ${e.message}`); }
      await sendEmail({ to: sentTo, attachments, ...quoteSentEmail({ request: rq, validUntil: c.valid_until, leadTimeDays: c.lead_time_days, count: c.count, total: c.mixed ? null : c.grandTotal, currency: c.currency, attached: !!attachments, url: `${(process.env.APP_URL || '').replace(/\/+$/, '')}/portal/requests/${rq.id}` }) });
    }
  } catch (e) { console.error(`[quote] email to client failed: ${e.message}`); return back(res, to, { msg: `${drafts.length} quotes sent — the client can see them in the portal, but the email notification failed.` }); }
  back(res, to, { msg: `${drafts.length} quotes sent${sentTo.length ? ` and the client was notified (${sentTo.join(', ')}).` : ' — the client can see them in the portal (no active client user to email).'}` });
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
  const formError = async error => {
    const lists = await formLists();
    return res.status(400).render('admin/pricing/quote_form', { title: id ? 'Edit quote' : 'New quote', q: { ...req.body, id }, settings, ...lists, incoterms: INCOTERMS, currencies: CURRENCIES, error });
  };
  let irq = null;
  if (b.request_id === '__irq__') { // quote started by staff, no client request: make an IRQ request for traceability
    if (id) return formError('Pick a client request.');
    if (!/^[0-9a-f-]{36}$/i.test(req.body.irq_org || '')) return formError('Choose the client this quote is for.');
    irq = { org_id: req.body.irq_org, title: String(req.body.irq_title || '').trim().slice(0, 200), ...destFields(req.body.irq_country, req.body.irq_city, req.body.irq_needed) };
    b.request_id = null;
  }
  if (!b.request_id && !irq) return formError('Pick the client request this quote answers, or start a new internal request.');
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
  if (irq) {
    const { data: pr } = b.product_id ? await admin.from('products').select('name, sku').eq('id', b.product_id).maybeSingle() : { data: null };
    const title = irq.title || pr?.name || 'Staff-initiated quote';
    let made = null, lastErr = null;
    for (let n = 0; n < 6 && !made; n++) {
      const ref = `IRQ-${new Date().toISOString().slice(2, 7).replace('-', '')}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
      const { data, error } = await admin.from('requests').insert({ ref, org_id: irq.org_id, created_by: req.user.id, assigned_to: req.user.id, title, description: 'Initiated by staff — no client request.', quantity: calc.quantity, target_currency: b.sell_currency || 'USD', destination_country: irq.destination_country, destination_city: irq.destination_city, needed_by: irq.needed_by, status: 'reviewing' }).select('id, ref').single();
      if (!error) made = data; else lastErr = error;
    }
    if (!made) return formError(lastErr?.message || 'Could not create the request.');
    const { data: item } = await admin.from('request_items').insert({ request_id: made.id, position: 0, name: title, description: pr?.sku ? `SKU ${pr.sku}` : null, quantity: calc.quantity, unit: 'pcs' }).select('id').single();
    b.request_id = made.id;
    if (item) b.request_item_id = item.id;
    await log({ entityType: 'request', entityId: made.id, action: 'request_initiated_by_staff', actorId: req.user.id, detail: { note: made.ref } });
  }
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
  await supersedeOlder(q.request_id, [q]);
  await admin.from('quotes').update({ status: 'sent' }).eq('id', q.id);
  await admin.from('requests').update({ status: 'quoted' }).eq('id', q.request_id);
  await log({ entityType: 'request', entityId: q.request_id, action: 'quote_sent', actorId: req.user.id, clientVisible: true, detail: { quote_id: q.id } });
  if (override) await log({ entityType: 'request', entityId: q.request_id, action: 'margin_override', actorId: req.user.id, detail: { quote_id: q.id, margin: calc.marginPct, reason: req.body.reason } });
  // email the client: the person who made the request, otherwise everyone active in that company
  let sentTo = [];
  try {
    const { data: rq } = await admin.from('requests').select('id, ref, title, org_id, created_by').eq('id', q.request_id).single();
    let { data: people } = rq.created_by ? await admin.from('profiles').select('email, role').eq('id', rq.created_by).eq('active', true) : { data: [] };
    people = (people || []).filter(x => x.role === 'client'); // a staff-initiated request (IRQ) is written to the company's users
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
  res.render('admin/pricing/settings', { title: 'Pricing settings', settings: await getSettings(admin), company: await getCompany(admin), msg: req.query.msg });
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
    { key: 'company', value: { name: String(req.body.co_name || '').trim() || 'Lumi Trade', email: String(req.body.co_email || '').trim(), phone: String(req.body.co_phone || '').trim(), website: String(req.body.co_website || '').trim(),
      address: String(req.body.co_address || '').trim(), bank: String(req.body.co_bank || '').trim(), payment_terms: String(req.body.co_payment_terms || '').trim() }, updated_at: new Date().toISOString() },
  ]);
  back(res, '/admin/pricing/settings', { msg: 'Settings saved.' });
});

export default r;
