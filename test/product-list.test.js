import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { render } from './mini-ejs.js';
import { pages, prodRows, prodIdx } from './fixtures.js';
import { filterProducts, paginate, SORT_DEFS, PAGE_SIZE } from '../src/lib/product-list.js';
import { productMetrics, fxToUsdStrict } from '../src/lib/product-metrics.js';

const all = prodRows(7);
const names = q => filterProducts(all, q).rows.map(p => p.id);
const view = (k, over = {}) => render('src/views/admin/products/index.ejs', { ...(Array.isArray(pages[k]) ? pages[k][1] : pages[k]), ...over });

test('search: every word must match name, SKU, supplier SKU, HS code, category, description or supplier name', () => {
  assert.deepEqual(names({ q: 'tumbler' }), ['p2']);
  assert.deepEqual(names({ q: 'KS209' }), ['p3']);              // supplier part number
  assert.ok(names({ q: 'brightway lamp' }).includes('p1'));     // two words, two fields
  assert.deepEqual(names({ q: 'батар' }), ['p3']);              // non-Latin
  assert.deepEqual(names({ q: 'zzz-no-such' }), []);
  assert.equal(names({ q: '   ' }).length, 7);
});
test('filters: category, supplier and data completeness combine (AND)', () => {
  assert.ok(names({ category: 'Lighting' }).every(id => all.find(p => p.id === id).category === 'Lighting'));
  assert.ok(names({ supplier: 's2' }).length >= 2);
  assert.deepEqual(names({ supplier: 's2', category: 'Houseware' }), ['p2']);
  const crit = filterProducts(all, { issues: 'critical' }).rows, any = filterProducts(all, { issues: '1' }).rows;
  assert.ok(crit.length > 0 && crit.every(p => p.m.critical.length > 0)); assert.ok(any.length >= crit.length);
  assert.ok(all.some(p => !p.m.issues.length) && any.every(p => p.m.issues.length > 0));
});
test('sort: every option works, missing values go last and ties never throw', () => {
  for (const k of Object.keys(SORT_DEFS)) assert.equal(filterProducts(all, { sort: k }).rows.length, 7, k);
  assert.equal(filterProducts(all, { sort: 'nonsense' }).sort, 'name');
  const asc = filterProducts(all, { sort: 'landed' }).rows.map(p => p.m.landedUsd);
  const firstNull = asc.indexOf(null); assert.ok(firstNull === -1 || asc.slice(firstNull).every(v => v == null));
  const desc = filterProducts(all, { sort: 'price_desc' }).rows.map(p => p.m.priceUsd);
  const dn = desc.indexOf(null); assert.ok(dn === -1 || desc.slice(dn).every(v => v == null));
  assert.equal(filterProducts(all, { sort: 'name' }).rows[0].name.toLowerCase().startsWith('12mm'), true);
});
test('large datasets: 20,000 products filter, sort and page quickly and never lose a row', () => {
  const toUsd = fxToUsdStrict({ fx: { CNY_USD: 0.138 } });
  const big = Array.from({ length: 20000 }, (_, i) => { const p = { id: 'b' + i, name: 'Item ' + i, sku: 'S' + i, unit_cost: (i % 97) + 1, cost_currency: 'CNY', supplier_id: 's' + (i % 5), category: 'C' + (i % 7), carton_qty: 10, carton_cbm: 0.05, carton_weight_kg: 10, suppliers: { name: 'Sup ' + (i % 5) } }; return { ...p, m: productMetrics(p, toUsd) }; });
  const t0 = Date.now(); const { rows } = filterProducts(big, { q: 'item', sort: 'landed' });
  assert.equal(rows.length, 20000); assert.ok(Date.now() - t0 < 3000);
  const seen = new Set(); let pages = 0;
  for (let n = 1; ; n++) { const pg = paginate(rows, n); pages = pg.pages; pg.shown.forEach(r => seen.add(r.id)); if (n >= pg.pages) break; }
  assert.equal(pages, 200); assert.equal(seen.size, 20000);
});
test('paginate clamps out-of-range and junk page numbers', () => {
  const rows = Array.from({ length: 250 }, (_, i) => i);
  assert.equal(PAGE_SIZE, 100);
  assert.deepEqual([paginate(rows, 1).shown.length, paginate(rows, 3).shown.length, paginate(rows, 99).page, paginate(rows, 'x').page, paginate(rows, -4).page], [100, 50, 3, 1, 1]);
  assert.deepEqual(paginate([], 5), { pages: 1, page: 1, shown: [] });
});

test('page: Catalog is the default; Costing is the same products with costing columns', () => {
  const cat = view('admin/products/index'), cost = view('admin/products/index#costing');
  assert.match(cat, /pd-catalog/); assert.match(cost, /pd-costing/);
  for (const h of ['Category', 'Supplier', 'Factory price', 'MOQ', 'Data']) assert.ok(cat.includes('>' + h), h);
  for (const h of ['Factory cost', 'Freight', 'Est. landed', 'Sugg. wholesale', 'Units']) assert.ok(cost.includes(h), h);
  for (const id of ['p1', 'p2', 'p3']) { assert.ok(cat.includes('/admin/products/' + id) && cost.includes('/admin/products/' + id), id); }
});
test('page: original price and currency are shown beside the converted USD value', () => {
  const h = view('admin/products/index');
  assert.match(h, /¥38\.50/); assert.match(h, /CNY/); assert.match(h, /≈ \$5\.313/);
  assert.match(h, /€9\.50/);
});
test('page: markup is called markup, with the equivalent margin explained', () => {
  const cost = view('admin/products/index#costing');
  assert.match(cost, /\+45% markup/); assert.match(cost, /Pricing basis/); assert.match(cost, /31%/);
  assert.doesNotMatch(cost, /45% margin/i);
});
test('page: estimates are labelled and an incomplete product shows no definitive landed cost', () => {
  const cost = view('admin/products/index#costing');
  assert.match(cost, /est\. 40HQ/); assert.match(cost, /volume only/); assert.match(cost, /needs carton data/); assert.match(cost, /not applicable/);
  assert.match(cost, /Estimates, not quotations/);
  assert.doesNotMatch(cost, /confirmed cost\s*<\/strong>/i);
});
test('page: the contextual selection toolbar keeps Compare, AI compare, Create quote and (authorized) Delete', () => {
  const h = view('admin/products/index');
  assert.match(h, /id="pdSel"[^>]*hidden|id="pdSel"[^>]*style="[^"]*display:\s*none/);   // hidden until something is selected
  for (const t of ['Compare', 'AI compare', 'Create quote', 'Delete', 'Clear selection']) assert.ok(h.includes(t), t);
  assert.ok(h.includes('/admin/pricing/quotes/multi')); assert.ok(h.includes('id="delcfm"'));
  const noDel = view('admin/products/index', { canDelete: false });
  assert.doesNotMatch(noDel, /Delete…/); assert.doesNotMatch(noDel, /id="delcfm"/);
});
test('page: the Data badge lists critical and optional gaps and links to the field to fix', () => {
  const h = view('admin/products/index');
  assert.match(h, /\d critical/); assert.match(h, /\d optional/); assert.match(h, /✓ Complete/);
  assert.match(h, /Needed for costing and quotes/); assert.match(h, /\/admin\/products\/p4\/edit#f=carton_qty/);
});
test('page: live search is debounced and the filters can be cleared', () => {
  const h = view('admin/products/index');
  assert.match(h, /name="q"/); assert.match(h, /\}, 400\)/); assert.match(h, /requestSubmit/);
  assert.doesNotMatch(h, /Clear filters/);
  const f = view('admin/products/index#filtered'); assert.match(f, /Clear filters/);
  assert.match(f, /name="view" value="costing"|view=costing/);
});
test('page: empty and no-match states each say what to do next', () => {
  const e = view('admin/products/index#empty'), n = view('admin/products/index#nomatch');
  assert.match(e, /No products yet/i); assert.match(e, /\/admin\/products\/new/);
  assert.match(n, /No products match/i); assert.match(n, /Clear filters/);
});
test('page: a large catalogue renders one page of rows with a pager, and the count of all matches', () => {
  const h = view('admin/products/index#large'), rows = (h.match(/name="ids"/g) || []).length;
  assert.equal(rows, 100); assert.match(h, /450/); assert.match(h, /cl-pager/);
});
test('page: long names are truncated with the full text kept for the tooltip', () => {
  const h = view('admin/products/index');
  assert.match(h, /extra long product name for truncation testing in the table/);
  assert.match(h, /class="tip"/);
});
test('page: Excel / PDF import and CSV export stay in the header, and export keeps the active filters', () => {
  const h = view('admin/products/index#filtered');
  assert.match(h, /Import from Excel \/ PDF/); assert.match(h, /\/admin\/products\/import/); assert.match(h, /\/admin\/products\/export\.csv\?/);
});
test('route: CSV export keeps its columns and appends the costing columns; filtering and paging live in the route', () => {
  const r = fs.readFileSync('src/routes/admin/products.js', 'utf8');
  for (const c of ["'Wholesale markup %'", "'Landed basis'", "'Critical missing'"]) assert.ok(r.includes(c), c);
  assert.match(r, /filterProducts\(/); assert.match(r, /paginate\(/); assert.match(r, /fxToUsdStrict/);
  assert.match(r, /range\(/);                                   // paged fetch — no silent 1000-row cap
});
test('form: a Data-badge link (#f=field) focuses that field on the edit page', () => {
  const f = fs.readFileSync('src/views/admin/products/form.ejs', 'utf8');
  assert.match(f, /#f=|\bf=/); assert.match(f, /pd-flash/); assert.match(f, /Type: Service/);
});
