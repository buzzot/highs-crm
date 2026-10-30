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
