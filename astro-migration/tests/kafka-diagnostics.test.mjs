import assert from 'node:assert/strict';
import test from 'node:test';
import { anonymizeSnapshot, diagnoseKafka } from '../src/lib/kafka-diagnostics.ts';

const current = {
  group: 'checkout-workers', topic: 'orders', state: 'Stable', sampledAt: 2000,
  members: [
    { id: 'a', clientId: 'checkout-a', host: '10.2.0.1', assignments: { orders: [0, 1] } },
    { id: 'b', clientId: 'inventory-b', host: '10.9.0.5', assignments: { orders: [2] } },
  ],
  partitions: [
    { partition: 0, committed: '10', earliest: '0', latest: '12', lag: '2', leader: 1, replicas: [1, 2], isr: [1, 2], owner: 'a' },
    { partition: 1, committed: '30', earliest: '0', latest: '45', lag: '15', leader: 2, replicas: [1, 2], isr: [2], owner: 'a' },
    { partition: 2, committed: '6', earliest: '8', latest: '20', lag: '14', leader: 1, replicas: [1, 2], isr: [1, 2], owner: 'b' },
  ],
};

test('diagnostics distinguish stuck, unexpected member, retention, and replica problems', () => {
  const previous = { ...current, sampledAt: 1000, partitions: current.partitions.map(p => p.partition === 1 ? { ...p, latest: '40', lag: '10' } : p) };
  const findings = diagnoseKafka(current, previous, 'checkout-*');
  assert.ok(findings.some(f => f.title === 'Unexpected group member' && f.partitions.includes(2)));
  assert.ok(findings.some(f => f.title === 'Commit stopped while data arrived' && f.partitions.includes(1)));
  assert.ok(findings.some(f => f.title === 'Committed offset outside retained range' && f.partitions.includes(2)));
  assert.ok(findings.some(f => f.title === 'Under replicated partitions' && f.partitions.includes(1)));
});

test('sharing hides actual group, topic, client IDs, and hosts', () => {
  const shared = anonymizeSnapshot(current);
  const text = JSON.stringify(shared);
  for (const secret of ['checkout-workers', 'orders', 'checkout-a', 'inventory-b', '10.2.0.1', '10.9.0.5']) assert.equal(text.includes(secret), false);
  assert.equal(shared.partitions[2].owner, 'Member 2');
});
