import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseQuotation, gaps } from '../src/lib/supplier-bulk.js';

const buf = readFileSync(new URL('./files/supplier-bulk.xlsx', import.meta.url));

test('bulk: header terms apply to every product, example row is skipped', () => {
  const r = parseQuotation(buf);
  assert.equal(r.skipped, 1);
  assert.equal(r.terms.currency, 'USD'); assert.equal(r.terms.fob_port, 'Ningbo');
  const [a, b] = r.rows;
  assert.equal(a.row, 17); assert.equal(a.data.name, 'Swaddle blanket'); assert.equal(a.data.sku, 'T17');
  assert.equal(a.data.unit_price, 3.2); assert.equal(a.data.carton_qty, 24); assert.equal(a.data.carton_l, 50);
  assert.equal(a.data.incoterm, 'FOB'); assert.equal(a.data.payment_terms, '30% deposit'); assert.equal(b.data.fob_port, 'Ningbo');
});

test('bulk: photos follow their row; rows without a name are flagged', () => {
  const r = parseQuotation(buf);
  assert.equal(r.rows[0].images.length, 1); assert.equal(r.rows[1].images.length, 0);
  const bad = r.rows[2];
  assert.deepEqual(bad.problems, ['Product name is missing']);
  assert.ok(gaps(r.rows[0].data, 1).includes('Carton gross weight') === false);
  assert.ok(gaps(r.rows[1].data, 0).includes('Photos or a photo link'));
});

test('bulk: a workbook without the product table is rejected with a helpful message', () => {
  assert.throws(() => parseQuotation(readFileSync(new URL('./files/price-list.xlsx', import.meta.url))), /Lumi Trade template|product table|Not an/);
});
