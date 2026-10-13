import { admin, anon, asUser } from '../lib/supabase.js';

const COOKIE = 'hb_session';
const secure = process.env.NODE_ENV === 'production';

export function setSession(res, session) {
  res.cookie(COOKIE, JSON.stringify({ a: session.access_token, r: session.refresh_token }), {
    httpOnly: true, sameSite: 'lax', secure, maxAge: 1000 * 60 * 60 * 24 * 7,
  });
}
export function clearSession(res) { res.clearCookie(COOKIE); }

/** Attach req.user (profile) and req.db (RLS-scoped client) when a valid session exists. */
export async function loadUser(req, res, next) {
  req.user = null;
  res.locals.user = null;
  const raw = req.cookies?.[COOKIE];
  if (!raw) return next();
  let tokens;
  try { tokens = JSON.parse(raw); } catch { clearSession(res); return next(); }

  let { data: { user }, error } = await anon.auth.getUser(tokens.a);
  if (error || !user) {
    // try refresh
    const { data, error: rErr } = await anon.auth.refreshSession({ refresh_token: tokens.r });
    if (rErr || !data?.session) { clearSession(res); return next(); }
    setSession(res, data.session);
    tokens = { a: data.session.access_token, r: data.session.refresh_token };
    user = data.session.user;
  }

  const { data: profile } = await admin.from('profiles')
    .select('*, organizations(id, name, country)').eq('id', user.id).single();
  if (!profile || !profile.active) { clearSession(res); return next(); }

  req.user = profile;
  req.accessToken = tokens.a;
  req.db = asUser(tokens.a);
  res.locals.user = profile;
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  next();
}

export function requireStaff(req, res, next) {
  if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  if (!['admin', 'staff'].includes(req.user.role)) return res.status(403).render('error', { title: 'Forbidden', message: 'Staff only.' });
  next();
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).render('error', { title: 'Forbidden', message: 'Admin only.' });
  next();
}

export function requireClient(req, res, next) {
  if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  if (req.user.role !== 'client' || !req.user.org_id) return res.redirect('/admin');
  next();
}
