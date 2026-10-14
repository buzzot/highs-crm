import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInbound, matchKeys, stripQuoted, replyAddress, subjectTag } from '../src/lib/freight.js';
import { rfqEmail } from '../src/lib/email-templates.js';
import { normalizeRows, totals } from '../src/lib/packing.js';

test('reply address uses plus-addressing when configured', () => {
  delete process.env.QUOTE_REPLY_ADDRESS;
  assert.equal(replyAddress('abc123def0', 'anna@lumitrade.cc'), 'anna@lumitrade.cc');
  process.env.QUOTE_REPLY_ADDRESS = 'quotes@in.lumitrade.cc';
  assert.equal(replyAddress('abc123def0', 'x@y.z'), 'quotes+abc123def0@in.lumitrade.cc');
  delete process.env.QUOTE_REPLY_ADDRESS;
  assert.equal(subjectTag('FQ-2610-0042', 'abc123def0'), '[FQ-2610-0042 #abc123def0]');
});

test('inbound payloads from different providers are normalised', () => {
  const a = normalizeInbound({ type: 'email.received', data: { from: 'Amy <amy@oceanlink.example>', to: ['quotes+abc123def0@in.lumitrade.cc'], subject: 'Re: Freight quote [FQ-2610-0042 #abc123def0]', text: 'USD 1850' } });
  assert.equal(a.from, 'amy@oceanlink.example');
  assert.deepEqual(matchKeys(a), { token: 'abc123def0' });
  const b = normalizeInbound({ From: 'ken@skyfast.example', To: 'quotes@in.lumitrade.cc', Subject: '回复: Freight quote request · LT-2610-0711 [FQ-2610-0042 #k9k9k9k9k9]', HtmlBody: '<p>Air: 6.5 USD/kg<br>5 days</p>' });
  assert.equal(b.text, 'Air: 6.5 USD/kg\n5 days');
  assert.deepEqual(matchKeys(b), { token: 'k9k9k9k9k9' });
  assert.deepEqual(matchKeys({ to: ['quotes@x.y'], subject: 'Re: FQ-2610-42 price' }), { ref: 'FQ-2610-42' });
  assert.deepEqual(matchKeys({ to: [], subject: 'hello' }), {});
});

test('quoted original message is removed', () => {
  const t = 'Dear Anna,\nUSD 1,850 door to door, 32 days.\nFrom: Shenzhen port\n\nOn Tue, 13 Oct 2026 at 21:00, Anna <a@lumitrade.cc> wrote:\n> please quote\n> thanks';
  const s = stripQuoted(t);
  assert.match(s, /USD 1,850/);
  assert.match(s, /From: Shenzhen port/);
  assert.doesNotMatch(s, /please quote/);
  assert.equal(stripQuoted('价格 USD 900\n发件人: amy@oceanlink.example\n以前的内容'), '价格 USD 900');
});

test('quote request email lists the cargo and stays on brand', () => {
  const rows = normalizeRows([{ description: 'LED lamp <b>', cartons: 20, quantity: 20, dims: '52x38x23', gross_weight_kg: 14 }]);
  const m = rfqEmail({ order: { order_no: 'LT-2610-0711' }, info: { mode: 'Sea LCL', pol: 'Shenzhen', pod: 'Los Angeles' }, rows, t: totals(rows), message: 'Door to door please', senderName: 'Anna Lee', forwarderName: 'Amy' });
  assert.match(m.subject, /LT-2610-0711 · Sea LCL · Shenzhen → Los Angeles/);
  assert.match(m.html, /LED lamp &lt;b&gt;/);
  assert.match(m.html, /Door to door please/);
  assert.match(m.html, /280 kg/);
  assert.doesNotMatch(m.html + m.text, /supabase|Highs/i);
});

test('mailgun signature', async () => {
  const { mailgunSignatureOk } = await import('../src/lib/freight.js');
  const { createHmac } = await import('node:crypto');
  const key = 'k-123', timestamp = String(Math.floor(Date.now() / 1000)), token = 'abc';
  const signature = createHmac('sha256', key).update(timestamp + token).digest('hex');
  assert.equal(mailgunSignatureOk({ timestamp, token, signature }, key), true);
  assert.equal(mailgunSignatureOk({ timestamp, token, signature }, 'other'), false);
  assert.equal(mailgunSignatureOk({ timestamp: '1000', token, signature }, key), false);
  assert.equal(mailgunSignatureOk({}, key), false);
  // Mailgun form fields → normalised mail
  const { normalizeInbound, matchKeys } = await import('../src/lib/freight.js');
  const m = normalizeInbound({ sender: 'amy@ocean.example', recipient: 'quotes+ab12cd34ef@in.lumitrade.cc', subject: 'Re: Freight quote [FQ-2610-0042 #ab12cd34ef]', 'body-plain': 'USD 1850' });
  assert.equal(m.from, 'amy@ocean.example'); assert.equal(m.text, 'USD 1850');
  assert.deepEqual(matchKeys(m), { token: 'ab12cd34ef' });
});
