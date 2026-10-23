// Which language to write to a person or company in. A person's own choice wins over the company default; English if unknown.
import { admin } from './supabase.js';

export const normLang = v => (v === 'ru' ? 'ru' : 'en');

/** Company default. Never throws (the column may not exist before migration 0032). */
export async function orgLang(orgId) {
  if (!orgId) return 'en';
  try { const { data } = await admin.from('organizations').select('language').eq('id', orgId).maybeSingle(); return normLang(data?.language); } catch { return 'en'; }
}

/** Language for emails to one address: the person's own setting, else their company's. */
export async function emailLang(email) {
  try {
    const { data: p } = await admin.from('profiles').select('role, language, org_id').ilike('email', String(email || '').trim()).maybeSingle();
    if (!p || p.role !== 'client') return 'en';
    return p.language ? normLang(p.language) : await orgLang(p.org_id);
  } catch { return 'en'; }
}

/** Company language for a request / an order (for emails that only know those). */
export async function requestLang(requestId) {
  try { const { data } = await admin.from('requests').select('org_id').eq('id', requestId).maybeSingle(); return orgLang(data?.org_id); } catch { return 'en'; }
}
export async function orderLang(orderId) {
  try { const { data } = await admin.from('orders').select('org_id').eq('id', orderId).maybeSingle(); return orgLang(data?.org_id); } catch { return 'en'; }
}

/** Language of the company an invitation belongs to (the invitation page and its emails always use it). */
export async function inviteLang(token) {
  try {
    if (!token || token.length < 20) return null;
    const { data } = await admin.from('invitations').select('org_id, role').eq('token', token).maybeSingle();
    return data?.role === 'client' ? orgLang(data.org_id) : 'en';
  } catch { return null; }
}
