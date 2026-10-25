import test from 'node:test';
import assert from 'node:assert/strict';
import { toReview, unchecked, cleanReview, reviewTotals, sendWarning, CHECKABLE } from '../src/lib/rfq-files.js';
import { rfqSupplierEmail } from '../src/lib/rfq.js';

test('a clean English file is ok', () => {
  assert.equal(toReview({ language: 'English', non_english: false, client_info: [] }).status, 'ok');
});
test('client details and non-English text raise a warning', () => {
  const r = toReview({ language: 'Russian', non_english: true, client_info: [{ kind: 'company_name', text: 'ООО ПРО ЭКСПЕРТ' }, { kind: 'phone', text: '+7 843 000' }] });
  assert.equal(r.status, 'warn');
  assert.deepEqual(r.issues, ['Not in English: Russian', 'Company name: ООО ПРО ЭКСПЕРТ', 'Phone: +7 843 000']);
});
test('review data from the browser is cleaned', () => {
  const r = cleanReview({ status: 'hack', issues: ['x'.repeat(500), '', 5], language: 'Chinese' });
  assert.equal(r.status, 'unchecked'); assert.equal(r.issues[0].length, 160); assert.equal(r.language, 'Chinese');
});
test('only photos and PDFs can be checked', () => {
  assert.ok(CHECKABLE('image/png', 'a.png')); assert.ok(CHECKABLE('application/pdf', 'a.pdf')); assert.ok(!CHECKABLE('application/vnd.ms-excel', 'a.xls'));
});
test('send warning counts warnings and unchecked files', () => {
  const t = reviewTotals(['a', 'b', 'c', 'd'], { a: { status: 'ok' }, b: { status: 'warn' }, c: unchecked() });
  assert.deepEqual(t, { warn: 1, notChecked: 2 });
  assert.match(sendWarning(t), /1 attached file has warnings.*2 attached files were not checked/);
  assert.equal(sendWarning({ warn: 0, notChecked: 0 }), '');
});
test('supplier email lists the files', () => {
  const m = rfqSupplierEmail({ rfq: { ref: 'RFQ-1', title: 'Rope', items: [{ description: 'Rope' }] }, supplier: { name: 'S' }, url: 'https://x', files: ['a.pdf', 'b.jpg'], attached: true });
  assert.match(m.html, /a\.pdf, b\.jpg/); assert.match(m.html, /attached to this email/); assert.match(m.text, /Files: a\.pdf, b\.jpg \(attached\)/);
});
