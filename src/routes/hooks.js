// Inbound webhooks (no sign-in): forwarder replies to freight quote requests.
//   POST /hooks/inbound-email?key=INBOUND_EMAIL_SECRET   body: the email as JSON (from, to, subject, text/html)
import express from 'express';
import { Router } from '../lib/router.js';
import { admin } from '../lib/supabase.js';
import { normalizeInbound, matchKeys } from '../lib/freight.js';
import { saveResponse } from '../lib/freight-store.js';
import { timingSafeEqual } from 'node:crypto';

const r = Router();
const same = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && x.length > 0 && timingSafeEqual(x, y); };

r.post('/inbound-email', express.json({ limit: '15mb' }), express.urlencoded({ extended: true, limit: '15mb' }), async (req, res) => {
  const secret = process.env.INBOUND_EMAIL_SECRET;
  if (!secret || !(same(req.query.key, secret) || same(req.get('x-inbound-secret'), secret))) return res.status(401).json({ ok: false, error: 'bad key' });
  const mail = normalizeInbound(req.body);
  const keys = matchKeys(mail);
  let rfq = null;
  if (keys.token) ({ data: rfq } = await admin.from('freight_rfqs').select('*').eq('token', keys.token).maybeSingle());
  if (!rfq && keys.ref && mail.from) {
    const { data: fr } = await admin.from('freight_requests').select('id').eq('ref', keys.ref).maybeSingle();
    if (fr) ({ data: rfq } = await admin.from('freight_rfqs').select('*').eq('request_id', fr.id).ilike('sent_to', mail.from).maybeSingle());
  }
  if (!rfq) {
    console.warn(`[inbound] no matching quote request: from=${mail.from} subject=${mail.subject}`);
    return res.json({ ok: true, matched: false }); // 200 so the provider doesn't retry forever
  }
  try {
    const { extracted } = await saveResponse({ rfq, channel: 'email', from: mail.from, subject: mail.subject, text: mail.text });
    console.log(`[inbound] reply for rfq ${rfq.id} from ${mail.from}: ${extracted?.summary || 'saved'}`);
    res.json({ ok: true, matched: true });
  } catch (e) {
    console.error('[inbound]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default r;
