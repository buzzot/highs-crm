// Company details a supplier fills in on first sign-in (and can update later).
export const COMPANY_TYPES = { factory: 'Factory / manufacturer', trading: 'Trading company', both: 'Factory with own trading arm' };
export const SUPPLIER_FIELDS = ['name', 'company_type', 'registration_no', 'year_established', 'employees', 'country', 'city', 'postal_code', 'address',
  'website', 'contact_name', 'email', 'phone', 'wechat', 'main_products', 'certifications', 'payment_terms', 'lead_time_days', 'can_export_official'];

const s = v => String(v ?? '').trim();
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** @returns {{ data: object, errors: Record<string,string> }} */
export function validateSupplierCompany(body) {
  const data = {
    name: s(body.name), company_type: COMPANY_TYPES[body.company_type] ? body.company_type : null,
    registration_no: s(body.registration_no) || null, employees: s(body.employees) || null,
    country: s(body.country), city: s(body.city), postal_code: s(body.postal_code) || null, address: s(body.address),
    website: s(body.website) || null, contact_name: s(body.contact_name), email: s(body.email).toLowerCase(),
    phone: s(body.phone) || null, wechat: s(body.wechat) || null,
    main_products: s(body.main_products), certifications: s(body.certifications) || null,
    payment_terms: s(body.payment_terms) || null,
    can_export_official: body.can_export_official === 'on' || body.can_export_official === 'true' || body.can_export_official === true,
  };
  const year = s(body.year_established);
  data.year_established = /^\d{4}$/.test(year) ? Number(year) : null;
  const lead = s(body.lead_time_days);
  data.lead_time_days = /^\d{1,3}$/.test(lead) ? Number(lead) : null;

  const errors = {};
  if (!data.name) errors.name = 'Enter the company name.';
  if (!data.company_type) errors.company_type = 'Choose the type of company.';
  if (!data.country) errors.country = 'Enter the country.';
  if (!data.city) errors.city = 'Enter the city.';
  if (!data.address) errors.address = 'Enter the factory or office address.';
  if (!data.contact_name) errors.contact_name = 'Enter a contact person.';
  if (!EMAIL.test(data.email)) errors.email = 'Enter a valid email.';
  if (!data.phone && !data.wechat) errors.phone = 'Enter a phone number or WeChat ID.';
  if (!data.main_products) errors.main_products = 'Tell us what you make or sell.';
  if (year && !data.year_established) errors.year_established = 'Use a 4-digit year, e.g. 2008.';
  if (data.year_established && (data.year_established < 1800 || data.year_established > new Date().getFullYear())) errors.year_established = 'Check the year.';
  if (lead && data.lead_time_days == null) errors.lead_time_days = 'Days as a number, e.g. 30.';
  return { data, errors };
}
