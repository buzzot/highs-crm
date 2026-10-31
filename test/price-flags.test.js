import test from 'node:test';
import assert from 'node:assert/strict';
import { priceFlags, marginAt, trim4 } from '../src/lib/price-flags.js';
let pinfo = null;
try { pinfo = await import('../src/lib/price-info.js'); } catch { /* database client not installed here */ }

test('trim4 and marginAt', () => {
  assert.equal(trim4(12.50004), '12.5');
  assert.equal(Math.round(marginAt(100, 80)), 20);
});
test('priceFlags: no history gives an info note only', () => {
  const f = priceFlags({ price: 10, info: { cur: 'USD', cost: null, hist: [] }, minMargin: 20 });
  assert.ok(f.every(x => x.kind !== 'bad'));
});
test('priceFlags: below cost is bad, differing last price is warn with a use value', () => {
  const info = { cur: 'USD', cost: 10, hist: [{ price: 15, qty: 1, date: '2026-01-01', order_no: 'A', cur_orig: 'USD', price_orig: 15, cost_then: 10 }] };
  const f = priceFlags({ price: 9, info, minMargin: 20 });
  assert.ok(f.some(x => x.kind === 'bad'));
  assert.ok(f.some(x => x.use != null));
  assert.ok(!priceFlags({ price: 15, info, minMargin: 20 }).some(x => x.kind === 'bad'));
});
test('buildHistory skips cancelled and zero-price rows, newest first', { skip: !pinfo }, () => {
  const { buildInfo, buildHistory } = pinfo;
  const rows = [
    { product_id: 'p', quantity: 1, unit_price: 5, unit_cost: 3, orders: { id: 'o1', order_no: 'A', org_id: 'x', currency: 'USD', status: 'cancelled', created_at: '2026-02-01' } },
    { product_id: 'p', quantity: 2, unit_price: 0, unit_cost: 3, orders: { id: 'o2', order_no: 'B', org_id: 'x', currency: 'USD', status: 'new', created_at: '2026-03-01' } },
    { product_id: 'p', quantity: 4, unit_price: 7, unit_cost: 3, orders: { id: 'o3', order_no: 'C', org_id: 'x', currency: 'USD', status: 'confirmed', created_at: '2026-01-01' } },
  ];
  const h = buildHistory(rows, 'USD', 1);
  assert.equal(h.length, 1);
  assert.equal(h[0].order_no, 'C');
  const i = buildInfo({ product: { id: 'p', unit_cost: 4, cost_currency: 'USD' }, rows, cur: 'USD', rate: 1 });
  assert.equal(i.cost, 4);
});
