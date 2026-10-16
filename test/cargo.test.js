import test from 'node:test';
import assert from 'node:assert/strict';
import { cargoLine, cargoTotals } from '../src/lib/cargo.js';

const lamp = { carton_qty: 20, carton_weight_kg: 12, carton_length_cm: 50, carton_width_cm: 40, carton_height_cm: 30, unit_weight_kg: 0.5 };

test('cargo line: cartons round up, weight and volume follow cartons', () => {
  const l = cargoLine(lamp, 500);
  assert.equal(l.cartons, 25);
  assert.equal(l.kg, 300);
  assert.equal(l.cbm, 1.5);
  assert.deepEqual(l.missing, []);
  assert.equal(cargoLine(lamp, 501).cartons, 26);
});

test('cargo line: missing packing data is reported, net weight is the fallback', () => {
  const l = cargoLine({ unit_weight_kg: 0.2 }, 100);
  assert.equal(l.kg, 20);
  assert.equal(l.cbm, null);
  assert.ok(l.missing.includes('pcs per carton') && l.missing.includes('carton size'));
  assert.match(l.kgNote, /net/);
});

test('cargo totals: air chargeable weight is the greater of weight and volumetric weight', () => {
  const t = cargoTotals([cargoLine(lamp, 500), cargoLine({ carton_qty: 10, carton_weight_kg: 5, carton_cbm: 0.1 }, 100)], { container_cbm: 68 });
  assert.equal(t.cartons, 35);
  assert.equal(t.kg, 350);
  assert.equal(t.cbm, 2.5);
  assert.equal(t.volumetricKg, 417.5);
  assert.equal(t.airChargeableKg, 417.5);
  assert.equal(t.airBasis, 'volume');
  assert.equal(t.containerPct, 3.7);
  assert.equal(t.incomplete, false);
});

import { allocateFreight } from '../src/lib/cargo.js';
test('freight is spread by volume for sea and sums to the total', () => {
  const lines = [{ cbm: 1, kg: 100, value: 10 }, { cbm: 3, kg: 50, value: 10 }];
  const a = allocateFreight(lines, 100.01, 'sea');
  assert.equal(a.basis, 'volume');
  assert.deepEqual(a.freight, [25, 75.01]);
});
test('air freight uses the greater of gross and volumetric weight per line', () => {
  const lines = [{ cbm: 0.1, kg: 100, value: 1 }, { cbm: 1, kg: 10, value: 1 }]; // 100 vs 16.7 → 100; 10 vs 167 → 167
  const a = allocateFreight(lines, 267, 'air');
  assert.equal(a.basis, 'chargeable weight');
  assert.deepEqual(a.freight, [100, 167]);
});
test('missing packing data falls back to goods value; locked lines keep their amount', () => {
  const lines = [{ cbm: null, kg: null, value: 300 }, { cbm: 1, kg: 5, value: 100 }, { cbm: 1, kg: 5, value: 100 }];
  const a = allocateFreight(lines, 100, 'sea');
  assert.ok(a.estimated);
  assert.equal(a.freight.reduce((t, x) => t + x, 0), 100);
  const b = allocateFreight(lines.slice(1), 100, 'sea', { 0: 40 });
  assert.deepEqual(b.freight, [40, 60]);
  assert.equal(b.basis, 'volume');
});
