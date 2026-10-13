import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCompany } from '../src/lib/company.js';

test('company form: required fields, email/phone checks, website + currency normalised', () => {
  const bad = validateCompany({ name: ' ', email: 'x', phone: '12' });
  assert.deepEqual(Object.keys(bad.errors).sort(), ['address', 'city', 'country', 'email', 'name', 'phone']);
  const ok = validateCompany({ name: 'Acme', country: 'USA', city: 'SF', address: '1 Main St', phone: '+1 415 555 0100', email: 'buy@acme.com', website: 'acme.com', default_currency: 'XXX' });
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.data.website, 'https://acme.com');
  assert.equal(ok.data.default_currency, 'USD');
  assert.equal(ok.data.tax_id, null);
});
