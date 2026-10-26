import test from 'node:test';
import assert from 'node:assert/strict';
import { keptFiles, placeFiles, cleanItems, cleanResponse, compare, currentResponses, rfqSupplierEmail } from '../src/lib/rfq.js';

const items = cleanItems({ item: { 0: { id: 'a', description: ' Lamp ', quantity: '1,000', unit: '' }, 1: { description: '' }, 2: { id: 'b', description: 'Cable', quantity: '-5' } } });

test('cleanItems keeps named products, stable ids, numeric quantities', () => {
  assert.equal(items.length, 2);
  assert.deepEqual([items[0].id, items[0].description, items[0].unit], ['a', 'Lamp', 'pcs']);
  assert.equal(items[0].quantity, 1000);
  assert.equal(items[1].quantity, null);
});

test('cleanResponse reads prices per item and the terms; asks for at least one price', () => {
  const r = cleanResponse({ line: { a: { unit_price: '3,5', currency: 'cny', moq: '500' }, b: { unit_price: '' } }, incoterm: 'fob', valid_until: '2026-12-01' }, items, 'USD');
  assert.equal(r.lines.length, 1);
  assert.deepEqual([r.lines[0].unit_price, r.lines[0].currency, r.lines[0].moq], [3.5, 'CNY', 500]);
  assert.equal(r.terms.incoterm, 'FOB'); assert.deepEqual(r.problems, []);
  assert.equal(cleanResponse({ line: {} }, items).problems.length, 1);
  assert.match(cleanResponse({ line: { a: { unit_price: 'abc' } } }, items).problems[0], /not a number/);
});

test('compare converts to the RFQ currency, marks the lowest and totals per supplier', () => {
  const sup = [{ id: 's1' }, { id: 's2' }];
  const resp = [
    { rfq_supplier_id: 's1', status: 'confirmed', created_at: '2', lines: [{ item_id: 'a', unit_price: 5, currency: 'USD' }] },
    { rfq_supplier_id: 's2', status: 'confirmed', created_at: '1', lines: [{ item_id: 'a', unit_price: 30, currency: 'CNY' }] },
    { rfq_supplier_id: 's2', status: 'parsed', created_at: '3', lines: [{ item_id: 'a', unit_price: 1, currency: 'USD' }] }, // unconfirmed AI draft is ignored
  ];
  const c = compare({ items, suppliers: sup, responses: resp, currency: 'USD', settings: { fx: { CNY_USD: 0.14 } } });
  assert.equal(c.rows[0].cells[1].converted, 4.2);
  assert.deepEqual(c.rows[0].cells.map(x => x.best), [false, true]);
  assert.equal(c.rows[1].cells[0].price, null);
  assert.equal(c.totals[0].quoted, 1); assert.equal(c.totals[0].of, 2);
});

test('the newest confirmed answer counts', () => {
  const cur = currentResponses([{ id: 1, rfq_supplier_id: 'x', status: 'confirmed', created_at: '1' }, { id: 2, rfq_supplier_id: 'x', status: 'confirmed', created_at: '2' }]);
  assert.equal(cur.x.id, 2);
});

test('supplier email lists the products, the deadline and both ways to answer', () => {
  const m = rfqSupplierEmail({ rfq: { ref: 'RFQ-2610-0001', title: 'Lamp', deadline: '2026-10-30', items }, supplier: { name: 'Acme Fab' }, url: 'https://x.test/supplier/rfqs/1', message: 'Black', senderName: 'Marsel' });
  assert.match(m.subject, /RFQ-2610-0001/); assert.match(m.html, /Lamp/); assert.match(m.html, /2026-10-30/); assert.match(m.html, /reply to this email/); assert.match(m.text, /supplier\/rfqs\/1/);
});

test('cleanResponse keeps the price unit and package type the supplier chose', () => {
  const items = [{ id: 'a', description: 'Steel rope', unit: 'm' }, { id: 'b', description: 'Bags', unit: 'pcs' }];
  const r = cleanResponse({ line: { a: { unit_price: '3.2', price_unit: 'kg', package_type: 'drum / reel', carton_qty: '500' }, b: { unit_price: '1', price_unit: 'bogus', package_type: 'nonsense' } } }, items, 'USD');
  assert.equal(r.lines[0].price_unit, 'kg');
  assert.equal(r.lines[0].package_type, 'Drum / reel');
  assert.equal(r.lines[1].price_unit, 'pcs');   // unknown unit falls back to the unit asked for in the RFQ
  assert.equal(r.lines[1].package_type, '');
});

test('answer files: kept + new files land on their product, only earlier files can be kept', () => {
  const items = [{ id: 'a' }, { id: 'b' }];
  const prev = { file_ids: ['g1', 'g2'], lines: [{ item_id: 'a', file_ids: ['a1', 'a2'] }] };
  const kept = keptFiles(prev, ['g1', 'a2', 'stranger']);
  assert.deepEqual(kept, { general: ['g1'], byItem: { a: ['a2'] } });
  const placed = placeFiles([{ item_id: 'a', unit_price: 2 }], items, kept, { general: ['g3'], byItem: { a: ['a3'], b: ['b1'], zzz: ['x'] } });
  assert.deepEqual(placed.file_ids, ['g1', 'g3']);
  assert.deepEqual(placed.lines.find(l => l.item_id === 'a').file_ids, ['a2', 'a3']);
  assert.deepEqual(placed.lines.find(l => l.item_id === 'b').file_ids, ['b1']);   // a product with only files still gets a line
  assert.equal(placed.lines.length, 2);
});
