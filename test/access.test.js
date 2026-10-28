import test from 'node:test';
import assert from 'node:assert/strict';
import { store, scopeTable, levelOf, canDelete, canSee, canAssign, guardFor, _forceReady } from '../src/lib/access.js';

// a query builder that records what was asked of it
const fake = () => {
  const log = [];
  const chain = { eq: (c, v) => (log.push(['eq', c, v]), chain), single: () => chain };
  const b = { select: (...a) => (log.push(['select', ...a]), chain), insert: (r) => (log.push(['insert', r]), chain), update: (v) => (log.push(['update', v]), chain), delete: () => (log.push(['delete']), chain), upsert: (r) => (log.push(['upsert', r]), chain) };
  return { b, log };
};
const as = (user, fn) => store.run({ user }, fn);
const admin = { id: 'a1', role: 'admin' }, director = { id: 'd1', role: 'staff', staff_level: 'director' }, manager = { id: 'm1', role: 'staff', staff_level: 'manager' };
const legacy = { id: 'l1', role: 'staff' };   // staff before migration 0036: no staff_level

test('levels: admin, director (also old staff), manager; clients and suppliers have none', () => {
  assert.equal(levelOf(admin), 'admin'); assert.equal(levelOf(director), 'director'); assert.equal(levelOf(legacy), 'director'); assert.equal(levelOf(manager), 'manager');
  assert.equal(levelOf({ role: 'client' }), null); assert.equal(levelOf(null), null);
});

test('a Manager reads and updates only their own records, and cannot reassign them', () => {
  _forceReady(true);
  const { b, log } = fake();
  as(manager, () => { const s = scopeTable(b, 'orders'); s.select('*'); s.update({ status: 'x', owner_id: 'someone', created_by: 'someone' }); });
  assert.deepEqual(log, [['select', '*'], ['eq', 'owner_id', 'm1'], ['update', { status: 'x' }], ['eq', 'owner_id', 'm1']]);
});

test('records a Manager creates are theirs; their documents are matched on creator', () => {
  _forceReady(true);
  const a = fake(); as(manager, () => scopeTable(a.b, 'requests').insert({ title: 'T' }));
  assert.deepEqual(a.log[0], ['insert', { created_by: 'm1', owner_id: 'm1', title: 'T' }]);
  const c = fake(); as(manager, () => scopeTable(c.b, 'purchase_orders').select('*'));
  assert.deepEqual(c.log, [['select', '*'], ['eq', 'created_by', 'm1']]);
});

test('Director sees everything, deletes only what they created; Admin deletes anything', () => {
  _forceReady(true);
  const d = fake(); as(director, () => { const s = scopeTable(d.b, 'orders'); s.select('*'); s.delete(); });
  assert.deepEqual(d.log, [['select', '*'], ['delete'], ['eq', 'created_by', 'd1']]);
  const a = fake(); as(admin, () => scopeTable(a.b, 'orders').delete());
  assert.deepEqual(a.log, [['delete']]);
  const i = fake(); as(director, () => scopeTable(i.b, 'orders').insert({ x: 1 }));
  assert.deepEqual(i.log[0], ['insert', { created_by: 'd1', x: 1 }]);   // no owner: it inherits the owner of what it belongs to
});

test('a Manager deleting needs both: created by them and owned by them', () => {
  _forceReady(true);
  const { b, log } = fake(); as(manager, () => scopeTable(b, 'rfqs').delete());
  assert.deepEqual(log, [['delete'], ['eq', 'created_by', 'm1'], ['eq', 'owner_id', 'm1']]);
});

test('outside a staff request, or on other tables, nothing changes', () => {
  _forceReady(true);
  const a = fake(); scopeTable(a.b, 'orders').select('*'); assert.deepEqual(a.log, [['select', '*']]);
  const b = fake(); as(manager, () => scopeTable(b.b, 'products').select('*')); assert.deepEqual(b.log, [['select', '*']]);
  const c = fake(); as({ id: 'c', role: 'client' }, () => scopeTable(c.b, 'orders').select('*')); assert.deepEqual(c.log, [['select', '*']]);
});

test('before the migration nobody is restricted — except a Manager, who can only exist after it', () => {
  _forceReady(false);
  const d = fake(); as(director, () => { const s = scopeTable(d.b, 'orders'); s.insert({ x: 1 }); s.delete(); });
  assert.deepEqual(d.log, [['insert', { x: 1 }], ['delete']]);
  const m = fake(); as(manager, () => scopeTable(m.b, 'orders').select('*'));
  assert.deepEqual(m.log, [['select', '*'], ['eq', 'owner_id', 'm1']]);
  _forceReady(true);
});

test('record-level rules', () => {
  assert.equal(canDelete(admin, { created_by: 'x' }), true);
  assert.equal(canDelete(director, { created_by: 'd1' }), true); assert.equal(canDelete(director, { created_by: 'x' }), false);
  assert.equal(canDelete(manager, { created_by: 'm1' }), true); assert.equal(canDelete(manager, { created_by: null }), false);
  assert.equal(canSee(director, { owner_id: null }), true); assert.equal(canSee(manager, { owner_id: null }), false); assert.equal(canSee(manager, { owner_id: 'm1' }), true);
  assert.equal(canAssign(admin), true); assert.equal(canAssign(director), true); assert.equal(canAssign(manager), false);
});

test('URLs of records map to the table a Manager must own', () => {
  const id = '0e3b6b1c-9d0e-4f6a-8a5b-1c2d3e4f5a6b';
  assert.deepEqual(guardFor(`/orders/${id}/packing-list`), { table: 'orders', id });
  assert.deepEqual(guardFor(`/logistics/shipments/${id}/costs`), { table: 'shipments', id });
  assert.deepEqual(guardFor(`/pricing/requests/${id}/quote-lines`), { table: 'requests', id });
  assert.equal(guardFor('/orders'), null); assert.equal(guardFor('/products'), null);
});
