import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { render } from './mini-ejs.js';
import { pages } from './fixtures.js';
import { validateSupplier, supplierPatch, mergeFollowUp, purchasingRows, deleteConfirmed } from '../src/lib/supplier-detail.js';

const ok = { name: 'Acme Ltd', crm_status: 'active' };
const html = (k = 'admin/suppliers/detail', over = {}) => render('src/views/admin/suppliers/detail.ejs', { ...(Array.isArray(pages[k]) ? pages[k][1] : pages[k]), ...over });

test('validateSupplier: only the name and a valid status are required; bad formats are reported per field', () => {
  assert.deepEqual(validateSupplier(ok).errors, {});
  const e = validateSupplier({ name: ' ', crm_status: 'nope', email: 'x', phone: '12', website: 'a b', year_established: '99', lead_time_days: 'ab', rating: '9', company_type: 'zzz' }).errors;
  for (const k of ['name', 'crm_status', 'email', 'phone', 'website', 'year_established', 'lead_time_days', 'rating', 'company_type']) assert.ok(e[k], k);
  assert.deepEqual(validateSupplier({ ...ok, phone: '+86 138 2581 4890 ext 12', name: '深圳市明亮电子科技有限公司', email: 'A@B.CO' }).errors, {});
});
test('supplierPatch: empty → null, numbers → numbers, no follow-up field is touched', () => {
  const p = supplierPatch(validateSupplier({ ...ok, lead_time_days: '30', rating: '4', year_established: '2008', notes: '' }).values);
  assert.equal(p.lead_time_days, 30); assert.equal(p.rating, 4); assert.equal(p.year_established, 2008); assert.equal(p.notes, null); assert.equal('next_follow_up' in p, false);
});
test('mergeFollowUp keeps ONE next follow-up: the earliest open date wins', () => {
  assert.equal(mergeFollowUp(null, '2026-11-05'), '2026-11-05');
  assert.equal(mergeFollowUp('2026-11-01', '2026-11-05'), '2026-11-01');
  assert.equal(mergeFollowUp('2026-11-10', '2026-11-05'), '2026-11-05');
  assert.equal(mergeFollowUp('2026-11-10', null), '2026-11-10');
});
test('purchasingRows: PI status and balances come from the confirmed PI and recorded payments, per currency', () => {
  const pos = [{ id: 'a', status: 'confirmed', currency: 'CNY', total: 999 }, { id: 'b', status: 'sent', currency: 'USD', total: 50 }, { id: 'c', status: 'cancelled', currency: 'CNY', total: 1 }, { id: 'd', status: 'confirmed', currency: 'USD', total: 10 }];
  const pis = [{ po_id: 'a', status: 'confirmed', currency: 'CNY', total: 1000, lines: [{ quantity: 10, unit_price: 100 }], created_at: '2026-01-01' }, { po_id: 'b', status: 'draft', currency: 'USD', total: 50, lines: [], created_at: '2026-01-01' },
    { po_id: 'c', status: 'confirmed', currency: 'CNY', total: 700, lines: [{ quantity: 7, unit_price: 100 }], created_at: '2026-01-01' }, { po_id: 'd', status: 'confirmed', currency: 'USD', total: 20, lines: [{ quantity: 2, unit_price: 10 }], created_at: '2026-01-01' }];
  const r = purchasingRows(pos, pis, [{ po_id: 'a', amount: 400, currency: 'CNY' }, { po_id: 'd', amount: 20, currency: 'USD' }]);
  const by = Object.fromEntries(r.rows.map(x => [x.id, x]));
  assert.equal(by.a.piTotal, 1000); assert.equal(by.a.pay, 'partial'); assert.equal(by.a.open, 600);   // not the PO total of 999
  assert.equal(by.b.piStatus, 'draft'); assert.equal(by.b.pay, 'pi_draft'); assert.equal(by.b.open, null);
  assert.equal(by.d.pay, 'paid');
  assert.deepEqual(r.owed, { CNY: 600 });                       // cancelled PO and settled PO are not counted
  assert.equal(r.open, 1);
  assert.equal(purchasingRows([{ id: 'z', status: 'draft', currency: 'CNY', total: 5 }]).rows[0].pay, 'no_pi');
});
test('deleteConfirmed needs the exact name (case-insensitive)', () => {
  assert.ok(deleteConfirmed(' acme ltd ', 'Acme Ltd')); assert.ok(!deleteConfirmed('Acme', 'Acme Ltd')); assert.ok(!deleteConfirmed('', ''));
});

test('page: five tabs, compact header, actions, no always-visible forms', () => {
  const h = html();
  for (const t of ['overview', 'products', 'purchasing', 'activity', 'portal']) assert.match(h, new RegExp(`data-tab="${t}"`));
  assert.match(h, /\+ Add product/); assert.match(h, /\/admin\/purchasing\/new\?supplier=s1/); assert.match(h, /Edit supplier/);
  assert.match(h, /class="pill crm-active"/); assert.match(h, /Portal: active/);
  assert.doesNotMatch(h, /class="detailsform"/); assert.doesNotMatch(h, /<div class="kpis/);
  assert.equal((h.match(/name="next_follow_up"/g) || []).length, 0);       // one follow-up date, not an editable field in several places
});
test('page: purchasing shows supplier POs with PI and payment state; the amount to pay is the PI balance', () => {
  const h = html();
  assert.match(h, /SPO-2610-0421/); assert.match(h, /\/admin\/purchasing\/po1/); assert.match(h, /PI confirmed/); assert.match(h, /Part paid/); assert.match(h, /PI not confirmed/); assert.match(h, /No PI yet/);
  assert.match(h, /To pay<\/span> <b>¥84,000/); assert.doesNotMatch(h, /customer order/i);
  assert.match(html('admin/suppliers/detail_new'), /No purchase orders yet/);
});
test('page: products tab — search, import dialog with review steps, never silent overwrite', () => {
  const h = html();
  assert.match(h, /id="pfind"/); assert.match(h, /data-hay="led desk lamp 10w/); assert.match(h, /id="importdlg"/); assert.match(h, /nothing is saved before this step/i); assert.match(h, /Review submissions/);
  assert.match(h, /name="supplier_id" value="s1"/); assert.match(h, /¥38\.50/);
  const rv = fs.readFileSync('src/views/admin/products/import_review.ejs', 'utf8');
  assert.match(rv, /\(p\.action \|\| 'skip'\) === 'skip' \? 'selected'/);   // matched rows default to keeping the existing product
});
test('page: documents list with visibility, confirmation before exposing, restricted delete', () => {
  const h = html();
  assert.match(h, /BSCI-2025\.pdf/); assert.match(h, /Internal/); assert.match(h, /Client sees/);
  assert.match(h, /data-sdconfirm="Show this document to clients\?"/);
  assert.match(h, /Restricted actions/); assert.match(h, /id="deldlg"/); assert.match(h, /name="confirm_name"/);
  assert.doesNotMatch(html('admin/suppliers/detail', { isAdmin: false, user: { ...pages['admin/suppliers/detail'].user, role: 'staff' } }), /Restricted actions/);
});
test('page: edit drawer holds every supplier field; activity is a modal; invited supplier is not shown as a finished profile', () => {
  const h = html();
  for (const f of ['name', 'registration_no', 'year_established', 'employees', 'website', 'contact_name', 'email', 'phone', 'wechat', 'address', 'city', 'postal_code', 'country', 'company_type', 'crm_status', 'can_export_official', 'main_products', 'payment_terms', 'lead_time_days', 'rating', 'certifications', 'notes'])
    assert.match(h, new RegExp(`<(input|textarea|select)[^>]*name="${f}"`), f);
  assert.match(h, /id="actdlg"/); assert.match(h, /action="\/admin\/suppliers\/s1\/activity"/);
  const n = html('admin/suppliers/detail_new'); assert.match(n, /Filled in by the supplier/); assert.match(n, /Waiting for the supplier to register/);
});
test('page: validation errors reopen the drawer with the typed values', () => {
  const { errors, values } = validateSupplier({ name: '', crm_status: 'active', email: 'bad' });
  const h = html('admin/suppliers/detail', { edit: { vals: values, errors }, openDlg: 'editdlg' });
  assert.match(h, /Company name is required/); assert.match(h, /Enter a valid email address/); assert.match(h, /data-invalid="1"/); assert.match(h, /OPEN = "editdlg"/);
});
test('routes: details/followup/portal handlers are guarded and audited', () => {
  const r = fs.readFileSync('src/routes/admin/suppliers.js', 'utf8');
  assert.match(r, /followup\/done/); assert.match(r, /followup\/reschedule/); assert.match(r, /action: 'followup_done'/);
  assert.match(r, /p\.supplier_id !== req\.params\.id/);                          // a user can only be disabled from their own supplier
  assert.match(r, /deleteConfirmed\(req\.body\.confirm_name/); assert.match(r, /supplier_pos/);
});
