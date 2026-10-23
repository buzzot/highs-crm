import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from './mini-ejs.js';
import { pages } from './fixtures.js';
import { wantsLinkOnly } from '../src/lib/members.js';

test('no-email invitation: link and code are shown with copy buttons', () => {
  const html = render('src/views/admin/suppliers/detail.ejs', pages['admin/suppliers/detail']);
  assert.match(html, /invite\/tok123/);
  assert.match(html, /482913/);
  assert.match(html, /data-copy/);
  assert.match(html, /name="no_email"/);
});
test('wantsLinkOnly reads the checkbox', () => {
  assert.equal(wantsLinkOnly({ no_email: '1' }), true);
  assert.equal(wantsLinkOnly({}), false);
});
