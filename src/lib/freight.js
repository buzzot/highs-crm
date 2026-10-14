// Freight quote requests: reply addresses, reading inbound reply emails, matching them to a request.
// No database access here — easy to test.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Where forwarders' replies should go. With QUOTE_REPLY_ADDRESS = quotes@in.lumitrade.cc → quotes+<token>@in.lumitrade.cc */
export function replyAddress(token, fallback) {
  const base = String(process.env.QUOTE_REPLY_ADDRESS || '').trim();
  const m = base.match(/^([^@\s]+)@([^@\s]+)$/);
  return m ? `${m[1]}+${token}@${m[2]}` : fallback;
}

/** Subject tag that survives "Re:" / "回复:" and lets us match replies even without plus-addressing. */
export const subjectTag = (ref, token) => `[${ref} #${token}]`;

const first = (...xs) => xs.find(x => x !== undefined && x !== null && x !== '');
const addr = v => {
  if (!v) return [];
  if (Array.isArray(v)) return v.flatMap(addr);
  if (typeof v === 'object') return addr(v.address || v.email || v.value || '');
  return String(v).split(',').map(x => (x.match(/<([^>]+)>/) || [null, x])[1].trim().toLowerCase()).filter(Boolean);
};
const htmlToText = h => String(h || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
  .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\n{3,}/g, '\n\n').trim();

/**
 * Accepts the JSON that common inbound-email services post (Resend, Postmark, Mailgun-as-JSON, SendGrid,
 * Cloudflare Email Workers…) and returns { from, to: [], subject, text }.
 */
export function normalizeInbound(payload) {
  const p = payload?.data && typeof payload.data === 'object' ? { ...payload, ...payload.data } : (payload || {});
  const from = addr(first(p.from, p.From, p.sender, p.envelope?.from, p.FromFull))[0] || null;
  const to = [...new Set([...addr(first(p.to, p.To, p.recipient, p.envelope?.to, p.ToFull)), ...addr(p.cc || p.Cc), ...addr(p.OriginalRecipient)])];
  const subject = String(first(p.subject, p.Subject, p.headers?.subject, '') || '');
  const text = String(first(p.text, p.TextBody, p['body-plain'], p['stripped-text'], p.plain, '') || '') || htmlToText(first(p.html, p.HtmlBody, p['body-html']));
  return { from, to, subject, text };
}

/** Find the request token: quotes+TOKEN@…, or "#TOKEN]" in the subject; else the FQ reference. */
export function matchKeys({ to = [], subject = '' }) {
  for (const a of to) { const m = a.match(/^[^+@]+\+([a-z0-9]{6,16})@/i); if (m) return { token: m[1].toLowerCase() }; }
  const t = subject.match(/#([a-z0-9]{6,16})\]/i);
  if (t) return { token: t[1].toLowerCase() };
  const r = subject.match(/\bFQ-\d{4}-\d{1,4}\b/i);
  return r ? { ref: r[0].toUpperCase() } : {};
}

/** Drop the quoted original message and signatures' long tails so the AI (and people) see only the answer. */
export function stripQuoted(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  for (const l of lines) {
    if (/^\s*>/.test(l)) continue;
    if (/^\s*(On .{5,200} wrote:|-{2,}\s*Original Message\s*-{2,}|-{2,}\s*原始邮件\s*-{2,}|发件人[:：].*|From:\s.*@.*|在\s.+写道[:：])\s*$/i.test(l)) break;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 20000);
}

/** Mailgun signs each forwarded message: HMAC-SHA256(signing key, timestamp + token) = signature. */
export function mailgunSignatureOk(body, key, now = Date.now()) {
  const sig = body?.signature && typeof body.signature === 'object' ? body.signature : body || {};
  const { timestamp, token, signature } = sig;
  if (!key || !timestamp || !token || !signature) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 86400) return false; // older than a day → replay
  const want = createHmac('sha256', key).update(String(timestamp) + String(token)).digest('hex');
  const a = Buffer.from(want), b = Buffer.from(String(signature));
  return a.length === b.length && timingSafeEqual(a, b);
}
