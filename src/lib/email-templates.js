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
${o.buttonUrl ? `            <tr><td style="padding:0 40px 30px;">
              <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#0b8a7a;border-radius:12px;">
                <a href="${url}" style="display:inline-block;padding:17px 34px;font-family:${FONT};font-size:18px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:12px;">${esc(o.buttonText)} &rarr;</a>
              </td></tr></table>
            </td></tr>
` : ''}
            <tr><td style="padding:10px 40px 36px;font-family:${FONT};font-size:14px;line-height:1.6;color:#7a8494;border-top:1px solid #eef0f3;">
              <div style="padding-top:18px;">${o.fineHtml}</div>
              ${o.buttonUrl ? `<div style="padding-top:10px;">Button not working? Copy this link into your browser:<br><a href="${url}" style="color:#2a62b8;word-break:break-all;">${url}</a></div>` : ''}
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
  const where = supplier ? 'the Lumi Trade portal as a supplier' : orgName ? `the Lumi Trade portal as a client of ${orgName}` : 'the Lumi Trade team';
  const what = supplier
    ? 'Register your company: confirm this email, fill in your company and contact details and create a password. After that you can keep your details and product information up to date.'
    : 'Send sourcing requests, approve quotes and follow every order and shipment in one place.';
  return {
    subject: supplier ? 'Lumi Trade invites you to register as a supplier' : "You're invited to the Lumi Trade portal",
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

export function newRequestEmail({ request, orgName, who, products, url, kind }) {
  const order = kind === 'order';
  return {
    subject: `${order ? 'New order' : 'New request'} ${request.ref} from ${orgName || 'a client'}`,
    html: layout({
      preheader: `${who} sent ${request.ref}`, eyebrow: order ? 'New order' : 'New sourcing request', title: order ? 'A client sent an order' : 'A client sent a request',
      introHtml: `<strong>${esc(who)}</strong> from <strong>${esc(orgName || 'a client')}</strong> sent <strong>${esc(request.ref)} · ${esc(request.title)}</strong>${products > 1 ? ` (${products} products)` : ''}. Open it to start sourcing.`,
      buttonText: order ? 'Open order' : 'Open request', buttonUrl: url, fineHtml: 'You get this email because you handle this request or are an admin.',
    }),
    text: `${order ? 'New order' : 'New request'} ${request.ref} from ${orgName || 'a client'} (${who}). Open: ${url}`,
  };
}

// ---- offer sent to the client ----
export function quoteSentEmail({ request, validUntil, leadTimeDays, url, count, total, currency, attached, notes, line }) {
  const facts = [validUntil ? `valid until ${validUntil}` : null, leadTimeDays ? `lead time ${leadTimeDays} days` : null].filter(Boolean).join(' · ');
  const money = v => `${currency || ''} ${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim();
  const sum = count > 1 && total != null ? `${count} products, total ${money(total)}` : '';
  // a single product: show quantity, unit price and the total right in the email
  const one = line && count <= 1 ? `${Number(line.quantity).toLocaleString('en-US')} × ${money(line.unit_price)} = ${money(line.total)}${line.logistics > 0 ? ` (goods ${money(line.goods)} + estimated freight & logistics ${money(line.logistics)})` : ''}` : '';
  const note = String(notes || '').trim();
  const noteHtml = note ? `<br><br><strong>Note from us:</strong><br>${esc(note).replace(/\n/g, '<br>')}` : '';
  return {
    subject: `Your offer for ${request.ref} is ready`,
    html: layout({
      preheader: `We prepared an offer for ${request.ref}.`, eyebrow: 'New offer', title: 'Your offer is ready',
      introHtml: `We prepared an offer for <strong>${esc(request.ref)} · ${esc(request.title)}</strong>${facts ? ` (${esc(facts)})` : ''}.${sum ? ` It covers ${esc(sum)}.` : ''}${one ? `<br><br><strong>${esc(one)}</strong>` : ''}${noteHtml}<br><br>${attached ? 'The quotation is attached. ' : ''}Open it in your portal to review the price and accept it.`,
      buttonText: 'View the offer', buttonUrl: url, fineHtml: 'Questions? Just reply to this email.',
    }),
    text: `Your offer for ${request.ref} is ready${facts ? ` (${facts})` : ''}${sum ? `. ${sum}` : ''}${one ? `. ${one}` : ''}.${note ? `\n\nNote from us:\n${note}` : ''}\n\nView it: ${url}`,
  };
}

// ---- purchase orders and proforma invoices ----
export function poSubmittedEmail({ po, orgName, who, url }) {
  return {
    subject: `Purchase order ${po.po_no} from ${orgName || 'a client'} — approval needed`,
    html: layout({
      preheader: `${who} sent ${po.po_no}`, eyebrow: 'New purchase order', title: 'Review the purchase order',
      introHtml: `<strong>${esc(who)}</strong> from <strong>${esc(orgName || 'a client')}</strong> sent purchase order <strong>${esc(po.po_no)}</strong> (${esc(po.currency)} ${Number(po.total).toLocaleString('en-US', { minimumFractionDigits: 2 })}). Check every detail, add comments if needed, then approve it to create the order. The PO is attached as a PDF.`,
      buttonText: 'Review the PO', buttonUrl: url, fineHtml: 'You get this email because you handle this request or are an admin.',
    }),
    text: `${who} (${orgName}) sent purchase order ${po.po_no}. Review: ${url}`,
  };
}

export function poRejectedEmail({ po, note, url }) {
  return {
    subject: `Your purchase order ${po.po_no} needs changes`,
    html: layout({
      preheader: 'See the note from our team.', eyebrow: 'Purchase order', title: 'We could not accept the purchase order yet',
      introHtml: `We could not accept <strong>${esc(po.po_no)}</strong> as sent.` + (note ? `<br><br><em>“${esc(note)}”</em>` : ''),
      buttonText: 'Open the request', buttonUrl: url, fineHtml: 'Questions? Just reply to this email.',
    }),
    text: `We could not accept ${po.po_no}. ${note || ''} ${url}`,
  };
}

export function piEmail({ pi, order, company, total, currency, schedule = [], message, url }) {
  const fm = n => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2 });
  const sched = schedule.length ? '<br><br>Payment schedule:<br>' + schedule.map(x => `${esc(x.label)} (${Number(x.percent)}%): <strong>${esc(currency)} ${fm(x.amount)}</strong>${x.due ? ' · due ' + esc(x.due) : ''}`).join('<br>') + '<br><br>After paying, open your order, upload the proof of payment and enter the amount.' : '';
  return {
    subject: `Proforma invoice ${pi.pi_no} · order ${order.order_no}`,
    html: layout({
      preheader: `Proforma invoice ${pi.pi_no} for order ${order.order_no}`, eyebrow: 'Proforma invoice', title: `Order ${esc(order.order_no)} is confirmed`,
      introHtml: `Thank you for your purchase order. Please find the proforma invoice <strong>${esc(pi.pi_no)}</strong> attached (${esc(currency)} ${Number(total).toLocaleString('en-US', { minimumFractionDigits: 2 })}).` + sched + (message ? `<br><br>${esc(message).replace(/\n/g, '<br>')}` : ''),
      buttonText: 'Open your order', buttonUrl: url, fineHtml: `${esc(company?.name || 'Lumi Trade')} · reply to this email with any questions.`,
    }),
    text: `Proforma invoice ${pi.pi_no} for order ${order.order_no} is attached (${currency} ${total}). ${message || ''} ${url}`,
  };
}

/** Shipping documents sent by hand (for clients who don't use their cabinet). Files are attached. */
export function documentsEmail({ order, docs, company, message }) {
  const list = docs.map(d => `<li>${esc(d.title)}</li>`).join('');
  return {
    subject: `Documents for order ${order.order_no} · ${company?.name || 'Lumi Trade'}`,
    html: layout({
      preheader: `${docs.length} document${docs.length === 1 ? '' : 's'} attached for order ${order.order_no}`, eyebrow: 'Shipping documents', title: `Order ${esc(order.order_no)}`,
      introHtml: `Please find attached:<ul style="margin:10px 0 0;padding-left:20px;">${list}</ul>` + (message ? `<br>${esc(message).replace(/\n/g, '<br>')}` : ''),
      fineHtml: `${esc(company?.name || 'Lumi Trade')} · reply to this email with any questions.`,
    }),
    text: `Documents for order ${order.order_no}: ${docs.map(d => d.title).join(', ')}. ${message || ''}`,
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

// ---- freight quote request to a forwarder (packing list in the body + Excel attached) ----
export function rfqEmail({ order, info = {}, rows, t, message, senderName, forwarderName }) {
  const pkg = rows.some(x => x.package_type);   // a draft packing list from an RFQ: packages of a type (Roll, Drum…) with a unit (m, kg…)
  const F = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const n = v => (v == null || v === '' ? '' : Number(v).toLocaleString('en-US'));
  const td = (v, right) => `<td style="padding:7px 8px;border-bottom:1px solid #eef0f3;font-size:13px;color:#16202e;${right ? 'text-align:right;' : ''}">${esc(v ?? '')}</td>`;
  const th = (v, right) => `<th style="padding:7px 8px;border-bottom:2px solid #dfe3e8;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#7a8494;text-align:${right ? 'right' : 'left'};">${esc(v)}</th>`;
  const facts = [
    ['Mode', info.mode], ['From', info.pol], ['To', info.pod], ['Incoterm', info.incoterm], ['Cargo ready', info.ready_date],
    ...(rows.some(x => x.package_type) ? [['Packages', t.pkgSummary], ['Quantity', t.qtySummary]] : [['Cartons', n(t.cartons)], ['Pieces', n(t.pieces)]]), ['Gross weight', `${n(t.gross)} kg`], ['Volume', `${t.cbm} cbm`],
    ['Shipping marks', info.marks], ['Cargo notes', info.remarks],
  ].filter(([, v]) => v !== undefined && v !== null && v !== '');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#f1f3f6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f3f6;"><tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:760px;background:#fff;border:1px solid #e3e6eb;border-radius:14px;">
<tr><td style="padding:26px 30px 6px;font-family:${F};">
  <div style="font-size:20px;font-weight:700;color:#0f3d5c;">Lumi<span style="color:#0b8a7a;">Trade</span></div>
  <div style="margin-top:14px;font-size:22px;font-weight:700;color:#16202e;">Freight quote request · ${esc(order.order_no)}</div>
  <p style="font-size:15px;line-height:1.6;color:#2f3a4a;">Dear ${esc(forwarderName || 'partner')},<br>please quote freight for the shipment below${info.mode ? ` (${esc(info.mode)})` : ''}. The attached Excel has a <strong style="font-weight:600;">quotation form</strong> (first sheet) and the full packing list.</p>
  ${message ? `<p style="font-size:15px;line-height:1.6;color:#2f3a4a;white-space:pre-line;">${esc(message)}</p>` : ''}
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:10px 0 18px;font-size:14px;">${facts.map(([k, v]) => `<tr><td style="padding:3px 18px 3px 0;color:#7a8494;">${esc(k)}</td><td style="padding:3px 0;color:#16202e;">${esc(v)}</td></tr>`).join('')}</table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-family:${F};">
    <tr>${pkg ? th('No.') + th('Package') + th('Description') + th('Pkgs', 1) + th('Qty/pkg', 1) + th('L×W×H cm', 1) + th('GW/pkg kg', 1) + th('Total CBM', 1) : th('CTN No.') + th('Description') + th('Ctns', 1) + th('Pcs/ctn', 1) + th('L×W×H cm', 1) + th('GW/ctn kg', 1) + th('Total CBM', 1)}</tr>
    ${pkg ? rows.map(x => `<tr>${td(x.carton_no)}${td(x.package_type)}${td([x.description, x.sku].filter(Boolean).join(' · '))}${td(n(x.cartons), 1)}${td(n(x.quantity) + ' ' + (x.unit || ''), 1)}${td(x.length_cm ? `${Number(x.length_cm)}×${Number(x.width_cm)}×${Number(x.height_cm)}` : '', 1)}${td(n(x.gross_weight_kg), 1)}${td(x.length_cm ? (x.length_cm * x.width_cm * x.height_cm / 1e6 * x.cartons).toFixed(3) : '', 1)}</tr>`).join('') : ''}
    ${pkg ? '' : rows.map(x => `<tr>${td(x.carton_no)}${td([x.description, x.sku].filter(Boolean).join(' · '))}${td(n(x.cartons), 1)}${td(n(x.quantity), 1)}${td(x.length_cm ? `${Number(x.length_cm)}×${Number(x.width_cm)}×${Number(x.height_cm)}` : '', 1)}${td(n(x.gross_weight_kg), 1)}${td(x.length_cm ? (x.length_cm * x.width_cm * x.height_cm / 1e6 * x.cartons).toFixed(3) : '', 1)}</tr>`).join('')}
    ${pkg ? `<tr><td style="padding:8px;font-weight:700;font-size:13px;">TOTAL</td><td></td><td></td><td style="padding:8px;text-align:right;font-weight:700;font-size:13px;">${n(t.cartons)}</td><td></td><td></td><td style="padding:8px;text-align:right;font-weight:700;font-size:13px;">${n(t.gross)} kg</td><td style="padding:8px;text-align:right;font-weight:700;font-size:13px;">${t.cbm}</td></tr>` : `<tr><td style="padding:8px;font-weight:700;font-size:13px;">TOTAL</td><td></td><td style="padding:8px;text-align:right;font-weight:700;font-size:13px;">${n(t.cartons)}</td><td></td><td></td><td style="padding:8px;text-align:right;font-weight:700;font-size:13px;">${n(t.gross)} kg</td><td style="padding:8px;text-align:right;font-weight:700;font-size:13px;">${t.cbm}</td></tr>`}
  </table>
  <p style="font-size:15px;line-height:1.6;color:#2f3a4a;margin-top:20px;">Please fill in the yellow cells of the quotation form: your contact details, date quoted and validity, main freight (unit price per kg or cbm), documentation and any extra service, the total, shipping date, and whether you pick up from our supplier or the supplier delivers to your warehouse.<br><span style="color:#6b7686;font-size:14px;">请填写报价单黄色部分：联系人信息、报价日期及有效期、主运费单价（按公斤或立方）、文件费及其他服务、总价、开船日期，以及上门提货或送货入仓。</span></p>
  <div style="margin:16px 0 18px;padding:12px 16px;border:1px solid #f1c2c2;border-left:4px solid #c62828;border-radius:8px;background:#fdf3f3;font-size:14px;line-height:1.6;color:#c62828;">
    <strong style="font-weight:600;">Important: please send your quote by replying to this email.</strong><br>
    Quotes sent as a new email are not received by our system. Email is a must; a copy may also be sent via WeChat.
    <div style="margin-top:6px;color:#b23b3b;font-size:13px;">重要：请直接回复本邮件报价。新建邮件发送的报价我们无法收到。必须通过邮件报价，副本可同时发微信。</div>
  </div>
  <p style="font-size:15px;color:#2f3a4a;">Best regards,<br><span style="color:#6b7686;">Logistics Department</span><br><strong style="font-weight:600;color:#0f3a5c;">Lumi Trade</strong></p>
</td></tr>
<tr><td style="padding:14px 30px 24px;font-family:${F};font-size:12px;color:#7a8494;border-top:1px solid #eef0f3;">Lumi Trade · Sourcing, orders and shipments in one place</td></tr>
</table></td></tr></table></body></html>`;
  const text = [`Freight quote request — ${order.order_no}`, ...facts.map(([k, v]) => `${k}: ${v}`), '', message || '', 'Attached Excel: quotation form (first sheet) and packing list.', '', 'Please fill in the yellow cells of the quotation form: contact details, date quoted and validity, main freight (unit price per kg or cbm), documentation and extra service, the total, shipping date, and pickup from our supplier or delivery to your warehouse.', '', 'IMPORTANT: please send your quote by REPLYING to this email. Quotes sent as a new email are not received by our system. Email is a must; a copy may also be sent via WeChat.', '重要：请直接回复本邮件报价。新建邮件发送的报价我们无法收到。必须通过邮件报价，副本可同时发微信。', '', 'Best regards,', 'Logistics Department', 'Lumi Trade'].join('\n');
  return { subject: `Freight quote request · ${order.order_no}${info.mode ? ' · ' + info.mode : ''}${info.pol && info.pod ? ` · ${info.pol} → ${info.pod}` : ''}`, html, text };
}

// ---- booking confirmation to the forwarder whose quote we accepted ----
export function bookingEmail({ order, info = {}, t, ref, quoteSummary, amount, etd, eta, forwarderName, message }) {
  const F = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const route = [info.pol, info.pod].filter(Boolean).join(' → ');
  const facts = [['Request', ref], ['Order', order.order_no], ['Mode', info.mode], ['Route', route], ['Incoterm', info.incoterm],
    ['Cargo', `${t.cartons} ctns · ${t.gross} kg · ${t.cbm} cbm`], ['Shipping date (ETD)', etd], ['ETA', eta], ['Agreed amount', amount], ['Your quote', quoteSummary]].filter(([, v]) => v);
  const asks = [
    ['Loading port / terminal', '装货港/码头'],
    ['Direct or transshipment (if transshipment, where)', '直达还是中转（如中转请注明中转港）'],
    ['Latest date to receive the goods (warehouse / cut-off)', '最晚收货日期（仓库/截仓）'],
  ];
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#f1f3f6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f3f6;"><tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#fff;border:1px solid #e3e6eb;border-radius:14px;">
<tr><td style="padding:26px 30px 24px;font-family:${F};">
  <div style="font-size:20px;font-weight:700;color:#0f3d5c;">Lumi<span style="color:#0b8a7a;">Trade</span></div>
  <div style="margin-top:14px;font-size:22px;font-weight:700;color:#16202e;">Booking confirmation · ${esc(order.order_no)}</div>
  <p style="font-size:15px;line-height:1.6;color:#2f3a4a;">Dear ${esc(forwarderName || 'partner')},<br>thank you for your quotation. We accept it and would like to <strong style="font-weight:600;">confirm the booking</strong> with you.<br><span style="color:#6b7686;font-size:14px;">感谢您的报价。我们接受此报价，现确认订舱。</span></p>
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 16px;font-size:14px;">${facts.map(([k, v]) => `<tr><td style="padding:3px 18px 3px 0;color:#7a8494;vertical-align:top;">${esc(k)}</td><td style="padding:3px 0;color:#16202e;">${esc(v)}</td></tr>`).join('')}</table>
  ${message ? `<p style="font-size:15px;line-height:1.6;color:#2f3a4a;white-space:pre-line;">${esc(message)}</p>` : ''}
  <p style="font-size:15px;line-height:1.6;color:#2f3a4a;margin-bottom:6px;">Please reply with:</p>
  <ol style="margin:0 0 16px;padding-left:20px;font-size:15px;line-height:1.7;color:#2f3a4a;">${asks.map(([en, cn]) => `<li>${esc(en)}<br><span style="color:#6b7686;font-size:13px;">${esc(cn)}</span></li>`).join('')}</ol>
  <p style="font-size:15px;line-height:1.6;color:#2f3a4a;">Also welcome: vessel / flight name, ETD and ETA, booking number, and where and how our supplier should deliver or when you will pick up.<br><span style="color:#6b7686;font-size:13px;">另请提供：船名/航班、ETD/ETA、订舱号，以及供应商送货方式或提货时间。</span></p>
  <div style="margin:16px 0 18px;padding:12px 16px;border:1px solid #f1c2c2;border-left:4px solid #c62828;border-radius:8px;background:#fdf3f3;font-size:14px;line-height:1.6;color:#c62828;">
    <strong style="font-weight:600;">Important: please reply to this email.</strong> Replies sent as a new email are not received by our system.
    <div style="margin-top:6px;color:#b23b3b;font-size:13px;">重要：请直接回复本邮件。新建邮件发送的内容我们无法收到。</div>
  </div>
  <p style="font-size:15px;color:#2f3a4a;">Best regards,<br><span style="color:#6b7686;">Logistics Department</span><br><strong style="font-weight:600;color:#0f3a5c;">Lumi Trade</strong></p>
</td></tr>
<tr><td style="padding:14px 30px 24px;font-family:${F};font-size:12px;color:#7a8494;border-top:1px solid #eef0f3;">Lumi Trade · Sourcing, orders and shipments in one place</td></tr>
</table></td></tr></table></body></html>`;
  const txt = [`Booking confirmation — ${order.order_no}`, '', `Dear ${forwarderName || 'partner'},`, 'Thank you for your quotation. We accept it and confirm the booking.', '',
    ...facts.map(([k, v]) => `${k}: ${v}`), '', message || null, message ? '' : null, 'Please reply with:', ...asks.map(([en, cn], i) => `${i + 1}. ${en} / ${cn}`), '',
    'Also welcome: vessel/flight, ETD/ETA, booking number, and how our supplier should deliver or when you will pick up.', '',
    'IMPORTANT: please reply to this email. Replies sent as a new email are not received by our system.', '重要：请直接回复本邮件。新建邮件发送的内容我们无法收到。', '',
    'Best regards,', 'Logistics Department', 'Lumi Trade'].filter(l => l !== null).join('\n');
  return { subject: `Booking confirmation · ${order.order_no}${route ? ' · ' + route : ''}`, html, text: txt };
}

export function paymentSubmittedEmail({ order, amount, who, orgName, status, url }) {
  const amt = `${order.currency} ${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  return {
    subject: `Payment ${amt} reported for order ${order.order_no}`,
    html: layout({
      preheader: `${who} reported a payment`, eyebrow: 'Payment to confirm', title: 'A client reported a payment',
      introHtml: `<strong>${esc(who)}</strong> from <strong>${esc(orgName || 'a client')}</strong> reported a payment of <strong>${esc(amt)}</strong> for order <strong>${esc(order.order_no)}</strong> and uploaded the proof. Check it against the bank statement, then confirm or reject it. Order payment status now: ${status === 'paid' ? 'paid' : 'partially paid'}.`,
      buttonText: 'Open the order', buttonUrl: url, fineHtml: 'You get this email because you handle this request or are an admin.',
    }),
    text: `${who} (${orgName}) reported a payment of ${amt} for order ${order.order_no}. Confirm: ${url}`,
  };
}

export function paymentDecidedEmail({ order, amount, confirmed, note, url }) {
  const amt = `${order.currency} ${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  return {
    subject: confirmed ? `Payment ${amt} received · order ${order.order_no}` : `Payment ${amt} could not be confirmed · order ${order.order_no}`,
    html: layout({
      preheader: confirmed ? 'We received your payment.' : 'Please check the note from our team.',
      eyebrow: 'Payment', title: confirmed ? 'Payment received' : 'We could not confirm the payment',
      introHtml: confirmed
        ? `We confirmed your payment of <strong>${esc(amt)}</strong> for order <strong>${esc(order.order_no)}</strong>. Thank you!`
        : `We could not confirm your payment of <strong>${esc(amt)}</strong> for order <strong>${esc(order.order_no)}</strong>.` + (note ? `<br><br><em>“${esc(note)}”</em>` : '') + '<br><br>Please check the transfer and upload the proof again.',
      buttonText: 'Open your order', buttonUrl: url, fineHtml: 'Questions? Just reply to this email.',
    }),
    text: confirmed ? `Payment ${amt} for order ${order.order_no} confirmed. ${url}` : `Payment ${amt} for order ${order.order_no} could not be confirmed. ${note || ''} ${url}`,
  };
}


// ---- purchase order to a supplier (PDF attached; asks for confirmation, PI and an estimated packing list) ----
export function spoEmail({ po, supplier, order, message, senderName }) {
  const F = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const n = v => Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 4 });
  const money = v => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const td = (v, right) => `<td style="padding:7px 8px;border-bottom:1px solid #eef0f3;font-size:13px;color:#16202e;${right ? 'text-align:right;' : ''}">${esc(v ?? '')}</td>`;
  const th = (v, right) => `<th style="padding:7px 8px;border-bottom:2px solid #dfe3e8;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#7a8494;text-align:${right ? 'right' : 'left'};">${esc(v)}</th>`;
  const facts = [['PO number', po.ref], ['Our order', order?.order_no], ['Required by', po.required_date], ['Payment terms', po.payment_terms], ['Ship to', po.ship_to], ['Currency', po.currency]].filter(([, v]) => v);
  const asks = [
    ['Confirm the order by replying to this email (price, quantity, and the date the goods will be ready).', '请回复本邮件确认订单（价格、数量及备货完成日期）。'],
    ['Send your proforma invoice (PI).', '请提供形式发票（PI）。'],
    ...(po.want_packing ? [['Send an ESTIMATED packing list: cartons, pieces per carton, carton size, gross and net weight per carton. You can use the attached Excel.', '请提供预估装箱单：箱数、每箱数量、箱规、每箱毛重/净重。可使用附件 Excel。']] : []),
  ];
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#f1f3f6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f3f6;"><tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:720px;background:#fff;border:1px solid #e3e6eb;border-radius:14px;">
<tr><td style="padding:26px 30px 6px;font-family:${F};">
  <div style="font-size:20px;font-weight:700;color:#0f3d5c;">Lumi<span style="color:#0b8a7a;">Trade</span></div>
  <div style="margin-top:14px;font-size:22px;font-weight:700;color:#16202e;">Purchase order ${esc(po.ref)}</div>
  <p style="font-size:15px;line-height:1.6;color:#2f3a4a;">Dear ${esc(supplier?.contact_name || supplier?.name || 'partner')},<br>please find our purchase order attached (PDF). The items are listed below.</p>
  ${message ? `<p style="font-size:15px;line-height:1.6;color:#2f3a4a;white-space:pre-line;">${esc(message)}</p>` : ''}
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:10px 0 18px;font-size:14px;">${facts.map(([k, v]) => `<tr><td style="padding:3px 18px 3px 0;color:#7a8494;">${esc(k)}</td><td style="padding:3px 0;color:#16202e;">${esc(v)}</td></tr>`).join('')}</table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-family:${F};">
    <tr>${th('Product')}${th('SKU')}${th('Qty', 1)}${th('Unit price', 1)}${th('Amount', 1)}</tr>
    ${po.lines.map(l => `<tr>${td(l.description)}${td(l.sku)}${td(`${n(l.quantity)} ${l.unit || 'pcs'}`, 1)}${td(Math.abs(l.unit_price) < 0.1 && l.unit_price ? n(l.unit_price) : money(l.unit_price), 1)}${td(money(l.quantity * l.unit_price), 1)}</tr>`).join('')}
    <tr><td colspan="4" style="padding:8px;text-align:right;font-weight:700;font-size:13px;">TOTAL ${esc(po.currency)}</td><td style="padding:8px;text-align:right;font-weight:700;font-size:13px;">${money(po.total)}</td></tr>
  </table>
  <p style="font-size:15px;line-height:1.6;color:#2f3a4a;margin:20px 0 6px;"><strong style="font-weight:600;">Please reply to this email to:</strong></p>
  <ol style="margin:0 0 14px 18px;padding:0;font-size:15px;line-height:1.6;color:#2f3a4a;">${asks.map(([en, zh]) => `<li>${esc(en)}<br><span style="color:#6b7686;font-size:14px;">${esc(zh)}</span></li>`).join('')}</ol>
  <div style="margin:16px 0 18px;padding:12px 16px;border:1px solid #f1c2c2;border-left:4px solid #c62828;border-radius:8px;background:#fdf3f3;font-size:14px;line-height:1.6;color:#c62828;">
    <strong style="font-weight:600;">Important: please answer by replying to this email</strong> and keep the reference ${esc(po.ref)} in the subject.<br>
    Replies sent as a new email may not reach our system. A copy via WeChat is welcome.
    <div style="margin-top:6px;color:#b23b3b;font-size:13px;">重要：请直接回复本邮件，并保留主题中的编号 ${esc(po.ref)}。新建邮件可能无法被系统接收，可同时发微信。</div>
  </div>
  <p style="font-size:15px;color:#2f3a4a;">Best regards,<br>${senderName ? `${esc(senderName)}<br>` : ''}<strong style="font-weight:600;color:#0f3a5c;">Lumi Trade</strong></p>
</td></tr>
<tr><td style="padding:14px 30px 24px;font-family:${F};font-size:12px;color:#7a8494;border-top:1px solid #eef0f3;">Lumi Trade · Purchasing</td></tr>
</table></td></tr></table></body></html>`;
  const text = [`Purchase order ${po.ref}`, ...facts.map(([k, v]) => `${k}: ${v}`), '', ...po.lines.map(l => `- ${l.description}${l.sku ? ' (' + l.sku + ')' : ''}: ${l.quantity} ${l.unit || 'pcs'} x ${l.unit_price} = ${money(l.quantity * l.unit_price)}`), `TOTAL ${po.currency} ${money(po.total)}`, '', message || '', 'Please reply to this email to:', ...asks.map(([en, zh], i) => `${i + 1}. ${en}\n   ${zh}`), '', `Important: answer by REPLYING to this email and keep ${po.ref} in the subject. 重要：请直接回复本邮件。`, '', 'Best regards,', senderName || '', 'Lumi Trade'].join('\n');
  return { subject: `Purchase order ${po.ref}${order?.order_no ? ' · ' + order.order_no : ''}`, html, text };
}
