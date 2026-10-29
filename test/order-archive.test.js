import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { createZip, crc32 } from '../src/lib/zip.js';
import { planArchive, safeName, summaryText } from '../src/lib/order-archive.js';

function readZip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = buf.readUInt16LE(end + 10); let p = buf.readUInt32LE(end + 16); const out = {};
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nl).toString('utf8');
    const lnl = buf.readUInt16LE(off + 26), start = off + 30 + lnl;
    const raw = buf.slice(start, start + csize), data = method === 8 ? inflateRawSync(raw) : raw;
    assert.equal(crc32(data), crc);
    out[name] = data; p += 46 + nl;
  }
  return out;
}

test('zip: round trip, UTF-8 names, deflate and store', () => {
  const big = Buffer.from('abc'.repeat(500));
  const z = readZip(createZip([{ name: 'Client/Платёж 订单.txt', data: 'привет' }, { name: 'Logistics/big.bin', data: big }, { name: 'tiny', data: 'x' }]));
  assert.equal(z['Client/Платёж 订单.txt'].toString(), 'привет');
  assert.deepEqual(z['Logistics/big.bin'], big);
  assert.equal(z.tiny.toString(), 'x');
});

test('safeName strips path characters', () => {
  assert.equal(safeName('a/b:c*d?.pdf'), 'a-b-c-d-.pdf');
});

const order = { id: 'o1', order_no: 'LT-2610-0001', client_name: 'HTL', supplier_name: 'Vision Lux' };
const doc = (id, entity_type, entity_id, kind, title, extra = {}) => ({ id, entity_type, entity_id, kind, title, mime_type: 'application/pdf', storage_path: `p/${id}.pdf`, created_at: '2026-10-01', ...extra });
const data = () => ({
  order, packRows: 3,
  payments: [{ id: 'p1', status: 'confirmed', label: 'Balance', reference: 'Sber 100%', paid_on: '2026-10-28', proof_doc_ids: ['d1'] }, { id: 'p2', status: 'confirmed', label: 'Deposit', paid_on: '2026-10-10', proof_doc_ids: [] }, { id: 'p3', status: 'rejected', proof_doc_ids: [] }],
  supPays: [{ label: 'Balance', paid_on: '2026-10-20', suppliers: { name: 'Vision Lux' }, invoice_doc_ids: ['d2'], proof_doc_ids: ['d3'] }],
  shipments: [{ id: 's1', forwarders: { name: 'Oceanlink' }, export_official: true }],
  costs: [{ id: 'c1', shipment_id: 's1', type: 'freight', invoice_ref: 'INV-77', paid: true, paid_at: '2026-10-22' }],
  pis: [{ id: 'pi1', pi_no: 'PI-2610-0001' }], pos: [{ id: 'po1', po_no: 'PO-2610-1234' }], spos: [{ id: 'sp1', ref: 'SPO-2610-0001', status: 'confirmed' }],
  responses: [{ extracted: { files: [{ id: 'd4' }] } }], spis: [{ file_doc_ids: ['d11'] }],
  docs: [doc('d1', 'order', 'o1', 'payment_proof', 'IMG_2231.jpg', { mime_type: 'image/jpeg' }), doc('d2', 'order', 'o1', 'other', 'invoice 5530.pdf'), doc('d3', 'order', 'o1', 'payment_proof', 'scan.png'),
    doc('d4', 'order', 'o1', 'other', 'supplier PI.xlsx'), doc('d5', 'shipment', 's1', 'bill_of_lading', 'bl.pdf'), doc('d6', 'shipment', 's1', 'cargo_photo', 'IMG_1.jpg'), doc('d7', 'shipment', 's1', 'cargo_photo', 'IMG_2.jpg'),
    doc('d8', 'freight_cost', 'c1', 'other', 'forwarder.pdf'), doc('d9', 'freight_cost', 'c1', 'payment_proof', 'slip.jpg', { mime_type: 'image/jpeg' }), doc('d10', 'order', 'o1', 'certificate', 'cert.pdf'), doc('d11', 'supplier', 's9', 'other', 'BW-PI-1012.pdf')],
});
const gen = { pi: () => Buffer.from('pi'), po: () => Buffer.from('po'), spo: () => Buffer.from('spo'), pl: () => Buffer.from('pl'), ci: () => Buffer.from('ci') };

test('archive: folders, readable names, generated fallbacks', () => {
  const { entries, missing } = planArchive(data(), gen);
  const paths = entries.map(e => e.path);
  assert.ok(paths.includes('Client/Payment for LT-2610-0001 Balance Sber 100% 2026-10-28.jpg'), paths.join('\n'));
  assert.ok(paths.includes('Client/Proforma invoice PI-2610-0001.pdf'));        // generated, none stored
  assert.ok(paths.includes('Client/Client PO PO-2610-1234.pdf'));
  assert.ok(paths.includes('Client/Packing list LT-2610-0001.pdf'));
  assert.ok(paths.includes('Supplier/Purchase order SPO-2610-0001.pdf'));
  assert.ok(paths.includes('Supplier/invoice 5530 LT-2610-0001.pdf'));          // original name + order number
  assert.ok(paths.includes('Supplier/supplier PI LT-2610-0001.xlsx'));
  assert.ok(paths.includes('Supplier/Payment for LT-2610-0001 Vision Lux Balance 2026-10-20.png'));
  assert.ok(paths.includes('Logistics/Bill of lading LT-2610-0001.pdf'));
  assert.ok(paths.includes('Logistics/Cargo photo 01 LT-2610-0001.jpg') && paths.includes('Logistics/Cargo photo 02 LT-2610-0001.jpg'));
  assert.ok(paths.includes('Logistics/Invoice Oceanlink INV-77 LT-2610-0001.pdf'));
  assert.ok(paths.includes('Logistics/Payment for LT-2610-0001 Oceanlink freight 2026-10-22.jpg'));
  assert.ok(paths.includes('Logistics/Commercial invoice LT-2610-0001.pdf'));   // generated from the PI
  assert.ok(paths.includes('Supplier/BW-PI-1012 LT-2610-0001.pdf'));          // the supplier PI file
  assert.ok(paths.includes('Other/cert LT-2610-0001.pdf'));
  assert.equal(new Set(paths.map(p => p.toLowerCase())).size, paths.length);   // no clashes
  assert.ok(missing.some(m => /no proof for payment Deposit/.test(m)));
  assert.ok(missing.some(m => /no export declaration/.test(m)));
  assert.ok(!missing.some(m => /supplier invoice/.test(m)));
  assert.match(summaryText(order, entries, missing), /Missing/);
});

test('archive: duplicate names get (2), several shipments get subfolders', () => {
  const d = data(); d.docs.find(x => x.id === 'd3').title = 'scan.jpg'; d.payments = [{ status: 'confirmed', label: 'Balance', paid_on: '2026-10-28', proof_doc_ids: ['d1', 'd3'] }];
  d.shipments.push({ id: 's2', forwarders: { name: 'SkyFast' } });
  const { entries } = planArchive(d, gen);
  const paths = entries.map(e => e.path);
  assert.ok(paths.some(p => /^Client\/Payment for LT-2610-0001 Balance 2026-10-28 \(2\)\./.test(p)));
  assert.ok(paths.some(p => p.startsWith('Logistics/Shipment 1 - Oceanlink/')) );
});
