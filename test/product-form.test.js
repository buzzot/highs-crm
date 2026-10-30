import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from './mini-ejs.js';
import { pages, prodForm } from './fixtures.js';
import { specParts, recordTypeOf, isNonPhysical, postedRows, buildSpec, cbmFromSize, cbmDiffers, cbmPlan, cbmFormState, cartonCbmToStore, validateProduct } from '../src/lib/product-form.js';
import { isDocFile, docKindFor, docTypeLabel, aiReadable, fmtSize } from '../src/lib/product-docs.js';
import fs from 'node:fs';
import { splitSpec } from '../src/lib/product-detail.js';

const html = k => render('src/views/admin/products/form.ejs', pages[k][1]);

test('specParts: sourcing keys keep their spelling, type is separated, nothing is dropped', () => {
  const s = { Power: '10 W', Incoterm: 'FOB', 'Production lead time (days)': '25', 'Quote valid until': '2026-12-31', Type: 'Service', 'Payment terms': '30%' };
  const r = specParts(s);
  assert.equal(r.type, 'Service'); assert.equal(r.incoterm.value, 'FOB'); assert.equal(r.lead.key, 'Production lead time (days)'); assert.equal(r.valid.value, '2026-12-31');
  assert.deepEqual(r.rows.map(x => x[0]).sort(), ['Payment terms', 'Power']);
});
test('buildSpec round trip loses no data and keeps existing key spellings', () => {
  const s = { Power: '10 W', Colour: 'Matte black', Incoterm: 'FOB', 'Production lead time (days)': '25', Type: 'Service' };
  const p = specParts(s);
  const out = buildSpec({ record_type: p.type, src_incoterm: 'FOB', src_lead: '25', src_valid: '', spec_k: p.rows.map(x => x[0]), spec_v: p.rows.map(x => x[1]) }, s);
  assert.deepEqual(out, s);
  const edited = buildSpec({ record_type: '', src_incoterm: 'CIF', src_lead: '30', spec_k: ['Power'], spec_v: ['12 W'] }, s);
  assert.equal(edited.Power, '12 W'); assert.equal(edited.Incoterm, 'CIF'); assert.equal(edited['Production lead time (days)'], '30'); assert.ok(!('Colour' in edited));
});
test('postedRows: structured rows, blanks dropped, old text field still understood', () => {
  assert.deepEqual(postedRows({ spec_k: ['A', '', 'B'], spec_v: ['1', '', '2'] }), [['A', '1'], ['B', '2']]);
  assert.ok(validateProduct({ name: 'x', spec_k: ['', 'B'], spec_v: ['orphan', '2'] }).spec, 'a value without a name is flagged, not dropped');
  assert.deepEqual(postedRows({ spec: 'Power: 10 W\nColour: Black' }), [['Power', '10 W'], ['Colour', 'Black']]);
});
test('recordTypeOf / isNonPhysical', () => {
  assert.equal(recordTypeOf({}), ''); assert.equal(recordTypeOf({ Type: 'service' }), 'Service');
  assert.ok(isNonPhysical('Service')); assert.ok(isNonPhysical('Freight')); assert.ok(!isNonPhysical('Sample')); assert.ok(!isNonPhysical(''));
});
test('CBM: supplier-provided, calculated and the one used — a difference is never settled silently', () => {
  assert.equal(cbmFromSize(50, 40, 30), 0.06); assert.equal(cbmFromSize(50, 40, ''), null);
  assert.ok(cbmDiffers(0.2, 0.06)); assert.ok(!cbmDiffers(0.0605, 0.06), 'rounding is not a discrepancy'); assert.ok(!cbmDiffers(0.0005, 0.0004), 'tiny volumes are not flagged by percentage alone');
  const sz = { carton_length_cm: '50', carton_width_cm: '40', carton_height_cm: '30' };
  let r = cbmPlan({ ...sz, carton_cbm: '0.2' }); assert.equal(r.value, 0.2); assert.equal(r.source, 'entered');            // no choice → the supplier's number stays
  r = cbmPlan({ ...sz, carton_cbm: '0.2', cbm_use: 'calc' }); assert.equal(r.value, 0.06); assert.equal(r.supplier, 0.2); assert.equal(r.source, 'calc');
  r = cbmPlan({ ...sz, carton_cbm: '0.2', cbm_use: 'entered' }); assert.equal(r.value, 0.2);
  r = cbmPlan({ ...sz, carton_cbm: '0.0605' }); assert.equal(r.value, 0.06); assert.equal(r.source, 'calc');
  r = cbmPlan({ ...sz, carton_cbm: '' }); assert.equal(r.value, 0.06);
  r = cbmPlan({ carton_cbm: '0.3' }); assert.equal(r.value, 0.3); assert.equal(r.source, 'entered');                      // incomplete size: kept as entered, not zero
  r = cbmPlan({ carton_cbm: '' }); assert.equal(r.value, null);
  assert.equal(cartonCbmToStore({ ...sz, carton_cbm: '0.3' }, false), 0.3);                                                // service: nothing calculated
});
test('CBM choice is remembered with its source and read back by the form', () => {
  const sz = { carton_length_cm: '50', carton_width_cm: '40', carton_height_cm: '30' };
  const spec = buildSpec({ ...sz, carton_cbm: '0.2', cbm_use: 'calc', record_type: '' }, {});
  assert.equal(spec['Supplier CBM'], '0.2'); assert.equal(spec['CBM used'], 'Calculated from carton size');
  assert.deepEqual(specParts(spec).rows, [], 'the two bookkeeping keys are not shown as technical attributes');
  const st = cbmFormState({ spec, carton_cbm: 0.06, ...Object.fromEntries(Object.entries(sz)) });
  assert.deepEqual(st, { supplier: '0.2', use: 'calc' });
  // an older product whose stored volume equals the calculated one shows no "supplier-provided" value; a differing one keeps it
  assert.equal(cbmFormState({ spec: {}, carton_cbm: 0.06, ...sz }).supplier, '');
  assert.equal(cbmFormState({ spec: {}, carton_cbm: 0.2, ...sz }).supplier, '0.2');
  assert.equal(cbmFormState({ spec: {}, carton_cbm: 0.3 }).supplier, '0.3');
  assert.ok(!('Supplier CBM' in buildSpec({ ...sz, carton_cbm: '0.2', record_type: 'Service' }, {})), 'no CBM bookkeeping for service records');
});
test('validateProduct: field-level errors', () => {
  const bad = validateProduct({ name: '', unit_cost: '-5', moq: '1.5', hs_code: 'abc', src_lead: 'soon', src_incoterm: 'FOB', spec_k: ['a:b'], spec_v: ['x'] });
  for (const k of ['name', 'unit_cost', 'moq', 'hs_code', 'src_lead']) assert.ok(bad[k], k);
  assert.deepEqual(validateProduct({ name: 'Lamp', unit_cost: '3.5', moq: '100', hs_code: '9405.40.90', src_lead: '25-30', src_valid: '2026-12-31', spec_k: ['Power'], spec_v: ['10 W'] }), {});
});
test('splitSpec still reads what the form writes', () => {
  const out = buildSpec({ record_type: 'Service', src_incoterm: 'DAP', src_lead: '10', spec_k: ['Scope'], spec_v: ['Door'] }, {});
  assert.equal(splitSpec(out).sourcing.incoterm, 'DAP'); assert.deepEqual(splitSpec(out).tech, [['Scope', 'Door']]);
});

test('form view: six sections, sticky footer, structured rows, supplier terms', () => {
  const h = html('admin/products/form#edit');
  for (const id of ['sec-basic', 'sec-photos', 'sec-spec', 'sec-supply', 'sec-pack', 'sec-customs']) assert.match(h, new RegExp(`id="${id}"`));
  assert.match(h, /class="pe-foot"/); assert.match(h, /Save changes/); assert.match(h, /Cancel/);
  assert.match(h, /name="spec_k"/); assert.doesNotMatch(h, /<textarea[^>]*name="spec"/);
  for (const n of ['src_incoterm', 'src_lead', 'src_valid', 'supplier_sku', 'moq', 'unit_cost', 'hs_code']) assert.match(h, new RegExp(`name="${n}"`));
  assert.match(h, /keep the price they were created with/); assert.match(h, /id="peTitle"/); assert.match(h, /Jump to section/);
});
test('form view: primary radios only when supported; no photos → empty state', () => {
  assert.match(html('admin/products/form#edit'), /name="primary_photo_id"/);
  assert.doesNotMatch(html('admin/products/form#nophotos'), /name="primary_photo_id"/);
});
test('form view: service records lock packing; mismatch offers the keep control', () => {
  assert.match(html('admin/products/form#service'), /is-off/);
  assert.doesNotMatch(html('admin/products/form#edit'), /packWrap" class="[^"]*is-off|pe-two is-off/);
  assert.match(html('admin/products/form#cbm'), /name="cbm_use"/); assert.match(html('admin/products/form#cbm'), /Carton CBM/); assert.match(html('admin/products/form#cbm'), /Calculated/); assert.match(html('admin/products/form#cbm'), /Used for freight/);
});
test('form view: failed save keeps typed values and shows field errors', () => {
  const h = html('admin/products/form#errors');
  assert.match(h, /Enter the product name/); assert.match(h, /value="bad:key"/); assert.match(h, /value="-5"/); assert.match(h, /aria-invalid="true"/);
  assert.match(h, /Some fields need attention/);
});

test('validateProduct: pieces per carton must be at least 1 for physical records only', () => {
  assert.ok(validateProduct({ name: 'x', carton_qty: '0' }).carton_qty);
  assert.equal(validateProduct({ name: 'x', carton_qty: '0', record_type: 'Service' }).carton_qty, undefined);
  assert.equal(validateProduct({ name: 'x', carton_qty: '12' }).carton_qty, undefined);
});
test('header: the product name is the heading, "Edit product" is a breadcrumb, details sit underneath', () => {
  const h = html('admin/products/form#edit');
  assert.match(h, /<h1 class="pe-title" id="peTitle">LED Desk Lamp 10W<\/h1>/); assert.match(h, /aria-current="page">Edit product</);
  assert.match(h, /id="peMeta">SKU BW-LED-001 · Lighting · /);
  assert.doesNotMatch(h, /<h1[^>]*>Edit product/);
  assert.match(html('admin/products/form#long'), /extra long technical product name/);
});
test('photos: remove is an icon with an undo note, the stored file is untouched until the form is saved', () => {
  const h = html('admin/products/form#edit');
  assert.match(h, /data-rmphoto/); assert.match(h, /Removed when you save/); assert.doesNotMatch(h, />\s*Remove\s*<\/label>/);
  assert.match(h, /class="pe-ph main"/);
});
test('tooltips carry the long explanations and are reachable by keyboard', () => {
  const h = html('admin/products/form#edit');
  assert.match(h, /class="pe-i"[^>]*aria-describedby="tip1"/); assert.match(h, /role="tooltip"/);
  assert.doesNotMatch(h, /The product itself — the same whichever supplier makes it/);
});
test('save button starts disabled on an unchanged edit, enabled after a failed save', () => {
  assert.match(html('admin/products/form#edit'), /id="peSave" disabled/);
  assert.doesNotMatch(html('admin/products/form#errors'), /id="peSave" disabled/);
});
test('header: a new product is called "New Product"; CJK and Cyrillic names are shown in full', () => {
  const n = html('admin/products/form#new');
  assert.match(n, /id="peTitle">New Product</); assert.match(n, /aria-current="page">New product</); assert.doesNotMatch(n, /id="peSave" disabled/);
  const c = html('admin/products/form#cjk'); assert.match(c, /LED 台灯 10W/); assert.match(c, /Настольная лампа складная/);
});

test('five sections; specifications live inside Product information', () => {
  const h = html('admin/products/form#edit');
  const nav = h.slice(h.indexOf('id="peNav"'), h.indexOf('</nav>', h.indexOf('id="peNav"')));
  assert.equal((nav.match(/<a /g) || []).length, 5);
  for (const t of ['Product information', 'Photos, documents', 'Supplier', 'Dimensions', 'Customs']) assert.match(nav, new RegExp(t));
  const basic = h.slice(h.indexOf('id="sec-basic"'), h.indexOf('id="sec-photos"'));
  assert.match(basic, /id="sec-spec"/); assert.match(basic, /name="spec_k"/);
});
test('supplier terms are three groups with content-sized fields', () => {
  const h = html('admin/products/form#edit'), sup = h.slice(h.indexOf('id="sec-supply"'), h.indexOf('id="sec-pack"'));
  for (const g of ['<h3>Supplier information</h3>', '<h3>Purchase price</h3>', '<h3>Purchasing conditions</h3>']) assert.ok(sup.includes(g), g);
  const cls = n => (sup.match(new RegExp(`<label class="([^"]+)">[^<]*(?:<span[^>]*>[^<]*</span>)?\\s*<(?:input|select)[^>]*name="${n}"`)) || [])[1];
  assert.equal(cls('unit_cost'), 'field--compact'); assert.equal(cls('moq'), 'field--compact'); assert.equal(cls('src_lead'), 'field--compact'); assert.equal(cls('cost_currency'), 'field--compact');
  assert.equal(cls('supplier_sku'), 'field--medium'); assert.equal(cls('supplier_id'), 'field--wide');
  assert.doesNotMatch(sup, /pe-grid g6/);
});
test('measurements are compact rows; CBM sits below them in a compact summary', () => {
  const h = html('admin/products/form#edit'), pack = h.slice(h.indexOf('id="sec-pack"'), h.indexOf('id="sec-customs"'));
  assert.equal((pack.match(/field--compact/g) || []).length, 4 + 5 + 1);
  assert.ok(pack.indexOf('name="carton_height_cm"') < pack.indexOf('id="cbmBox"'));
  assert.match(pack, /Pieces \/ carton/); assert.match(pack, /Gross weight/);
});
test('field-size classes are shared, not one width per input', () => {
  const css = fs.readFileSync('public/css/app.css', 'utf8');
  for (const c of ['field--compact', 'field--medium', 'field--wide', 'field--fill']) assert.match(css, new RegExp('\\.' + c + '\\{'));
  const form = fs.readFileSync('src/views/admin/products/form.ejs', 'utf8');
  assert.doesNotMatch(form, /style="[^"]*width/);
});
test('documents: listed with type, date, size, View / Download; internal by default; removal only marked until save', () => {
  const h = html('admin/products/form#edit'), docs = h.slice(h.indexOf('id="docList"'), h.indexOf('id="docNew"'));
  assert.match(docs, /LED-lamp-datasheet\.pdf/); assert.match(docs, />PDF</); assert.match(docs, />Certificate</); assert.match(docs, />Excel</);
  assert.match(docs, /2026-10-02 · 471 KB/); assert.match(docs, />View</); assert.match(docs, />Download</); assert.match(docs, /\/admin\/documents\/d1\/download/);
  assert.match(docs, /name="remove_doc" value="d1" hidden/); assert.match(docs, /Removed when you save/);
  assert.match(docs, /· visible to client/); assert.equal((docs.match(/visible to client/g) || []).length, 1, 'only the one that really is client-visible is flagged');
  assert.match(h, /name="docs"/); assert.match(h, /name="doc_kind"/);
  assert.match(html('admin/products/form#nophotos').replace(/\s+/g, ' '), /id="docCount">3</);
});
test('documents: the AI can read saved PDFs, not spreadsheets', () => {
  const h = html('admin/products/form#edit');
  assert.match(h, /data-id="d1" data-ai="1"/); assert.match(h, /data-id="d3" data-ai=""/);
  assert.match(h, /Extract product details/); assert.match(h, /id="aiPick"/); assert.match(h, /AI suggests \(editable\)/);
  const off = render('src/views/admin/products/form.ejs', prodForm({}, { aiOn: false }));
  assert.doesNotMatch(off, /id="aiScan"/); assert.match(off, /id="docList"/, 'documents work without AI');
});
test('product-docs helpers', () => {
  assert.ok(isDocFile('a.PDF')); assert.ok(isDocFile('x.xlsx')); assert.ok(isDocFile('plan.dwg')); assert.ok(!isDocFile('virus.exe')); assert.ok(!isDocFile('photo.png'));
  assert.equal(docKindFor('certificate'), 'certificate'); assert.equal(docKindFor('x'), 'other'); assert.equal(docKindFor(undefined), 'other');
  assert.equal(docTypeLabel({ kind: 'certificate', title: 'a.pdf' }), 'Certificate'); assert.equal(docTypeLabel({ kind: 'other', title: 'a.xlsx' }), 'Excel'); assert.equal(docTypeLabel({ kind: 'other', title: 'z.dwg' }), 'Drawing');
  assert.ok(aiReadable({ title: 'a.pdf' })); assert.ok(aiReadable({ mime_type: 'image/png', title: 'x' })); assert.ok(!aiReadable({ title: 'a.xlsx', mime_type: 'application/vnd.ms-excel' }));
  assert.equal(fmtSize(482113), '471 KB'); assert.equal(fmtSize(3 * 1048576), '3.0 MB'); assert.equal(fmtSize(0), '');
});
test('routes: documents are saved internal, removal is limited to this product, AI reads saved files by id', () => {
  const r = fs.readFileSync('src/routes/admin/products.js', 'utf8');
  assert.match(r, /clientVisible: false/); assert.match(r, /neq\('kind', 'product_photo'\)\.in\('id', rmDocs\)/);
  assert.match(r, /req\.body\.stored/); assert.match(r, /entity_id', String\(req\.body\.product_id\)/); assert.match(r, /extractProductCard/);
  assert.match(r, /name: 'docs', maxCount/);
});
