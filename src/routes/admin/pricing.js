import { Router } from '../../lib/router.js';
import { admin } from '../../lib/supabase.js';
import { calcQuote } from '../../lib/pricing.js';
import { verifyQuote } from '../../lib/ai.js';
import { log } from '../../lib/activity.js';
import { sendEmail } from '../../lib/mailer.js';
import { getCompany } from '../../lib/purchase.js';
import { combineQuotes, dropReplaced, quotationPdf, LIVE } from '../../lib/combined-quote.js';
import { modeOf } from '../../lib/freight-mode.js';
import { okCurrency, clearDefaultCurrency } from '../../lib/currency.js';
import { quoteSentEmail } from '../../lib/email-templates.js';
import { requireAdmin } from '../../middleware/auth.js';
import { cargoLine, cargoTotals, AIR_KG_PER_CBM } from '../../lib/cargo.js';
import { CONTAINER_DEFAULTS } from '../../lib/product-metrics.js';
import { clean, bool, back, notFound, getSettings, clearSettingsCache, fxRate, INCOTERMS, CURRENCIES } from '../../lib/util.js';
import { localizeEmail } from '../../lib/i18n.js';
import { orgLang } from '../../lib/lang.js';
import { currentResponses } from '../../lib/rfq.js';
import { compareScenarios } from '../../lib/scenarios.js';

const r = Router();
const QUOTE_FIELDS = ['request_id', 'request_item_id', 'product_id', 'supplier_id', 'quantity', 'unit_cost', 'cost_currency', 'fx_rate', 'margin_pct', 'sell_currency',
  'freight_estimate', 'duties_estimate', 'other_costs', 'freight_mode', 'incoterm', 'lead_time_days', 'valid_until', 'notes'];

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

// ---- compare scenarios side by side (supplier / freight mode / duty) ----
const SC = 4;
const scenarioFields = i => ['label', 'unitCost', 'costCurrency', 'marginPct', 'freightTotal', 'otherTotal', 'dutyPct', 'vatPct', 'dutyBase', 'leadDays'].reduce((o, k) => { o[k] = ''; return o; }, { key: i });
async function comparePage(req, res, post) {
  const settings = await getSettings(admin);
  const lists = await formLists();
  const b = post ? req.body : req.query;
  const sellCurrency = CURRENCIES.includes(b.sell_currency) ? b.sell_currency : (res.locals.defCur || 'USD');
  const margin = settings.pricing.default_margin_pct;
  const scenarios = Array.from({ length: SC }, (_, i) => {
    const s = scenarioFields(i);
    for (const k of Object.keys(s)) if (k !== 'key' && b[`s${i}_${k}`] != null) s[k] = String(b[`s${i}_${k}`]);
    if (!post) { s.costCurrency ||= 'CNY'; s.marginPct ||= String(margin); s.dutyBase ||= 'goods'; }
    return s;
  });
  const product = lists.products.find(p => p.id === b.product_id);
  if (!post && product && !scenarios[0].unitCost) Object.assign(scenarios[0], { label: scenarios[0].label || 'Current supplier', unitCost: String(product.unit_cost ?? ''), costCurrency: product.cost_currency || 'CNY' });
  const common = { product_id: b.product_id || '', quantity: b.quantity || '', sell_currency: sellCurrency };
  let result = null;
  if (post || (b.quantity && scenarios.some(s => Number(s.unitCost) > 0))) {
    result = compareScenarios({ quantity: common.quantity || 1, minMarginPct: settings.pricing.min_margin_pct, fxOf: c => fxRate(settings, c, sellCurrency), scenarios });
  }
  res.render('admin/pricing/compare', { title: 'Compare scenarios', scenarios, common, result, product, settings, ...lists, currencies: CURRENCIES, minMargin: settings.pricing.min_margin_pct });
}
r.get('/compare', (req, res) => comparePage(req, res, false));
r.post('/compare', (req, res) => comparePage(req, res, true));

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
  const sell = CURRENCIES.includes(b.sell_currency) ? b.sell_currency : (res.locals.defCur || 'CNY');
  let requestId = null, ref = null;
  if (/^[0-9a-f-]{36}$/i.test(b.request_id || '')) requestId = b.request_id;
  else if (!/^[0-9a-f-]{36}$/i.test(b.org_id || '')) return bad('Choose the client, or an existing request.');
  const { data: prods } = await admin.from('products').select('id, name, sku, supplier_id, hs_code').in('id', rows.map(l => l.product_id));
  const byId = new Map((prods || []).map(p => [p.id, p]));
  const lines = rows.filter(l => byId.has(l.product_id)).map(l => {
    const p = byId.get(l.product_id), cur = CURRENCIES.includes(l.cost_currency) ? l.cost_currency : 'CNY', fx = fxRate(settings, cur, sell);
    const row = { product_id: p.id, supplier_id: p.supplier_id, quantity: Math.max(1, Math.round(Number(l.quantity) || 0)), unit_cost: Number(String(l.unit_cost).replace(',', '.')) || 0, cost_currency: cur, fx_rate: fx,
      margin_pct: Number(l.margin_pct) || settings.pricing.default_margin_pct, sell_currency: sell, freight_estimate: Number(l.freight) || 0, duties_estimate: 0, other_costs: 0,
      ...(modeOf(b.freight_mode) === 'included' ? { freight_mode: 'included' } : {}), incoterm: b.incoterm || 'FOB', lead_time_days: Number(b.lead_time_days) > 0 ? Math.round(Number(b.lead_time_days)) : null, valid_until: /^\d{4}-\d{2}-\d{2}$/.test(b.valid_until || '') ? b.valid_until : null };
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

// client-visible notes of the quotes being sent (one per line, shown in the email)
const noteOf = quotes => [...new Set((quotes || []).map(q => String(q.notes || '').trim()).filter(Boolean))].join('\n\n');

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

// ---- price several products of one request in one form (a draft quote line per product), optionally filled from a supplier's RFQ answer ----
const isUuid = v => /^[0-9a-f-]{36}$/i.test(v || '');
async function rfqAnswersFor(rid) {
  const { data, error } = await admin.from('rfqs').select('id, ref, items, rfq_suppliers(id, status, supplier_id, suppliers(id, name)), rfq_responses(id, rfq_supplier_id, status, lines, created_at)').eq('request_id', rid).order('created_at', { ascending: false });
  if (error) return [];   // RFQ tables not there yet
  const out = [];
  for (const rfq of data || []) {
    const cur = currentResponses(rfq.rfq_responses || []);
    for (const rs of rfq.rfq_suppliers || []) {
      const resp = cur[rs.id];
      if (rs.status !== 'replied' || !resp || resp.status !== 'confirmed') continue;
      const byItem = {};
      for (const it of rfq.items || []) {
        const l = (resp.lines || []).find(x => x.item_id === it.id);
        if (it.request_item_id && l && l.unit_price != null) byItem[it.request_item_id] = { ...l, rfq_unit: it.unit || 'pcs' };
      }
      out.push({ id: rs.id, label: `${rfq.ref} · ${rs.suppliers?.name || 'supplier'}`, supplier_id: rs.supplier_id, byItem });
    }
  }
  return out;
}

// the forwarder quote (freight_rfqs) for a packing list sent from this request's RFQs: accepted first, then the latest quoted one
async function forwarderQuoteFor(rid) {
  const { data: rfqs } = await admin.from('rfqs').select('id').eq('request_id', rid);
  const ids = (rfqs || []).map(x => x.id);
  if (!ids.length) return null;
  const { data, error } = await admin.from('freight_requests').select('ref, freight_rfqs!freight_rfqs_request_id_fkey(status, quote_amount, quote_currency, quoted_at, forwarders(name))').in('rfq_id', ids).order('created_at', { ascending: false });
  if (error) return null;   // freight tables / rfq_id column not there yet
  const all = (data || []).flatMap(f => (f.freight_rfqs || []).map(q => ({ ref: f.ref, status: q.status, amount: Number(q.quote_amount), currency: q.quote_currency, forwarder: q.forwarders?.name || '', at: q.quoted_at || '' })))
    .filter(q => ['quoted', 'accepted'].includes(q.status) && q.amount > 0);
  all.sort((a, b) => (b.status === 'accepted') - (a.status === 'accepted') || String(b.at).localeCompare(String(a.at)));
  return all[0] || null;
}

r.get('/requests/:rid/quote-lines', async (req, res) => {
  const rid = req.params.rid;
  if (!isUuid(rid)) return notFound(res, 'Request');
  const settings = await getSettings(admin);
  const { data: request } = await admin.from('requests').select('id, ref, title, target_currency, organizations(name)').eq('id', rid).maybeSingle();
  if (!request) return notFound(res, 'Request');
  let [{ data: items }, { data: drafts }, { data: products }, { data: suppliers }, answers] = await Promise.all([
    admin.from('request_items').select('id, name, sku, quantity, unit, target_unit_price, position').eq('request_id', rid).order('position'),
    admin.from('quotes').select('*').eq('request_id', rid).eq('status', 'draft').order('created_at', { ascending: false }),
    admin.from('products').select('id, name, sku, supplier_id, unit_weight_kg, carton_qty, carton_weight_kg, carton_cbm, carton_length_cm, carton_width_cm, carton_height_cm').order('name'),
    admin.from('suppliers').select('id, name, lead_time_days').order('name'),
    rfqAnswersFor(rid),
  ]);
  items = items || []; drafts = drafts || [];
  if (!items.length) return back(res, `/admin/sourcing/${rid}`, { err: 'This request has no product lines to quote.' });
  const answer = answers.find(a => a.id === req.query.rs) || null;
  const d0 = drafts[0] || {};
  const shared = { sell_currency: d0.sell_currency || request.target_currency || res.locals.defCur || 'CNY', incoterm: d0.incoterm || 'FOB', lead_time_days: d0.lead_time_days ?? '',
    valid_until: d0.valid_until || new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10), freight_mode: modeOf(d0.freight_mode),
    freight_basis: d0.freight_basis === 'air' ? 'air' : 'sea', freight_total: d0.freight_total ?? '', freight_note: d0.freight_note || '', freight_from: null };
  // the forwarder's quote for this request's packing list, when there is one
  if (shared.freight_total === '') {
    const fq = await forwarderQuoteFor(rid);
    if (fq) {
      const amt = Number(fq.amount) * fxRate(settings, fq.currency || shared.sell_currency, shared.sell_currency);
      shared.freight_total = Math.round(amt * 100) / 100; shared.freight_from = fq;
      shared.freight_note = `From ${fq.ref}${fq.forwarder ? ' · ' + fq.forwarder : ''} — quoted ${fq.currency || ''} ${fq.amount}`.trim();
    }
  }
  const lines = items.map(it => {
    const dq = drafts.find(q => q.request_item_id === it.id);
    const l = { item: it, quote_id: dq?.id || '', product_id: dq?.product_id || '', supplier_id: dq?.supplier_id || '', quantity: dq?.quantity ?? it.quantity ?? '', unit_cost: dq?.unit_cost ?? '',
      cost_currency: dq?.cost_currency || 'CNY', margin_pct: dq?.margin_pct ?? settings.pricing.default_margin_pct, freight: dq?.freight_estimate ?? 0, note: '',
      pack_kg: dq?.pack_kg ?? '', pack_cbm: dq?.pack_cbm ?? '', freight_saved: dq != null && dq.freight_estimate != null && dq.freight_total != null };
    const a = answer?.byItem[it.id];
    if (a) {
      l.unit_cost = a.unit_price; l.cost_currency = CURRENCIES.includes(a.currency) ? a.currency : l.cost_currency; l.supplier_id = answer.supplier_id;
      if (a.moq && !l.quantity) l.quantity = a.moq;
      l.note = (a.price_unit || a.rfq_unit) && (a.price_unit || a.rfq_unit) !== (it.unit || 'pcs') ? `The supplier's price is per ${a.price_unit}, the request counts in ${it.unit || 'pcs'} — check the price.` : 'Filled from the RFQ answer.';
      if (a.lead_days && !shared.lead_time_days) shared.lead_time_days = a.lead_days;
    } else if (answer) l.note = 'This product has no price in that RFQ answer.';
    return l;
  });
  res.render('admin/pricing/quote_lines', { title: `Quote all products · ${request.ref}`, request, lines, shared, answers, answer, products: products || [], suppliers: suppliers || [], airKgPerCbm: AIR_KG_PER_CBM,
    settings, incoterms: INCOTERMS, currencies: CURRENCIES, error: req.query.err || null,
    rates: Object.fromEntries(CURRENCIES.map(a => [a, Object.fromEntries(CURRENCIES.map(c => [c, fxRate(settings, a, c)]))])) });
});

// form values → quote rows (shared by "save" and "preview PDF" so both always agree)
const numOrNull = v => { const n = Number(String(v ?? '').replace(/[,\s]/g, '')); return v === '' || v == null || !Number.isFinite(n) || n < 0 ? null : n; };
const PACK_COLS = /pack_kg|pack_cbm|freight_basis|freight_total|freight_note/;   // columns from migration 0040
const without = (o, re) => Object.fromEntries(Object.entries(o).filter(([k]) => !re.test(k)));
function buildLines(rows, prods, shared, settings, rid) {
  return rows.map(l => {
    const cur = CURRENCIES.includes(l.cost_currency) ? l.cost_currency : 'CNY';
    const pr = (prods || []).find(p => p.id === l.product_id);
    const row = { request_id: rid, request_item_id: l.item_id, product_id: pr?.id || null, supplier_id: pr?.supplier_id || (isUuid(l.supplier_id) ? l.supplier_id : null),
      quantity: Math.max(1, Math.round(Number(l.quantity) || 0)), unit_cost: Number(String(l.unit_cost).replace(',', '.')), cost_currency: cur, fx_rate: fxRate(settings, cur, shared.sell_currency),
      margin_pct: Number(l.margin_pct) || settings.pricing.default_margin_pct, freight_estimate: Math.max(0, Number(l.freight) || 0), duties_estimate: 0, other_costs: 0,
      pack_kg: numOrNull(l.pack_kg), pack_cbm: numOrNull(l.pack_cbm), ...shared };
    const calc = compute(row, settings);
    return { l, full: { ...row, quantity: calc.quantity, margin_pct: calc.marginPct, unit_price: calc.unitPrice, landed_unit_price: calc.landedUnitPrice } };
  });
}
function formShared(b, res) {
  const sell = CURRENCIES.includes(b.sell_currency) ? b.sell_currency : (res.locals.defCur || 'CNY');
  return { sell_currency: sell, incoterm: INCOTERMS.includes(b.incoterm) ? b.incoterm : 'FOB', freight_mode: modeOf(b.freight_mode),
    freight_basis: b.freight_basis === 'air' ? 'air' : 'sea', freight_total: numOrNull(b.freight_total), freight_note: String(b.freight_note || '').trim().slice(0, 300) || null,
    lead_time_days: Number(b.lead_time_days) > 0 ? Math.round(Number(b.lead_time_days)) : null, valid_until: /^\d{4}-\d{2}-\d{2}$/.test(b.valid_until || '') ? b.valid_until : null };
}
const pricedRows = (b, itemIds) => (Array.isArray(b.line) ? b.line : Object.values(b.line || {})).filter(l => l && itemIds.has(l.item_id) && Number(String(l.unit_cost ?? '').replace(',', '.')) > 0);

// the client quotation as a PDF, from what is typed on the form (nothing is saved)
r.post('/requests/:rid/quote-lines/preview.pdf', async (req, res) => {
  const rid = req.params.rid;
  if (!isUuid(rid)) return notFound(res, 'Request');
  const settings = await getSettings(admin);
  const { data: request } = await admin.from('requests').select('*, organizations(*)').eq('id', rid).maybeSingle();
  if (!request) return notFound(res, 'Request');
  const { data: items } = await admin.from('request_items').select('id, name, sku').eq('request_id', rid);
  const rows = pricedRows(req.body, new Set((items || []).map(i => i.id)));
  if (!rows.length) return back(res, `/admin/pricing/requests/${rid}/quote-lines`, { err: 'Enter a factory price for at least one product to preview the PDF.' });
  const prodIds = rows.map(l => l.product_id).filter(isUuid);
  const { data: prods } = prodIds.length ? await admin.from('products').select('id, name, sku, supplier_id').in('id', prodIds) : { data: [] };
  const quotes = buildLines(rows, prods, formShared(req.body, res), settings, rid).map((x, i) => ({ ...x.full, id: `preview-${i}`, status: 'draft', created_at: new Date().toISOString() }));
  const item = id => (items || []).find(i => i.id === id);
  const combined = combineQuotes(quotes, { nameOf: q => item(q.request_item_id)?.name || 'Item', skuOf: q => item(q.request_item_id)?.sku || '' });
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${request.ref}-quotation-preview.pdf"` });
  res.send(Buffer.from(quotationPdf({ request, combined, org: request.organizations, company: await getCompany(admin) })));
});

r.post('/requests/:rid/quote-lines', async (req, res) => {
  const rid = req.params.rid;
  if (!isUuid(rid)) return notFound(res, 'Request');
  const settings = await getSettings(admin);
  const b = req.body, to = `/admin/pricing/requests/${rid}/quote-lines`;
  const { data: request } = await admin.from('requests').select('id, status').eq('id', rid).maybeSingle();
  if (!request) return notFound(res, 'Request');
  const [{ data: items }, { data: drafts }] = await Promise.all([
    admin.from('request_items').select('id, quantity').eq('request_id', rid),
    admin.from('quotes').select('id').eq('request_id', rid).eq('status', 'draft'),
  ]);
  const itemIds = new Set((items || []).map(i => i.id)), draftIds = new Set((drafts || []).map(q => q.id));
  const shared = formShared(b, res);
  const rows = pricedRows(b, itemIds);
  if (!rows.length) return back(res, to, { err: 'Enter a factory price for at least one product.' });
  const prodIds = rows.map(l => l.product_id).filter(isUuid);
  const { data: prods } = prodIds.length ? await admin.from('products').select('id, supplier_id').in('id', prodIds) : { data: [] };
  let saved = 0;
  let packSkipped = false;
  for (let { l, full } of buildLines(rows, prods, shared, settings, rid)) {
    const write = async f => (isUuid(l.quote_id) && draftIds.has(l.quote_id)
      ? admin.from('quotes').update({ ...f, ai_check: null, status: 'draft' }).eq('id', l.quote_id)
      : admin.from('quotes').insert({ ...f, created_by: req.user.id, status: 'draft' }));
    let { error } = await write(full);
    if (error && PACK_COLS.test(error.message)) { full = without(full, PACK_COLS); packSkipped = true; ({ error } = await write(full)); }   // before migration 0040
    if (error && /freight_mode/.test(error.message)) { const { freight_mode, ...rest } = full; ({ error } = await write(rest)); }   // before the freight-mode migration
    if (error) return back(res, to, { err: `${saved ? saved + ' saved, then: ' : ''}${error.message}` });
    saved++;
  }
  await admin.from('requests').update({ status: 'reviewing' }).eq('id', rid).eq('status', 'new');
  // the lines of one quotation share the freight switch
  await admin.from('quotes').update({ freight_mode: shared.freight_mode }).eq('request_id', rid).eq('status', 'draft').then(() => {}, () => {});
  await admin.from('quotes').update({ freight_basis: shared.freight_basis, freight_total: shared.freight_total, freight_note: shared.freight_note }).eq('request_id', rid).eq('status', 'draft').then(() => {}, () => {});
  const warn = packSkipped ? ' Packing weight, volume and the logistics split were not stored — run supabase/migrations/0040_quote_packing.sql in Supabase first.' : '';
  res.redirect(`/admin/pricing/requests/${rid}/quote?msg=` + encodeURIComponent(`${saved} quote line${saved > 1 ? 's' : ''} saved as drafts. Check the total, then send the quote to the client.${warn}`));
});

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

// one switch per quotation: freight shown separately, or included in the unit prices (drafts only — what was sent stays as sent)
r.post('/requests/:rid/freight-mode', async (req, res) => {
  const rid = req.params.rid, to = `/admin/pricing/requests/${rid}/quote`, mode = modeOf(req.body.freight_mode);
  const { data, error } = await admin.from('quotes').update({ freight_mode: mode }).eq('request_id', rid).eq('status', 'draft').select('id');
  if (error) return back(res, to, { err: /freight_mode/.test(error.message) ? 'Run supabase/migrations/0023_freight_mode.sql in Supabase first.' : error.message });
  back(res, to, { msg: mode === 'included' ? 'Freight is now included in the unit prices — the client will see all-in prices and no freight line.' : 'Freight will be shown as a separate line.' });
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
      await sendEmail({ to: sentTo, attachments, ...localizeEmail(quoteSentEmail({ request: rq, validUntil: c.valid_until, leadTimeDays: c.lead_time_days, count: c.count, total: c.mixed ? null : c.shown.grandTotal, currency: c.currency, attached: !!attachments, notes: noteOf(x.quotes), url: `${(process.env.APP_URL || '').replace(/\/+$/, '')}/portal/requests/${rq.id}` }), await orgLang(rq.org_id)) });
    }
  } catch (e) { console.error(`[quote] email to client failed: ${e.message}`); return back(res, to, { msg: `${drafts.length} quotes sent — the client can see them in the portal, but the email notification failed.` }); }
  back(res, to, { msg: `${drafts.length} quotes sent${sentTo.length ? ` and the client was notified (${sentTo.join(', ')}).` : ' — the client can see them in the portal (no active client user to email).'}` });
});

// ---- quotes ----
r.get('/quotes/new', async (req, res) => {
  const settings = await getSettings(admin);
  const lists = await formLists();
  const q = { quantity: '', margin_pct: settings.pricing.default_margin_pct, cost_currency: 'CNY', sell_currency: res.locals.defCur || 'CNY', incoterm: 'FOB',
    freight_estimate: 0, duties_estimate: 0, other_costs: 0, request_id: req.query.request_id || '', request_item_id: req.query.item_id || '', product_id: req.query.product_id || '',
    valid_until: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10) };
  const req0 = lists.requests.find(x => x.id === q.request_id);
  if (req0) {
    q.quantity = req0.quantity || ''; q.sell_currency = req0.target_currency || res.locals.defCur || 'CNY';
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
  b.freight_mode = modeOf(b.freight_mode);
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
    let { error } = await admin.from('quotes').update({ ...row, ai_check: null, status: 'draft' }).eq('id', id);
    if (error && /freight_mode/.test(error.message)) { const { freight_mode, ...rest } = row; ({ error } = await admin.from('quotes').update({ ...rest, ai_check: null, status: 'draft' }).eq('id', id)); } // before migration 0023
    if (error) return back(res, `/admin/pricing/quotes/${id}`, { err: error.message });
  } else {
    let { data, error } = await admin.from('quotes').insert({ ...row, created_by: req.user.id }).select('id').single();
    if (error && /freight_mode/.test(error.message)) { const { freight_mode, ...rest } = row; ({ data, error } = await admin.from('quotes').insert({ ...rest, created_by: req.user.id }).select('id').single()); } // before migration 0023
    if (error) {
      const lists = await formLists();
      return res.status(400).render('admin/pricing/quote_form', { title: 'New quote', q: req.body, settings, ...lists, incoterms: INCOTERMS, currencies: CURRENCIES, error: error.message });
    }
    qid = data.id;
    await admin.from('requests').update({ status: 'reviewing' }).eq('id', b.request_id).eq('status', 'new');
  }
  // one switch per quotation: the other draft lines of this request follow this line's choice
  if (b.request_id) await admin.from('quotes').update({ freight_mode: b.freight_mode }).eq('request_id', b.request_id).eq('status', 'draft').neq('id', qid);
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
    if (sentTo.length) {
      let attachments, c, line;
      try {
        const x = await loadCombined(q.request_id, ['sent', 'accepted']);
        const only = { ...x, quotes: x.quotes.filter(z => z.id === q.id) };
        c = combineQuotes(only.quotes, { nameOf: z => x.combined.lines.find(l => l.id === z.id)?.name || 'Item', skuOf: z => x.combined.lines.find(l => l.id === z.id)?.sku || '' });
        const l0 = c.lines[0]; line = { quantity: l0.quantity, unit_price: l0.shown.unit_price, goods: l0.shown.goods, logistics: l0.shown.logistics, total: l0.shown.total };
        attachments = [{ filename: `${rq.ref}-quotation.pdf`, content: Buffer.from(quotationPdf({ request: x.request, combined: c, org: x.org, company: await getCompany(admin) })) }];
      } catch (e) { console.error(`[quote] pdf failed: ${e.message}`); }
      await sendEmail({ to: sentTo, attachments, ...localizeEmail(quoteSentEmail({ request: rq, validUntil: q.valid_until, leadTimeDays: q.lead_time_days, count: 1, currency: q.sell_currency, line, attached: !!attachments, notes: q.notes, url: `${(process.env.APP_URL || '').replace(/\/+$/, '')}/portal/requests/${rq.id}` }), await orgLang(rq.org_id)) });
    }
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
      address: String(req.body.co_address || '').trim(), bank: String(req.body.co_bank || '').trim(), payment_terms: String(req.body.co_payment_terms || '').trim(), default_currency: okCurrency(req.body.co_default_currency) }, updated_at: new Date().toISOString() },
  ]);
  clearDefaultCurrency(); clearSettingsCache();
  back(res, '/admin/pricing/settings', { msg: 'Settings saved.' });
});

export default r;
