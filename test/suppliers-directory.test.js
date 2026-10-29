import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSuppliers, portalMap } from '../src/lib/suppliers.js';
import { render } from './mini-ejs.js';
import { pages } from './fixtures.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const view = name => { const e = pages[name]; const [tpl, loc] = Array.isArray(e) ? e : [name, e]; return render(path.join(root, 'src/views', tpl + '.ejs'), loc); };
const CRM = ['prospect', 'contacted', 'sampling', 'approved', 'active', 'on_hold', 'blocked'];
const today = '2026-10-29';
const S = (id, o) => ({ id, country: 'China', city: 'Shenzhen', crm_status: 'active', details_completed_at: '2026-01-01', ...o });
const data = () => ({
  suppliers: [
    S('a', { name: 'Brightway Electronics', contact_name: 'Li Wei', email: 'liwei@bw.example', wechat: 'liwei_bw', rating: 4, lead_time_days: 30, next_follow_up: '2026-10-20', company_type: 'factory' }),
    S('b', { name: '(huayuanwire.com)', email: 'eva@huayuanwire.com', contact_name: 'Eva', details_completed_at: null, crm_status: 'contacted', city: null }),
    S('c', { name: '深圳市明亮电子科技有限公司', country: 'RU', city: 'Казань', main_products: 'tumblers', crm_status: 'on_hold' }),
    S('d', { name: 'Plain Co', city: null, country: null, next_follow_up: today }),
  ],
  portal: { a: 'active', b: 'invited' }, products: [{ supplier_id: 'a', name: 'LED desk lamp', category: 'Lighting' }, { supplier_id: 'a', name: 'USB cable', category: 'Cables' }, { supplier_id: 'c', name: 'Steel rope', category: 'Hardware' }],
  pos: [{ supplier_id: 'a' }, { supplier_id: 'a' }, { supplier_id: 'c' }],
  people: [{ supplier_id: 'a', full_name: 'Li Wei', email: 'liwei@bw.example' }, { supplier_id: 'a', full_name: 'Zhang Min', email: 'zhang@bw.example' }], crmOrder: CRM,
});
const find = (q) => buildSuppliers(data(), q, today).rows.map(r => r.id);

test('portal status is its own thing: active, invited, expired, none', () => {
  const now = Date.parse('2026-10-29');
  assert.deepEqual(portalMap([{ supplier_id: 'a', accepted_at: 'x', active: true }, { supplier_id: 'z', accepted_at: 'x', active: false }],
    [{ supplier_id: 'b', expires_at: '2026-11-05' }, { supplier_id: 'c', expires_at: '2026-10-01' }, { supplier_id: 'a', expires_at: '2026-11-05' }], now), { a: 'active', b: 'invited', c: 'expired' });
});

test('search covers name, city, country (even by alias), contact, email, WeChat, products, categories and extra portal users', () => {
  assert.deepEqual(find({ q: 'brightway' }), ['a']);
  assert.deepEqual(find({ q: 'liwei_bw' }), ['a']);                    // WeChat
  assert.deepEqual(find({ q: 'eva@huayuan' }), ['b']);                 // email
  assert.deepEqual(find({ q: 'Eva' }), ['b']);                         // contact name
  assert.deepEqual(find({ q: 'russia' }), ['c']);                      // stored as "RU"
  assert.deepEqual(find({ q: 'казань' }), ['c']);                      // Cyrillic
  assert.deepEqual(find({ q: '深圳市' }), ['c']);                       // Chinese name
  assert.deepEqual(find({ q: 'lamp' }), ['a']);                        // product name
  assert.deepEqual(find({ q: 'hardware' }), ['c']);                    // product category
  assert.deepEqual(find({ q: 'tumblers' }), ['c']);                    // main products text
  assert.deepEqual(find({ q: 'zhang' }), ['a']);                       // a second portal user
  assert.deepEqual(find({ q: 'shenzhen wei' }), ['a']);                // several words must all match
  assert.deepEqual(find({ q: 'nothing like this' }), []);
});

test('filters: relationship status, follow-up due, portal access; inactive and invited suppliers stay findable', () => {
  assert.deepEqual(find({ status: 'contacted' }), ['b']);
  assert.deepEqual(find({ status: 'on_hold' }), ['c']);
  assert.deepEqual(find({ view: 'followup' }).sort(), ['a', 'd']);
  assert.deepEqual(find({ view: 'invites' }), ['b']);
  assert.deepEqual(find({ view: 'invites', status: 'contacted' }), ['b']); assert.deepEqual(find({ view: 'invites', status: 'active' }), []);
  assert.deepEqual(find({}).sort(), ['a', 'b', 'c', 'd']);                          // All suppliers: every relationship status, on hold and blocked included
  assert.deepEqual(find({ portal: 'invited' }), ['b']);
  assert.deepEqual(find({ portal: 'none' }).sort(), ['c', 'd']);
  assert.deepEqual(find({ portal: 'active', status: 'active' }), ['a']);   // filters combine
  const r = buildSuppliers(data(), {}, today);
  assert.equal(r.counts.all, 4); assert.equal(r.counts.followup, 2); assert.equal(r.counts.invites, 1); assert.equal(r.counts.on_hold, 1);
});

test('invited records: awaiting company details, placeholder shown as the domain, nothing invented', () => {
  const b = buildSuppliers(data(), {}, today).rows.find(r => r.id === 'b');
  assert.equal(b.awaiting, true); assert.equal(b.placeholder, true); assert.equal(b.shownName, 'huayuanwire.com'); assert.equal(b.domain, 'huayuanwire.com'); assert.equal(b.name, '(huayuanwire.com)');   // stored name untouched
  const a = buildSuppliers(data(), {}, today).rows.find(r => r.id === 'a');
  assert.equal(a.awaiting, false); assert.equal(a.placeholder, false); assert.equal(a.shownName, 'Brightway Electronics');
});

test('counts and contacts: products and purchase orders per supplier, extra portal users, overdue vs due today', () => {
  const rows = Object.fromEntries(buildSuppliers(data(), {}, today).rows.map(r => [r.id, r]));
  assert.deepEqual([rows.a.nProducts, rows.a.nPos, rows.b.nProducts, rows.b.nPos, rows.c.nProducts, rows.c.nPos], [2, 2, 0, 0, 1, 1]);
  assert.deepEqual(rows.a.otherContacts.map(p => p.full_name), ['Zhang Min']);   // primary contact is not repeated
  assert.equal(rows.a.overdue, true); assert.equal(rows.d.overdue, false); assert.equal(rows.d.dueToday, true);
  assert.equal(rows.c.place, 'Казань, Russia'); assert.equal(rows.d.place, '');   // display spelling only
});

test('sorting: missing values always last, both directions', () => {
  const ids = q => buildSuppliers(data(), q, today).rows.map(r => r.id);
  assert.deepEqual(ids({ sort: 'rating', dir: 'desc' }).slice(0, 1), ['a']); assert.equal(ids({ sort: 'rating', dir: 'asc' })[0], 'a');   // only one rated: first either way
  assert.deepEqual(ids({ sort: 'products', dir: 'desc' }).slice(0, 2), ['a', 'c']);
  assert.deepEqual(ids({ sort: 'status' }).slice(0, 2), ['b', 'a']);   // contacted before active, by workflow order
  assert.equal(ids({ sort: 'location' }).at(-1), 'd');                // no country last
  assert.equal(ids({ sort: 'followup' })[0], 'a');
});

test('page: three attributes are separate, optional columns, tooltips, Not rated', () => {
  const html = view('admin/suppliers/index');
  assert.match(html, /<th class="c-portal"/);                         // portal access has its own column…
  assert.match(html, /class="sp-rel crm-/);                           // …apart from the relationship status (compact badge)
  assert.doesNotMatch(html, /<select[^>]*pillselect/);
  assert.match(html, /Manufacturer \+ trading|Manufacturer/);         // business role under the name
  assert.match(html, /Awaiting company details/); assert.match(html, /huayuanwire\.com/); assert.doesNotMatch(html, /\(huayuanwire\.com\)/);
  assert.match(html, /Not rated/); assert.match(html, /Entered by your team on the supplier profile/); assert.match(html, /Not calculated from orders/);
  assert.match(html, /data-col="rating"/); assert.match(html, /data-col="lead"/);
  assert.match(html, /\/admin\/products\?supplier=s1/); assert.match(html, /\/admin\/purchasing\?supplier=s1/);
  assert.match(html, /\/admin\/suppliers\/s3#portal/);                // manage the invitation on the supplier profile
  assert.match(html, /\+ 1 more portal user/);
  assert.match(html, /overdue/); assert.match(html, /Due today/);
  assert.doesNotMatch(html, /href="\/admin\/products\?supplier=s3"/);   // zero counts are plain text
});

test('page: states — empty, no match, filtered (Clear filters), no follow-up column when none scheduled', () => {
  assert.match(view('admin/suppliers/index#empty'), /No suppliers yet/);
  const nm = view('admin/suppliers/index#nomatch'); assert.match(nm, /No suppliers match/); assert.match(nm, /Clear filters/);
  assert.match(view('admin/suppliers/index#search'), /Clear filters/); assert.doesNotMatch(view('admin/suppliers/index'), /Clear filters/);
  const nf = view('admin/suppliers/index#nofollow'); assert.doesNotMatch(nf, /Next follow-up/); assert.match(nf, /Add a follow-up date when logging an activity/);
  assert.match(view('admin/suppliers/index#rating'), /show-rating/);   // sorting by a hidden column shows it
});

test('Purchasing can be filtered to one supplier', () => {
  const html = view('admin/purchasing/index#supplier');
  assert.match(html, /Showing purchase orders for <strong>Shenzhen Brightway Electronics/); assert.match(html, /supplier=s1/); assert.match(html, /Show all suppliers/);
  assert.doesNotMatch(view('admin/purchasing/index'), /Show all suppliers/);
  const r = fs.readFileSync(path.join(root, 'src/routes/admin/purchasing.js'), 'utf8');
  assert.match(r, /q\.eq\('supplier_id', supplierId\)/);
});

test('status change from the list gives feedback, is logged, and checks the status exists', () => {
  const r = fs.readFileSync(path.join(root, 'src/routes/admin/suppliers.js'), 'utf8');
  assert.match(r, /That relationship status does not exist/); assert.match(r, /action: 'crm_status'/); assert.match(r, /is already/);
});

test('page: three quick views, no status tabs, Filters popover, relationship menu', () => {
  const html = view('admin/suppliers/index');
  const nav = html.match(/<nav class="sp-views"[\s\S]*?<\/nav>/)[0];
  assert.equal((nav.match(/<a /g) || []).length, 3);
  assert.match(nav, /All suppliers/); assert.match(nav, /Follow-up due/); assert.match(nav, /Invitations/);
  assert.match(html, /<details class="sp-pop sp-filters"/); assert.match(html, /name="status"/); assert.match(html, /name="portal"/);
  assert.match(html, /Columns/); assert.doesNotMatch(html, /Sampling<span/);   // statuses live in the filter, not in tabs
  assert.match(html, /action="\/admin\/suppliers\/s1\/status"/);               // per-row status change still posts to the same route
  const f = view('admin/suppliers/index#filtered2'); assert.match(f, /sp-badge/); assert.match(f, /Clear filters/);
  assert.match(view('admin/suppliers/index#emptyview'), /No follow-ups are due/);
  assert.match(view('admin/suppliers/index#invites'), /class="on"|class="on /);
});
