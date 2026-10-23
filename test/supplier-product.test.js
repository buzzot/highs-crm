import test from 'node:test';
import assert from 'node:assert/strict';
import { clean, missing, containerFit, toProduct } from '../src/lib/supplier-product.js';

test('clean trims text, parses numbers and defaults the currency', () => {
  const d = clean({ name: '  Seal ', unit_price: '1,25', moq: '', carton_qty: '-3', currency: 'GBP', photo_link: 'example.com/a' });
  assert.equal(d.name, 'Seal'); assert.equal(d.unit_price, 1.25); assert.equal(d.moq, null); assert.equal(d.carton_qty, null);
  assert.equal(d.currency, 'USD'); assert.equal(d.photo_link, 'https://example.com/a');
});

test('missing lists what the review step still needs', () => {
  assert.deepEqual(missing(clean({}), 0).map(m => m.key), ['unit_price', 'photos', 'carton', 'gross_kg']);
  const full = clean({ unit_price: '2', carton_qty: '50', carton_l: '40', carton_w: '30', carton_h: '20', gross_kg: '9' });
  assert.deepEqual(missing(full, 1), []);
  assert.deepEqual(missing({ ...full, photo_link: 'https://x.co' }, 0), []);
});

test('containerFit: units per container from carton size', () => {
  assert.equal(containerFit(clean({})), null);
  const f = containerFit(clean({ carton_qty: '10', carton_l: '50', carton_w: '40', carton_h: '30' }));
  assert.equal(f.cartonCbm, 0.06); assert.equal(f.gp20, Math.floor(28 * 0.85 / 0.06) * 10);
});

test('toProduct maps the form onto a products row; extras go into spec', () => {
  const d = clean({ name: 'Seal', sku: 'S-1', unit_price: '0.5', currency: 'CNY', moq: '1000', size: '18 x 6.5 x 6.5', materials: 'EPDM', carton_qty: '200', carton_l: '60', carton_w: '40', carton_h: '30', gross_kg: '15', net_kg: '14', lead_days: '25' });
  const p = toProduct(d, 'sup1');
  assert.equal(p.supplier_id, 'sup1'); assert.equal(p.supplier_sku, 'S-1'); assert.equal(p.unit_cost, 0.5); assert.equal(p.cost_currency, 'CNY'); assert.equal(p.moq, 1000);
  assert.deepEqual([p.unit_length_cm, p.unit_width_cm, p.unit_height_cm], [18, 6.5, 6.5]);
  assert.equal(p.carton_cbm, 0.072); assert.equal(p.carton_weight_kg, 15); assert.equal(p.carton_qty, 200);
  assert.equal(p.spec.Materials, 'EPDM'); assert.equal(p.spec['Carton net weight (kg)'], '14'); assert.equal(p.spec['Production lead time (days)'], '25');
  assert.equal(p.spec.Brand, undefined);
});

import { completeness, catalogItems } from '../src/lib/supplier-product.js';
test('catalogItems merges submissions and catalog products; completeness is a percentage', () => {
  assert.equal(completeness({}, 0), 0);
  const items = catalogItems({ products: [{ id: 'p1', name: 'A', created_at: '2026-10-01', unit_cost: 2 }], photoOf: {}, subs: [{ id: 's1', status: 'draft', data: { name: 'B' }, updated_at: '2026-10-05' }, { id: 's2', status: 'approved', data: { name: 'C' }, updated_at: '2026-10-06' }] });
  assert.deepEqual(items.map(i => [i.name, i.status]), [['B', 'draft'], ['A', 'selected']]);
  assert.ok(items[0].pct > 0 && items[0].pct < 100);
});
