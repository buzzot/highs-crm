// Sends email through Resend (https://resend.com) from your own domain.
// Env: RESEND_API_KEY, EMAIL_FROM ("Lumi Trade <no-reply@yourdomain.com>"), optional EMAIL_REPLY_TO.
// Without RESEND_API_KEY (local development) the email is printed to the server log instead.

export const mailConfigured = () => !!process.env.RESEND_API_KEY && !!process.env.EMAIL_FROM;

export async function sendEmail({ to, subject, html, text, attachments, replyTo }) {
  if (!process.env.RESEND_API_KEY) {
    if (process.env.NODE_ENV === 'production') throw new Error('Email is not configured (RESEND_API_KEY missing).');
    console.log(`\n[mail:dev] to=${to}\n[mail:dev] subject=${subject}\n${text || ''}\n`);
    return { id: 'dev' };
  }
  if (!process.env.EMAIL_FROM) throw new Error('Email is not configured (EMAIL_FROM missing).');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM, to: Array.isArray(to) ? to : [to], subject, html, text,
      ...(replyTo || process.env.EMAIL_REPLY_TO ? { reply_to: replyTo || process.env.EMAIL_REPLY_TO } : {}),
      // [{ filename, content: Buffer }] → Resend expects base64
      ...(attachments?.length ? { attachments: attachments.map(a => ({ filename: a.filename, content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : a.content })) } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`[mail] ${res.status} to ${to}: ${body.message || JSON.stringify(body)}`);
    const why = body.message || `HTTP ${res.status}`;
    const err = new Error(/domain/i.test(why) && /verif/i.test(why)
      ? `Email could not be sent: the domain in EMAIL_FROM is not verified in Resend (${why}).`
      : `Email could not be sent: ${why}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

/** Diagnostics for the admin "Email check" page — never returns the key itself. */
export async function emailDiagnostics() {
  const key = process.env.RESEND_API_KEY || '';
  const from = process.env.EMAIL_FROM || '';
  const fromEmail = (from.match(/<([^>]+)>/) || [null, from])[1].trim();
  const fromDomain = (fromEmail.split('@')[1] || '').toLowerCase();
  const out = {
    key: key ? (key.startsWith('re_') ? `set (re_…${key.slice(-4)})` : 'set, but does not start with re_ — wrong value?') : 'MISSING',
    keyOk: key.startsWith('re_'),
    from: from || 'MISSING', fromOk: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fromEmail), fromDomain,
    replyTo: process.env.EMAIL_REPLY_TO || null,
    domains: null, domainsError: null,
  };
  if (out.keyOk) {
    try {
      const r = await fetch('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${key}` } });
      const b = await r.json().catch(() => ({}));
      if (r.ok) out.domains = (b.data || []).map(d => ({ name: d.name, status: d.status, region: d.region }));
      else out.domainsError = r.status === 401 && /restricted/i.test(b.message || b.name || '')
        ? 'This key is "Sending access" only, so the domain list can\'t be read — that\'s fine; use the test email below.'
        : (b.message || `HTTP ${r.status}`);
    } catch (e) { out.domainsError = e.message; }
  }
  return out;
}
