import test from 'node:test';
import assert from 'node:assert/strict';
import { piTotal, checkPi, paymentPlan, matchProducts } from '../src/lib/supplier-pi.js';

test('PI total and the printed-total check', () => {
  const lines = [{ quantity: 100, unit_price: 12.5 }, { quantity: 40, unit_price: 3.333 }];
  assert.equal(piTotal(lines), 1383.32);
  assert.equal(checkPi({ lines, declared: 1383.32, poTotal: 1383.32 }).matches, true);
  const bad = checkPi({ lines, declared: 1400, poTotal: 1200 });
  assert.equal(bad.matches, false); assert.equal(bad.diff, 16.68); assert.equal(bad.vsPo, 183.32); assert.equal(bad.samePo, false);
  assert.equal(checkPi({ lines, declared: '' }).matches, false);      // no printed total yet → not confirmed
});
test('payments are shares of the PI total', () => {
  const p = paymentPlan(10000, [{ amount: 3000 }, { amount: 7000 }]);
  assert.deepEqual(p.rows.map(r => r.pct), [30, 70]); assert.equal(p.status, 'paid'); assert.equal(p.open, 0);
  const q = paymentPlan(10000, [{ amount: 3000 }]);
  assert.equal(q.status, 'partial'); assert.equal(q.open, 7000); assert.equal(q.pctPaid, 30);
  assert.equal(paymentPlan(0, []).status, 'unpaid');
  assert.equal(paymentPlan(100, [{ amount: 150 }]).status, 'over');
});
test('AI lines are matched to products by SKU then name', () => {
  const prods = [{ id: 'p1', sku: 'BW-1', name: 'Desk lamp' }, { id: 'p2', sku: null, name: 'USB cable' }];
  const out = matchProducts([{ sku: 'bw-1', description: 'x' }, { description: 'usb CABLE' }, { description: 'new thing' }], prods);
  assert.deepEqual(out.map(l => l.product_id), ['p1', 'p2', undefined]);
});
