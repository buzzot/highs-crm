// Database side of freight quote requests: store a forwarder's answer and update their quote.
import { admin } from './supabase.js';
import { extractQuote, aiEnabled } from './ai.js';
import { stripQuoted } from './freight.js';
import { log } from './activity.js';

/**
 * @param {{ rfq: object, channel: 'email'|'wechat'|'manual', from?: string, subject?: string, text?: string, manual?: object, userId?: string }} p
 * manual: { amount, currency, transit_days, valid_until, notes } typed by staff (wins over AI)
 */
export async function saveResponse({ rfq, channel, from = null, subject = null, text = '', manual = null, userId = null }) {
  const body = channel === 'email' ? stripQuoted(text) : String(text || '').trim();
  let extracted = null;
  if (body && aiEnabled()) {
    try {
      const { data: req } = await admin.from('freight_requests').select('ref, info, totals').eq('id', rfq.request_id).maybeSingle();
      extracted = await extractQuote({ text: body, context: { ref: req?.ref, ...(req?.info || {}), ...(req?.totals || {}) } }, { type: 'freight_request', id: rfq.request_id });
    } catch (e) { extracted = { is_quote: false, summary: `AI could not read this reply: ${e.message}`, error: true }; }
  }
  const m = manual && (manual.amount !== '' && manual.amount != null) ? manual : null;
  const final = {
    ...(extracted || {}),
    ...(m ? { is_quote: true, amount: Number(m.amount), currency: m.currency || extracted?.currency || 'USD', transit_days: m.transit_days ? Number(m.transit_days) : extracted?.transit_days ?? null, valid_until: m.valid_until || extracted?.valid_until || null, summary: m.notes || extracted?.summary || 'Entered by hand' } : {}),
  };
  const { data: resp, error } = await admin.from('freight_responses').insert({
    rfq_id: rfq.id, request_id: rfq.request_id, channel, from_address: from, subject, body: body || null,
    extracted: Object.keys(final).length ? { ...final, usage: undefined } : null, created_by: userId,
  }).select('*').single();
  if (error) throw error;
  if (final.is_quote && final.amount != null) {
    await admin.from('freight_rfqs').update({
      status: 'quoted', quote_amount: final.amount, quote_currency: final.currency || 'USD', quote_notes: final.summary || null,
      transit_days: final.transit_days ?? null, valid_until: /^\d{4}-\d{2}-\d{2}$/.test(final.valid_until || '') ? final.valid_until : null, quoted_at: new Date().toISOString(),
    }).eq('id', rfq.id);
  }
  await log({ entityType: 'order', entityId: rfq.order_id, action: 'freight_quote_received', actorId: userId, detail: { note: final.summary || `${channel} reply from ${from || 'forwarder'}` } });
  return { response: resp, extracted: final, usage: extracted?.usage || null };
}
