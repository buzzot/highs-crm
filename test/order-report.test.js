import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../src/lib/order-report.js';

const st = { pricing: {} };
test('report: income, expenses and balance per order', () => {
  const orders = [{ id: 'a', order_no: 'A1', currency: 'USD', cost_total: 500, supplier_name: 'S', status: 'confirmed', owner_id: 'u' }];
  const { rows, totals } = buildReport({ orders, cur: 'USD', settings: st, staff: [{ id: 'u', full_name: 'Anna' }],
    pays: [{ order_id: 'a', amount: 1000, currency: 'USD', status: 'confirmed', paid_on: '2026-10-01' }, { order_id: 'a', amount: 300, currency: 'USD', status: 'submitted' }, { order_id: 'a', amount: 9, currency: 'USD', status: 'rejected' }],
    pos: [{ order_id: 'a', total: 600, currency: 'USD', status: 'confirmed', suppliers: { name: 'Acme Co' } }, { order_id: 'a', total: 50, currency: 'USD', status: 'draft' }],
    ships: [{ id: 's', order_id: 'a', forwarders: { name: 'Fwd' } }], costs: [{ shipment_id: 's', amount: 100, currency: 'USD' }] });
  const r = rows[0];
  assert.equal(r.staff, 'Anna');
  assert.equal(r.incomes.length, 2);                 // rejected is not shown
  assert.equal(r.income, 1000);                      // waiting-for-confirmation is not in the balance
  assert.deepEqual(r.expenses.map(e => e.name), ['Acme Co', 'Fwd']);   // draft PO ignored, cost_total not used when a PO exists
  assert.equal(r.balance, 300);
  assert.equal(totals.balance, 300);
});
test('report: no PO → estimate from order cost; cancelled not in totals', () => {
  const { rows, totals } = buildReport({ cur: 'USD', settings: st, orders: [{ id: 'a', currency: 'USD', cost_total: 500, supplier_name: 'S', status: 'confirmed' }, { id: 'b', currency: 'USD', cost_total: 900, status: 'cancelled' }] });
  assert.equal(rows[0].expenses[0].est, true);
  assert.equal(totals.expense, 500);
});
