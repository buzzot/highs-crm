// Purchasing: purchase orders to suppliers, generated from a client order, sent by email, answered by email.
import { randomUUID } from 'node:crypto';
import multer from '../../lib/multer-utf8.js';
import { Router } from '../../lib/router.js';
import { admin } from '../../lib/supabase.js';
import { sendEmail } from '../../lib/mailer.js';
import { log } from '../../lib/activity.js';
import { getCompany, parseLines } from '../../lib/purchase.js';
import { groupBySupplier, totalOf, spoPdf, packingTemplate, SPO_STATUSES, SPO_LABEL } from '../../lib/purchasing.js';
import { spoEmail } from '../../lib/email-templates.js';
import { replyAddress, subjectTag } from '../../lib/freight.js';
import { saveSupplierReply } from '../../lib/purchasing-store.js';
import { back, notFound, bool, CURRENCIES } from '../../lib/util.js';
import { uploadDocument } from '../../lib/storage.js';
import { canDelete } from '../../lib/access.js';
import { aiEnabled, extractSupplierPi } from '../../lib/ai.js';
import { readXlsx, workbookToText } from '../../lib/xlsx-read.js';
import { readCsv } from './imports.js';
import { piTotal, checkPi, paymentPlan, matchProducts } from '../../lib/supplier-pi.js';

const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 8 } });
const isId = v => /^[0-9a-f-]{36}$/i.test(v || '');
const missingTable = e => /supplier_pos|supplier_po_responses/.test(e?.message || '');
const ent = po => (po.order_id ? ['order', po.order_id] : ['supplier', po.supplier_id]); // where activity about an unlinked PO is logged
const MIGRATION = 'Run supabase/migrations/0021_purchasing.sql in Supabase first, then reload the schema cache.';

// ---- list ----
r.get('/', async (req, res) => {
  const status = SPO_STATUSES.includes(req.query.status) ? req.query.status : '';
  const unlinked = req.query.order === 'none';
  let q = admin.from('supplier_pos').select('*, suppliers(id, name), orders(id, order_no, organizations(name))').order('created_at', { ascending: false }).limit(300);
  if (status) q = q.eq('status', status);
  if (unlinked) q = q.is('order_id', null);
  else if (isId(req.query.order)) q = q.eq('order_id', req.query.order);
  const { data: pos, error } = await q;
  const all = error ? [] : (await admin.from('supplier_pos').select('status, order_id')).data || [];
  const counts = Object.fromEntries(SPO_STATUSES.map(s => [s, all.filter(x => x.status === s).length]));
  res.render('admin/purchasing/index', {
    title: 'Purchasing', pos: pos || [], status, unlinked, labels: SPO_LABEL, statuses: SPO_STATUSES, counts,
    kpi: { total: all.length, waiting: counts.sent, review: counts.replied, confirmed: counts.confirmed, drafts: counts.draft, unlinked: all.filter(x => !x.order_id && !['cancelled', 'declined'].includes(x.status)).length },
    error: error ? (missingTable(error) ? MIGRATION : error.message) : null,
  });
});

// ---- generate POs from an order: lines grouped by supplier ----
async function newContext(orderId) {
  const [{ data: order }, { data: items }, { data: suppliers }, { data: existing }, { data: products }] = await Promise.all([
    admin.from('orders').select('id, order_no, currency, expected_ship_date, organizations(name)').eq('id', orderId).maybeSingle(),
    admin.from('order_items').select('id, product_id, description, quantity, unit_cost, products(id, name, sku, supplier_id, unit_cost, cost_currency)').eq('order_id', orderId).order('created_at'),
    admin.from('suppliers').select('id, name, email, payment_terms').order('name'),
    admin.from('supplier_pos').select('id, ref, status, lines, suppliers(name)').eq('order_id', orderId).neq('status', 'cancelled'),
    admin.from('products').select('id, name, sku, supplier_id, unit_cost, cost_currency'),
  ]);
  if (!order) return null;
  const byName = new Map((products || []).map(p => [String(p.name).trim().toLowerCase(), p]));
  const taken = new Set((existing || []).flatMap(p => (p.lines || []).map(l => l.order_item_id).filter(Boolean)));
  const rows = (items || []).map(it => {
    const p = it.products || byName.get(String(it.description || '').trim().toLowerCase()) || null;
    return { order_item_id: it.id, product_id: p?.id || null, description: it.description || p?.name || '', sku: p?.sku || '', quantity: it.quantity, unit: 'pcs',
      supplier_id: p?.supplier_id || '', unit_price: p?.unit_cost ?? '', currency: p?.cost_currency || 'CNY', already: taken.has(it.id) };
  });
  return { order, rows, suppliers: suppliers || [], existing: existing || [] };
}

// a PO without an order: pick the supplier and add products from the catalogue
async function manualCtx() {
  const [{ data: suppliers }, { data: products }, { data: orders }] = await Promise.all([
    admin.from('suppliers').select('id, name, email, payment_terms').order('name'),
    admin.from('products').select('id, name, sku, supplier_sku, supplier_id, unit_cost, cost_currency, description, moq').order('name'),
    admin.from('orders').select('id, order_no, status, organizations(name)').not('status', 'in', '("closed","cancelled","delivered")').order('created_at', { ascending: false }).limit(100),
  ]);
  const { data: ph } = await admin.from('documents').select('id, entity_id').eq('entity_type', 'product').eq('kind', 'product_photo').order('created_at'); // first photo per product, for the picker
  const photo = {}; (ph || []).forEach(d => { photo[d.entity_id] ||= d.id; });
  return { suppliers: suppliers || [], products: (products || []).map(x => ({ ...x, photo: photo[x.id] || null })), orders: orders || [] };
}
const blankForm = supplier => ({ supplier_id: supplier || '', currency: 'CNY', required_date: '', title: '', order_id: '', payment_terms: '', ship_to: '', notes: '', lines: [], token: randomUUID() });
r.get('/new', async (req, res, next) => {
  if (isId(req.query.order)) return next();
  const ctx = await manualCtx();
  res.render('admin/purchasing/new_manual', { title: 'New purchase order', ...ctx, currencies: CURRENCIES, error: req.query.err || null, errors: {}, form: blankForm(isId(req.query.supplier) ? req.query.supplier : '') });
});

r.get('/new', async (req, res) => {
  const x = await newContext(req.query.order).catch(e => ({ error: e.message }));
  if (x?.error || !x) return back(res, `/admin/orders/${req.query.order}`, { err: x?.error || 'Order not found.' });
  res.render('admin/purchasing/new', { title: `Supplier POs · ${x.order.order_no}`, ...x, currencies: CURRENCIES, error: req.query.err || null });
});

r.post('/new', async (req, res) => {
  const b = req.body, orderId = b.order_id;
  if (!isId(orderId)) return back(res, '/admin/orders', { err: 'Order not found.' });
  const arr = Array.isArray(b.line) ? b.line : Object.values(b.line || {});
  const rows = arr.filter(l => l && bool(l.include)).map(l => ({ order_item_id: isId(l.order_item_id) ? l.order_item_id : null, product_id: isId(l.product_id) ? l.product_id : null,
    description: l.description, sku: l.sku, quantity: Number(l.quantity), unit: l.unit || 'pcs', unit_price: Number(String(l.unit_price).replace(',', '.')) || 0,
    currency: CURRENCIES.includes(l.currency) ? l.currency : 'CNY', supplier_id: isId(l.supplier_id) ? l.supplier_id : '' }));
  if (!rows.length) return back(res, `/admin/purchasing/new?order=${orderId}`, { err: 'Tick at least one product.' });
  const { groups, skipped } = groupBySupplier(rows);
  if (!groups.length) return back(res, `/admin/purchasing/new?order=${orderId}`, { err: 'Choose a supplier for each ticked product.' });
  const [{ data: order }, { data: sups }] = await Promise.all([
    admin.from('orders').select('expected_ship_date').eq('id', orderId).maybeSingle(),
    admin.from('suppliers').select('id, email, payment_terms').in('id', groups.map(g => g.supplier_id)),
  ]);
  const made = [];
  for (const g of groups) {
    const sup = (sups || []).find(s => s.id === g.supplier_id);
    let po = null, lastErr = null;
    for (let n = 0; n < 5 && !po; n++) {
      const { data, error } = await admin.from('supplier_pos').insert({ order_id: orderId, supplier_id: g.supplier_id, currency: g.currency, lines: g.lines, total: g.total,
        required_date: order?.expected_ship_date || null, payment_terms: sup?.payment_terms || null, sent_to: sup?.email || null, created_by: req.user.id }).select('id, ref').single();
      if (!error) po = data; else lastErr = error;
    }
    if (!po) return back(res, `/admin/purchasing/new?order=${orderId}`, { err: missingTable(lastErr) ? MIGRATION : lastErr?.message || 'Could not create the PO.' });
    made.push(po);
  }
  await log({ entityType: 'order', entityId: orderId, action: 'supplier_pos_created', actorId: req.user.id, detail: { note: made.map(m => m.ref).join(', ') } });
  const msg = `${made.length} purchase order${made.length > 1 ? 's' : ''} created (one per supplier)${skipped.length ? `; ${skipped.length} line(s) skipped — no supplier or quantity` : ''}. Check them, then send.`;
  res.redirect(made.length === 1 ? `/admin/purchasing/${made[0].id}?msg=${encodeURIComponent(msg)}` : `/admin/purchasing?order=${orderId}&msg=${encodeURIComponent(msg)}`);
});

// duplicate-submit guard: the form carries a one-time token; a second post with the same token goes to the PO the first one made
const made = new Map();
const rememberToken = (tok, id) => { made.set(tok, { id, at: Date.now() }); for (const [k, v] of made) if (Date.now() - v.at > 3600e3) made.delete(k); };
const num = v => { const s = String(v ?? '').trim().replace(',', '.'); return s === '' ? null : Number(s); };
const realDay = v => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;

r.post('/new-manual', async (req, res) => {
  const b = req.body, strict = b.act === 'create', tok = String(b.token || '');
  if (tok && made.has(tok)) return res.redirect(`/admin/purchasing/${made.get(tok).id}`);
  const s = (v, n) => String(v ?? '').trim().slice(0, n);
  const raw = Array.isArray(b.line) ? b.line : Object.values(b.line || {});
  const form = { supplier_id: s(b.supplier_id, 40), currency: s(b.currency, 5), required_date: s(b.required_date, 10), title: s(b.title, 200), order_id: s(b.order_id, 40), payment_terms: s(b.payment_terms, 300), ship_to: s(b.ship_to, 500), notes: s(b.notes, 2000), token: tok || randomUUID(),
    lines: raw.filter(l => l && [l.description, l.product_id, l.quantity, l.unit_price].some(x => String(x ?? '').trim() !== '')).map(l => ({ product_id: isId(l.product_id) ? l.product_id : '', description: s(l.description, 500), sku: s(l.sku, 80), quantity: s(l.quantity, 20), unit: s(l.unit, 20) || 'pcs', unit_price: s(l.unit_price, 20) })) };
  const errors = {}, lerr = {};
  const bad = (i, f, m) => { (lerr[i] ||= {})[f] = m; };
  if (!isId(form.supplier_id)) errors.supplier_id = 'Choose the supplier.';
  if (!CURRENCIES.includes(form.currency)) errors.currency = 'Choose a valid currency.';
  if (form.required_date && !realDay(form.required_date)) errors.required_date = 'Enter a valid date.';
  if (form.order_id && !isId(form.order_id)) errors.order_id = 'Choose an order from the list.';
  if (!form.lines.length) errors.lines = 'Add at least one product.';
  const ids = [...new Set(form.lines.map(l => l.product_id).filter(Boolean))];
  const { data: prods } = ids.length ? await admin.from('products').select('id, name, sku').in('id', ids) : { data: [] };
  const known = new Map((prods || []).map(p => [p.id, p]));
  form.lines.forEach((l, i) => {
    const q = num(l.quantity), p = num(l.unit_price);
    if (l.product_id && !known.has(l.product_id)) bad(i, 'product', 'This product no longer exists — choose it again.');
    if (strict && !l.product_id) bad(i, 'product', 'Choose a catalogue product (or save as a draft).');
    if (!l.description) bad(i, 'description', 'Enter a name.');
    if (q != null && (!Number.isFinite(q) || q < 0)) bad(i, 'quantity', 'Quantity must be a number ≥ 0.');
    else if (strict && !(q > 0)) bad(i, 'quantity', 'Enter a quantity.');
    if (p != null && (!Number.isFinite(p) || p < 0)) bad(i, 'unit_price', 'Price must be a number ≥ 0.');
    else if (strict && p == null) bad(i, 'unit_price', 'Enter the unit price.');
  });
  if (Object.keys(lerr).length) errors.line = lerr;
  const fail = async (status, general) => {
    const ctx = await manualCtx();
    res.status(status).render('admin/purchasing/new_manual', { title: 'New purchase order', ...ctx, currencies: CURRENCIES, error: general || null, errors, form });
  };
  if (Object.keys(errors).length) return fail(400, 'Please fix the highlighted fields.');
  const [{ data: sup }, orderRes] = await Promise.all([
    admin.from('suppliers').select('id, email, payment_terms').eq('id', form.supplier_id).maybeSingle(),
    form.order_id ? admin.from('orders').select('id').eq('id', form.order_id).maybeSingle() : { data: null },
  ]);
  if (!sup) { errors.supplier_id = 'Supplier not found.'; return fail(400, 'Please fix the highlighted fields.'); }
  if (form.order_id && !orderRes.data) { errors.order_id = 'Order not found.'; return fail(400, 'Please fix the highlighted fields.'); }
  const lines = form.lines.map(l => ({ description: l.description, sku: l.sku || known.get(l.product_id)?.sku || '', quantity: num(l.quantity) || 0, unit: l.unit, unit_price: num(l.unit_price) || 0, product_id: l.product_id || null, order_item_id: null }));
  const orderId = form.order_id || null;
  let po = null, lastErr = null;
  for (let n = 0; n < 5 && !po; n++) {
    const { data, error } = await admin.from('supplier_pos').insert({ order_id: orderId, supplier_id: sup.id, title: form.title || null, currency: form.currency,
      lines, total: totalOf(lines), required_date: form.required_date || null, payment_terms: form.payment_terms || sup.payment_terms || null, ship_to: form.ship_to || null, notes: form.notes || null,
      sent_to: sup.email || null, created_by: req.user.id }).select('id, ref').single();
    if (!error) po = data; else lastErr = error;
  }
  if (!po) return fail(500, /order_id/.test(lastErr?.message || '') && /null/.test(lastErr?.message || '') ? 'Run supabase/migrations/0022_purchasing_standalone.sql first.' : missingTable(lastErr) ? MIGRATION : lastErr?.message || 'Could not create the PO.');
  rememberToken(form.token, po.id);
  await log({ entityType: orderId ? 'order' : 'supplier', entityId: orderId || sup.id, action: 'supplier_pos_created', actorId: req.user.id, detail: { note: po.ref } });
  const incomplete = lines.some(l => !l.product_id || !(l.quantity > 0) || l.unit_price == null);
  res.redirect(`/admin/purchasing/${po.id}?msg=${encodeURIComponent(`${po.ref} saved as a draft${orderId ? '' : ' — not linked to an order yet'}${incomplete && !strict ? ' — some lines are still incomplete' : ''}. Nothing has been sent; review it, then send it to the supplier.`)}`);
});

// link a PO to an order (the order confirmed later) — or take the link off again
async function linkPo(req, res, poId, orderId, backTo) {
  const po = await load(poId);
  if (!po) return notFound(res, 'Purchase order');
  const to = backTo || `/admin/purchasing/${po.id}`;
  const now = new Date().toISOString();
  if (!orderId) {
    await admin.from('supplier_pos').update({ order_id: null, updated_at: now }).eq('id', po.id);
    return back(res, to, { msg: `${po.ref} is no longer linked to an order.` });
  }
  if (!isId(orderId)) return back(res, to, { err: 'Choose an order.' });
  const { data: order } = await admin.from('orders').select('id, order_no').eq('id', orderId).maybeSingle();
  if (!order) return back(res, to, { err: 'Order not found.' });
  await admin.from('supplier_pos').update({ order_id: order.id, updated_at: now }).eq('id', po.id);
  // the supplier's documents (PI, packing list) move to the order too
  const { data: resp } = await admin.from('supplier_po_responses').select('extracted').eq('po_id', po.id);
  const docIds = [...new Set((resp || []).flatMap(x => (x.extracted?.files || []).map(f => f.id)))];
  if (docIds.length) await admin.from('documents').update({ entity_type: 'order', entity_id: order.id }).in('id', docIds);
  await log({ entityType: 'order', entityId: order.id, action: 'supplier_po_linked', actorId: req.user.id, detail: { note: po.ref } });
  back(res, to, { msg: `${po.ref} linked to order ${order.order_no}.` });
}
r.post('/link', (req, res) => linkPo(req, res, req.body.po_id, req.body.order_id, /^\/admin\//.test(req.body.redirect || '') ? req.body.redirect : null));
r.post('/:id/link', (req, res) => linkPo(req, res, req.params.id, req.body.order_id));
r.post('/:id/unlink', (req, res) => linkPo(req, res, req.params.id, null));

// ---- one PO ----
async function load(id) {
  if (!isId(id)) return null;
  const { data: po } = await admin.from('supplier_pos').select('*, suppliers(*), orders(id, order_no, status, organizations(name))').eq('id', id).maybeSingle();
  return po;
}


// ---- the supplier's PI and our payments to the supplier (migration 0037) ----
const SPI_IMG = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const migErr = e => (/supplier_pis|supplier_payments/.test(e.message) ? 'Run supabase/migrations/0037_supplier_pi.sql in the Supabase SQL editor first.' : e.message);
const day = v => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
const money = (v, c) => `${c} ${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
async function attach(req, po, files, kind) {
  const [type, id] = ent(po), ids = [];
  for (const file of files || []) ids.push((await uploadDocument({ file, entityType: type, entityId: id, kind, title: file.originalname, clientVisible: false, uploadedBy: req.user.id })).id);
  return ids;
}
r.post('/:id/pi', upload.array('files', 8), async (req, res) => {
  const po = await load(req.params.id);
  if (!po) return notFound(res, 'Purchase order');
  const to = `/admin/purchasing/${po.id}#supplier-pi`;
  const lines = parseLines(req.body);
  if (!lines.length) return back(res, to, { err: 'Add at least one line with a quantity.' });
  const declared = String(req.body.declared_total ?? '').trim() === '' ? null : Math.round(Number(String(req.body.declared_total).replace(',', '.')) * 100) / 100;
  const chk = checkPi({ lines, declared: Number.isFinite(declared) ? declared : null });
  const currency = CURRENCIES.includes(req.body.currency) ? req.body.currency : po.currency;
  const row = { po_id: po.id, pi_no: String(req.body.pi_no || '').trim().slice(0, 80) || null, pi_date: day(req.body.pi_date), currency, lines, total: chk.total, declared_total: chk.declared,
    notes: String(req.body.notes || '').trim().slice(0, 1000) || null, status: req.body.act === 'approve' && chk.matches ? 'confirmed' : 'draft' };
  let pid = isId(req.body.pid) ? req.body.pid : null, old = null;
  if (pid) { old = (await admin.from('supplier_pis').select('file_doc_ids').eq('id', pid).eq('po_id', po.id).maybeSingle()).data; if (!old) pid = null; }
  let newIds;
  try { newIds = await attach(req, po, req.files, 'other'); } catch (e) { return back(res, to, { err: e.message }); }
  const file_doc_ids = [...(old?.file_doc_ids || []), ...newIds];
  const q = pid ? admin.from('supplier_pis').update({ ...row, file_doc_ids }).eq('id', pid) : admin.from('supplier_pis').insert({ ...row, file_doc_ids, created_by: req.user.id });
  const { error } = await q;
  if (error) return back(res, to, { err: migErr(error) });
  await log({ entityType: ent(po)[0], entityId: ent(po)[1], action: 'supplier_pi_saved', actorId: req.user.id, detail: { note: `${po.ref}: ${money(chk.total, currency)}` } });
  if (req.body.act !== 'approve') return back(res, to, chk.matches ? { msg: `Draft saved — total ${money(chk.total, currency)} matches the PI. Approve it when you have checked the lines.` } : { msg: `Draft saved — lines total ${money(chk.total, currency)}${chk.declared != null ? `, the PI says ${money(chk.declared, currency)}` : ''}.` });
  if (!chk.matches) return back(res, to, { err: chk.declared == null ? "Not approved, saved as a draft — enter the total printed on the supplier's PI so it can be checked." : `Not approved, saved as a draft — the lines add up to ${money(chk.total, currency)} but the PI says ${money(chk.declared, currency)} (difference ${money(chk.diff, currency)}). Check quantities and prices.` });
  back(res, to, { msg: `Supplier PI approved — total ${money(chk.total, currency)}.` });
});
r.post('/:id/pi/:pid/files', upload.array('files', 8), async (req, res) => {
  const po = await load(req.params.id);
  if (!po) return notFound(res, 'Purchase order');
  const to = `/admin/purchasing/${po.id}#supplier-pi`;
  const { data: pi } = await admin.from('supplier_pis').select('id, file_doc_ids').eq('id', req.params.pid).eq('po_id', po.id).maybeSingle();
  if (!pi) return notFound(res, 'Supplier PI');
  if (!req.files?.length) return back(res, to, { err: 'Choose at least one file.' });
  const rep = String(req.body.replace || '');
  try { const ids = await attach(req, po, req.files, 'other'); await admin.from('supplier_pis').update({ file_doc_ids: [...(pi.file_doc_ids || []).filter(x => x !== rep), ...ids] }).eq('id', pi.id); } catch (e) { return back(res, to, { err: e.message }); }
  back(res, to, { msg: rep ? 'File replaced.' : 'File attached.' });
});
r.post('/:id/pi/:pid/files/:did/remove', async (req, res) => {
  const po = await load(req.params.id);
  if (!po) return notFound(res, 'Purchase order');
  const to = `/admin/purchasing/${po.id}#supplier-pi`;
  const { data: pi } = await admin.from('supplier_pis').select('id, file_doc_ids').eq('id', req.params.pid).eq('po_id', po.id).maybeSingle();
  if (!pi) return notFound(res, 'Supplier PI');
  await admin.from('supplier_pis').update({ file_doc_ids: (pi.file_doc_ids || []).filter(x => x !== req.params.did) }).eq('id', pi.id);
  back(res, to, { msg: 'File removed from the PI (it stays in the documents).' });
});
r.post('/:id/pi/:pid/approve', async (req, res) => {
  const po = await load(req.params.id);
  if (!po) return notFound(res, 'Purchase order');
  const to = `/admin/purchasing/${po.id}#supplier-pi`;
  const { data: pi } = await admin.from('supplier_pis').select('id, lines, declared_total, currency').eq('id', req.params.pid).eq('po_id', po.id).maybeSingle();
  if (!pi) return notFound(res, 'Supplier PI');
  const chk = checkPi({ lines: pi.lines, declared: pi.declared_total });
  if (!chk.matches) return back(res, to, { err: 'The lines do not match the total printed on the PI yet.' });
  await admin.from('supplier_pis').update({ status: 'confirmed' }).eq('id', pi.id);
  await log({ entityType: ent(po)[0], entityId: ent(po)[1], action: 'supplier_pi_approved', actorId: req.user.id, detail: { note: po.ref } });
  back(res, to, { msg: 'Supplier PI approved.' });
});
r.post('/:id/pi/:pid/delete', async (req, res) => {
  const po = await load(req.params.id);
  if (!po) return notFound(res, 'Purchase order');
  const to = `/admin/purchasing/${po.id}#supplier-pi`;
  const { data: pi } = await admin.from('supplier_pis').select('id, created_by').eq('id', req.params.pid).eq('po_id', po.id).maybeSingle();
  if (!pi) return notFound(res, 'Supplier PI');
  if (!canDelete(req.user, pi)) return back(res, to, { err: 'You can delete only records you created.' });
  await admin.from('supplier_pis').delete().eq('id', pi.id);
  back(res, to, { msg: 'Supplier PI deleted (the files stay in the documents).' });
});
// attach the supplier's file and let AI fill the lines — saved as a draft to check
r.post('/:id/pi/read', upload.array('files', 8), async (req, res) => {
  const po = await load(req.params.id);
  if (!po) return notFound(res, 'Purchase order');
  const to = `/admin/purchasing/${po.id}#supplier-pi`, f = req.files?.[0];
  if (!f) return back(res, to, { err: "Choose or drop the supplier's PI file." });
  if (!aiEnabled()) return back(res, to, { err: 'AI is not configured (ANTHROPIC_API_KEY). Attach the file and type the lines instead.' });
  const ext = (f.originalname.split('.').pop() || '').toLowerCase();
  try {
    let src;
    if (['xlsx', 'xlsm', 'csv', 'txt'].includes(ext)) src = { text: workbookToText(ext === 'csv' || ext === 'txt' ? readCsv(f.buffer.toString('utf8').replace(/^﻿/, '')) : readXlsx(f.buffer)), filename: f.originalname };
    else if (ext === 'pdf') src = { pdf: f.buffer, filename: f.originalname };
    else if (SPI_IMG[ext]) src = { image: { data: f.buffer, mediaType: SPI_IMG[ext] }, filename: f.originalname };
    else return back(res, to, { err: 'Upload a PDF, Excel, CSV or screenshot.' });
    const ai = await extractSupplierPi(src, { type: 'supplier_po', id: po.id });
    const { data: products } = await admin.from('products').select('id, name, sku');
    const lines = matchProducts(parseLines({ lines: ai.lines.map(l => ({ description: l.description, sku: l.sku, quantity: l.quantity, unit: l.unit, unit_price: l.unit_price })) }), products || []);
    if (!lines.length) return back(res, to, { err: 'The AI found no lines in that file — attach it and type the lines.' });
    const currency = CURRENCIES.includes(ai.currency) ? ai.currency : po.currency;
    const chk = checkPi({ lines, declared: ai.printed_total });
    const ids = await attach(req, po, req.files, 'other');
    const { error } = await admin.from('supplier_pis').insert({ po_id: po.id, pi_no: ai.pi_no, pi_date: day(ai.pi_date), currency, lines, total: chk.total, declared_total: chk.declared, file_doc_ids: ids, notes: ai.notes || null, status: 'draft', created_by: req.user.id });
    if (error) return back(res, to, { err: migErr(error) });
    back(res, to, chk.matches ? { msg: `Read by AI — ${lines.length} lines, total ${money(chk.total, currency)} matches the PI. Check the lines, then approve it.` } : { err: `Read by AI as a draft — the lines add up to ${money(chk.total, currency)}${chk.declared != null ? ` but the PI says ${money(chk.declared, currency)}` : ''}. Check every line against the file before relying on it.` });
  } catch (e) { back(res, to, { err: `Could not read the file: ${e.message}` }); }
});
// payments to the supplier (shares of the PI total)
const payBody = b => ({ amount: Math.round(Number(String(b.amount || '').replace(',', '.')) * 100) / 100, paid_on: day(b.paid_on),
  label: String(b.label || '').trim().slice(0, 40) || null, reference: String(b.reference || '').trim().slice(0, 120) || null });
r.post('/:id/payments', async (req, res) => {
  const po = await load(req.params.id);
  if (!po) return notFound(res, 'Purchase order');
  const to = `/admin/purchasing/${po.id}#supplier-pi`, b = payBody(req.body);
  if (!(b.amount > 0)) return back(res, to, { err: 'Enter the amount paid.' });
  const { data: pi } = await admin.from('supplier_pis').select('currency').eq('po_id', po.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
  const { error } = await admin.from('supplier_payments').insert({ ...b, paid_on: b.paid_on || new Date().toISOString().slice(0, 10), po_id: po.id, currency: pi?.currency || po.currency, created_by: req.user.id });
  if (error) return back(res, to, { err: migErr(error) });
  await log({ entityType: ent(po)[0], entityId: ent(po)[1], action: 'supplier_payment_recorded', actorId: req.user.id, detail: { note: `${po.ref}: ${money(b.amount, pi?.currency || po.currency)}` } });
  back(res, to, { msg: 'Payment to the supplier recorded.' });
});
r.post('/:id/payments/:sid/edit', async (req, res) => {
  const to = `/admin/purchasing/${req.params.id}#supplier-pi`, b = payBody(req.body);
  if (!(b.amount > 0)) return back(res, to, { err: 'Enter the amount.' });
  const upd = { amount: b.amount, label: b.label, reference: b.reference }; if (b.paid_on) upd.paid_on = b.paid_on;
  const { error } = await admin.from('supplier_payments').update(upd).eq('id', req.params.sid).eq('po_id', req.params.id);
  back(res, to, error ? { err: migErr(error) } : { msg: 'Payment updated.' });
});
r.post('/:id/payments/:sid/delete', async (req, res) => {
  const to = `/admin/purchasing/${req.params.id}#supplier-pi`;
  const { data: rec } = await admin.from('supplier_payments').select('id, created_by').eq('id', req.params.sid).eq('po_id', req.params.id).maybeSingle();
  if (!rec) return notFound(res, 'Payment');
  if (!canDelete(req.user, rec)) return back(res, to, { err: 'You can delete only records you created.' });
  await admin.from('supplier_payments').delete().eq('id', rec.id);
  back(res, to, { msg: 'Payment record deleted.' });
});
r.post('/:id/payments/:sid/files', upload.array('files', 8), async (req, res) => {
  const po = await load(req.params.id);
  if (!po) return notFound(res, 'Purchase order');
  const to = `/admin/purchasing/${po.id}#supplier-pi`;
  const { data: sp } = await admin.from('supplier_payments').select('id, proof_doc_ids').eq('id', req.params.sid).eq('po_id', po.id).maybeSingle();
  if (!sp) return notFound(res, 'Payment');
  if (!req.files?.length) return back(res, to, { err: 'Choose at least one file.' });
  try { const ids = await attach(req, po, req.files, 'payment_proof'); await admin.from('supplier_payments').update({ proof_doc_ids: [...(sp.proof_doc_ids || []), ...ids] }).eq('id', sp.id); } catch (e) { return back(res, to, { err: e.message }); }
  back(res, to, { msg: `${req.files.length} proof file${req.files.length === 1 ? '' : 's'} added.` });
});

r.get('/:id', async (req, res) => {
  const po = await load(req.params.id);
  if (!po) return notFound(res, 'Purchase order');
  const { data: responses } = await admin.from('supplier_po_responses').select('*').eq('po_id', po.id).order('received_at', { ascending: false });
  const ids = [...new Set((responses || []).flatMap(x => (x.extracted?.files || []).map(f => f.id)))];
  const { data: docs } = ids.length ? await admin.from('documents').select('id, title, kind, mime_type').in('id', ids) : { data: [] };
  const { data: openOrders } = po.order_id ? { data: [] } : await admin.from('orders').select('id, order_no, status, organizations(name)').not('status', 'in', '("closed","cancelled","delivered")').order('created_at', { ascending: false }).limit(100);
  const [{ data: spis }, { data: spays }, { data: products }] = await Promise.all([
    admin.from('supplier_pis').select('*').eq('po_id', po.id).order('created_at', { ascending: false }),   // empty before migration 0037
    admin.from('supplier_payments').select('*').eq('po_id', po.id).order('created_at'),
    admin.from('products').select('id, name, sku, unit_cost, cost_currency').order('name'),
  ]);
  const sdocIds = [...(spis || []).flatMap(x => x.file_doc_ids || []), ...(spays || []).flatMap(x => x.proof_doc_ids || [])];
  const { data: sdocs } = sdocIds.length ? await admin.from('documents').select('id, title').in('id', sdocIds) : { data: [] };
  res.render('admin/purchasing/detail', { aiOn: aiEnabled(), checkPi, paymentPlan, spis: spis || [], spays: spays || [], sdocs: sdocs || [], products: products || [], openOrders: openOrders || [], title: po.ref, po, supplier: po.suppliers, order: po.orders, responses: responses || [], docs: docs || [], labels: SPO_LABEL, replyTo: replyAddress(po.token, ''), msg: req.query.msg, err: req.query.err });
});

r.post('/:id', async (req, res) => {
  const po = await load(req.params.id);
  if (!po) return notFound(res, 'Purchase order');
  if (po.status !== 'draft') return back(res, `/admin/purchasing/${po.id}`, { err: 'Only a draft can be edited. Send a note to the supplier instead (log the reply below).' });
  const b = req.body, s = (v, n = 500) => String(v ?? '').trim().slice(0, n) || null;
  const lines = parseLines(b).map((l, i) => ({ ...l, order_item_id: po.lines[i]?.order_item_id || null, product_id: l.product_id || po.lines[i]?.product_id || null }));
  if (!lines.length) return back(res, `/admin/purchasing/${po.id}`, { err: 'Keep at least one line with a quantity.' });
  await admin.from('supplier_pos').update({ title: s(b.title, 200), lines, total: totalOf(lines), required_date: /^\d{4}-\d{2}-\d{2}$/.test(b.required_date || '') ? b.required_date : null,
    payment_terms: s(b.payment_terms, 300), ship_to: s(b.ship_to, 600), notes: s(b.notes, 2000), message: s(b.message, 2000), want_packing: bool(b.want_packing), sent_to: s(b.sent_to, 200), updated_at: new Date().toISOString() }).eq('id', po.id);
  back(res, `/admin/purchasing/${po.id}`, { msg: 'Saved.' });
});

r.get('/:id/pdf', async (req, res) => {
  const po = await load(req.params.id);
  if (!po) return notFound(res, 'Purchase order');
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${po.ref}.pdf"` });
  res.send(Buffer.from(spoPdf(po, { supplier: po.suppliers, order: po.orders, company: await getCompany(admin) })));
});

r.post('/:id/send', async (req, res) => {
  const po = await load(req.params.id);
  if (!po) return notFound(res, 'Purchase order');
  const to = `/admin/purchasing/${po.id}`;
  if (!['draft', 'sent', 'replied'].includes(po.status)) return back(res, to, { err: 'This purchase order can no longer be sent.' });
  const sentTo = String(req.body.sent_to || po.sent_to || '').split(/[,;\s]+/).filter(x => /@/.test(x));
  if (!sentTo.length) return back(res, to, { err: 'Enter the supplier\'s email address first.' });
  if (!po.lines?.length) return back(res, to, { err: 'The purchase order has no lines.' });
  const company = await getCompany(admin);
  try {
    const m = spoEmail({ po, supplier: po.suppliers, order: po.orders, message: po.message, senderName: req.user.full_name });
    const sentPo = { ...po, status: po.status === 'draft' ? 'sent' : po.status, sent_at: new Date().toISOString() };   // the PDF that goes out must not say "Draft"
    const attachments = [{ filename: `${po.ref}.pdf`, content: Buffer.from(spoPdf(sentPo, { supplier: po.suppliers, order: po.orders, company })) }];
    if (po.want_packing) attachments.push({ filename: `${po.ref}-estimated-packing-list.xlsx`, content: Buffer.from(packingTemplate(po, { order: po.orders })) });
    await sendEmail({ to: sentTo, ...m, subject: `${m.subject} ${subjectTag(po.ref, po.token)}`, replyTo: replyAddress(po.token, req.user.email), attachments });
  } catch (e) { return back(res, to, { err: `Email failed: ${e.message}` }); }
  const now = new Date().toISOString();
  await admin.from('supplier_pos').update({ status: po.status === 'draft' ? 'sent' : po.status, sent_to: sentTo.join(', '), sent_at: now, sent_by: req.user.id, updated_at: now }).eq('id', po.id);
  await log({ entityType: ent(po)[0], entityId: ent(po)[1], action: 'supplier_po_sent', actorId: req.user.id, detail: { note: `${po.ref} → ${sentTo.join(', ')}` } });
  back(res, to, { msg: `Sent to ${sentTo.join(', ')}. Their reply will appear below when it arrives.` });
});

// log an answer by hand: pasted email / WeChat message, files received outside the mailbox
r.post('/:id/reply', upload.array('files', 8), async (req, res) => {
  const po = await load(req.params.id);
  if (!po) return notFound(res, 'Purchase order');
  const to = `/admin/purchasing/${po.id}`;
  const text = String(req.body.body || '').trim();
  if (!text && !req.files?.length) return back(res, to, { err: 'Paste the supplier\'s message or attach their files.' });
  try {
    const out = await saveSupplierReply({ po, channel: ['wechat', 'email'].includes(req.body.channel) ? req.body.channel : 'manual', from: String(req.body.from || '').trim().slice(0, 200) || po.suppliers?.name || null,
      subject: null, text, files: req.files || [], outcome: req.body.outcome || null, userId: req.user.id });
    back(res, to, { msg: `Reply saved — ${out.extracted?.summary || out.status}` });
  } catch (e) { back(res, to, { err: e.message }); }
});

r.post('/:id/status', async (req, res) => {
  const po = await load(req.params.id);
  if (!po) return notFound(res, 'Purchase order');
  const st = req.body.status;
  if (!['sent', 'confirmed', 'declined', 'cancelled'].includes(st)) return back(res, `/admin/purchasing/${po.id}`, { err: 'Unknown status.' });
  const now = new Date().toISOString();
  await admin.from('supplier_pos').update({ status: st, updated_at: now, ...(st === 'confirmed' ? { confirmed_at: po.confirmed_at || now } : {}) }).eq('id', po.id);
  await log({ entityType: ent(po)[0], entityId: ent(po)[1], action: 'supplier_po_status', actorId: req.user.id, detail: { note: `${po.ref}: ${st}` } });
  back(res, `/admin/purchasing/${po.id}`, { msg: `Marked as ${SPO_LABEL[st].toLowerCase()}.` });
});

r.post('/:id/delete', async (req, res) => {
  const po = await load(req.params.id);
  if (!po) return notFound(res, 'Purchase order');
  if (po.status !== 'draft') return back(res, `/admin/purchasing/${po.id}`, { err: 'Only a draft can be deleted — cancel it instead.' });
  await admin.from('supplier_pos').delete().eq('id', po.id);
  back(res, po.order_id ? `/admin/orders/${po.order_id}` : '/admin/purchasing', { msg: `${po.ref} deleted.` });
});

export default r;
