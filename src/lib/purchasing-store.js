// Database side of purchasing: store a supplier's answer to a PO (email reply, pasted WeChat message, typed by hand).
import { admin } from './supabase.js';
import { extractSupplierReply, aiEnabled } from './ai.js';
import { stripQuoted } from './freight.js';
import { readXlsx, workbookToText } from './xlsx-read.js';
import { uploadDocument } from './storage.js';
import { log } from './activity.js';
import { classifyReply, keepFiles, kindOf, isXlsx, isPdf, isImg, mediaOf } from './purchasing.js';

const isoDate = v => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);

/**
 * @param {{ po: object, channel: 'email'|'wechat'|'manual', from?: string, subject?: string, text?: string,
 *   files?: object[], outcome?: string, userId?: string }} p
 * outcome (typed by staff) wins over what is read from the text.
 */
export async function saveSupplierReply({ po, channel, from = null, subject = null, text = '', files = [], outcome = null, userId = null }) {
  const body = channel === 'email' ? stripQuoted(text) : String(text || '').trim();
  const att = keepFiles(files);
  const notes = [];
  let extracted = null, sheetText = '';
  for (const f of att.filter(isXlsx)) { try { sheetText += `\n${workbookToText(readXlsx(f.buffer), { maxRows: 200 })}`; } catch (e) { notes.push(`${f.originalname}: ${e.message}`); } }
  const pdf = att.find(isPdf), img = att.find(isImg);

  if (aiEnabled() && (body || pdf || img || sheetText)) {
    try {
      extracted = await extractSupplierReply({
        text: body, sheetText: sheetText || undefined, pdf: pdf?.buffer, image: !pdf && img ? { data: img.buffer, mediaType: mediaOf(img) } : undefined,
        context: { ref: po.ref, currency: po.currency, total: po.total, required_date: po.required_date, lines: (po.lines || []).map(l => `${l.description} x ${l.quantity}`) },
      }, { type: 'supplier_po', id: po.id });
    } catch (e) { notes.push(`AI could not read this reply: ${e.message}`); }
  }
  if (!extracted) extracted = { outcome: classifyReply(body), summary: body ? body.replace(/\s+/g, ' ').slice(0, 160) : 'Documents received' };
  delete extracted.usage;
  const result = outcome && ['confirmed', 'declined', 'question', 'info'].includes(outcome) ? outcome : extracted.outcome || 'info';

  // keep the files with the order (internal only)
  const where = po.order_id ? ['order', po.order_id] : ['supplier', po.supplier_id]; // an unlinked PO keeps its files with the supplier until it is linked
  const stored = [];
  for (const f of att) {
    try {
      const doc = await uploadDocument({ file: { ...f, size: f.size ?? f.buffer.length }, entityType: where[0], entityId: where[1], kind: kindOf(f.originalname), title: `Supplier ${po.ref} — ${f.originalname}`, clientVisible: false, uploadedBy: userId });
      stored.push({ id: doc.id, name: f.originalname });
    } catch (e) { notes.push(`${f.originalname} not stored: ${e.message}`); }
  }
  const final = { ...extracted, ready_date: isoDate(extracted.ready_date), ...(stored.length ? { files: stored } : {}), ...(notes.length ? { notes } : {}) };

  const { data: resp, error } = await admin.from('supplier_po_responses').insert({
    po_id: po.id, channel, from_address: from, subject, body: body || null, outcome: result, extracted: final, created_by: userId,
  }).select('*').single();
  if (error) throw error;

  const now = new Date().toISOString();
  const patch = { last_reply_at: now, updated_at: now };
  if (result === 'confirmed') { patch.status = 'confirmed'; patch.confirmed_at = po.confirmed_at || now; }
  else if (result === 'declined') patch.status = 'declined';
  else if (po.status !== 'confirmed') patch.status = 'replied'; // a later question or document does not undo a confirmation
  await admin.from('supplier_pos').update(patch).eq('id', po.id);
  await log({ entityType: where[0], entityId: where[1], action: 'supplier_po_reply', actorId: userId, detail: { note: `${po.ref}: ${final.summary || result}` } });
  return { response: resp, extracted: final, status: patch.status || po.status };
}
