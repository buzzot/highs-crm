// Admin side of client purchase orders (review → approve → order) and proforma invoices (generate → send).
import { Router } from '../../lib/router.js';
import { admin } from '../../lib/supabase.js';
import { log } from '../../lib/activity.js';
import { back, notFound } from '../../lib/util.js';
import { uploadDocument } from '../../lib/storage.js';
import { sendEmail } from '../../lib/mailer.js';
import { poRejectedEmail, piEmail } from '../../lib/email-templates.js';
import { DEFAULT_SCHEDULE, parseSchedule, withAmounts } from '../../lib/payments.js';
import { recalcOrder } from '../../lib/payments-db.js';
import { getCompany, poPdf, piPdf, totalOf, parseLines, text } from '../../lib/purchase.js';

const appUrl = () => (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
const s = (v, n = 300) => String(v ?? '').trim().slice(0, n);
const r2 = x => Math.round(Number(x || 0) * 100) / 100;
const dayOnly = v => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);

// ============================ purchase orders ============================
export const po = Router();

async function loadPo(id) {
  const { data } = await admin.from('purchase_orders').select('*, organizations(id, name), requests(id, ref, title), quotes(id, status, quantity, unit_price, sell_currency, unit_cost, fx_rate, margin_pct, product_id, supplier_id, lead_time_days, incoterm, request_item_id)').eq('id', id).maybeSingle();
  return data;
}
const clientFrom = (b, old) => ({ ...old, company: s(b.company, 200) || old.company, contact: s(b.contact, 120), email: s(b.email, 200), phone: s(b.phone, 60), ref: s(b.ref, 60), address: s(b.address, 500), delivery_address: s(b.delivery_address, 500) });
const poPatch = (b, old) => ({
  client: clientFrom(b, old.client || {}), lines: parseLines(b), incoterm: s(b.incoterm, 20) || null, lead_time_days: Number(b.lead_time_days) > 0 ? Math.round(Number(b.lead_time_days)) : null,
  terms: text(b.terms), admin_comment: text(b.admin_comment), admin_note: text(b.admin_note, 1000), updated_at: new Date().toISOString(),
});

po.get('/:id', async (req, res) => {
  const p = await loadPo(req.params.id);
  if (!p) return notFound(res, 'Purchase order');
  const [{ data: order }, { data: pis }] = await Promise.all([
    p.order_id ? admin.from('orders').select('id, order_no').eq('id', p.order_id).maybeSingle() : { data: null },
    p.order_id ? admin.from('proforma_invoices').select('id, pi_no, status').eq('order_id', p.order_id).order('created_at') : { data: [] },
  ]);
  const q = p.quotes;
  res.render('admin/po', {
    title: p.po_no, p, order, pis: pis || [], quoteTotal: q ? r2(Number(q.quantity) * Number(q.unit_price)) : null, total: totalOf(p.lines),
    editable: ['draft', 'submitted'].includes(p.status), msg: req.query.msg, err: req.query.err,
  });
});
po.get('/:id/pdf', async (req, res) => {
  const p = await loadPo(req.params.id);
  if (!p) return notFound(res, 'Purchase order');
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${p.po_no}.pdf"` });
  res.send(poPdf(p, await getCompany(admin)));
});
po.post('/:id', async (req, res) => {
  const p = await loadPo(req.params.id);
  if (!p) return notFound(res, 'Purchase order');
  if (!['draft', 'submitted'].includes(p.status)) return back(res, `/admin/po/${p.id}`, { err: `A ${p.status} purchase order can't be edited.` });
  const patch = poPatch(req.body, p);
  if (!patch.lines.length) return back(res, `/admin/po/${p.id}`, { err: 'Keep at least one line with a quantity.' });
  await admin.from('purchase_orders').update(patch).eq('id', p.id);
  await log({ entityType: 'request', entityId: p.request_id, action: 'po_edited', actorId: req.user.id, detail: { po_no: p.po_no } });
  back(res, `/admin/po/${p.id}`, { msg: 'Changes saved.' });
});

// approve → the order is created from the (checked and edited) PO
po.post('/:id/approve', async (req, res) => {
  const p = await loadPo(req.params.id);
  if (!p) return notFound(res, 'Purchase order');
  if (p.status !== 'submitted') return back(res, `/admin/po/${p.id}`, { err: 'Only a PO the client has sent can be approved.' });
  const patch = poPatch(req.body, p);
  if (!patch.lines.length) return back(res, `/admin/po/${p.id}`, { err: 'Keep at least one line with a quantity.' });
  const q = p.quotes;
  const total = totalOf(patch.lines);
  let orderId = null;
  const { data: existing } = q ? await admin.from('orders').select('id').eq('quote_id', q.id).maybeSingle() : { data: null };
  if (existing) orderId = existing.id;
  else {
    const unitCostSell = q ? Number(q.unit_cost) * Number(q.fx_rate) : null;
    const single = patch.lines.length === 1;
    const qtyAll = patch.lines.reduce((t, l) => t + Number(l.quantity), 0);
    const { data: order, error } = await admin.from('orders').insert({
      org_id: p.org_id, request_id: p.request_id, quote_id: q?.id || null, supplier_id: q?.supplier_id || null, currency: p.currency, status: 'new',
      subtotal: total, cost_total: unitCostSell != null ? r2(unitCostSell * qtyAll) : 0,
      client_notes: p.client_notes, internal_notes: patch.admin_comment,
      expected_ship_date: patch.lead_time_days ? new Date(Date.now() + patch.lead_time_days * 864e5).toISOString().slice(0, 10) : null,
    }).select('id, order_no').single();
    if (error) return back(res, `/admin/po/${p.id}`, { err: error.message });
    orderId = order.id;
    let hs = null;
    if (q?.product_id) hs = (await admin.from('products').select('hs_code').eq('id', q.product_id).maybeSingle()).data?.hs_code || null;
    await admin.from('order_items').insert(patch.lines.map((l, i) => ({
      order_id: orderId, product_id: l.product_id || (single || i === 0 ? q?.product_id || null : null), description: l.description,
      quantity: Math.round(l.quantity), unit_cost: unitCostSell != null && single ? Math.round(unitCostSell * 10000) / 10000 : null, unit_price: l.unit_price, hs_code: i === 0 ? hs : null,
    })));
    await log({ entityType: 'order', entityId: orderId, action: 'order_confirmed', actorId: req.user.id, clientVisible: true, detail: { note: `from ${p.po_no}` } });
  }
  await admin.from('purchase_orders').update({ ...patch, status: 'approved', order_id: orderId, decided_at: new Date().toISOString(), decided_by: req.user.id }).eq('id', p.id);
  await admin.from('requests').update({ status: 'accepted' }).eq('id', p.request_id);
  await log({ entityType: 'request', entityId: p.request_id, action: 'po_approved', actorId: req.user.id, clientVisible: true, detail: { po_no: p.po_no } });
  res.redirect(`/admin/po/${p.id}?msg=` + encodeURIComponent('PO approved and order created. Check the details, then generate the proforma invoice.'));
});

po.post('/:id/reject', async (req, res) => {
  const p = await loadPo(req.params.id);
  if (!p) return notFound(res, 'Purchase order');
  if (p.status !== 'submitted') return back(res, `/admin/po/${p.id}`, { err: 'Only a PO the client has sent can be rejected.' });
  const note = s(req.body.admin_note, 1000);
  if (!note) return back(res, `/admin/po/${p.id}`, { err: 'Write a note for the client — what needs to change.' });
  await admin.from('purchase_orders').update({ ...poPatch(req.body, p), status: 'rejected', admin_note: note, decided_at: new Date().toISOString(), decided_by: req.user.id }).eq('id', p.id);
  await log({ entityType: 'request', entityId: p.request_id, action: 'po_rejected', actorId: req.user.id, clientVisible: true, detail: { note } });
  let sent = '';
  try {
    const to = p.client?.email;
    if (to) { await sendEmail({ to, ...poRejectedEmail({ po: p, note, url: `${appUrl()}/portal/requests/${p.request_id}` }) }); sent = ` The client was emailed (${to}).`; }
  } catch (e) { console.error(`[po] reject email: ${e.message}`); }
  back(res, `/admin/po/${p.id}`, { msg: 'PO sent back to the client.' + sent });
});

// ============================ proforma invoices ============================
export const pi = Router();

const lineFromItem = it => ({ description: it.description, sku: '', quantity: Number(it.quantity), unit: 'pcs', unit_price: Number(it.unit_price) });

// create (or open) the proforma invoice of an order
pi.post('/order/:oid', async (req, res) => {
  const { data: order } = await admin.from('orders').select('*, organizations(*)').eq('id', req.params.oid).maybeSingle();
  if (!order) return notFound(res, 'Order');
  const { data: have } = await admin.from('proforma_invoices').select('id').eq('order_id', order.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (have && !req.body.another) return res.redirect(`/admin/pi/${have.id}`);
  const [{ data: items }, { data: pos }, company, { data: quote }] = await Promise.all([
    admin.from('order_items').select('*').eq('order_id', order.id),
    admin.from('purchase_orders').select('*').eq('order_id', order.id).order('created_at', { ascending: false }).limit(1),
    getCompany(admin),
    order.quote_id ? admin.from('quotes').select('incoterm, lead_time_days').eq('id', order.quote_id).maybeSingle() : { data: null },
  ]);
  const p = pos?.[0] || null, org = order.organizations || {};
  const buyer = p?.client || { company: org.name, contact: '', email: org.email || '', phone: org.phone || '', address: [org.address, [org.postal_code, org.city].filter(Boolean).join(' '), org.country].filter(Boolean).join('\n'), delivery_address: org.delivery_address || '' };
  const valid = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
  const { data: row, error } = await admin.from('proforma_invoices').insert({
    order_id: order.id, po_id: p?.id || null, created_by: req.user.id,
    data: { buyer, lines: p?.lines?.length ? p.lines : (items || []).map(lineFromItem), currency: order.currency, incoterm: p?.incoterm || quote?.incoterm || '', lead_time_days: p?.lead_time_days || quote?.lead_time_days || null,
      po_ref: p?.client?.ref || '', schedule: DEFAULT_SCHEDULE, payment_terms: company.payment_terms, bank: company.bank, notes: '', valid_until: valid },
  }).select('id').single();
  if (error) return back(res, `/admin/orders/${order.id}`, { err: error.message });
  await log({ entityType: 'order', entityId: order.id, action: 'pi_created', actorId: req.user.id });
  res.redirect(`/admin/pi/${row.id}`);
});

async function loadPi(id) {
  const { data } = await admin.from('proforma_invoices').select('*, orders(id, order_no, org_id, request_id, organizations(name))').eq('id', id).maybeSingle();
  return data;
}
const piData = (b, old) => ({
  ...old, buyer: { ...old.buyer, company: s(b.company, 200), contact: s(b.contact, 120), email: s(b.email, 200), phone: s(b.phone, 60), address: s(b.address, 500), delivery_address: s(b.delivery_address, 500) },
  lines: parseLines(b), incoterm: s(b.incoterm, 20), lead_time_days: Number(b.lead_time_days) > 0 ? Math.round(Number(b.lead_time_days)) : null, po_ref: s(b.po_ref, 60),
  schedule: parseSchedule(b), payment_terms: s(b.payment_terms, 600), bank: s(b.bank, 1000), notes: s(b.notes, 2000), valid_until: dayOnly(b.valid_until) || old.valid_until,
});

pi.get('/:id', async (req, res) => {
  const p = await loadPi(req.params.id);
  if (!p) return notFound(res, 'Proforma invoice');
  res.render('admin/pi', { title: p.pi_no, p, order: p.orders, total: totalOf(p.data.lines), msg: req.query.msg, err: req.query.err });
});
pi.get('/:id/pdf', async (req, res) => {
  const p = await loadPi(req.params.id);
  if (!p) return notFound(res, 'Proforma invoice');
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${p.pi_no}.pdf"` });
  res.send(piPdf(p, p.orders, await getCompany(admin)));
});
pi.post('/:id', async (req, res) => {
  const p = await loadPi(req.params.id);
  if (!p) return notFound(res, 'Proforma invoice');
  const data = piData(req.body, p.data);
  if (!data.lines.length) return back(res, `/admin/pi/${p.id}`, { err: 'Keep at least one line with a quantity.' });
  await admin.from('proforma_invoices').update({ data, updated_at: new Date().toISOString() }).eq('id', p.id);
  back(res, `/admin/pi/${p.id}`, { msg: 'Saved.' });
});

// send to the client: PDF is kept with the order (client-visible) and emailed
pi.post('/:id/send', async (req, res) => {
  const p = await loadPi(req.params.id);
  if (!p) return notFound(res, 'Proforma invoice');
  const data = piData(req.body, p.data);
  if (!data.lines.length) return back(res, `/admin/pi/${p.id}`, { err: 'Keep at least one line with a quantity.' });
  const to = s(req.body.send_to, 300).split(/[,;\s]+/).filter(x => /@/.test(x));
  if (!to.length) { await admin.from('proforma_invoices').update({ data }).eq('id', p.id); return back(res, `/admin/pi/${p.id}`, { err: 'Enter the email address to send it to.' }); }
  const sentAt = new Date().toISOString();
  const row = { ...p, data, status: 'sent', sent_at: sentAt };
  const company = await getCompany(admin);
  const pdf = piPdf(row, p.orders, company);
  try {
    await sendEmail({ to, ...piEmail({ pi: row, order: p.orders, company, total: totalOf(data.lines), currency: data.currency, schedule: withAmounts(data.schedule, totalOf(data.lines)), message: s(req.body.message, 1500), url: `${appUrl()}/portal/orders/${p.orders.id}` }),
      attachments: [{ filename: `${p.pi_no}.pdf`, content: pdf.toString('base64') }] });
  } catch (e) { await admin.from('proforma_invoices').update({ data }).eq('id', p.id); return back(res, `/admin/pi/${p.id}`, { err: `Email failed: ${e.message}` }); }
  try {
    await uploadDocument({ file: { originalname: `${p.pi_no}.pdf`, mimetype: 'application/pdf', buffer: pdf, size: pdf.length }, entityType: 'order', entityId: p.orders.id, kind: 'proforma_invoice', title: `Proforma invoice ${p.pi_no}`, clientVisible: true, uploadedBy: req.user.id });
  } catch (e) { console.error(`[pi] store pdf: ${e.message}`); }
  await admin.from('proforma_invoices').update({ data, status: 'sent', sent_at: sentAt, sent_by: req.user.id, updated_at: sentAt }).eq('id', p.id);
  // the order now carries what the client has to pay, and when
  const total = totalOf(data.lines), schedule = withAmounts(data.schedule, total);
  await admin.from('orders').update({ amount_due: total, payment_schedule: schedule }).eq('id', p.orders.id);
  await recalcOrder(p.orders.id);
  await log({ entityType: 'order', entityId: p.orders.id, action: 'proforma_sent', actorId: req.user.id, clientVisible: true, detail: { note: `${p.pi_no} → ${to.join(', ')}` } });
  back(res, `/admin/pi/${p.id}`, { msg: `Proforma invoice sent to ${to.join(', ')} and saved in the order's documents.` });
});
