import { admin, anon, asUser } from '../lib/supabase.js';

const COOKIE = 'hb_session';
const secure = process.env.NODE_ENV === 'production';

export function setSession(res, session) {
  const value = JSON.stringify({ a: session.access_token, r: session.refresh_token });
  if (value.length > 3800) console.error(`[session] cookie is ${value.length} bytes — browsers may drop it`);
  res.cookie(COOKIE, value, { httpOnly: true, sameSite: 'lax', secure, maxAge: 1000 * 60 * 60 * 24 * 7 });
  res.cookie('hb_just', '1', { httpOnly: true, sameSite: 'lax', secure, maxAge: 60e3 }); // lets /login notice a lost cookie
}
/** Remember when a person really signed in (password + code, invitation or reset) — not token refreshes. */
export function markLogin(session) {
  const id = session?.user?.id;
  if (!id) return;
  admin.from('profiles').update({ last_login_at: new Date().toISOString() }).eq('id', id)
    .then(({ error }) => { if (error && !/last_login_at/.test(error.message)) console.error(`[session] last login: ${error.message}`); });
}

export function clearSession(res, why) {
  res.clearCookie(COOKIE);
  if (why) res.cookie('hb_why', why.slice(0, 300), { httpOnly: true, sameSite: 'lax', secure, maxAge: 5 * 60e3 });
}

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
      const why = `token rejected (${error?.message || 'no user'}); refresh failed (${rErr?.message || 'no session'})`;
      console.error(`[session] ${why}`);
      clearSession(res, `Session not accepted: ${why}`); return next();
    }
    setSession(res, data.session);
    tokens = { a: data.session.access_token, r: data.session.refresh_token };
    user = data.session.user;
  }

  let { data: profile, error: pErr } = await admin.from('profiles')
    .select('*, organizations!profiles_org_id_fkey(id, name, country, details_completed_at)').eq('id', user.id).single();
  if (pErr && /details_completed_at|column/i.test(pErr.message || '')) {
    // migration 0008 not applied yet: still let people in, skip the company-details gate
    console.error(`[session] ${pErr.message} — run supabase/migrations/0008_company_details.sql`);
    ({ data: profile, error: pErr } = await admin.from('profiles')
      .select('*, organizations!profiles_org_id_fkey(id, name, country)').eq('id', user.id).single());
    if (profile) profile.detailsGateOff = true;
  }
  if (!profile || !profile.active) {
    const why = `${user.email}: profile ${profile ? 'inactive' : 'not found'}${pErr ? ` (${pErr.message})` : ''}`;
    console.error(`[session] ${why}`);
    clearSession(res, `Signed in, but the account could not be loaded — ${why}`); return next();
  }

  if (profile.role === 'supplier' && profile.supplier_id) {
    const { data: sup } = await admin.from('suppliers').select('id, name, country, details_completed_at').eq('id', profile.supplier_id).maybeSingle();
    profile.supplier = sup || null;
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
  if (req.user.role === 'client') return res.redirect('/portal');
  if (req.user.role === 'supplier') return res.redirect('/supplier');
  if (!['admin', 'staff'].includes(req.user.role)) return res.status(403).render('error', { title: 'Forbidden', message: 'Staff only.' });
  next();
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).render('error', { title: 'Forbidden', message: 'Admin only.' });
  next();
}

export function requireClient(req, res, next) {
  if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  if (req.user.role === 'supplier') return res.redirect('/supplier');
  if (req.user.role !== 'client' || !req.user.org_id) return res.redirect('/admin');
  // first sign-in for this company: details must be completed before anything else
  if (!req.user.detailsGateOff && !req.user.organizations?.details_completed_at && !req.path.startsWith('/company')) return res.redirect('/portal/company?first=1');
  next();
}

export function requireSupplier(req, res, next) {
  if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  if (req.user.role !== 'supplier' || !req.user.supplier_id) return res.redirect(req.user.role === 'client' ? '/portal' : '/admin');
  if (!req.user.supplier) return res.status(403).render('error', { title: 'Not available', message: 'Your supplier account is not linked to a company. Please contact Lumi Trade.' });
  // first sign-in: the company details must be filled in before anything else
  if (!req.user.supplier.details_completed_at && !req.path.startsWith('/company')) return res.redirect('/supplier/company?first=1');
  next();
}
