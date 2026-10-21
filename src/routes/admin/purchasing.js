// Purchasing: purchase orders to suppliers, generated from a client order, sent by email, answered by email.
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

// a PO without an order: pick the supplier and add products by hand
r.get('/new', async (req, res, next) => {
  if (isId(req.query.order)) return next();
  const [{ data: suppliers }, { data: products }, { data: orders }] = await Promise.all([
    admin.from('suppliers').select('id, name, email, payment_terms').order('name'),
    admin.from('products').select('id, name, sku, supplier_id, unit_cost, cost_currency, description, moq').order('name'),
    admin.from('orders').select('id, order_no, status, organizations(name)').not('status', 'in', '("closed","cancelled","delivered")').order('created_at', { ascending: false }).limit(100),
  ]);
  const { data: ph } = await admin.from('documents').select('id, entity_id').eq('entity_type', 'product').eq('kind', 'product_photo').order('created_at'); // first photo per product, for the picker
  const photo = {}; (ph || []).forEach(d => { photo[d.entity_id] ||= d.id; });
  res.render('admin/purchasing/new_manual', { title: 'New purchase order', suppliers: suppliers || [], products: (products || []).map(x => ({ ...x, photo: photo[x.id] || null })), orders: orders || [], currencies: CURRENCIES, error: req.query.err || null, supplier_id: isId(req.query.supplier) ? req.query.supplier : '' });
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

r.post('/new-manual', async (req, res) => {
  const b = req.body, to = '/admin/purchasing/new';
  if (!isId(b.supplier_id)) return back(res, to, { err: 'Choose the supplier.' });
  const arr = Array.isArray(b.line) ? b.line : Object.values(b.line || {});
  const lines = arr.filter(l => l && String(l.description || '').trim() && Number(l.quantity) > 0).map(l => ({ description: String(l.description).trim().slice(0, 500), sku: String(l.sku || '').trim().slice(0, 80),
    quantity: Number(l.quantity), unit: String(l.unit || 'pcs').trim().slice(0, 20) || 'pcs', unit_price: Number(String(l.unit_price).replace(',', '.')) || 0, product_id: isId(l.product_id) ? l.product_id : null, order_item_id: null }));
  if (!lines.length) return back(res, `${to}?supplier=${b.supplier_id}`, { err: 'Add at least one product with a quantity.' });
  const { data: sup } = await admin.from('suppliers').select('id, email, payment_terms').eq('id', b.supplier_id).maybeSingle();
  if (!sup) return back(res, to, { err: 'Supplier not found.' });
  const orderId = isId(b.order_id) ? b.order_id : null;
  let po = null, lastErr = null;
  for (let n = 0; n < 5 && !po; n++) {
    const { data, error } = await admin.from('supplier_pos').insert({ order_id: orderId, supplier_id: sup.id, title: String(b.title || '').trim().slice(0, 200) || null, currency: CURRENCIES.includes(b.currency) ? b.currency : 'CNY',
      lines, total: totalOf(lines), required_date: /^\d{4}-\d{2}-\d{2}$/.test(b.required_date || '') ? b.required_date : null, payment_terms: sup.payment_terms || null, sent_to: sup.email || null, created_by: req.user.id }).select('id, ref').single();
    if (!error) po = data; else lastErr = error;
  }
  if (!po) return back(res, `${to}?supplier=${sup.id}`, { err: /order_id/.test(lastErr?.message || '') && /null/.test(lastErr?.message || '') ? 'Run supabase/migrations/0022_purchasing_standalone.sql first.' : missingTable(lastErr) ? MIGRATION : lastErr?.message || 'Could not create the PO.' });
  await log({ entityType: orderId ? 'order' : 'supplier', entityId: orderId || sup.id, action: 'supplier_pos_created', actorId: req.user.id, detail: { note: po.ref } });
  res.redirect(`/admin/purchasing/${po.id}?msg=${encodeURIComponent(`${po.ref} created${orderId ? '' : ' — not linked to an order yet'}. Check it, then send.`)}`);
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
  const { data: po } = await admin.from('supplier_pos').select('*, suppliers(*), orders(id, order_no, organizations(name))').eq('id', id).maybeSingle();
  return po;
}

r.get('/:id', async (req, res) => {
  const po = await load(req.params.id);
  if (!po) return notFound(res, 'Purchase order');
  const { data: responses } = await admin.from('supplier_po_responses').select('*').eq('po_id', po.id).order('received_at', { ascending: false });
  const ids = [...new Set((responses || []).flatMap(x => (x.extracted?.files || []).map(f => f.id)))];
  const { data: docs } = ids.length ? await admin.from('documents').select('id, title, kind, mime_type').in('id', ids) : { data: [] };
  const { data: openOrders } = po.order_id ? { data: [] } : await admin.from('orders').select('id, order_no, status, organizations(name)').not('status', 'in', '("closed","cancelled","delivered")').order('created_at', { ascending: false }).limit(100);
  res.render('admin/purchasing/detail', { openOrders: openOrders || [], title: po.ref, po, supplier: po.suppliers, order: po.orders, responses: responses || [], docs: docs || [], labels: SPO_LABEL, replyTo: replyAddress(po.token, ''), msg: req.query.msg, err: req.query.err });
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
    const attachments = [{ filename: `${po.ref}.pdf`, content: Buffer.from(spoPdf(po, { supplier: po.suppliers, order: po.orders, company })) }];
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
