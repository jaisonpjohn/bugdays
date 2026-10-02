// Build-time, fictional examples. Never include production logs or connection details here.
import LZString from 'lz-string';
import { analyzeTraffic, reportShareSnapshot } from './traffic-analysis.ts';
import { anonymizeSnapshot, diagnoseKafka } from './kafka-diagnostics.ts';
import type { KafkaGroupSnapshot } from './kafka-diagnostics.ts';

function exampleLink(path: string, tool: string, data: object, action?: string): string {
  return `${path}#lz:${LZString.compressToEncodedURIComponent(JSON.stringify({ v: 1, t: tool, ...(action ? { a: action } : {}), d: data }))}`;
}

export const base64ExampleHref = exampleLink('/base64-encoder-decoder/', 'base64', { input: 'SGVsbG8sIGNhZsOpIOKYlQ==' }, 'decode');
export const base64UrlExampleHref = exampleLink('/base64-encoder-decoder/', 'base64', { input: '-_8' }, 'base64url');

export const kafkaBefore: KafkaGroupSnapshot = {
  group: 'checkout-workers', topic: 'orders.events', state: 'Stable', sampledAt: Date.parse('2026-10-01T12:00:00Z'),
  members: [
    { id: 'worker-a', clientId: 'checkout-processor-a', host: '10.4.1.12', assignments: { 'orders.events': [0, 1] } },
    { id: 'worker-b', clientId: 'checkout-processor-b', host: '10.4.1.13', assignments: { 'orders.events': [2] } },
    { id: 'worker-c', clientId: 'inventory-worker', host: '10.8.2.45', assignments: { 'orders.events': [3] } },
  ],
  partitions: [
    { partition: 0, committed: '12800', earliest: '12000', latest: '12804', lag: '4', leader: 1, replicas: [1, 2, 3], isr: [1, 2, 3], owner: 'worker-a' },
    { partition: 1, committed: '17000', earliest: '16000', latest: '17010', lag: '10', leader: 2, replicas: [1, 2, 3], isr: [1, 2, 3], owner: 'worker-a' },
    { partition: 2, committed: '9310', earliest: '9000', latest: '9360', lag: '50', leader: 3, replicas: [1, 2, 3], isr: [1, 2], owner: 'worker-b' },
    { partition: 3, committed: '2000', earliest: '1800', latest: '2048', lag: '48', leader: 1, replicas: [1, 2, 3], isr: [1, 2, 3], owner: 'worker-c' },
  ],
};
export const kafkaAfter: KafkaGroupSnapshot = {
  ...kafkaBefore, sampledAt: kafkaBefore.sampledAt + 60_000,
  partitions: kafkaBefore.partitions.map((p, i) => ({ ...p,
    committed: ['12840', '17100', '9310', '2044'][i],
    latest: ['12844', '17130', '9389', '2092'][i], lag: ['4', '30', '79', '48'][i],
  })),
};
export const kafkaFindings = diagnoseKafka(kafkaAfter, kafkaBefore, 'checkout-processor*, 10.4.*');
export const kafkaExampleHref = exampleLink('/kafka-diagnostics/', 'kafka-diagnostics', {
  v: 1, view: 'diagnostics', report: anonymizeSnapshot(kafkaAfter),
  findings: kafkaFindings.map(({ severity, title, partitions }) => ({ severity, title, partitions })),
});

export const accessLogExample = `192.0.2.10 - - [01/Oct/2026:12:00:00 +0000] "GET /guides/ HTTP/1.1" 200 1200 "-" "ExampleBrowser/1.0"
192.0.2.10 - - [01/Oct/2026:12:00:03 +0000] "GET /json-formatter/ HTTP/1.1" 200 2400 "-" "ExampleBrowser/1.0"
198.51.100.20 - - [01/Oct/2026:12:00:04 +0000] "GET /.env HTTP/1.1" 404 150 "-" "ExampleScanner/1.0"
198.51.100.20 - - [01/Oct/2026:12:00:05 +0000] "GET /wp-login.php HTTP/1.1" 404 150 "-" "ExampleScanner/1.0"
198.51.100.20 - - [01/Oct/2026:12:00:06 +0000] "POST /login HTTP/1.1" 403 180 "-" "ExampleScanner/1.0"
203.0.113.30 - - [01/Oct/2026:12:00:08 +0000] "GET /sitemap-index.xml HTTP/1.1" 200 500 "-" "Googlebot"`;

export async function accessLogExampleReport() {
  const report = await analyzeTraffic(accessLogExample, 'log', { version: 1, fetchedAt: '2026-10-01T12:00:00Z', sources: [], ranges: [], failures: [] });
  report.createdAt = '2026-10-01T12:01:00Z';
  return reportShareSnapshot(report, report.ips, 'Fictional documentation-address example; no provider lookup');
}
export async function accessLogExampleHref() {
  return exampleLink('/access-log-analyzer/', 'access-log-analyzer', { report: await accessLogExampleReport(), title: 'Example log investigation' });
}
