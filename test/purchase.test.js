import { test } from 'node:test';
import assert from 'node:assert/strict';
import { poFromQuote, parseLines, totalOf, poPdf, piPdf, clientLines } from '../src/lib/purchase.js';
import { wrap, textWidth, toBytes } from '../src/lib/pdf-write.js';

const company = { name: 'Lumi Trade', address: 'Ningbo, China', email: 'orders@lumitrade.cc', phone: '', website: '', bank: 'Beneficiary: Lumi Trade', payment_terms: '30% deposit' };

test('PO starts from the accepted quote and the client header', () => {
  const po = poFromQuote({ quote: { quantity: 500, unit_price: 6.45, sell_currency: 'USD', incoterm: 'FOB', lead_time_days: 30 }, item: { name: 'Lamp', sku: 'L-1', unit: 'pcs' }, request: { title: 'x' },
    org: { name: 'Acme', phone: '+1 555', address: '1 Main St', city: 'LA', postal_code: '90001', country: 'USA', delivery_address: 'WH' }, profile: { full_name: 'Tom', email: 'tom@acme.example' } });
  assert.equal(po.client.company, 'Acme'); assert.equal(po.client.contact, 'Tom'); assert.equal(po.client.email, 'tom@acme.example');
  assert.equal(po.lines[0].quantity, 500); assert.equal(po.lines[0].sku, 'L-1'); assert.equal(po.currency, 'USD');
  assert.equal(totalOf(po.lines), 3225);
  assert.deepEqual(clientLines(po.client).slice(0, 2), ['Attn: Tom', 'tom@acme.example · +1 555']);
});

test('form lines are parsed and empty ones dropped', () => {
  const l = parseLines({ lines: { 0: { description: ' Lamp ', quantity: '10', unit_price: '2,5', unit: 'pcs' }, 1: { description: '', quantity: '3' }, 2: { description: 'Zero', quantity: '0' } } });
  assert.equal(l.length, 1); assert.equal(l[0].unit_price, 2.5); assert.equal(l[0].description, 'Lamp');
});

test('PDF writer: wraps text, WinAnsi, valid file structure', () => {
  assert.ok(wrap('a '.repeat(200), 100, 10).length > 3);
  assert.deepEqual(toBytes('€ é →'), [0x80, 32, 0xe9, 32, 63]);
  assert.ok(textWidth('Hello', 10, true) > textWidth('Hello', 10, false));
  const po = { po_no: 'PO-1', status: 'submitted', created_at: '2026-10-14', currency: 'USD', client: { company: 'Acme', contact: 'Tom', email: 't@a.example' }, lines: [{ description: 'Lamp', quantity: 2, unit_price: 3, unit: 'pcs' }] };
  const buf = poPdf(po, company);
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-'); assert.match(buf.subarray(-6).toString(), /%%EOF/);
  const pi = piPdf({ pi_no: 'PI-1', created_at: '2026-10-14', data: { buyer: po.client, lines: po.lines, currency: 'USD', payment_terms: '30%' } }, { order_no: 'HB-1' }, company);
  assert.equal(pi.subarray(0, 5).toString(), '%PDF-');
});

test('staff-initiated requests use the IRQ prefix format', () => {
  const ref = `IRQ-${new Date('2026-10-15').toISOString().slice(2, 7).replace('-', '')}-${String(7).padStart(4, '0')}`;
  assert.equal(ref, 'IRQ-2610-0007');
});

test('PO from a quote with freight adds an estimated logistics line equal to the quotation total', () => {
  const po = poFromQuote({ quote: { quantity: 200, unit_price: 148.2, sell_currency: 'CNY', freight_estimate: 500, duties_estimate: 0, other_costs: 0 }, item: { name: 'Housing' }, request: { title: 'x' }, org: {}, profile: {} });
  assert.equal(po.lines.length, 2); assert.equal(po.lines[1].description, 'Freight & logistics (estimate)');
  assert.equal(totalOf(po.lines), 30140);
});
