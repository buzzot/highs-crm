import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compress, staticGzip } from '../src/lib/compress.js';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
function get(port, url, headers = {}) {
  return new Promise((resolve, reject) => http.get({ port, path: url, headers }, res => { const parts = []; res.on('data', c => parts.push(c)); res.on('end', () => resolve({ res, body: Buffer.concat(parts) })); }).on('error', reject));
}
// a tiny stand-in for the bits of Express the middleware uses (res.status / set / send / type / json)
function shim(res) {
  res.status = c => { res.statusCode = c; return res; };
  res.set = h => { for (const [k, v] of Object.entries(h)) res.setHeader(k, v); return res; };
  res.type = t => { res.setHeader('Content-Type', t === 'html' ? 'text/html; charset=utf-8' : t); return res; };
  res.send = b => { if (!res.getHeader('Content-Type')) res.type('html'); res.setHeader('Content-Length', Buffer.byteLength(b)); res.end(b); };
  res.json = o => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.send(JSON.stringify(o)); };
  return res;
}
async function withApp(fn) {
  const mw = compress(), st = staticGzip(PUB);
  const routes = { '/big': r => r.type('html').send('<p>hello</p>'.repeat(500)), '/small': r => r.type('html').send('<p>hi</p>'), '/json': r => r.json({ rows: Array.from({ length: 200 }, (_, i) => ({ i, name: 'row ' + i })) }) };
  const server = http.createServer((req, res) => {
    shim(res); req.path = req.url.split('?')[0];
    mw(req, res, () => st(req, res, () => (routes[req.path] ? routes[req.path](res) : res.status(404).end())));
  }).listen(0);
  try { await fn(server.address().port); } finally { server.close(); }
}

test('big HTML / JSON responses are gzipped when the browser accepts it', () => withApp(async port => {
  const a = await get(port, '/big', { 'accept-encoding': 'gzip' });
  assert.equal(a.res.headers['content-encoding'], 'gzip');
  assert.equal(gunzipSync(a.body).toString(), '<p>hello</p>'.repeat(500));
  assert.equal(Number(a.res.headers['content-length']), a.body.length);
  const j = await get(port, '/json', { 'accept-encoding': 'gzip' });
  assert.equal(JSON.parse(gunzipSync(j.body)).rows.length, 200);
}));

test('no gzip without Accept-Encoding, and small bodies stay as they are', () => withApp(async port => {
  const plain = await get(port, '/big');
  assert.equal(plain.res.headers['content-encoding'], undefined);
  assert.equal(plain.body.toString(), '<p>hello</p>'.repeat(500));
  const small = await get(port, '/small', { 'accept-encoding': 'gzip' });
  assert.equal(small.res.headers['content-encoding'], undefined);
}));

test('static CSS is served gzipped with caching headers and answers 304 to a repeat visit', () => withApp(async port => {
  const a = await get(port, '/css/app.css', { 'accept-encoding': 'gzip' });
  assert.equal(a.res.headers['content-encoding'], 'gzip');
  assert.match(a.res.headers['content-type'], /text\/css/);
  assert.match(a.res.headers['cache-control'], /max-age=600/);
  assert.ok(gunzipSync(a.body).toString().includes('.pltable'));
  const b = await get(port, '/css/app.css', { 'accept-encoding': 'gzip', 'if-none-match': a.res.headers.etag });
  assert.equal(b.res.statusCode, 304);
}));
