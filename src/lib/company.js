// Client company details — completed by the client on first sign-in, editable later by client and staff.
export const COMPANY_FIELDS = ['name', 'registration_no', 'tax_id', 'country', 'city', 'postal_code', 'address', 'delivery_address', 'phone', 'email', 'website', 'default_currency'];
export const REQUIRED = { name: 'Company name', country: 'Country', city: 'City', address: 'Street address', phone: 'Company phone', email: 'Company email' };
const CURRENCIES = ['USD', 'EUR', 'GBP', 'CNY'];

/** Clean a posted form. @returns {{ data, errors: {field: message} }} */
export function validateCompany(body = {}) {
  const data = {};
  for (const k of COMPANY_FIELDS) data[k] = String(body[k] ?? '').trim() || null;
  const errors = {};
  for (const [k, label] of Object.entries(REQUIRED)) if (!data[k]) errors[k] = `${label} is required.`;
  if (data.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.email)) errors.email = 'Enter a valid email address.';
  if (data.phone && data.phone.replace(/\D/g, '').length < 6) errors.phone = 'Enter a full phone number with country code.';
  if (data.website && !/^https?:\/\//i.test(data.website)) data.website = `https://${data.website}`;
  if (!CURRENCIES.includes(data.default_currency)) data.default_currency = 'USD';
  return { data, errors };
}

export const isComplete = org => !!org?.details_completed_at;
