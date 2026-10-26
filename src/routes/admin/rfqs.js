// RFQs: one request for quotation sent to several suppliers; their answers are compared inside it.
import multer from '../../lib/multer-utf8.js';
import { Router } from '../../lib/router.js';
import { admin } from '../../lib/supabase.js';
import { sendEmail } from '../../lib/mailer.js';
import { log } from '../../lib/activity.js';
import { replyAddress, subjectTag } from '../../lib/freight.js';
import { uploadDocument, downloadDocument, deleteDocument } from '../../lib/storage.js';
import { aiEnabled, reviewRfqFiles } from '../../lib/ai.js';
import { addUsage } from '../../lib/ai-usage.js';
import { CHECKABLE, isImage, toReview, unchecked, cleanReview, MAX_FILES, reviewTotals, sendWarning } from '../../lib/rfq-files.js';
import { back, notFound, getSettings, INCOTERMS } from '../../lib/util.js';
import { answerUpload, uploadAnswerFiles } from '../../lib/rfq-answer-files.js';
import { FREIGHT_MODES, cleanInfo, emailsIn, emailFreightRequest, recordWechatRequest } from '../../lib/freight-from-rfq.js';
import { factoryPlace, draftPacking, draftPackingText, draftPackingWorkbook } from '../../lib/rfq-packing.js';
import { withQuantities, keptFiles, placeFiles, cleanItems, cleanResponse, compare, currentResponses, rfqSupplierEmail, RFQ_STATUS_LABEL, RS_LABEL, RFQ_CURRENCIES } from '../../lib/rfq.js';

const r = Router();
const filesUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: MAX_FILES } });
const MIGRATION_FILES = 'Run supabase/migrations/0033_rfq_files.sql in Supabase first (it adds the file columns), then reload the schema cache.';
const isId = v => /^[0-9a-f-]{36}$/i.test(v || '');
const appUrl = () => (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
const MIGRATION = 'Run supabase/migrations/0029_rfqs.sql in Supabase first, then reload the schema cache.';
const missingTable = e => /rfqs|rfq_suppliers|rfq_responses/.test(e?.message || '');
const ids = v => [].concat(v || []).filter(isId);

// AI check over a list of { key, name, mime, buffer } → { map: key → review, usage }. Never throws: a failure leaves the file "not checked".
async function reviewMany(list, entity = null) {
  const map = {}, ready = [];
  for (const f of list) {
    if (!CHECKABLE(f.mime, f.name)) map[f.key] = unchecked('Only photos and PDFs can be checked automatically — open the file and look yourself.');
    else if (f.buffer.length > 20 * 1024 * 1024) map[f.key] = unchecked('Too large for the AI check.');
    else ready.push(f);
  }
  let usage = null;
  if (ready.length && !aiEnabled()) ready.forEach(f => { map[f.key] = unchecked('AI is not switched on — open the file and look yourself.'); });
  else {
    for (let i = 0; i < ready.length; i += 6) {
      const part = ready.slice(i, i + 6);
      try {
        const out = await reviewRfqFiles(part.map(f => (isImage(f.mime) ? { name: f.name, image: { data: f.buffer, mediaType: f.mime.replace('image/jpg', 'image/jpeg') } } : { name: f.name, pdf: f.buffer })), entity);
        usage = addUsage(usage, out.usage);
        part.forEach((f, j) => { map[f.key] = out.results[j] ? toReview(out.results[j]) : unchecked('The AI gave no answer for this file.'); });
      } catch (e) { part.forEach(f => { map[f.key] = unchecked('AI check failed: ' + e.message); }); }
    }
  }
  return { map, usage };
}
const parseJson = v => { try { const x = JSON.parse(v || '{}'); return x && typeof x === 'object' ? x : {}; } catch { return {}; } };

r.get('/', async (req, res) => {
  const status = ['draft', 'open', 'closed'].includes(req.query.status) ? req.query.status : '';
  let q = admin.from('rfqs').select('id, ref, title, status, deadline, currency, items, created_at, requests(ref), rfq_suppliers(id, status)').order('created_at', { ascending: false }).limit(200);
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  res.render('admin/rfqs/index', { title: 'RFQs', rfqs: data || [], status, labels: RFQ_STATUS_LABEL, error: error ? (missingTable(error) ? MIGRATION : error.message) : null, msg: req.query.msg });
});

r.get('/new', async (req, res) => {
  const [{ data: suppliers }, reqRes] = await Promise.all([
    admin.from('suppliers').select('id, name, email, contact_name, city').order('name'),
    isId(req.query.request) ? Promise.all([
      admin.from('requests').select('id, ref, title, description, quantity, target_currency').eq('id', req.query.request).maybeSingle(),
      admin.from('request_items').select('id, name, sku, description, quantity, unit, spec').eq('request_id', req.query.request).order('position'),
    ]) : [{ data: null }, { data: [] }],
  ]);
  const request = reqRes[0]?.data || null;
  let items = (reqRes[1]?.data || []).map(i => ({ id: '', description: i.name, sku: i.sku || '', quantity: i.quantity, unit: i.unit, notes: i.description || '', spec: i.spec || {}, request_item_id: i.id }));
  if (request && !items.length) items = [{ id: '', description: request.title, sku: '', quantity: request.quantity, unit: 'pcs', notes: request.description || '', request_item_id: null }];
  if (!items.length) items = [{ id: '', description: '', sku: '', quantity: null, unit: 'pcs', notes: '' }];
  const { data: clientDocs } = request ? await admin.from('documents').select('id, title, mime_type, size_bytes').eq('entity_type', 'request').eq('entity_id', request.id).is('revision_id', null).order('created_at') : { data: [] };
  res.render('admin/rfqs/new', { title: 'New RFQ', suppliers: suppliers || [], request, items, currencies: RFQ_CURRENCIES, clientDocs: clientDocs || [], aiOn: aiEnabled(), error: req.query.err || null });
});

// AI check of files before the RFQ exists: the chosen client documents + files dropped on the form. Nothing is saved here.
r.post('/review', filesUpload.array('files', MAX_FILES), async (req, res) => {
  try {
    const list = [];
    const picked = ids(req.body.doc_ids).slice(0, MAX_FILES);
    if (picked.length) {
      const { data: ds } = await admin.from('documents').select('id, title, mime_type, storage_path').in('id', picked);
      for (const d of ds || []) list.push({ key: 'doc:' + d.id, name: d.title || 'file', mime: d.mime_type || '', buffer: await downloadDocument(d.storage_path) });
    }
    for (const f of req.files || []) list.push({ key: `new:${f.originalname}|${f.size}`, name: f.originalname, mime: f.mimetype, buffer: f.buffer });
    if (!list.length) return res.json({ results: {}, names: {} });
    const { map, usage } = await reviewMany(list);
    res.json({ results: map, names: Object.fromEntries(list.map(f => [f.key, f.name])), usage: usage ? res.locals.aiLine(usage) : '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

r.post('/new', filesUpload.array('files', MAX_FILES), async (req, res) => {
  const b = req.body, to = '/admin/rfqs/new' + (isId(b.request_id) ? '?request=' + b.request_id + '&' : '?');
  const items = cleanItems(b), sup = ids(b.supplier_ids);
  const title = String(b.title || '').trim().slice(0, 200);
  if (!title) return back(res, to.slice(0, -1), { err: 'Give the RFQ a title.' });
  if (!items.length) return back(res, to.slice(0, -1), { err: 'Add at least one product.' });
  if (!sup.length) return back(res, to.slice(0, -1), { err: 'Choose at least one supplier.' });
  const { data: rfq, error } = await admin.from('rfqs').insert({ title, request_id: isId(b.request_id) ? b.request_id : null, currency: RFQ_CURRENCIES.includes(b.currency) ? b.currency : 'USD',
    deadline: /^\d{4}-\d{2}-\d{2}$/.test(b.deadline || '') ? b.deadline : null, message: String(b.message || '').trim().slice(0, 3000) || null, items, created_by: req.user.id }).select('id, ref').single();
  if (error) return back(res, to.slice(0, -1), { err: missingTable(error) ? MIGRATION : error.message });
  // files: the client documents ticked on the form + anything dropped there
  const fileIds = [], fileReview = {}, review = parseJson(b.review_json);
  let fileErr = null;
  const picked = ids(b.doc_ids);
  if (picked.length && isId(b.request_id)) {
    const { data: ds } = await admin.from('documents').select('id, entity_type, entity_id').in('id', picked);
    for (const d of ds || []) if (d.entity_type === 'request' && d.entity_id === b.request_id) { fileIds.push(d.id); fileReview[d.id] = review['doc:' + d.id] ? cleanReview(review['doc:' + d.id]) : unchecked('Not checked yet.'); }
  }
  for (const file of req.files || []) {
    try {
      const doc = await uploadDocument({ file, entityType: 'rfq', entityId: rfq.id, kind: 'other', title: file.originalname, clientVisible: false, uploadedBy: req.user.id });
      fileIds.push(doc.id); const k = `new:${file.originalname}|${file.size}`;
      fileReview[doc.id] = review[k] ? cleanReview(review[k]) : unchecked('Not checked yet.');
    } catch (e) { fileErr = /entity_type/.test(e.message) ? MIGRATION_FILES : `${file.originalname}: ${e.message}`; }
  }
  if (fileIds.length) { const { error: fe } = await admin.from('rfqs').update({ file_ids: fileIds, file_review: fileReview }).eq('id', rfq.id); if (fe) fileErr = /file_ids|file_review/.test(fe.message) ? MIGRATION_FILES : fe.message; }
  await admin.from('rfq_suppliers').insert(sup.map(supplier_id => ({ rfq_id: rfq.id, supplier_id, sent_to: String(b['email_' + supplier_id] || '').trim().slice(0, 300) || null })));
  await log({ entityType: isId(b.request_id) ? 'request' : 'supplier', entityId: isId(b.request_id) ? b.request_id : sup[0], action: 'rfq_created', actorId: req.user.id, detail: { note: `${rfq.ref} → ${sup.length} supplier(s)` } });
  res.redirect(`/admin/rfqs/${rfq.id}?msg=${encodeURIComponent('RFQ created. Check it, then send it to the suppliers.')}${fileErr ? '&err=' + encodeURIComponent('Files not attached: ' + fileErr) : ''}`);
});

async function load(id) {
  if (!isId(id)) return null;
  const { data: rfq } = await admin.from('rfqs').select('*, requests(id, ref, title)').eq('id', id).maybeSingle();
  if (!rfq) return null;
  const [{ data: rs }, { data: responses }] = await Promise.all([
    admin.from('rfq_suppliers').select('*, suppliers(id, name, email, contact_name, city, country)').eq('rfq_id', id).order('created_at'),
    admin.from('rfq_responses').select('*').eq('rfq_id', id).order('created_at', { ascending: false }),
  ]);
  return { rfq, rs: rs || [], responses: responses || [] };
}

r.get('/:id', async (req, res) => {
  const x = await load(req.params.id);
  if (!x) return notFound(res, 'RFQ');
  const [settings, { data: all }] = await Promise.all([getSettings(admin), admin.from('suppliers').select('id, name').order('name')]);
  const fileIds = [...new Set(x.responses.flatMap(p => [...(p.file_ids || []), ...(p.lines || []).flatMap(l => l.file_ids || [])]))];
  const { data: docs } = fileIds.length ? await admin.from('documents').select('id, title, mime_type').in('id', fileIds) : { data: [] };
  const invited = new Set(x.rs.map(s => s.supplier_id));
  const fids = x.rfq.file_ids || [];
  const { data: fdocs } = fids.length ? await admin.from('documents').select('id, title, mime_type, size_bytes, entity_type').in('id', fids) : { data: [] };
  const fileDocs = fids.map(id => (fdocs || []).find(d => d.id === id)).filter(Boolean);
  res.render('admin/rfqs/detail', { fileDocs, fileReview: x.rfq.file_review || {}, sendWarn: sendWarning(reviewTotals(fids, x.rfq.file_review || {})), aiOn: aiEnabled(), maxFiles: MAX_FILES, title: x.rfq.ref, ...x, current: currentResponses(x.responses), cmp: compare({ items: x.rfq.items, suppliers: x.rs, responses: x.responses, currency: x.rfq.currency, settings }),
    docs: docs || [], addable: (all || []).filter(s => !invited.has(s.id)), labels: RFQ_STATUS_LABEL, rsLabels: RS_LABEL, currencies: RFQ_CURRENCIES, incoterms: INCOTERMS, msg: req.query.msg, err: req.query.err });
});

// draft packing list from a supplier's answer (no order needed): packages, weight and volume for freight calculations
async function packingOf(req) {
  const x = await load(req.params.id);
  const s = x?.rs.find(v => v.id === req.params.rs);
  if (!s) return null;
  const resp = currentResponses(x.responses)[s.id];
  return { x, s, resp: resp && resp.status === 'confirmed' ? resp : null };
}
r.get('/:id/packing/:rs', async (req, res) => {
  const p = await packingOf(req);
  if (!p) return notFound(res, 'RFQ');
  if (!p.resp) return back(res, `/admin/rfqs/${p.x.rfq.id}`, { err: 'This supplier has not sent prices yet.' });
  const d = draftPacking({ rfq: p.x.rfq, resp: p.resp });
  const [{ data: forwarders }, sent] = await Promise.all([
    admin.from('forwarders').select('*').order('name'),
    admin.from('freight_requests').select('id, ref, created_at, info, freight_rfqs!freight_rfqs_request_id_fkey(id, status, quote_amount, quote_currency, sent_to, forwarders(name))').eq('rfq_id', p.x.rfq.id).order('created_at', { ascending: false }),
  ]);
  res.render('admin/rfqs/packing', { title: `Draft packing · ${p.x.rfq.ref}`, rfq: p.x.rfq, s: p.s, resp: p.resp, d, origin: factoryPlace(p.s.suppliers), text: draftPackingText({ origin: factoryPlace(p.s.suppliers), d }),
    forwarders: forwarders || [], modes: FREIGHT_MODES, sentRequests: sent.error ? [] : sent.data || [], msg: req.query.msg, err: req.query.err });
});
// ask forwarders for a freight quote with this draft packing list
r.post('/:id/packing/:rs/send', async (req, res) => {
  const p = await packingOf(req);
  if (!p || !p.resp) return notFound(res, 'RFQ');
  const to = `/admin/rfqs/${p.x.rfq.id}/packing/${p.s.id}`;
  const d = draftPacking({ rfq: p.x.rfq, resp: p.resp });
  if (!d.rows.length) return back(res, to, { err: 'There is nothing to send yet — the draft packing list is empty.' });
  const ids = [].concat(req.body.forwarder_ids || []).filter(Boolean);
  const { data: fws } = ids.length ? await admin.from('forwarders').select('*').in('id', ids) : { data: [] };
  const targets = [...(fws || []).filter(f => f.email).map(f => ({ fw: f, email: f.email })), ...emailsIn(req.body.extra_emails).map(email => ({ fw: null, email }))];
  if (!targets.length) return back(res, to, { err: 'Choose a forwarder with an email address, or type an email.' });
  try {
    const { fr, sent, failed } = await emailFreightRequest({ rfq: p.x.rfq, supplierName: p.s.suppliers?.name, d, info: cleanInfo(req.body), targets, message: String(req.body.message || '').trim().slice(0, 3000), user: req.user });
    if (sent.length && !failed.length) return res.redirect(`/admin/logistics/quotes/${fr.id}?msg=` + encodeURIComponent(`${fr.ref} sent to ${sent.join(', ')}.`));
    back(res, to, { err: `${sent.length ? `${fr.ref} sent to ${sent.join(', ')}. ` : ''}Failed: ${failed.join(' · ')}` });
  } catch (e) { back(res, to, { err: e.message }); }
});
r.post('/:id/packing/:rs/wechat', async (req, res) => {
  const p = await packingOf(req);
  if (!p || !p.resp) return notFound(res, 'RFQ');
  const to = `/admin/rfqs/${p.x.rfq.id}/packing/${p.s.id}`;
  const d = draftPacking({ rfq: p.x.rfq, resp: p.resp });
  if (!d.rows.length) return back(res, to, { err: 'There is nothing to send yet — the draft packing list is empty.' });
  try {
    const fr = await recordWechatRequest({ rfq: p.x.rfq, supplierName: p.s.suppliers?.name, d, info: cleanInfo(req.body), forwarderId: req.body.forwarder_id || null, user: req.user });
    res.redirect(`/admin/logistics/quotes/${fr.id}?msg=` + encodeURIComponent(`${fr.ref} recorded as sent by WeChat — paste the reply here when it comes.`));
  } catch (e) { back(res, to, { err: e.message }); }
});
r.get('/:id/packing/:rs/xlsx', async (req, res) => {
  const p = await packingOf(req);
  if (!p || !p.resp) return notFound(res, 'RFQ');
  const d = draftPacking({ rfq: p.x.rfq, resp: p.resp });
  res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="draft-packing-${p.x.rfq.ref}.xlsx"` });
  res.send(draftPackingWorkbook({ rfq: p.x.rfq, d }));
});

r.post('/:id', async (req, res) => {
  const x = await load(req.params.id);
  if (!x) return notFound(res, 'RFQ');
  const b = req.body, to = `/admin/rfqs/${x.rfq.id}`;
  const patch = { title: String(b.title || '').trim().slice(0, 200) || x.rfq.title, message: String(b.message || '').trim().slice(0, 3000) || null,
    deadline: /^\d{4}-\d{2}-\d{2}$/.test(b.deadline || '') ? b.deadline : null, updated_at: new Date().toISOString() };
  if (x.rfq.status === 'draft') {
    const items = cleanItems(b);
    if (!items.length) return back(res, to, { err: 'Keep at least one product.' });
    patch.items = items; patch.currency = RFQ_CURRENCIES.includes(b.currency) ? b.currency : x.rfq.currency;
  } else {
    const items = withQuantities(x.rfq.items, b.item);   // sent RFQ: only quantity and unit can change, same product list
    if (JSON.stringify(items) !== JSON.stringify(x.rfq.items)) {
      patch.items = items;
      await log({ entityType: x.rfq.request_id ? 'request' : 'supplier', entityId: x.rfq.request_id || x.rs[0]?.supplier_id, action: 'rfq_quantity_changed', actorId: req.user.id, detail: { note: x.rfq.ref } }).catch(() => {});
    }
  }
  await admin.from('rfqs').update(patch).eq('id', x.rfq.id);
  back(res, to, { msg: 'Saved.' });
});

r.post('/:id/suppliers', async (req, res) => {
  const x = await load(req.params.id);
  if (!x) return notFound(res, 'RFQ');
  const to = `/admin/rfqs/${x.rfq.id}`;
  if (isId(req.body.remove)) {
    const s = x.rs.find(v => v.id === req.body.remove);
    if (s && s.status !== 'draft') return back(res, to, { err: 'This supplier was already sent the RFQ and cannot be removed.' });
    await admin.from('rfq_suppliers').delete().eq('id', req.body.remove).eq('rfq_id', x.rfq.id);
    return back(res, to, { msg: 'Supplier removed.' });
  }
  const add = ids(req.body.supplier_ids).filter(id => !x.rs.some(s => s.supplier_id === id));
  if (add.length) await admin.from('rfq_suppliers').insert(add.map(supplier_id => ({ rfq_id: x.rfq.id, supplier_id })));
  back(res, to, { msg: add.length ? `${add.length} supplier(s) added.` : 'Nothing to add.' });
});

// send the RFQ by email to every supplier that has not got it yet (or to one, to resend)
r.post('/:id/send', async (req, res) => {
  const x = await load(req.params.id);
  if (!x) return notFound(res, 'RFQ');
  const to = `/admin/rfqs/${x.rfq.id}`;
  if (x.rfq.status === 'closed') return back(res, to, { err: 'This RFQ is closed.' });
  const only = isId(req.body.rs) ? req.body.rs : null;
  const targets = x.rs.filter(s => (only ? s.id === only : s.status === 'draft'));
  if (!targets.length) return back(res, to, { err: 'Everyone has already been sent this RFQ.' });
  const sent = [], failed = [];
  // attached files: named in the email, and attached to it when they are small enough (everything is also in the supplier portal)
  const fids = x.rfq.file_ids || [];
  const { data: fdocs } = fids.length ? await admin.from('documents').select('id, title, storage_path, size_bytes').in('id', fids) : { data: [] };
  const fileList = fids.map(id => (fdocs || []).find(d => d.id === id)).filter(Boolean);
  const attachable = fileList.reduce((n, d) => n + (d.size_bytes || 0), 0) <= 10 * 1024 * 1024;
  let attachments = [];
  if (attachable) { try { attachments = await Promise.all(fileList.map(async d => ({ filename: d.title || 'file', content: await downloadDocument(d.storage_path) }))); } catch (e) { console.error(`[rfq] attachments: ${e.message}`); attachments = []; } }
  for (const s of targets) {
    const emails = String(req.body['to_' + s.id] || s.sent_to || s.suppliers?.email || '').split(/[,;\s]+/).filter(v => /@/.test(v));
    if (!emails.length) { failed.push(`${s.suppliers?.name}: no email address`); continue; }
    try {
      const m = rfqSupplierEmail({ rfq: x.rfq, supplier: s.suppliers, url: `${appUrl()}/supplier/rfqs/${s.id}`, message: x.rfq.message, senderName: req.user.full_name, files: fileList.map(d => d.title), attached: attachments.length > 0 });
      await sendEmail({ to: emails, ...m, subject: `${m.subject} ${subjectTag(x.rfq.ref, s.token)}`, replyTo: replyAddress(s.token, req.user.email), attachments });
      await admin.from('rfq_suppliers').update({ status: s.status === 'draft' ? 'sent' : s.status, sent_to: emails.join(', '), sent_at: new Date().toISOString() }).eq('id', s.id);
      sent.push(s.suppliers?.name);
    } catch (e) { failed.push(`${s.suppliers?.name}: ${e.message}`); }
  }
  if (sent.length && x.rfq.status === 'draft') await admin.from('rfqs').update({ status: 'open', updated_at: new Date().toISOString() }).eq('id', x.rfq.id);
  if (sent.length) await log({ entityType: x.rfq.request_id ? 'request' : 'supplier', entityId: x.rfq.request_id || x.rs[0].supplier_id, action: 'rfq_sent', actorId: req.user.id, detail: { note: `${x.rfq.ref} → ${sent.join(', ')}` } });
  back(res, to, { msg: sent.length ? `Sent to ${sent.join(', ')}.` : undefined, err: failed.length ? 'Not sent — ' + failed.join('; ') : undefined });
});

// staff enter an answer received outside the portal (WeChat, a phone call, a PDF)
r.post('/:id/answer/:rs', answerUpload(multer), async (req, res) => {
  const x = await load(req.params.id);
  const s = x?.rs.find(v => v.id === req.params.rs);
  if (!s) return notFound(res, 'RFQ');
  const to = `/admin/rfqs/${x.rfq.id}`;
  const declined = req.body.decline === '1';
  const parsed = cleanResponse(req.body, x.rfq.items, x.rfq.currency);
  if (!declined && parsed.problems.length) return back(res, to, { err: parsed.problems.join('; ') });
  const prev = currentResponses(x.responses)[s.id];
  const placed = placeFiles(declined ? [] : parsed.lines, x.rfq.items, keptFiles(prev, req.body.keep), await uploadAnswerFiles(req.files, { supplierId: s.supplier_id, userId: req.user.id, items: x.rfq.items }));
  await admin.from('rfq_responses').insert({ rfq_id: x.rfq.id, rfq_supplier_id: s.id, supplier_id: s.supplier_id, source: 'manual', status: declined ? 'declined' : 'confirmed',
    lines: placed.lines, terms: declined ? {} : parsed.terms, note: String(req.body.note || '').trim().slice(0, 2000) || null, file_ids: placed.file_ids, created_by: req.user.id });
  await admin.from('rfq_suppliers').update({ status: declined ? 'declined' : 'replied', replied_at: new Date().toISOString() }).eq('id', s.id);
  back(res, to, { msg: `Answer from ${s.suppliers?.name} saved.` });
});

// files for the suppliers of an existing RFQ: add more, remove, run the AI check
r.post('/:id/files', filesUpload.array('files', MAX_FILES), async (req, res) => {
  const x = await load(req.params.id);
  if (!x) return notFound(res, 'RFQ');
  const to = `/admin/rfqs/${x.rfq.id}`;
  if (x.rfq.status === 'closed') return back(res, to, { err: 'This RFQ is closed.' });
  const have = x.rfq.file_ids || [], rev = { ...(x.rfq.file_review || {}) }, next = [...have];
  const room = Math.max(0, MAX_FILES - have.length);
  if (!(req.files || []).length) return back(res, to, { err: 'Choose a file first.' });
  let err = (req.files || []).length > room ? `Only ${MAX_FILES} files fit on one RFQ.` : null;
  for (const file of (req.files || []).slice(0, room)) {
    try {
      const doc = await uploadDocument({ file, entityType: 'rfq', entityId: x.rfq.id, kind: 'other', title: file.originalname, clientVisible: false, uploadedBy: req.user.id });
      next.push(doc.id); rev[doc.id] = unchecked('Not checked yet.');
    } catch (e) { err = /entity_type/.test(e.message) ? MIGRATION_FILES : `${file.originalname}: ${e.message}`; }
  }
  const { error } = await admin.from('rfqs').update({ file_ids: next, file_review: rev, updated_at: new Date().toISOString() }).eq('id', x.rfq.id);
  if (error) return back(res, to, { err: /file_ids|file_review/.test(error.message) ? MIGRATION_FILES : error.message });
  back(res, to, { msg: next.length > have.length ? `${next.length - have.length} file(s) added. Run the AI check before you send.` : undefined, err });
});

r.post('/:id/files/remove', async (req, res) => {
  const x = await load(req.params.id);
  if (!x) return notFound(res, 'RFQ');
  const id = req.body.doc, have = x.rfq.file_ids || [];
  if (!have.includes(id)) return back(res, `/admin/rfqs/${x.rfq.id}`, { err: 'File not found on this RFQ.' });
  const rev = { ...(x.rfq.file_review || {}) }; delete rev[id];
  await admin.from('rfqs').update({ file_ids: have.filter(v => v !== id), file_review: rev, updated_at: new Date().toISOString() }).eq('id', x.rfq.id);
  const { data: d } = await admin.from('documents').select('entity_type').eq('id', id).maybeSingle();
  if (d?.entity_type === 'rfq') await deleteDocument(id);          // files uploaded here are deleted; the client's own documents are only detached
  back(res, `/admin/rfqs/${x.rfq.id}`, { msg: 'File removed from this RFQ.' });
});

r.post('/:id/review', async (req, res) => {
  const x = await load(req.params.id);
  if (!x) return notFound(res, 'RFQ');
  const to = `/admin/rfqs/${x.rfq.id}`, have = x.rfq.file_ids || [];
  if (!have.length) return back(res, to, { err: 'No files attached.' });
  const { data: ds } = await admin.from('documents').select('id, title, mime_type, storage_path').in('id', have);
  const list = [];
  for (const d of ds || []) { try { list.push({ key: d.id, name: d.title || 'file', mime: d.mime_type || '', buffer: await downloadDocument(d.storage_path) }); } catch (e) { console.error(`[rfq] review download: ${e.message}`); } }
  const { map } = await reviewMany(list, { type: 'rfq', id: x.rfq.id });
  await admin.from('rfqs').update({ file_review: { ...(x.rfq.file_review || {}), ...map }, updated_at: new Date().toISOString() }).eq('id', x.rfq.id);
  const warn = Object.values(map).filter(v => v.status === 'warn').length;
  back(res, to, { msg: warn ? `AI check done — ${warn} file${warn > 1 ? 's need' : ' needs'} your attention.` : 'AI check done — nothing to flag in the files it could read.' });
});

r.post('/:id/status', async (req, res) => {
  const x = await load(req.params.id);
  if (!x) return notFound(res, 'RFQ');
  const st = req.body.status === 'closed' ? 'closed' : 'open';
  await admin.from('rfqs').update({ status: st, updated_at: new Date().toISOString() }).eq('id', x.rfq.id);
  back(res, `/admin/rfqs/${x.rfq.id}`, { msg: st === 'closed' ? 'RFQ closed.' : 'RFQ reopened.' });
});

r.post('/:id/delete', async (req, res) => {
  const x = await load(req.params.id);
  if (!x) return notFound(res, 'RFQ');
  if (x.rs.some(s => s.status !== 'draft')) return back(res, `/admin/rfqs/${x.rfq.id}`, { err: 'This RFQ was already sent — close it instead.' });
  await admin.from('rfqs').delete().eq('id', x.rfq.id);
  res.redirect('/admin/rfqs?msg=' + encodeURIComponent('RFQ deleted.'));
});

export default r;
