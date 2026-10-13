import { createClient } from '@supabase/supabase-js';

// Tidy up values pasted into hosting dashboards: stray quotes/spaces, missing https://,
// a bare project ref ("abcd1234") or a dashboard link instead of the API URL.
const tidy = v => String(v ?? '').trim().replace(/^['"]|['"]$/g, '').trim();
function normalizeUrl(raw) {
  let v = tidy(raw).replace(/\/+$/, '');
  if (!v) return '';
  const dash = v.match(/supabase\.com\/dashboard\/project\/([a-z0-9]+)/i);
  if (dash) return `https://${dash[1]}.supabase.co`;
  if (/^[a-z0-9]{15,30}$/i.test(v)) return `https://${v}.supabase.co`;   // project ref only
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  return v;
}

const url = normalizeUrl(process.env.SUPABASE_URL);
const anonKey = tidy(process.env.SUPABASE_ANON_KEY);
const serviceKey = tidy(process.env.SUPABASE_SERVICE_ROLE_KEY);

const missing = [!url && 'SUPABASE_URL', !anonKey && 'SUPABASE_ANON_KEY', !serviceKey && 'SUPABASE_SERVICE_ROLE_KEY'].filter(Boolean);
if (missing.length) {
  console.error(`\n[config] Missing environment variable(s): ${missing.join(', ')}.\n` +
    '         Set them in Railway → service → Variables (or .env locally), then redeploy.\n');
}
if (url && !/^https?:\/\/[^\s/]+\.[^\s/]+/i.test(url)) {
  const raw = tidy(process.env.SUPABASE_URL);
  console.error(`\n[config] SUPABASE_URL does not look like a URL. Received ${raw.length} chars starting "${raw.slice(0, 12)}…".\n` +
    '         Expected: https://<project-ref>.supabase.co  (Supabase → Project Settings → API → Project URL)\n');
  process.exit(1);
}
if (url) console.log(`[config] Supabase: ${url}`);

const opts = { auth: { autoRefreshToken: false, persistSession: false } };
const safeUrl = url || 'http://localhost';

/** Service-role client: bypasses RLS. Use only in admin routes and auth plumbing. */
export const admin = createClient(safeUrl, serviceKey || 'x', opts);

/** Anonymous client for sign-in flows. */
export const anon = createClient(safeUrl, anonKey || 'x', opts);

/** Per-request client acting as the signed-in user (RLS applies). */
export function asUser(accessToken) {
  return createClient(safeUrl, anonKey || 'x', { ...opts, global: { headers: { Authorization: `Bearer ${accessToken}` } } });
}
