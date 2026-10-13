import { Router } from '../../lib/router.js';
import multer from 'multer';
import { admin } from '../../lib/supabase.js';
import { uploadDocument, signedUrl, deleteDocument } from '../../lib/storage.js';
import { log } from '../../lib/activity.js';
import { bool, back, DOC_KINDS } from '../../lib/util.js';

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
  for (const file of req.files) {
    await uploadDocument({
      file, entityType: entity_type, entityId: entity_id, kind: k,
      title: req.files.length === 1 && title ? title : file.originalname,
      clientVisible: bool(client_visible), uploadedBy: req.user.id,
    });
  }
  await log({
    entityType: entity_type, entityId: entity_id, action: 'documents_uploaded', actorId: req.user.id,
    clientVisible: bool(client_visible) && ['order', 'request'].includes(entity_type),
    detail: { kind: k, count: req.files.length, note: `${req.files.length} × ${k.replace(/_/g, ' ')}` },
  });
  back(res, to, { msg: `${req.files.length} file(s) uploaded.` });
});

r.get('/:id/download', async (req, res) => {
  const { data: doc } = await admin.from('documents').select('storage_path').eq('id', req.params.id).single();
  if (!doc) return res.status(404).send('Not found');
  res.redirect(await signedUrl(doc.storage_path));
});

r.post('/:id/toggle', async (req, res) => {
  const { data: doc } = await admin.from('documents').select('client_visible').eq('id', req.params.id).single();
  if (doc) await admin.from('documents').update({ client_visible: !doc.client_visible }).eq('id', req.params.id);
  back(res, safeBack(req.body.redirect));
});

r.post('/:id/delete', async (req, res) => {
  await deleteDocument(req.params.id);
  back(res, safeBack(req.body.redirect), { msg: 'File deleted.' });
});

export default r;
