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
  const m = productMetrics({ unit_cost: 38.5, cost_currency: 'CNY', carton_cbm: 0.045, carton_qty: 20, carton_weight_kg: 14, moq: 500, hs_code: '9405', supplier_id: 's1', category: 'Lighting' }, fx);
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

import { fxToUsdStrict, productKind } from '../src/lib/product-metrics.js';
const strict = fxToUsdStrict({ fx: { CNY_USD: 0.138, USD_EUR: 0.92 } });
const full = { unit_cost: 10, cost_currency: 'USD', carton_cbm: 0.05, carton_qty: 10, carton_weight_kg: 12, moq: 100, hs_code: '9405', supplier_id: 's1', category: 'Lighting' };

test('price conversion: strict FX never guesses — an unknown currency gives null, not 1:1', () => {
  assert.equal(strict('USD'), 1); assert.equal(strict('CNY'), 0.138);
  assert.ok(Math.abs(strict('EUR') - 1 / 0.92) < 1e-9);   // derived from the inverse pair
  assert.equal(strict('GBP'), null);
  const m = productMetrics({ ...full, cost_currency: 'GBP' }, strict);
  assert.equal(m.priceUsd, null); assert.equal(m.landedUsd, null); assert.equal(m.fxOk, false);
  assert.ok(m.critical.some(g => g.label === 'no exchange rate'));
});
test('costing: a full carton profile is an estimate with a full basis and a 31% implied margin for a 45% markup', () => {
  const m = productMetrics(full, strict);
  assert.equal(m.landedBasis, 'full'); assert.equal(m.critical.length, 0);
  assert.ok(Math.abs(m.impliedMarginPct - 31.03) < 0.05); assert.equal(m.markupPct, 45);
});
test('costing: without a carton weight the load is volume-only and flagged, not presented as full', () => {
  const m = productMetrics({ ...full, carton_weight_kg: null }, strict);
  assert.equal(m.landedBasis, 'volume'); assert.ok(m.landedUsd > 10);
  assert.deepEqual(m.optional.map(g => g.label), ['no carton weight']);
});
test('costing: missing or impossible logistics inputs give no landed cost at all', () => {
  assert.equal(productMetrics({ ...full, carton_qty: null }, strict).landedUsd, null);
  assert.equal(productMetrics({ ...full, carton_cbm: null }, strict).landedUsd, null);
  const big = productMetrics({ ...full, carton_cbm: 90 }, strict);       // bigger than a 40HQ
  assert.equal(big.landedUsd, null); assert.ok(big.critical.some(g => g.label.startsWith('carton too big')));
  const heavy = productMetrics({ ...full, carton_weight_kg: 30000 }, strict);
  assert.equal(heavy.landedUsd, null);
});
test('missing data is split into critical and optional, each with a form field to open', () => {
  const m = productMetrics({ unit_cost: 5, cost_currency: 'USD' }, strict);
  const crit = m.critical.map(g => g.label), opt = m.optional.map(g => g.label);
  for (const l of ['no supplier', 'no pcs/carton', 'no carton size']) assert.ok(crit.includes(l), l);
  for (const l of ['no MOQ', 'no HS code', 'no category']) assert.ok(opt.includes(l), l);
  assert.ok([...m.critical, ...m.optional].every(g => g.field && g.hint));
  assert.equal(m.issues.length, m.critical.length + m.optional.length);
  assert.ok(productMetrics({ ...full, unit_cost: 0 }, strict).critical.some(g => g.label === 'price is 0'));
});
test('CBM entered that disagrees with the carton size is an optional warning', () => {
  const m = productMetrics({ ...full, carton_cbm: 0.2, carton_length_cm: 50, carton_width_cm: 40, carton_height_cm: 30 }, strict);
  assert.ok(m.optional.some(g => g.label === 'carton CBM ≠ size'));
});
test('product types: Service and Freight skip carton and container costing; samples and packaging stay physical', () => {
  assert.deepEqual(productKind({ spec: { Type: 'Service' } }), { label: 'Service', physical: false });
  assert.equal(productKind({ spec: { 'Product type': 'freight' } }).physical, false);
  assert.equal(productKind({ spec: { Type: 'Sample' } }).physical, true);
  assert.equal(productKind({ spec: { Type: 'Packaging' } }).physical, true);
  assert.equal(productKind({}).physical, true);
  const m = productMetrics({ unit_cost: 50, cost_currency: 'USD', spec: { Type: 'Service' }, supplier_id: 's1', category: 'Service', moq: 1, hs_code: null }, strict);
  assert.equal(m.physical, false); assert.equal(m.landedUsd, null);
  assert.equal([...m.critical, ...m.optional].some(g => /carton|pcs/.test(g.label)), false);
});

test('the same estimates are also given in the product currency (null for USD or without a rate)', () => {
  const p = { unit_cost: 4.05, cost_currency: 'CNY', carton_cbm: 0.486, carton_qty: 500, carton_weight_kg: 410 };
  const m = productMetrics(p, fx);
  assert.equal(m.localCur, 'CNY');
  assert.ok(Math.abs(m.landedLocal * 0.138 - m.landedUsd) < 0.001);
  assert.ok(Math.abs(m.freightLocal * 0.138 - m.freightPerUnit) < 0.001);
  assert.ok(Math.abs(m.wholesaleLocal * 0.138 - m.wholesaleUsd) < 0.01);
  assert.equal(productMetrics({ ...p, cost_currency: 'USD' }, fx).localCur, null);
  assert.equal(productMetrics(p, () => null).landedLocal, null);
});
