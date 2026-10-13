import { admin } from './supabase.js';
import { randomUUID } from 'node:crypto';

const BUCKET = 'documents';

export async function uploadDocument({ file, entityType, entityId, kind = 'other', title, clientVisible = true, uploadedBy }) {
  const ext = (file.originalname.split('.').pop() || 'bin').toLowerCase();
  const path = `${entityType}/${entityId}/${randomUUID()}.${ext}`;
  const { error } = await admin.storage.from(BUCKET).upload(path, file.buffer, { contentType: file.mimetype, upsert: false });
  if (error) throw error;
  const { data, error: dErr } = await admin.from('documents').insert({
    entity_type: entityType, entity_id: entityId, kind, title: title || file.originalname,
    storage_path: path, mime_type: file.mimetype, size_bytes: file.size, client_visible: clientVisible, uploaded_by: uploadedBy,
  }).select().single();
  if (dErr) throw dErr;
  return data;
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
