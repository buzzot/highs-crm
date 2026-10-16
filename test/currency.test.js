import test from 'node:test';
import assert from 'node:assert/strict';
import { fmt } from '../src/lib/format.js';
import { fxRate } from '../src/lib/util.js';
import { sumIn, okCurrency } from '../src/lib/currency.js';

test('yuan shows as plain ¥, other currencies keep their symbols', () => {
  assert.equal(fmt.money(29640, 'CNY', 0), '¥29,640'); assert.equal(fmt.money(150.7, 'CNY'), '¥150.70'); assert.equal(fmt.money(5, 'USD'), '$5.00'); assert.match(fmt.money(5, 'EUR'), /€/);
});
test('fxRate goes through USD when there is no direct rate', () => {
  const s = { fx: { CNY_USD: 0.14, EUR_USD: 1.1 } };
  assert.equal(fxRate(s, 'CNY', 'USD'), 0.14); assert.equal(fxRate(s, 'USD', 'CNY'), 1 / 0.14);
  assert.ok(Math.abs(fxRate(s, 'EUR', 'CNY') - 1.1 / 0.14) < 1e-9); assert.equal(fxRate(s, 'CNY', 'CNY'), 1);
});
test('sumIn adds mixed currencies in the target currency', () => {
  const s = { fx: { CNY_USD: 0.14 } };
  assert.ok(Math.abs(sumIn(s, 'CNY', [[100, 'CNY'], [14, 'USD'], [null, 'USD']]) - 200) < 1e-9);
});
test('okCurrency falls back to CNY', () => { assert.equal(okCurrency('EUR'), 'EUR'); assert.equal(okCurrency('xx'), 'CNY'); });
