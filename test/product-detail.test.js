import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { render } from './mini-ejs.js';
import { pages } from './fixtures.js';
import { isImageDoc, productPhotos, splitSpec, physicalFacts, sizeText, quoteRows, poRows, orderRows, requestRows } from '../src/lib/product-detail.js';

const html = (k = 'admin/products/detail') => render('src/views/admin/products/detail.ejs', Array.isArray(pages[k]) ? pages[k][1] : pages[k]);
const panel = (h, id) => { const i = h.indexOf(`id="tab-${id}"`); const j = h.indexOf('<section', i + 10); return h.slice(i, j < 0 ? undefined : j); };

test('splitSpec: sourcing facts leave the technical table, the type is shown elsewhere, blanks vanish', () => {
  const r = splitSpec({ Power: '10 W', Incoterm: 'FOB', 'Production lead time (days)': '25', 'Quote valid until': '2026-12-31', Type: 'Service', 'Units per 40HQ': '9000', Empty: '  ', 'Payment terms': '30%' });
  assert.deepEqual(r.tech, [['Power', '10 W']]);
  assert.deepEqual(r.sourcing, { incoterm: 'FOB', lead: '25', valid: '2026-12-31', payment: '30%' });
  assert.deepEqual(r.packing, [['Units per 40HQ', '9000']]);
  assert.deepEqual(splitSpec(null), { sourcing: {}, packing: [], tech: [] });
});
test('physicalFacts / sizeText: only what is known, sizes need all three sides', () => {
  assert.equal(sizeText(30, 20, 10.55), '30 × 20 × 10.6 cm'); assert.equal(sizeText(30, 20, null), '');
  const f = physicalFacts({ unit_weight_kg: 0.65, carton_qty: 20, carton_length_cm: 50, carton_width_cm: 40, carton_height_cm: 30, carton_cbm: 0.06, carton_weight_kg: 14 });
  assert.deepEqual(f.unit, [['Weight', '0.65 kg']]);
  assert.deepEqual(f.carton.map(x => x[0]), ['Pieces per carton', 'Carton size', 'Carton volume', 'Carton weight']);
  assert.deepEqual(physicalFacts({}), { unit: [], carton: [] });
});
test('quote, request, order and PO rows are shaped for the page', () => {
  const qs = [{ id: 'a', quantity: 10, unit_cost: '1', cost_currency: 'CNY', unit_price: '0.2', sell_currency: 'USD', margin_pct: '25', status: 'sent', created_at: '2026-01-02', requests: { id: 'r1', ref: 'REQ-1', organizations: { name: 'Acme' } } },
    { id: 'b', quantity: 50, unit_cost: 1, cost_currency: 'CNY', unit_price: 0.2, sell_currency: 'USD', margin_pct: 20, status: 'draft', created_at: '2026-02-01', requests: { id: 'r1', ref: 'REQ-1', organizations: { name: 'Acme' } } }, { id: 'c', quantity: 1, requests: null }];
  const rows = quoteRows(qs); assert.equal(rows[0].markupPct, 25); assert.equal(rows[0].client, 'Acme'); assert.equal(rows[2].ref, '');
  const rq = requestRows(qs); assert.equal(rq.length, 1); assert.equal(rq[0].quotes, 2); assert.equal(rq[0].qty, 50); assert.equal(rq[0].at, '2026-02-01');
  assert.equal(orderRows([{ quantity: 5, unit_price: '2', orders: { id: 'o', order_no: 'HB-1', status: 'confirmed', currency: 'USD', organizations: { name: 'X' } } }, { quantity: 1, orders: null }]).length, 1);
  const po = poRows([{ id: 'p', ref: 'SPO-1', status: 'sent', currency: 'CNY', lines: [{ product_id: 'P', quantity: 3, unit_price: 2 }, { product_id: 'P', quantity: 4, unit_price: 3 }, { product_id: 'Z', quantity: 99 }] }, { id: 'q', lines: [{ product_id: 'Z' }] }, { id: 'n', lines: null }], 'P');
  assert.equal(po.length, 1); assert.equal(po[0].qty, 7); assert.equal(po[0].unitPrice, 3);
});

test('page: compact header with image, name, SKU, category, supplier, status, Edit and Quote this', () => {
  const h = html(), head = h.slice(h.indexOf('<header'), h.indexOf('</header>'));
  for (const t of ['LED Desk Lamp 10W', 'BW-LED-001', 'Lighting', 'Shenzhen Brightway', 'Complete', 'Edit product', 'Quote this']) assert.ok(head.includes(t), t);
  assert.match(head, /\/admin\/products\/p1\/edit/); assert.match(head, /\/admin\/pricing\/quotes\/new\?product_id=p1/);
});
test('page: the header stays compact — no thumbnail, no repeated photo', () => {
  const h = html(), head = h.slice(h.indexOf('<header'), h.indexOf('</header>'));
  assert.doesNotMatch(head, /<img/); assert.doesNotMatch(head, /pdd-thumb/);
  assert.equal((h.match(/<img[^>]*data-pimg/g) || []).length, 2);   // main image on Overview + the one gallery photo — not on every tab
});
test('page: exactly four tabs, read-only — no form fields outside the document upload', () => {
  const h = html();
  for (const t of ['Overview', 'Sourcing &amp; Costing', 'Quotes &amp; Orders', 'Photos &amp; Documents']) assert.ok(h.includes(t), t);
  assert.equal((h.match(/role="tab"/g) || []).length, 4);
  const noDocs = h.slice(h.indexOf('<header class="cd-head'), h.indexOf('id="tab-docs"'));
  assert.doesNotMatch(noDocs, /<input|<textarea|<select|<form/);
});
test('page: overview shows identity, specs and dimensions; sourcing keys are not repeated in the spec table', () => {
  const o = panel(html('admin/products/detail#long'), 'overview');
  assert.match(o, /Technical specifications/); assert.match(o, /Power/); assert.doesNotMatch(o, /Incoterm|Payment terms|Quote valid/);
  const f = panel(html(), 'overview'); for (const t of ['Internal SKU', 'Category', 'HS code', 'Physical dimensions', '0.65 kg', 'Data completeness']) assert.ok(f.includes(t), t);
});
test('page: sourcing tab shows the original price and currency apart from the converted value, and the assumptions', () => {
  const s = panel(html(), 'sourcing');
  assert.match(s, /¥38\.50/); assert.match(s, /CNY per unit/); assert.match(s, /≈ \$5\.31/); assert.match(s, /1 CNY = 0\.138 USD/);
  for (const t of ['Supplier SKU', 'Price basis', 'MOQ', 'Production lead time', 'Supplier quotation', 'Packing and cartons', 'Pieces per carton', 'Cost estimate', 'Estimate', '$4,500 per 40HQ', '+45% markup', '31.0% gross margin']) assert.ok(s.includes(t), t);
  assert.match(s, /Not recorded/);                                // price basis was never stored: say so, don't invent
});
test('page: values a supplier submitted (price basis, lead time, quote validity) are shown, not hidden in the spec', () => {
  const s = panel(html('admin/products/detail#long'), 'sourcing');
  assert.match(s, /FOB/); assert.match(s, /25 days/); assert.match(s, /Valid until 2026-12-31/); assert.match(s, /30% deposit/);
});
test('page: no definitive landed cost when an exchange rate or carton data is missing', () => {
  const g = panel(html('admin/products/detail#long'), 'sourcing');           // priced in GBP, no rate
  assert.match(g, /No landed cost shown/); assert.match(g, /No exchange rate for GBP/); assert.doesNotMatch(g, /Estimated landed/);
  const sp = panel(html('admin/products/detail#sparse'), 'sourcing'); assert.match(sp, /No landed cost shown/);
});
test('page: a service is not forced into carton and container costing', () => {
  const h = html('admin/products/detail#service'), s = panel(h, 'sourcing');
  assert.match(s, /Not applicable/); assert.match(s, /does not apply/); assert.doesNotMatch(s, /Pieces per carton|No carton details/);
  assert.doesNotMatch(panel(h, 'overview'), /pcs\/carton|carton size/); assert.match(panel(h, 'overview'), /Service/);
});
test('page: completeness links each gap to its field in the existing edit form', () => {
  const o = panel(html('admin/products/detail#sparse'), 'overview');
  assert.match(o, /Needed for costing and quotes/); assert.match(o, /Optional/);
  for (const f of ['unit_cost', 'supplier_id', 'carton_qty', 'carton_length_cm', 'hs_code', 'moq']) assert.ok(o.includes('/edit#f=' + f), f);
  assert.match(panel(html(), 'overview'), /Everything needed for costing and quotes is filled in/);
});
test('page: quotes tab labels markup as markup on cost, with the equivalent margin', () => {
  const q = panel(html(), 'quotes');
  assert.match(q, /Markup on cost/); assert.match(q, /18\.0%/); assert.match(q, /15\.3% margin/); assert.doesNotMatch(q, /<th[^>]*>Margin<\/th>/);
  for (const t of ['REQ-2610-0042', 'Acme Retail LLC', 'Client orders', 'HB-2610-1001', 'Supplier purchase orders', 'SPO-2610-0001', '2 customer requests']) assert.ok(q.includes(t), t);
  assert.doesNotMatch(q, /\b5\b<\/td>/);                          // only this product's PO line quantity (2000), not the other product's
});
test('page: nothing to show means no empty tables — one clear empty state instead', () => {
  const q = panel(html('admin/products/detail#sparse'), 'quotes');
  assert.match(q, /Not quoted or ordered yet/); assert.doesNotMatch(q, /<table/);
  const h = html('admin/products/detail#sparse'); assert.doesNotMatch(panel(h, 'overview'), /Technical specifications|Physical dimensions/);
});
test('page: photos & documents keeps upload, visibility and delete (the shared documents panel)', () => {
  const d = panel(html(), 'docs');
  assert.match(d, /action="\/admin\/documents\/upload"/); assert.match(d, /Visible to client/); assert.match(d, /\/admin\/documents\/doc1\/download/);
});
test('page: the route keeps product, supplier, quotes, documents and pricing data and reads orders and purchase orders', () => {
  const r = fs.readFileSync('src/routes/admin/products.js', 'utf8'), g = r.slice(r.indexOf("r.get('/:id', async"), r.indexOf("r.get('/:id/edit'"));
  for (const t of ["from('products')", "from('documents')", "from('quotes')", "from('order_items')", "from('supplier_pos')", 'productMetrics', 'splitSpec']) assert.ok(g.includes(t), t);
});

test('images: type by mime or, when no type was saved, by file name; primary = first uploaded; documents stay out', () => {
  assert.equal(isImageDoc({ mime_type: 'image/webp' }), true); assert.equal(isImageDoc({ mime_type: null, storage_path: 'a/b.JPEG' }), true);
  assert.equal(isImageDoc({ mime_type: 'application/pdf', title: 'x.png' }), false); assert.equal(isImageDoc({ mime_type: null, title: 'spec.pdf' }), false); assert.equal(isImageDoc(null), false);
  const ph = productPhotos([{ id: 'b', kind: 'product_photo', mime_type: 'image/png', created_at: '2026-02' }, { id: 'a', kind: 'product_photo', mime_type: 'image/png', created_at: '2026-01' },
    { id: 'c', kind: 'certificate', mime_type: 'image/png', created_at: '2026-00' }, { id: 'd', kind: 'product_photo', mime_type: 'application/pdf', created_at: '2026-03' }]);
  assert.deepEqual(ph.map(x => x.id), ['a', 'b']);
});
test('page: Overview shows a large main image (opens the viewer), name, SKU, category and description beside it', () => {
  const o = panel(html('admin/products/detail#photos'), 'overview');
  assert.match(o, /class="pdd-main"[^>]*data-lb="0"/); assert.match(o, /\/admin\/documents\/ph-land\/download/);
  for (const t of ['pdd-title', 'BW-LED-001', 'Lighting', 'Foldable aluminium desk lamp', '5 photos — see all']) assert.ok(o.includes(t), t);
  assert.doesNotMatch(o, /pdd-gal/);                                 // the gallery lives on the Photos tab only
});
test('page: no photo gives a neutral placeholder that leads to the upload, not a broken image', () => {
  const h = html('admin/products/detail#sparse'), o = panel(h, 'overview');
  assert.match(o, /pdd-main none/); assert.match(o, /No photo yet/); assert.doesNotMatch(h.slice(h.indexOf('<header'), h.indexOf('id="pddLb"')), /<img[^>]*src="\/admin\/documents/);
});
test('page: gallery lists product photos only, primary first, with originals, and keeps documents separate', () => {
  const d = panel(html('admin/products/detail#photos'), 'docs');
  assert.equal((d.match(/class="pdd-ph/g) || []).length, 5); assert.match(d, /pdd-ph primary/); assert.equal((d.match(/>Primary</g) || []).length, 1);
  assert.match(d, /Original/); assert.match(d, /internal/); assert.match(d, /ph-noext/);       // untyped upload recognised by its file name
  const photos = d.slice(0, d.indexOf('Documents &amp; upload'));
  assert.doesNotMatch(photos, /CE-certificate/); assert.match(d, /CE-certificate\.pdf/);       // the certificate is in the documents list
  assert.match(d, /action="\/admin\/documents\/upload"/);
});
test('page: viewer and failure handling are wired in', () => {
  const h = html('admin/products/detail#photos');
  assert.match(h, /id="pddLb"/); assert.match(h, /id="pddPhotos"/); assert.match(h, /could not be loaded/); assert.match(h, /addEventListener\('error', fail/);
  assert.equal(JSON.parse(h.match(/id="pddPhotos">(.*?)<\/script>/s)[1]).length, 5);
});
test('download route: a record whose file is gone answers 404 instead of crashing', () => {
  const r = fs.readFileSync('src/routes/admin/documents.js', 'utf8');
  assert.match(r, /try \{ url = await signedUrl/); assert.match(r, /status\(404\)\.send\('File not found in storage'\)/);
});
