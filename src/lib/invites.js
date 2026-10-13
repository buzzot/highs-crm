import { admin } from './supabase.js';

/**
 * Invite a user by email. Supabase Auth sends the email (configure the "Invite user" template
 * in Supabase → Authentication → Email Templates; redirect URL = APP_URL/auth/accept).
 * The DB trigger handle_new_user() reads the invitations row to assign role + org.
 */
export async function inviteUser({ email, role = 'client', orgId = null, invitedBy = null }) {
  email = String(email).trim().toLowerCase();
  if (role === 'client' && !orgId) throw new Error('Client invites need an organization.');

  const { error: iErr } = await admin.from('invitations').insert({ email, role, org_id: orgId, invited_by: invitedBy });
  if (iErr) throw iErr;

  const redirectTo = `${(process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '')}/auth/accept`;
  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo,
    data: { role, org_id: orgId },
  });
  if (error) {
    // Existing auth user (e.g. re-invite): attach to org and send a recovery link instead.
    if (/already/i.test(error.message)) {
      const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
      const existing = list?.users?.find(u => u.email?.toLowerCase() === email);
      if (existing) {
        await admin.from('profiles').upsert({ id: existing.id, email, role, org_id: orgId, active: true });
        await admin.auth.resetPasswordForEmail(email, { redirectTo });
        return { user: existing, reinvited: true };
      }
    }
    throw error;
  }
  return { user: data.user, reinvited: false };
}
