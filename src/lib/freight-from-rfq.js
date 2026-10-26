// Send a draft packing list (from an RFQ answer) to forwarders as a freight quote request — no order needed.
// The request keeps its own copy of the packing lines (freight_requests.cargo); replies come back through the same token/webhook as order-based requests.
import { admin } from './supabase.js';
import { sendEmail } from './mailer.js';
import { replyAddress, subjectTag } from './freight.js';
import { rfqEmail } from './email-templates.js';
import { draftRfqWorkbook } from './rfq-packing.js';

export const FREIGHT_MODES = ['Sea FCL', 'Sea LCL', 'Air', 'Express', 'Rail', 'Truck'];
const INFO = ['mode', 'pol', 'pod', 'incoterm', 'ready_date', 'remarks'];
export const cleanInfo = body => Object.fromEntries(INFO.map(k => [k, String(body[k] || '').trim().slice(0, 500) || null]).filter(([, v]) => v));
export const emailsIn = v => String(v || '').split(/[\s,;]+/).map(x => x.trim().toLowerCase()).filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));

async function createRequest({ rfq, supplierName, d, info, message, userId }) {
  const t = d.t;
  const { data: fr, error } = await admin.from('freight_requests').insert({
    order_id: null, rfq_id: rfq.id, label: [rfq.ref, supplierName].filter(Boolean).join(' · '), cargo: d.rows, info,
    totals: { cartons: t.cartons, pieces: t.pieces, gross_kg: t.gross, cbm: t.cbm, packages: t.pkgSummary, qty: t.qtySummary }, message: message || null, created_by: userId,
  }).select('*').single();
  if (error) throw new Error(/order_id|rfq_id|label|cargo|null value/.test(error.message) ? 'Run supabase/migrations/0034_freight_from_rfq.sql first.' : error.message);
  return fr;
}

/** Email the draft packing list (Excel attached) to every target: [{ fw, email }]. Returns { fr, sent[], failed[] }. */
export async function emailFreightRequest({ rfq, supplierName, d, info, targets, message, user }) {
  const fr = await createRequest({ rfq, supplierName, d, info, message, userId: user.id });
  const order = { order_no: fr.ref };
  const sent = [], failed = [];
  for (const tg of targets) {
    const { data: row, error } = await admin.from('freight_rfqs').insert({ request_id: fr.id, order_id: null, forwarder_id: tg.fw?.id || null, sent_to: tg.email, channel: 'email', message: message || null, sent_by: user.id }).select('*').single();
    if (error) { failed.push(`${tg.email}: ${error.message}`); continue; }
    try {
      const m = rfqEmail({ order, info, rows: d.rows, t: d.t, message, senderName: user.full_name, forwarderName: tg.fw?.contact_name || tg.fw?.name });
      await sendEmail({ to: tg.email, ...m, subject: `${m.subject} ${subjectTag(fr.ref, row.token)}`, replyTo: replyAddress(row.token, user.email),
        attachments: [{ filename: `${fr.ref}-quotation-packing-list.xlsx`, content: draftRfqWorkbook({ order, info, rows: d.rows, t: d.t, ref: fr.ref, token: row.token }) }] });
      sent.push(tg.fw?.name || tg.email);
    } catch (e) {
      await admin.from('freight_rfqs').delete().eq('id', row.id);
      failed.push(`${tg.fw?.name || tg.email}: ${e.message}`);
    }
  }
  if (!sent.length) await admin.from('freight_requests').delete().eq('id', fr.id);
  return { fr, sent, failed };
}

/** WeChat is sent by hand: record it as a request so the forwarder's answer can be pasted in later. */
export async function recordWechatRequest({ rfq, supplierName, d, info, forwarderId, user }) {
  const fr = await createRequest({ rfq, supplierName, d, info, message: 'Sent by WeChat', userId: user.id });
  await admin.from('freight_rfqs').insert({ request_id: fr.id, order_id: null, forwarder_id: forwarderId || null, channel: 'wechat', sent_by: user.id, sent_to: 'WeChat' });
  return fr;
}
