import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from './mini-ejs.js';
import { pages } from './fixtures.js';
import { toRussian, pickLang } from '../src/lib/i18n.js';

const ru = name => { const v = pages[name]; const [view, data] = Array.isArray(v) ? v : [name, v]; return toRussian(render(`src/views/${view}.ejs`, { ...data, lang: 'ru' })); };

test('language cookie: only ru switches, everything else is English', () => {
  assert.equal(pickLang('ru'), 'ru'); assert.equal(pickLang('zh'), 'en'); assert.equal(pickLang(undefined), 'en');
});
test('client portal pages come out in Russian with the switch in the header', () => {
  const h = ru('portal/dashboard');
  assert.match(h, /lang="ru"/); assert.match(h, /Мои запросы/); assert.match(h, /Мои заказы/); assert.match(h, /class="langsw"/);
});
test('form values and field names are never translated', () => {
  const h = ru('portal/po');
  assert.match(h, /name="do" value="send"/);
});
test('dates and quantities use Russian short forms; names are kept', () => {
  const h = toRussian('<p>Hello, Tom</p><span>14 Oct, 11:35</span><b>1,500 pcs</b><i>Order HB-1</i>');
  assert.match(h, /Здравствуйте, Tom/); assert.match(h, /14 окт, 11:35/); assert.match(h, /1,500 шт/); assert.match(h, /Заказ HB-1/);
});
test('HTML in the page is left intact and user text is escaped', () => {
  const h = toRussian('<td>Products you&#39;ve asked us to source, and the quotes we&#39;ve sent back.</td><td>A &amp; B</td>');
  assert.match(h, /Товары, которые/); assert.match(h, /A &amp; B/);
});
