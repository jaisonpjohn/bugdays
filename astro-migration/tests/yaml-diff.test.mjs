import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareYaml, formatYamlBoth, defaultYamlOptions, YAML_LIMITS } from '../src/lib/yaml-diff.ts';
import { yamlExampleLeft, yamlExampleRight, yamlExampleOptions } from '../src/lib/yaml-diff-examples.ts';
const compare = (a,b,options={}) => compareYaml(a,b,{...defaultYamlOptions,...options});
test('key order, comments and equivalent scalar styles do not create changes',()=>{
  assert.equal(compare('a: 1\nb: "hi" # note\n','b: hi\na: 1.0\n').changes.length,0);
  assert.equal(compare('s: |\n  first\n  second\n','s: "first\\nsecond\\n"').changes.length,0);
});
test('addition, removal, null and type changes have exact pointers and source lines',()=>{
  const result=compare('a: 1\nb: null\nc: gone\n','a: "1"\nb: 2\nd: added\n');
  assert.deepEqual(result.changes.map(c=>[c.type,(c.modified??c.original).pointer]),[['removed','/c'],['modified','/a'],['modified','/b'],['added','/d']]);
  assert.equal(result.changes[1].original.line,1); assert.equal(result.changes[1].modified.yaml,'"1"');
  assert.equal(compare('null','{}').changes[0].original.yaml,'null');
});
test('numbers are exact, mathematical and preserve original tokens in exports',()=>{
  for(const [a,b] of [['9007199254740993','9007199254740994'],['0.10000000000000001','0.10000000000000002'],['1e400','2e400']]) assert.equal(compare('x: '+a,'x: '+b).changes.length,1);
  for(const [a,b] of [['1','1.0'],['1e400','10e399'],['+0012','12'],['.5','0.50'],['0xff','255'],['0o10','8'],['-.inf','-.Inf'],['.NaN','.nan']]) assert.equal(compare('x: '+a,'x: '+b).changes.length,0,a);
  const result=compare('x: 9007199254740993','x: 9007199254740994');
  assert.equal(JSON.parse(result.report).changes[0].original.yaml,'9007199254740993');
  assert.equal(compare('x: 1e400','x: .inf').changes.length,1);
});
test('YAML 1.2 booleans and timestamp-looking strings stay correctly typed',()=>{
  assert.equal(compare('a: on\nb: 2026-10-14','a: "on"\nb: "2026-10-14"').changes.length,0);
  assert.equal(compare('a: true','a: "true"').changes.length,1);
});
test('duplicate keys, unsupported tags and non-string keys fail explicitly',()=>{
  for(const yaml of ['a: 1\na: 2','x: !Something hi','1: x','? [a, b]\n: value','x: !!timestamp 2026-10-14','%YAML 1.1\n---\na: yes']) assert.throws(()=>compare(yaml,'a: 1'));
});
test('aliases and merge keys compare resolved values with explicit overrides',()=>{
  assert.equal(compare('base: &base {x: 1, y: 2}\ncopy: {<<: *base, y: 3}','base: {x: 1, y: 2}\ncopy: {x: 1, y: 3}').changes.length,0);
  assert.equal(compare('a: &a {x: 1}\nb: &b {x: 2, y: 3}\nc: {<<: [*a, *b]}','a: {x: 1}\nb: {x: 2, y: 3}\nc: {x: 1, y: 3}').changes.length,0);
  assert.throws(()=>compare('a: &a [*a]','a: []'),/Circular/);
  assert.throws(()=>compare('a: *missing','a: 1'),/anchor/);
  assert.throws(()=>compare('a: {<<: 1}','a: 1'),/merge/);
});
test('multi-document streams compare by position and report added/removed documents',()=>{
  const result=compare('a: 1\n---\nb: 2\n','a: 1\n');
  assert.deepEqual(result.documents,[2,1]); assert.equal(result.changes[0].type,'removed'); assert.equal(result.changes[0].original.document,2);
  assert.equal(compare('---\nnull\n---\n[]','---\n~\n---\n[]').changes.length,0);
});
test('Kubernetes matching pairs reordered resources and reordered containers by name',()=>{
  const result=compareYaml(yamlExampleLeft,yamlExampleRight,yamlExampleOptions);
  assert.equal(result.changes.length,2);
  assert.deepEqual(result.changes.map(c=>c.modified.pointer),['/spec/replicas','/spec/template/spec/containers/1/image']);
  assert.equal(result.changes[1].original.pointer,'/spec/template/spec/containers/0/image');
  assert.equal(result.changes[0].original.document,2); assert.equal(result.changes[0].modified.document,1);
});
test('missing and duplicate Kubernetes identities fail; added/removed resources are whole-document changes',()=>{
  const a='apiVersion: v1\nkind: ConfigMap\nmetadata: {name: a}', b=a.replace('name: a','name: b');
  assert.deepEqual(compare(a,b,{documents:'kubernetes'}).changes.map(c=>c.type),['removed','added']);
  assert.throws(()=>compare(a+'\n---\n'+a,a,{documents:'kubernetes'}),/same Kubernetes/);
  assert.throws(()=>compare('x: 1',a,{documents:'kubernetes'}),/metadata.name/);
});
test('unordered lists remain multisets; keyed lists validate identities and retain original positions',()=>{
  assert.equal(compare('x: [1, 2, 2]','x: [2, 1, 2]',{arrays:'unordered'}).changes.length,0);
  assert.deepEqual(compare('x: [1, 2, 2]','x: [1, 2]',{arrays:'unordered'}).changes.map(c=>c.type),['removed']);
  assert.throws(()=>compare('x: [{name: a}, {name: a}]','x: []',{arrays:'key'}),/duplicate/);
  assert.throws(()=>compare('x: [{name: a}, 1]','x: []',{arrays:'key'}),/scalar/);
  assert.equal(compare('x: [1, 2]','x: [1, 2]',{arrays:'key'}).changes.length,0);
  const a='containers: [{name: web, ports: [{containerPort: 80}]}]', b=a.replace('80','443');
  assert.equal(compare(a,b,{arrays:'key'}).changes.length,1);
  assert.equal(compare(a,b,{arrays:'key'}).keyedLists,2);
});
test('ignored names and escaped pointers are exact, not redaction',()=>{
  assert.equal(compare('a: {timestamp: 1}\nb: {timestamp: 2}','a: {timestamp: 3}\nb: {timestamp: 4}',{ignoredPaths:'timestamp'}).changes.length,0);
  assert.equal(compare('a/b: {"c~d": 1}','a/b: {"c~d": 2}',{ignoredPaths:'/a~1b/c~0d'}).changes.length,0);
  assert.throws(()=>compare('a: 1','a: 2',{ignoredPaths:'/bad~3'}),/~0/);
});
test('parser errors identify the correct side and offset',()=>{
  assert.throws(()=>compare('a: 1','a: [broken'),error=>error.side===1 && Number.isInteger(error.offset));
  assert.throws(()=>compare('', 'a: 1'),/both sides/);
  assert.throws(()=>compare('# comment only','a: 1'),/No YAML/);
});
test('formatting is atomic and preserves comments, anchors, multi-document values and numbers',()=>{
  const left='# note\nbase: &base {x: 9007199254740993}\ncopy: *base\n---\ny: [1, 2]\n', right='x: 0.10000000000000001\n';
  const [a,b]=formatYamlBoth(left,right); assert.equal(compare(left,a).changes.length,0); assert.equal(compare(right,b).changes.length,0);
  assert.ok(a.includes('# note')); assert.ok(a.includes('&base')); assert.ok(b.includes('0.10000000000000001'));
  assert.throws(()=>formatYamlBoth('a: 1','a: [bad'));
});
test('size, document, nesting and change bounds refuse incomplete reports',()=>{
  assert.throws(()=>compare('x'.repeat(YAML_LIMITS.bytes+1),'x'),/5 MiB/);
  assert.throws(()=>compare('x: 1\n---\n'.repeat(251),'x'),/250 documents/);
  assert.throws(()=>compare('['.repeat(102)+'1'+']'.repeat(102),'x'),/100-level/);
  const left=Array.from({length:5001},(_,i)=>'x'+i+': 1').join('\n'), right=left.replaceAll(': 1',': 2');
  assert.throws(()=>compare(left,right),/5,000/);
});
