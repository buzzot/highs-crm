import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cartonCount, parseDims, normalizeRows, rowsFromSheet, totals, packingText, packingSheet } from '../src/lib/packing.js';
import { writeXlsx } from '../src/lib/xlsx-write.js';
import { readXlsx } from '../src/lib/xlsx-read.js';

test('carton ranges and dimensions', () => {
  assert.equal(cartonCount('1-20'), 20);
  assert.equal(cartonCount('21~25, 30'), 6);
  assert.equal(cartonCount('7'), 1);
  assert.deepEqual(parseDims('52*38*23CM'), [52, 38, 23]);
  assert.deepEqual(parseDims('60 × 40 × 35'), [60, 40, 35]);
});

test('rows are normalised and numbered; totals are per-carton × cartons', () => {
  const rows = normalizeRows([
    { description: 'LED lamp', cartons: 20, quantity: 20, dims: '52x38x23', gross_weight_kg: '14.0', net_weight_kg: 13 },
    { description: 'Charger', carton_no: '21-25', total_quantity: 500, length_cm: 40, width_cm: 30, height_cm: 30, total_gross_weight_kg: 60 },
    {},
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].carton_no, '1-20');
  assert.equal(rows[1].cartons, 5);
  assert.equal(rows[1].quantity, 100);
  assert.equal(rows[1].gross_weight_kg, 12);
  const t = totals(rows);
  assert.equal(t.cartons, 25);
  assert.equal(t.pieces, 900);
  assert.equal(t.gross, 340);
  assert.equal(t.cbm, Math.round((0.52 * 0.38 * 0.23 * 20 + 0.4 * 0.3 * 0.3 * 5) * 1000) / 1000);
  assert.deepEqual(t.missing, []);
});

test('spreadsheet layout is recognised by headers (English and Chinese)', () => {
  const sheet = [
    ['PACKING LIST'], [],
    ['CTN NO.', 'DESCRIPTION', 'QTY/CTN', 'CTNS', 'MEAS (CM)', 'G.W.(KGS)', 'N.W.(KGS)'],
    ['1-10', 'Bunny cloth book', 50, 10, '50*40*30', 8.5, 7.5],
    ['11-12', 'Giraffe fan', 24, 2, '45x35x40', 10, 9],
    ['TOTAL', '', '', 12],
  ];
  const rows = rowsFromSheet(sheet);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].length_cm, rows[0].width_cm, rows[0].height_cm], [50, 40, 30]);
  assert.equal(totals(rows).pieces, 548);
  const cn = rowsFromSheet([['箱号', '品名', '每箱', '箱数', '外箱尺寸', '毛重'], ['1-3', '宠物碗', 36, 3, '40x30x25', 9]]);
  assert.equal(cn.length, 1);
  assert.equal(cn[0].cartons, 3);
  assert.equal(rowsFromSheet([['a', 'b'], [1, 2]]), null);
});

test('text and Excel output round-trip', () => {
  const rows = normalizeRows([{ description: 'LED lamp', cartons: 2, quantity: 20, dims: '52x38x23', gross_weight_kg: 14 }]);
  const t = totals(rows);
  const order = { order_no: 'LT-2610-0001' };
  const txt = packingText({ order, info: { mode: 'Sea LCL', pol: 'Shenzhen', pod: 'Los Angeles' }, rows, t });
  assert.match(txt, /LT-2610-0001/); assert.match(txt, /2 ctns · 40 pcs/); assert.match(txt, /Shenzhen → To: Los Angeles|From: Shenzhen → To: Los Angeles/);
  const buf = writeXlsx(packingSheet({ order, rows, t }), { boldRows: [0, 6] });
  const wb = readXlsx(buf);
  const data = wb.sheets[0].rows;
  assert.equal(data[0][0], 'Lumi Trade — PACKING LIST');
  const head = data.findIndex(x => x && x[0] === 'CTN No.');
  assert.equal(data[head + 1][2], 'LED lamp');
  assert.equal(data[head + 2][0], 'TOTAL');
  assert.equal(data[head + 2][6], 40);
});
