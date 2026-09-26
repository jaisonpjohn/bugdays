import protobuf from 'protobufjs';

const textDecoder = new TextDecoder();

export const GRPC_STATUS_NAMES = {
  0: 'OK',
  1: 'CANCELLED',
  2: 'UNKNOWN',
  3: 'INVALID_ARGUMENT',
  4: 'DEADLINE_EXCEEDED',
  5: 'NOT_FOUND',
  6: 'ALREADY_EXISTS',
  7: 'PERMISSION_DENIED',
  8: 'RESOURCE_EXHAUSTED',
  9: 'FAILED_PRECONDITION',
  10: 'ABORTED',
  11: 'OUT_OF_RANGE',
  12: 'UNIMPLEMENTED',
  13: 'INTERNAL',
  14: 'UNAVAILABLE',
  15: 'DATA_LOSS',
  16: 'UNAUTHENTICATED'
};

// Well-known types bundled with protobufjs. Each entry is a `{ nested: { google: … } }` envelope,
// so it is the `.nested` part that belongs in the root.
const WELL_KNOWN_PROTO_FILES = Object.keys(protobuf.common || {}).filter((name) => name.endsWith('.proto'));

// Imports that only declare custom options (HTTP annotations, field behavior, validation rules).
// protobufjs parses option usages without their definitions, so these need not be supplied.
const OPTION_ONLY_IMPORTS = [
  /^google\/api\/(annotations|http|client|field_behavior|resource|routing|launch_stage|field_info|visibility)\.proto$/,
  /^google\/protobuf\/descriptor\.proto$/,
  /^(buf\/)?validate\/validate\.proto$/,
  /^gogoproto\/gogo\.proto$/,
  /^protoc-gen-openapiv2\/options\/(annotations|openapiv2)\.proto$/
];

export function parseProtoSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error('Add at least one .proto definition');
  }

  const root = new protobuf.Root();
  for (const filename of WELL_KNOWN_PROTO_FILES) {
    const definition = protobuf.common[filename];
    if (definition?.nested) root.addJSON(definition.nested);
  }

  const supplied = new Set(sources.map((item) => item?.name).filter(Boolean));
  const suppliedBase = new Set([...supplied].map((name) => name.split('/').pop()));
  const missingImports = new Set();
  const warnings = [];
  for (const source of sources) {
    const content = String(source?.content || '').trim();
    if (!content) continue;
    let result;
    try {
      result = protobuf.parse(content, root, {
        keepCase: true,
        alternateCommentMode: true,
        preferTrailingComment: true
      });
    } catch (error) {
      throw new Error(`${source.name || 'definition'}: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const imported of [...(result.imports || []), ...(result.weakImports || [])]) {
      if (supplied.has(imported) || suppliedBase.has(imported.split('/').pop()) || WELL_KNOWN_PROTO_FILES.includes(imported)) continue;
      missingImports.add(imported);
      if (!OPTION_ONLY_IMPORTS.some((pattern) => pattern.test(imported))) warnings.push(`Import not supplied: ${imported}`);
    }
  }

  try {
    root.resolveAll();
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).replace(/ \.(?=[A-Za-z_])/g, ' ');
    const missing = [...missingImports];
    throw new Error(missing.length
      ? `${reason}. Add the missing import${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`
      : `${reason}.`);
  }
  const services = [];
  walkNamespace(root, (item) => {
    if (!(item instanceof protobuf.Service)) return;
    const serviceName = item.fullName.replace(/^\./, '');
    const methods = item.methodsArray.map((method) => ({
      id: `${serviceName}/${method.name}`,
      name: method.name,
      path: `/${serviceName}/${method.name}`,
      serviceName,
      requestStream: Boolean(method.requestStream),
      responseStream: Boolean(method.responseStream),
      requestType: method.resolvedRequestType,
      responseType: method.resolvedResponseType,
      comment: method.comment || ''
    }));
    services.push({ name: serviceName, shortName: item.name, methods });
  });

  services.sort((a, b) => a.name.localeCompare(b.name));
  if (!services.length) throw new Error('No gRPC services were found in this definition');

  return { root, services, warnings: [...new Set(warnings)] };
}

function walkNamespace(namespace, visit) {
  for (const item of namespace.nestedArray || []) {
    visit(item);
    if (item.nestedArray) walkNamespace(item, visit);
  }
}

// ---------------------------------------------------------------------------------------------
// Proto3 JSON mapping (https://protobuf.dev/programming-guides/json/)
//
// Requests accept what people paste from docs, grpcurl or other clients: proto field names or
// lowerCamelCase JSON names, RFC 3339 timestamps, "1.5s" durations, bare wrapper values, plain
// JSON for Struct/Value/ListValue, comma-separated field masks, and `@type` for Any. Unknown
// fields are errors instead of being silently dropped. Responses are rendered the same way.
// ---------------------------------------------------------------------------------------------

const WKT = '.google.protobuf.';
const WRAPPER_TYPES = new Set(['DoubleValue', 'FloatValue', 'Int64Value', 'UInt64Value', 'Int32Value', 'UInt32Value', 'BoolValue', 'StringValue', 'BytesValue'].map((name) => WKT + name));
const INT64_WRAPPERS = new Set([WKT + 'Int64Value', WKT + 'UInt64Value']);
const lowerCamel = (name) => name.replace(/_([a-z0-9])/g, (_, char) => char.toUpperCase());
const snakeCase = (name) => name.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

class JsonShapeError extends Error {}
const shapeError = (path, message) => new JsonShapeError(`${path}: ${message}`);

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

const fieldIndexes = new WeakMap();
function fieldIndex(type) {
  let index = fieldIndexes.get(type);
  if (!index) {
    index = new Map();
    for (const field of type.fieldsArray) {
      index.set(field.name, field);
      index.set(lowerCamel(field.name), field);
      const jsonName = field.options?.json_name;
      if (typeof jsonName === 'string') index.set(jsonName, field);
    }
    fieldIndexes.set(type, index);
  }
  return index;
}

function frac(nanos) {
  const digits = String(Math.abs(nanos)).padStart(9, '0');
  if (digits.endsWith('000000')) return digits.slice(0, 3);
  if (digits.endsWith('000')) return digits.slice(0, 6);
  return digits;
}

function timestampFromJson(value, path) {
  if (isObject(value) && ('seconds' in value || 'nanos' in value)) return value;
  const match = typeof value === 'string'
    && /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?([Zz]|[+-]\d{2}:\d{2})$/.exec(value);
  const millis = match ? Date.parse(`${match[1]}T${match[2]}${match[4].toUpperCase()}`) : NaN;
  if (!match || Number.isNaN(millis)) throw shapeError(path, 'expected an RFC 3339 timestamp such as "2024-01-02T03:04:05Z"');
  return { seconds: String(Math.floor(millis / 1000)), nanos: match[3] ? Number(match[3].padEnd(9, '0')) : 0 };
}

function timestampToJson(value) {
  const seconds = Number(value?.seconds || 0);
  const nanos = Number(value?.nanos || 0);
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return value;
  const base = date.toISOString().slice(0, 19);
  return nanos ? `${base}.${frac(nanos)}Z` : `${base}Z`;
}

function durationFromJson(value, path) {
  if (isObject(value) && ('seconds' in value || 'nanos' in value)) return value;
  const match = typeof value === 'string' && /^(-)?(\d+)(?:\.(\d{1,9}))?s$/.exec(value);
  if (!match) throw shapeError(path, 'expected a duration such as "1.5s" or "-30s"');
  const sign = match[1] ? -1 : 1;
  const nanos = match[3] ? Number(match[3].padEnd(9, '0')) : 0;
  return { seconds: `${match[1] || ''}${match[2]}`, nanos: sign * nanos };
}

function durationToJson(value) {
  const seconds = BigInt(String(value?.seconds || 0));
  const nanos = Number(value?.nanos || 0);
  const negative = seconds < 0n || nanos < 0;
  const whole = (seconds < 0n ? -seconds : seconds).toString();
  return `${negative ? '-' : ''}${whole}${nanos ? `.${frac(nanos)}` : ''}s`;
}

function valueFromJson(value, path) {
  if (value === null) return { nullValue: 'NULL_VALUE' };
  if (typeof value === 'number') return { numberValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (Array.isArray(value)) return { listValue: { values: value.map((item, index) => valueFromJson(item, `${path}[${index}]`)) } };
  if (isObject(value)) return { structValue: structFromJson(value, path) };
  throw shapeError(path, 'expected a JSON value');
}

function structFromJson(value, path) {
  if (!isObject(value)) throw shapeError(path, 'expected a JSON object');
  return { fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, valueFromJson(item, `${path}.${key}`)])) };
}

function valueToJson(value) {
  if (!value || value.nullValue != null) return null;
  if (value.numberValue != null) return value.numberValue;
  if (value.stringValue != null) return value.stringValue;
  if (value.boolValue != null) return value.boolValue;
  if (value.structValue != null) return structToJson(value.structValue);
  if (value.listValue != null) return (value.listValue.values || []).map(valueToJson);
  return null;
}

function structToJson(value) {
  return Object.fromEntries(Object.entries(value?.fields || {}).map(([key, item]) => [key, valueToJson(item)]));
}

function anyType(root, typeUrl, path) {
  const name = String(typeUrl || '').split('/').pop();
  try {
    return root.lookupType(name);
  } catch {
    throw shapeError(path, `unknown Any type "${typeUrl}"; add the .proto that defines ${name || 'it'}`);
  }
}

function base64Bytes(text) {
  const bytes = new Uint8Array(protobuf.util.base64.length(text));
  protobuf.util.base64.decode(text, bytes, 0);
  return bytes;
}

const hasCustomJson = (type) => type.fullName.startsWith(WKT) && type.fullName !== WKT + 'Empty';

/** Convert proto3 JSON into the object shape protobufjs `fromObject` expects. */
function messageFromJson(type, value, path) {
  const name = type.fullName;
  if (name === WKT + 'Timestamp') return timestampFromJson(value, path);
  if (name === WKT + 'Duration') return durationFromJson(value, path);
  if (WRAPPER_TYPES.has(name)) {
    if (isObject(value) && 'value' in value) return value;
    if (typeof value === 'object') throw shapeError(path, `expected a bare value for ${name.slice(1)}`);
    return { value: INT64_WRAPPERS.has(name) ? String(value) : value };
  }
  if (name === WKT + 'FieldMask') {
    if (isObject(value) && Array.isArray(value.paths)) return value;
    if (typeof value !== 'string') throw shapeError(path, 'expected a comma-separated field mask such as "name,address.city"');
    return { paths: value ? value.split(',').map((item) => item.trim().split('.').map(snakeCase).join('.')).filter(Boolean) : [] };
  }
  if (name === WKT + 'Struct') {
    if (isObject(value) && Object.keys(value).length === 1 && isObject(value.fields) && !Object.keys(value.fields).length) return { fields: {} };
    return structFromJson(value, path);
  }
  if (name === WKT + 'Value') return valueFromJson(value, path);
  if (name === WKT + 'ListValue') {
    if (!Array.isArray(value)) throw shapeError(path, 'expected a JSON array');
    return { values: value.map((item, index) => valueFromJson(item, `${path}[${index}]`)) };
  }
  if (name === WKT + 'Any') {
    if (!isObject(value)) throw shapeError(path, 'expected an object with "@type"');
    if (!('@type' in value) && 'type_url' in value) return value;
    const inner = anyType(type.root, value['@type'], path);
    const { ['@type']: typeUrl, ...rest } = value;
    const converted = messageFromJson(inner, hasCustomJson(inner) ? rest.value : rest, `${path}${hasCustomJson(inner) ? '.value' : ''}`);
    return { type_url: typeUrl, value: inner.encode(inner.fromObject(converted)).finish() };
  }

  if (!isObject(value)) throw shapeError(path, `expected a JSON object for ${name.slice(1)}`);
  const index = fieldIndex(type);
  const result = {};
  const oneofs = new Map();
  for (const [key, item] of Object.entries(value)) {
    const field = index.get(key);
    if (!field) {
      const known = type.fieldsArray.map((candidate) => candidate.name);
      const guess = known.map((candidate) => [candidate, Math.min(editDistance(key, candidate), editDistance(key, lowerCamel(candidate)))])
        .filter(([, distance]) => distance <= 2).sort((a, b) => a[1] - b[1])[0]?.[0];
      throw shapeError(path, `unknown field "${key}" in ${name.slice(1)}.${guess ? ` Did you mean "${guess}"?` : ''} Fields: ${known.join(', ') || '(none)'}`);
    }
    if (field.partOf && item !== null) {
      const other = oneofs.get(field.partOf.name);
      if (other) throw shapeError(path, `"${other}" and "${field.name}" are both in oneof "${field.partOf.name}"; set only one`);
      oneofs.set(field.partOf.name, field.name);
    }
    result[field.name] = fieldFromJson(field, item, `${path}.${key}`);
  }
  return result;
}

function enumFromJson(type, value, path) {
  if (typeof value === 'string' && !(value in type.values)) {
    throw shapeError(path, `"${value}" is not a ${type.name} value. Allowed: ${Object.keys(type.values).join(', ')}`);
  }
  return value;
}

function singleFromJson(field, value, path) {
  const type = field.resolvedType;
  if (type instanceof protobuf.Type) return messageFromJson(type, value, path);
  if (type instanceof protobuf.Enum) return enumFromJson(type, value, path);
  return value;
}

function fieldFromJson(field, value, path) {
  if (value === null) return field.resolvedType?.fullName === WKT + 'Value' ? valueFromJson(null, path) : null;
  if (field.map) {
    if (!isObject(value)) throw shapeError(path, 'expected a JSON object for this map');
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, singleFromJson(field, item, `${path}.${key}`)]));
  }
  if (field.repeated) {
    if (!Array.isArray(value)) throw shapeError(path, 'expected a JSON array for this repeated field');
    return value.map((item, index) => singleFromJson(field, item, `${path}[${index}]`));
  }
  return singleFromJson(field, value, path);
}

/** Render a protobufjs plain object (from toObject with json: false) as proto3 JSON. */
function messageToJson(type, value) {
  if (value == null) return null;
  const name = type.fullName;
  if (name === WKT + 'Timestamp') return timestampToJson(value);
  if (name === WKT + 'Duration') return durationToJson(value);
  if (WRAPPER_TYPES.has(name)) return value.value ?? null;
  if (name === WKT + 'FieldMask') return (value.paths || []).map((item) => item.split('.').map(lowerCamel).join('.')).join(',');
  if (name === WKT + 'Struct') return structToJson(value);
  if (name === WKT + 'Value') return valueToJson(value);
  if (name === WKT + 'ListValue') return (value.values || []).map(valueToJson);
  if (name === WKT + 'Any') {
    if (!value.type_url) return null;
    try {
      const inner = anyType(type.root, value.type_url, '$');
      const bytes = typeof value.value === 'string' ? base64Bytes(value.value) : value.value;
      const decoded = messageToJson(inner, inner.toObject(inner.decode(bytes), TO_OBJECT));
      return hasCustomJson(inner) ? { '@type': value.type_url, value: decoded } : { '@type': value.type_url, ...decoded };
    } catch {
      return { '@type': value.type_url, value: value.value };
    }
  }
  const result = {};
  for (const field of type.fieldsArray) {
    if (!(field.name in value)) continue;
    const item = value[field.name];
    const single = (entry) => {
      if (field.resolvedType instanceof protobuf.Type) return messageToJson(field.resolvedType, entry);
      if ((field.type === 'double' || field.type === 'float') && typeof entry === 'number' && !Number.isFinite(entry)) return String(entry);
      return entry;
    };
    if (item == null) result[field.name] = null;
    else if (field.map) result[field.name] = Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, single(entry)]));
    else if (field.repeated) result[field.name] = item.map(single);
    else result[field.name] = single(item);
  }
  return result;
}

const TO_OBJECT = { longs: String, enums: String, bytes: String, defaults: true, arrays: true, objects: true, oneofs: false, json: false };

function templateValue(field, depth, seen) {
  const type = field.resolvedType;
  if (type instanceof protobuf.Enum) return Object.keys(type.values)[0] || 0;
  if (type instanceof protobuf.Type) return makeRequestTemplate(type, depth + 1, seen);
  switch (field.type) {
    case 'bool': return false;
    case 'string': return '';
    case 'bytes': return '';
    case 'int64':
    case 'uint64':
    case 'sint64':
    case 'fixed64':
    case 'sfixed64': return '0';
    default: return 0;
  }
}

export function makeRequestTemplate(type, depth = 0, seen = new Set()) {
  if (!type) return {};
  const name = type.fullName;
  if (name === WKT + 'Timestamp') return '1970-01-01T00:00:00Z';
  if (name === WKT + 'Duration') return '0s';
  if (WRAPPER_TYPES.has(name)) return templateValue(type.fields.value, depth, seen);
  if (name === WKT + 'FieldMask') return '';
  if (name === WKT + 'Struct') return {};
  if (name === WKT + 'Value' || name === WKT + 'Any') return null;
  if (name === WKT + 'ListValue') return [];
  if (depth > 6 || seen.has(name)) return {};
  const nextSeen = new Set(seen);
  nextSeen.add(name);
  const value = {};
  const emittedOneofs = new Set();

  for (const field of type.fieldsArray) {
    if (field.partOf) {
      if (emittedOneofs.has(field.partOf.name)) continue;
      emittedOneofs.add(field.partOf.name);
    }
    if (field.map) value[field.name] = {};
    else if (field.repeated) value[field.name] = [];
    else value[field.name] = templateValue(field, depth, nextSeen);
  }
  return value;
}

function parseRequestJson(type, jsonText) {
  if (!type) throw new Error('The selected method has no resolved request type');
  let object;
  try {
    object = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`Request body is not valid JSON: ${error.message}`);
  }
  try {
    return type.fromObject(messageFromJson(type, object, '$'));
  } catch (error) {
    throw new Error(`Request does not match ${type.fullName.replace(/^\./, '')}: ${error.message}`);
  }
}

export function encodeRequest(type, jsonText) {
  const message = parseRequestJson(type, jsonText);
  const verificationError = type.verify(message);
  if (verificationError) throw new Error(`Request does not match ${type.fullName.replace(/^\./, '')}: ${verificationError}`);
  return type.encode(message).finish();
}

/** Canonical proto3 JSON for a request, e.g. for a grpcurl command. Only set fields are kept. */
export function canonicalRequestJson(type, jsonText) {
  const message = parseRequestJson(type, jsonText);
  return JSON.stringify(messageToJson(type, type.toObject(message, { ...TO_OBJECT, defaults: false, arrays: false, objects: false })));
}

export function decodeResponse(type, bytes) {
  if (!type) throw new Error('The selected method has no resolved response type');
  return messageToJson(type, type.toObject(type.decode(bytes), TO_OBJECT));
}

export function frameGrpcMessage(payload) {
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = 0;
  new DataView(frame.buffer).setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
}

export class GrpcWebFrameDecoder {
  constructor() {
    this.buffer = new Uint8Array(0);
  }

  push(chunk) {
    const next = new Uint8Array(this.buffer.length + chunk.length);
    next.set(this.buffer);
    next.set(chunk, this.buffer.length);
    this.buffer = next;
    const frames = [];

    while (this.buffer.length >= 5) {
      const length = new DataView(
        this.buffer.buffer,
        this.buffer.byteOffset + 1,
        4
      ).getUint32(0, false);
      if (this.buffer.length < 5 + length) break;

      const flag = this.buffer[0];
      const data = this.buffer.slice(5, 5 + length);
      this.buffer = this.buffer.slice(5 + length);
      frames.push({
        trailer: Boolean(flag & 0x80),
        compressed: Boolean(flag & 0x01),
        data
      });
    }
    return frames;
  }

  finish() {
    if (this.buffer.length) {
      throw new Error(`The response ended with ${this.buffer.length} incomplete gRPC frame bytes`);
    }
  }
}

export function parseTrailerFrame(bytes) {
  const headers = {};
  const text = textDecoder.decode(bytes);
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[name] = value;
  }
  return headers;
}

export function normalizeEndpoint(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) throw new Error('Enter a gRPC endpoint');
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(withScheme);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('The endpoint must use http:// or https://');
  }
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function buildGrpcUrl(endpoint, methodPath, transport, bridgeUrl) {
  const target = `${normalizeEndpoint(endpoint)}${methodPath}`;
  if (transport === 'native') {
    return `${normalizeEndpoint(bridgeUrl)}/${target}`;
  }
  return target;
}

export function grpcTimeoutHeader(milliseconds) {
  const value = Number(milliseconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  return `${Math.min(Math.round(value), 99_999_999)}m`;
}

export function grpcStatusLabel(value) {
  const code = Number(value);
  return `${Number.isFinite(code) ? code : value} ${GRPC_STATUS_NAMES[code] || 'UNKNOWN'}`;
}

export function redactMetadata(metadata) {
  const sensitive = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i;
  return Object.fromEntries(
    Object.entries(metadata).map(([name, value]) => [name, sensitive.test(name) ? '••••••••' : value])
  );
}
