// Proto loading and proto3 JSON mapping for the gRPC client. These cover the inputs people paste
// from docs, grpcurl and other tools, which previously failed or were silently dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProtoSources, encodeRequest, decodeResponse, makeRequestTemplate, canonicalRequestJson } from '../src/lib/grpc-web.mjs';

const proto = `syntax = "proto3";
package demo;
import "google/protobuf/timestamp.proto";
import "google/protobuf/duration.proto";
import "google/protobuf/struct.proto";
import "google/protobuf/wrappers.proto";
import "google/protobuf/field_mask.proto";
import "google/protobuf/any.proto";
import "google/protobuf/empty.proto";
import "google/api/annotations.proto";

enum Color { COLOR_UNSPECIFIED = 0; RED = 1; }
message Item { string sku = 1; int64 quantity = 2; }
message Req {
  int32 page_size = 1;
  google.protobuf.Timestamp start_time = 2;
  google.protobuf.Duration ttl = 3;
  google.protobuf.Struct labels = 4;
  google.protobuf.StringValue nickname = 5;
  google.protobuf.FieldMask update_mask = 6;
  google.protobuf.Value extra = 7;
  Color color = 8;
  bytes blob = 9;
  google.protobuf.Any detail = 10;
  map<string, Item> items = 11;
  repeated Item history = 12;
  oneof target { string email = 13; string phone = 14; }
  double ratio = 15;
  google.protobuf.Int64Value big = 16;
}
service Demo {
  rpc Send(Req) returns (Req) { option (google.api.http) = { post: "/v1/send" body: "*" }; }
  rpc Ping(google.protobuf.Empty) returns (google.protobuf.Timestamp);
}`;

const parsed = parseProtoSources([{ name: 'demo.proto', content: proto }]);
const methods = Object.fromEntries(parsed.services[0].methods.map((method) => [method.name, method]));
const Req = methods.Send.requestType;
const roundTrip = (json) => decodeResponse(Req, encodeRequest(Req, JSON.stringify(json)));

test('well-known types load, and option-only imports need not be supplied', () => {
  assert.deepEqual(parsed.services.map((service) => service.name), ['demo.Demo']);
  assert.deepEqual(parsed.warnings, [], 'google/api/annotations.proto only declares options');
  assert.equal(methods.Ping.requestType.fullName, '.google.protobuf.Empty');
});

test('templates use proto3 JSON forms rather than internal shapes', () => {
  const template = makeRequestTemplate(Req);
  assert.equal(template.start_time, '1970-01-01T00:00:00Z');
  assert.equal(template.ttl, '0s');
  assert.deepEqual(template.labels, {});
  assert.equal(template.nickname, '');
  assert.equal(template.update_mask, '');
  assert.equal(template.extra, null);
  assert.equal(template.detail, null);
  assert.equal(template.big, '0');
  assert.ok('email' in template && !('phone' in template), 'one member per oneof');
  assert.doesNotThrow(() => encodeRequest(Req, JSON.stringify(template)), 'the template itself is a valid request');
  assert.deepEqual(makeRequestTemplate(methods.Ping.requestType), {});
});

test('proto field names and lowerCamelCase JSON names are both accepted', () => {
  assert.equal(roundTrip({ page_size: 10 }).page_size, 10);
  assert.equal(roundTrip({ pageSize: 10 }).page_size, 10);
  assert.equal(roundTrip({ startTime: '2024-01-02T03:04:05Z' }).start_time, '2024-01-02T03:04:05Z');
});

test('unknown fields fail loudly with a suggestion instead of being dropped', () => {
  assert.throws(() => encodeRequest(Req, '{"pag_size": 10}'), /unknown field "pag_size" in demo\.Req\. Did you mean "page_size"\?/);
  assert.throws(() => encodeRequest(Req, '{"history": [{"skuu": "a"}]}'), /\$\.history\[0\]: unknown field "skuu"/);
  assert.throws(() => encodeRequest(Req, '{"color": "PURPLE"}'), /"PURPLE" is not a Color value\. Allowed: COLOR_UNSPECIFIED, RED/);
  assert.throws(() => encodeRequest(Req, '{"email": "a@b.c", "phone": "123"}'), /both in oneof "target"/);
});

test('well-known types round-trip in their proto3 JSON forms', () => {
  const sent = roundTrip({
    start_time: '2024-01-02T03:04:05.123Z',
    ttl: '-1.5s',
    labels: { env: 'prod', n: 3, nested: { ok: true }, list: [1, 'two', null] },
    nickname: 'alice',
    update_mask: 'pageSize,history.sku',
    extra: { any: ['json'] },
    big: '9007199254740993',
  });
  assert.equal(sent.start_time, '2024-01-02T03:04:05.123Z');
  assert.equal(sent.ttl, '-1.500s');
  assert.deepEqual(sent.labels, { env: 'prod', n: 3, nested: { ok: true }, list: [1, 'two', null] });
  assert.equal(sent.nickname, 'alice');
  assert.equal(sent.update_mask, 'pageSize,history.sku');
  assert.deepEqual(sent.extra, { any: ['json'] });
  assert.equal(sent.big, '9007199254740993', '64-bit values keep full precision as strings');
  assert.throws(() => encodeRequest(Req, '{"start_time": "yesterday"}'), /RFC 3339/);
  assert.throws(() => encodeRequest(Req, '{"ttl": "90"}'), /duration such as "1\.5s"/);
});

test('Any packs and unpacks by @type, including well-known payloads', () => {
  assert.deepEqual(roundTrip({ detail: { '@type': 'type.googleapis.com/demo.Item', sku: 'a1', quantity: '2' } }).detail,
    { '@type': 'type.googleapis.com/demo.Item', sku: 'a1', quantity: '2' });
  assert.deepEqual(roundTrip({ detail: { '@type': 'type.googleapis.com/google.protobuf.Duration', value: '3s' } }).detail,
    { '@type': 'type.googleapis.com/google.protobuf.Duration', value: '3s' });
  assert.throws(() => encodeRequest(Req, '{"detail": {"@type": "type.googleapis.com/demo.Missing"}}'), /unknown Any type/);
});

test('maps, repeated messages, bytes and non-finite doubles map correctly', () => {
  const sent = roundTrip({ items: { a: { sku: 'x', quantity: '1' } }, history: [{ sku: 'y' }], blob: 'aGk=', ratio: 'NaN' });
  assert.deepEqual(sent.items, { a: { sku: 'x', quantity: '1' } });
  assert.equal(sent.history[0].sku, 'y');
  assert.equal(sent.blob, 'aGk=');
  assert.equal(sent.ratio, 'NaN');
});

test('requests saved before this change (object forms) still work', () => {
  const legacy = { start_time: { seconds: '1700000000', nanos: 0 }, ttl: { seconds: '5', nanos: 0 }, nickname: { value: 'bob' }, update_mask: { paths: ['page_size'] }, labels: { fields: {} } };
  const sent = roundTrip(legacy);
  assert.equal(sent.start_time, '2023-11-14T22:13:20Z');
  assert.equal(sent.ttl, '5s');
  assert.equal(sent.nickname, 'bob');
  assert.equal(sent.update_mask, 'pageSize');
  assert.deepEqual(sent.labels, {});
});

test('canonical JSON for grpcurl keeps only set fields in proto3 forms', () => {
  const json = canonicalRequestJson(Req, JSON.stringify({ pageSize: 5, start_time: { seconds: '0', nanos: 0 }, nickname: { value: 'z' } }));
  assert.deepEqual(JSON.parse(json), { page_size: 5, start_time: '1970-01-01T00:00:00Z', nickname: 'z' });
});

test('an RPC returning a well-known type renders it directly', () => {
  const Timestamp = methods.Ping.responseType;
  const bytes = Timestamp.encode(Timestamp.fromObject({ seconds: '86400', nanos: 5000000 })).finish();
  assert.equal(decodeResponse(Timestamp, bytes), '1970-01-02T00:00:00.005Z');
});

test('multi-file contracts resolve, and a missing import is named in the error', () => {
  const schema = 'syntax = "proto3"; package pubsub; enum Encoding { ENCODING_UNSPECIFIED = 0; JSON = 1; } message SchemaSettings { Encoding encoding = 1; }';
  const service = 'syntax = "proto3"; package pubsub; import "google/pubsub/v1/schema.proto"; import "google/protobuf/empty.proto"; service Publisher { rpc Create(SchemaSettings) returns (google.protobuf.Empty); }';
  assert.throws(() => parseProtoSources([{ name: 'pubsub.proto', content: service }]),
    /Add the missing import: google\/pubsub\/v1\/schema\.proto/);
  const both = parseProtoSources([{ name: 'schema.proto', content: schema }, { name: 'pubsub.proto', content: service }]);
  assert.equal(both.services[0].methods[0].requestType.fullName, '.pubsub.SchemaSettings');
  assert.deepEqual(both.warnings, [], 'an upload matched by file name counts as supplied');
});

test('syntax errors name the file', () => {
  assert.throws(() => parseProtoSources([{ name: 'broken.proto', content: 'syntax = "proto3"; message {' }]), /^Error: broken\.proto: /);
});
