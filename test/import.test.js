import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readXlsx, workbookToText } from '../src/lib/xlsx-read.js';
import { parseWorkbook, num, dims, hsCode, currency, checkRow, matchSupplier, matchProduct, nameSimilarity, coreName, toProductRecord, cleanProduct } from '../src/lib/product-import.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const file = n => fs.readFileSync(path.join(dir, 'files', n));

test('value clean-up', () => {
  assert.equal(num('1,234.5 kg'), 1234.5);
  assert.equal(num('0,65'), 0.65);
  assert.equal(num('$1.85'), 1.85);
  assert.equal(num(''), null);
  assert.deepEqual(dims('52*38*23'), [52, 38, 23]);
  assert.deepEqual(dims('45x35x30 cm'), [45, 35, 30]);
  assert.deepEqual(dims('520 × 380 × 230 mm'), [52, 38, 23]);
  assert.equal(dims('52x38'), null);
  assert.equal(hsCode(' 9405.21.00 '), '9405.21.00');
  assert.equal(currency('¥'), 'CNY'); assert.equal(currency('usd'), 'USD'); assert.equal(currency(''), 'CNY');
});

test('blank template parses to zero products (example row ignored)', () => {
  const r = parseWorkbook(readXlsx(fs.readFileSync(path.join(dir, '..', 'public', 'templates', 'highs-product-import-template.xlsx'))));
  assert.equal(r.template, true);
  assert.equal(r.products.length, 0);
});

test('filled template: supplier block, products, photo on the right row', () => {
  const r = parseWorkbook(readXlsx(file('filled-template.xlsx')));
  assert.equal(r.template, true);
  assert.equal(r.supplier.name, 'Shenzhen Brightway Electronic Co., Ltd.');
  assert.equal(r.supplier.email, 'sales@brightway-led.com');
  assert.equal(r.supplier.wechat, 'liwei_bw');
  assert.equal(r.products.length, 2);
  const [a, b] = r.products;
  assert.equal(a.supplier_sku, 'BW-DL12');
  assert.equal(a.hs_code, '9405.21.00');
  assert.deepEqual([a.carton_length_cm, a.carton_width_cm, a.carton_height_cm], [56, 30, 40]);
  assert.equal(a.unit_price, 45);
  assert.ok(a.image && a.image.data.length > 50, 'photo attached to first product');
  assert.equal(b.image, null);
  assert.equal(b.unit_price, 22.5);           // "22,50" text
  assert.equal(b.currency, 'CNY');            // "cny"
  assert.ok(checkRow(b).some(i => i.field === 'hs_code'));   // "abc" → no HS code
});

test('WPS in-cell picture (=DISPIMG) is attached to its row', () => {
  const r = parseWorkbook(readXlsx(file('wps-cellimage.xlsx')));
  const clip = r.products.find(p => p.supplier_sku === 'BW-CL05');
  assert.ok(clip.image, 'WPS image found');
  assert.equal(clip.image.ext, 'jpeg');
});

test('supplier price list with its own headers (no template)', () => {
  const wb = readXlsx(file('price-list.xlsx'));
  const r = parseWorkbook(wb);
  assert.equal(r.template, false);
  assert.equal(r.products.length, 2);
  const [t, m] = r.products;
  assert.equal(t.supplier_sku, 'SH-STB-210');
  assert.equal(t.unit_price, 1.85);
  assert.equal(t.currency, 'CNY');            // "$" in the value isn't a currency column — AI/admin confirm
  assert.deepEqual([t.unit_length_cm, t.unit_width_cm, t.unit_height_cm], [7, 7, 20]);
  assert.deepEqual([t.carton_length_cm, t.carton_width_cm, t.carton_height_cm], [52, 38, 23]);
  assert.equal(t.carton_qty, 48);
  assert.equal(m.moq, 500);
  assert.ok(m.image, 'picture on row 5 → mug');
  assert.match(workbookToText(wb), /SH-STB-210/);
});

test('company-name similarity ignores suffixes, cities, typos', () => {
  assert.equal(coreName('Shenzhen Brightway Electronics Co., Ltd.'), 'brightway');
  assert.ok(nameSimilarity('Shenzhen Brightway Electronics', 'Brightway Electronic Co.,Ltd') >= 0.97);
  assert.ok(nameSimilarity('Shenzhen Brigthway Electronics', 'Brightway Electronics Co Ltd') > 0.72);   // typo
  assert.ok(nameSimilarity('Bright Way Lighting', 'Brightway Lighting Factory') > 0.72);
  assert.ok(nameSimilarity('深圳市明途电子有限公司', '明途电子') >= 0.97);
  assert.ok(nameSimilarity('Yiwu Sunhome Houseware', 'Shenzhen Brightway Electronics') < 0.5);
});

test('supplier matching: exact, contact match, suspect, new', () => {
  const existing = [
    { id: 1, name: 'Shenzhen Brightway Electronics', email: 'liwei@brightway-led.com', wechat: 'liwei_bw', phone: '+86 138 0000 0000' },
    { id: 2, name: 'Yiwu Sunhome Houseware', email: 'sunhome88@qq.com' },
  ];
  assert.equal(matchSupplier({ name: 'Brightway Electronic Co., Ltd.' }, existing).status, 'match');
  const byDomain = matchSupplier({ name: 'BW Lighting', email: 'sales@brightway-led.com' }, existing);
  assert.equal(byDomain.status, 'match'); assert.ok(byDomain.candidates[0].reasons.some(r => /domain/.test(r)));
  assert.equal(matchSupplier({ name: 'Someone', email: 'x@qq.com' }, existing).status, 'new');   // public mail domain isn't a match
  const typo = matchSupplier({ name: 'Yiwu Sunhom Housewares Co.' }, existing);
  assert.equal(typo.status, 'suspect'); assert.equal(typo.candidates[0].id, 2);
  assert.equal(matchSupplier({ name: 'Ningbo Ocean Textiles' }, existing).status, 'new');
});

test('product duplicate detection by supplier SKU, then name', () => {
  const existing = [{ id: 'a', name: 'Desk lamp 12W touch dimmer', supplier_sku: 'bw-dl12' }, { id: 'b', name: 'Ceramic mug 330ml' }];
  assert.equal(matchProduct({ supplier_sku: 'BW-DL12', name: 'x' }, existing).status, 'sku');
  assert.equal(matchProduct({ name: 'Ceramic mug 330 ml' }, existing).status, 'name');
  assert.equal(matchProduct({ name: 'Glass jar' }, existing).status, 'none');
});

test('row checks catch unit mistakes', () => {
  const p = cleanProduct({ name: 'x', unit_price: '2', hs_code: '9617.00', carton_qty: 48, unit_weight_kg: 300, carton_weight_kg: 16,
    carton_length_cm: 520, carton_width_cm: 380, carton_height_cm: 230 });
  const msgs = checkRow(p).map(i => i.message).join(' ');
  assert.match(msgs, /grams instead of kg/);
  assert.match(msgs, /mm instead of cm/);
  assert.match(msgs, /lighter than/);
  const rec = toProductRecord(cleanProduct({ name: 'Mug', carton_length_cm: 45, carton_width_cm: 35, carton_height_cm: 30, unit_price: 1.2, currency: 'USD' }), 's1');
  assert.equal(rec.carton_cbm, 0.0473); assert.equal(rec.unit_cost, 1.2); assert.equal(rec.cost_currency, 'USD');
});
