import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// `<%= 'A &amp; B' %>` is escaped a second time and shows a literal "&amp;" — entities belong in plain markup, not inside <%= %>.
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.ejs') ? [path.join(d, e.name)] : []));
test('no HTML entity inside an escaped <%= %> tag', () => {
  const bad = [];
  for (const f of walk('src/views')) fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (/<%=[^%]*&(amp|lt|gt|quot|nbsp|#\d+);/.test(l)) bad.push(`${f}:${i + 1}`); });
  assert.deepEqual(bad, []);
});
