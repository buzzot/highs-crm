// Branded HTML emails (inline styles + tables so they render the same in Gmail, Outlook, Apple Mail).
// Pure functions → unit-tested and previewable.
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * @param {{ preheader, eyebrow, title, introHtml, code?, codeLabel?, buttonText, buttonUrl, fineHtml }} o
 * Values ending in "Html" are trusted HTML (built here); everything else is escaped.
 */
export function layout(o) {
  const code = o.code ? `
              <tr><td style="padding:8px 40px 4px;font-family:${FONT};font-size:15px;color:#4a5566;">${esc(o.codeLabel)}</td></tr>
              <tr><td style="padding:6px 40px 26px;">
                <div style="font-family:'SFMono-Regular',Menlo,Consolas,'Courier New',monospace;font-size:40px;line-height:1;font-weight:700;letter-spacing:12px;color:#0f3d5c;background:#eef4f9;border:1px solid #dbe6f0;border-radius:14px;padding:22px 10px 22px 22px;text-align:center;">${esc(o.code)}</div>
              </td></tr>` : '';
  const url = esc(o.buttonUrl);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(o.title)}</title></head>
<body style="margin:0;padding:0;background:#f1f3f6;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(o.preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f3f6;">
    <tr><td align="center" style="padding:36px 14px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td style="padding:0 6px 18px;font-family:${FONT};font-size:22px;font-weight:700;letter-spacing:-0.3px;color:#0f3d5c;">Lumi<span style="color:#0b8a7a;">Trade</span></td></tr>
        <tr><td style="background:#ffffff;border-radius:18px;border:1px solid #e3e6eb;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="height:6px;background:#0b8a7a;border-radius:18px 18px 0 0;font-size:0;line-height:0;">&nbsp;</td></tr>
            <tr><td style="padding:36px 40px 0;font-family:${FONT};font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#0b8a7a;">${esc(o.eyebrow)}</td></tr>
            <tr><td style="padding:10px 40px 0;font-family:${FONT};font-size:32px;line-height:1.2;font-weight:800;letter-spacing:-0.6px;color:#16202e;">${esc(o.title)}</td></tr>
            <tr><td style="padding:16px 40px 26px;font-family:${FONT};font-size:18px;line-height:1.6;color:#2f3a4a;">${o.introHtml}</td></tr>${code}
            <tr><td style="padding:0 40px 30px;">
              <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#0b8a7a;border-radius:12px;">
                <a href="${url}" style="display:inline-block;padding:17px 34px;font-family:${FONT};font-size:18px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:12px;">${esc(o.buttonText)} &rarr;</a>
              </td></tr></table>
            </td></tr>
            <tr><td style="padding:10px 40px 36px;font-family:${FONT};font-size:14px;line-height:1.6;color:#7a8494;border-top:1px solid #eef0f3;">
              <div style="padding-top:18px;">${o.fineHtml}</div>
              <div style="padding-top:10px;">Button not working? Copy this link into your browser:<br><a href="${url}" style="color:#2a62b8;word-break:break-all;">${url}</a></div>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:20px 6px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:#9aa3b0;text-align:center;">Lumi Trade · Sourcing, orders and shipments in one place</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

const text = (...lines) => lines.filter(l => l != null).join('\n');

export function inviteEmail({ url, code, orgName, inviterName, days, kind = 'client' }) {
  const supplier = kind === 'supplier';
  const where = supplier ? 'the Lumi Trade supplier portal' : orgName ? `the ${orgName} portal at Lumi Trade` : 'the Lumi Trade team';
  const what = supplier
    ? 'Register your company: confirm this email, fill in your company and contact details and create a password. After that you can keep your details and product information up to date.'
    : 'Send sourcing requests, approve quotes and follow every order and shipment in one place.';
  return {
    subject: supplier ? 'Lumi Trade invites you to register as a supplier' : orgName ? `You're invited to the ${orgName} portal` : "You're invited to Lumi Trade",
    html: layout({
      preheader: `Your invitation code is ${code}.`,
      eyebrow: supplier ? 'Supplier invitation' : 'Invitation', title: supplier ? 'Register as a Lumi Trade supplier' : 'You’re invited to Lumi Trade',
      introHtml: `${inviterName ? `<strong>${esc(inviterName)}</strong> invited you to ` : 'You have been invited to '}${esc(where)}. ${what}`,
      code, codeLabel: 'On the next page, enter this confirmation code:',
      buttonText: supplier ? 'Register now' : 'Accept invitation', buttonUrl: url,
      fineHtml: `The invitation link and code work for <strong>${days} days</strong>. Didn't expect this? You can ignore this email.`,
    }),
    text: text(`You're invited to ${where}.`, '', `Confirmation code: ${code}`, `${supplier ? 'Register' : 'Accept the invitation'}: ${url}`, '', `Valid for ${days} days.`),
  };
}

export function codeEmail({ url, code, minutes, purpose = 'login' }) {
  const invite = purpose === 'invite';
  return {
    subject: invite ? `Your Lumi Trade invitation code: ${code}` : `Your Lumi Trade sign-in code: ${code}`,
    html: layout({
      preheader: `Your code is ${code}`,
      eyebrow: invite ? 'Invitation code' : 'Sign-in code', title: 'Here’s your code',
      introHtml: invite ? 'Enter this code on your invitation page to confirm your email address.' : 'Enter this code on the Lumi Trade sign-in page to finish signing in.',
      code, codeLabel: 'Your one-time code:',
      buttonText: invite ? 'Open invitation' : 'Open Lumi Trade', buttonUrl: url,
      fineHtml: `The code works once${minutes ? ` and expires in <strong>${minutes} minutes</strong>` : ''}. ${invite ? '' : "If you didn't try to sign in, someone may know your password — change it under <em>My account</em>."}`,
    }),
    text: text(`Your Lumi Trade code: ${code}`, '', `Open: ${url}`, minutes ? `Expires in ${minutes} minutes.` : null),
  };
}

export function resetEmail({ url, email, minutes }) {
  return {
    subject: 'Reset your Lumi Trade password',
    html: layout({
      preheader: 'Choose a new password for your Lumi Trade account.',
      eyebrow: 'Password reset', title: 'Choose a new password',
      introHtml: `We received a request to reset the password for <strong>${esc(email)}</strong>. Click the button to choose a new one.`,
      buttonText: 'Reset password', buttonUrl: url,
      fineHtml: `The link works for <strong>${minutes} minutes</strong> and only once. If you didn't ask for this, you can ignore this email — your password stays the same.`,
    }),
    text: text(`Reset your Lumi Trade password (${email}):`, url, '', `The link works for ${minutes} minutes and only once.`),
  };
}

// ---- client edits of a sourcing request ----
export function changeSubmittedEmail({ request, orgName, who, url }) {
  return {
    subject: `${orgName || 'A client'} changed ${request.ref} — approval needed`,
    html: layout({
      preheader: `${who} edited ${request.ref}`, eyebrow: 'Request changed', title: 'Approve the changes',
      introHtml: `<strong>${esc(who)}</strong> from <strong>${esc(orgName || 'a client')}</strong> edited <strong>${esc(request.ref)} · ${esc(request.title)}</strong>. Review what changed and approve it to prepare an updated offer.`,
      buttonText: 'Review changes', buttonUrl: url, fineHtml: 'You get this email because you handle this request or are an admin.',
    }),
    text: `${who} (${orgName}) edited ${request.ref}. Review: ${url}`,
  };
}

export function changeDecidedEmail({ request, approved, note, url }) {
  return {
    subject: approved ? `Your changes to ${request.ref} were approved` : `Your changes to ${request.ref} were not accepted`,
    html: layout({
      preheader: approved ? 'We are preparing an updated offer.' : 'See the note from our team.',
      eyebrow: approved ? 'Changes approved' : 'Changes not accepted', title: approved ? 'Updated offer on the way' : 'Changes not accepted',
      introHtml: (approved
        ? `Your changes to <strong>${esc(request.ref)} · ${esc(request.title)}</strong> are now part of the request. We are preparing an updated offer.`
        : `We could not accept your changes to <strong>${esc(request.ref)} · ${esc(request.title)}</strong>. The request stays as it was.`)
        + (note ? `<br><br><em>“${esc(note)}”</em>` : ''),
      buttonText: 'Open the request', buttonUrl: url, fineHtml: 'Questions? Just reply to this email.',
    }),
    text: `${approved ? 'Approved' : 'Not accepted'}: your changes to ${request.ref}. ${note || ''} ${url}`,
  };
}
