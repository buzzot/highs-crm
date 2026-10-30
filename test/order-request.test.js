import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOrderInfo, validateOrder, orderInfoRows, orderInfoText, INCOTERMS } from '../src/lib/order-request.js';

test('parseOrderInfo keeps only known incoterms and trims fields', () => {
  const i = parseOrderInfo({ incoterm: 'CIF', contact: '  Tom  ', email: 'tom@x.com', po_number: ' PO-1 ', delivery_address: '', notes: 'n' });
  assert.equal(i.incoterm, 'CIF'); assert.equal(i.contact, 'Tom'); assert.equal(i.po_number, 'PO-1'); assert.equal(i.delivery_address, null);
  assert.equal(parseOrderInfo({ incoterm: 'XYZ' }).incoterm, null);
  assert.deepEqual(INCOTERMS, ['EXW', 'FOB', 'CIF', 'DAP']);
});

test('validateOrder asks for country, contact and a valid email', () => {
  const ok = parseOrderInfo({ contact: 'Tom', email: 'tom@x.com' });
  assert.equal(validateOrder(ok, { destination_country: 'Russia' }), null);
  assert.match(validateOrder(ok, { destination_country: ' ' }), /country/);
  assert.match(validateOrder(parseOrderInfo({ email: 'tom@x.com' }), { destination_country: 'Russia' }), /contact/i);
  assert.match(validateOrder(parseOrderInfo({ contact: 'Tom', email: 'nope' }), { destination_country: 'Russia' }), /email/);
});

test('orderInfoRows lists only what was filled; the text fallback keeps every detail', () => {
  const info = parseOrderInfo({ incoterm: 'FOB', contact: 'Tom', email: 'tom@x.com', po_number: 'PO-9' });
  const rows = orderInfoRows(info, 'sea');
  assert.deepEqual(rows.map(r => r[0]), ['Incoterm', 'Transport', 'Client PO number', 'Contact']);
  const text = orderInfoText(info, 'air');
  assert.match(text, /Incoterm: FOB/); assert.match(text, /Transport: Air/); assert.match(text, /PO-9/);
  assert.deepEqual(orderInfoRows(null, null), []);
});
