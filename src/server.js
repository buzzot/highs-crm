import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadUser } from './middleware/auth.js';
import { compress, staticGzip } from './lib/compress.js';
import { requestTiming } from './lib/perf.js';
import authRoutes from './routes/auth.js';
import portalRoutes from './routes/portal.js';
import supplierRoutes from './routes/supplier.js';
import hookRoutes from './routes/hooks.js';
import adminRoutes from './routes/admin/index.js';
import { fmt } from './lib/format.js';
import { admin } from './lib/supabase.js';
import { icon } from './lib/icons.js';
import { homeFor } from './lib/util.js';
import { aiContext, getPrices, usageLine } from './lib/ai-usage.js';
import { showValue, deliveryLabel } from './lib/request-revisions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
// /hooks/* parse their own (larger) bodies — inbound emails can be big
const formParser = express.urlencoded({ extended: true, parameterLimit: 50000, limit: '5mb' }); // import review posts many fields
const jsonParser = express.json();
app.use((req, res, next) => (req.path.startsWith('/hooks/') ? next() : formParser(req, res, next)));
app.use((req, res, next) => (req.path.startsWith('/hooks/') ? next() : jsonParser(req, res, next)));
app.use(requestTiming());
app.use(compress());
app.use(cookieParser());
const PUBLIC = path.join(__dirname, '..', 'public');
app.use(staticGzip(PUBLIC));
app.use(express.static(PUBLIC, { maxAge: '10m' }));
// the quote calculator in the browser uses the exact same pricing module as the server
app.get('/js/pricing.js', (req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'lib', 'pricing.js')));
// counts behind the red balls in the menu: four queries run together and are reused for 20 s
let navCache = { at: 0, value: { sourcing: 0, orders: 0, purchasing: 0 }, pending: null };
async function navPending() {
  if (Date.now() - navCache.at < 20e3) return navCache.value;
  navCache.pending ||= (async () => {
    const n = async q => { try { return (await q).count || 0; } catch { return 0; } }; // a table missing before its migration counts as 0
    const head = (table, status) => admin.from(table).select('id', { count: 'exact', head: true }).eq('status', status);
    const [rev, po, pay, spo] = await Promise.all([n(head('request_revisions', 'pending')), n(head('purchase_orders', 'submitted')), n(head('order_payments', 'submitted')), n(head('supplier_pos', 'replied'))]);
    navCache = { at: Date.now(), value: { sourcing: rev + po, orders: pay, purchasing: spo }, pending: null };
    return navCache.value;
  })().finally(() => { navCache.pending = null; });
  return navCache.pending;
}

app.use((req, res, next) => {
  Object.assign(res.locals, { fmt, icon, showValue, deliveryLabel, path: req.path, query: req.query, msg: req.query.msg, err: req.query.err });
  next();
});
app.use(loadUser);
// AI calls made while handling this request are attributed to the signed-in person; views get aiLine(usage)
app.use(async (req, res, next) => {
  if (req.user && ['admin', 'staff'].includes(req.user.role)) {
    const [prices, nav] = await Promise.all([getPrices(), navPending()]);
    res.locals.aiLine = u => usageLine(u, prices);
    res.locals.navPending = nav; // red balls on the menu
  } else res.locals.aiLine = () => '';
  aiContext.run({ userId: req.user?.id || null, orgId: req.user?.org_id || null, supplierId: req.user?.supplier_id || null }, next);
});

app.get('/', (req, res) => {
  if (!req.user) return res.redirect('/login');
  res.redirect(homeFor(req.user.role));
});
app.get('/health', (req, res) => res.json({ ok: true }));
// Config self-check (no secrets shown): which project/role each key belongs to, and can the server read the DB?
app.get('/health/db', async (req, res) => {
  const { admin } = await import('./lib/supabase.js');
  const tidy = v => String(v ?? '').trim().replace(/^['"]|['"]$/g, '').trim();
  const describe = raw => {
    const v = tidy(raw);
    if (!v) return { type: 'MISSING' };
    if (/^sb_secret_/.test(v)) return { type: 'new secret key' };
    if (/^sb_publishable_/.test(v)) return { type: 'new publishable key' };
    if (/^eyJ/.test(v)) {
      try {
        const p = JSON.parse(Buffer.from(v.split('.')[1], 'base64url').toString());
        return { type: 'legacy JWT', role: p.role, project_ref: p.ref };
      } catch { return { type: 'JWT (unreadable)' }; }
    }
    return { type: 'unrecognised', length: v.length, starts_with: v.slice(0, 4) + '…' };
  };
  const { data, error } = await admin.from('profiles').select('id').limit(5);
  const urlRef = (tidy(process.env.SUPABASE_URL).match(/https?:\/\/([a-z0-9]+)\.supabase\.co/i) || [])[1] || null;
  res.json({
    url_project_ref: urlRef,
    service_role_key: describe(process.env.SUPABASE_SERVICE_ROLE_KEY),
    anon_key: describe(process.env.SUPABASE_ANON_KEY),
    profiles_readable: !error, profiles_found: data ? data.length : null,
    error: error ? [error.code, error.message, error.hint].filter(Boolean).join(' · ') || JSON.stringify(error) : null,
    app_url: process.env.APP_URL || null,
  });
});
app.use('/hooks', hookRoutes);
app.use('/', authRoutes);
app.use('/portal', portalRoutes);
app.use('/supplier', supplierRoutes);
app.use('/admin', adminRoutes);

app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'Page not found.' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(`[error] ${req.method} ${req.originalUrl}:`, err);
  const isStaff = req.user && ['admin', 'staff'].includes(req.user.role);
  const detail = [err.message, err.code, err.details, err.hint].filter(Boolean).join(' · ');
  res.status(500).render('error', { title: 'Error', message: process.env.NODE_ENV === 'production' && !isStaff ? 'Something went wrong.' : `Something went wrong: ${detail}` });
});

export default app;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Lumi Trade CRM listening on :${port}`));
}
