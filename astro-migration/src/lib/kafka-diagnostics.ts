export interface KafkaMember {
  id: string;
  clientId: string;
  host: string;
  assignments: Record<string, number[]>;
}

export interface KafkaPartition {
  partition: number;
  committed: string | null;
  earliest: string;
  latest: string;
  lag: string | null;
  leader: number;
  replicas: number[];
  isr: number[];
  owner: string | null;
}

export interface KafkaGroupSnapshot {
  group: string;
  topic: string;
  state: string;
  sampledAt: number;
  members: KafkaMember[];
  partitions: KafkaPartition[];
}

export interface Finding {
  severity: 'high' | 'medium' | 'info';
  title: string;
  detail: string;
  partitions: number[];
}

function matchesBaseline(member: KafkaMember, patterns: string[]): boolean {
  return patterns.some(pattern => {
    const value = pattern.trim().toLowerCase();
    if (!value) return false;
    const targets = [member.host, member.clientId].map(v => v.toLowerCase());
    if (value.endsWith('*')) return targets.some(target => target.startsWith(value.slice(0, -1)));
    return targets.some(target => target === value || target.includes(value));
  });
}

export function diagnoseKafka(snapshot: KafkaGroupSnapshot, previous?: KafkaGroupSnapshot, expectedMembers = ''): Finding[] {
  const findings: Finding[] = [];
  const patterns = expectedMembers.split(/[\n,]+/).map(v => v.trim()).filter(Boolean);
  if (patterns.length) {
    for (const member of snapshot.members.filter(m => !matchesBaseline(m, patterns))) {
      findings.push({ severity: 'medium', title: 'Unexpected group member', detail: `${member.clientId} from ${member.host} does not match the expected member patterns. Check whether another app reused this group ID.`, partitions: snapshot.partitions.filter(p => p.owner === member.id).map(p => p.partition) });
    }
  }

  const owned = new Map(snapshot.members.map(member => [member.id, snapshot.partitions.filter(p => p.owner === member.id).length]));
  if (owned.size >= 2) {
    const counts = [...owned.values()];
    if (Math.max(...counts) - Math.min(...counts) > 1) {
      findings.push({ severity: 'medium', title: 'Uneven partition assignment', detail: `Members own ${counts.join(', ')} partitions. Check assignment strategy, subscriptions, and recent rebalances.`, partitions: [] });
    }
  }

  const prior = new Map(previous?.partitions.map(p => [p.partition, p]) ?? []);
  const stuck: number[] = [];
  const growing: number[] = [];
  const outOfRange: number[] = [];
  const underReplicated: number[] = [];
  for (const part of snapshot.partitions) {
    const current = part.committed === null ? null : BigInt(part.committed);
    const low = BigInt(part.earliest);
    const high = BigInt(part.latest);
    if (current !== null && (current < low || current > high)) outOfRange.push(part.partition);
    if (part.replicas.length > part.isr.length) underReplicated.push(part.partition);
    const before = prior.get(part.partition);
    if (before && current !== null && before.committed !== null) {
      const previousCommit = BigInt(before.committed);
      const previousHigh = BigInt(before.latest);
      if (current === previousCommit && high > previousHigh && high > current) stuck.push(part.partition);
      else if (high - current > previousHigh - previousCommit && current > previousCommit) growing.push(part.partition);
    }
  }
  if (stuck.length) findings.push({ severity: 'high', title: 'Commit stopped while data arrived', detail: 'These partitions received new offsets, but their committed positions did not move between samples. Inspect the next available record and the one before it; a poison message is one possible cause.', partitions: stuck });
  if (growing.length) findings.push({ severity: 'medium', title: 'Lag is growing', detail: 'The consumer made progress, but incoming offsets grew faster than commits between samples.', partitions: growing });
  if (outOfRange.length) findings.push({ severity: 'high', title: 'Committed offset outside retained range', detail: 'The committed position is before the earliest retained offset or beyond the current end. Review retention and any recent reset.', partitions: outOfRange });
  if (underReplicated.length) findings.push({ severity: 'high', title: 'Under replicated partitions', detail: 'One or more replicas are missing from the in sync replica set. Check broker health and replication.', partitions: underReplicated });
  if (previous && snapshot.state !== previous.state) findings.push({ severity: 'info', title: 'Group state changed', detail: `${previous.state} → ${snapshot.state} between samples. Repeated changes can indicate rebalancing.`, partitions: [] });
  if (!findings.length) findings.push({ severity: 'info', title: 'No clear anomaly in this sample', detail: 'Keep sampling to see whether committed offsets move with new messages. A single snapshot cannot prove a consumer is healthy.', partitions: [] });
  return findings;
}

export function anonymizeSnapshot(snapshot: KafkaGroupSnapshot): KafkaGroupSnapshot {
  const memberNames = new Map(snapshot.members.map((member, i) => [member.id, `Member ${i + 1}`]));
  return {
    ...snapshot,
    group: 'Shared consumer group',
    topic: 'Shared topic',
    members: snapshot.members.map(member => ({ ...member, id: memberNames.get(member.id)!, clientId: memberNames.get(member.id)!, host: 'hidden', assignments: {} })),
    partitions: snapshot.partitions.map(part => ({ ...part, owner: part.owner ? memberNames.get(part.owner) ?? null : null })),
  };
}
