// Renders every template with realistic fixtures. Catches template syntax errors,
// undefined variables and broken includes without needing a database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from './mini-ejs.js';
import { pages } from './fixtures.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const views = path.join(root, 'src', 'views');
const out = process.env.RENDER_OUT;

// every top-level template (not partials or "_" fragments) must have a fixture
const all = [];
(function walk(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) { if (f.name !== 'partials') walk(p); } else if (!f.name.startsWith('_')) all.push(path.relative(views, p).replace(/\.ejs$/, ''));
  }
})(views);

test('every page template has a fixture', () => {
  const missing = all.filter(v => !pages[v]);
  assert.deepEqual(missing, []);
});

// a fixture is either locals, or [template, locals] for an extra variant of a page
const resolve = (name, v) => (Array.isArray(v) ? v : [name, v]);

for (const [name, entry] of Object.entries(pages)) {
  const [tpl, locals] = resolve(name, entry);
  test(`renders ${name}`, () => {
    const html = render(path.join(views, tpl + '.ejs'), locals);
    assert.match(html, /<\/html>/);
    assert.doesNotMatch(html, /undefined|NaN|\[object Object\]/, 'leaked undefined/NaN/object into HTML');
    if (out) {
      fs.mkdirSync(path.join(out, path.dirname(name)), { recursive: true });
      fs.writeFileSync(path.join(out, name + '.html'), html);
    }
  });
}

test('client portal never renders cost, margin or supplier fields', () => {
  for (const [name, entry] of Object.entries(pages)) {
    if (!name.startsWith('portal/')) continue;
    const [tpl, locals] = resolve(name, entry);
    const html = render(path.join(views, tpl + '.ejs'), locals);
    assert.doesNotMatch(html, /Brightway|margin|unit cost|internal/i, `${name} leaks internal data`);
  }
});

test('supplier portal never renders margins, sell prices or client names', () => {
  for (const [name, entry] of Object.entries(pages)) {
    if (!name.startsWith('supplier/')) continue;
    const [tpl, locals] = resolve(name, entry);
    const html = render(path.join(views, tpl + '.ejs'), locals);
    assert.doesNotMatch(html, /margin|landed|Acme|sell price|internal/i, `${name} leaks internal data`);
  }
});

test('styled select popup script is loaded and styled', () => {
  assert.match(fs.readFileSync('src/views/partials/foot.ejs', 'utf8'), /\/js\/select-ui\.js/);
  assert.match(fs.readFileSync('public/css/app.css', 'utf8'), /\.sx-pop\s*\{/);
});

test('quote all products: internal packing, per-line freight and one logistics card', () => {
  const html = render(path.join(views, 'admin/pricing/quote_lines.ejs'), pages['admin/pricing/quote_lines']);
  assert.match(html, /name="line\[0\]\[pack_kg\]"/);
  assert.match(html, /name="line\[1\]\[pack_cbm\]"/);
  assert.match(html, /name="line\[0\]\[freight\]"/);
  assert.match(html, /name="freight_total"[^>]*value="38500"/);
  assert.match(html, /name="freight_basis"/);
  assert.match(html, /never shown to the client/);
  assert.match(html, /Prefilled from <button[^>]*data-fq-open>FQ-2610-0042 · Dragon Freight/);
  assert.match(html, /<dialog class="fqdlg"/);
  assert.match(html, /Dragon Freight[\s\S]*Sino Logistics/);
  assert.match(html, /data-fq-use data-amount="39000"/);
  assert.match(html, /\/admin\/logistics\/quotes\/fr1/);
});

test('quote all products: "No freight" is offered and is the default for a new quotation', () => {
  const html = render(path.join(views, 'admin/pricing/quote_lines.ejs'), { ...pages['admin/pricing/quote_lines'], shared: { ...pages['admin/pricing/quote_lines'].shared, freight_mode: 'none' } });
  assert.match(html, /<option value="none" selected>No freight on the quotation/);
  assert.match(fs.readFileSync(path.join(views, 'admin/pricing/quote_multi.ejs'), 'utf8'), /<option value="none" selected>No freight/);
  assert.match(fs.readFileSync(path.join(root, 'supabase/migrations/0041_freight_mode_none.sql'), 'utf8'), /'none'/);
});

test('a portal order under review shows what the client sent — no prices, totals, payment form or costs', () => {
  const [tpl, locals] = resolve('portal/order_detail_review', pages['portal/order_detail_review']);
  const html = render(path.join(views, tpl + '.ejs'), locals);
  assert.match(html, /Under review/); assert.match(html, /Your target price/); assert.match(html, /Steel wire rope/);
  assert.match(html, /Kazan, Russia/);
  assert.doesNotMatch(html, /Goods total|Unit price|Submit payment|I have paid|id="pay"/);
  assert.doesNotMatch(html, /0\.0000|\$0\.00/);
});

test('staff see the client order block, the client target column and an edit form per item', () => {
  const html = render(path.join(views, 'admin/orders/detail.ejs'), pages['admin/orders/detail']);
  assert.match(html, /Order sent by the client/); assert.match(html, /PO-77/); assert.match(html, /no price yet/);
  assert.match(html, /action="\/admin\/orders\/ord1\/items\/i1"/);
});

test('menu: red ball on Orders for new client orders and payments, with a plain title', () => {
  const l = (np) => ({ ...pages['admin/orders/index'], navPending: np });
  let html = render(path.join(views, 'admin/orders/index.ejs'), l({ sourcing: 0, orders: 3, ordersNew: 2, ordersPay: 1, purchasing: 0, products: 0 }));
  assert.match(html, /Orders<span class="navball" title="2 new orders from clients to review · 1 payment to confirm">3<\/span>/);
  html = render(path.join(views, 'admin/orders/index.ejs'), l({ sourcing: 0, orders: 0, ordersNew: 0, ordersPay: 0, purchasing: 0, products: 0 }));
  assert.doesNotMatch(html, /Orders<span class="navball"/);
});
