import test from 'node:test';
import assert from 'node:assert/strict';
import { combineQuotes, poLinesFromCombined, quotationDocument, quotationPdf } from '../src/lib/combined-quote.js';

const q = (id, qty, price, freight, extra = {}) => ({ id, quantity: qty, unit_price: price, freight_estimate: freight, duties_estimate: 0, other_costs: 0, sell_currency: 'USD', incoterm: 'FOB', lead_time_days: 20, valid_until: '2026-11-15', unit_cost: price / 1.25, fx_rate: 1, margin_pct: 25, status: 'draft', ...extra });
const names = { a: 'Lamp', b: 'Toy' };
const c = combineQuotes([q('a', 500, 5, 100), q('b', 1000, 2, 50, { lead_time_days: 35, valid_until: '2026-11-01' })], { nameOf: x => names[x.id] });

test('totals add goods and logistics over all lines', () => {
  assert.equal(c.goodsTotal, 4500);
  assert.equal(c.logisticsTotal, 150);
  assert.equal(c.grandTotal, 4650);
  assert.equal(c.lead_time_days, 35);      // the longest lead time
  assert.equal(c.valid_until, '2026-11-01'); // the earliest expiry
  assert.equal(c.incoterm, 'FOB');
  assert.equal(c.profit, 900);              // 4500 − 3600 cost
});

test('PO lines carry goods at unit prices plus one logistics line, so the PO total equals the quote total', () => {
  const lines = poLinesFromCombined(c);
  assert.equal(lines.length, 3);
  assert.equal(lines.reduce((t, l) => t + l.quantity * l.unit_price, 0), c.grandTotal);
});

test('mixed currencies are flagged', () => {
  assert.ok(combineQuotes([q('a', 1, 1, 0), q('b', 1, 1, 0, { sell_currency: 'EUR' })]).mixed);
});

test('quotation PDF renders', () => {
  const doc = quotationDocument({ request: { ref: 'IRQ-2610-0530', title: 'Lamps', destination_city: 'Hamburg', destination_country: 'Germany' }, combined: c, org: { name: 'Acme' }, company: { name: 'Lumi Trade', payment_terms: '30/70' } });
  assert.equal(doc.title, 'QUOTATION');
  assert.ok(doc.meta.some(([k, v]) => k === 'Destination' && v === 'Hamburg, Germany'));
  const pdf = quotationPdf({ request: { ref: 'IRQ-1', title: 'x' }, combined: c, org: { name: 'Acme' }, company: { name: 'Lumi Trade' } });
  assert.equal(Buffer.from(pdf).subarray(0, 4).toString(), '%PDF');
});

test('dropReplaced keeps only the newest live quote per request line', async () => {
  const { dropReplaced } = await import('../src/lib/combined-quote.js');
  const q = (id, item, status, at) => ({ id, request_item_id: item, status, created_at: at });
  const out = dropReplaced([q('a', 'i1', 'accepted', '2026-10-16T07:45'), q('b', 'i1', 'accepted', '2026-10-16T08:27'), q('c', 'i1', 'rejected', '2026-10-15'), q('d', 'i2', 'sent', '2026-10-16')]);
  assert.deepEqual(out.map(x => x.id), ['b', 'c', 'd']);
});
