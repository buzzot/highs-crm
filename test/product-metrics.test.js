import { test } from 'node:test';
import assert from 'node:assert/strict';
import { productMetrics, unitsPer40hq, cartonCbm, bestOf } from '../src/lib/product-metrics.js';

const fx = c => ({ CNY: 0.138, USD: 1 }[c] ?? 1);

test('units per 40HQ use volume and weight limits', () => {
  assert.equal(unitsPer40hq({ carton_cbm: 0.045, carton_qty: 20 }), Math.floor(68 / 0.045) * 20);       // volume-bound
  assert.equal(unitsPer40hq({ carton_cbm: 0.02, carton_qty: 10, carton_weight_kg: 30 }), Math.floor(26500 / 30) * 10); // weight-bound
  assert.equal(unitsPer40hq({ carton_qty: 10 }), null);
  assert.equal(cartonCbm({ carton_length_cm: 50, carton_width_cm: 40, carton_height_cm: 30 }), 0.06);
});

test('landed and suggested wholesale', () => {
  const m = productMetrics({ unit_cost: 38.5, cost_currency: 'CNY', carton_cbm: 0.045, carton_qty: 20, carton_weight_kg: 14, moq: 500, hs_code: '9405' }, fx);
  const units = Math.floor(68 / 0.045) * 20;
  assert.equal(m.unitsPer40hq, units);
  assert.equal(m.priceUsd, 5.313);
  assert.ok(Math.abs(m.landedUsd - (5.313 + 4500 / units)) < 1e-4);
  assert.ok(Math.abs(m.wholesaleUsd - m.landedUsd * 1.45) < 0.01);
  assert.deepEqual(m.issues, []);
});

test('missing data is reported, estimates stay empty', () => {
  const m = productMetrics({ unit_cost: null, cost_currency: 'USD' }, fx);
  assert.equal(m.landedUsd, null);
  assert.ok(m.issues.includes('no price') && m.issues.includes('no carton size'));
});

test('best value per comparison row', () => {
  assert.deepEqual([...bestOf([3, 1, null, 1])], [1, 3]);
  assert.deepEqual([...bestOf([5, 9], 'high')], [1]);
  assert.deepEqual([...bestOf([5, null])], []);
});
