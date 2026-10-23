import { randomBytes } from 'node:crypto';
import { admin } from './supabase.js';
import { sendInvite } from './otp.js';
import { seal, unseal } from './signed.js';
import { orgLang } from './lang.js';

import { INVITE_DAYS } from './members.js';
export { INVITE_DAYS, memberRows, wantsLinkOnly } from './members.js';

/**
 * Invite (or re-invite) a person by email.
 *
 * Each invitation gets its own random link token and a 6-digit code, both valid 14 days, emailed through
 * Resend from your own domain. The login is created here (without a password); the person sets the
 * password on the invitation page after confirming the code. Re-inviting revokes earlier open invitations.
 */
export async function inviteUser({ email, role = 'client', orgId = null, supplierId = null, invitedBy = null, mail = true }) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid email address.');
  if (role === 'client' && !orgId) throw new Error('Client invites need an organization.');
  if (role === 'supplier' && !supplierId) throw new Error('Supplier invites need a supplier.');
  if (role === 'supplier') orgId = null;

  const { data: existing } = await admin.from('profiles').select('*, organizations!profiles_org_id_fkey(name)').ilike('email', email).maybeSingle();
  if (existing?.accepted_at) {
    if (role === 'client' && existing.org_id && existing.org_id !== orgId) {
      throw new Error(`${email} already uses the portal for ${existing.organizations?.name || 'another client'}.`);
    }
    if (role === 'client' && existing.role !== 'client') throw new Error(`${email} is a ${existing.role} account.`);
    if (role === 'supplier' && existing.role !== 'supplier') throw new Error(`${email} is already used by a ${existing.role} account.`);
    if (role === 'supplier' && existing.supplier_id && existing.supplier_id !== supplierId) throw new Error(`${email} already uses the portal for another supplier.`);
  }
  if (!existing?.accepted_at && existing && existing.role !== role && ['admin', 'staff'].includes(existing.role)) throw new Error(`${email} is a staff account.`);

  await admin.from('invitations').update({ revoked_at: new Date().toISOString() })
    .ilike('email', email).is('accepted_at', null).is('revoked_at', null);

  const token = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 864e5).toISOString();
  const { error: iErr } = await admin.from('invitations')
    .insert({ email, role, org_id: orgId, ...(supplierId ? { supplier_id: supplierId } : {}), invited_by: invitedBy, token, expires_at: expiresAt });
  if (iErr) throw iErr;

  // the login (no password yet) — the database trigger links it to the invitation (role + client)
  const now = new Date().toISOString();
  if (existing) {
    await admin.from('profiles').update({ role, org_id: orgId, ...(supplierId ? { supplier_id: supplierId } : {}), active: true, invited_at: now }).eq('id', existing.id);
  } else {
    const { error } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (error && !/already|registered|exists/i.test(error.message)) throw error;
    await admin.from('profiles').update({ invited_at: now }).ilike('email', email);
  }

  const [{ data: org }, { data: sup }, { data: inviter }] = await Promise.all([
    orgId ? admin.from('organizations').select('name').eq('id', orgId).single() : { data: null },
    supplierId ? admin.from('suppliers').select('name, details_completed_at').eq('id', supplierId).single() : { data: null },
    invitedBy ? admin.from('profiles').select('full_name').eq('id', invitedBy).single() : { data: null },
  ]);
  const lang = role === 'client' ? await orgLang(orgId) : 'en';   // invitations always use the company's language
  const sent = await sendInvite({ mail, lang, email, token, orgName: org?.name || (sup?.details_completed_at ? sup.name : null), inviterName: inviter?.full_name || null, days: INVITE_DAYS, kind: role === 'supplier' ? 'supplier' : 'client' });
  return { resent: !!existing, expiresAt, link: sent.url, code: sent.code, mailError: sent.mailError, mailed: mail && !sent.mailError };
}

/** Look up an invitation by its link token and say whether it can still be used. */
export async function findInvite(token) {
  if (!token || token.length < 20) return { state: 'invalid' };
  const { data: inv } = await admin.from('invitations').select('*, organizations(name)').eq('token', token).maybeSingle();
  if (!inv) return { state: 'invalid' };
  if (inv.supplier_id) {
    const { data: sup } = await admin.from('suppliers').select('name, details_completed_at').eq('id', inv.supplier_id).maybeSingle();
    inv.supplier = sup || null;
  }
  if (inv.accepted_at) return { state: 'accepted', inv };
  if (inv.revoked_at) return { state: 'revoked', inv };
  if (inv.expires_at && new Date(inv.expires_at) < new Date()) return { state: 'expired', inv };
  return { state: 'valid', inv };
}


// ---- hand-over of an invitation link (for people who cannot receive email) ----
const SHOW_COOKIE = 'hb_invshow';
/** Keep the fresh link + code for the next page view only (encrypted cookie, 10 minutes). */
export function stashInvite(res, email, r) {
  const ttl = 10 * 60e3;
  res.cookie(SHOW_COOKIE, seal({ email, link: r.link, code: r.code, mailed: r.mailed, err: r.mailError || null }, ttl), { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: ttl, path: '/admin' });
}
/** Read and clear it: the link is shown once. */
export function takeInvite(req, res) {
  const v = unseal(req.cookies?.[SHOW_COOKIE]);
  if (req.cookies?.[SHOW_COOKIE]) res.clearCookie(SHOW_COOKIE, { path: '/admin' });
  return v || null;
}
