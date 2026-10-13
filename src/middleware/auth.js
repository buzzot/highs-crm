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
  try { tokens = JSON.parse(raw); } catch { console.error('[session] unreadable cookie'); clearSession(res); return next(); }

  let { data: { user }, error } = await anon.auth.getUser(tokens.a);
  if (error || !user) {
    // try refresh
    const { data, error: rErr } = await anon.auth.refreshSession({ refresh_token: tokens.r });
    if (rErr || !data?.session) {
      console.error(`[session] token rejected (${error?.message || 'no user'}); refresh failed (${rErr?.message || 'no session'})`);
      clearSession(res); return next();
    }
    setSession(res, data.session);
    tokens = { a: data.session.access_token, r: data.session.refresh_token };
    user = data.session.user;
  }

  let { data: profile, error: pErr } = await admin.from('profiles')
    .select('*, organizations(id, name, country, details_completed_at)').eq('id', user.id).single();
  if (pErr && /details_completed_at|column/i.test(pErr.message || '')) {
    // migration 0008 not applied yet: still let people in, skip the company-details gate
    console.error(`[session] ${pErr.message} — run supabase/migrations/0008_company_details.sql`);
    ({ data: profile, error: pErr } = await admin.from('profiles')
      .select('*, organizations(id, name, country)').eq('id', user.id).single());
    if (profile) profile.detailsGateOff = true;
  }
  if (!profile || !profile.active) {
    console.error(`[session] ${user.email}: profile ${profile ? 'inactive' : 'not found'}${pErr ? ` (${pErr.message})` : ''}`);
    clearSession(res); return next();
  }

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
  // first sign-in for this company: details must be completed before anything else
  if (!req.user.detailsGateOff && !req.user.organizations?.details_completed_at && !req.path.startsWith('/company')) return res.redirect('/portal/company?first=1');
  next();
}
