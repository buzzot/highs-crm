import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSupplierCompany } from '../src/lib/supplier-company.js';
import { inviteEmail } from '../src/lib/email-templates.js';
import { homeFor } from '../src/lib/util.js';

const good = { name: 'Dongguan Milky Way Rubber Co., Ltd.', company_type: 'factory', country: 'China', city: 'Dongguan', address: 'No. 8 Industrial Rd',
  contact_name: 'Li Kuan', email: 'LI@milkyway.example ', wechat: 'likuan', main_products: 'Silicone baby products', year_established: '2008', lead_time_days: '30', can_export_official: 'on' };

test('valid supplier company passes and is cleaned', () => {
  const { data, errors } = validateSupplierCompany(good);
  assert.deepEqual(errors, {});
  assert.equal(data.email, 'li@milkyway.example');
  assert.equal(data.year_established, 2008);
  assert.equal(data.lead_time_days, 30);
  assert.equal(data.can_export_official, true);
  assert.equal(data.phone, null);
});

test('required fields and phone-or-wechat', () => {
  const { errors } = validateSupplierCompany({ ...good, name: '', company_type: 'bogus', wechat: '', phone: '', main_products: ' ', year_established: '08' });
  assert.deepEqual(Object.keys(errors).sort(), ['company_type', 'main_products', 'name', 'phone', 'year_established']);
});

test('supplier invitation email is worded for suppliers', () => {
  const m = inviteEmail({ url: 'https://lumitrade.cc/invite/x', code: '123456', orgName: null, inviterName: 'Anna', days: 14, kind: 'supplier' });
  assert.match(m.subject, /register as a supplier/i);
  assert.match(m.html, /portal as a supplier/);
  assert.match(m.html, /123456/);
  assert.doesNotMatch(m.html + m.text, /sourcing requests|supabase|Highs/i);
  const c = inviteEmail({ url: 'u', code: '1', orgName: 'Acme', days: 14 });
  assert.match(c.subject, /Lumi Trade portal/);
  assert.doesNotMatch(c.subject, /Acme/);
  assert.match(c.html, /Lumi Trade portal as a client of Acme/);
});

test('each role has its own home', () => {
  assert.equal(homeFor('supplier'), '/supplier');
  assert.equal(homeFor('client'), '/portal');
  assert.equal(homeFor('admin'), '/admin');
});
