import { randomBytes } from 'node:crypto';
import { admin } from './supabase.js';
import { sendCode } from './otp.js';

import { INVITE_DAYS } from './members.js';
export { INVITE_DAYS, memberRows } from './members.js';
const appUrl = () => (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');

/**
 * Invite (or re-invite) a person by email.
 *
 * Each invitation gets its own random token and a 14-day expiry. The email Supabase sends links to
 * APP_URL/invite/<token>; that page lets the person set a password for as long as the token is valid —
 * even after Supabase's own one-time code (max 24 h) has expired.
 * Re-inviting revokes any earlier open invitation for the same email.
 */
export async function inviteUser({ email, role = 'client', orgId = null, invitedBy = null }) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid email address.');
  if (role === 'client' && !orgId) throw new Error('Client invites need an organization.');

  const { data: existing } = await admin.from('profiles').select('id, role, org_id, accepted_at, organizations(name)').ilike('email', email).maybeSingle();
  if (existing?.accepted_at) {
    if (role === 'client' && existing.org_id && existing.org_id !== orgId) {
      throw new Error(`${email} already uses the portal for ${existing.organizations?.name || 'another client'}.`);
    }
    if (role === 'client' && existing.role !== 'client') throw new Error(`${email} is a staff account.`);
  }

  await admin.from('invitations').update({ revoked_at: new Date().toISOString() })
    .ilike('email', email).is('accepted_at', null).is('revoked_at', null);

  const token = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 864e5).toISOString();
  const { error: iErr } = await admin.from('invitations')
    .insert({ email, role, org_id: orgId, invited_by: invitedBy, token, expires_at: expiresAt });
  if (iErr) throw iErr;

  const redirectTo = `${appUrl()}/invite/${token}`;
  const { error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo });
  if (!error) {
    await admin.from('profiles').update({ invited_at: new Date().toISOString() }).ilike('email', email);
    return { resent: false, expiresAt };
  }
  if (!/already|registered|exists/i.test(error.message)) throw error;

  // Login already exists (earlier invite, or an existing user): make sure the profile points at this
  // client/role, then email a link (password-reset email) that lands on the same invite page.
  if (existing) {
    const patch = { role, org_id: orgId, active: true, invited_at: new Date().toISOString() };
    await admin.from('profiles').update(patch).eq('id', existing.id);
  }
  // email them a fresh code; the button in that email opens the same invitation page
  try { await sendCode(email, `/invite/${token}`); }
  catch (e) {
    const { error: rErr } = await admin.auth.resetPasswordForEmail(email, { redirectTo });
    if (rErr) throw new Error(e.message);
  }
  return { resent: true, expiresAt };
}

/** Look up an invitation by its link token and say whether it can still be used. */
export async function findInvite(token) {
  if (!token || token.length < 20) return { state: 'invalid' };
  const { data: inv } = await admin.from('invitations').select('*, organizations(name)').eq('token', token).maybeSingle();
  if (!inv) return { state: 'invalid' };
  if (inv.accepted_at) return { state: 'accepted', inv };
  if (inv.revoked_at) return { state: 'revoked', inv };
  if (inv.expires_at && new Date(inv.expires_at) < new Date()) return { state: 'expired', inv };
  return { state: 'valid', inv };
}

