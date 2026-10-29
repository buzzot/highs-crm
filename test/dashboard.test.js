import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsAttention, shipmentFlag, paymentsOpen, monthBuckets, niceScale, describeActivity, groupActivity, statusSummary, isOpenOrder } from '../src/lib/dashboard.js';

const today = '2026-10-29', now = Date.parse('2026-10-29T12:00:00Z');

test('a shipment is late only with a past ETA and no arrival', () => {
  assert.equal(shipmentFlag({ status: 'departed', eta: '2026-10-20' }, today).kind, 'late');
  assert.equal(shipmentFlag({ status: 'delivered', eta: '2026-10-20' }, today), null);
  assert.equal(shipmentFlag({ status: 'departed', eta: '2026-10-20', ata: '2026-10-19' }, today), null);
  assert.equal(shipmentFlag({ status: 'customs', eta: '2026-10-20' }, today), null);
  assert.equal(shipmentFlag({ status: 'departed', eta: '2026-11-02', tracking_no: 'X' }, today).kind, 'soon');
  assert.equal(shipmentFlag({ status: 'departed', eta: '2027-01-02' }, today).kind, 'notrack');
  assert.equal(shipmentFlag({ status: 'booked', eta: null }, today), null);
});

test('waiting for a supplier is never called overdue; a past deadline is', () => {
  const items = needsAttention({ now, today,
    pos: [{ id: 'p', ref: 'SPO-1', status: 'sent', sent_at: '2026-08-01T00:00:00Z', suppliers: { name: 'A' } }],
    rfqs: [{ id: 'r', ref: 'RFQ-1', title: 'x', deadline: '2026-10-01' }, { id: 'r2', ref: 'RFQ-2', title: 'y', deadline: '2026-12-01' }] });
  assert.equal(items.find(i => i.ref === 'SPO-1').overdue, false);
  assert.equal(items.find(i => i.ref === 'RFQ-1').overdue, true);
  assert.equal(items.find(i => i.ref === 'RFQ-2'), undefined);
  assert.equal(items[0].ref, 'RFQ-1');           // overdue first
});

test('PI drafts, replies and missing PIs are listed; empty input gives nothing', () => {
  assert.deepEqual(needsAttention({ now, today }), []);
  const items = needsAttention({ now, today,
    pos: [{ id: 'a', ref: 'A', status: 'replied', suppliers: { name: 'S' } }, { id: 'b', ref: 'B', status: 'confirmed', suppliers: { name: 'S' } }, { id: 'c', ref: 'C', status: 'confirmed', suppliers: { name: 'S' } }],
    pis: [{ id: 'i', po_id: 'c', status: 'draft', total: 5, currency: 'USD' }] });
  assert.deepEqual(items.map(i => [i.ref, i.kind]).sort(), [['A', 'po_reply'], ['B', 'pi_missing'], ['C', 'pi']]);
});

test('outstanding balance = approved PI total − payments, per currency', () => {
  const o = paymentsOpen({ pos: [{ id: 'p', ref: 'P', suppliers: { name: 'S' } }], pis: [{ po_id: 'p', status: 'confirmed', currency: 'USD', total: 1000 }, { po_id: 'q', status: 'draft', currency: 'USD', total: 9 }], pays: [{ po_id: 'p', amount: 300 }] });
  assert.equal(o.length, 1); assert.equal(o[0].open, 700);
});

test('month buckets include zero months and order matters', () => {
  const m = monthBuckets([{ date: '2026-10-05T00:00:00Z', revenue: 10, profit: 2 }, { date: '2026-04-05T00:00:00Z', revenue: 99, profit: 9 }], 6, new Date('2026-10-29T00:00:00Z'));
  assert.deepEqual(m.map(x => x.key), ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
  assert.equal(m[0].revenue, 0); assert.equal(m[5].revenue, 10);          // April is outside the window
  assert.deepEqual(niceScale(0), { top: 1, ticks: [0] });
  assert.equal(niceScale(13300).top, 20000);
});

test('activity reads like a sentence and merges repeats', () => {
  assert.equal(describeActivity({ action: 'supplier_pi_approved', detail: { note: 'SPO-1: PI-9' } }).text, 'Supplier PI approved');
  assert.equal(describeActivity({ action: 'supplier_po_status', detail: { note: 'SPO-1: confirmed' } }).text, 'Supplier PO confirmed');
  assert.equal(describeActivity({ action: 'some_new_thing' }).text, 'Some new thing');
  const g = groupActivity([1, 2, 3].map(i => ({ action: 'product_created_from_pi', detail: { note: 'P' + i }, created_at: 'x', profiles: { full_name: 'A' } })), 8);
  assert.equal(g.length, 1); assert.equal(g[0].n, 3);
});

test('open orders exclude delivered, closed and cancelled', () => {
  assert.deepEqual(['confirmed', 'delivered', 'closed', 'cancelled', 'customs'].filter(s => isOpenOrder({ status: s })), ['confirmed', 'customs']);
  assert.deepEqual(statusSummary([{ status: 'qc' }, { status: 'qc' }, { status: 'shipped' }]), [{ status: 'qc', n: 2 }, { status: 'shipped', n: 1 }]);
});

test('levels: broken rules are critical, past deadlines overdue, decisions review, waiting pending', () => {
  const items = needsAttention({ now, today,
    lowMargin: [{ id: 'o', order_no: 'O-1', margin_pct: 12.34, client_name: 'C' }], exportGaps: [{ id: 's', orders: { order_no: 'S-1' } }],
    shipments: [{ id: 'a', status: 'departed', eta: '2026-10-20', orders: { order_no: 'SH-A' } }, { id: 'b', status: 'departed', eta: '2026-09-01', orders: { order_no: 'SH-B' } }],
    pos: [{ id: 'p', ref: 'P1', status: 'replied', suppliers: {} }, { id: 'q', ref: 'P2', status: 'sent', suppliers: {} }] });
  const lv = Object.fromEntries(items.map(i => [i.ref, i.level]));
  assert.deepEqual(lv, { 'S-1': 'critical', 'O-1': 'critical', 'SH-B': 'critical', 'SH-A': 'overdue', P1: 'review', P2: 'pending' });
  assert.equal(items.find(i => i.ref === 'O-1').action, 'Margin 12.3% is below the 20% minimum');
  assert.equal(items.find(i => i.ref === 'P2').overdue, false);
  assert.deepEqual(items.map(i => i.level), ['critical', 'critical', 'critical', 'overdue', 'review', 'pending']);
});

test('owner: tasks carry the record owner; a supplier PO belongs to its order owner, else its creator', () => {
  const items = needsAttention({ now, today,
    pos: [{ id: 'a', ref: 'A', status: 'replied', created_by: 'u2', orders: { owner_id: 'u1' }, suppliers: {} }, { id: 'b', ref: 'B', status: 'sent', created_by: 'u2', orders: null, suppliers: {} }],
    requests: [{ id: 'r', ref: 'R', status: 'new', owner_id: 'u3', created_at: '2026-10-28T00:00:00Z', organizations: {} }] });
  assert.deepEqual(Object.fromEntries(items.map(i => [i.ref, i.owner])), { A: 'u1', B: 'u2', R: 'u3' });
});

test('one row per supplier PO: a reply and a PI are merged, with a quick-action link', () => {
  const items = needsAttention({ now, today, pos: [{ id: 'a', ref: 'A', status: 'replied', suppliers: {} }], pis: [{ id: 'i', po_id: 'a', status: 'draft', total: 1, currency: 'USD' }] });
  assert.equal(items.length, 1);
  assert.equal(items[0].cta, 'Open reply');
  assert.match(items[0].action, /Supplier replied.*PI needs approval/);
});

test('arriving soon only counts shipments that are really in transit', () => {
  assert.equal(shipmentFlag({ status: 'booked', eta: '2026-11-02' }, today), null);
  assert.equal(shipmentFlag({ status: 'departed', eta: '2026-11-02', tracking_no: 'x' }, today).kind, 'soon');
});
