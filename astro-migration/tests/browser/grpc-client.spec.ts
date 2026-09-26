import { test, expect, type Page } from '@playwright/test';

const proto = `syntax = "proto3";
package demo;
import "google/protobuf/timestamp.proto";
import "google/protobuf/empty.proto";
import "google/api/annotations.proto";
message Req { int32 page_size = 1; google.protobuf.Timestamp start_time = 2; }
service Demo {
  rpc Send(Req) returns (google.protobuf.Empty) { option (google.api.http) = { post: "/v1/send" body: "*" }; }
}`;

test.beforeEach(async ({ page }) => {
  await page.route('https://**/*', (route) => route.abort());
  await page.addInitScript(() => localStorage.setItem('cookie-notice-dismissed', 'true'));
  await page.goto('/grpc-client/');
});

async function paste(page: Page, text: string) {
  await page.locator('summary', { hasText: 'Or paste a definition' }).click();
  await page.locator('#proto-input').fill(text);
  await page.locator('#parse-proto-btn').click();
}

test('a proto importing well-known types parses, with proto3 JSON templates', async ({ page }) => {
  await paste(page, proto);
  await expect(page.locator('#selected-method')).toHaveText('/demo.Demo/Send');
  await expect(page.locator('#proto-warnings')).toBeHidden();
  const template = JSON.parse(await page.locator('#request-json').inputValue());
  expect(template).toEqual({ page_size: 0, start_time: '1970-01-01T00:00:00Z' });
  await expect(page.locator('#request-validation')).toHaveAttribute('data-state', 'valid');
});

test('the request is validated while typing: camelCase is accepted, typos are named', async ({ page }) => {
  await paste(page, proto);
  const status = page.locator('#request-validation');
  await page.locator('#request-json').fill('{"pageSize": 5, "startTime": "2024-01-02T03:04:05Z"}');
  await expect(status).toHaveAttribute('data-state', 'valid');
  await page.locator('#request-json').fill('{"pag_size": 5}');
  await expect(status).toHaveAttribute('data-state', 'invalid');
  await expect(status).toContainText('unknown field "pag_size" in demo.Req. Did you mean "page_size"?');
  await page.locator('#request-json').fill('{"start_time": "yesterday"}');
  await expect(status).toContainText('RFC 3339');
});

test('a missing import is named, and uploading it with the service resolves the contract', async ({ page }) => {
  const settings = 'syntax = "proto3"; package pubsub; enum Encoding { ENCODING_UNSPECIFIED = 0; JSON = 1; } message SchemaSettings { Encoding encoding = 1; }';
  const service = 'syntax = "proto3"; package pubsub; import "google/pubsub/v1/schema.proto"; import "google/protobuf/empty.proto"; service Publisher { rpc Create(SchemaSettings) returns (google.protobuf.Empty); }';
  await paste(page, service);
  await expect(page.locator('#error-box')).toContainText('Add the missing import: google/pubsub/v1/schema.proto');
  await page.locator('#proto-files').setInputFiles([
    { name: 'schema.proto', mimeType: 'text/plain', buffer: Buffer.from(settings) },
    { name: 'pubsub.proto', mimeType: 'text/plain', buffer: Buffer.from(service) },
  ]);
  await expect(page.locator('#selected-method')).toHaveText('/pubsub.Publisher/Create');
  expect(JSON.parse(await page.locator('#request-json').inputValue())).toEqual({ encoding: 'ENCODING_UNSPECIFIED' });
});

test('the grpcurl command carries canonical proto3 JSON', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'clipboard permissions are Chromium-only');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await paste(page, proto);
  await page.locator('#endpoint-url').fill('localhost:50051');
  await page.locator('#request-json').fill('{"pageSize": 3, "start_time": {"seconds": "0", "nanos": 0}}');
  await page.locator('#copy-grpcurl-btn').click();
  const command = await page.evaluate(() => navigator.clipboard.readText());
  expect(command).toContain(`-d '{"page_size":3,"start_time":"1970-01-01T00:00:00Z"}'`);
  expect(command).toContain('demo.Demo/Send');
});
