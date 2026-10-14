import { parseAllDocuments, isAlias, isMap, isSeq, isScalar, LineCounter } from 'yaml';
import type { ScalarTag } from 'yaml';
import { exactNumber } from './json-diff.ts';
import { YAML_LIMITS, defaultYamlOptions, YamlDiffError, validateYamlSize } from './yaml-diff-shared.ts';
import type { YamlOptions, YamlValue, YamlChange, YamlResult } from './yaml-diff-shared.ts';
export { YAML_LIMITS, defaultYamlOptions, YamlDiffError, validateYamlSize } from './yaml-diff-shared.ts';
type Tree = { kind: 'map' | 'seq' | 'string' | 'number' | 'boolean' | 'null'; value?: string; yaml?: string; entries?: Map<string, Tree>; items?: Tree[]; offset: number; };
const childPath = (path: string, key: string) => path + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1');
function read(text: string, side: number) {
  validateYamlSize(text);
  if (!text.trim()) throw new YamlDiffError('Paste or open a YAML document on both sides.', side, 0);
  const lines = new LineCounter();
  const docs = parseAllDocuments(text, { version: '1.2', schema: 'core', merge: true, intAsBigInt: true, lineCounter: lines, prettyErrors: false,
    // Stringifying a rounded JS float would rewrite precise decimal tokens. The
    // public tag hook retains validated numeric source spelling instead.
    customTags: tags => tags.map(tag => {
      if (typeof tag === 'string' || tag.tag !== 'tag:yaml.org,2002:float') return tag;
      const float = tag as ScalarTag; // This standard tag is scalar, never a collection.
      return { ...float, stringify: item => item.source ?? String(item.value) } satisfies ScalarTag;
    }),
  });
  if (!docs.length) throw new YamlDiffError('No YAML document found. Comments alone are not a configuration.', side, 0);
  if (docs.length > YAML_LIMITS.documents) throw new YamlDiffError('Compare at most 250 documents per input.', side);
  let count = 0;
  const trees = docs.map(doc => {
    if (doc.errors.length) throw new YamlDiffError(doc.errors[0].message, side, doc.errors[0].pos[0]);
    if (doc.warnings.length) throw new YamlDiffError(doc.warnings[0].message + ' Unsupported tags are not silently compared as strings.', side, doc.warnings[0].pos[0]);
    if (doc.directives?.yaml.version !== '1.2') throw new YamlDiffError('This comparison uses YAML 1.2 core types. Remove a YAML 1.1 directive or convert the document first.', side, doc.range?.[0] ?? 0);
    const ancestors = new Set<unknown>();
    function build(raw: any, depth: number, aliasOffset?: number): Tree {
      const offset = aliasOffset ?? raw?.range?.[0] ?? doc.range?.[0] ?? 0;
      if (++count > YAML_LIMITS.nodes || depth > YAML_LIMITS.depth) throw new YamlDiffError('YAML exceeds the 100-level or 100,000-node limit, including resolved aliases.', side, offset);
      if (isAlias(raw)) {
        const target = raw.resolve(doc);
        if (!target) throw new YamlDiffError('An alias refers to a missing or later anchor.', side, offset);
        return build(target, depth + 1, offset);
      }
      if (ancestors.has(raw)) throw new YamlDiffError('Circular aliases cannot be compared as a finite configuration.', side, offset);
      const allowedTags = ['str', 'int', 'float', 'bool', 'null', 'map', 'seq'].map(tag => 'tag:yaml.org,2002:' + tag);
      if (raw?.tag && !allowedTags.includes(raw.tag)) throw new YamlDiffError('Custom or non-core YAML tags are not supported. Compare rendered configuration instead.', side, offset);
      if (!raw) return { kind: 'null', value: 'null', yaml: 'null', offset };
      ancestors.add(raw);
      try {
        if (isMap(raw)) {
          const entries = new Map<string, Tree>(), explicit: [string, Tree][] = [];
          for (const pair of raw.items) {
            if (isScalar(pair.key) && typeof pair.key.value === 'symbol') {
              const merged = build(pair.value, depth + 1, aliasOffset);
              for (const source of merged.kind === 'seq' ? merged.items! : [merged]) {
                if (source.kind !== 'map') throw new YamlDiffError('A merge key needs a mapping, its alias, or a sequence of mappings.', side, offset);
                for (const [key, value] of source.entries!) if (!entries.has(key)) entries.set(key, value);
              }
            } else {
              if (!isScalar(pair.key) || typeof pair.key.value !== 'string') throw new YamlDiffError('Use string mapping keys. Complex, numeric and boolean keys are not supported by this config comparison.', side, (pair.key as any)?.range?.[0] ?? offset);
              explicit.push([pair.key.value, build(pair.value, depth + 1, aliasOffset)]);
            }
          }
          for (const [key, value] of explicit) entries.set(key, value);
          return { kind: 'map', entries, offset };
        }
        if (isSeq(raw)) return { kind: 'seq', items: raw.items.map(item => build(item, depth + 1, aliasOffset)), offset };
        if (!isScalar(raw)) throw new YamlDiffError('Unsupported YAML node.', side, offset);
        const value = raw.value;
        if (value === null) return { kind: 'null', value: 'null', yaml: 'null', offset };
        if (typeof value === 'string') return { kind: 'string', value, yaml: JSON.stringify(value), offset };
        if (typeof value === 'boolean') return { kind: 'boolean', value: String(value), yaml: String(value), offset };
        if (typeof value === 'number' || typeof value === 'bigint') {
          const source = raw.source ?? String(value);
          const number = typeof value === 'bigint' ? value.toString() : source.replace(/^\+/, '').replace(/^(\-?)\./, '$10.').replace(/\.(?=[eE]|$)/, '.0').replace(/^(-?)0+(?=\d)/, '$1');
          const special = /^[+-]?\.inf$/i.test(source) ? (source.startsWith('-') ? '-.inf' : '.inf') : /^\.nan$/i.test(source) ? '.nan' : null;
          if (!special && !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(number)) throw new YamlDiffError('Unsupported numeric spelling. Use YAML 1.2 decimal, hexadecimal or octal values.', side, offset);
          let canonical: string;
          try { canonical = special ?? exactNumber(number); }
          catch(error) { throw new YamlDiffError((error as Error).message, side, offset); }
          return { kind: 'number', value: canonical, yaml: source, offset };
        }
        throw new YamlDiffError('Unsupported scalar type.', side, offset);
      } finally { ancestors.delete(raw); }
    }
    return build(doc.contents, 0);
  });
  return { docs, trees, lines };
}
function renderValue(node: Tree): string {
  if (node.kind === 'map') return '{' + [...node.entries!].map(([key, value]) => JSON.stringify(key) + ': ' + renderValue(value)).join(', ') + '}';
  if (node.kind === 'seq') return '[' + node.items!.map(renderValue).join(', ') + ']';
  return node.yaml!;
}

export function compareYaml(left: string, right: string, settings: YamlOptions = defaultYamlOptions): YamlResult {
  const options = { ...defaultYamlOptions, ...settings }, input = [read(left, 0), read(right, 1)];
  if (!['position','kubernetes'].includes(options.documents) || !['position','unordered','key'].includes(options.arrays)) throw new YamlDiffError('Choose a supported comparison mode.');
  const arrayKey = options.arrayKey.trim();
  if (options.arrays === 'key' && (!arrayKey || arrayKey.length > 200)) throw new YamlDiffError('Choose a list identity field between 1 and 200 characters.');
  const rules = options.ignoredPaths.split('\n').flatMap(line => line.trim().startsWith('/') ? [line.trim()] : line.split(',').map(value => value.trim())).filter(Boolean);
  if (rules.length > 100 || rules.some(rule => rule.length > 1000)) throw new YamlDiffError('Use at most 100 ignored fields or pointers, each at most 1,000 characters.');
  if (rules.some(rule => rule.startsWith('/') && /~(?![01])/u.test(rule))) throw new YamlDiffError('Use ~0 for a tilde and ~1 for a slash in pointers.');
  if (options.ignoreGenerated) rules.push('/metadata/managedFields', '/metadata/resourceVersion', '/metadata/uid', '/metadata/creationTimestamp', '/status');
  const names = new Set(rules.filter(rule => !rule.startsWith('/'))), pointers = new Set(rules.filter(rule => rule.startsWith('/')));
  const skip = (pointer: string, key?: string) => pointers.has(pointer) || (key !== undefined && names.has(key));
  let ignored = 0, budget = 0, keyedLists = 0;
  const intern = new Map<string, number>(), ids = new WeakMap<Tree, number>(), identity = new WeakMap<Tree, string[]>();
  function signature(node: Tree, pointer: string, side: number): number {
    budget += pointer.length;
    if (budget > 60 * 1024 ** 2 || pointer.length > 10000) throw new YamlDiffError('Comparison metadata is too large. Compare smaller sections.', side, node.offset);
    let key: string;
    if (node.kind === 'map') {
      const entries: [string, number][] = [];
      for (const [name, child] of node.entries!) { const next = childPath(pointer, name); if (skip(next, name)) { ignored++; continue; } entries.push([name, signature(child, next, side)]); }
      entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0); key = 'map:' + JSON.stringify(entries);
    } else if (node.kind === 'seq') {
      const children = node.items!, values = children.map((child, i) => { const next = childPath(pointer, String(i)); if (skip(next)) { ignored++; return 0; } return signature(child, next, side); });
      if (options.arrays === 'key' && children.some(child => child.entries?.has(arrayKey))) {
        const seen = new Set<string>(), keys: string[] = [];
        for (const child of children) {
          const item = child.entries?.get(arrayKey);
          if (!item || !['string','number','boolean'].includes(item.kind)) throw new YamlDiffError(`Every record in list ${pointer || '(root)'} needs a scalar ${JSON.stringify(arrayKey)} field.`, side, child.offset);
          const id = item.kind + ':' + item.value;
          if (seen.has(id)) throw new YamlDiffError(`List ${pointer || '(root)'} has duplicate ${JSON.stringify(arrayKey)} identities.`, side, item.offset);
          seen.add(id); keys.push(id);
        }
        identity.set(node, keys); keyedLists++;
        key = 'keyed:' + JSON.stringify(keys.map((id, i) => [id, values[i]]).sort((a, b) => String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0));
      } else { if (options.arrays === 'unordered') values.sort((a,b) => a-b); key = 'seq:' + values.join(','); }
    } else key = node.kind + ':' + node.value;
    budget += key.length;
    if (budget > 60 * 1024 ** 2) throw new YamlDiffError('Comparison metadata is too large. Compare smaller sections.', side, node.offset);
    let id = intern.get(key); if (id === undefined) { id = intern.size + 1; intern.set(key, id); } ids.set(node, id); return id;
  }
  input.forEach((doc, side) => doc.trees.forEach(tree => signature(tree, '', side)));
  const changes: YamlChange[] = []; let exported = 0;
  function add(type: YamlChange['type'], path: string, a?: Tree, b?: Tree, ai = 0, bi = 0, ap = '', bp = '') {
    if (changes.length >= YAML_LIMITS.changes) throw new YamlDiffError('More than 5,000 changes. Compare a smaller section; no partial report is presented as complete.');
    const value = (node: Tree, side: number, document: number, pointer: string): YamlValue => {
      const yaml = renderValue(node); exported += yaml.length;
      if (exported > YAML_LIMITS.exportChars) throw new YamlDiffError('The complete report exceeds 32 MiB. Compare smaller sections.');
      const position = input[side].lines.linePos(node.offset);
      return { document: document + 1, pointer, offset: node.offset, line: position.line, column: position.col, yaml };
    };
    changes.push({ type, path, ...(a ? { original: value(a, 0, ai, ap) } : {}), ...(b ? { modified: value(b, 1, bi, bp) } : {}) });
  }
  function walk(a: Tree, b: Tree, ai: number, bi: number, label: string, ap: string, bp: string) {
    if (ids.get(a) === ids.get(b)) return;
    const path = label + ' · ' + (bp || ap || '(root)');
    if (a.kind !== b.kind || !['map','seq'].includes(a.kind)) { add('modified', path, a, b, ai, bi, ap, bp); return; }
    if (a.kind === 'map') {
      const aa = a.entries!, bb = b.entries!;
      for (const [key, child] of aa) if (!bb.has(key) && !skip(childPath(ap, key), key)) add('removed', label + ' · ' + childPath(ap, key), child, undefined, ai, bi, childPath(ap, key));
      for (const [key, child] of bb) {
        const next = childPath(bp, key); if (skip(next, key) || skip(childPath(ap, key), key)) continue;
        if (aa.has(key)) walk(aa.get(key)!, child, ai, bi, label, childPath(ap, key), next);
        else add('added', label + ' · ' + next, undefined, child, ai, bi, '', next);
      }
    } else {
      const aa = a.items!, bb = b.items!, ak = identity.get(a), bk = identity.get(b);
      if (options.arrays === 'key' && (ak || bk)) {
        if ((!ak && aa.length) || (!bk && bb.length)) throw new YamlDiffError('A list changes between records and scalar values. Choose positional list matching.');
        const am = new Map((ak ?? []).map((key,i) => [key,i])), bm = new Map((bk ?? []).map((key,i) => [key,i]));
        for (const [key,i] of am) { const j = bm.get(key), next = childPath(ap, String(i)); if (skip(next)) continue; if (j === undefined) add('removed', label + ' · ' + next, aa[i], undefined, ai, bi, next); else if (!skip(childPath(bp, String(j)))) walk(aa[i], bb[j], ai, bi, label, next, childPath(bp, String(j))); }
        for (const [key,j] of bm) if (!am.has(key) && !skip(childPath(bp, String(j)))) add('added', label + ' · ' + childPath(bp, String(j)), undefined, bb[j], ai, bi, '', childPath(bp, String(j)));
      } else if (options.arrays === 'unordered') {
        const buckets = new Map<number, number[]>();
        bb.forEach((child,i) => { if (skip(childPath(bp, String(i)))) return; const id = ids.get(child)!, bucket = buckets.get(id) ?? []; bucket.push(i); buckets.set(id,bucket); });
        aa.forEach((child,i) => { const next = childPath(ap,String(i)); if (skip(next)) return; const bucket = buckets.get(ids.get(child)!); if (bucket?.length) bucket.pop(); else add('removed',label+' · '+next,child,undefined,ai,bi,next); });
        for (const j of [...buckets.values()].flat().sort((a,b)=>a-b)) add('added',label+' · '+childPath(bp,String(j)),undefined,bb[j],ai,bi,'',childPath(bp,String(j)));
      } else {
        for (let i = 0; i < Math.max(aa.length,bb.length); i++) { const apath=childPath(ap,String(i)), bpath=childPath(bp,String(i)); if(skip(apath)||skip(bpath)) continue; if(i>=aa.length) add('added',label+' · '+bpath,undefined,bb[i],ai,bi,'',bpath); else if(i>=bb.length) add('removed',label+' · '+apath,aa[i],undefined,ai,bi,apath); else walk(aa[i],bb[i],ai,bi,label,apath,bpath); }
      }
    }
  }
  const trees = input.map(doc => doc.trees);
  function resourceKeys(side: number) {
    const keys: string[] = [], seen = new Set<string>();
    for (const node of trees[side]) {
      const metadata = node.entries?.get('metadata'), fields = [node.entries?.get('apiVersion'),node.entries?.get('kind'),metadata?.entries?.get('namespace'),metadata?.entries?.get('name')];
      if (![0,1,3].every(i=>fields[i]?.kind==='string' && fields[i]!.value) || (fields[2] && fields[2].kind !== 'string')) throw new YamlDiffError('Kubernetes matching needs apiVersion, kind and metadata.name on every document; namespace must be a string when present.', side, node.offset);
      const key = JSON.stringify(fields.map(field => field?.value ?? ''));
      if (seen.has(key)) throw new YamlDiffError('Two documents have the same Kubernetes resource identity. Remove duplicates or compare by document position.', side, node.offset);
      seen.add(key); keys.push(key);
    }
    return keys;
  }
  if (options.documents === 'kubernetes') {
    const keys = [resourceKeys(0),resourceKeys(1)], rightMap = new Map(keys[1].map((key,i)=>[key,i]));
    const label = (key:string) => {const [api,kind,namespace,name]=JSON.parse(key); return `${kind} ${namespace ? namespace+'/' : ''}${name} (${api})`;};
    keys[0].forEach((key,i)=>{const j=rightMap.get(key); if(j===undefined) add('removed',label(key)+' · (root)',trees[0][i],undefined,i); else walk(trees[0][i],trees[1][j],i,j,label(key),'','');});
    const leftSet=new Set(keys[0]); keys[1].forEach((key,j)=>{if(!leftSet.has(key)) add('added',label(key)+' · (root)',undefined,trees[1][j],0,j);});
  } else {
    for(let i=0;i<Math.max(trees[0].length,trees[1].length);i++) {const label='Document '+(i+1); if(i>=trees[0].length) add('added',label+' · (root)',undefined,trees[1][i],0,i); else if(i>=trees[1].length) add('removed',label+' · (root)',trees[0][i],undefined,i); else walk(trees[0][i],trees[1][i],i,i,label,'','');}
  }
  const report = JSON.stringify({ format:'bugdays-yaml-diff-report/v1', options, documents:[trees[0].length,trees[1].length], ignored, keyedLists, changes },null,2);
  const textReport = 'YAML Diff report\nRules: '+JSON.stringify(options)+'\nDocuments: '+trees[0].length+' original / '+trees[1].length+' modified\n\n'+(changes.length ? changes.map(change=>`${change.type.toUpperCase()} ${change.path}\n${change.original ? 'Original (document '+change.original.document+', line '+change.original.line+'): '+change.original.yaml+'\n' : ''}${change.modified ? 'Modified (document '+change.modified.document+', line '+change.modified.line+'): '+change.modified.yaml+'\n' : ''}`).join('\n') : 'No semantic differences under the selected rules.\n');
  if(report.length>YAML_LIMITS.exportChars || textReport.length>YAML_LIMITS.exportChars) throw new YamlDiffError('The complete report exceeds 32 MiB. Compare smaller sections.');
  return { changes, documents:[trees[0].length,trees[1].length], ignored, keyedLists, report, textReport };
}

export function formatYamlBoth(left: string, right: string): [string,string] {
  return [left,right].map((text,side)=>{
    const parsed=read(text,side), formatted=parsed.docs.map(doc=>doc.toString({indent:2,lineWidth:0})).join('');
    validateYamlSize(formatted);
    if(compareYaml(text,formatted).changes.length) throw new YamlDiffError('Formatting would change resolved values. Inputs were left untouched; compare the original source instead.',side);
    return formatted;
  }) as [string,string];
}
