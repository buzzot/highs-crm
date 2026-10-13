// Email one-time codes (Supabase Auth "email OTP"). Supabase generates, emails and checks the code;
// the code is shown in the email via {{ .Token }} — see README → "Email templates".
import { anon } from './supabase.js';

export const CODE_TTL_MIN = 15;
const appUrl = () => (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');

/** Two-step sign-in is on unless LOGIN_2FA=off (emergency switch if email delivery breaks). */
export const twoFactorOn = () => !/^(off|false|0|no)$/i.test(process.env.LOGIN_2FA || '');

/** Email a fresh code. `linkPath` is where the button in the email points (e.g. /login/verify). */
export async function sendCode(email, linkPath = '/login/verify') {
  const { error } = await anon.auth.signInWithOtp({
    email, options: { shouldCreateUser: false, emailRedirectTo: `${appUrl()}${linkPath}` },
  });
  if (error) {
    console.error(`[otp] send to ${email}: ${error.status || ''} ${error.message}`);
    if (/rate|seconds|too many/i.test(error.message)) throw new Error('A code was sent very recently — wait a minute, then request a new one.');
    throw new Error('Could not send the code email. Try again in a minute.');
  }
}

// --- brute-force guard: max 5 wrong codes per email per 15 minutes (per server instance) ---
const fails = new Map();
const key = e => String(e).toLowerCase();
export function tooManyAttempts(email) {
  const f = fails.get(key(email));
  return !!f && f.n >= 5 && f.until > Date.now();
}
function noteFail(email) {
  const k = key(email), f = fails.get(k);
  fails.set(k, !f || f.until < Date.now() ? { n: 1, until: Date.now() + 15 * 60e3 } : { n: f.n + 1, until: f.until });
}

/**
 * Check a code. Tries the code types Supabase may have sent (invite email, sign-in email…).
 * @returns {{ session, user } | null}
 */
export async function verifyCode(email, code, types = ['email']) {
  const token = String(code || '').replace(/\D/g, '');
  if (token.length < 6 || tooManyAttempts(email)) return null;
  for (const type of types) {
    const { data, error } = await anon.auth.verifyOtp({ email, token, type });
    if (!error && data?.session) { fails.delete(key(email)); return { session: data.session, user: data.user }; }
  }
  noteFail(email);
  return null;
}

/** "marsel@gmail.com" → "ma•••@gmail.com" */
export const maskEmail = e => String(e).replace(/^(.{2})[^@]*(@.*)$/, (m, a, b) => `${a}•••${b}`);
