import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usageFrom, addUsage, usageLine, costOf } from '../src/lib/ai-usage.js';

test('usage is read from the API response and summed', () => {
  const a = usageFrom({ model: 'claude-haiku-5-5', usage: { input_tokens: 3900, output_tokens: 284 } });
  assert.deepEqual(a, { model: 'claude-haiku-5-5', input: 3900, output: 284, cacheRead: 0, cacheWrite: 0, total: 4184 });
  const b = usageFrom({ usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000 } }, 'm');
  const s = addUsage(a, null, b);
  assert.equal(s.total, 4184 + 1150);
  assert.equal(addUsage(null), null);
});

test('usage line, with and without prices', () => {
  const u = usageFrom({ model: 'claude-haiku-5-5', usage: { input_tokens: 3900, output_tokens: 284 } });
  assert.equal(usageLine(u), 'claude-haiku-5-5 · 4,184 tokens (3,900 in · 284 out)');
  assert.equal(costOf(u, {}), null);
  assert.ok(Math.abs(costOf(u, { input_per_m: 1, output_per_m: 5 }) - (3900 + 284 * 5) / 1e6) < 1e-12);
  assert.match(usageLine(u, { input_per_m: 1, output_per_m: 5 }), /≈ \$0\.0053$/);
});
