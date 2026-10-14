import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadUser } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import portalRoutes from './routes/portal.js';
import supplierRoutes from './routes/supplier.js';
import adminRoutes from './routes/admin/index.js';
import { fmt } from './lib/format.js';
import { icon } from './lib/icons.js';
import { homeFor } from './lib/util.js';
import { showValue, deliveryLabel } from './lib/request-revisions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: true, parameterLimit: 50000, limit: '5mb' })); // import review posts many fields
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));
// the quote calculator in the browser uses the exact same pricing module as the server
app.get('/js/pricing.js', (req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'lib', 'pricing.js')));
app.use((req, res, next) => {
  Object.assign(res.locals, { fmt, icon, showValue, deliveryLabel, path: req.path, query: req.query, msg: req.query.msg, err: req.query.err });
  next();
});
app.use(loadUser);

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
