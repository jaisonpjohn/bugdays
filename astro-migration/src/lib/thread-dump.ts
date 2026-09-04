export type JavaThreadState = 'RUNNABLE' | 'BLOCKED' | 'WAITING' | 'TIMED_WAITING' | 'NEW' | 'TERMINATED' | 'UNKNOWN';
export type ThreadCategory = 'Application' | 'Web / HTTP' | 'Database' | 'Messaging' | 'Scheduler' | 'JVM / GC' | 'Virtual thread';

export interface StackFrame {
  raw: string;
  className: string;
  methodName: string;
  location: string;
  nativeMethod: boolean;
}

export interface ThreadLock {
  id: string;
  className?: string;
  kind: 'held' | 'waiting-to-lock' | 'waiting-on' | 'parking';
  frameIndex?: number;
  ownerJavaId?: string;
}

export interface JavaThread {
  id: string;
  javaId?: string;
  name: string;
  state: JavaThreadState;
  stateDetail?: string;
  daemon: boolean;
  virtual: boolean;
  priority?: number;
  osPriority?: number;
  tid?: string;
  nid?: string;
  cpuMs?: number;
  elapsedSeconds?: number;
  category: ThreadCategory;
  container?: string;
  stack: StackFrame[];
  topFrame: string;
  locks: ThreadLock[];
  locksHeld: string[];
  waitingOn?: string;
  waitingKind?: ThreadLock['kind'];
  waitingOwnerJavaId?: string;
  raw: string;
}

export interface LockContention {
  id: string;
  className?: string;
  ownerThreadIds: string[];
  waiterThreadIds: string[];
}

export interface DeadlockCycle {
  threadIds: string[];
  lockIds: string[];
  explicit: boolean;
}

export interface ThreadStackGroup {
  id: string;
  state: JavaThreadState;
  category: ThreadCategory;
  title: string;
  count: number;
  threadIds: string[];
  stack: StackFrame[];
}

export interface HotFrame {
  frame: string;
  count: number;
  threadIds: string[];
}

export interface AnalysisFinding {
  severity: 'critical' | 'warning' | 'info' | 'good';
  title: string;
  detail: string;
  threadIds?: string[];
}

export interface ThreadDumpSnapshot {
  id: string;
  index: number;
  timestamp?: string;
  runtimeVersion?: string;
  processId?: string;
  format: 'hotspot-text' | 'jdk-json';
  formatLabel: string;
  threads: JavaThread[];
  stateCounts: Record<JavaThreadState, number>;
  categoryCounts: Record<ThreadCategory, number>;
  locks: LockContention[];
  deadlocks: DeadlockCycle[];
  groups: ThreadStackGroup[];
  hotFrames: HotFrame[];
  findings: AnalysisFinding[];
  warnings: string[];
  raw: string;
}

export interface ThreadDumpAnalysis {
  snapshots: ThreadDumpSnapshot[];
  totalCharacters: number;
  formatLabel: string;
}

const MAX_INPUT_CHARACTERS = 20 * 1024 * 1024;
const MAX_THREADS = 50_000;
const MAX_FRAMES_PER_THREAD = 500;
const STATES: JavaThreadState[] = ['RUNNABLE', 'BLOCKED', 'WAITING', 'TIMED_WAITING', 'NEW', 'TERMINATED', 'UNKNOWN'];
const CATEGORIES: ThreadCategory[] = ['Application', 'Web / HTTP', 'Database', 'Messaging', 'Scheduler', 'JVM / GC', 'Virtual thread'];

function stripControlSequences(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '');
}

function normalizeState(value?: string): JavaThreadState {
  const normalized = (value || '').trim().toUpperCase().replace(/[ -]+/g, '_');
  if (STATES.includes(normalized as JavaThreadState)) return normalized as JavaThreadState;
  if (/RUNNABLE/.test(normalized)) return 'RUNNABLE';
  if (/BLOCKED|MONITOR_ENTRY/.test(normalized)) return 'BLOCKED';
  if (/TIMED|SLEEP/.test(normalized)) return 'TIMED_WAITING';
  if (/WAIT|PARK/.test(normalized)) return 'WAITING';
  return 'UNKNOWN';
}

function stateFromHeader(tail: string): JavaThreadState {
  if (/waiting for monitor entry|blocked/i.test(tail)) return 'BLOCKED';
  if (/timed_waiting|sleeping/i.test(tail)) return 'TIMED_WAITING';
  if (/waiting on condition|in Object\.wait|parked|\bwaiting\b/i.test(tail)) return 'WAITING';
  if (/\brunnable\b/i.test(tail)) return 'RUNNABLE';
  return 'UNKNOWN';
}

function parseFrame(value: string): StackFrame {
  const raw = value.trim().replace(/^at\s+/, '');
  const match = /^(.*?)\.([^.(]+)\((.*)\)$/.exec(raw);
  if (!match) return { raw, className: '', methodName: raw, location: '', nativeMethod: false };
  return {
    raw,
    className: match[1],
    methodName: match[2],
    location: match[3],
    nativeMethod: /Native Method/i.test(match[3]),
  };
}

function normalizeLockId(value: string): string {
  return value.trim().replace(/^0x/i, '').toLowerCase();
}

function lockFromLine(line: string, frameIndex: number): ThreadLock | null {
  const trimmed = line.trim();
  let kind: ThreadLock['kind'] | null = null;
  if (/^- locked\s+</.test(trimmed)) kind = 'held';
  else if (/^- waiting to lock\s+</.test(trimmed)) kind = 'waiting-to-lock';
  else if (/^- waiting on\s+</.test(trimmed)) kind = 'waiting-on';
  else if (/^- parking to wait for\s+</.test(trimmed)) kind = 'parking';
  else if (/^- <(?!None>)/.test(trimmed)) kind = 'held';
  if (!kind) return null;
  const idMatch = /<([^>]+)>/.exec(trimmed);
  if (!idMatch) return null;
  const classMatch = /\((?:a|an)\s+([^)]+)\)/i.exec(trimmed);
  const ownerMatch = /,\s*owner\s+#(\d+)/i.exec(trimmed);
  return {
    id: normalizeLockId(idMatch[1]),
    className: classMatch?.[1] || (/^[\w.$]+@[0-9a-f]+$/i.test(idMatch[1]) ? idMatch[1].split('@')[0] : undefined),
    kind,
    frameIndex,
    ownerJavaId: ownerMatch?.[1],
  };
}

function parseMetric(tail: string, name: string, unit: 'ms' | 's'): number | undefined {
  const match = new RegExp(`(?:^|\\s)${name}=([0-9.]+)(ms|s)?`, 'i').exec(tail);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  if (unit === 'ms') return match[2]?.toLowerCase() === 's' ? value * 1000 : value;
  return match[2]?.toLowerCase() === 'ms' ? value / 1000 : value;
}

function categorizeThread(name: string, topFrame: string, virtual: boolean): ThreadCategory {
  const value = `${name} ${topFrame}`.toLowerCase();
  if (virtual) return 'Virtual thread';
  if (/reference handler|finalizer|signal dispatcher|notification thread|common-cleaner|gc thread|g1 |shenandoah|zgc|vm thread|vm periodic|compilerthread|sweeper thread|service thread|attach listener|destroyjavavm|jdk\.internal\.ref|java\.lang\.ref\./.test(value)) return 'JVM / GC';
  if (/http|https|tomcat|jetty|undertow|netty|nio-\d+-exec|servlet|webcontainer|reactor-http/.test(value)) return 'Web / HTTP';
  if (/hikari|jdbc|r2dbc|mongo|redis|lettuce|cassandra|database|dbcp|agroal|sql/.test(value)) return 'Database';
  if (/kafka|rabbit|amqp|jms|activemq|pulsar|message|consumer|producer/.test(value)) return 'Messaging';
  if (/sched|timer|quartz|cron|housekeeper|delayqueue|periodic/.test(value)) return 'Scheduler';
  return 'Application';
}

function parseTraditionalHeader(line: string, index: number): Omit<JavaThread, 'stack' | 'topFrame' | 'locks' | 'locksHeld' | 'category' | 'raw'> | null {
  const modern = /^#(\d+)\s+"((?:\\.|[^"])*)"\s+(virtual\s+)?([A-Z_]+)(?:\s+(.*))?$/.exec(line.trim());
  if (modern) {
    return {
      id: `thread-${index + 1}`,
      javaId: modern[1],
      name: modern[2].replace(/\\"/g, '"'),
      state: normalizeState(modern[4]),
      stateDetail: modern[5],
      daemon: false,
      virtual: Boolean(modern[3]),
    };
  }

  const match = /^"((?:\\.|[^"])*)"\s+(.*)$/.exec(line.trim());
  if (!match || /^:\s*$/.test(match[2])) return null;
  const tail = match[2];
  if (!/(?:^|\s)(?:#\d+|prio=|tid=|nid=|daemon\b|virtual\b|RUNNABLE\b|WAITING\b|BLOCKED\b)/i.test(tail)) return null;
  const javaId = /(?:^|\s)#(\d+)/.exec(tail)?.[1];
  const priority = /(?:^|\s)prio=(\d+)/i.exec(tail)?.[1];
  const osPriority = /(?:^|\s)os_prio=(-?\d+)/i.exec(tail)?.[1];
  return {
    id: `thread-${index + 1}`,
    javaId,
    name: match[1].replace(/\\"/g, '"'),
    state: stateFromHeader(tail),
    stateDetail: tail.replace(/\s+/g, ' ').trim(),
    daemon: /(?:^|\s)daemon(?:\s|$)/i.test(tail),
    virtual: /(?:^|\s)virtual(?:\s|$)/i.test(tail),
    priority: priority === undefined ? undefined : Number(priority),
    osPriority: osPriority === undefined ? undefined : Number(osPriority),
    tid: /(?:^|\s)tid=([^\s]+)/i.exec(tail)?.[1],
    nid: /(?:^|\s)nid=([^\s]+)/i.exec(tail)?.[1],
    cpuMs: parseMetric(tail, 'cpu', 'ms'),
    elapsedSeconds: parseMetric(tail, 'elapsed', 's'),
  };
}

function parseTextThreads(raw: string): { threads: JavaThread[]; warnings: string[] } {
  const lines = raw.split('\n');
  const starts: Array<{ line: number; base: ReturnType<typeof parseTraditionalHeader> }> = [];
  for (let index = 0; index < lines.length; index++) {
    const base = parseTraditionalHeader(lines[index], starts.length);
    if (base) starts.push({ line: index, base });
    if (starts.length >= MAX_THREADS) break;
  }
  const warnings: string[] = [];
  if (starts.length >= MAX_THREADS) warnings.push(`Only the first ${MAX_THREADS.toLocaleString()} threads were included.`);

  const threads = starts.map((start, threadIndex) => {
    const nextThread = starts[threadIndex + 1]?.line ?? lines.length;
    const sectionMarker = lines.findIndex((line, lineIndex) => lineIndex > start.line && lineIndex < nextThread && /^(?:JNI global references|Found (?:one|\d+) Java-level deadlock|Deadlock Detection:|Heap\s*$)/i.test(line.trim()));
    const end = sectionMarker >= 0 ? sectionMarker : nextThread;
    const blockLines = lines.slice(start.line, end);
    const stack: StackFrame[] = [];
    const locks: ThreadLock[] = [];
    let state = start.base!.state;
    let stateDetail = start.base!.stateDetail;

    for (const line of blockLines.slice(1)) {
      const stateMatch = /java\.lang\.Thread\.State:\s+([A-Z_]+)(?:\s+\(([^)]+)\))?/i.exec(line);
      if (stateMatch) {
        state = normalizeState(stateMatch[1]);
        stateDetail = stateMatch[2] || stateDetail;
        continue;
      }
      if (/^\s*(?:at|\tat)\s+/.test(line) && stack.length < MAX_FRAMES_PER_THREAD) stack.push(parseFrame(line));
      const lock = lockFromLine(line, Math.max(0, stack.length - 1));
      if (lock) locks.push(lock);
    }

    const held = [...new Set(locks.filter(lock => lock.kind === 'held').map(lock => lock.id))];
    const waiting = locks.find(lock => lock.kind !== 'held');
    const topFrame = stack[0]?.raw || '(no Java stack frames)';
    const virtual = start.base!.virtual;
    return {
      ...start.base!,
      id: `thread-${threadIndex + 1}`,
      state,
      stateDetail,
      virtual,
      stack,
      topFrame,
      locks,
      locksHeld: held,
      waitingOn: waiting?.id,
      waitingKind: waiting?.kind,
      waitingOwnerJavaId: waiting?.ownerJavaId,
      category: categorizeThread(start.base!.name, topFrame, virtual),
      raw: blockLines.join('\n').trimEnd(),
    } satisfies JavaThread;
  });
  if (!threads.length) throw new Error('No HotSpot/OpenJDK thread entries were found. Paste output from jcmd Thread.print, jstack, or a JDK JSON thread dump.');
  return { threads, warnings };
}

interface JsonThread {
  tid?: string | number;
  name?: string;
  state?: string;
  virtual?: boolean;
  time?: string;
  stack?: string[];
  parkBlocker?: { object?: string; owner?: string | number };
  blockedOn?: string;
  waitingOn?: string;
  monitorsOwned?: Array<{ depth?: number; locks?: Array<string | null> }>;
  carrier?: string | number;
}

interface JsonThreadContainer {
  container?: string;
  parent?: string | null;
  owner?: string | number | null;
  threads?: JsonThread[];
  threadCount?: string | number;
}

function parseJsonSnapshot(input: string, parsed: any): ThreadDumpSnapshot {
  const root = parsed?.threadDump;
  if (!root || !Array.isArray(root.threadContainers)) throw new Error('The JSON is valid, but it is not a JDK thread dump. Expected threadDump.threadContainers.');
  const warnings: string[] = [];
  const jsonThreads: Array<{ thread: JsonThread; container?: string }> = [];
  for (const container of root.threadContainers as JsonThreadContainer[]) {
    for (const thread of container.threads || []) {
      if (jsonThreads.length >= MAX_THREADS) break;
      jsonThreads.push({ thread, container: container.container });
    }
    if (jsonThreads.length >= MAX_THREADS) break;
  }
  if (jsonThreads.length >= MAX_THREADS) warnings.push(`Only the first ${MAX_THREADS.toLocaleString()} threads were included.`);
  if (!jsonThreads.length) throw new Error('The JDK JSON dump does not contain any thread entries.');

  const threads: JavaThread[] = jsonThreads.map(({ thread, container }, index) => {
    const stack = (thread.stack || []).slice(0, MAX_FRAMES_PER_THREAD).map(parseFrame);
    const locks: ThreadLock[] = [];
    for (const owned of thread.monitorsOwned || []) {
      for (const lockValue of owned.locks || []) {
        if (!lockValue) continue;
        locks.push({
          id: normalizeLockId(lockValue),
          className: /^[\w.$]+@[0-9a-f]+$/i.test(lockValue) ? lockValue.split('@')[0] : undefined,
          kind: 'held',
          frameIndex: owned.depth,
        });
      }
    }
    const waitingValue = thread.blockedOn || thread.waitingOn || thread.parkBlocker?.object;
    const waitingKind: ThreadLock['kind'] | undefined = thread.blockedOn ? 'waiting-to-lock' : thread.waitingOn ? 'waiting-on' : waitingValue ? 'parking' : undefined;
    if (waitingValue && waitingKind) {
      locks.push({
        id: normalizeLockId(waitingValue),
        className: /^[\w.$]+@[0-9a-f]+$/i.test(waitingValue) ? waitingValue.split('@')[0] : undefined,
        kind: waitingKind,
        frameIndex: 0,
        ownerJavaId: thread.parkBlocker?.owner === undefined ? undefined : String(thread.parkBlocker.owner),
      });
    }
    const javaId = thread.tid === undefined ? undefined : String(thread.tid);
    const name = thread.name || (javaId ? `Thread #${javaId}` : `Thread ${index + 1}`);
    const topFrame = stack[0]?.raw || '(no Java stack frames)';
    return {
      id: `thread-${index + 1}`,
      javaId,
      name,
      state: normalizeState(thread.state),
      stateDetail: thread.carrier === undefined ? undefined : `Carrier thread #${thread.carrier}`,
      daemon: false,
      virtual: Boolean(thread.virtual),
      category: categorizeThread(name, topFrame, Boolean(thread.virtual)),
      container,
      stack,
      topFrame,
      locks,
      locksHeld: [...new Set(locks.filter(lock => lock.kind === 'held').map(lock => lock.id))],
      waitingOn: waitingValue ? normalizeLockId(waitingValue) : undefined,
      waitingKind,
      waitingOwnerJavaId: thread.parkBlocker?.owner === undefined ? undefined : String(thread.parkBlocker.owner),
      raw: JSON.stringify(thread, null, 2),
    };
  });
  return finalizeSnapshot({
    id: 'snapshot-1',
    index: 0,
    timestamp: root.time,
    runtimeVersion: root.runtimeVersion,
    processId: root.processId === undefined ? undefined : String(root.processId),
    format: 'jdk-json',
    formatLabel: `JDK JSON thread dump${root.formatVersion ? ` v${root.formatVersion}` : ''}`,
    threads,
    warnings,
    raw: input,
  });
}

function fnvHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function buildGroups(threads: JavaThread[]): ThreadStackGroup[] {
  const map = new Map<string, JavaThread[]>();
  for (const thread of threads) {
    const signature = `${thread.state}\n${thread.stack.map(frame => frame.raw).join('\n')}`;
    const list = map.get(signature) || [];
    list.push(thread);
    map.set(signature, list);
  }
  return [...map.entries()].map(([signature, groupedThreads]) => {
    const sample = groupedThreads[0];
    const applicationFrame = sample.stack.find(frame => frame.className && !/^(?:java|javax|jdk|sun|com\.sun)\./.test(frame.className));
    return {
      id: `group-${fnvHash(signature)}`,
      state: sample.state,
      category: sample.category,
      title: applicationFrame?.raw || sample.topFrame,
      count: groupedThreads.length,
      threadIds: groupedThreads.map(thread => thread.id),
      stack: sample.stack,
    };
  }).sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
}

function buildHotFrames(threads: JavaThread[]): HotFrame[] {
  const frames = new Map<string, Set<string>>();
  for (const thread of threads) {
    const seen = new Set<string>();
    for (const frame of thread.stack) {
      if (!frame.raw || seen.has(frame.raw) || /java\.lang\.Thread\.run\(/.test(frame.raw)) continue;
      seen.add(frame.raw);
      const ids = frames.get(frame.raw) || new Set<string>();
      ids.add(thread.id);
      frames.set(frame.raw, ids);
    }
  }
  return [...frames.entries()]
    .map(([frame, ids]) => ({ frame, count: ids.size, threadIds: [...ids] }))
    .filter(item => item.count > 1)
    .sort((a, b) => b.count - a.count || a.frame.localeCompare(b.frame))
    .slice(0, 20);
}

function buildLocks(threads: JavaThread[]): LockContention[] {
  const lockMap = new Map<string, LockContention>();
  for (const thread of threads) {
    for (const lock of thread.locks) {
      const entry = lockMap.get(lock.id) || { id: lock.id, className: lock.className, ownerThreadIds: [], waiterThreadIds: [] };
      if (!entry.className && lock.className) entry.className = lock.className;
      const target = lock.kind === 'held' ? entry.ownerThreadIds : entry.waiterThreadIds;
      if (!target.includes(thread.id)) target.push(thread.id);
      lockMap.set(lock.id, entry);
    }
  }
  return [...lockMap.values()]
    .filter(lock =>
      (lock.waiterThreadIds.length > 0 && lock.ownerThreadIds.length > 0)
      || lock.waiterThreadIds.length > 1
      || lock.ownerThreadIds.length > 1
    )
    .sort((a, b) => b.waiterThreadIds.length - a.waiterThreadIds.length || b.ownerThreadIds.length - a.ownerThreadIds.length);
}

function detectDeadlocks(threads: JavaThread[], locks: LockContention[], raw: string): DeadlockCycle[] {
  const ownersByLock = new Map(locks.map(lock => [lock.id, lock.ownerThreadIds]));
  const idByJavaId = new Map(threads.filter(thread => thread.javaId).map(thread => [thread.javaId!, thread.id]));
  const waitTargets = new Map<string, { owners: string[]; lockId: string }>();
  for (const thread of threads) {
    if (!thread.waitingOn) continue;
    const owners = [...(ownersByLock.get(thread.waitingOn) || [])];
    if (thread.waitingOwnerJavaId) {
      const ownerId = idByJavaId.get(thread.waitingOwnerJavaId);
      if (ownerId && !owners.includes(ownerId)) owners.push(ownerId);
    }
    if (owners.length) waitTargets.set(thread.id, { owners: owners.filter(owner => owner !== thread.id), lockId: thread.waitingOn });
  }

  const cycles: DeadlockCycle[] = [];
  const keys = new Set<string>();
  const visit = (current: string, path: string[], pathLocks: string[]): void => {
    const existingIndex = path.indexOf(current);
    if (existingIndex >= 0) {
      const threadIds = path.slice(existingIndex);
      if (threadIds.length < 2) return;
      const lockIds = pathLocks.slice(existingIndex);
      const key = [...threadIds].sort().join('|');
      if (!keys.has(key)) {
        keys.add(key);
        cycles.push({ threadIds, lockIds, explicit: false });
      }
      return;
    }
    if (path.length > threads.length) return;
    const target = waitTargets.get(current);
    if (!target) return;
    for (const owner of target.owners) visit(owner, [...path, current], [...pathLocks, target.lockId]);
  };
  for (const threadId of waitTargets.keys()) visit(threadId, [], []);

  const explicit = /Found (?:one|\d+) Java-level deadlock/i.test(raw);
  if (explicit && !cycles.length) {
    const marker = raw.search(/Found (?:one|\d+) Java-level deadlock/i);
    const section = marker >= 0 ? raw.slice(marker) : raw;
    const names = [...section.matchAll(/^"([^"]+)":\s*$/gm)].map(match => match[1]);
    const threadIds = [...new Set(names.map(name => threads.find(thread => thread.name === name)?.id).filter((id): id is string => Boolean(id)))];
    if (threadIds.length > 1) cycles.push({ threadIds, lockIds: [], explicit: true });
  }
  if (explicit) cycles.forEach(cycle => { cycle.explicit = true; });
  return cycles;
}

function countBy<T extends string>(items: T[], values: T[]): Record<T, number> {
  const result = Object.fromEntries(values.map(value => [value, 0])) as Record<T, number>;
  items.forEach(value => { result[value] = (result[value] || 0) + 1; });
  return result;
}

function buildFindings(threads: JavaThread[], locks: LockContention[], deadlocks: DeadlockCycle[], groups: ThreadStackGroup[]): AnalysisFinding[] {
  const findings: AnalysisFinding[] = [];
  const blocked = threads.filter(thread => thread.state === 'BLOCKED');
  const runnable = threads.filter(thread => thread.state === 'RUNNABLE');
  const contended = locks.filter(lock => lock.waiterThreadIds.length > 0);
  const largestGroup = groups.find(group => group.count >= Math.max(3, Math.ceil(threads.length * 0.1)));

  if (deadlocks.length) {
    const ids = [...new Set(deadlocks.flatMap(cycle => cycle.threadIds))];
    findings.push({ severity: 'critical', title: `${deadlocks.length} deadlock cycle${deadlocks.length === 1 ? '' : 's'} detected`, detail: `${ids.length} threads form circular lock dependencies. Open the deadlock finding to inspect each waiter and owner.`, threadIds: ids });
  } else {
    findings.push({ severity: 'good', title: 'No lock cycle detected', detail: 'No circular ownership chain was found in the lock information included with this dump.' });
  }
  if (blocked.length) findings.push({ severity: blocked.length >= 10 ? 'warning' : 'info', title: `${blocked.length} blocked thread${blocked.length === 1 ? '' : 's'}`, detail: 'BLOCKED threads are waiting to enter synchronized code. Inspect their target locks and owning threads.', threadIds: blocked.map(thread => thread.id) });
  if (contended.length) {
    const waiters = new Set(contended.flatMap(lock => lock.waiterThreadIds));
    findings.push({ severity: waiters.size >= 5 ? 'warning' : 'info', title: `${contended.length} contended lock${contended.length === 1 ? '' : 's'}`, detail: `${waiters.size} thread${waiters.size === 1 ? '' : 's'} are waiting on locks with identifiable owners or shared waiters.`, threadIds: [...waiters] });
  }
  if (largestGroup) findings.push({ severity: 'info', title: `${largestGroup.count} threads share one stack`, detail: `Repeated at ${largestGroup.title}. This can reveal a saturated pool, shared bottleneck, or normal idle workers.`, threadIds: largestGroup.threadIds });
  if (runnable.length >= Math.max(10, Math.ceil(threads.length * 0.3))) findings.push({ severity: 'info', title: `${runnable.length} threads are RUNNABLE`, detail: 'RUNNABLE includes CPU work, native calls, and some I/O. Compare several captures before treating it as evidence of a hot loop.', threadIds: runnable.map(thread => thread.id) });
  if (threads.some(thread => thread.virtual)) {
    const count = threads.filter(thread => thread.virtual).length;
    findings.push({ severity: 'info', title: `${count.toLocaleString()} virtual thread${count === 1 ? '' : 's'}`, detail: 'Virtual threads are grouped and searchable like platform threads; carrier information is shown when the dump provides it.' });
  }
  return findings;
}

function finalizeSnapshot(base: Pick<ThreadDumpSnapshot, 'id' | 'index' | 'timestamp' | 'runtimeVersion' | 'processId' | 'format' | 'formatLabel' | 'threads' | 'warnings' | 'raw'>): ThreadDumpSnapshot {
  const locks = buildLocks(base.threads);
  const groups = buildGroups(base.threads);
  const deadlocks = detectDeadlocks(base.threads, locks, base.raw);
  return {
    ...base,
    stateCounts: countBy(base.threads.map(thread => thread.state), STATES),
    categoryCounts: countBy(base.threads.map(thread => thread.category), CATEGORIES),
    locks,
    deadlocks,
    groups,
    hotFrames: buildHotFrames(base.threads),
    findings: buildFindings(base.threads, locks, deadlocks, groups),
  };
}

function textSnapshotMetadata(raw: string): { timestamp?: string; runtimeVersion?: string; processId?: string } {
  const timestamp = raw.match(/^\s*(\d{4}-\d{2}-\d{2}(?:[T ][^\n]+)?)/m)?.[1];
  const processId = raw.match(/^\s*(\d+):?\s*$/m)?.[1];
  const vmLine = raw.split('\n').find(line => /Full thread dump/.test(line));
  return { timestamp, processId, runtimeVersion: vmLine?.replace(/^.*Full thread dump\s*/, '').replace(/:$/, '').trim() || undefined };
}

function splitTextSnapshots(input: string): string[] {
  const lines = input.split('\n');
  const headers = lines.flatMap((line, index) => /Full thread dump/.test(line) ? [index] : []);
  if (headers.length <= 1) return [input];
  const starts = headers.map((header, index) => {
    if (index === 0) return 0;
    let start = header;
    for (let line = header - 1; line >= Math.max(headers[index - 1] + 1, header - 4); line--) {
      if (/^\s*$|^\s*\d+:?\s*$|^\s*\d{4}-\d{2}-\d{2}/.test(lines[line])) start = line;
      else break;
    }
    return start;
  });
  return starts.map((start, index) => lines.slice(start, starts[index + 1] ?? lines.length).join('\n')).filter(value => value.trim());
}

export function analyzeThreadDump(input: string): ThreadDumpAnalysis {
  if (input.length > MAX_INPUT_CHARACTERS) throw new Error('That dump is larger than 20 MB. Split it into smaller captures and analyze them separately.');
  const cleaned = stripControlSequences(input).trim();
  if (!cleaned) throw new Error('Paste a Java thread dump or open a dump file first.');

  if (cleaned.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = undefined;
    }
    if (parsed && typeof parsed === 'object' && (parsed as any).threadDump) {
      const snapshot = parseJsonSnapshot(cleaned, parsed);
      return { snapshots: [snapshot], totalCharacters: cleaned.length, formatLabel: snapshot.formatLabel };
    }
  }

  const chunks = splitTextSnapshots(cleaned);
  const snapshots = chunks.map((raw, index) => {
    const { threads, warnings } = parseTextThreads(raw);
    const metadata = textSnapshotMetadata(raw);
    return finalizeSnapshot({
      id: `snapshot-${index + 1}`,
      index,
      ...metadata,
      format: 'hotspot-text',
      formatLabel: 'HotSpot / OpenJDK text dump',
      threads,
      warnings,
      raw,
    });
  });
  return {
    snapshots,
    totalCharacters: cleaned.length,
    formatLabel: snapshots.length > 1 ? `${snapshots[0].formatLabel} · ${snapshots.length} captures` : snapshots[0].formatLabel,
  };
}

function csvCell(value: string | number | boolean | undefined): string {
  const text = value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function threadReportCsv(snapshot: ThreadDumpSnapshot): string {
  const rows: Array<Array<string | number | boolean | undefined>> = [
    ['Name', 'Java ID', 'State', 'Category', 'Daemon', 'Virtual', 'Top frame', 'Waiting on', 'Locks held', 'CPU ms', 'Elapsed seconds'],
    ...snapshot.threads.map(thread => [
      thread.name, thread.javaId, thread.state, thread.category, thread.daemon, thread.virtual,
      thread.topFrame, thread.waitingOn, thread.locksHeld.join(' '), thread.cpuMs, thread.elapsedSeconds,
    ]),
  ];
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}

export function snapshotReportJson(snapshot: ThreadDumpSnapshot): string {
  return JSON.stringify({
    format: snapshot.formatLabel,
    timestamp: snapshot.timestamp,
    runtimeVersion: snapshot.runtimeVersion,
    processId: snapshot.processId,
    summary: { threads: snapshot.threads.length, states: snapshot.stateCounts, categories: snapshot.categoryCounts },
    findings: snapshot.findings,
    deadlocks: snapshot.deadlocks,
    locks: snapshot.locks,
    groups: snapshot.groups.map(group => ({ ...group, stack: group.stack.map(frame => frame.raw) })),
    threads: snapshot.threads.map(thread => ({
      name: thread.name,
      javaId: thread.javaId,
      state: thread.state,
      category: thread.category,
      daemon: thread.daemon,
      virtual: thread.virtual,
      priority: thread.priority,
      tid: thread.tid,
      nid: thread.nid,
      cpuMs: thread.cpuMs,
      elapsedSeconds: thread.elapsedSeconds,
      waitingOn: thread.waitingOn,
      locksHeld: thread.locksHeld,
      stack: thread.stack.map(frame => frame.raw),
    })),
  }, null, 2);
}
