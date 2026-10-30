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
  assert.match(h, /keep the price they were created with/); assert.match(h, /id="peTitle"/);
});
test('form view: primary radios only when supported; no photos → empty state', () => {
  assert.match(html('admin/products/form#edit'), /name="primary_photo_id"/);
  assert.doesNotMatch(html('admin/products/form#nophotos'), /name="primary_photo_id"/);
});
test('form view: service records lock packing; mismatch offers the keep control', () => {
  assert.match(html('admin/products/form#service'), /is-off/);
  assert.doesNotMatch(html('admin/products/form#edit'), /packWrap" class="[^"]*is-off|pe-two is-off/);
  assert.match(html('admin/products/form#cbm'), /name="cbm_use"/); assert.match(html('admin/products/form#cbm'), /Volume <span class="pe-unit">CBM/); assert.match(html('admin/products/form#cbm'), /id="cbmUse"/);
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

test('two-column workspace: product info, supplier and customs on the left; photos/documents/AI and packaging on the right', () => {
  const h = html('admin/products/form#edit');
  const L = h.slice(h.indexOf('pe-col pe-left'), h.indexOf('pe-col pe-right')), R = h.slice(h.indexOf('pe-col pe-right'), h.indexOf('class="pe-foot"'));
  for (const id of ['sec-basic', 'sec-supply', 'sec-customs']) { assert.match(L, new RegExp(`id="${id}"`)); assert.doesNotMatch(R, new RegExp(`id="${id}"`)); }
  for (const id of ['sec-photos', 'sec-pack']) { assert.match(R, new RegExp(`id="${id}"`)); assert.doesNotMatch(L, new RegExp(`id="${id}"`)); }
  assert.match(L.slice(L.indexOf('id="sec-basic"'), L.indexOf('id="sec-supply"')), /id="sec-spec"/, 'specifications sit inside Product information');
  assert.doesNotMatch(h, /id="peNav"/, 'the five-link section bar is gone — two columns fit on one screen');
  assert.ok(h.indexOf('class="pe-foot"') > h.indexOf('id="sec-customs"') && h.indexOf('class="pe-foot"') > h.indexOf('id="sec-pack"'));
});
test('supplier & pricing: essentials always visible, the rest under "More purchasing terms" with a summary', () => {
  const h = html('admin/products/form#edit'), sup = h.slice(h.indexOf('id="sec-supply"'), h.indexOf('id="sec-customs"'));
  const more = sup.slice(sup.indexOf('<details'), sup.indexOf('</details>')), top = sup.slice(0, sup.indexOf('<details'));
  for (const n of ['supplier_id', 'supplier_sku', 'unit_cost', 'cost_currency', 'moq']) assert.match(top, new RegExp(`name="${n}"`), n + ' stays visible');
  for (const n of ['src_incoterm', 'src_lead', 'src_valid']) { assert.match(more, new RegExp(`name="${n}"`), n); assert.doesNotMatch(top, new RegExp(`name="${n}"`)); }
  assert.match(more, /More purchasing terms/); assert.match(more, /id="moreSum"><span class="pe-chip">FOB<\/span><span class="pe-chip">30 days lead time<\/span><span class="pe-chip">valid until 2026-12-31<\/span>/);
  assert.doesNotMatch(more.slice(0, 20), /open/); assert.match(sup, /pe-more" id="moreTerms" >/);
  assert.match(html('admin/products/form#errors').replace(/\s+/g, ' '), /id="moreTerms" open/, 'a problem in a hidden term opens it');
  assert.equal((sup.match(/<h3>(Supplier|Price &amp; minimum order)<\/h3>/g) || []).length, 2, 'two labelled blocks');
  assert.match(sup, /<span class="pk-join"><input[^>]*name="unit_cost"[\s\S]*?<select name="cost_currency"/, 'price and currency are one joined control');
  assert.match(sup, /<i data-unit>/, 'the MOQ unit sits inside the field and follows Sold per');
  assert.ok(sup.indexOf('name="supplier_sku"') > sup.indexOf('name="supplier_id"') && sup.indexOf('name="supplier_sku"') < sup.indexOf('Price &amp; minimum order'), 'supplier and its SKU share the first block');
  assert.doesNotMatch(sup, /pe-group|pe-grid g6/, 'no stacked sub-cards');
});
test('measurements: export packaging first, joined L × W × H fields, one volume field and one status line, the choice only on a conflict', () => {
  const h = html('admin/products/form#edit'), pack = h.slice(h.indexOf('id="sec-pack"'), h.indexOf('class="pe-foot"'));
  assert.match(pack, /<h3>Export packaging /); assert.match(pack, /<h3>Single product /);
  assert.ok(pack.indexOf('Export packaging') < pack.indexOf('Single product'));
  assert.equal((pack.match(/class="pk-trio"/g) || []).length, 2, 'one joined size field per block');
  for (const n of ['carton_length_cm', 'carton_width_cm', 'carton_height_cm', 'unit_length_cm', 'unit_width_cm', 'unit_height_cm', 'carton_qty', 'carton_weight_kg', 'carton_cbm', 'unit_weight_kg', 'package_type']) assert.match(pack, new RegExp('name="' + n + '"'), n);
  assert.ok(pack.indexOf('name="carton_height_cm"') < pack.indexOf('name="carton_cbm"'));
  assert.match(pack, /id="cbmUse"/); assert.match(pack, /Qty per package/); assert.doesNotMatch(pack, /id="cbmCalc"|Carton CBM|Used for freight &amp; costing/);
  assert.match(pack, /id="cbmPick" hidden/, 'the comparison starts hidden');
});
test('customs is a small card in the left column', () => {
  const h = html('admin/products/form#edit'), c = h.slice(h.indexOf('id="sec-customs"'), h.indexOf('pe-col pe-right'));
  assert.match(c, /name="hs_code"/); assert.match(c, /field--medium/); assert.match(c, /Not verified/); assert.match(c, /role="tooltip"/);
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
  assert.match(h, /name="docs"/); assert.doesNotMatch(h, /name="doc_kind"/);
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

test('one upload entry point: a single "+ Add files" button; photos and documents are sorted by type', () => {
  const h = html('admin/products/form#edit');
  assert.equal((h.match(/<button[^>]*>\+ Add (files|photos|documents)</g) || []).length, 1); assert.match(h, /id="fileAdd">\+ Add files</);
  for (const gone of ['id="phAdd"', 'id="docAdd"', 'id="phAdd2"', 'id="docAdd2"', 'Save as:']) assert.ok(!h.includes(gone), gone);
  assert.match(h, /id="fileInput"[^>]*accept="[^"]*\.pdf[^"]*\.jpg|id="fileInput"[^>]*accept="\.jpg[^"]*\.pdf/);
  assert.match(h, /name="photos"/); assert.match(h, /name="docs"/, 'the two form fields still carry the files to the same server fields');
});
test('empty attachments: one short line, no empty blocks', () => {
  const h = html('admin/products/form#nofiles');
  assert.match(h, /id="attEmpty" >|id="attEmpty">/); assert.doesNotMatch(h, /id="attEmpty" hidden/);
  assert.match(h, /id="phBlock" hidden/); assert.match(h, /id="docPanel" hidden/);
  const full = html('admin/products/form#edit'); assert.match(full, /id="attEmpty" hidden/); assert.doesNotMatch(full, /id="phBlock" hidden/);
});

test('specifications: one Add attribute button, plain empty state', () => {
  const h = html('admin/products/form#edit'); assert.equal((h.match(/Add attribute/g) || []).length, 1); assert.doesNotMatch(h, /specAdd2/);
});

test('Sold per and Package type are stored in the spec, read back, and stay optional', async () => {
  const { buildSpec, specParts, UNITS, PACKAGE_TYPES } = await import('../src/lib/product-form.js');
  assert.ok(UNITS.includes('m') && PACKAGE_TYPES.includes('Reel') && !PACKAGE_TYPES.includes('Roll') && !['Bucket', 'Bundle', 'Loose / bulk'].some(x => PACKAGE_TYPES.includes(x)) && !PACKAGE_TYPES.includes('Drum / reel'));
  assert.ok(!PACKAGE_TYPES.includes('Box') && !UNITS.includes('boxes') && PACKAGE_TYPES.includes('Carton') && UNITS.includes('cartons'));
  const spec = buildSpec({ record_type: '', sold_per: 'm', package_type: 'Reel', spec_k: ['Diameter'], spec_v: ['12 mm'] }, {});
  assert.equal(spec['Sold per'], 'm'); assert.equal(spec['Package type'], 'Reel'); assert.equal(spec.Diameter, '12 mm');
  const back = specParts(spec);
  assert.equal(back.unit.value, 'm'); assert.equal(back.pkg.value, 'Reel'); assert.deepEqual(back.rows, [['Diameter', '12 mm']]);
  assert.deepEqual(buildSpec({ record_type: '' }, {}), {});                                         // empty = nothing stored
  assert.equal(buildSpec({ record_type: 'Service', package_type: 'Pallet', sold_per: 'sets' }, {})['Package type'], undefined);   // no package for a service
  assert.equal(buildSpec({ sold_per: 'kg', spec_k: ['Sold per'], spec_v: ['pcs'] }, {})['Sold per'], 'kg');           // an old row cannot override the selector
  assert.equal(buildSpec({ record_type: '' }, { 'uom': 'kg' })['uom'], undefined);                                      // posted form is the source of truth
});

test('edit form: Sold per and Package type selectors, with labels that follow them', () => {
  const base = pages['admin/products/form#edit'] || pages['admin/products/form'];
  const loc = Array.isArray(base) ? base[1] : base;
  const html = render('src/views/admin/products/form.ejs', { ...loc, units: ['pcs', 'm', 'kg'], packageTypes: ['Carton', 'Reel', 'Pallet'], f: { ...(loc.f || {}), unit: 'm', pkg: 'Reel', rows: (loc.f || {}).rows || [] } });
  assert.match(html, /name="sold_per"[\s\S]*?<option selected>m<\/option>/);
  assert.match(html, /name="package_type"[\s\S]*?<option selected>Reel<\/option>/);
  assert.match(html, /Qty per package <span class="pe-unit" data-unit>m<\/span>/);
  assert.match(html, /<i data-unit>m<\/i>/);
});

test('edit form: the default unit and package read plainly, without "(default)"', () => {
  const base = pages['admin/products/form#edit'] || pages['admin/products/form'];
  const loc = Array.isArray(base) ? base[1] : base;
  const html = render('src/views/admin/products/form.ejs', loc);
  assert.match(html, /<option value="">pcs<\/option>/);
  assert.match(html, /<option value="">Carton<\/option>/);
  assert.doesNotMatch(html, /\(default\)/);
});
