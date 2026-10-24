import { Router } from '../lib/router.js';
import { admin, anon } from '../lib/supabase.js';
import { setSession, clearSession, requireAuth, markLogin } from '../middleware/auth.js';
import { findInvite } from '../lib/invites.js';
import { homeFor } from '../lib/util.js';
import { log } from '../lib/activity.js';
import { sign, unsign, seal, unseal } from '../lib/signed.js';
import { sendCode, sendReset, checkCode, codeError, twoFactorOn, maskEmail, CODE_TTL_MIN, RESET_TTL_MIN } from '../lib/otp.js';

const r = Router();
const APP_URL = () => (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
const secure = process.env.NODE_ENV === 'production';
const cookieOpts = ttl => ({ httpOnly: true, sameSite: 'lax', secure, maxAge: ttl });
const PENDING = 'hb_2fa';          // password OK, waiting for the emailed code
const INVITE_OK = 'hb_inv';        // invitation email code confirmed, waiting for profile + password
const safeNext = n => (n && n.startsWith('/') && !n.startsWith('//') ? n : null);
const home = homeFor;

r.get('/login', (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user.role));
  const lost = req.cookies.hb_just && !req.cookies.hb_session
    ? 'You were signed in, but your browser did not keep the sign-in cookie. Allow cookies for this site (and turn off strict tracking protection), then try again.' : null;
  if (lost) console.error('[login] session cookie was set but not sent back by the browser');
  const why = req.cookies.hb_why || lost || (req.query.why === 'step' ? 'This sign-in step was started in another browser or has expired. Enter your email and password again here, then enter the new code in this same browser window.' : null);
  if (req.cookies.hb_why) res.clearCookie('hb_why');
  res.render('auth/login', { title: 'Sign in', error: why, next: req.query.next || '' });
});

r.post('/login', async (req, res) => {
  const { email, password, next } = req.body;
  const { data, error } = await anon.auth.signInWithPassword({ email: String(email || '').trim(), password });
  if (error || !data.session) {
    console.error(`[login] ${String(email || '').trim()}: ${error?.status || ''} ${error?.code || ''} ${error?.message || 'no session'}`);
    const msg = /invalid login credentials/i.test(error?.message || '') ? 'Invalid email or password.'
      : /not confirmed/i.test(error?.message || '') ? 'Email not confirmed yet — open the link in your invitation email.'
      : /api key|apikey|jwt/i.test(error?.message || '') ? 'Server configuration error (Supabase key). Check SUPABASE_ANON_KEY.'
      : 'Sign-in failed. Please try again.';
    return res.status(401).render('auth/login', { title: 'Sign in', error: msg, next: next || '' });
  }
  const { data: profile, error: pErr } = await admin.from('profiles').select('role, active').eq('id', data.user.id).single();
  if (!profile || !profile.active) {
    console.error(`[login] ${data.user.email}: signed in but profile ${profile ? 'inactive' : 'missing'} ${pErr?.message || ''}`);
    return res.status(403).render('auth/login', { title: 'Sign in', error: 'Your account is not activated yet. Ask an administrator.', next: '' });
  }
  if (!twoFactorOn()) {
    setSession(res, data.session); markLogin(data.session);
    return res.redirect(safeNext(next) || home(profile.role));
  }
  // Step 2: keep the (encrypted) session aside until the emailed code is entered.
  try { await sendCode(data.user.email, 'login', '/login/verify'); } catch (e) {
    return res.status(503).render('auth/login', { title: 'Sign in', error: e.message, next: next || '' });
  }
  res.cookie(PENDING, seal({ e: data.user.email, rt: data.session.refresh_token, n: safeNext(next) }, CODE_TTL_MIN * 60e3), cookieOpts(CODE_TTL_MIN * 60e3));
  res.redirect('/login/verify');
});

const verifyView = (res, pending, extra = {}) => res.render('auth/verify', {
  title: 'Enter your code', email: maskEmail(pending.e), error: null, msg: null, ...extra,
});

r.get('/login/verify', (req, res) => {
  const pending = unseal(req.cookies[PENDING]);
  if (!pending) return res.redirect('/login?why=step');
  verifyView(res, pending, { msg: req.query.sent ? 'A new code is on its way.' : null });
});

r.post('/login/verify', async (req, res) => {
  const pending = unseal(req.cookies[PENDING]);
  if (!pending) {
    console.error(`[login] code entered but no pending sign-in cookie (${req.cookies[PENDING] ? 'unreadable/expired' : 'missing'})`);
    return res.redirect('/login?why=step');
  }
  const result = await checkCode(pending.e, 'login', req.body.code);
  if (result !== 'ok') return verifyView(res.status(401), pending, { error: codeError(result) });
  const { data, error } = await anon.auth.refreshSession({ refresh_token: pending.rt });
  if (error || !data?.session) console.error(`[login] ${pending.e}: refresh after code failed: ${error?.message || 'no session'}`);
  if (error || !data?.session) return res.status(401).render('auth/login', { title: 'Sign in', error: 'Your sign-in expired — please enter your password again.', next: pending.n || '' });
  const { data: profile } = await admin.from('profiles').select('role, active').eq('id', data.user.id).single();
  if (!profile?.active) return res.status(403).render('auth/login', { title: 'Sign in', error: 'Your account is not active.', next: '' });
  res.clearCookie(PENDING);
  setSession(res, data.session); markLogin(data.session);
  console.log(`[login] ${pending.e}: signed in with email code`);
  res.redirect(pending.n || home(profile.role));
});

r.post('/login/resend', async (req, res) => {
  const pending = unseal(req.cookies[PENDING]);
  if (!pending) return res.redirect('/login');
  try { await sendCode(pending.e, 'login', '/login/verify'); } catch (e) { return verifyView(res.status(429), pending, { error: e.message }); }
  res.redirect('/login/verify?sent=1');
});

r.post('/logout', (req, res) => { clearSession(res); res.redirect('/login'); });

/**
 * Invite acceptance. Supabase sends the invited user to APP_URL/auth/accept#access_token=...&refresh_token=...
 * The tokens live in the URL fragment, so a tiny script posts them here, then the user sets a password.
 */
r.get('/auth/accept', (req, res) => res.render('auth/accept', { title: 'Choose a new password', error: null }));

r.post('/auth/accept', async (req, res) => {
  const { access_token, refresh_token, password, full_name } = req.body;
  if (!access_token || !password || password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return res.status(400).render('auth/accept', { title: 'Choose a new password', error: 'Use at least 8 characters with letters and a number.', at: access_token, rt: refresh_token });
  }
  if (req.body.password2 !== undefined && password !== req.body.password2) {
    return res.status(400).render('auth/accept', { title: 'Choose a new password', error: 'Passwords do not match.', at: access_token, rt: refresh_token });
  }
  const { data, error } = await anon.auth.setSession({ access_token, refresh_token });
  if (error || !data.session) return res.status(400).render('auth/accept', { title: 'Choose a new password', error: 'This link is invalid or has expired. Request a new one from "Forgot password".' });

  const { error: uErr } = await admin.auth.admin.updateUserById(data.user.id, { password, user_metadata: { full_name } });
  if (uErr) return res.status(400).render('auth/accept', { title: 'Choose a new password', error: uErr.message, at: access_token, rt: refresh_token });
  if (full_name) await admin.from('profiles').update({ full_name }).eq('id', data.user.id);

  const { data: signed } = await anon.auth.signInWithPassword({ email: data.user.email, password });
  if (signed?.session) { setSession(res, signed.session); markLogin(signed.session); }
  const { data: profile } = await admin.from('profiles').select('role').eq('id', data.user.id).single();
  res.redirect(homeFor(profile?.role));
});

/**
 * Invitation (link valid 14 days) — two steps:
 *   1. confirm the email address with the 6-digit code from the invitation email (or a freshly sent one)
 *   2. fill in the profile and create a password → signed in
 */
const inviteView = (res, found, extra = {}) => res.render('auth/invite', {
  title: 'Accept invitation', state: found.state, inv: found.inv || null, step: 'code', error: null, msg: null, form: {}, ...extra,
});
const inviteVerified = (req, token) => { const v = unsign(req.cookies[INVITE_OK]); return v && v.t === token; };
const markVerified = (res, token) => res.cookie(INVITE_OK, sign({ t: token }, 60 * 60e3), cookieOpts(60 * 60e3));

r.get('/invite/:token', async (req, res) => {
  const found = await findInvite(req.params.token);
  if (found.state !== 'valid') return inviteView(res, found);
  if (req.user && req.user.email.toLowerCase() !== found.inv.email.toLowerCase()) clearSession(res);
  inviteView(res, found, { step: inviteVerified(req, req.params.token) ? 'profile' : 'code', msg: req.query.sent ? 'A new code is on its way — check your inbox.' : null });
});

// step 1: code from the email
r.post('/invite/:token/code', async (req, res) => {
  const found = await findInvite(req.params.token);
  if (found.state !== 'valid') return inviteView(res.status(400), found);
  const result = await checkCode(found.inv.email, 'invite', req.body.code);
  if (result !== 'ok') return inviteView(res.status(401), found, { error: codeError(result) });
  await admin.from('invitations').update({ verified_at: new Date().toISOString() }).eq('id', found.inv.id);
  markVerified(res, req.params.token);
  res.redirect(`/invite/${req.params.token}`);
});

r.post('/invite/:token/resend', async (req, res) => {
  const found = await findInvite(req.params.token);
  if (found.state !== 'valid') return inviteView(res.status(400), found);
  try { await sendCode(found.inv.email, 'invite', `/invite/${req.params.token}`); }
  catch (e) { return inviteView(res.status(429), found, { error: e.message }); }
  res.redirect(`/invite/${req.params.token}?sent=1`);
});

// Older email template: the link itself was the confirmation (tokens arrive in the URL fragment)
r.post('/invite/:token/session', async (req, res) => {
  const found = await findInvite(req.params.token);
  if (found.state !== 'valid' || !req.body.access_token) return res.redirect(`/invite/${req.params.token}`);
  const { data: { user } } = await anon.auth.getUser(req.body.access_token);
  if (user && user.email?.toLowerCase() === found.inv.email.toLowerCase()) {
    await admin.from('invitations').update({ verified_at: new Date().toISOString() }).eq('id', found.inv.id);
    markVerified(res, req.params.token);
  }
  res.redirect(`/invite/${req.params.token}`);
});

// step 2: profile + password
r.post('/invite/:token', async (req, res) => {
  const found = await findInvite(req.params.token);
  if (found.state !== 'valid') return inviteView(res.status(400), found);
  if (!inviteVerified(req, req.params.token)) return inviteView(res.status(401), found, { error: 'Please confirm the code from your email first.' });
  const { inv } = found;
  const form = {
    full_name: String(req.body.full_name || '').trim(),
    job_title: String(req.body.job_title || '').trim(),
    phone: String(req.body.phone || '').trim(),
    wechat: String(req.body.wechat || '').trim(),
  };
  const password = String(req.body.password || '');
  const again = (error) => inviteView(res.status(400), found, { step: 'profile', error, form });
  if (!form.full_name) return again('Please enter your name.');
  if (password.length < 8) return again('Password must be at least 8 characters.');
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return again('Use letters and at least one number in the password.');
  if (password !== req.body.password2) return again('Passwords do not match.');

  // the login was created when the invitation was sent; create it if that step never completed
  let { data: profile } = await admin.from('profiles').select('id').ilike('email', inv.email).maybeSingle();
  let userId = profile?.id;
  if (userId) {
    const { error } = await admin.auth.admin.updateUserById(userId, { password, email_confirm: true, user_metadata: { full_name: form.full_name } });
    if (error) return again(error.message);
  } else {
    const { data, error } = await admin.auth.admin.createUser({ email: inv.email, password, email_confirm: true, user_metadata: { full_name: form.full_name } });
    if (error) return again(error.message);
    userId = data.user.id;
  }
  const now = new Date().toISOString();
  await admin.from('profiles').update({
    full_name: form.full_name, job_title: form.job_title || null, phone: form.phone || null, wechat: form.wechat || null,
    role: inv.role, org_id: inv.org_id, ...(inv.supplier_id ? { supplier_id: inv.supplier_id } : {}), active: true, accepted_at: now,
  }).eq('id', userId);
  await admin.from('invitations').update({ accepted_at: now }).eq('id', inv.id);
  if (inv.org_id) await log({ entityType: 'organization', entityId: inv.org_id, action: 'invite_accepted', actorId: userId, detail: { note: inv.email } });
  if (inv.supplier_id) await log({ entityType: 'supplier', entityId: inv.supplier_id, action: 'invite_accepted', actorId: userId, detail: { note: inv.email } });

  // the email code already proved ownership of the address → sign straight in
  const { data: signed } = await anon.auth.signInWithPassword({ email: inv.email, password });
  if (signed?.session) { setSession(res, signed.session); markLogin(signed.session); }
  res.clearCookie(INVITE_OK);
  res.redirect(home(inv.role));
});

r.get('/forgot', (req, res) => res.render('auth/forgot', { title: 'Reset password', sent: false, email: null, error: null }));
r.post('/forgot', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).render('auth/forgot', { title: 'Reset password', sent: false, email, error: 'Enter a valid email address.' });
  // only people who finished their invitation can reset; the answer is the same either way
  const { data: p, error: pErr } = await admin.from('profiles').select('id, active').ilike('email', email).maybeSingle();
  if (pErr) console.error(`[forgot] ${email}: profile lookup failed: ${pErr.message}`);
  if (p?.active) {
    try { await sendReset(email); console.log(`[forgot] ${email}: reset email sent`); } catch (e) { console.error(`[forgot] ${email}: ${e.message}`); }
  } else console.log(`[forgot] ${email}: no active account — no email sent`);
  res.render('auth/forgot', { title: 'Check your inbox', sent: true, email, error: null, minutes: RESET_TTL_MIN });
});

// link from the reset email: /reset/<email>/<token>
const resetView = (res, extra = {}) => res.render('auth/reset', { title: 'Choose a new password', error: null, valid: true, ...extra });
r.get('/reset/:email/:token', async (req, res) => {
  const state = await checkCode(req.params.email, 'reset', req.params.token, { consume: false });
  resetView(res, { valid: state === 'ok', expired: state !== 'ok' });
});
r.post('/reset/:email/:token', async (req, res) => {
  const email = String(req.params.email).toLowerCase();
  const password = String(req.body.password || '');
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) return resetView(res.status(400), { error: 'Use at least 8 characters with letters and a number.' });
  if (password !== req.body.password2) return resetView(res.status(400), { error: 'Passwords do not match.' });
  const state = await checkCode(email, 'reset', req.params.token);
  if (state !== 'ok') return resetView(res.status(400), { valid: false, expired: true });
  const { data: p } = await admin.from('profiles').select('id, role, active').ilike('email', email).maybeSingle();
  if (!p?.active) return resetView(res.status(400), { valid: false, expired: true });
  const { error } = await admin.auth.admin.updateUserById(p.id, { password });
  if (error) return resetView(res.status(400), { error: error.message });
  // the link proved access to the mailbox → sign straight in
  const { data: signed } = await anon.auth.signInWithPassword({ email, password });
  if (signed?.session) { setSession(res, signed.session); markLogin(signed.session); }
  console.log(`[reset] ${email}: password changed`);
  res.redirect(home(p.role) + '?msg=' + encodeURIComponent('Password changed.'));
});

r.get('/account', requireAuth, (req, res) => res.render('auth/account', { title: 'My account', saved: req.query.saved }));
r.post('/account', requireAuth, async (req, res) => {
  const { full_name, password } = req.body;
  const patch = {};
  for (const k of ['full_name', 'job_title', 'phone', 'wechat']) if (k in req.body) patch[k] = String(req.body[k] || '').trim() || null;
  if (patch.full_name === null) delete patch.full_name;
  if (patch.wechat && /^(WhatsApp|WeChat)$/.test(req.body.messenger || '')) patch.wechat = `${req.body.messenger}: ${patch.wechat}`;   // number/ID is stored with the messenger it belongs to
  if (Object.keys(patch).length) await admin.from('profiles').update(patch).eq('id', req.user.id);
  if (password && (password.length < 8 || password !== req.body.password2)) return res.redirect('/account?err=' + encodeURIComponent('Password not changed: at least 8 characters, typed twice the same.'));
  if (password && password.length >= 8) await admin.auth.admin.updateUserById(req.user.id, { password });
  res.redirect('/account?saved=1');
});

export default r;
