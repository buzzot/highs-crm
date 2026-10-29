// Shared bits for the supplier and client pages: activity types and last sign-in lookup.
import { admin } from './supabase.js';

import { ACTIVITY_TYPES } from './crm-forms.js';
export { ACTIVITY_TYPES, validateActivity, validateCompany } from './crm-forms.js';

/** Validated activity form → { type, summary, date, follow } or { error }. */
export function readActivity(body) {
  const type = ACTIVITY_TYPES[body.type] ? body.type : 'note';
  const summary = String(body.summary || '').trim().slice(0, 2000);
  const iso = v => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
  if (!summary) return { error: 'Write a short summary of the activity.' };
  const next = String(body.next_action || '').trim().slice(0, 300);
  return { type, summary, date: iso(body.date) || new Date().toISOString().slice(0, 10), follow: iso(body.follow_up), next: next || null };
}

/** Fill last_login_at from Supabase's own record for people who signed in before we recorded it. */
export async function withLastLogin(users) {
  for (const u of users || []) {
    if (!u.last_login_at && u.accepted_at) {
      const { data } = await admin.auth.admin.getUserById(u.id).catch(() => ({ data: null }));
      u.last_login_at = data?.user?.last_sign_in_at || null;
    }
  }
  return users || [];
}
