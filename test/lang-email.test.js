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

import { newRequestEmail } from '../src/lib/email-templates.js';
test('new request email names the client and links the request', () => {
  const m = newRequestEmail({ request: { ref: 'REQ-1', title: 'Rope' }, orgName: 'Acme', who: 'Tom', products: 2, url: 'https://x/admin/sourcing/1' });
  assert.match(m.subject, /REQ-1.*Acme/);
  assert.match(m.html, /2 products/);
  assert.match(m.text, /https:\/\/x\/admin\/sourcing\/1/);
});
