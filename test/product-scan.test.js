import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanCard } from '../src/lib/product-card.js';

test('cleanCard keeps only usable values and builds spec lines', () => {
  const c = cleanCard({ name: ' Steel tumbler ', supplier_sku: '', unit_cost: 12.5, cost_currency: 'GBP', moq: 100.4, unit_weight_kg: -1, carton_qty: 24,
    spec: [{ key: 'Capacity', value: '500 ml' }, { key: '', value: 'x' }], warnings: ['blurry label', ''] });
  assert.equal(c.name, 'Steel tumbler'); assert.equal(c.supplier_sku, null); assert.equal(c.cost_currency, null);
  assert.equal(c.moq, 100); assert.equal(c.unit_weight_kg, null); assert.equal(c.carton_qty, 24);
  assert.equal(c.spec, 'Capacity: 500 ml'); assert.deepEqual(c.warnings, ['blurry label']);
});
test('cleanCard copes with an empty answer', () => {
  const c = cleanCard({}); assert.equal(c.name, null); assert.equal(c.spec, null); assert.deepEqual(c.warnings, []);
});
