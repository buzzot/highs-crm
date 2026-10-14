import { Router } from '../../lib/router.js';
import { admin } from '../../lib/supabase.js';
import { log } from '../../lib/activity.js';
import { clean, bool, back, notFound, ORDER_STATUSES, CURRENCIES } from '../../lib/util.js';
import { landed } from '../../lib/landed.js';
import multer from 'multer';
import { readXlsx, workbookToText } from '../../lib/xlsx-read.js';
import { readCsv } from './imports.js';
import { normalizeRows, rowsFromSheet, totals as packTotals, packingText, packingSheet } from '../../lib/packing.js';
import { rfqWorkbook } from '../../lib/quote-form.js';
import { extractPacking, aiEnabled } from '../../lib/ai.js';
import { uploadDocument } from '../../lib/storage.js';
import { sendEmail } from '../../lib/mailer.js';
import { rfqEmail } from '../../lib/email-templates.js';
import { replyAddress, subjectTag } from '../../lib/freight.js';

const packUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const IMG = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const PACK_INFO = ['mode', 'pol', 'pod', 'incoterm', 'ready_date', 'marks', 'remarks'];
const MODES = ['Sea FCL', 'Sea LCL', 'Air', 'Express', 'Rail', 'Truck'];

const r = Router();
const like = q => String(q || '').replace(/[,()%]/g, ' ').trim();
const r2 = x => Math.round(Number(x || 0) * 100) / 100;

async function recalc(orderId) {
  const { data: items } = await admin.from('order_items').select('quantity, unit_price, unit_cost').eq('order_id', orderId);
  const subtotal = (items || []).reduce((s, i) => s + i.quantity * Number(i.unit_price || 0), 0);
  const cost = (items || []).reduce((s, i) => s + i.quantity * Number(i.unit_cost || 0), 0);
  await admin.from('orders').update({ subtotal: r2(subtotal), cost_total: r2(cost) }).eq('id', orderId);
}

r.get('/', async (req, res) => {
  let q = admin.from('order_overview').select('*').order('created_at', { ascending: false });
  const status = req.query.status || 'open';
  if (status === 'open') q = q.not('status', 'in', '("delivered","closed","cancelled")');
  else if (status !== 'all') q = q.eq('status', status);
  if (req.query.client) q = q.eq('org_id', req.query.client);
  const s = like(req.query.q);
  if (s) q = q.or(`order_no.ilike.%${s}%,client_name.ilike.%${s}%,supplier_name.ilike.%${s}%`);
  const [{ data }, { data: all }, { data: clients }] = await Promise.all([
    q, admin.from('orders').select('status'), admin.from('organizations').select('id, name').order('name'),
  ]);
  const byStatus = {};
  (all || []).forEach(o => { byStatus[o.status] = (byStatus[o.status] || 0) + 1; });
  res.render('admin/orders/index', { title: 'Orders', orders: data || [], byStatus, statuses: ORDER_STATUSES, status, clients: clients || [] });
});

r.get('/new', async (req, res) => {
  const [{ data: clients }, { data: suppliers }] = await Promise.all([
    admin.from('organizations').select('id, name, default_currency').eq('active', true).order('name'),
    admin.from('suppliers').select('id, name').order('name'),
  ]);
  res.render('admin/orders/new', { title: 'New order', clients: clients || [], suppliers: suppliers || [], currencies: CURRENCIES, org: req.query.org_id || '' });
});
r.post('/', async (req, res) => {
  const b = clean(req.body, ['org_id', 'supplier_id', 'currency', 'expected_ship_date', 'client_notes', 'internal_notes']);
  const { data, error } = await admin.from('orders').insert(b).select('id').single();
  if (error) return back(res, '/admin/orders/new', { err: error.message });
  await log({ entityType: 'order', entityId: data.id, action: 'order_confirmed', actorId: req.user.id, clientVisible: true });
  res.redirect(`/admin/orders/${data.id}`);
});

r.get('/:id', async (req, res) => {
  const id = req.params.id;
  const [{ data: order }, { data: items }, { data: shipments }, { data: packing }, { data: events }, { data: suppliers }, { data: products }] = await Promise.all([
    admin.from('order_overview').select('*').eq('id', id).single(),
    admin.from('order_items').select('*, products(id, name, sku)').eq('order_id', id),
    admin.from('shipments').select('*, forwarders(name), freight_costs(amount, fx_to_order)').eq('order_id', id).order('created_at'),
    admin.from('packing_lists').select('*').eq('order_id', id).order('carton_no'),
    admin.from('activity_log').select('*, profiles(full_name, email)').eq('entity_type', 'order').eq('entity_id', id).order('created_at', { ascending: false }),
    admin.from('suppliers').select('id, name').order('name'),
    admin.from('products').select('id, name, sku, hs_code').order('name'),
  ]);
  if (!order) return notFound(res, 'Order');
  const shipIds = (shipments || []).map(s => s.id);
  const { data: docs } = await admin.from('documents').select('*')
    .or(`and(entity_type.eq.order,entity_id.eq.${id})${shipIds.length ? `,and(entity_type.eq.shipment,entity_id.in.(${shipIds.join(',')}))` : ''}`)
    .order('created_at', { ascending: false });
  res.render('admin/orders/detail', {
    title: order.order_no, order, items: items || [], shipments: shipments || [], packing: packing || [], events: events || [],
    docs: docs || [], suppliers: suppliers || [], products: products || [], statuses: ORDER_STATUSES,
    land: landed(order, items), msg: req.query.msg, err: req.query.err,
  });
});

// status change with optional client-visible note
r.post('/:id/status', async (req, res) => {
  const id = req.params.id;
  const { data: o } = await admin.from('orders').select('status').eq('id', id).single();
  if (!o) return notFound(res, 'Order');
  const to = ORDER_STATUSES.includes(req.body.status) ? req.body.status : o.status;
  if (to !== o.status) await admin.from('orders').update({ status: to }).eq('id', id);
  if (to !== o.status || req.body.note) {
    await log({
      entityType: 'order', entityId: id, action: to !== o.status ? `status_${to}` : 'note', actorId: req.user.id,
      clientVisible: bool(req.body.client_visible), detail: { from: o.status, to, note: req.body.note || undefined },
    });
  }
  back(res, `/admin/orders/${id}`, { msg: 'Status updated.' });
});

r.post('/:id', async (req, res) => {
  const b = clean(req.body, ['supplier_id', 'expected_ship_date', 'client_notes', 'internal_notes', 'currency']);
  const { error } = await admin.from('orders').update(b).eq('id', req.params.id);
  back(res, `/admin/orders/${req.params.id}`, error ? { err: error.message } : { msg: 'Saved.' });
});

// ---- items ----
r.post('/:id/items', async (req, res) => {
  const b = clean(req.body, ['product_id', 'description', 'quantity', 'unit_cost', 'unit_price', 'hs_code']);
  if (b.product_id && !b.description) {
    const { data: p } = await admin.from('products').select('name, hs_code').eq('id', b.product_id).single();
    b.description = p?.name; b.hs_code ||= p?.hs_code;
  }
  const { error } = await admin.from('order_items').insert({ ...b, order_id: req.params.id });
  if (!error) await recalc(req.params.id);
  back(res, `/admin/orders/${req.params.id}`, error ? { err: error.message } : { msg: 'Item added.' });
});
r.post('/:id/items/:iid/delete', async (req, res) => {
  await admin.from('order_items').delete().eq('id', req.params.iid).eq('order_id', req.params.id);
  await recalc(req.params.id);
  back(res, `/admin/orders/${req.params.id}`, { msg: 'Item removed.' });
});

// ---- packing list ----
// manual add: N identical cartons become one line "first-last"
r.post('/:id/packing', async (req, res) => {
  const b = clean(req.body, ['carton_no', 'product_id', 'description', 'sku', 'quantity', 'length_cm', 'width_cm', 'height_cm', 'gross_weight_kg', 'net_weight_kg']);
  const copies = Math.min(Math.max(parseInt(req.body.copies || '1', 10) || 1, 1), 5000);
  const start = parseInt(b.carton_no, 10);
  const row = { ...b, order_id: req.params.id, cartons: copies, carton_no: copies > 1 && Number.isFinite(start) ? `${start}-${start + copies - 1}` : b.carton_no };
  const { data: last } = await admin.from('packing_lists').select('position').eq('order_id', req.params.id).order('position', { ascending: false }).limit(1).maybeSingle();
  row.position = (last?.position ?? -1) + 1;
  const { error } = await admin.from('packing_lists').insert(row);
  back(res, `/admin/orders/${req.params.id}#packing`, error ? { err: error.message } : { msg: `${copies} carton(s) added.` });
});
r.post('/:id/packing/:pid/delete', async (req, res) => {
  await admin.from('packing_lists').delete().eq('id', req.params.pid).eq('order_id', req.params.id);
  back(res, `/admin/orders/${req.params.id}#packing`);
});
r.post('/:id/packing-clear', async (req, res) => {
  await admin.from('packing_lists').delete().eq('order_id', req.params.id);
  back(res, `/admin/orders/${req.params.id}#packing`, { msg: 'Packing list cleared.' });
});

// upload Excel / CSV / PDF / screenshot → read it (column headers first, AI otherwise) → review page
r.post('/:id/packing/import', packUpload.single('file'), async (req, res) => {
  const id = req.params.id;
  const { data: order } = await admin.from('orders').select('id, order_no, packing_info').eq('id', id).single();
  if (!order) return notFound(res, 'Order');
  const f = req.file;
  if (!f) return back(res, `/admin/orders/${id}#packing`, { err: 'Choose or drop a packing list file.' });
  const ext = (f.originalname.split('.').pop() || '').toLowerCase();
  let rows = null, method = 'columns', notes = [], usage = null, marks = null;
  try {
    if (['xlsx', 'xlsm', 'csv', 'txt'].includes(ext)) {
      const wb = ext === 'csv' || ext === 'txt' ? readCsv(f.buffer.toString('utf8').replace(/^﻿/, '')) : readXlsx(f.buffer);
      for (const sh of wb.sheets) { rows = rowsFromSheet(sh.rows); if (rows) break; }
      if (!rows) {
        if (!aiEnabled()) throw new Error('This layout was not recognised and AI is not configured (ANTHROPIC_API_KEY). Use columns like CTN NO · DESCRIPTION · QTY/CTN · CTNS · MEAS · G.W.');
        method = 'ai';
        const ai = await extractPacking({ text: workbookToText(wb), filename: f.originalname }, { type: 'order', id });
        rows = normalizeRows(ai.lines); usage = ai.usage; marks = ai.marks; if (ai.notes) notes.push(ai.notes);
      }
    } else if (ext === 'pdf' || IMG[ext]) {
      if (!aiEnabled()) throw new Error('Reading PDFs and screenshots needs AI — set ANTHROPIC_API_KEY, or upload the Excel file.');
      method = 'ai';
      const ai = await extractPacking(ext === 'pdf' ? { pdf: f.buffer, filename: f.originalname } : { image: { data: f.buffer, mediaType: IMG[ext] }, filename: f.originalname }, { type: 'order', id });
      rows = normalizeRows(ai.lines); usage = ai.usage; marks = ai.marks; if (ai.notes) notes.push(ai.notes);
    } else if (ext === 'xls') {
      throw new Error('Old .xls format — open it in Excel/WPS and "Save as" .xlsx, or upload a PDF / screenshot.');
    } else throw new Error(`Unsupported file type .${ext}. Use Excel, CSV, PDF or a screenshot.`);
  } catch (e) {
    console.error('[packing import]', e.message);
    return back(res, `/admin/orders/${id}#packing`, { err: e.message });
  }
  if (!rows?.length) return back(res, `/admin/orders/${id}#packing`, { err: 'No packing lines found in this file.' });
  // keep the original on the order (internal)
  let source = null;
  try { source = await uploadDocument({ file: f, entityType: 'order', entityId: id, kind: 'packing_list', title: `Supplier packing list — ${f.originalname}`, clientVisible: false, uploadedBy: req.user.id }); } catch (e) { notes.push(`Original not stored: ${e.message}`); }
  const { count } = await admin.from('packing_lists').select('id', { count: 'exact', head: true }).eq('order_id', id);
  res.render('admin/orders/packing_review', {
    title: `Packing list · ${order.order_no}`, order, rows, t: packTotals(rows), method, notes, usage, marks, existing: count || 0, source, file: f.originalname,
  });
});

r.post('/:id/packing/confirm', async (req, res) => {
  const id = req.params.id;
  const raw = req.body.rows ? (Array.isArray(req.body.rows) ? req.body.rows : Object.values(req.body.rows)) : [];
  const rows = normalizeRows(raw.filter(x => x && x.keep !== 'off'));
  if (!rows.length) return back(res, `/admin/orders/${id}#packing`, { err: 'No lines to save.' });
  let start = 0;
  if (req.body.mode === 'replace') await admin.from('packing_lists').delete().eq('order_id', id);
  else {
    const { data: last } = await admin.from('packing_lists').select('position').eq('order_id', id).order('position', { ascending: false }).limit(1).maybeSingle();
    start = (last?.position ?? -1) + 1;
  }
  const { error } = await admin.from('packing_lists').insert(rows.map((x, i) => ({ ...x, order_id: id, position: start + i })));
  if (error) return back(res, `/admin/orders/${id}#packing`, { err: error.message });
  if (req.body.marks) {
    const { data: o } = await admin.from('orders').select('packing_info').eq('id', id).single();
    if (!o?.packing_info?.marks) await admin.from('orders').update({ packing_info: { ...(o?.packing_info || {}), marks: String(req.body.marks).slice(0, 500) } }).eq('id', id);
  }
  await log({ entityType: 'order', entityId: id, action: 'packing_list_imported', actorId: req.user.id, detail: { note: `${rows.length} lines · ${packTotals(rows).cartons} cartons` } });
  res.redirect(`/admin/orders/${id}/packing-list?msg=` + encodeURIComponent(`Packing list saved: ${rows.length} lines, ${packTotals(rows).cartons} cartons.`));
});

async function packingData(id) {
  // packing_info lives on orders (the order_overview view predates that column)
  const [{ data: order }, { data: rows }, { data: o }] = await Promise.all([
    admin.from('order_overview').select('*').eq('id', id).single(),
    admin.from('packing_lists').select('*').eq('order_id', id).order('position').order('carton_no'),
    admin.from('orders').select('packing_info').eq('id', id).maybeSingle(),
  ]);
  return { order, rows: rows || [], t: packTotals(rows || []), info: o?.packing_info || order?.packing_info || {} };
}

// standard packing list: print / PDF, Excel, send to forwarders
r.get('/:id/packing-list', async (req, res) => {
  const { order, rows, t, info } = await packingData(req.params.id);
  if (!order) return notFound(res, 'Order');
  const [{ data: forwarders }, { data: rfqs }] = await Promise.all([
    admin.from('forwarders').select('*').order('name'),
    admin.from('freight_rfqs').select('*, forwarders(name), freight_requests!freight_rfqs_request_id_fkey(id, ref)').eq('order_id', order.id).order('sent_at', { ascending: false }),
  ]);
  res.render('admin/orders/packing_list', {
    title: `Packing list · ${order.order_no}`, order, rows, t, info, modes: MODES, forwarders: forwarders || [], rfqs: rfqs || [],
    wechatText: packingText({ order, info, rows, t }), msg: req.query.msg, err: req.query.err,
  });
});

r.get('/:id/packing-list.xlsx', async (req, res) => {
  const { order, rows, t, info } = await packingData(req.params.id);
  if (!order) return notFound(res, 'Order');
  const buf = rfqWorkbook({ order, info, rows, t });
  res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="packing-list-${order.order_no}.xlsx"` });
  res.send(buf);
});

r.post('/:id/packing-info', async (req, res) => {
  const info = Object.fromEntries(PACK_INFO.map(k => [k, String(req.body[k] || '').trim().slice(0, 500) || null]).filter(([, v]) => v));
  const { error } = await admin.from('orders').update({ packing_info: info }).eq('id', req.params.id);
  back(res, `/admin/orders/${req.params.id}/packing-list`, error ? { err: error.message } : { msg: 'Shipment details saved.' });
});

// email the packing list (Excel attached) to the chosen forwarders and record the quote requests
r.post('/:id/packing-list/send', async (req, res) => {
  const id = req.params.id;
  const { order, rows, t, info } = await packingData(id);
  if (!order) return notFound(res, 'Order');
  if (!rows.length) return back(res, `/admin/orders/${id}/packing-list`, { err: 'The packing list is empty.' });
  const ids = [].concat(req.body.forwarder_ids || []).filter(Boolean);
  const { data: fws } = ids.length ? await admin.from('forwarders').select('*').in('id', ids) : { data: [] };
  const extra = String(req.body.extra_emails || '').split(/[\s,;]+/).map(x => x.trim().toLowerCase()).filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
  const targets = [...(fws || []).filter(f => f.email).map(f => ({ fw: f, email: f.email })), ...extra.map(email => ({ fw: null, email }))];
  if (!targets.length) return back(res, `/admin/orders/${id}/packing-list`, { err: 'Choose a forwarder with an email address, or type an email.' });
  const message = String(req.body.message || '').trim().slice(0, 3000);
  const { data: fr, error: frErr } = await admin.from('freight_requests').insert({
    order_id: id, info, totals: { cartons: t.cartons, pieces: t.pieces, gross_kg: t.gross, cbm: t.cbm }, message: message || null, created_by: req.user.id,
  }).select('*').single();
  if (frErr) return back(res, `/admin/orders/${id}/packing-list`, { err: /freight_requests/.test(frErr.message) ? 'Run supabase/migrations/0014_packing_rfq.sql first.' : frErr.message });
  const sent = [], failed = [];
  for (const tg of targets) {
    const { data: rfq, error: rErr } = await admin.from('freight_rfqs').insert({ request_id: fr.id, order_id: id, forwarder_id: tg.fw?.id || null, sent_to: tg.email, channel: 'email', message: message || null, sent_by: req.user.id }).select('*').single();
    if (rErr) { failed.push(`${tg.email}: ${rErr.message}`); continue; }
    try {
      const m = rfqEmail({ order, info, rows, t, message, senderName: req.user.full_name, forwarderName: tg.fw?.contact_name || tg.fw?.name });
      await sendEmail({ to: tg.email, ...m, subject: `${m.subject} ${subjectTag(fr.ref, rfq.token)}`, replyTo: replyAddress(rfq.token, req.user.email),
        attachments: [{ filename: `${fr.ref}-quotation-packing-list-${order.order_no}.xlsx`, content: rfqWorkbook({ order, info, rows, t, ref: fr.ref, token: rfq.token }) }] });
      sent.push(tg.fw?.name || tg.email);
    } catch (e) {
      await admin.from('freight_rfqs').delete().eq('id', rfq.id);
      failed.push(`${tg.fw?.name || tg.email}: ${e.message}`);
    }
  }
  if (!sent.length) await admin.from('freight_requests').delete().eq('id', fr.id);
  else await log({ entityType: 'order', entityId: id, action: 'freight_quote_requested', actorId: req.user.id, detail: { note: `${fr.ref} → ${sent.join(', ')}` } });
  if (sent.length && !failed.length) return res.redirect(`/admin/logistics/quotes/${fr.id}?msg=` + encodeURIComponent(`${fr.ref} sent to ${sent.join(', ')}.`));
  back(res, `/admin/orders/${id}/packing-list`, { err: `${sent.length ? `${fr.ref} sent to ${sent.join(', ')}. ` : ''}Failed: ${failed.join(' · ')}` });
});

// WeChat is sent by hand — this records it as a quote request so the answer can be added later
r.post('/:id/packing-list/wechat', async (req, res) => {
  const id = req.params.id;
  const { order, t, info } = await packingData(id);
  if (!order) return notFound(res, 'Order');
  const { data: fr, error } = await admin.from('freight_requests').insert({ order_id: id, info, totals: { cartons: t.cartons, pieces: t.pieces, gross_kg: t.gross, cbm: t.cbm }, message: 'Sent by WeChat', created_by: req.user.id }).select('*').single();
  if (error) return back(res, `/admin/orders/${id}/packing-list`, { err: error.message });
  await admin.from('freight_rfqs').insert({ request_id: fr.id, order_id: id, forwarder_id: req.body.forwarder_id || null, channel: 'wechat', sent_by: req.user.id, sent_to: 'WeChat' });
  await log({ entityType: 'order', entityId: id, action: 'freight_quote_requested', actorId: req.user.id, detail: { note: `${fr.ref} by WeChat` } });
  res.redirect(`/admin/logistics/quotes/${fr.id}?msg=` + encodeURIComponent(`${fr.ref} recorded as sent by WeChat — paste the reply here when it comes.`));
});

// record the forwarder's answer
r.post('/:id/rfq/:rid', async (req, res) => {
  const status = ['sent', 'quoted', 'declined', 'accepted'].includes(req.body.status) ? req.body.status : 'quoted';
  const amount = Number(req.body.quote_amount);
  await admin.from('freight_rfqs').update({
    status, quote_amount: Number.isFinite(amount) && req.body.quote_amount !== '' ? amount : null, quote_currency: req.body.quote_currency || 'USD',
    quote_notes: String(req.body.quote_notes || '').trim() || null, quoted_at: new Date().toISOString(),
  }).eq('id', req.params.rid).eq('order_id', req.params.id);
  back(res, `/admin/orders/${req.params.id}/packing-list#quotes`, { msg: 'Quote saved.' });
});

export default r;
