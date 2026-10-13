import { Router } from '../lib/router.js';
import { admin, anon } from '../lib/supabase.js';
import { setSession, clearSession, requireAuth } from '../middleware/auth.js';
import { findInvite } from '../lib/invites.js';
import { log } from '../lib/activity.js';

const r = Router();
const APP_URL = () => (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');

r.get('/login', (req, res) => {
  if (req.user) return res.redirect(req.user.role === 'client' ? '/portal' : '/admin');
  res.render('auth/login', { title: 'Sign in', error: null, next: req.query.next || '' });
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
  setSession(res, data.session);
  const { data: profile, error: pErr } = await admin.from('profiles').select('role, active').eq('id', data.user.id).single();
  if (!profile || !profile.active) {
    console.error(`[login] ${data.user.email}: signed in but profile ${profile ? 'inactive' : 'missing'} ${pErr?.message || ''}`);
    clearSession(res);
    return res.status(403).render('auth/login', { title: 'Sign in', error: 'Your account is not activated yet. Ask an administrator.', next: '' });
  }
  res.redirect(next && next.startsWith('/') && !next.startsWith('//') ? next : (profile.role === 'client' ? '/portal' : '/admin'));
});

r.post('/logout', (req, res) => { clearSession(res); res.redirect('/login'); });

/**
 * Invite acceptance. Supabase sends the invited user to APP_URL/auth/accept#access_token=...&refresh_token=...
 * The tokens live in the URL fragment, so a tiny script posts them here, then the user sets a password.
 */
r.get('/auth/accept', (req, res) => res.render('auth/accept', { title: 'Accept invitation', error: null }));

r.post('/auth/accept', async (req, res) => {
  const { access_token, refresh_token, password, full_name } = req.body;
  if (!access_token || !password || password.length < 8) {
    return res.status(400).render('auth/accept', { title: 'Accept invitation', error: 'Password must be at least 8 characters.' });
  }
  const { data, error } = await anon.auth.setSession({ access_token, refresh_token });
  if (error || !data.session) return res.status(400).render('auth/accept', { title: 'Accept invitation', error: 'Invitation link is invalid or expired. Ask for a new one.' });

  const { error: uErr } = await admin.auth.admin.updateUserById(data.user.id, { password, user_metadata: { full_name } });
  if (uErr) return res.status(400).render('auth/accept', { title: 'Accept invitation', error: uErr.message });
  if (full_name) await admin.from('profiles').update({ full_name }).eq('id', data.user.id);

  const { data: signed } = await anon.auth.signInWithPassword({ email: data.user.email, password });
  if (signed?.session) setSession(res, signed.session);
  const { data: profile } = await admin.from('profiles').select('role').eq('id', data.user.id).single();
  res.redirect(profile?.role === 'client' ? '/portal' : '/admin');
});

/**
 * Invitation link (valid 14 days). The emailed Supabase link redirects here; whether or not Supabase's
 * own one-time code is still valid, our token decides. The person picks a name + password and is signed in.
 */
const inviteView = (res, found, extra = {}) => res.render('auth/invite', {
  title: 'Accept invitation', state: found.state, inv: found.inv || null, error: null, form: {}, ...extra,
});

r.get('/invite/:token', async (req, res) => {
  const found = await findInvite(req.params.token);
  if (req.user && found.state === 'valid' && req.user.email.toLowerCase() !== found.inv.email.toLowerCase()) clearSession(res);
  inviteView(res, found);
});

r.post('/invite/:token', async (req, res) => {
  const found = await findInvite(req.params.token);
  if (found.state !== 'valid') return inviteView(res.status(400), found);
  const { inv } = found;
  const full_name = String(req.body.full_name || '').trim();
  const password = String(req.body.password || '');
  if (password.length < 8) return inviteView(res.status(400), found, { error: 'Password must be at least 8 characters.', form: { full_name } });
  if (password !== req.body.password2) return inviteView(res.status(400), found, { error: 'Passwords do not match.', form: { full_name } });

  // Find the login created when the invite was sent; create it if the email step never got that far.
  let { data: profile } = await admin.from('profiles').select('id').ilike('email', inv.email).maybeSingle();
  let userId = profile?.id;
  if (userId) {
    const { error } = await admin.auth.admin.updateUserById(userId, { password, email_confirm: true, user_metadata: { full_name } });
    if (error) return inviteView(res.status(400), found, { error: error.message, form: { full_name } });
  } else {
    const { data, error } = await admin.auth.admin.createUser({ email: inv.email, password, email_confirm: true, user_metadata: { full_name } });
    if (error) return inviteView(res.status(400), found, { error: error.message, form: { full_name } });
    userId = data.user.id;
  }
  const now = new Date().toISOString();
  await admin.from('profiles').update({ full_name: full_name || null, role: inv.role, org_id: inv.org_id, active: true, accepted_at: now }).eq('id', userId);
  await admin.from('invitations').update({ accepted_at: now }).eq('id', inv.id);
  if (inv.org_id) await log({ entityType: 'organization', entityId: inv.org_id, action: 'invite_accepted', actorId: userId, detail: { note: inv.email } });

  const { data: signed } = await anon.auth.signInWithPassword({ email: inv.email, password });
  if (signed?.session) setSession(res, signed.session);
  res.redirect(inv.role === 'client' ? '/portal' : '/admin');
});

r.get('/forgot', (req, res) => res.render('auth/forgot', { title: 'Reset password', sent: false }));
r.post('/forgot', async (req, res) => {
  await anon.auth.resetPasswordForEmail(req.body.email, { redirectTo: `${APP_URL()}/auth/accept` });
  res.render('auth/forgot', { title: 'Reset password', sent: true });
});

r.get('/account', requireAuth, (req, res) => res.render('auth/account', { title: 'My account', saved: req.query.saved }));
r.post('/account', requireAuth, async (req, res) => {
  const { full_name, password } = req.body;
  if (full_name) await admin.from('profiles').update({ full_name }).eq('id', req.user.id);
  if (password && password.length >= 8) await admin.auth.admin.updateUserById(req.user.id, { password });
  res.redirect('/account?saved=1');
});

export default r;
