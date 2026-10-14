// Database side of freight quote requests: store a forwarder's answer and update their quote.
import { admin } from './supabase.js';
import { extractQuote, aiEnabled } from './ai.js';
import { stripQuoted } from './freight.js';
import { parseQuoteForm, summaryOf } from './quote-form.js';
import { readXlsx, workbookToText } from './xlsx-read.js';
import { uploadDocument } from './storage.js';
import { log } from './activity.js';

const IMG = /^image\/(png|jpe?g|gif|webp)$/i;
const isXlsx = f => /\.xlsx$/i.test(f.originalname || '') || /spreadsheetml/.test(f.mimetype || '');
const isPdf = f => /\.pdf$/i.test(f.originalname || '') || f.mimetype === 'application/pdf';
const isImg = f => IMG.test(f.mimetype || '') || /\.(png|jpe?g|webp|gif)$/i.test(f.originalname || '');
const mediaOf = f => (IMG.test(f.mimetype || '') ? f.mimetype.replace('jpg', 'jpeg') : /\.png$/i.test(f.originalname) ? 'image/png' : /\.webp$/i.test(f.originalname) ? 'image/webp' : 'image/jpeg');

/** Keep only files worth reading/storing (quotation forms, PDFs, screenshots); skip logos and signatures. */
export function usefulFiles(files = []) {
  return files.filter(f => f?.buffer?.length && (isXlsx(f) || isPdf(f) || (isImg(f) && f.buffer.length > 15000))).slice(0, 5);
}

/**
 * @param {{ rfq: object, channel: 'email'|'wechat'|'manual', from?: string, subject?: string, text?: string,
 *   files?: { originalname: string, mimetype: string, buffer: Buffer, size?: number }[], manual?: object, userId?: string }} p
 * manual: { amount, currency, transit_days, valid_until, notes } typed by staff (wins over everything)
 */
export async function saveResponse({ rfq, channel, from = null, subject = null, text = '', files = [], manual = null, userId = null }) {
  const body = channel === 'email' ? stripQuoted(text) : String(text || '').trim();
  const att = usefulFiles(files);
  const notes = [];

  // 1. our own quotation form, filled in → read it directly (exact, free)
  let form = null, sheetText = '';
  for (const f of att.filter(isXlsx)) {
    try {
      const wb = readXlsx(f.buffer);
      form = parseQuoteForm(wb);
      if (form) { form.file = f.originalname; break; }
      sheetText += `\n${workbookToText(wb, { maxRows: 200 })}`;
    } catch (e) { notes.push(`${f.originalname}: ${e.message}`); }
  }

  // 2. anything else (text, their own PDF/Excel/screenshot) → AI
  let extracted = form;
  let usage = null;
  const pdf = att.find(isPdf), img = att.find(isImg);
  const needAi = !form || (!form.is_quote && (body || pdf || img));
  if (needAi && (body || pdf || img || sheetText) && aiEnabled()) {
    try {
      const { data: req } = await admin.from('freight_requests').select('ref, info, totals').eq('id', rfq.request_id).maybeSingle();
      const ai = await extractQuote({
        text: body, sheetText: sheetText || undefined,
        pdf: pdf?.buffer, image: !pdf && img ? { data: img.buffer, mediaType: mediaOf(img) } : undefined,
        context: { ref: req?.ref, ...(req?.info || {}), ...(req?.totals || {}) },
      }, { type: 'freight_request', id: rfq.request_id });
      usage = ai.usage;
      extracted = form ? { ...ai, ...Object.fromEntries(Object.entries(form).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length))) } : ai;
    } catch (e) { extracted = extracted || { is_quote: false, summary: `AI could not read this reply: ${e.message}`, error: true }; }
  } else if (form && body && !form.questions) {
    form.message = body.slice(0, 2000);
  }

  // 3. keep the files with the order (internal)
  const stored = [];
  for (const f of att) {
    try {
      const doc = await uploadDocument({ file: { ...f, size: f.size ?? f.buffer.length }, entityType: 'order', entityId: rfq.order_id, kind: 'other', title: `Freight quote — ${f.originalname}`, clientVisible: false, uploadedBy: userId });
      stored.push({ id: doc.id, name: f.originalname });
    } catch (e) { notes.push(`${f.originalname} not stored: ${e.message}`); }
  }

  const m = manual && (manual.amount !== '' && manual.amount != null) ? manual : null;
  const final = {
    ...(extracted || {}),
    ...(m ? { is_quote: true, amount: Number(m.amount), currency: m.currency || extracted?.currency || 'USD', transit_days: m.transit_days ? Number(m.transit_days) : extracted?.transit_days ?? null, valid_until: m.valid_until || extracted?.valid_until || null, summary: m.notes || extracted?.summary || 'Entered by hand' } : {}),
    ...(stored.length ? { files: stored } : {}),
    ...(notes.length ? { file_notes: notes } : {}),
  };
  if (final.amount != null && !m && (!final.summary || form)) final.summary = summaryOf(final);
  delete final.usage;
  const isoDate = v => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);

  const { data: resp, error } = await admin.from('freight_responses').insert({
    rfq_id: rfq.id, request_id: rfq.request_id, channel, from_address: from, subject, body: body || null,
    extracted: Object.keys(final).length ? final : null, created_by: userId,
  }).select('*').single();
  if (error) throw error;
  if (rfq.status === 'accepted') {
    // after acceptance, replies are booking details: keep the accepted price, enrich the shipment
    if (rfq.shipment_id) {
      const patch = {};
      if (final.loading_port) patch.origin_port = final.loading_port;
      if (isoDate(final.etd)) patch.etd = final.etd;
      const bits = [final.routing && `Routing: ${final.routing}${final.via ? ' via ' + final.via : ''}`, final.latest_receiving_date && `Latest receiving date: ${final.latest_receiving_date}`, final.vessel_flight && `Vessel/flight: ${final.vessel_flight}`].filter(Boolean);
      if (bits.length) {
        const { data: sh } = await admin.from('shipments').select('notes').eq('id', rfq.shipment_id).maybeSingle();
        patch.notes = [sh?.notes, `Booking details: ${bits.join(' · ')}`].filter(Boolean).join('\n');
      }
      if (Object.keys(patch).length) await admin.from('shipments').update(patch).eq('id', rfq.shipment_id);
    }
  } else if (final.is_quote && final.amount != null) {
    await admin.from('freight_rfqs').update({
      status: 'quoted', quote_amount: final.amount, quote_currency: final.currency || 'USD', quote_notes: final.summary || null,
      transit_days: final.transit_days ?? null, valid_until: isoDate(final.valid_until), quoted_at: new Date().toISOString(),
    }).eq('id', rfq.id);
  }
  await log({ entityType: 'order', entityId: rfq.order_id, action: 'freight_quote_received', actorId: userId, detail: { note: final.summary || `${channel} reply from ${from || 'forwarder'}` } });
  return { response: resp, extracted: final, usage };
}
