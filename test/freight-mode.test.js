import test from 'node:test';
import assert from 'node:assert/strict';
import { shownOf, modeOf, piLines } from '../src/lib/freight-mode.js';
import { combineQuotes, poLinesFromCombined, quotationDocument } from '../src/lib/combined-quote.js';
import { poFromQuote, totalOf } from '../src/lib/purchase.js';

const q = (o = {}) => ({ id: 'a', quantity: 200, unit_price: 148.2, freight_estimate: 500, duties_estimate: 0, other_costs: 0, sell_currency: 'CNY', ...o });

test('modeOf accepts only the two modes', () => { assert.equal(modeOf('included'), 'included'); assert.equal(modeOf('x'), 'separate'); assert.equal(modeOf(undefined), 'separate'); });

test('separate: the client sees goods and a logistics amount', () => {
  const s = shownOf(q()); assert.equal(s.included, false); assert.equal(s.unit_price, 148.2); assert.equal(s.goods, 29640); assert.equal(s.logistics, 500); assert.equal(s.total, 30140);
});
test('included: freight is inside the unit price, total unchanged', () => {
  const s = shownOf(q({ freight_mode: 'included' })); assert.equal(s.included, true); assert.equal(s.unit_price, 150.7); assert.equal(s.logistics, 0); assert.equal(s.goods, 30140); assert.equal(s.total, 30140);
});

test('combined quotation with freight included: no freight line, same grand total, real figures kept for staff', () => {
  const c = combineQuotes([q({ id: 'a', freight_mode: 'included' }), q({ id: 'b', quantity: 100, unit_price: 10, freight_estimate: 50, freight_mode: 'included' })]);
  assert.equal(c.included, true); assert.equal(c.grandTotal, 30140 + 1050); assert.equal(c.shown.logisticsTotal, 0); assert.equal(c.logisticsTotal, 550); assert.equal(c.goodsTotal, 29640 + 1000);
  const lines = poLinesFromCombined(c);
  assert.equal(lines.length, 2); assert.ok(!lines.some(l => /Freight/.test(l.description)));
  assert.ok(Math.abs(totalOf(lines) - c.grandTotal) < 0.02);
  assert.match(quotationDocument({ request: {}, combined: c, org: {}, company: { name: 'L' } }).sections[1].text, /include freight/);
});
test('combined quotation with separate freight keeps the freight line', () => {
  const c = combineQuotes([q(), q({ id: 'b' })]);
  assert.equal(c.included, false); assert.equal(poLinesFromCombined(c).at(-1).description, 'Freight & logistics (estimate)'); assert.equal(totalOf(poLinesFromCombined(c)), c.grandTotal);
});
test('PO from a single quote follows the mode', () => {
  const inc = poFromQuote({ quote: q({ freight_mode: 'included' }), item: { name: 'Housing' }, request: { title: 'x' }, org: {}, profile: {} });
  assert.equal(inc.lines.length, 1); assert.equal(inc.lines[0].unit_price, 150.7); assert.equal(totalOf(inc.lines), 30140);
  const sep = poFromQuote({ quote: q(), item: { name: 'Housing' }, request: { title: 'x' }, org: {}, profile: {} });
  assert.equal(sep.lines.length, 2); assert.equal(totalOf(sep.lines), 30140);
});

test('proforma invoice freight: none, separate line, or spread into the unit prices', () => {
  const lines = [{ description: 'A', quantity: 100, unit_price: 10 }, { description: 'B', quantity: 50, unit_price: 20 }]; // goods 1000 + 1000
  assert.equal(piLines({ lines }).length, 2);
  assert.equal(piLines({ lines, freight: { amount: 500, mode: 'none' } }).length, 2);
  const sep = piLines({ lines, freight: { amount: 500, mode: 'separate' } });
  assert.equal(sep.length, 3); assert.equal(sep[2].unit_price, 500); assert.equal(totalOf(sep), 2500);
  const inc = piLines({ lines, freight: { amount: 500, mode: 'included' } });
  assert.equal(inc.length, 2); assert.equal(inc[0].unit_price, 12.5); assert.equal(inc[1].unit_price, 25); assert.equal(totalOf(inc), 2500);
  // no prices yet: spread by quantity
  const free = piLines({ lines: [{ quantity: 100, unit_price: 0 }, { quantity: 100, unit_price: 0 }], freight: { amount: 200, mode: 'included' } });
  assert.deepEqual(free.map(l => l.unit_price), [1, 1]);
});

test('proforma invoice freight buffer percentage is added to the freight', () => {
  const lines = [{ description: 'A', quantity: 100, unit_price: 10 }];
  const sep = piLines({ lines, freight: { amount: 1000, buffer_pct: 10, mode: 'separate' } });
  assert.equal(sep[1].unit_price, 1100);
  assert.equal(totalOf(piLines({ lines, freight: { amount: 1000, buffer_pct: 10, mode: 'included' } })), 2100);
});
