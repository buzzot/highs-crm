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

test('quote email shows the note and, for one product, quantity x price = total', async () => {
  const { quoteSentEmail } = await import('../src/lib/email-templates.js');
  const m = quoteSentEmail({ request: { ref: 'REQ-1', title: 'Housing' }, url: 'https://x/y', count: 1, currency: 'CNY', attached: true, notes: 'Pins included\nPay 30% upfront',
    line: { quantity: 200, unit_price: 148.2, goods: 29640, logistics: 500, total: 30140 } });
  assert.match(m.html, /200 × CNY 148\.20 = CNY 30,140\.00/); assert.match(m.html, /Pins included<br>Pay 30% upfront/); assert.match(m.html, /quotation is attached/);
  assert.match(m.text, /Note from us:\nPins included/);
  assert.doesNotMatch(m.html, /&amp;amp;/);
});

import { ciDocument, ciNo, ciPdf, packingListPdf } from '../src/lib/purchase.js';
import { totals as packTotals } from '../src/lib/packing.js';

const _pi = { pi_no: 'PI-2610-1259', created_at: '2026-10-20T10:00:00Z', data: { currency: 'CNY', incoterm: 'DDP Moscow', payment_terms: '100% before shipment', bank: 'Beneficiary: X', schedule: [{ label: 'Balance', percent: 100 }], buyer: { company: 'HTL', contact: 'Nicholas' }, lines: [{ description: 'LED light samples', quantity: 4, unit: 'pcs', unit_price: 0 }, { description: 'Freight & logistics', quantity: 1, unit_price: 6750 }] } };

test('commercial invoice: built from the PI, totals only, no payment schedule', () => {
  assert.equal(ciNo(_pi), 'CI-2610-1259');
  const d = ciDocument(_pi, { order_no: 'HB-2610-2864' }, { name: 'Lumi Trade' }, { shipment: { mode: 'sea_lcl' }, info: { pol: 'Ningbo' } });
  assert.equal(d.title, 'COMMERCIAL INVOICE');
  assert.equal(d.no, 'CI-2610-1259');
  assert.ok(!d.sections.some(s => /schedule/i.test(s.heading)));
  assert.ok(d.meta.some(([k, v]) => k === 'Proforma invoice' && v === 'PI-2610-1259'));
  const pdf = ciPdf(_pi, { order_no: 'HB-2610-2864' }, { name: 'Lumi Trade' }, {});
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.toString('latin1').includes('COMMERCIAL INVOICE'));
});

test('packing list PDF: landscape A4 with the embedded font', () => {
  const rows = [{ carton_no: '1', cartons: 1, description: 'Drey Spot T 2700 K', quantity: 1, length_cm: 20.5, width_cm: 20.5, height_cm: 25, cbm: 0.011, gross_weight_kg: 2.81, net_weight_kg: 2 }];
  const pdf = packingListPdf({ company: { name: 'Lumi Trade' }, order: { order_no: 'HB-2610-2864' }, info: { mode: 'Air', marks: 'Z10' }, rows, t: packTotals(rows) });
  const s = pdf.toString('latin1');
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.match(s, /MediaBox \[0 0 841\.89 595\.28\]/);
  assert.ok(s.includes('PACKING LIST') && s.includes('FontFile2'));
});
