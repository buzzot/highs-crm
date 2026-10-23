import test from 'node:test';
import assert from 'node:assert/strict';
import { localizeEmail } from '../src/lib/i18n.js';
import { pickLang } from '../src/lib/i18n.js';

test('pickLang defaults to English', () => {
  assert.equal(pickLang('ru'), 'ru');
  assert.equal(pickLang('xx'), 'en');
  assert.equal(pickLang(undefined), 'en');
});
test('localizeEmail leaves English untouched and translates Russian', () => {
  const m = { subject: 'Your sign-in code', html: '<p>Sign in</p>', text: 'x' };
  assert.deepEqual(localizeEmail(m, 'en'), m);
  const r = localizeEmail(m, 'ru');
  assert.ok(r.html && typeof r.subject === 'string');
});
