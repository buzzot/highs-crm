import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteFormSheet, parseQuoteForm, rfqWorkbook, toDate, summaryOf, FORM_ID } from '../src/lib/quote-form.js';
import { writeWorkbook } from '../src/lib/xlsx-write.js';
import { readXlsx } from '../src/lib/xlsx-read.js';
import { totals } from '../src/lib/packing.js';

const rows = [{ carton_no: '1-20', cartons: 20, description: 'LED desk lamp', quantity: 20, length_cm: 52, width_cm: 38, height_cm: 23, gross_weight_kg: 14, net_weight_kg: 13 }];
const t = totals(rows);
const order = { order_no: 'LT-2610-0711' };
const info = { mode: 'Sea LCL', pol: 'Shenzhen', pod: 'Los Angeles' };

test('rfq workbook opens and contains the form and the packing list', () => {
  const wb = readXlsx(rfqWorkbook({ order, info, rows, t, ref: 'FQ-2610-0042', token: 'ab12cd34ef' }));
  assert.deepEqual(wb.sheets.map(s => s.name), ['Quotation 报价单', 'Packing list 装箱单']);
  const flat = wb.sheets[0].rows.flat().map(String);
  assert.ok(flat.some(c => c.includes(FORM_ID) && c.includes('#ab12cd34ef')));
  assert.ok(wb.sheets[1].rows.some(r => r && r[0] === 'TOTAL'));
  // an empty form is recognised but is not a quote
  const empty = parseQuoteForm(wb);
  assert.equal(empty.token, 'ab12cd34ef');
  assert.equal(empty.is_quote, false);
});

test('a filled form is read back exactly', () => {
  const sh = quoteFormSheet({ order, info, t, ref: 'FQ-2610-0042', token: 'ab12cd34ef' });
  const set = (label, v, col = 1) => { const r = sh.rows.find(r => r?.[0]?.v?.startsWith(label + ' ')); assert.ok(r, label); r[col] = v; };
  set('Company name', 'Oceanlink Logistics Ltd');
  set('Quoted by', 'Amy Zhou');
  set('Email', 'amy@oceanlink.example');
  set('Phone / WeChat', '+86 138 0000 0000');
  set('Date quoted', 46309);            // Excel serial for 2026-10-14
  set('Valid until', '2026/10/31');
  set('Currency', 'USD');
  set('Service / mode', 'Sea LCL');
  set('Service scope', 'Door to door DDP');
  set('Transit time (days)', 32);
  set('Shipping date (ETD)', '2026-11-02');
  set('Cargo handover', 'Pickup from supplier 上门提货');
  set('Main freight', 85, 2);
  set('Documentation', 120, 2);
  set('Extra service', 150, 2);
  set('Extra service', 1, 3);
  set('Remarks', 'Storage after 7 days');
  const q = parseQuoteForm(readXlsx(writeWorkbook([sh])));
  assert.equal(q.company, 'Oceanlink Logistics Ltd');
  assert.equal(q.contact_person, 'Amy Zhou');
  assert.equal(q.quote_date, '2026-10-14');
  assert.equal(q.valid_until, '2026-10-31');
  assert.equal(q.handover, 'pickup');
  assert.equal(q.transit_days, 32);
  assert.equal(q.unit_price, 85);
  assert.equal(q.unit_basis, 'per cbm');
  const main = q.breakdown.find(c => c.item === 'Main freight');
  assert.equal(main.qty, t.wm);
  assert.equal(q.amount, Math.round((85 * t.wm + 120 + 150) * 100) / 100);
  assert.equal(q.is_quote, true);
  assert.match(summaryOf(q), /^USD .* · 32 days · ETD 2026-11-02 · valid to 2026-10-31 · pickup from supplier$/);
});

test('dates', () => {
  assert.equal(toDate('31.10.2026'), '2026-10-31');
  assert.equal(toDate('2026年10月31日'), '2026-10-31');
  assert.equal(toDate(''), null);
});

test('a workbook that is not our form', () => {
  assert.equal(parseQuoteForm({ sheets: [{ name: 'x', rows: [['Price', 100]] }] }), null);
});
