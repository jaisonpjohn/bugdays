import Ajv from 'ajv';
import Ajv2019 from 'ajv/dist/2019.js';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parseTree, findNodeAtLocation, printParseErrorCode, type Node, type ParseError } from 'jsonc-parser';
import type { ErrorObject } from 'ajv';

export type Dialect = 'auto' | 'draft7' | '2019-09' | '2020-12';
export type Profile = 'standard' | 'openai';
export interface DoctorInput { schema: string; json: string; dialect: Dialect; profile: Profile; formats: boolean; references: string[] }
export interface Finding {
  source: 'schema' | 'json' | 'profile' | 'reference';
  severity: 'error' | 'warning';
  keyword: string;
  path: string;
  schemaPath?: string;
  message: string;
  hint: string;
  offset?: number;
  line?: number;
  column?: number;
  reference?: number;
}
export interface SchemaEdit { path: string; before: string; after: string; reason: string }
export interface DoctorReport {
  version: 1;
  dialect: string;
  profile: Profile;
  profileRevision?: string;
  formats: boolean;
  schemaValid: boolean;
  dataValid: boolean | null;
  findings: Finding[];
  truncated: boolean;
  edits: SchemaEdit[];
  proposedSchema?: string;
}
export const PROFILE_REVISION = '2026-10-05';
export const PROFILE_SOURCE = 'https://developers.openai.com/api/docs/guides/structured-outputs';
export const MAX_INPUT = 500_000;
export const MAX_TOTAL = 1_000_000;
const MAX_FINDINGS = 200;
const uriByDialect = { draft7: 'http://json-schema.org/draft-07/schema', '2019-09': 'https://json-schema.org/draft/2019-09/schema', '2020-12': 'https://json-schema.org/draft/2020-12/schema' };
const escapePointer = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');
const parts = (pointer: string) => pointer.replace(/^#/, '').split('/').slice(1).map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

function locate(text: string, tree: Node | undefined, pointer: string) {
  let node = tree;
  for (const part of parts(pointer)) {
    if (!node) break;
    const child = findNodeAtLocation(node, [node.type === 'array' ? Number(part) : part]);
    if (!child) break; // Missing property: point to the containing object.
    node = child;
  }
  const offset = node?.offset ?? 0;
  const before = text.slice(0, offset);
  return { offset, line: before.split('\n').length, column: offset - before.lastIndexOf('\n') };
}

// Bound nesting before invoking either a parser or a schema compiler.
function guardText(text: string) {
  if (new TextEncoder().encode(text).length > MAX_INPUT) throw new Error('Each input must be 500 KB or smaller. Use a smaller reproducer.');
  let depth = 0, inString = false, escaped = false;
  for (const char of text) {
    if (inString) { if (!escaped && char === '"') inString = false; escaped = !escaped && char === '\\'; }
    else if (char === '"') { inString = true; escaped = false; }
    else if (char === '{' || char === '[') { if (++depth > 100) throw new Error('Input nesting exceeds 100 levels. Use a smaller reproducer.'); }
    else if (char === '}' || char === ']') depth--;
  }
}

function readJson(text: string, source: Finding['source'], findings: Finding[], reference?: number) {
  guardText(text);
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: false, disallowComments: true, allowEmptyContent: false });
  if (errors.length || !tree) {
    const offset = errors[0]?.offset ?? 0;
    const before = text.slice(0, offset);
    findings.push({ source, reference, severity: 'error', keyword: 'syntax', path: '', message: `Invalid JSON: ${errors[0] ? printParseErrorCode(errors[0].error) : 'value expected'}.`, hint: 'Use double-quoted keys and strings; remove comments and trailing commas.', offset, line: before.split('\n').length, column: offset - before.lastIndexOf('\n') });
    return null;
  }
  let ambiguous = false;
  function walk(node: Node, pointer: string) {
    if (node.type === 'object') {
      const keys = new Set<string>();
      for (const property of node.children ?? []) {
        const [key, child] = property.children!;
        const path = `${pointer}/${escapePointer(key.value)}`;
        if (keys.has(key.value)) {
          ambiguous = true;
          if (findings.length < MAX_FINDINGS) findings.push({ source, reference, severity: 'error', keyword: 'duplicate-key', path, message: 'Duplicate object key makes this document ambiguous.', hint: 'Keep only one occurrence. Different parsers can keep different values.', ...locate(text, tree, path) });
        }
        keys.add(key.value); walk(child, path);
      }
    } else if (node.type === 'array') node.children?.forEach((child, i) => walk(child, `${pointer}/${i}`));
    else if (node.type === 'number' && (!Number.isFinite(node.value) || (Number.isInteger(node.value) && !Number.isSafeInteger(node.value)))) {
      ambiguous = true;
      if (findings.length < MAX_FINDINGS) findings.push({ source, reference, severity: 'error', keyword: 'number-precision', path: pointer, message: 'This number is outside JavaScript’s reliable numeric range.', hint: 'Use a string for long identifiers if your contract permits it, or a validator with arbitrary-precision numbers. This tool will not validate a rounded value.', ...locate(text, tree, pointer) });
    }
  }
  walk(tree, '');
  if (ambiguous) return null;
  return { value: JSON.parse(text), tree };
}

/** Format only unambiguous JSON, without silently deleting duplicate keys or rounding IDs. */
export function formatDoctorJson(text: string): string {
  const findings: Finding[] = [];
  const parsed = readJson(text, 'json', findings);
  if (!parsed) throw new Error(findings[0]?.message ?? 'Invalid JSON.');
  return JSON.stringify(parsed.value, null, 2);
}

function dialectFor(schema: any, selected: Dialect): Exclude<Dialect, 'auto'> {
  const declared = record(schema) ? schema.$schema : undefined;
  const normalized = typeof declared === 'string' ? declared.replace(/#$/, '').replace(/^https:/, 'http:') : undefined;
  const found = Object.entries(uriByDialect).find(([, uri]) => uri.replace(/^https:/, 'http:') === normalized)?.[0] as Exclude<Dialect, 'auto'> | undefined;
  if (declared !== undefined && !found) throw new Error('Unsupported $schema. Choose Draft 7, 2019-09, or 2020-12; custom dialects and Draft 4/6 are not supported.');
  if (found && selected !== 'auto' && found !== selected) throw new Error(`The selected dialect conflicts with $schema (${found}). Use Auto or choose the declared dialect.`);
  return found ?? (selected === 'auto' ? '2020-12' : selected);
}

const maps = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'];
const singles = ['additionalProperties', 'unevaluatedProperties', 'propertyNames', 'contains', 'additionalItems', 'unevaluatedItems', 'not', 'if', 'then', 'else'];
function walkSchema(schema: any, visit: (s: any, path: string) => void, path = '') {
  visit(schema, path);
  if (!record(schema)) return;
  for (const key of maps) if (record(schema[key])) for (const [name, value] of Object.entries(schema[key])) walkSchema(value, visit, `${path}/${key}/${escapePointer(name)}`);
  for (const key of singles) if (own(schema, key)) walkSchema(schema[key], visit, `${path}/${key}`);
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) if (Array.isArray(schema[key])) schema[key].forEach((s: any, i: number) => walkSchema(s, visit, `${path}/${key}/${i}`));
  if (Array.isArray(schema.items)) schema.items.forEach((s: any, i: number) => walkSchema(s, visit, `${path}/items/${i}`));
  else if (own(schema, 'items')) walkSchema(schema.items, visit, `${path}/items`);
  if (record(schema.dependencies)) for (const [name, value] of Object.entries(schema.dependencies)) if (!Array.isArray(value)) walkSchema(value, visit, `${path}/dependencies/${escapePointer(name)}`);
}

function errorFinding(error: ErrorObject, source: 'schema' | 'json', text: string, tree?: Node): Finding {
  let path = error.instancePath;
  const p = error.params;
  let message = error.message ?? 'Validation failed.';
  let hint = 'Check the value against the rule at the schema pointer.';
  if (error.keyword === 'required') { path += '/' + escapePointer(p.missingProperty); message = `Missing required property ${JSON.stringify(p.missingProperty)}.`; hint = 'Add this property to its containing object, or revise required if the API contract allows it to be absent.'; }
  if (error.keyword === 'additionalProperties') { path += '/' + escapePointer(p.additionalProperty); message = 'This extra property is not allowed.'; hint = 'Check for a misspelled key. Remove it or explicitly declare it in the schema.'; }
  if (error.keyword === 'type') { message = `Expected ${p.type}.`; hint = 'A quoted number is a string; null is not a missing property. Values are never coerced by this tool.'; }
  if (error.keyword === 'enum') { message = 'Value is not one of the allowed enum choices.'; hint = 'Compare the value, type, and letter case with enum in the schema.'; }
  if (error.keyword === 'oneOf') { message = p.passingSchemas?.length ? `Matches ${p.passingSchemas.length} branches; oneOf requires exactly one.` : 'Matches none of the oneOf branches.'; hint = 'Inspect the branch errors at the same data path. Overlapping branches can fail even when each looks valid.'; }
  if (error.keyword === 'anyOf') { message = 'Matches none of the anyOf branches.'; hint = 'At least one branch must fully match. The other findings show the failing branch rules.'; }
  return { source, severity: 'error', keyword: error.keyword, path, schemaPath: error.schemaPath, message, hint, ...locate(text, tree, path) };
}

// Deliberately a dated, limited lint profile, NOT a claim of API acceptance.
// Source: PROFILE_SOURCE. Fine-tuned/model-specific behavior is outside this profile.
function profileChecks(schema: any, add: (finding: Finding) => void) {
  const issue = (path: string, keyword: string, message: string, hint: string, severity: 'error' | 'warning' = 'error') => add({ source: 'profile', severity, path, keyword, message, hint });
  if (!record(schema) || schema.type !== 'object' || own(schema, 'anyOf')) issue('', 'root', 'Structured output needs an object root without a top-level anyOf.', 'Use a named object property for the union; review the changed response shape.');
  const unsupported = new Set(['allOf', 'not', 'dependentRequired', 'dependentSchemas', 'if', 'then', 'else']);
  const reviewed = new Set(['$schema', '$id', '$ref', '$defs', 'definitions', 'title', 'description', 'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf', 'pattern', 'format', 'multipleOf', 'maximum', 'exclusiveMaximum', 'minimum', 'exclusiveMinimum', 'minItems', 'maxItems']);
  const formats = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'ipv4', 'ipv6', 'uuid']);
  let properties = 0, enumCount = 0, strings = 0;
  walkSchema(schema, (s, path) => {
    if (!record(s)) {
      if (!(s === false && path.endsWith('/additionalProperties'))) issue(path, 'boolean-schema', 'Boolean schemas are outside this profile’s reviewed subset.', 'Use an explicit type/schema and check your target model.', 'warning');
      return;
    }
    for (const keyword of Object.keys(s)) {
      if (unsupported.has(keyword)) issue(`${path}/${keyword}`, keyword, `${keyword} is not supported in the documented strict-output subset.`, 'Redesign this rule; simply deleting a constraint changes your contract.');
      else if (!reviewed.has(keyword)) issue(`${path}/${keyword}`, keyword, `${keyword} is not covered by this compatibility profile.`, 'Check support for your exact model and endpoint; no API request is made.', 'warning');
    }
    const isObject = s.type === 'object' || (Array.isArray(s.type) && s.type.includes('object')) || record(s.properties);
    if (isObject) {
      const names = record(s.properties) ? Object.keys(s.properties) : [];
      properties += names.length; strings += names.join('').length;
      if (s.additionalProperties !== false) issue(`${path}/additionalProperties`, 'additionalProperties', 'Set additionalProperties to false for this object.', 'This disallows undeclared keys. Review the proposed edit before applying it.');
      const missing = names.filter(name => !Array.isArray(s.required) || !s.required.includes(name));
      if (missing.length) issue(`${path}/required`, 'required', `${missing.length} declared field${missing.length === 1 ? ' is' : 's are'} not required.`, 'Strict output requires every declared field. If absence means “no value”, design an explicit nullable field rather than silently changing the contract.');
    }
    if (typeof s.format === 'string' && !formats.has(s.format)) issue(`${path}/format`, 'format', 'This format is outside the documented supported format list.', 'Keep application-side validation or choose a documented format.', 'warning');
    if (typeof s.$ref === 'string' && !s.$ref.startsWith('#')) issue(`${path}/$ref`, '$ref', 'External references need review before sending a schema to the API.', 'Local reference files validate here, but this tool does not bundle them for the provider.', 'warning');
    if (record(s.$defs)) strings += Object.keys(s.$defs).join('').length;
    if (record(s.definitions)) strings += Object.keys(s.definitions).join('').length;
    if (typeof s.const === 'string') strings += s.const.length;
    if (Array.isArray(s.enum)) {
      enumCount += s.enum.length;
      const length = s.enum.reduce((n: number, v: unknown) => n + (typeof v === 'string' ? v.length : 0), 0);
      strings += length;
      if (s.enum.length > 250 && length > 15000) issue(`${path}/enum`, 'enum-size', 'Large enum exceeds the documented string-size limit.', 'Reduce choices or split the task.');
    }
  });
  if (properties > 5000) issue('', 'property-limit', 'More than 5,000 object properties.', 'Reduce the schema size.');
  if (enumCount > 1000) issue('', 'enum-limit', 'More than 1,000 enum values in the schema.', 'Reduce the enum choices.');
  if (strings > 120000) issue('', 'string-limit', 'Property, definition, enum, and const strings exceed 120,000 characters.', 'Shorten names or reduce choices.');
}

function propose(schema: any): { edits: SchemaEdit[]; proposedSchema?: string } {
  const copy = structuredClone(schema), edits: SchemaEdit[] = [];
  walkSchema(copy, (s, path) => {
    if (!record(s) || !(s.type === 'object' || (Array.isArray(s.type) && s.type.includes('object')) || record(s.properties))) return;
    if (s.additionalProperties !== false) {
      edits.push({ path: `${path}/additionalProperties`, before: own(s, 'additionalProperties') ? JSON.stringify(s.additionalProperties) : '(absent)', after: 'false', reason: 'Disallow undeclared keys; this tightens the contract.' }); s.additionalProperties = false;
    }
    const names = record(s.properties) ? Object.keys(s.properties) : [];
    const required = Array.isArray(s.required) ? s.required : [];
    const missing = names.filter(name => !required.includes(name));
    if (missing.length) {
      const next = [...required, ...missing];
      edits.push({ path: `${path}/required`, before: own(s, 'required') ? JSON.stringify(s.required) : '(absent)', after: JSON.stringify(next), reason: 'Previously optional fields become required. Review null handling yourself.' }); s.required = next;
    }
  });
  return { edits, ...(edits.length ? { proposedSchema: JSON.stringify(copy, null, 2) } : {}) };
}

export function diagnoseSchema(input: DoctorInput): DoctorReport {
  const report: DoctorReport = { version: 1, dialect: '', profile: input.profile === 'openai' ? 'openai' : 'standard', formats: input.formats === true, schemaValid: false, dataValid: null, findings: [], truncated: false, edits: [] };
  const add = (f: Finding) => { if (report.findings.length < MAX_FINDINGS) report.findings.push(f); else report.truncated = true; };
  try {
    if (!Array.isArray(input.references) || input.references.length > 12) throw new Error('Use no more than 12 local reference files.');
    if (![input.schema, input.json, ...input.references].every(s => typeof s === 'string')) throw new Error('Input must be JSON text.');
    for (const source of [input.schema, input.json, ...input.references]) guardText(source);
    if (new TextEncoder().encode([input.schema, input.json, ...input.references].join('')).length > MAX_TOTAL) throw new Error('The combined inputs must be 1 MB or smaller.');
    if (!['auto', 'draft7', '2019-09', '2020-12'].includes(input.dialect)) throw new Error('Choose a supported schema dialect.');
    const parsed = readJson(input.schema, 'schema', report.findings);
    if (!parsed) return report;
    const schema = parsed.value;
    if (typeof schema !== 'boolean' && !record(schema)) throw new Error('A JSON Schema must be an object or a boolean, not an array, string, number, or null.');
    report.dialect = dialectFor(schema, input.dialect);
    const Constructor = report.dialect === 'draft7' ? Ajv : report.dialect === '2019-09' ? Ajv2019 : Ajv2020;
    const ajv = new Constructor({ allErrors: true, strict: false, strictSchema: 'log', validateFormats: report.formats, ownProperties: true, inlineRefs: false, loopRequired: 50, loopEnum: 50, logger: { log() {}, error() {}, warn(message: string) { add({ source: 'schema', severity: 'warning', keyword: 'lint', path: '', message: String(message), hint: 'An ignored or ambiguous rule may not constrain the data as intended.' }); } } });
    addFormats(ajv);
    // Accept the standard HTTP/HTTPS URI spellings without making any fetches.
    const canonical = uriByDialect[report.dialect as keyof typeof uriByDialect];
    const alias = canonical.startsWith('http:') ? canonical.replace('http:', 'https:') : canonical.replace('https:', 'http:');
    ajv.addMetaSchema({ $id: alias, $ref: canonical });
    for (let i = 0; i < input.references.length; i++) {
      const ref = readJson(input.references[i], 'reference', report.findings, i);
      if (!ref) return report;
      if (!record(ref.value) || typeof ref.value.$id !== 'string' || !/^[a-z][a-z0-9+.-]*:/i.test(ref.value.$id) || ref.value.$id.includes('#')) throw new Error(`Reference ${i + 1} needs an absolute $id without a fragment, matching its $ref URI.`);
      dialectFor(ref.value, report.dialect as Dialect);
      ajv.addSchema(ref.value);
    }
    if (!ajv.validateSchema(schema)) {
      (ajv.errors ?? []).forEach(e => add(errorFinding(e, 'schema', input.schema, parsed.tree)));
      return report;
    }
    let asyncSchema = false;
    for (const source of [schema, ...input.references.map(s => JSON.parse(s))]) walkSchema(source, s => { if (record(s) && own(s, '$async')) asyncSchema = true; });
    if (asyncSchema) throw new Error('$async is an Ajv extension, not supported here. Validation is synchronous and local.');
    let hasNullableExtension = false;
    for (const source of [schema, ...input.references.map(s => JSON.parse(s))]) walkSchema(source, s => { if (record(s) && own(s, 'nullable')) hasNullableExtension = true; });
    if (hasNullableExtension) throw new Error('nullable is an OpenAPI extension, not a JSON Schema type rule. Express null explicitly in type or a union schema.');
    const validate = ajv.compile(schema);
    report.schemaValid = true;
    if (report.profile === 'openai') {
      report.profileRevision = PROFILE_REVISION;
      profileChecks(schema, f => add({ ...f, ...locate(input.schema, parsed.tree, f.path) }));
      if (input.references.length) add({ source: 'profile', severity: 'warning', keyword: 'references', path: '', message: 'Provider checks cover the root document, not attached reference files.', hint: 'Bundle references and validate the final schema with the target API.' });
      Object.assign(report, propose(schema));
    }
    if (input.json.trim()) {
      const data = readJson(input.json, 'json', report.findings);
      if (!data) { report.dataValid = false; return report; }
      report.dataValid = Boolean(validate(data.value));
      (validate.errors ?? []).forEach(e => add(errorFinding(e, 'json', input.json, data.tree)));
    }
  } catch (error) {
    const missing = record(error) && typeof error.missingRef === 'string';
    add({ source: 'schema', severity: 'error', keyword: missing ? '$ref' : 'check', path: '', message: error instanceof Error ? error.message.slice(0, 1500) : 'Schema could not be checked.', hint: missing ? 'Add the referenced schema as a local file with its matching absolute $id. URLs are never fetched.' : 'Review the dialect, schema keywords, references, and input size.' });
  }
  return report;
}

export function exportDoctorReport(report: DoctorReport): string {
  const { proposedSchema, edits, ...findingsOnly } = report;
  return JSON.stringify({ ...findingsOnly, note: 'Includes rule names, paths and diagnostic text; excludes original documents and proposed schema. Review before distributing.' }, null, 2);
}
