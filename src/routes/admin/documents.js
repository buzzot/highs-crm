import { Router } from '../../lib/router.js';
import multer from 'multer';
import { admin } from '../../lib/supabase.js';
import { uploadDocument, signedUrl, deleteDocument, downloadDocument } from '../../lib/storage.js';
import { sendEmail } from '../../lib/mailer.js';
import { documentsEmail } from '../../lib/email-templates.js';
import { getCompany } from '../../lib/purchase.js';
import { log } from '../../lib/activity.js';
import { bool, back, DOC_KINDS, INTERNAL_KINDS } from '../../lib/util.js';

const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const ENTITIES = ['request', 'quote', 'order', 'shipment', 'product', 'supplier'];
const safeBack = u => (typeof u === 'string' && u.startsWith('/admin') ? u : '/admin');

// Generic upload used by the documents panel on every detail page
r.post('/upload', upload.array('files', 20), async (req, res) => {
  const { entity_type, entity_id, kind, title, client_visible, redirect } = req.body;
  const to = safeBack(redirect);
  if (!ENTITIES.includes(entity_type) || !entity_id) return back(res, to, { err: 'Invalid upload target.' });
  if (!req.files?.length) return back(res, to, { err: 'Choose at least one file.' });
  const k = DOC_KINDS.includes(kind) ? kind : 'other';
  const visible = INTERNAL_KINDS.includes(k) ? false : bool(client_visible);
  for (const file of req.files) {
    await uploadDocument({
      file, entityType: entity_type, entityId: entity_id, kind: k,
      title: req.files.length === 1 && title ? title : file.originalname,
      clientVisible: visible, uploadedBy: req.user.id,
    });
  }
  await log({
    entityType: entity_type, entityId: entity_id, action: 'documents_uploaded', actorId: req.user.id,
    clientVisible: visible && ['order', 'request'].includes(entity_type),
    detail: { kind: k, count: req.files.length, note: `${req.files.length} × ${k.replace(/_/g, ' ')}` },
  });
  back(res, to, { msg: `${req.files.length} file(s) uploaded.` });
});

// E-mail the selected documents (attached) to the client and/or any typed address; every send is recorded
const MAX_ATTACH = 20 * 1024 * 1024;
const list = v => (Array.isArray(v) ? v : v ? [v] : []);
r.post('/send', async (req, res) => {
  const { entity_type, entity_id, redirect, message } = req.body;
  const to = safeBack(redirect);
  const ids = list(req.body.ids).filter(x => /^[0-9a-f-]{36}$/i.test(x));
  if (!ids.length) return back(res, to, { err: 'Tick at least one document to send.' });
  const emails = [...new Set([...list(req.body.to_client), ...String(req.body.to_other || '').split(/[,;\s]+/)].map(x => x.trim().toLowerCase()).filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))];
  if (!emails.length) return back(res, to, { err: 'Choose the client or type an email address to send to.' });
  const { data: docs } = await admin.from('documents').select('*').in('id', ids).eq('entity_type', entity_type).eq('entity_id', entity_id);
  if (!docs?.length) return back(res, to, { err: 'Those documents were not found.' });
  let order = null;
  if (entity_type === 'shipment') {
    const { data: sh } = await admin.from('shipments').select('order_id').eq('id', entity_id).maybeSingle();
    if (sh) order = (await admin.from('orders').select('id, order_no').eq('id', sh.order_id).maybeSingle()).data;
  } else if (entity_type === 'order') order = (await admin.from('orders').select('id, order_no').eq('id', entity_id).maybeSingle()).data;
  if (!order) return back(res, to, { err: 'Documents can only be sent from an order or shipment.' });
  let total = 0; const attachments = [];
  try {
    for (const d of docs) {
      const content = await downloadDocument(d.storage_path);
      total += content.length;
      const ext = (d.storage_path.split('.').pop() || 'pdf').toLowerCase();
      const base = String(d.title || 'document').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\.[a-z0-9]{2,4}$/i, '').trim();
      attachments.push({ filename: `${base}.${ext}`, content });
    }
  } catch (e) { return back(res, to, { err: `Could not read a file: ${e.message}` }); }
  if (total > MAX_ATTACH) return back(res, to, { err: `The files add up to ${(total / 1048576).toFixed(1)} MB — send fewer at once (limit ${MAX_ATTACH / 1048576} MB).` });
  const company = await getCompany(admin);
  try { await sendEmail({ to: emails, ...documentsEmail({ order, docs, company, message: String(message || '').trim().slice(0, 1500) }), attachments }); }
  catch (e) { return back(res, to, { err: e.message }); }
  const { error: hErr } = await admin.from('document_sends').insert(docs.map(d => ({ document_id: d.id, sent_by: req.user.id, to_emails: emails, message: String(message || '').trim().slice(0, 1500) || null })));
  await log({ entityType: entity_type, entityId: entity_id, action: 'documents_sent', actorId: req.user.id, clientVisible: false, detail: { note: `${docs.length} document(s) → ${emails.join(', ')}` } });
  back(res, to, hErr
    ? { msg: `Sent to ${emails.join(', ')}.`, err: /document_sends/.test(hErr.message) ? 'The history could not be saved — run supabase/migrations/0026_document_sends.sql first.' : hErr.message }
    : { msg: `${docs.length} document${docs.length === 1 ? '' : 's'} sent to ${emails.join(', ')}.` });
});

// a document's file never changes, so its path and a signed link are remembered for 5 minutes — a page with many thumbnails
// then costs one lookup per picture at most once, and the browser keeps the redirect for a few minutes too
const linkCache = new Map();
r.get('/:id/download', async (req, res) => {
  const hit = linkCache.get(req.params.id);
  let url = hit && hit.until > Date.now() ? hit.url : null;
  if (!url) {
    const { data: doc } = await admin.from('documents').select('storage_path').eq('id', req.params.id).single();
    if (!doc) return res.status(404).send('Not found');
    url = await signedUrl(doc.storage_path);
    if (linkCache.size > 2000) linkCache.clear();
    linkCache.set(req.params.id, { url, until: Date.now() + 300e3 });
  }
  res.set('Cache-Control', 'private, max-age=240');
  res.redirect(url);
});

r.post('/:id/toggle', async (req, res) => {
  const { data: doc } = await admin.from('documents').select('client_visible, kind').eq('id', req.params.id).single();
  if (doc && !INTERNAL_KINDS.includes(doc.kind)) await admin.from('documents').update({ client_visible: !doc.client_visible }).eq('id', req.params.id);
  back(res, safeBack(req.body.redirect));
});

r.post('/:id/delete', async (req, res) => {
  await deleteDocument(req.params.id);
  linkCache.delete(req.params.id);
  back(res, safeBack(req.body.redirect), { msg: 'File deleted.' });
});

export default r;
