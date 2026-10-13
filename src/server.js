import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadUser } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import portalRoutes from './routes/portal.js';
import adminRoutes from './routes/admin/index.js';
import { fmt } from './lib/format.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));
// the quote calculator in the browser uses the exact same pricing module as the server
app.get('/js/pricing.js', (req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'lib', 'pricing.js')));
app.use((req, res, next) => {
  Object.assign(res.locals, { fmt, path: req.path, query: req.query, msg: req.query.msg, err: req.query.err });
  next();
});
app.use(loadUser);

app.get('/', (req, res) => {
  if (!req.user) return res.redirect('/login');
  res.redirect(req.user.role === 'client' ? '/portal' : '/admin');
});
app.get('/health', (req, res) => res.json({ ok: true }));
// Config self-check (no secrets shown): can the server read the database with its service key?
app.get('/health/db', async (req, res) => {
  const { admin } = await import('./lib/supabase.js');
  const { count, error } = await admin.from('profiles').select('id', { count: 'exact', head: true });
  res.json({
    supabase_url: (process.env.SUPABASE_URL || '').replace(/^(https?:\/\/[^.]{4})[^.]*/, '$1…'),
    service_key_type: /^sb_secret_/.test(process.env.SUPABASE_SERVICE_ROLE_KEY || '') ? 'new secret key' : /^eyJ/.test(process.env.SUPABASE_SERVICE_ROLE_KEY || '') ? 'legacy JWT' : 'unknown/missing',
    anon_key_type: /^sb_publishable_/.test(process.env.SUPABASE_ANON_KEY || '') ? 'new publishable key' : /^eyJ/.test(process.env.SUPABASE_ANON_KEY || '') ? 'legacy JWT' : 'unknown/missing',
    profiles_readable: !error, profiles_count: count ?? null, error: error?.message || null,
    secure_cookies: process.env.NODE_ENV === 'production', app_url: process.env.APP_URL || null,
  });
});
app.use('/', authRoutes);
app.use('/portal', portalRoutes);
app.use('/admin', adminRoutes);

app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'Page not found.' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).render('error', { title: 'Error', message: process.env.NODE_ENV === 'production' ? 'Something went wrong.' : err.message });
});

export default app;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Highs CRM listening on :${port}`));
}
