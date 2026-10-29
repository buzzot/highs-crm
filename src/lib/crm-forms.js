// Form validation for the client page — pure functions (no database), so they are easy to test.
export const ACTIVITY_TYPES = { call: 'Call', wechat: 'WeChat', email: 'Email', meeting: 'Meeting', visit: 'Visit', sample: 'Sample', note: 'Note' };

/** Add-activity form → { values, errors } with a message per field (the form is shown again with what was typed). */
export function validateActivity(body, today = new Date().toISOString().slice(0, 10)) {
  const ok = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && !Number.isNaN(Date.parse(v));
  const s = k => String(body[k] ?? '').trim();
  const errors = {}, date = s('date') || today, follow = s('follow_up');
  const summary = s('summary'), next = s('next_action');
  if (!summary) errors.summary = 'Write a short summary of the activity.';
  else if (summary.length > 2000) errors.summary = 'Keep the summary under 2000 characters.';
  if (!ok(date)) errors.date = 'Enter a valid date.';
  if (next.length > 300) errors.next_action = 'Keep the next action under 300 characters.';
  if (follow && !ok(follow)) errors.follow_up = 'Enter a valid date.';
  else if (follow && ok(date) && follow < date) errors.follow_up = 'The follow-up cannot be before the activity date.';
  return { errors, values: { type: ACTIVITY_TYPES[body.type] ? body.type : 'note', summary, date, next_action: next, follow_up: follow, owner_id: s('owner_id') } };
}

/** Company-details form → { values, errors } (a message per field). Empty optional fields become null. */
export function validateCompany(body, { currencies = ['USD', 'EUR', 'GBP', 'CNY'], keepCurrency = null } = {}) {
  const s = k => String(body[k] ?? '').trim();
  const errors = {}, v = {};
  const max = { name: 200, registration_no: 60, tax_id: 60, address: 500, postal_code: 20, city: 100, country: 80, delivery_address: 500, phone: 40, email: 254, website: 255, notes: 4000 };
  for (const [k, n] of Object.entries(max)) { v[k] = s(k); if (v[k].length > n) errors[k] = `Keep this under ${n} characters.`; }
  if (!v.name) errors.name = 'Company name is required.';
  if (v.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) errors.email = 'Enter a valid email address, e.g. buyer@company.com.';
  const ph = v.phone.replace(/\s*(ext\.?|x)\s*\d{1,6}\s*$/i, '');
  if (v.phone && (!/^[+()\-.\s/#0-9]{5,40}$/.test(ph) || (ph.match(/\d/g) || []).length < 5)) errors.phone = 'Enter a valid phone number, e.g. +1 415 555 0100.';
  if (v.website && (/\s/.test(v.website) || !/^(https?:\/\/)?[^\s/.]+(\.[^\s/.]+)+([/?#]\S*)?$/i.test(v.website))) errors.website = 'Enter a web address like www.company.com.';
  const cur = s('default_currency'); v.default_currency = cur;
  if (cur && !currencies.includes(cur) && cur !== keepCurrency) errors.default_currency = 'Choose one of the listed currencies.';
  v.language = s('language'); v.active = body.active === 'on';
  return { errors, values: v };
}

