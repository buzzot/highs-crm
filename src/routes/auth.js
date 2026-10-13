import { Router } from '../lib/router.js';
import { admin, anon } from '../lib/supabase.js';
import { setSession, clearSession, requireAuth } from '../middleware/auth.js';

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
