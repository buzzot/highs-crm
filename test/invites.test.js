import { test } from 'node:test';
import assert from 'node:assert/strict';

import { memberRows } from '../src/lib/members.js';

const now = new Date('2026-10-20T12:00:00Z');
const day = n => new Date(now.getTime() + n * 864e5).toISOString();

test('invitation status: accepted, pending with days left, expired, manual', () => {
  const profiles = [
    { id: 'a', email: 'acc@x.com', accepted_at: day(-3), active: true },
    { id: 'b', email: 'pend@x.com', accepted_at: null, active: true },
    { id: 'c', email: 'old@x.com', accepted_at: null, active: true },
    { id: 'd', email: 'manual@x.com', accepted_at: null, active: true },
  ];
  const invitations = [
    { email: 'acc@x.com', created_at: day(-5), expires_at: day(9), accepted_at: day(-3) },
    { email: 'pend@x.com', created_at: day(-2), expires_at: day(12) },
    { email: 'pend@x.com', created_at: day(-10), expires_at: day(4), revoked_at: day(-2) },   // superseded
    { email: 'old@x.com', created_at: day(-20), expires_at: day(-6) },
    { email: 'nologin@x.com', created_at: day(-1), expires_at: day(13) },                     // invite email failed
  ];
  const rows = Object.fromEntries(memberRows(profiles, invitations, now).map(r => [r.email, r]));
  assert.equal(rows['acc@x.com'].state, 'accepted');
  assert.equal(rows['pend@x.com'].state, 'pending');
  assert.equal(rows['pend@x.com'].days_left, 12);
  assert.equal(rows['old@x.com'].state, 'expired');
  assert.equal(rows['manual@x.com'].state, 'manual');
  assert.equal(rows['nologin@x.com'].state, 'pending');
});

test('legacy invitation without expires_at gets 14 days from sending', () => {
  const rows = memberRows([{ id: 'x', email: 'l@x.com', active: true }], [{ email: 'l@x.com', created_at: day(-15) }], now);
  assert.equal(rows[0].state, 'expired');
});
