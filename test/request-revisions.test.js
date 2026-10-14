import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshot, buildRevision, diff, showValue, EDITABLE } from '../src/lib/request-revisions.js';
import { changeSubmittedEmail, changeDecidedEmail } from '../src/lib/email-templates.js';

const request = { title: 'Lamps', description: null, destination_country: 'USA', destination_city: 'LA', needed_by: '2026-12-01', delivery_mode: 'sea', target_currency: 'USD' };
const items = [
  { id: 'a', position: 0, name: 'Lamp', description: 'black', quantity: 100, unit: 'pcs', target_unit_price: '6.9000' },
  { id: 'b', position: 1, name: 'Cable', description: null, quantity: 500, unit: 'pcs', target_unit_price: null },
];
const header = { title: 'Lamps', description: null, destination_country: 'USA', destination_city: 'LA', needed_by: '2026-12-01', delivery_mode: 'sea', target_currency: 'USD' };

test('unchanged form is an empty diff (numbers compare by value)', () => {
  const rev = buildRevision(header, [
    { key: '0', id: 'a', name: 'Lamp', description: 'black', quantity: 100, unit: 'pcs', target_unit_price: 6.9 },
    { key: '1', id: 'b', name: 'Cable', description: null, quantity: 500, unit: 'pcs', target_unit_price: null },
  ], ['a', 'b']);
  const d = diff(snapshot(request, items), rev);
  assert.equal(d.empty, true);
});

test('detects changed, added and removed products and header changes', () => {
  const rev = buildRevision({ ...header, delivery_mode: 'air' }, [
    { key: '0', id: 'a', name: 'Lamp', description: 'black', quantity: 300, unit: 'pcs', target_unit_price: 6.9 },
    { key: '2', name: 'Shade', quantity: 10, unit: 'pcs' },
    { key: '3', id: 'zzz-not-ours', name: 'Hack', unit: 'pcs' },
  ], ['a', 'b']);
  assert.ok(rev.items[1].tmp && !rev.items[1].id);
  assert.ok(!rev.items[2].id, 'unknown ids are treated as new products');
  const d = diff(snapshot(request, items), rev);
  assert.deepEqual(d.header.map(h => h.field), ['delivery_mode']);
  assert.equal(d.affectsAll, true);
  assert.deepEqual(d.changed.map(c => [c.id, c.fields.map(f => f.field)]), [['a', ['quantity']]]);
  assert.deepEqual(d.added.map(a => a.name), ['Shade', 'Hack']);
  assert.deepEqual(d.removed.map(r => r.id), ['b']);
  assert.deepEqual(d.staleItemIds.sort(), ['a', 'b']);
});

test('quantity-only change does not outdate every quote', () => {
  const rev = buildRevision(header, [
    { key: '0', id: 'a', name: 'Lamp', description: 'black', quantity: 120, unit: 'pcs', target_unit_price: 6.9 },
    { key: '1', id: 'b', name: 'Cable', description: null, quantity: 500, unit: 'pcs', target_unit_price: null },
  ], ['a', 'b']);
  const d = diff(snapshot(request, items), rev);
  assert.equal(d.affectsAll, false);
  assert.deepEqual(d.staleItemIds, ['a']);
});

test('file-only change counts as a change', () => {
  const rev = buildRevision(header, items.map((i, k) => ({ ...i, key: String(k) })), ['a', 'b']);
  rev.new_docs.push({ doc: 'x', item: 'b' });
  const d = diff(snapshot(request, items), rev);
  assert.equal(d.empty, false);
  assert.deepEqual(d.staleItemIds, ['b']);
});

test('values are shown readably', () => {
  assert.equal(showValue('delivery_mode', 'land'), 'Land (rail / truck)');
  assert.equal(showValue('target_unit_price', 6.9, 'USD'), '6.90 USD');
  assert.equal(showValue('quantity', 12000), '12,000');
  assert.equal(showValue('needed_by', null), '—');
  assert.deepEqual(EDITABLE, ['new', 'reviewing', 'quoted']);
});

test('change emails are branded and escape user text', () => {
  const r = { ref: 'REQ-1', title: 'Lamps <b>' };
  const a = changeSubmittedEmail({ request: r, orgName: 'Acme', who: 'Tom', url: 'https://lumitrade.cc/admin/sourcing/1' });
  assert.match(a.subject, /approval needed/);
  assert.match(a.html, /Lamps &lt;b&gt;/);
  const b = changeDecidedEmail({ request: r, approved: false, note: 'MOQ is 500', url: 'https://lumitrade.cc/portal/requests/1' });
  assert.match(b.html, /MOQ is 500/);
  for (const m of [a, b]) assert.doesNotMatch(m.html + m.subject, /supabase|Highs/i);
});
