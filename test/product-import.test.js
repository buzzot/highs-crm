import test from 'node:test';
import assert from 'node:assert/strict';

test('supplier quotation form: all rows, USD, combined N.W./G.W., supplier block, no footer rows', async () => {
  const { parseWorkbook } = await import('../src/lib/product-import.js');
  const rows = [
    [], ['Factory / Company Name', 'Acme Toys Co.', null, null, 'Factory Address', 'Shantou, China'],
    ['Contact Person', 'Vivi', null, null, 'Email', 'v@acme.cn'], ['Phone / WhatsApp', '+86 1', null, null, 'Website'],
    ['Currency', 'USD', 'Incoterm', 'FOB', 'MOQ', 5000],
    ['ITEM NO. / SKU', 'FACTORY PRODUCT PICTURE', 'PRODUCT SIZE (cm)', 'DESCRIPTION', 'UNIT PRICE (USD)', 'MATERIAL', 'PACKING (pcs/ctn)', 'N.W. / G.W. (kg)', 'CARTON SIZE L×W×H (cm)', 'HS CODE'],
    ['A 001', null, '9.5*7.3*2.2', 'Snail rattle', 0.58, 'ABS', 60, '2.9/3.3', '42.5*26.5*21', '9503008900\n(China HS code)'],
    ['B 001', null, '8*7*2', 'Butterfly rattle', 0.6, 'ABS', 60, '2.6/3', '59*26*14', '9503008900'],
    ['General Factory Notes'], ['Prepared by (Factory)'],
  ];
  const r = parseWorkbook({ sheets: [{ name: 'Quotation Form', rows, images: [{ row: 6, col: 1, data: Buffer.from('x'), ext: 'png' }, { row: 7, col: 1, data: Buffer.from('y'), ext: 'png' }] }] });
  assert.equal(r.products.length, 2);
  assert.equal(r.products[0].currency, 'USD');
  assert.equal(r.products[0].carton_weight_kg, 3.3);
  assert.equal(r.products[0].unit_weight_kg, 0.0483);
  assert.equal(r.products[0].moq, 5000);
  assert.ok(r.products[0].image && r.products[1].image);
  assert.equal(r.supplier.name, 'Acme Toys Co.');
  assert.equal(r.supplier.address, 'Shantou, China');
  assert.equal(r.supplier.email, 'v@acme.cn');
});
