import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign, unsign, seal, unseal, hashSecret } from '../src/lib/signed.js';

test('sealed cookie round-trips and hides its content', () => {
  const v = seal({ e: 'a@b.com', rt: 'refresh-secret' }, 60e3);
  assert.doesNotMatch(v, /refresh-secret|a@b\.com/);
  assert.equal(unseal(v).rt, 'refresh-secret');
});
test('tampered or expired values are rejected', () => {
  const v = seal({ e: 'a@b.com' }, 60e3);
  const parts = v.split('.'); parts[2] = parts[2].slice(0, -2) + (parts[2].endsWith('A') ? 'BB' : 'AA');
  assert.equal(unseal(parts.join('.')), null);
  assert.equal(unseal(seal({ e: 1 }, -1)), null);
  assert.equal(unsign(sign({ t: 1 }, -1)), null);
  assert.equal(unsign(sign({ t: 1 }, 60e3) + 'x'), null);
});
test('code hashes differ per purpose/email', () => {
  assert.notEqual(hashSecret('login:a@b.com:123456'), hashSecret('invite:a@b.com:123456'));
});
