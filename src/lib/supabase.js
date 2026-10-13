import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !anonKey || !serviceKey) {
  console.warn('[supabase] SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY not all set');
}

/** Service-role client: bypasses RLS. Use only in admin routes and auth plumbing. */
export const admin = createClient(url || 'http://localhost', serviceKey || 'x', {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Anonymous client for sign-in flows. */
export const anon = createClient(url || 'http://localhost', anonKey || 'x', {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Per-request client acting as the signed-in user (RLS applies). */
export function asUser(accessToken) {
  return createClient(url || 'http://localhost', anonKey || 'x', {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
