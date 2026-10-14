import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseItems, validateItems, requestTitle, splitFiles } from '../src/lib/request-items.js';

test('parses product blocks, keeps block keys and skips empty blocks', () => {
  const items = parseItems({ items: { 0: { name: ' Mug ', quantity: '500', unit: 'pcs', target_unit_price: '1,25' }, 3: { name: '', description: '' }, 5: { name: 'Lid', unit: 'bogus' } } });
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { key: '0', name: 'Mug', sku: null, description: null, quantity: 500, unit: 'pcs', target_unit_price: 1.25 });
  assert.equal(items[1].key, '5');
  assert.equal(items[1].unit, 'pcs');
  assert.equal(items[1].quantity, null);
});

test('accepts the array shape too', () => {
  assert.equal(parseItems({ items: [{ name: 'A' }, { name: 'B' }] }).length, 2);
  assert.deepEqual(parseItems({}), []);
});

test('validation needs at least one named product', () => {
  assert.match(validateItems([]), /at least one/);
  assert.match(validateItems([{ name: 'A' }, { name: '', description: 'x' }]), /Product 2/);
  assert.equal(validateItems([{ name: 'A' }]), null);
});

test('title: own name, else first product (+ N more)', () => {
  assert.equal(requestTitle('Spring range', [{ name: 'A' }]), 'Spring range');
  assert.equal(requestTitle('', [{ name: 'Mug' }]), 'Mug');
  assert.equal(requestTitle(' ', [{ name: 'Mug' }, { name: 'Lid' }, { name: 'Box' }]), 'Mug + 2 more');
});

test('files are grouped per product block', () => {
  const f = (fieldname, n) => ({ fieldname, originalname: n });
  const { general, byKey } = splitFiles([f('files', 'a.pdf'), f('item_files_0', 'b.jpg'), f('item_files_0', 'c.jpg'), f('item_files_7', 'd.jpg'), f('evil', 'x')]);
  assert.deepEqual(general.map(x => x.originalname), ['a.pdf']);
  assert.deepEqual(Object.fromEntries(Object.entries(byKey).map(([k, v]) => [k, v.length])), { 0: 2, 7: 1 });
});

test('keeps an optional SKU, and a block with only a SKU is not empty', () => {
  const items = parseItems({ items: [{ name: 'Mug', sku: ' MG-500 ' }, { sku: 'X1' }] });
  assert.equal(items[0].sku, 'MG-500');
  assert.equal(items.length, 2);
});
