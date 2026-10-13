// One-time codes and reset links, generated and checked by the app and emailed through Resend.
// Only a keyed hash of each code/token is stored (table auth_codes).
import { randomInt, randomBytes } from 'node:crypto';
import { admin } from './supabase.js';
import { hashSecret } from './signed.js';
import { sendEmail } from './mailer.js';
import { codeEmail, inviteEmail, resetEmail } from './email-templates.js';

export const CODE_TTL_MIN = 15;     // sign-in codes
export const RESET_TTL_MIN = 30;    // password-reset links
export const INVITE_CODE_DAYS = 14; // invitation codes live as long as the invitation link
const MAX_ATTEMPTS = 5;
const appUrl = () => (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');

/** Two-step sign-in is on unless LOGIN_2FA=off (emergency switch if email delivery breaks). */
export const twoFactorOn = () => !/^(off|false|0|no)$/i.test(process.env.LOGIN_2FA || '');

const lc = e => String(e || '').trim().toLowerCase();
export const newCode = () => String(randomInt(0, 1e6)).padStart(6, '0');

async function store(email, purpose, secretValue, ttlMs) {
  // a new code replaces any unused earlier one for the same purpose
  await admin.from('auth_codes').update({ used_at: new Date().toISOString() }).eq('email', lc(email)).eq('purpose', purpose).is('used_at', null);
  const { error } = await admin.from('auth_codes').insert({
    email: lc(email), purpose, code_hash: hashSecret(`${purpose}:${lc(email)}:${secretValue}`), expires_at: new Date(Date.now() + ttlMs).toISOString(),
  });
  if (error) throw new Error(`Could not create code: ${error.message}`);
}

async function recentlySent(email, purpose, seconds = 30) {
  const { data } = await admin.from('auth_codes').select('created_at').eq('email', lc(email)).eq('purpose', purpose)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  return data && Date.now() - new Date(data.created_at).getTime() < seconds * 1000;
}

/** Email a sign-in code (purpose 'login') or a fresh invitation code (purpose 'invite'). */
export async function sendCode(email, purpose = 'login', linkPath = '/login/verify') {
  if (await recentlySent(email, purpose)) throw new Error('A code was sent a few seconds ago — check your inbox, or wait 30 seconds.');
  const code = newCode();
  const ttl = purpose === 'invite' ? INVITE_CODE_DAYS * 864e5 : CODE_TTL_MIN * 60e3;
  await store(email, purpose, code, ttl);
  const msg = codeEmail({ url: `${appUrl()}${linkPath}`, code, minutes: purpose === 'invite' ? null : CODE_TTL_MIN, purpose });
  await sendEmail({ to: lc(email), ...msg });
}

/** Invitation email: link to the invitation page + confirmation code. */
export async function sendInvite({ email, token, orgName, inviterName, days }) {
  const code = newCode();
  await store(email, 'invite', code, days * 864e5);
  await sendEmail({ to: lc(email), ...inviteEmail({ url: `${appUrl()}/invite/${token}`, code, orgName, inviterName, days }) });
}

/** Password-reset email with a single-use link. */
export async function sendReset(email) {
  const token = randomBytes(32).toString('base64url');
  await store(email, 'reset', token, RESET_TTL_MIN * 60e3);
  await sendEmail({ to: lc(email), ...resetEmail({ url: `${appUrl()}/reset/${encodeURIComponent(lc(email))}/${token}`, email: lc(email), minutes: RESET_TTL_MIN }) });
}

/**
 * Check a code / token. Wrong guesses count against the latest code; after 5 it is burned.
 * @returns {'ok'|'wrong'|'expired'|'locked'}
 */
export async function checkCode(email, purpose, value, { consume = true } = {}) {
  const { data: row } = await admin.from('auth_codes').select('*').eq('email', lc(email)).eq('purpose', purpose).is('used_at', null)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!row) return 'expired';
  if (new Date(row.expires_at) < new Date()) return 'expired';
  if (row.attempts >= MAX_ATTEMPTS) return 'locked';
  const clean = purpose === 'reset' ? String(value || '') : String(value || '').replace(/\D/g, '');
  if (hashSecret(`${purpose}:${lc(email)}:${clean}`) !== row.code_hash) {
    await admin.from('auth_codes').update({ attempts: row.attempts + 1 }).eq('id', row.id);
    return row.attempts + 1 >= MAX_ATTEMPTS ? 'locked' : 'wrong';
  }
  if (consume) await admin.from('auth_codes').update({ used_at: new Date().toISOString() }).eq('id', row.id);
  return 'ok';
}

export const codeError = r => ({
  wrong: 'That code is not correct. Check the newest email and try again.',
  expired: 'That code has expired or was already used. Send a new code.',
  locked: 'Too many wrong attempts. Send a new code.',
}[r] || 'Something went wrong. Try again.');

/** "marsel@gmail.com" → "ma•••@gmail.com" */
export const maskEmail = e => String(e).replace(/^(.{2})[^@]*(@.*)$/, (m, a, b) => `${a}•••${b}`);
