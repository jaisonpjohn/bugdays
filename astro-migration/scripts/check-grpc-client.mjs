import assert from 'node:assert/strict';
import {
  GrpcWebFrameDecoder,
  buildGrpcUrl,
  decodeResponse,
  encodeRequest,
  frameGrpcMessage,
  grpcStatusLabel,
  grpcTimeoutHeader,
  makeRequestTemplate,
  parseProtoSources,
  parseTrailerFrame,
  redactMetadata,
} from '../src/lib/grpc-web.mjs';

const common = `syntax = "proto3"; package demo; message Echo { string text = 1; int64 sequence = 2; }`;
const service = `syntax = "proto3"; package demo; import "common.proto"; service EchoService { rpc Send(Echo) returns (Echo); rpc Watch(Echo) returns (stream Echo); }`;
const parsed = parseProtoSources([
  { name: 'common.proto', content: common },
  { name: 'service.proto', content: service },
]);

assert.equal(parsed.services.length, 1);
assert.equal(parsed.services[0].methods.length, 2);
assert.equal(parsed.services[0].methods[1].responseStream, true);
assert.deepEqual(makeRequestTemplate(parsed.services[0].methods[0].requestType), { text: '', sequence: '0' });

const method = parsed.services[0].methods[0];
const payload = encodeRequest(method.requestType, '{"text":"hello","sequence":"42"}');
const framed = frameGrpcMessage(payload);
const decoder = new GrpcWebFrameDecoder();
assert.equal(decoder.push(framed.slice(0, 3)).length, 0);
const frames = decoder.push(framed.slice(3));
assert.equal(frames.length, 1);
assert.deepEqual(decodeResponse(method.responseType, frames[0].data), { text: 'hello', sequence: '42' });
decoder.finish();

const trailerText = new TextEncoder().encode('grpc-status: 0\r\ngrpc-message: all%20good\r\n');
assert.deepEqual(parseTrailerFrame(trailerText), { 'grpc-status': '0', 'grpc-message': 'all%20good' });
assert.equal(buildGrpcUrl('localhost:50051', method.path, 'native', 'http://127.0.0.1:2345'), 'http://127.0.0.1:2345/http://localhost:50051/demo.EchoService/Send');
assert.equal(buildGrpcUrl('https://api.example.test/', method.path, 'direct', ''), 'https://api.example.test/demo.EchoService/Send');
assert.equal(grpcTimeoutHeader(30_000), '30000m');
assert.equal(grpcStatusLabel(14), '14 UNAVAILABLE');
assert.deepEqual(redactMetadata({ authorization: 'Bearer secret', traceparent: 'safe' }), { authorization: '••••••••', traceparent: 'safe' });

console.log('gRPC client protocol checks passed.');
