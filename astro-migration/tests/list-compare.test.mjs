import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareLists, defaultListOptions, listCsv, listText, importListColumn, MAX_LIST_BYTES, MAX_LIST_ITEMS } from '../src/lib/list-compare.ts';
test('all seven views and input/duplicate counts are exact', () => {
  const report = compareLists('a\nb\nc\nc', 'b\nd\ne\ne');
  assert.deepEqual(report.a, { items: 4, unique: 3, repeats: 1 });
  assert.deepEqual(report.b, { items: 4, unique: 3, repeats: 1 });
  assert.deepEqual(report.results, { intersection: ['b'], diffAB: ['a','c'], diffBA: ['d','e'], union: ['a','b','c','d','e'], symmetric: ['a','c','d','e'], duplicatesA: ['c'], duplicatesB: ['e'] });
});
test('legacy defaults remain trimmed, case-sensitive and ordered', () => {
  assert.deepEqual(compareLists(' Apple \n\n002\n2\nApple', 'apple\n2').results.intersection, ['2']);
  assert.deepEqual(compareLists(' Apple \n\n002\n2\nApple', 'apple\n2').results.diffAB, ['Apple','002']);
});
test('case folding changes keys, preserving first spelling', () => {
  const result = compareLists('APPLE\nApple\nCafé', 'apple\nCAFÉ', { ...defaultListOptions, ignoreCase: true });
  assert.deepEqual(result.results.intersection, ['APPLE','Café']); assert.deepEqual(result.results.duplicatesA, ['APPLE']);
});
test('surrounding whitespace is literal when trimming is off; blank lines still ignored', () => {
  const result = compareLists(' a \n\t\n a \n', 'a', { ...defaultListOptions, trim: false });
  assert.deepEqual(result.results.diffAB, [' a ']); assert.deepEqual(result.a, { items: 2, unique: 1, repeats: 1 });
});
test('CRLF, lone CR, UTF-8 BOM and empty input are supported', () => {
  assert.deepEqual(compareLists('\uFEFFa\r\nb\rc\n', 'a\nb').results.diffAB, ['c']);
  assert.deepEqual(compareLists('', '').results.union, []);
  assert.deepEqual(compareLists('a\na', '').results.diffAB, ['a']);
});
test('IDs, literal punctuation, object-like keys and strings are not coerced', () => {
  const values = ['0012','12','9007199254740993','9007199254740994','__proto__','constructor','a*','<script>x</script>','a b','ab'];
  assert.deepEqual(compareLists(values.join('\n'), '').results.union, values);
});
test('natural sort is independent from matching and input mutation', () => {
  const a = 'SKU-10\nSKU-2\nSKU-1';
  assert.deepEqual(compareLists(a, '', { ...defaultListOptions, order: 'ascending' }).results.union, ['SKU-1','SKU-2','SKU-10']);
  assert.deepEqual(compareLists(a, '', { ...defaultListOptions, order: 'descending' }).results.union, ['SKU-10','SKU-2','SKU-1']);
  assert.deepEqual(compareLists(a, '').results.union, ['SKU-10','SKU-2','SKU-1']);
});
test('dedupe can be disabled without converting membership into quantity subtraction', () => {
  const report = compareLists('a\na\nb', 'a\nc\nc', { ...defaultListOptions, dedupe: false });
  assert.deepEqual(report.results.intersection, ['a','a']);
  assert.deepEqual(report.results.diffAB, ['b']); assert.deepEqual(report.results.diffBA, ['c','c']);
  assert.deepEqual(report.results.union, ['a','a','b','a','c','c']);
  assert.deepEqual(report.results.symmetric, ['b','c','c']);
  assert.deepEqual(report.results.duplicatesA, ['a']); assert.deepEqual(report.results.duplicatesB, ['c']);
});
test('optional empty entries, whitespace and terminal newlines round-trip without invented rows', () => {
  const options = { ...defaultListOptions, ignoreBlank: false, dedupe: false };
  assert.deepEqual(compareLists('a\n\n  \n', '\n', options).results.intersection, ['','']);
  assert.equal(compareLists('a\n', '', options).a.items, 1);
  assert.equal(compareLists('\n', '', options).a.items, 1);
  assert.equal(compareLists('', '', options).a.items, 0);
  for (const values of [[''], ['a',''], ['',''], ['a','b']]) assert.deepEqual(compareLists(listText(values), '', options).results.union, values);
  assert.deepEqual(compareLists('  \n', '\n', { ...options, trim: false }).results.diffAB, ['  ']);
});
test('leading-zero matching is optional, digit-only and never rounds IDs', () => {
  const options = { ...defaultListOptions, ignoreZeros: true };
  assert.deepEqual(compareLists('00012\n000\n09007199254740993', '12\n0\n9007199254740993', options).results.intersection, ['00012','000','09007199254740993']);
  assert.deepEqual(compareLists('SKU-0012\n-0012\n0012.0', 'SKU-12\n-12\n12.0', options).results.intersection, []);
});
test('internal-space and Unicode normalization affect matching, not result spelling', () => {
  const options = { ...defaultListOptions, extraSpaces: true, unicodeNfc: true };
  assert.deepEqual(compareLists('Jane  Doe\nCafe\u0301', 'Jane Doe\nCafé', options).results.intersection, ['Jane  Doe','Cafe\u0301']);
  assert.deepEqual(compareLists(' Jane  Doe ', 'Jane Doe', { ...options, trim: false }).results.intersection, []);
  assert.deepEqual(compareLists('Cafe\u0301', 'Café').results.intersection, []);
});
test('CSV/TSV column imports handle headers, BOM, quotes, empty rows and exact IDs', () => {
  const csv = '\uFEFFname,id\r\n"Smith, John",0012\r\n"a""b",0003\r\n';
  assert.equal(importListColumn(csv, ',', 1, true), 'Smith, John\na"b');
  assert.equal(importListColumn(csv, ',', 2, true), '0012\n0003');
  assert.equal(importListColumn('name\tid\na\t0012\nb\t0003\n', '\t', 2, true), '0012\n0003');
  assert.equal(importListColumn('name,id\n\na,0012\n', ',', 2, true), '\n0012');
  assert.equal(importListColumn('name,id\n', ',', 2, true), '');
  assert.equal(importListColumn('""\n', ','), '\n');
  assert.equal(importListColumn('', ','), '');
});
test('invalid CSV/TSV or column choices fail explicitly rather than corrupting items', () => {
  for (const csv of ['"unfinished', '"a"extra,b', 'a"b,c', '"a\nb",c', 'a,b\nc\n']) assert.throws(() => importListColumn(csv, ',', 2), /quoted|quoting|Multiline|column/);
  for (const column of [0, 1.5, 1001, NaN]) assert.throws(() => importListColumn('a,b', ',', column), /column/);
});
test('CSV has BOM/header, proper quote escaping and formula-like cell protection', () => {
  assert.equal(listCsv(['0012','a,b','a"b','=SUM(A1:A2)','+cmd','-3','@value','  =1','ordinary']), '\uFEFFItem\r\n"0012"\r\n"a,b"\r\n"a""b"\r\n"\'=SUM(A1:A2)"\r\n"\'+cmd"\r\n"\'-3"\r\n"\'@value"\r\n"\'  =1"\r\n"ordinary"\r\n');
  assert.equal(listCsv([]), '\uFEFFItem\r\n');
});
test('limits fail explicitly; no partial result', () => {
  assert.throws(() => compareLists('x'.repeat(MAX_LIST_BYTES + 1), ''), /5 MiB/);
  assert.throws(() => compareLists('x\n'.repeat(MAX_LIST_ITEMS + 1), ''), /100,000/);
  const report = compareLists('x\n'.repeat(MAX_LIST_ITEMS), 'x'); assert.equal(report.a.items, MAX_LIST_ITEMS); assert.deepEqual(report.results.intersection, ['x']);
});
test('deterministic generated cases match independent set operations', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const a = Array.from({ length: 80 }, (_, i) => String((i * seed + 3) % 29)), b = Array.from({ length: 60 }, (_, i) => String((i * (seed + 2)) % 31));
    const aa = [...new Set(a)], bb = [...new Set(b)], results = compareLists(a.join('\n'), b.join('\n')).results;
    assert.deepEqual(results.intersection, aa.filter(x => bb.includes(x)));
    assert.deepEqual(results.union, [...new Set([...a, ...b])]);
    assert.deepEqual(results.symmetric, [...aa.filter(x => !bb.includes(x)), ...bb.filter(x => !aa.includes(x))]);
  }
});
