import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClients, normCountry, PAGE } from '../src/lib/clients.js';

const orgs = [
  { id: '1', name: 'Zeta Co', country: 'USA', default_currency: 'USD', active: true },
  { id: '2', name: 'ООО "ПРО ЭКСПЕРТ"', country: 'Russian Federation', default_currency: 'CNY', active: true },
  { id: '3', name: 'Alpha', country: '', default_currency: 'CNY', active: false },
  { id: '4', name: 'Beta', country: 'United States', default_currency: 'EUR', active: true },
];
const data = { orgs, users: [{ org_id: '4', full_name: 'Tom Baker', email: 'tom@beta.example' }, { org_id: '4', full_name: 'Ann', email: 'a@beta.example' }], reqs: [{ org_id: '1', created_at: '2026-10-01T00:00:00Z' }, { org_id: '1', created_at: '2026-10-05T00:00:00Z' }], ords: [{ org_id: '1', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-10-20T00:00:00Z' }] };

test('country names are standardised for display and filtering only', () => {
  assert.equal(normCountry('USA'), 'United States'); assert.equal(normCountry('us'), 'United States'); assert.equal(normCountry('Russian Federation'), 'Russia'); assert.equal(normCountry('CN'), 'China'); assert.equal(normCountry('  '), '');
  const r = buildClients(data, { country: 'United States' });
  assert.deepEqual(r.rows.map(x => x.name), ['Beta', 'Zeta Co']);
  assert.equal(orgs[0].country, 'USA');                       // stored value untouched
});

test('counts, last activity and portal users come from the real relations', () => {
  const z = buildClients(data, {}).rows.find(x => x.id === '1');
  assert.equal(z.requests, 2); assert.equal(z.orders, 1); assert.equal(z.lastActivity, '2026-10-20T00:00:00Z'); assert.equal(z.users, 0);
  assert.equal(buildClients(data, {}).rows.find(x => x.id === '4').users, 2);
});

test('search covers company, country and contact names, accents and Cyrillic included', () => {
  assert.deepEqual(buildClients(data, { q: 'tom baker' }).rows.map(x => x.name), ['Beta']);
  assert.deepEqual(buildClients(data, { q: 'russia' }).rows.map(x => x.name), ['ООО "ПРО ЭКСПЕРТ"']);
  assert.deepEqual(buildClients(data, { q: 'экспе' }).rows.length, 1);
  assert.deepEqual(buildClients(data, { q: 'zzz' }).total, 0);
});

test('filters and sorting', () => {
  assert.deepEqual(buildClients(data, { state: 'inactive' }).rows.map(x => x.name), ['Alpha']);
  assert.deepEqual(buildClients(data, { currency: 'CNY' }).rows.map(x => x.name), ['Alpha', 'ООО "ПРО ЭКСПЕРТ"']);
  assert.deepEqual(buildClients(data, { country: '_none' }).rows.map(x => x.name), ['Alpha']);
  assert.deepEqual(buildClients(data, { sort: 'requests', dir: 'desc' }).rows[0].name, 'Zeta Co');
  const c = buildClients(data, { sort: 'country' }).rows.map(x => x.name);
  assert.equal(c[c.length - 1], 'Alpha');                      // clients without a country always last
  assert.equal(buildClients(data, { sort: 'country', dir: 'desc' }).rows.at(-1).name, 'Alpha');
  assert.equal(buildClients(data, { sort: 'bogus' }).sort, 'name');
});

test('hundreds of clients are paged', () => {
  const many = Array.from({ length: 321 }, (_, i) => ({ id: 'x' + i, name: 'C' + String(i).padStart(3, '0'), default_currency: 'USD', active: true }));
  const p2 = buildClients({ orgs: many }, { page: '2' });
  assert.equal(p2.rows.length, PAGE); assert.equal(p2.rows[0].name, 'C050'); assert.equal(p2.pages, 7); assert.equal(p2.from, 51); assert.equal(p2.to, 100);
  assert.equal(buildClients({ orgs: many }, { page: '99' }).page, 7);
  assert.deepEqual(buildClients({ orgs: [] }, {}).rows, []);
});

test('last activity uses the newest request change or order change', () => {
  const r = buildClients({ orgs: [{ id: '1', name: 'A', default_currency: 'USD' }], reqs: [{ org_id: '1', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-10-25T00:00:00Z' }], ords: [{ org_id: '1', created_at: '2026-02-01T00:00:00Z', updated_at: '2026-10-10T00:00:00Z' }] }, {}).rows[0];
  assert.equal(r.lastActivity, '2026-10-25T00:00:00Z');
});
