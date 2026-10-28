import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcQuote, marginFromPrice } from '../src/lib/pricing.js';
import { landed } from '../src/lib/landed.js';

test('margin is applied to product cost only, logistics passed through', () => {
  const c = calcQuote({ unitCost: 100, fxRate: 0.14, marginPct: 25, quantity: 1000, freightTotal: 700, dutiesTotal: 200, otherTotal: 100 });
  assert.equal(c.unitCostSell, 14);
  assert.equal(c.unitPrice, 17.5);           // 14 × 1.25
  assert.equal(c.logisticsPerUnit, 1);       // 1000 / 1000
  assert.equal(c.landedUnitPrice, 18.5);
  assert.equal(c.goodsTotal, 17500);
  assert.equal(c.grossProfit, 3500);         // freight does not touch profit
  assert.equal(c.effectiveMarginPct, 25);
  assert.equal(c.meetsMinimum, true);
  assert.deepEqual(c.warnings, []);
});

test('flags margin below the 20% minimum', () => {
  const c = calcQuote({ unitCost: 10, fxRate: 1, marginPct: 15, quantity: 10 });
  assert.equal(c.meetsMinimum, false);
  assert.match(c.warnings[0], /below the 20% minimum/);
});

test('exactly 20% passes', () => {
  assert.equal(calcQuote({ unitCost: 10, fxRate: 1, marginPct: 20, quantity: 1 }).meetsMinimum, true);
});

test('custom minimum from settings', () => {
  assert.equal(calcQuote({ unitCost: 10, fxRate: 1, marginPct: 22, quantity: 1, minMarginPct: 25 }).meetsMinimum, false);
});

test('warns on missing cost and on logistics exceeding price', () => {
  assert.ok(calcQuote({ unitCost: 0, fxRate: 1, marginPct: 30, quantity: 1 }).warnings.some(w => /zero/.test(w)));
  assert.ok(calcQuote({ unitCost: 1, fxRate: 1, marginPct: 30, quantity: 10, freightTotal: 100 }).warnings.some(w => /Logistics/.test(w)));
});

test('quantity floors to at least 1', () => {
  assert.equal(calcQuote({ unitCost: 1, fxRate: 1, marginPct: 20, quantity: 0 }).quantity, 1);
});

test('reverse: target price → implied margin', () => {
  assert.equal(marginFromPrice({ unitCost: 100, fxRate: 0.14, targetUnitPrice: 17.5 }), 25);
  assert.equal(marginFromPrice({ unitCost: 0, fxRate: 1, targetUnitPrice: 5 }), null);
});

test('landed cost spreads actual logistics by quantity', () => {
  const l = landed({ subtotal: 1250, cost_total: 1000, freight_total: 200 }, [
    { quantity: 100, unit_cost: 5, unit_price: 6.25 }, { quantity: 100, unit_cost: 5, unit_price: 6.25 },
  ]);
  assert.equal(l.qty, 200);
  assert.equal(l.freightPerUnit, 1);
  assert.equal(l.items[0].landed_unit_cost, 6);
  assert.equal(l.items[0].landed_unit_price, 7.25);
  assert.equal(l.landedCostTotal, 1200);
  assert.equal(l.landedSellTotal, 1450);
});

import { compareScenarios, dutyOf } from '../src/lib/scenarios.js';
test('duty is on the sell value (+ freight when CIF), VAT on value + duty', () => {
  assert.deepEqual(dutyOf({ goodsTotal: 10000, freightTotal: 1000, dutyPct: 10, vatPct: 20, base: 'goods' }), { customsValue: 10000, duty: 1000, vat: 2200, total: 3200 });
  assert.deepEqual(dutyOf({ goodsTotal: 10000, freightTotal: 1000, dutyPct: 10, vatPct: 0, base: 'cif' }), { customsValue: 11000, duty: 1100, vat: 0, total: 1100 });
});
test('scenario comparison ranks cheapest for the client, most profit and fastest', () => {
  const fxOf = c => (c === 'CNY' ? 0.14 : 1);
  const { rows } = compareScenarios({ quantity: 1000, fxOf, scenarios: [
    { label: 'Air', unitCost: 100, costCurrency: 'CNY', marginPct: 25, freightTotal: 2000, dutyPct: 5, leadDays: 20 },
    { label: 'Rail', unitCost: 100, costCurrency: 'CNY', marginPct: 25, freightTotal: 500, dutyPct: 5, leadDays: 35 },
    { label: 'Blank', unitCost: '' } ] });
  assert.equal(rows.length, 2);                                   // empty column ignored
  const [air, rail] = rows;
  assert.equal(air.unitPrice, 17.5); assert.equal(air.duty, 875);
  assert.equal(rail.cheapestForClient, true); assert.equal(air.cheapestForClient, false);
  assert.equal(air.fastest, true); assert.equal(rail.fastest, false);
  assert.equal(air.grossProfit, rail.grossProfit);                // same margin, logistics is pass-through
  assert.ok(!air.mostProfit && !rail.mostProfit);                 // a tie highlights nobody
  assert.ok(rail.vsCheapest === 0 && air.vsCheapest > 0);
});
