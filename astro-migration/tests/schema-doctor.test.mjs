import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseSchema, exportDoctorReport, formatDoctorJson } from '../src/lib/schema-doctor.ts';
import { schemaExample, invalidExample, validExample, structuredExample } from '../src/lib/schema-doctor-examples.ts';

const run = (schema, data, options = {}) => diagnoseSchema({ schema: JSON.stringify(schema), json: data === undefined ? '' : JSON.stringify(data), dialect: 'auto', profile: 'standard', formats: false, references: [], ...options });
const errors = report => report.findings.filter(f => f.severity === 'error');

test('published failing example has four precise data paths and source locations', () => {
  const r = diagnoseSchema({ schema: schemaExample, json: invalidExample, dialect: 'auto', profile: 'standard', formats: false, references: [] });
  assert.equal(r.schemaValid, true); assert.equal(r.dataValid, false);
  assert.deepEqual(errors(r).map(f => f.path).sort(), ['/debug', '/items/0/quantity', '/orderId', '/status']);
  for (const f of errors(r)) { assert.ok(f.offset >= 0); assert.ok(f.line >= 2); assert.ok(f.schemaPath.startsWith('#')); }
  assert.equal(invalidExample[errors(r).find(f => f.path === '/items/0/quantity').offset], '0');
});
test('published passing example validates without mutation', () => {
  const input = { schema: schemaExample, json: validExample, dialect: 'auto', profile: 'standard', formats: false, references: [] };
  const before = JSON.stringify(input); const r = diagnoseSchema(input);
  assert.equal(r.dataValid, true); assert.equal(r.findings.length, 0); assert.equal(JSON.stringify(input), before);
});
for (const [name, uri] of [['draft7', 'http://json-schema.org/draft-07/schema#'], ['2019-09', 'https://json-schema.org/draft/2019-09/schema'], ['2020-12', 'https://json-schema.org/draft/2020-12/schema']]) {
  test(`auto detects ${name}, including HTTP/HTTPS alias`, () => {
    for (const schemaUri of [uri, uri.replace(/^https:/, 'http:').replace(/^http:(?=\/\/json-schema.org\/draft-07)/, 'https:')]) {
      const r = run({ $schema: schemaUri, type: 'integer' }, 3);
      assert.equal(r.dialect, name); assert.equal(r.dataValid, true, JSON.stringify(r));
    }
  });
}
test('dialect mismatch and legacy/custom dialects cannot silently pass', () => {
  assert.equal(run({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'string' }, 'ok', { dialect: '2020-12' }).schemaValid, false);
  for (const uri of ['http://json-schema.org/draft-04/schema#', 'https://example.com/custom']) assert.match(errors(run({ $schema: uri }, 1))[0].message, /Unsupported/);
});
test('2020 tuple and unevaluatedProperties work, Draft 7 tuple works', () => {
  assert.equal(run({ type: 'array', prefixItems: [{ type: 'string' }], items: false }, ['a']).dataValid, true);
  assert.equal(run({ type: 'array', prefixItems: [{ type: 'string' }], items: false }, ['a', 2]).dataValid, false);
  assert.equal(run({ type: 'array', items: [{ type: 'string' }], additionalItems: false }, ['a'], { dialect: 'draft7' }).dataValid, true);
  assert.equal(run({ type: 'object', allOf: [{ properties: { a: { type: 'integer' } } }], unevaluatedProperties: false }, { a: 1, b: 2 }).dataValid, false);
});
test('boolean schemas and scalar instances are supported', () => {
  assert.equal(run(true, null).dataValid, true); assert.equal(run(false, null).dataValid, false);
  assert.equal(run({ type: 'boolean' }, false).dataValid, true);
  assert.equal(run({ type: 'number' }, 0).dataValid, true);
  assert.equal(run({ type: 'string' }, '').dataValid, true);
});
test('schema-only and empty document are not reported as valid data', () => {
  assert.equal(run({ type: 'string' }).dataValid, null);
});
test('malformed syntax, comments and trailing commas get line/column errors', () => {
  for (const source of ['{"type":"string",}', '{\n"type":}', '{/*comment*/}', '']) {
    const r = run({}, 1, { schema: source }); assert.equal(r.schemaValid, false); assert.equal(errors(r)[0].keyword, 'syntax'); assert.ok(errors(r)[0].line >= 1);
  }
  const r = run({}, 1, { json: '{"x":}' }); assert.equal(r.schemaValid, true); assert.equal(r.dataValid, false); assert.equal(errors(r)[0].source, 'json');
});
test('duplicate keys are rejected in data, schema, and nested values', () => {
  assert.equal(errors(run({}, 1, { schema: '{"type":"string","type":"number"}' }))[0].keyword, 'duplicate-key');
  assert.equal(errors(run({}, 1, { json: '{"a":{"x":1,"x":2}}' }))[0].path, '/a/x');
});
test('malformed schemas are rejected before document validation', () => {
  for (const schema of [null, [], 4, { type: 'foo' }, { required: 'a' }, { minimum: 'zero' }, { type: 'array', items: [] }]) {
    const r = run(schema, {}); assert.equal(r.schemaValid, false, JSON.stringify(schema)); assert.equal(r.dataValid, null);
  }
});
test('required is distinct from nullable and pointers escape property names', () => {
  const schema = { type: 'object', properties: { 'a/b~c': { type: ['string', 'null'] } }, required: ['a/b~c'] };
  assert.equal(run(schema, { 'a/b~c': null }).dataValid, true);
  const r = run(schema, {}); assert.equal(errors(r)[0].path, '/a~1b~0c'); assert.equal(errors(r)[0].offset, 0);
});
test('oneOf overlap and no anyOf matches explain the branch rules', () => {
  const r = run({ oneOf: [{ type: 'number' }, { type: 'integer' }] }, 2);
  assert.match(errors(r)[0].message, /Matches 2 branches/);
  const union = run({ anyOf: [{ type: 'string' }, { type: 'number' }] }, false);
  assert.equal(errors(union).length, 3); assert.ok(errors(union).some(f => f.keyword === 'anyOf'));
});
test('formats are opt-in; unknown keyword and format are visible warnings', () => {
  assert.equal(run({ type: 'string', format: 'email' }, 'not-email').dataValid, true);
  assert.equal(run({ type: 'string', format: 'email' }, 'not-email', { formats: true }).dataValid, false);
  assert.ok(run({ type: 'string', typoKeyword: 1 }, 'yes').findings.some(f => f.severity === 'warning'));
  const unknown = run({ type: 'string', format: 'custom' }, 'yes', { formats: true });
  assert.equal(unknown.schemaValid, false); assert.match(errors(unknown)[0].message, /unknown format/);
});
test('external references resolve entirely from local schemas', () => {
  const schema = { $id: 'https://example.com/schemas/root.json', $ref: 'item.json' };
  const references = [JSON.stringify({ $id: 'https://example.com/schemas/item.json', type: 'integer' })];
  assert.equal(run(schema, 7, { references }).dataValid, true);
  assert.equal(run(schema, '7', { references }).dataValid, false);
  const missing = run(schema, 7); assert.equal(missing.schemaValid, false); assert.match(errors(missing)[0].hint, /never fetched/);
});
test('reference identifiers, duplicates and syntax are checked', () => {
  for (const ref of [{ type: 'integer' }, { $id: 'relative.json', type: 'integer' }]) assert.equal(run({}, 1, { references: [JSON.stringify(ref)] }).schemaValid, false);
  const ref = JSON.stringify({ $id: 'https://example.com/a', type: 'integer' });
  assert.equal(run({}, 1, { references: [ref, ref] }).schemaValid, false);
  assert.equal(errors(run({}, 1, { references: ['{bad'] }))[0].source, 'reference');
});
test('recursive references and special object keys are handled without pollution', () => {
  const schema = { type: 'object', properties: { next: { $ref: '#' } }, additionalProperties: false };
  assert.equal(run(schema, { next: { next: {} } }).dataValid, true);
  const evil = '{"__proto__":{"polluted":true}}';
  assert.equal(run({ type: 'object', additionalProperties: false }, null, { json: evil }).dataValid, false);
  assert.equal({}.polluted, undefined);
});
test('OpenAI profile findings are separate from passing document validation', () => {
  const r = run({}, { summary: 'ok' }, { schema: structuredExample, profile: 'openai' });
  assert.equal(r.schemaValid, true); assert.equal(r.dataValid, true);
  assert.deepEqual(errors(r).map(f => f.keyword).sort(), ['additionalProperties', 'required']);
  assert.equal(r.profileRevision, '2026-10-05'); assert.equal(r.edits.length, 2);
  const fixed = run({}, { summary: 'ok', category: null }, { schema: r.proposedSchema, profile: 'openai' });
  assert.equal(fixed.dataValid, true); assert.equal(errors(fixed).length, 0);
});
test('profile traversal ignores example data and property names that look like keywords', () => {
  const schema = { type: 'object', properties: { if: { type: 'string' }, required: { type: 'string' } }, required: ['if', 'required'], additionalProperties: false, description: 'if' };
  assert.equal(run(schema, { if: 'a', required: 'b' }, { profile: 'openai' }).findings.length, 0);
});
test('profile does not promise unsupported or unreviewed keyword compatibility', () => {
  const r = run({ type: 'object', properties: {}, additionalProperties: false, allOf: [{}], oneOf: [{}], minProperties: 1 }, undefined, { profile: 'openai' });
  assert.ok(r.findings.some(f => f.keyword === 'allOf' && f.severity === 'error'));
  assert.ok(r.findings.some(f => f.keyword === 'oneOf' && f.severity === 'warning'));
});
test('proposals do not delete constraints or silently add nullability', () => {
  const schema = { type: 'object', properties: { s: { type: 'string', minLength: 2 } }, additionalProperties: { type: 'number' } };
  const r = run(schema, undefined, { profile: 'openai' });
  const fixed = JSON.parse(r.proposedSchema);
  assert.deepEqual(fixed.properties, schema.properties); assert.equal(fixed.additionalProperties, false); assert.deepEqual(fixed.required, ['s']);
  assert.equal(schema.additionalProperties.type, 'number');
});
test('size, nesting, unsupported async and reference count are bounded', () => {
  assert.match(errors(run({}, 0, { json: ' '.repeat(500_001) }))[0].message, /500 KB/);
  assert.match(errors(run({}, 0, { schema: '['.repeat(101) + '0' + ']'.repeat(101) }))[0].message, /100 levels/);
  assert.match(errors(run({}, 0, { references: Array(13).fill('{}') }))[0].message, /12/);
  assert.match(errors(run({ $async: true, type: 'integer' }, 1))[0].message, /async/);
});
test('findings are capped and marked truncated', () => {
  const schema = { type: 'array', items: { type: 'number' } };
  const r = run(schema, Array(300).fill('bad')); assert.equal(r.findings.length, 200); assert.equal(r.truncated, true);
});
test('export excludes original inputs and proposed schemas', () => {
  const r = run({ type: 'integer' }, 'private-document-value');
  const exported = exportDoctorReport(r);
  assert.ok(!exported.includes('private-document-value')); assert.equal(JSON.parse(exported).version, 1);
});
test('unsafe integers and nonfinite numbers cannot silently validate after rounding', () => {
  for (const json of ['9007199254740993', '1e999', '{"id":9007199254740993}']) {
    const r = run({}, null, { json }); assert.equal(r.dataValid, false); assert.ok(errors(r).some(f => f.keyword === 'number-precision'));
  }
});
test('formatting preserves data and rejects duplicate keys and unsafe numbers', () => {
  assert.equal(formatDoctorJson('{"a":1}'), '{\n  "a": 1\n}');
  assert.throws(() => formatDoctorJson('{"a":1,"a":2}'), /Duplicate/);
  assert.throws(() => formatDoctorJson('9007199254740993'), /numeric range/);
  assert.throws(() => formatDoctorJson('{"a":}'), /Invalid JSON/);
});
test('OpenAPI nullable does not silently change JSON Schema semantics', () => {
  const r = run({ type: 'string', nullable: true }, null);
  assert.equal(r.schemaValid, false); assert.equal(r.dataValid, null); assert.match(errors(r)[0].message, /OpenAPI extension/);
});
