import { admin } from './supabase.js';
import { randomUUID } from 'node:crypto';
import { healText } from './heal-text.js';

const BUCKET = 'documents';

export async function uploadDocument({ file, entityType, entityId, kind = 'other', title, clientVisible = true, uploadedBy }) {
  const ext = (file.originalname.split('.').pop() || 'bin').toLowerCase();
  const path = `${entityType}/${entityId}/${randomUUID()}.${ext}`;
  const { error } = await admin.storage.from(BUCKET).upload(path, file.buffer, { contentType: file.mimetype, upsert: false });
  if (error) throw error;
  const { data, error: dErr } = await admin.from('documents').insert({
    entity_type: entityType, entity_id: entityId, kind, title: healText(title || file.originalname),
    storage_path: path, mime_type: file.mimetype, size_bytes: file.size, client_visible: clientVisible, uploaded_by: uploadedBy,
  }).select().single();
  if (dErr) throw dErr;
  return data;
}

/** File contents as a Buffer (for e-mail attachments). */
export async function downloadDocument(storagePath) {
  const { data, error } = await admin.storage.from(BUCKET).download(storagePath);
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}

export async function signedUrl(storagePath, seconds = 600) {
  const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(storagePath, seconds);
  if (error) throw error;
  return data.signedUrl;
}

export async function deleteDocument(id) {
  const { data: doc } = await admin.from('documents').select('*').eq('id', id).single();
  if (!doc) return;
  await admin.storage.from(BUCKET).remove([doc.storage_path]);
  await admin.from('documents').delete().eq('id', id);
}

/** One-off self-repair at start-up: titles saved before the upload fix ("ç®±…") become real text again. Safe to run every time. */
export async function repairDocumentTitles() {
  const { data } = await admin.from('documents').select('id, title').or('title.like.%Ã%,title.like.%Â%,title.like.%ç%,title.like.%å%,title.like.%æ%,title.like.%è%,title.like.%é%,title.like.%ä%,title.like.%ï%').limit(500);
  let n = 0;
  for (const d of data || []) { const t = healText(d.title); if (t !== d.title) { await admin.from('documents').update({ title: t }).eq('id', d.id); n++; } }
  return n;
}
