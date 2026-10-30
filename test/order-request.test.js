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

import { buildPortalOrder, validateOrderItems, awaitingPrices } from '../src/lib/order-request.js';

test('a portal order becomes a real order: status new, prices 0, the client target kept apart', () => {
  const info = parseOrderInfo({ incoterm: 'CIF', contact: 'Tom', email: 'tom@x.com', notes: 'Call me' });
  const { order, items } = buildPortalOrder({
    orgId: 'o1', userId: 'u1', info, currencyOk: ['USD', 'EUR'],
    form: { target_currency: 'EUR', destination_country: ' Russia ', destination_city: 'Kazan', needed_by: '2026-12-01', delivery_mode: 'air' },
    items: [{ name: 'Rope', description: 'galvanised', sku: 'WR-12', quantity: 2000.4, unit: 'm', target_unit_price: 4.2 }, { name: 'Hook', quantity: 5, unit: 'pcs', target_unit_price: null }],
  });
  assert.equal(order.status, 'new'); assert.equal(order.source, 'portal'); assert.equal(order.subtotal, 0); assert.equal(order.currency, 'EUR');
  assert.equal(order.org_id, 'o1'); assert.equal(order.submitted_by, 'u1'); assert.equal(order.client_notes, 'Call me');
  assert.equal(order.order_info.destination_country, 'Russia'); assert.equal(order.order_info.needed_by, '2026-12-01'); assert.equal(order.order_info.delivery_mode, 'air');
  assert.equal(items.length, 2);
  assert.ok(items.every(i => i.unit_price === 0), 'the client target price is never stored as a price');
  assert.equal(items[0].quantity, 2000); assert.equal(items[0].target_unit_price, 4.2); assert.equal(items[0].description, 'Rope — galvanised'); assert.equal(items[1].target_unit_price, null);
});

test('portal order: bad currency / date / transport fall back safely', () => {
  const { order } = buildPortalOrder({ orgId: 'o', userId: 'u', info: {}, currencyOk: ['USD'], form: { target_currency: 'XXX', needed_by: 'tomorrow', delivery_mode: 'teleport' }, items: [] });
  assert.equal(order.currency, 'USD'); assert.equal(order.order_info.needed_by, null); assert.equal(order.order_info.delivery_mode, null);
});

test('an order needs a quantity on every line; prices are "awaited" while the goods total is 0', () => {
  assert.match(validateOrderItems([{ quantity: 5 }, { quantity: null }]), /Product 2/);
  assert.equal(validateOrderItems([{ quantity: 5 }]), null);
  assert.equal(awaitingPrices({ subtotal: 0 }), true); assert.equal(awaitingPrices({ subtotal: '0.00' }), true); assert.equal(awaitingPrices({ subtotal: 120 }), false);
});

test('orderInfoRows lists destination and date when the order carries them', () => {
  const rows = orderInfoRows({ destination_country: 'Russia', destination_city: 'Kazan', needed_by: '2026-12-01', incoterm: 'CIF', delivery_mode: 'sea' });
  assert.deepEqual(rows.slice(0, 4).map(r => r[0]), ['Destination', 'Needed by', 'Incoterm', 'Transport']);
  assert.equal(rows[0][1], 'Kazan, Russia'); assert.equal(rows[3][1], 'Sea');
});
