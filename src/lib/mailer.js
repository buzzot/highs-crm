// Sends email through Resend (https://resend.com) from your own domain.
// Env: RESEND_API_KEY, EMAIL_FROM ("Highs Business <no-reply@yourdomain.com>"), optional EMAIL_REPLY_TO.
// Without RESEND_API_KEY (local development) the email is printed to the server log instead.

export const mailConfigured = () => !!process.env.RESEND_API_KEY && !!process.env.EMAIL_FROM;

export async function sendEmail({ to, subject, html, text }) {
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
      from: process.env.EMAIL_FROM, to: [to], subject, html, text,
      ...(process.env.EMAIL_REPLY_TO ? { reply_to: process.env.EMAIL_REPLY_TO } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`[mail] ${res.status} to ${to}: ${body.message || JSON.stringify(body)}`);
    throw new Error(res.status === 403 || /domain/i.test(body.message || '')
      ? 'Email could not be sent: the sending domain is not verified in Resend yet.'
      : 'Email could not be sent. Please try again in a minute.');
  }
  return body;
}
