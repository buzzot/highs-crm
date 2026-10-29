import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCompany, validateActivity } from '../src/lib/crm-forms.js';
import { canActOn, followState, isoDate } from '../src/lib/followup-rules.js';
import { needsAttention } from '../src/lib/dashboard.js';
import { memberRows } from '../src/lib/members.js';
import { render } from './mini-ejs.js';
import { pages } from './fixtures.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const view = name => { const e = pages[name]; const [tpl, loc] = Array.isArray(e) ? e : [name, e]; return render(path.join(root, 'src/views', tpl + '.ejs'), loc); };

test('company form: a message per bad field, valid data passes, long international names are fine', () => {
  const bad = validateCompany({ name: ' ', email: 'x', phone: 'abc', website: 'a b' }).errors;
  assert.deepEqual(Object.keys(bad).sort(), ['email', 'name', 'phone', 'website']);
  for (const name of ['Общество с ограниченной ответственностью «Научно-производственное объединение»', '深圳市明亮电子科技有限公司', 'Acme Retail LLC']) {
    const r = validateCompany({ name, email: 'buyer@acme.co', phone: '+1 (415) 555-0100 ext 12', website: 'www.acme.com/en', default_currency: 'USD' });
    assert.deepEqual(r.errors, {}); assert.equal(r.values.name, name);
  }
  assert.ok(validateCompany({ name: 'A', default_currency: 'XYZ' }).errors.default_currency);
  assert.equal(validateCompany({ name: 'A', default_currency: 'RUB' }, { keepCurrency: 'RUB' }).errors.default_currency, undefined);   // an existing unusual currency is not forced to change
  assert.ok(validateCompany({ name: 'x'.repeat(201) }).errors.name);
});

test('activity form: summary required, follow-up not before the activity, values kept for the form', () => {
  const r = validateActivity({ summary: '', date: '2026-10-10', follow_up: '2026-10-01', next_action: 'Call', type: 'meeting' }, '2026-10-29');
  assert.ok(r.errors.summary && r.errors.follow_up);
  assert.equal(r.values.next_action, 'Call'); assert.equal(r.values.type, 'meeting');
  assert.deepEqual(validateActivity({ summary: 'ok', follow_up: '2026-11-01' }, '2026-10-29').errors, {});
  assert.ok(validateActivity({ summary: 'ok', follow_up: '31-12-2026' }).errors.follow_up);
});

test('follow-up helpers: who may act, due state, date parsing', () => {
  const fu = { owner_id: 'u1', status: 'open', due_date: '2026-10-20' };
  assert.equal(canActOn({ id: 'u1' }, fu, false), true);
  assert.equal(canActOn({ id: 'u2' }, fu, false), false);
  assert.equal(canActOn({ id: 'u2' }, fu, true), true);       // Admin / Director
  assert.equal(followState(fu, '2026-10-29'), 'overdue');
  assert.equal(followState({ ...fu, due_date: '2026-10-29' }, '2026-10-29'), 'today');
  assert.equal(followState({ ...fu, status: 'done' }, '2026-10-29'), 'done');
  assert.equal(isoDate('2026-02-30x'), null); assert.equal(isoDate('2026-10-29'), '2026-10-29');
});

test('Dashboard Action Center: overdue client follow-ups are real tasks with owner and due date; done ones are not', () => {
  const today = '2026-10-29';
  const items = needsAttention({ today, now: Date.parse(today), followups: [
    { id: 'f1', org_id: 'o1', title: 'Send price list', due_date: '2026-10-25', owner_id: 'u1', status: 'open', organizations: { name: 'Acme' } },
    { id: 'f2', org_id: 'o2', title: 'Call back', due_date: today, owner_id: 'u2', status: 'open', organizations: { name: 'Raylux' } },
    { id: 'f3', org_id: 'o3', title: 'Old', due_date: '2026-10-01', owner_id: 'u1', status: 'done', organizations: { name: 'Gone' } },
    { id: 'f4', org_id: 'o4', title: 'Later', due_date: '2026-11-30', owner_id: 'u1', status: 'open', organizations: { name: 'Future' } }] }).filter(i => i.kind === 'followup');
  assert.equal(items.length, 2);
  const late = items.find(i => i.ref === 'Acme');
  assert.equal(late.level, 'overdue'); assert.equal(late.owner, 'u1'); assert.equal(late.href, '/admin/clients/o1#activity'); assert.match(late.when, /4 d/);
  assert.equal(items.find(i => i.ref === 'Raylux').level, 'pending');
});

test('portal users: active, pending, expired, disabled and cancelled are told apart', () => {
  const now = new Date('2026-10-29T12:00:00Z');
  const rows = memberRows([
    { id: 'a', email: 'a@x.co', accepted_at: '2026-09-01', active: true },
    { id: 'd', email: 'd@x.co', accepted_at: '2026-09-01', active: false },
    { id: 'c', email: 'c@x.co', accepted_at: null, active: false }],
  [{ email: 'p@x.co', created_at: '2026-10-25T00:00:00Z' }, { email: 'e@x.co', created_at: '2026-09-01T00:00:00Z' }], now);
  const st = Object.fromEntries(rows.map(r => [r.email, r.state + (r.active === false ? '/off' : '')]));
  assert.deepEqual(st, { 'p@x.co': 'pending', 'e@x.co': 'expired', 'a@x.co': 'accepted', 'd@x.co': 'accepted/off', 'c@x.co': 'manual/off' });
});

test('client page: one source for last sign-in, scoped counts, grouped duplicates keep every event', () => {
  const html = view('admin/clients/detail');
  assert.match(html, /Last sign-in to the portal: 28 Oct/);          // same value as Overview
  assert.match(html, /<b>1<\/b> active portal user · 1 pending · 1 expired/);
  assert.match(html, /×2/);                                          // the duplicate "company details completed" shown once…
  assert.equal((html.match(/<details class="grp">[\s\S]*?<\/details>/g) || []).length, 1);
  assert.equal((html.match(/<details class="grp">[\s\S]*?<\/details>/)[0].match(/<li>/g) || []).length, 2);   // …with both events listed under it
  assert.match(html, /Follow-up overdue/); assert.match(html, /Follow-up due/);
  assert.doesNotMatch(html, /Activity completed/);                   // completing a follow-up never completes the activity
  assert.equal((html.match(/\+ New order/g) || []).length, 1);       // a single New order button
  assert.match(html, /\/admin\/orders\/new\?org_id=o1/); assert.match(html, /\/admin\/sourcing\/new\?org=o1/);
});

test('client page: each status has its own label and standard actions with confirmation', () => {
  const html = view('admin/clients/detail');
  for (const t of ['Pending invitation', 'Expired invitation', 'Disabled']) assert.match(html, new RegExp(t));
  assert.match(html, /data-confirm-title="Disable portal access\?"/);
  assert.match(html, /data-confirm-title="Cancel this invitation\?"/);
  assert.match(html, /previous link and code stop working/);
  assert.doesNotMatch(html, /token=|invite\/[A-Za-z0-9_-]{20,}/);   // no invitation token in the page
});

test('edit drawer: grouped fields, fixed header/footer parts, errors shown next to fields with values kept', () => {
  const html = view('admin/clients/detail#editerr');
  for (const g of ['Company identity', 'Contact information', 'Addresses', 'Preferences']) assert.match(html, new RegExp('<legend>' + g));
  assert.match(html, /class="dh"/); assert.match(html, /class="db2"/); assert.match(html, /class="df"/);
  assert.match(html, /id="f-email-e" role="alert">Enter a valid email/);
  assert.match(html, /value="not-an-email"/); assert.match(html, />Keep me<\/textarea>/);
  assert.match(html, /Discard your changes\?/);
  assert.match(html, /OPEN = "editdlg"/);
});

test('add-activity drawer: follow-up owner, errors and kept values; without migration 0038 it says so', () => {
  const html = view('admin/clients/detail#acterr');
  assert.match(html, /Responsible/); assert.match(html, /The follow-up cannot be before the activity date/); assert.match(html, /value="Send quote"/);
  const old = view('admin/clients/detail#nofu');
  assert.match(old, /0038_client_followups\.sql/); assert.doesNotMatch(old, /\/followups\/[a-z0-9]+\/complete/);
});

test('Managers can only complete or reschedule their own follow-ups', () => {
  const html = view('admin/clients/detail#manager');
  assert.doesNotMatch(html, /data-resched=/); assert.match(html, /an Admin or a Director can change this/);
});

test('sparse client: neutral dashes, no empty KPI cards, no portal users message', () => {
  const html = view('admin/clients/detail#sparse');
  assert.match(html, /No requests yet/); assert.match(html, /Nobody from this client has portal access yet/);
  assert.match(html, /Nobody has signed in to the portal yet/); assert.match(html, /No open follow-ups/);
  assert.doesNotMatch(html, /class="kpi"/);
});

test('migration 0038 and routes exist', () => {
  const sql = fs.readFileSync(path.join(root, 'supabase/migrations/0038_client_followups.sql'), 'utf8');
  assert.match(sql, /create table if not exists client_followups/); assert.match(sql, /enable row level security/); assert.match(sql, /insert into client_followups/);
  const r = fs.readFileSync(path.join(root, 'src/routes/admin/clients.js'), 'utf8');
  for (const p of ['/followups/:fid/complete', '/followups/:fid/reschedule', '/followups/:fid/reopen']) assert.ok(r.includes(p), p);
  assert.match(r, /That user does not belong to this client/);       // disabling is limited to this client's own users
});
