import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSchedule, withAmounts, paymentStatus, nextInstalment } from '../src/lib/payments.js';
import { scheduleText } from '../src/lib/purchase.js';

test('schedule rows are parsed, capped and amounts add up to the total', () => {
  const s = parseSchedule({ sched: { 0: { label: 'Deposit', percent: '33.33', due: '2026-11-01' }, 1: { label: 'Balance', percent: '66.67', due: 'bad' }, 2: { label: '', percent: '5' }, 3: { label: 'x', percent: '0' } } });
  assert.equal(s.length, 2);
  assert.equal(s[1].due, '');
  const rows = withAmounts(s, 1000);
  assert.equal(rows.reduce((t, x) => t + x.amount, 0), 1000);
});

test('payment status: unpaid, partial, paid', () => {
  assert.equal(paymentStatus(1000, 0), 'unpaid');
  assert.equal(paymentStatus(1000, 300), 'partial');
  assert.equal(paymentStatus(1000, 1000), 'paid');
  assert.equal(paymentStatus(null, 100), 'unpaid');
});

test('next instalment shows what is still open and its due date', () => {
  const sch = withAmounts([{ label: 'Deposit', percent: 30, due: '2026-11-01' }, { label: 'Balance', percent: 70, due: '2026-12-10' }], 1000);
  assert.deepEqual(nextInstalment(sch, 0), { label: 'Deposit', amount: 300, due: '2026-11-01' });
  assert.deepEqual(nextInstalment(sch, 100), { label: 'Deposit', amount: 200, due: '2026-11-01' });
  assert.deepEqual(nextInstalment(sch, 300), { label: 'Balance', amount: 700, due: '2026-12-10' });
  assert.equal(nextInstalment(sch, 1000), null);
});

test('PI pdf text lists the schedule', () => {
  const t = scheduleText({ currency: 'USD', lines: [{ quantity: 10, unit_price: 100 }], schedule: [{ label: 'Deposit', percent: 30, due: '2026-11-01' }] });
  assert.match(t, /Deposit 30% · USD 300\.00 · due 01 Nov 2026/);
});
