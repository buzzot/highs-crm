import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogItems, changes, fromProduct, toProduct, STATUS_LABEL } from '../src/lib/supplier-product.js';

const prod = { id: 'p1', name: 'Lamp', supplier_sku: 'L-1', category: 'Lighting', unit_cost: 5, cost_currency: 'USD', moq: 100, carton_qty: 20, carton_length_cm: 50, carton_width_cm: 40, carton_height_cm: 30, carton_weight_kg: 12, spec: { Materials: 'ABS', Incoterm: 'FOB' }, created_at: '2026-01-01' };

test('fromProduct reverses toProduct', () => {
  const d = fromProduct(prod, ['ph1']);
  assert.equal(d.materials, 'ABS'); assert.equal(d.incoterm, 'FOB'); assert.equal(d.unit_price, 5); assert.deepEqual(d.photo_ids, ['ph1']);
  assert.equal(toProduct(d, 's1').spec.Materials, 'ABS');
});
test('changes lists only differing fields', () => {
  const a = fromProduct(prod), b = { ...a, unit_price: 6, materials: 'ABS' };
  assert.deepEqual(changes(a, b).map(c => c.key), ['unit_price']);
});
test('a product with an edit request shows that status and no duplicate row', () => {
  const subs = [{ id: 'x1', status: 'edit_requested', product_id: 'p1', data: fromProduct(prod), updated_at: '2026-10-02' }];
  const items = catalogItems({ products: [prod], subs });
  assert.equal(items.length, 1); assert.equal(items[0].status, 'edit_requested'); assert.equal(items[0].kind, 'product');
});
test('updated: the supplier sees the values they sent', () => {
  const subs = [{ id: 'x1', status: 'updated', product_id: 'p1', data: { ...fromProduct(prod), unit_price: 7 }, updated_at: '2026-10-02' }];
  const [it] = catalogItems({ products: [prod], subs });
  assert.equal(it.status, 'updated'); assert.equal(it.price, 7); assert.equal(it.subId, 'x1'); assert.equal(STATUS_LABEL.updated, 'Updated');
});
test('declined request leaves the product in catalog with a note', () => {
  const subs = [{ id: 'x1', status: 'approved', product_id: 'p1', review_note: 'Not now', data: {}, updated_at: '2026-10-02' }];
  const [it] = catalogItems({ products: [prod], subs });
  assert.equal(it.status, 'selected'); assert.match(it.note, /Not now/);
});
