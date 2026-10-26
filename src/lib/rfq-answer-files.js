// Uploads of a supplier's RFQ answer: the whole-quote drop area ("files") and one drop area per product ("files_<item id>").
import { uploadDocument } from './storage.js';

export const answerUpload = multer => multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 40 } }).any();

export async function uploadAnswerFiles(files, { supplierId, userId, items }) {
  const ids = new Set(items.map(i => i.id));
  const out = { general: [], byItem: {} };
  for (const file of files || []) {
    const m = /^files(?:_(.+))?$/.exec(file.fieldname);
    if (!m || (m[1] && !ids.has(m[1]))) continue;
    if ((m[1] ? (out.byItem[m[1]] || []).length : out.general.length) >= 8) continue;
    const doc = await uploadDocument({ file, entityType: 'supplier', entityId: supplierId, kind: 'other', title: file.originalname, clientVisible: false, uploadedBy: userId });
    if (m[1]) (out.byItem[m[1]] ||= []).push(doc.id); else out.general.push(doc.id);
  }
  return out;
}
