import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from './mini-ejs.js';
import { pages } from './fixtures.js';
import { specParts, recordTypeOf, isNonPhysical, postedRows, buildSpec, cbmFromSize, cbmDiffers, cartonCbmToStore, validateProduct } from '../src/lib/product-form.js';
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
test('CBM: calculated from the size, mismatch beyond 5 %, entered value kept only on request', () => {
  assert.equal(cbmFromSize(50, 40, 30), 0.06); assert.equal(cbmFromSize(50, 40, ''), null);
  assert.ok(cbmDiffers(0.2, 0.06)); assert.ok(!cbmDiffers(0.0605, 0.06));
  const sz = { carton_length_cm: '50', carton_width_cm: '40', carton_height_cm: '30' };
  assert.equal(Number(cartonCbmToStore({ ...sz, carton_cbm: '0.2' }, true)), 0.06);
  assert.equal(Number(cartonCbmToStore({ ...sz, carton_cbm: '0.2', keep_cbm: 'on' }, true)), 0.2);
  assert.equal(Number(cartonCbmToStore({ carton_cbm: '0.3' }, true)), 0.3);
  assert.equal(Number(cartonCbmToStore({ ...sz, carton_cbm: '0.3' }, false)), 0.3);
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
  assert.match(h, /already made/);
});
test('form view: primary radios only when supported; no photos → empty state', () => {
  assert.match(html('admin/products/form#edit'), /name="primary_photo_id"/);
  assert.doesNotMatch(html('admin/products/form#nophotos'), /name="primary_photo_id"/);
});
test('form view: service records lock packing; mismatch offers the keep control', () => {
  assert.match(html('admin/products/form#service'), /is-off/);
  assert.doesNotMatch(html('admin/products/form#edit'), /packWrap" class="[^"]*is-off|pe-two is-off/);
  assert.match(html('admin/products/form#cbm'), /keep_cbm/);
});
test('form view: failed save keeps typed values and shows field errors', () => {
  const h = html('admin/products/form#errors');
  assert.match(h, /Enter the product name/); assert.match(h, /value="bad:key"/); assert.match(h, /value="-5"/); assert.match(h, /aria-invalid="true"/);
  assert.match(h, /Some fields need attention/);
});
