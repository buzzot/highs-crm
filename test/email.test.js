import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inviteEmail, codeEmail, resetEmail, esc } from '../src/lib/email-templates.js';

const all = [
  inviteEmail({ url: 'https://app.example.com/invite/tok', code: '048213', orgName: 'Acme <Retail>', inviterName: 'Anna', days: 14 }),
  codeEmail({ url: 'https://app.example.com/login/verify', code: '482913', minutes: 15 }),
  codeEmail({ url: 'https://app.example.com/invite/tok', code: '111222', purpose: 'invite' }),
  resetEmail({ url: 'https://app.example.com/reset/a%40b.com/xyz', email: 'a@b.com', minutes: 30 }),
];

test('emails carry the code / link and never mention Supabase or localhost', () => {
  for (const m of all) {
    assert.ok(m.subject && m.html && m.text);
    assert.doesNotMatch(m.html + m.text + m.subject, /supabase|localhost|\{\{/i);
    assert.match(m.html, /https:\/\/app\.example\.com\//);
  }
  assert.match(all[0].html, /048213/); assert.match(all[0].text, /048213/);
  assert.match(all[1].subject, /482913/);
  assert.match(all[3].html, /30 minutes/);
});

test('user-supplied names are escaped', () => {
  assert.match(all[0].html, /Acme &lt;Retail&gt;/);
  assert.doesNotMatch(all[0].html, /Acme <Retail>/);
  assert.equal(esc(`"'<&>`), '&quot;&#39;&lt;&amp;&gt;');
});

import { documentsEmail } from '../src/lib/email-templates.js';
test('documents email lists the files and has no button when there is no link', () => {
  const m = documentsEmail({ order: { order_no: 'HB-1' }, docs: [{ title: 'Commercial invoice CI-1 (001)' }], company: { name: 'Lumi Trade' }, message: 'Hello <b>' });
  assert.match(m.subject, /HB-1/);
  assert.ok(m.html.includes('Commercial invoice CI-1 (001)') && m.html.includes('Hello &lt;b&gt;'));
  assert.ok(!m.html.includes('Button not working'));
});
