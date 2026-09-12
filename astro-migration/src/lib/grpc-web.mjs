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

const WELL_KNOWN_PROTO_FILES = [
  'google/protobuf/any.proto',
  'google/protobuf/duration.proto',
  'google/protobuf/timestamp.proto',
  'google/protobuf/empty.proto',
  'google/protobuf/struct.proto',
  'google/protobuf/wrappers.proto',
  'google/protobuf/field_mask.proto'
];

export function parseProtoSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error('Add at least one .proto definition');
  }

  const root = new protobuf.Root();
  for (const filename of WELL_KNOWN_PROTO_FILES) {
    const definition = protobuf.common?.[filename];
    if (definition) root.addJSON(definition);
  }

  const warnings = [];
  for (const source of sources) {
    const content = String(source?.content || '').trim();
    if (!content) continue;
    const result = protobuf.parse(content, root, {
      keepCase: true,
      alternateCommentMode: true,
      preferTrailingComment: true
    });
    if (result.imports?.length) {
      const supplied = new Set(sources.map((item) => item.name));
      for (const imported of result.imports) {
        if (!supplied.has(imported) && !WELL_KNOWN_PROTO_FILES.includes(imported)) {
          warnings.push(`Import not supplied: ${imported}`);
        }
      }
    }
  }

  root.resolveAll();
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

export function makeRequestTemplate(type, depth = 0, seen = new Set()) {
  if (!type || depth > 6 || seen.has(type.fullName)) return {};
  const nextSeen = new Set(seen);
  nextSeen.add(type.fullName);
  const value = {};
  const emittedOneofs = new Set();

  for (const field of type.fieldsArray) {
    if (field.partOf) {
      if (emittedOneofs.has(field.partOf.name)) continue;
      emittedOneofs.add(field.partOf.name);
    }
    if (field.map) {
      value[field.name] = {};
    } else if (field.repeated) {
      value[field.name] = [];
    } else {
      value[field.name] = sampleFieldValue(field, depth, nextSeen);
    }
  }
  return value;
}

function sampleFieldValue(field, depth, seen) {
  if (field.resolvedType instanceof protobuf.Enum) {
    return Object.keys(field.resolvedType.values)[0] || 0;
  }
  if (field.resolvedType instanceof protobuf.Type) {
    const name = field.resolvedType.fullName;
    if (name === '.google.protobuf.Timestamp') return { seconds: '0', nanos: 0 };
    if (name === '.google.protobuf.Duration') return { seconds: '0', nanos: 0 };
    if (name === '.google.protobuf.Empty') return {};
    return makeRequestTemplate(field.resolvedType, depth + 1, seen);
  }

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

export function encodeRequest(type, jsonText) {
  if (!type) throw new Error('The selected method has no resolved request type');
  let object;
  try {
    object = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`Request body is not valid JSON: ${error.message}`);
  }

  let message;
  try {
    message = type.fromObject(object);
  } catch (error) {
    throw new Error(`Request does not match ${type.fullName}: ${error.message}`);
  }
  const verificationError = type.verify(message);
  if (verificationError) throw new Error(`Request does not match ${type.fullName}: ${verificationError}`);
  return type.encode(message).finish();
}

export function decodeResponse(type, bytes) {
  if (!type) throw new Error('The selected method has no resolved response type');
  const message = type.decode(bytes);
  return type.toObject(message, {
    longs: String,
    enums: String,
    bytes: String,
    defaults: true,
    arrays: true,
    objects: true,
    oneofs: true,
    json: true
  });
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
