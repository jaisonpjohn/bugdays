import type { KafkaGroupSnapshot } from './kafka-diagnostics.ts';

const BASE = 'http://127.0.0.1:2345/api/v1/kafka';
const TOKEN_KEY = 'bugdays.kafka.session';

export interface KafkaHeader { key: string; valueBase64: string | null }
export interface KafkaRecord {
  topic: string;
  partition: number;
  offset: string;
  timestampMs: number | null;
  keyBase64: string | null;
  valueBase64: string | null;
  headers: KafkaHeader[];
}
export interface KafkaPage {
  records: KafkaRecord[];
  nextOffset: string;
  earliest: string;
  latest: string;
  endExclusive: string;
  hasMore: boolean;
}
export interface KafkaTopic {
  topic: string;
  partitions: Array<{ partition: number; leader: number; replicas: number[]; isr: number[]; earliest: string; latest: string }>;
}
export interface KafkaConnection {
  brokers: string;
  securityProtocol: string;
  saslMechanism?: string;
  username?: string;
  password?: string;
  caPem?: string;
  certificatePem?: string;
  keyPem?: string;
  keyPassword?: string;
}

export function sessionToken(): string { return sessionStorage.getItem(TOKEN_KEY) ?? ''; }
export function saveSessionToken(token: string): void { sessionStorage.setItem(TOKEN_KEY, token); }
export function clearSessionToken(): void { sessionStorage.removeItem(TOKEN_KEY); }

export async function bridgePost<T>(operation: string, body: object, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}/${operation}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      cache: 'no-store', signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error('Cannot reach Holy CORS on this device. Start the local bridge, then retry. Chrome may also ask you to allow access to local services.');
  }
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(payload.error || `Kafka request failed (${response.status}).`);
  return payload as T;
}

export async function bridgeReady(): Promise<boolean> {
  try {
    const response = await fetch('http://127.0.0.1:2345/api/v1/capabilities', { cache: 'no-store', signal: AbortSignal.timeout(2500) });
    if (!response.ok) return false;
    const data = await response.json();
    return data?.capabilities?.kafkaApiVersion === 1;
  } catch { return false; }
}

export const sampleGroup: KafkaGroupSnapshot = {
  group: 'checkout-workers', topic: 'orders.events', state: 'Stable', sampledAt: Date.now(),
  members: [
    { id: 'worker-a', clientId: 'checkout-processor-a', host: '10.4.1.12', assignments: { 'orders.events': [0, 1] } },
    { id: 'worker-b', clientId: 'checkout-processor-b', host: '10.4.1.13', assignments: { 'orders.events': [2] } },
    { id: 'unexpected', clientId: 'inventory-worker', host: '10.8.2.45', assignments: { 'orders.events': [3] } },
  ],
  partitions: [
    { partition: 0, committed: '12840', earliest: '12000', latest: '12844', lag: '4', leader: 1, replicas: [1, 2, 3], isr: [1, 2, 3], owner: 'worker-a' },
    { partition: 1, committed: '17103', earliest: '16000', latest: '17105', lag: '2', leader: 2, replicas: [2, 3, 1], isr: [2, 3, 1], owner: 'worker-a' },
    { partition: 2, committed: '9310', earliest: '9000', latest: '9389', lag: '79', leader: 3, replicas: [3, 1, 2], isr: [3, 1], owner: 'worker-b' },
    { partition: 3, committed: '2044', earliest: '1800', latest: '2092', lag: '48', leader: 1, replicas: [1, 2, 3], isr: [1, 2, 3], owner: 'unexpected' },
  ],
};

export const samplePreviousGroup: KafkaGroupSnapshot = {
  ...sampleGroup, sampledAt: Date.now() - 5000,
  partitions: sampleGroup.partitions.map(p => p.partition === 2 ? { ...p, latest: '9360', lag: '50' } : p.partition === 3 ? { ...p, latest: '2080', lag: '36' } : p),
};

export const sampleRecords: KafkaRecord[] = [
  { topic: 'orders.events', partition: 2, offset: '9309', timestampMs: Date.now() - 30000, keyBase64: btoa('order-1028'), valueBase64: btoa(JSON.stringify({ orderId: 1028, status: 'paid' })), headers: [{ key: 'event-type', valueBase64: btoa('OrderPaid') }] },
  { topic: 'orders.events', partition: 2, offset: '9310', timestampMs: Date.now() - 15000, keyBase64: btoa('order-1029'), valueBase64: btoa(JSON.stringify({ orderId: 1029, status: 'paid', amount: 'invalid-number' })), headers: [{ key: 'event-type', valueBase64: btoa('OrderPaid') }] },
];
