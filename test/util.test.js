import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clean, bool, fxRate } from '../src/lib/util.js';

test('clean() nulls empty strings and filters to allowed keys', () => {
  assert.deepEqual(clean({ a: '', b: 'x', evil: '1' }, ['a', 'b']), { a: null, b: 'x' });
});
test('bool() reads checkboxes', () => {
  assert.equal(bool('on'), true); assert.equal(bool(undefined), false);
});
test('fxRate() uses direct, reverse and identity pairs', () => {
  const s = { fx: { CNY_USD: 0.138, EUR_USD: 1.08 } };
  assert.equal(fxRate(s, 'CNY', 'USD'), 0.138);
  assert.ok(Math.abs(fxRate(s, 'USD', 'EUR') - 1 / 1.08) < 1e-9);
  assert.equal(fxRate(s, 'USD', 'USD'), 1);
});
