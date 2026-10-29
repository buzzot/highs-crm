// Supplier Detail page — pure helpers (no database), so they are easy to test.
import { COMPANY_TYPES } from './supplier-company.js';
import { piTotal, paymentPlan } from './supplier-pi.js';

export const CRM_STATUS_KEYS = ['prospect', 'contacted', 'sampling', 'approved', 'active', 'on_hold', 'blocked'];

/** Edit-supplier drawer → { values, errors }. Lenient for staff: only the company name is required. Empty optional fields become null. */
export function validateSupplier(body, { statuses = CRM_STATUS_KEYS, thisYear = new Date().getFullYear() } = {}) {
  const s = k => String(body[k] ?? '').trim();
  const errors = {}, v = {};
  const max = { name: 200, contact_name: 120, email: 254, phone: 40, wechat: 80, website: 255, address: 500, city: 100, country: 80, postal_code: 20,
    registration_no: 60, employees: 40, main_products: 500, certifications: 300, payment_terms: 300, notes: 4000 };
  for (const [k, n] of Object.entries(max)) { v[k] = s(k); if (v[k].length > n) errors[k] = `Keep this under ${n} characters.`; }
  if (!v.name) errors.name = 'Company name is required.';
  v.email = v.email.toLowerCase();
  if (v.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) errors.email = 'Enter a valid email address, e.g. sales@factory.com.';
  const ph = v.phone.replace(/\s*(ext\.?|x)\s*\d{1,6}\s*$/i, '');
  if (v.phone && (!/^[+()\-.\s/#0-9]{5,40}$/.test(ph) || (ph.match(/\d/g) || []).length < 5)) errors.phone = 'Enter a valid phone number, e.g. +86 138 2581 4890.';
  if (v.website && (/\s/.test(v.website) || !/^(https?:\/\/)?[^\s/.]+(\.[^\s/.]+)+([/?#]\S*)?$/i.test(v.website))) errors.website = 'Enter a web address like www.factory.com.';
  v.company_type = COMPANY_TYPES[body.company_type] ? body.company_type : '';
  if (s('company_type') && !v.company_type) errors.company_type = 'Choose one of the listed types.';
  v.crm_status = statuses.includes(body.crm_status) ? body.crm_status : '';
  if (!v.crm_status) errors.crm_status = 'Choose a relationship status.';
  const year = s('year_established'); v.year_established = year;
  if (year && (!/^\d{4}$/.test(year) || Number(year) < 1800 || Number(year) > thisYear)) errors.year_established = `Use a 4-digit year between 1800 and ${thisYear}.`;
  const lead = s('lead_time_days'); v.lead_time_days = lead;
  if (lead && (!/^\d{1,3}$/.test(lead))) errors.lead_time_days = 'Days as a whole number, e.g. 30.';
  const rating = s('rating'); v.rating = rating;
  if (rating && !/^[1-5]$/.test(rating)) errors.rating = 'Choose 1 to 5 stars.';
  v.can_export_official = body.can_export_official === 'on';
  return { errors, values: v };
}

/** Values from validateSupplier → the row to save (empty → null, numbers as numbers). */
export function supplierPatch(values) {
  const out = {};
  for (const [k, x] of Object.entries(values)) out[k] = typeof x === 'boolean' ? x : (x === '' ? null : x);
  for (const k of ['year_established', 'lead_time_days', 'rating']) if (out[k] != null) out[k] = Number(out[k]);
  out.name = values.name;                       // never empty
  out.crm_status = values.crm_status;
  out.country = values.country || null;
  return out;
}

/** A new activity may bring a follow-up date; the supplier keeps ONE next follow-up, so the earlier of the two wins
 *  (to push it later, use Reschedule — a new date never silently replaces an earlier, still-open one). */
export function mergeFollowUp(current, incoming) {
  if (!incoming) return current || null;
  if (!current) return incoming;
  return incoming < current ? incoming : current;
}

/** One row per purchase order for the Purchasing tab, plus what is still to pay per currency.
 *  PI status and balances come from the supplier's PI and our recorded payments — never from payment terms or product prices.
 *  pis / payments: rows of supplier_pis / supplier_payments (any order). */
export function purchasingRows(pos, pis = [], payments = []) {
  const piBy = {}; for (const p of pis) { (piBy[p.po_id] ||= []).push(p); }
  const payBy = {}; for (const p of payments) { (payBy[p.po_id] ||= []).push(p); }
  const rows = (pos || []).map(po => {
    const list = (piBy[po.id] || []).slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const pi = list.find(x => x.status === 'confirmed') || list[0] || null;
    const piStatus = !pi ? 'none' : pi.status === 'confirmed' ? 'confirmed' : 'draft';
    const confirmed = pi && pi.status === 'confirmed';
    const plan = confirmed ? paymentPlan(piTotal(pi.lines) || pi.total, (payBy[po.id] || []).filter(x => x.currency === pi.currency)) : null;
    return { ...po, pi, piStatus, pay: plan ? plan.status : (piStatus === 'none' ? 'no_pi' : 'pi_draft'), piTotal: confirmed ? plan.total : null, piCurrency: pi?.currency || null, paid: plan ? plan.paid : null, open: plan ? plan.open : null };
  });
  const owed = {};
  for (const r of rows) if (r.open != null && r.open > 0.01 && !['cancelled', 'declined'].includes(r.status)) owed[r.piCurrency] = Math.round(((owed[r.piCurrency] || 0) + r.open) * 100) / 100;
  const live = rows.filter(r => !['cancelled', 'declined'].includes(r.status));
  return { rows, owed, open: live.filter(r => r.status !== 'confirmed').length, nLive: live.length };
}

export const PAY_LABEL = { no_pi: 'No PI yet', pi_draft: 'PI not confirmed', unpaid: 'Unpaid', partial: 'Part paid', paid: 'Paid', over: 'Overpaid' };
export const PI_LABEL = { none: 'No PI', draft: 'PI draft', confirmed: 'PI confirmed' };

/** Typed confirmation for deleting a supplier: the name must match (ignoring case and surrounding spaces). */
export const deleteConfirmed = (typed, name) => String(typed || '').trim().toLowerCase() === String(name || '').trim().toLowerCase() && !!String(name || '').trim();
