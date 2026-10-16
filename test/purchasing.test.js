import test from 'node:test';
import assert from 'node:assert/strict';
import { groupBySupplier, totalOf, spoDocument, spoPdf, packingTemplate, classifyReply, kindOf, keepFiles } from '../src/lib/purchasing.js';
import { spoEmail } from '../src/lib/email-templates.js';
import { matchKeys } from '../src/lib/freight.js';

const row = (n, supplier, price, cur = 'CNY', qty = 100) => ({ order_item_id: 'i' + n, description: 'Item ' + n, quantity: qty, unit_price: price, currency: cur, supplier_id: supplier });

test('products of the same supplier and currency share one PO; others get their own', () => {
  const { groups, skipped } = groupBySupplier([row(1, 's1', 10), row(2, 's1', 5), row(3, 's2', 2), row(4, 's1', 3, 'USD'), row(5, '', 1)]);
  assert.equal(groups.length, 3);
  assert.equal(groups.find(g => g.supplier_id === 's1' && g.currency === 'CNY').lines.length, 2);
  assert.equal(groups.find(g => g.supplier_id === 's1' && g.currency === 'CNY').total, 1500);
  assert.equal(skipped.length, 1);
});

test('lines without quantity are skipped', () => {
  assert.equal(groupBySupplier([row(1, 's1', 10, 'CNY', 0)]).groups.length, 0);
  assert.equal(totalOf([{ quantity: 3, unit_price: 1.1 }]), 3.3);
});

const po = { ref: 'SPO-2610-0412', token: 'abc123def4', currency: 'CNY', status: 'draft', lines: [{ description: 'LED Desk Lamp 10W', sku: 'BW-1', quantity: 500, unit: 'pcs', unit_price: 38.5 }], total: 19250, required_date: '2026-11-20', payment_terms: '30/70', want_packing: true, created_at: new Date().toISOString() };

test('PO document and PDF', () => {
  const d = spoDocument(po, { supplier: { name: 'Brightway', email: 'a@b.cc' }, order: { order_no: 'HB-2610-1187' }, company: { name: 'Lumi Trade' } });
  assert.equal(d.title, 'PURCHASE ORDER');
  assert.ok(d.sections.some(s => /packing list/i.test(s.text || '')));
  assert.equal(Buffer.from(spoPdf(po, { supplier: { name: 'B' }, order: {}, company: { name: 'Lumi Trade' } })).subarray(0, 4).toString(), '%PDF');
});

test('packing list template is an xlsx carrying the PO token', () => {
  const buf = Buffer.from(packingTemplate(po, { order: { order_no: 'HB-1' } }));
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
});

test('email asks for confirmation, PI and packing list', () => {
  const m = spoEmail({ po, supplier: { name: 'Brightway' }, order: { order_no: 'HB-2610-1187' }, senderName: 'Anna' });
  assert.match(m.subject, /SPO-2610-0412/);
  assert.match(m.text, /proforma invoice/i);
  assert.match(m.text, /packing list/i);
  assert.doesNotMatch(spoEmail({ po: { ...po, want_packing: false }, supplier: {}, order: {} }).text, /packing list/i);
});

test('replies are matched by token, reply address or SPO reference', () => {
  assert.deepEqual(matchKeys({ to: ['quotes+abc123def4@in.lumitrade.cc'], subject: 'Re: x' }), { token: 'abc123def4' });
  assert.deepEqual(matchKeys({ to: [], subject: 'Re: Purchase order SPO-2610-0412 [SPO-2610-0412 #abc123def4]' }), { token: 'abc123def4' });
  assert.deepEqual(matchKeys({ to: [], subject: 'RE: SPO-2610-0412' }), { ref: 'SPO-2610-0412' });
  assert.deepEqual(matchKeys({ to: [], subject: 'Re: FQ-2610-0412' }), { ref: 'FQ-2610-0412' });
});

test('reply reading without AI', () => {
  assert.equal(classifyReply('Dear Anna, we confirm the order. Ready on 28 Oct.'), 'confirmed');
  assert.equal(classifyReply('已确认订单，PI 见附件'), 'confirmed');
  assert.equal(classifyReply('Sorry, we cannot supply this model any more.'), 'declined');
  assert.equal(classifyReply('Could you send the logo artwork again?'), 'question');
  assert.equal(classifyReply(''), 'info');
});

test('supplier files are recognised', () => {
  assert.equal(kindOf('Proforma Invoice SH-0912.pdf'), 'proforma_invoice');
  assert.equal(kindOf('PI-123.pdf'), 'proforma_invoice');
  assert.equal(kindOf('estimated packing list.xlsx'), 'packing_list');
  assert.equal(kindOf('photo.jpg'), 'other');
  assert.equal(keepFiles([{ originalname: 'logo.png', mimetype: 'image/png', buffer: Buffer.alloc(900) }, { originalname: 'PI.pdf', mimetype: 'application/pdf', buffer: Buffer.alloc(900) }]).length, 1);
});
