// Inbound webhooks (no sign-in): forwarder replies to freight quote requests.
//   POST /hooks/inbound-email?key=INBOUND_EMAIL_SECRET   body: the email as JSON or form data (Mailgun Routes → forward()).
//   Accepted when ?key= / x-inbound-secret matches INBOUND_EMAIL_SECRET, or the Mailgun signature matches MAILGUN_WEBHOOK_SIGNING_KEY.
import express from 'express';
import multer from 'multer';
import { Router } from '../lib/router.js';
import { admin } from '../lib/supabase.js';
import { normalizeInbound, matchKeys, mailgunSignatureOk } from '../lib/freight.js';
import { saveResponse, usefulFiles } from '../lib/freight-store.js';
import { saveSupplierReply } from '../lib/purchasing-store.js';
import { parseQuoteForm } from '../lib/quote-form.js';
import { readXlsx } from '../lib/xlsx-read.js';
import { timingSafeEqual } from 'node:crypto';

const r = Router();
// multipart (Mailgun with attachments): keep the text fields, drop files
const form = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 20 } }).any();
const same = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && x.length > 0 && timingSafeEqual(x, y); };

r.post('/inbound-email', express.json({ limit: '15mb' }), express.urlencoded({ extended: true, limit: '15mb' }), form, async (req, res) => {
  const secret = process.env.INBOUND_EMAIL_SECRET;
  const byKey = secret && (same(req.query.key, secret) || same(req.get('x-inbound-secret'), secret));
  if (!byKey && !mailgunSignatureOk(req.body, process.env.MAILGUN_WEBHOOK_SIGNING_KEY)) return res.status(401).json({ ok: false, error: 'bad key' });
  const mail = normalizeInbound(req.body);
  const keys = matchKeys(mail);
  let rfq = null;
  if (keys.token) ({ data: rfq } = await admin.from('freight_rfqs').select('*').eq('token', keys.token).maybeSingle());
  if (!rfq && keys.ref && mail.from) {
    const { data: fr } = await admin.from('freight_requests').select('id').eq('ref', keys.ref).maybeSingle();
    if (fr) ({ data: rfq } = await admin.from('freight_rfqs').select('*').eq('request_id', fr.id).ilike('sent_to', mail.from).maybeSingle());
  }
  const files = usefulFiles(req.files || []);
  if (!rfq) { // last chance: the token printed on our quotation form
    for (const f of files.filter(f => /\.xlsx$/i.test(f.originalname || ''))) {
      try { const tok = parseQuoteForm(readXlsx(f.buffer))?.token; if (tok) ({ data: rfq } = await admin.from('freight_rfqs').select('*').eq('token', tok).maybeSingle()); } catch { /* not a workbook */ }
      if (rfq) break;
    }
  }
  if (!rfq) { // not a freight quote: maybe a supplier answering our purchase order
    let spo = null;
    if (keys.token) ({ data: spo } = await admin.from('supplier_pos').select('*').eq('token', keys.token).maybeSingle());
    if (!spo && keys.ref?.startsWith('SPO-')) ({ data: spo } = await admin.from('supplier_pos').select('*').eq('ref', keys.ref).maybeSingle());
    if (spo) {
      try {
        const out = await saveSupplierReply({ po: spo, channel: 'email', from: mail.from, subject: mail.subject, text: mail.text, files: req.files || [] });
        console.log(`[inbound] reply for ${spo.ref} from ${mail.from}: ${out.extracted?.summary || 'saved'}`);
        return res.json({ ok: true, matched: true, purchase_order: spo.ref });
      } catch (e) { console.error('[inbound] supplier PO:', e.message); return res.status(500).json({ ok: false, error: e.message }); }
    }
  }
  if (!rfq) {
    console.warn(`[inbound] no matching quote request: from=${mail.from} subject=${mail.subject}`);
    return res.json({ ok: true, matched: false }); // 200 so the provider doesn't retry forever
  }
  try {
    const { extracted } = await saveResponse({ rfq, channel: 'email', from: mail.from, subject: mail.subject, text: mail.text, files });
    console.log(`[inbound] reply for rfq ${rfq.id} from ${mail.from}: ${extracted?.summary || 'saved'}`);
    res.json({ ok: true, matched: true });
  } catch (e) {
    console.error('[inbound]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default r;
