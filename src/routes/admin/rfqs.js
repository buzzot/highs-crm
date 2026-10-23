// RFQs: one request for quotation sent to several suppliers; their answers are compared inside it.
import multer from '../../lib/multer-utf8.js';
import { Router } from '../../lib/router.js';
import { admin } from '../../lib/supabase.js';
import { sendEmail } from '../../lib/mailer.js';
import { log } from '../../lib/activity.js';
import { replyAddress, subjectTag } from '../../lib/freight.js';
import { uploadDocument } from '../../lib/storage.js';
import { back, notFound, getSettings, INCOTERMS } from '../../lib/util.js';
import { cleanItems, cleanResponse, compare, currentResponses, rfqSupplierEmail, RFQ_STATUS_LABEL, RS_LABEL, RFQ_CURRENCIES } from '../../lib/rfq.js';

const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 8 } });
const isId = v => /^[0-9a-f-]{36}$/i.test(v || '');
const appUrl = () => (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
const MIGRATION = 'Run supabase/migrations/0029_rfqs.sql in Supabase first, then reload the schema cache.';
const missingTable = e => /rfqs|rfq_suppliers|rfq_responses/.test(e?.message || '');
const ids = v => [].concat(v || []).filter(isId);

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
      admin.from('request_items').select('id, name, description, quantity, unit').eq('request_id', req.query.request).order('position'),
    ]) : [{ data: null }, { data: [] }],
  ]);
  const request = reqRes[0]?.data || null;
  let items = (reqRes[1]?.data || []).map(i => ({ id: '', description: i.name, sku: '', quantity: i.quantity, unit: i.unit, notes: i.description || '', request_item_id: i.id }));
  if (request && !items.length) items = [{ id: '', description: request.title, sku: '', quantity: request.quantity, unit: 'pcs', notes: request.description || '', request_item_id: null }];
  if (!items.length) items = [{ id: '', description: '', sku: '', quantity: null, unit: 'pcs', notes: '' }];
  res.render('admin/rfqs/new', { title: 'New RFQ', suppliers: suppliers || [], request, items, currencies: RFQ_CURRENCIES, error: req.query.err || null });
});

r.post('/new', async (req, res) => {
  const b = req.body, to = '/admin/rfqs/new' + (isId(b.request_id) ? '?request=' + b.request_id + '&' : '?');
  const items = cleanItems(b), sup = ids(b.supplier_ids);
  const title = String(b.title || '').trim().slice(0, 200);
  if (!title) return back(res, to.slice(0, -1), { err: 'Give the RFQ a title.' });
  if (!items.length) return back(res, to.slice(0, -1), { err: 'Add at least one product.' });
  if (!sup.length) return back(res, to.slice(0, -1), { err: 'Choose at least one supplier.' });
  const { data: rfq, error } = await admin.from('rfqs').insert({ title, request_id: isId(b.request_id) ? b.request_id : null, currency: RFQ_CURRENCIES.includes(b.currency) ? b.currency : 'USD',
    deadline: /^\d{4}-\d{2}-\d{2}$/.test(b.deadline || '') ? b.deadline : null, message: String(b.message || '').trim().slice(0, 3000) || null, items, created_by: req.user.id }).select('id, ref').single();
  if (error) return back(res, to.slice(0, -1), { err: missingTable(error) ? MIGRATION : error.message });
  await admin.from('rfq_suppliers').insert(sup.map(supplier_id => ({ rfq_id: rfq.id, supplier_id })));
  await log({ entityType: isId(b.request_id) ? 'request' : 'supplier', entityId: isId(b.request_id) ? b.request_id : sup[0], action: 'rfq_created', actorId: req.user.id, detail: { note: `${rfq.ref} → ${sup.length} supplier(s)` } });
  res.redirect(`/admin/rfqs/${rfq.id}?msg=${encodeURIComponent('RFQ created. Check it, then send it to the suppliers.')}`);
});

async function load(id) {
  if (!isId(id)) return null;
  const { data: rfq } = await admin.from('rfqs').select('*, requests(id, ref, title)').eq('id', id).maybeSingle();
  if (!rfq) return null;
  const [{ data: rs }, { data: responses }] = await Promise.all([
    admin.from('rfq_suppliers').select('*, suppliers(id, name, email, contact_name)').eq('rfq_id', id).order('created_at'),
    admin.from('rfq_responses').select('*').eq('rfq_id', id).order('created_at', { ascending: false }),
  ]);
  return { rfq, rs: rs || [], responses: responses || [] };
}

r.get('/:id', async (req, res) => {
  const x = await load(req.params.id);
  if (!x) return notFound(res, 'RFQ');
  const [settings, { data: all }] = await Promise.all([getSettings(admin), admin.from('suppliers').select('id, name').order('name')]);
  const fileIds = [...new Set(x.responses.flatMap(p => p.file_ids || []))];
  const { data: docs } = fileIds.length ? await admin.from('documents').select('id, title, mime_type').in('id', fileIds) : { data: [] };
  const invited = new Set(x.rs.map(s => s.supplier_id));
  res.render('admin/rfqs/detail', { title: x.rfq.ref, ...x, current: currentResponses(x.responses), cmp: compare({ items: x.rfq.items, suppliers: x.rs, responses: x.responses, currency: x.rfq.currency, settings }),
    docs: docs || [], addable: (all || []).filter(s => !invited.has(s.id)), labels: RFQ_STATUS_LABEL, rsLabels: RS_LABEL, currencies: RFQ_CURRENCIES, incoterms: INCOTERMS, msg: req.query.msg, err: req.query.err });
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
  for (const s of targets) {
    const emails = String(req.body['to_' + s.id] || s.sent_to || s.suppliers?.email || '').split(/[,;\s]+/).filter(v => /@/.test(v));
    if (!emails.length) { failed.push(`${s.suppliers?.name}: no email address`); continue; }
    try {
      const m = rfqSupplierEmail({ rfq: x.rfq, supplier: s.suppliers, url: `${appUrl()}/supplier/rfqs/${s.id}`, message: x.rfq.message, senderName: req.user.full_name });
      await sendEmail({ to: emails, ...m, subject: `${m.subject} ${subjectTag(x.rfq.ref, s.token)}`, replyTo: replyAddress(s.token, req.user.email) });
      await admin.from('rfq_suppliers').update({ status: s.status === 'draft' ? 'sent' : s.status, sent_to: emails.join(', '), sent_at: new Date().toISOString() }).eq('id', s.id);
      sent.push(s.suppliers?.name);
    } catch (e) { failed.push(`${s.suppliers?.name}: ${e.message}`); }
  }
  if (sent.length && x.rfq.status === 'draft') await admin.from('rfqs').update({ status: 'open', updated_at: new Date().toISOString() }).eq('id', x.rfq.id);
  if (sent.length) await log({ entityType: x.rfq.request_id ? 'request' : 'supplier', entityId: x.rfq.request_id || x.rs[0].supplier_id, action: 'rfq_sent', actorId: req.user.id, detail: { note: `${x.rfq.ref} → ${sent.join(', ')}` } });
  back(res, to, { msg: sent.length ? `Sent to ${sent.join(', ')}.` : undefined, err: failed.length ? 'Not sent — ' + failed.join('; ') : undefined });
});

// staff enter an answer received outside the portal (WeChat, a phone call, a PDF)
r.post('/:id/answer/:rs', upload.array('files', 8), async (req, res) => {
  const x = await load(req.params.id);
  const s = x?.rs.find(v => v.id === req.params.rs);
  if (!s) return notFound(res, 'RFQ');
  const to = `/admin/rfqs/${x.rfq.id}`;
  const declined = req.body.decline === '1';
  const parsed = cleanResponse(req.body, x.rfq.items, x.rfq.currency);
  if (!declined && parsed.problems.length) return back(res, to, { err: parsed.problems.join('; ') });
  const file_ids = [];
  for (const file of req.files || []) {
    const doc = await uploadDocument({ file, entityType: 'supplier', entityId: s.supplier_id, kind: 'other', title: file.originalname, clientVisible: false, uploadedBy: req.user.id });
    file_ids.push(doc.id);
  }
  await admin.from('rfq_responses').insert({ rfq_id: x.rfq.id, rfq_supplier_id: s.id, supplier_id: s.supplier_id, source: 'manual', status: declined ? 'declined' : 'confirmed',
    lines: declined ? [] : parsed.lines, terms: declined ? {} : parsed.terms, note: String(req.body.note || '').trim().slice(0, 2000) || null, file_ids, created_by: req.user.id });
  await admin.from('rfq_suppliers').update({ status: declined ? 'declined' : 'replied', replied_at: new Date().toISOString() }).eq('id', s.id);
  back(res, to, { msg: `Answer from ${s.suppliers?.name} saved.` });
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
