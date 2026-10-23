import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanSpec, specFacts } from '../src/lib/request-spec.js';
import { parseItems } from '../src/lib/request-items.js';
import { cleanItems } from '../src/lib/rfq.js';

test('cleanSpec keeps known fields, drops bad dates / incoterms / unknown keys', () => {
  const s = cleanSpec({ materials: ' ABS ', certifications: 'CE, RoHS', incoterm: 'fob', etd: '2026-11-30', valid_until: 'next week', color: 'red', size: '' });
  assert.deepEqual(s, { materials: 'ABS', certifications: 'CE, RoHS', incoterm: 'FOB', etd: '2026-11-30' });
  assert.deepEqual(cleanSpec(null), {}); assert.deepEqual(cleanSpec('{"materials":"x"}'), { materials: 'x' }); assert.deepEqual(cleanSpec('not json'), {});
});

test('specFacts lists what is filled in, labelled', () => {
  assert.deepEqual(specFacts({ materials: 'ABS', etd: '2026-11-30' }), [['Materials', 'ABS'], ['Needed by (ETD)', '2026-11-30']]);
});

test('request form lines carry their spec; clients (no spec) are unchanged', () => {
  const rows = parseItems({ items: { 0: { name: 'Lamp', spec: { materials: 'Aluminium', incoterm: 'EXW' } }, 1: { name: 'Cable' } } });
  assert.deepEqual(rows[0].spec, { materials: 'Aluminium', incoterm: 'EXW' });
  assert.equal('spec' in rows[1], false);
});

test('RFQ lines keep the spec from the request', () => {
  const [it] = cleanItems({ item: { 0: { description: 'Lamp', spec: JSON.stringify({ certifications: 'CE' }) } } });
  assert.deepEqual(it.spec, { certifications: 'CE' });
});
