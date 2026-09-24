export interface IpAddress { address: string; version: 4 | 6; value: bigint; mapped?: boolean }

/** Strict address parsing; no DNS requests, octal IPv4, or shortened IPv4 forms. */
export function parseIp(input: string): IpAddress | null {
  const text = input.trim();
  if (!text || text.length > 80) return null;
  if (!text.includes(':')) {
    const parts = text.split('.');
    if (parts.length !== 4 || parts.some(p => !/^(0|[1-9]\d{0,2})$/.test(p) || Number(p) > 255)) return null;
    return { address: parts.join('.'), version: 4, value: parts.reduce((n, p) => (n << 8n) | BigInt(p), 0n) };
  }
  let source = text.toLowerCase();
  if (source.includes('.')) {
    const boundary = source.lastIndexOf(':');
    const tail = parseIp(source.slice(boundary + 1));
    if (!tail || tail.version !== 4) return null;
    source = source.slice(0, boundary + 1) + (tail.value >> 16n).toString(16) + ':' + (tail.value & 65535n).toString(16);
  }
  if (!/^[0-9a-f:]+$/.test(source) || source.includes(':::')) return null;
  const halves = source.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if ([...left, ...right].some(p => !/^[0-9a-f]{1,4}$/.test(p))) return null;
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...right].map(p => parseInt(p, 16));
  const value = groups.reduce((n, p) => (n << 16n) | BigInt(p), 0n);
  if ((value >> 32n) === 65535n) {
    const low = value & 0xffffffffn;
    return { address: [24n, 16n, 8n, 0n].map(shift => String((low >> shift) & 255n)).join('.'), version: 4, value: low, mapped: true };
  }
  let start = -1, length = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > length && j - i >= 2) { start = i; length = j - i; }
    i = j;
  }
  const hex = groups.map(p => p.toString(16));
  const address = start < 0 ? hex.join(':') : hex.slice(0, start).join(':') + '::' + hex.slice(start + length).join(':');
  return { address, version: 6, value };
}

export function parseCidr(text: string) {
  const [address, prefixText, extra] = text.split('/');
  const ip = parseIp(address);
  if (!ip || ip.mapped || extra !== undefined || !/^(0|[1-9]\d{0,2})$/.test(prefixText || '')) return null;
  const prefix = Number(prefixText), bits = ip.version === 4 ? 32 : 128;
  if (prefix > bits) return null;
  const shift = BigInt(bits - prefix);
  return { ...ip, prefix, network: (ip.value >> shift) << shift, shift };
}

/** Extract addresses from prose, comma-separated lists, endpoint notation, or logs. */
export function extractIps(text: string): IpAddress[] {
  const results: IpAddress[] = [];
  for (const token of text.split(/[\s,;"'<>()[\]{}=\/\\]+/)) {
    if (!token.includes('.') && !token.includes(':')) continue;
    const cleaned = token.replace(/[.!?]+$/, '');
    let ip = parseIp(cleaned);
    if (!ip && /^(?:\d{1,3}\.){3}\d{1,3}:\d+$/.test(cleaned)) {
      const colon = cleaned.lastIndexOf(':');
      if (Number(cleaned.slice(colon + 1)) <= 65535) ip = parseIp(cleaned.slice(0, colon));
    }
    if (ip) results.push(ip);
  }
  return results;
}

const specialRanges = [
  ['0.0.0.0/8', 'This network'], ['10.0.0.0/8', 'Private network'], ['100.64.0.0/10', 'Shared address space'],
  ['127.0.0.0/8', 'Loopback'], ['169.254.0.0/16', 'Link-local'], ['172.16.0.0/12', 'Private network'],
  ['192.0.2.0/24', 'Documentation'], ['192.168.0.0/16', 'Private network'], ['198.18.0.0/15', 'Benchmarking'],
  ['198.51.100.0/24', 'Documentation'], ['203.0.113.0/24', 'Documentation'], ['224.0.0.0/4', 'Multicast'],
  ['240.0.0.0/4', 'Reserved'], ['::/128', 'Unspecified'], ['::1/128', 'Loopback'],
  ['fc00::/7', 'Private network'], ['fe80::/10', 'Link-local'], ['ff00::/8', 'Multicast'], ['2001:db8::/32', 'Documentation'],
].map(([cidr, label]) => ({ ...parseCidr(cidr)!, label }));

export function specialIpLabel(ip: IpAddress): string | null {
  return specialRanges.find(range => range.version === ip.version && (ip.value >> range.shift) << range.shift === range.network)?.label || null;
}

/**
 * Collapse a list of CIDRs into the smallest equivalent set. Providers such as iCloud Private
 * Relay publish hundreds of thousands of per-city /31s; merged they describe the same addresses
 * in a fraction of the rows.
 */
export function mergeCidrs(cidrs: readonly string[]): string[] {
  const spans: Record<4 | 6, Array<[bigint, bigint]>> = { 4: [], 6: [] };
  for (const text of cidrs) {
    const cidr = parseCidr(text);
    if (!cidr) continue;
    const size = 1n << cidr.shift;
    spans[cidr.version].push([cidr.network, cidr.network + size - 1n]);
  }
  const merged: string[] = [];
  for (const version of [4, 6] as const) {
    const bits = BigInt(version === 4 ? 32 : 128);
    const sorted = spans[version].sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
    let current: [bigint, bigint] | null = null;
    const flush = () => {
      if (!current) return;
      let [start, end] = current;
      while (start <= end) {
        // Largest block that starts here and does not overrun the span.
        let shift = 0n;
        while (shift < bits && ((start >> (shift + 1n)) << (shift + 1n)) === start && start + (1n << (shift + 1n)) - 1n <= end) shift += 1n;
        merged.push(`${formatIp(start, version)}/${bits - shift}`);
        start += 1n << shift;
      }
      current = null;
    };
    for (const span of sorted) {
      if (!current) current = [span[0], span[1]];
      else if (span[0] <= current[1] + 1n) current[1] = span[1] > current[1] ? span[1] : current[1];
      else { flush(); current = [span[0], span[1]]; }
    }
    flush();
  }
  return merged;
}

/** Render a numeric address back to text, for ranges produced by merging. */
export function formatIp(value: bigint, version: 4 | 6): string {
  if (version === 4) return [24n, 16n, 8n, 0n].map(shift => Number((value >> shift) & 255n)).join('.');
  const groups: string[] = [];
  for (let index = 7n; index >= 0n; index -= 1n) groups.push(((value >> (index * 16n)) & 65535n).toString(16));
  const text = groups.join(':');
  const zeros = text.match(/(?:^|:)(0(?::0)+)(?::|$)/);
  if (!zeros) return text;
  const start = zeros.index + (zeros[0].startsWith(':') ? 1 : 0);
  return `${text.slice(0, start)}::${text.slice(start + zeros[1].length + (text[start + zeros[1].length] === ':' ? 1 : 0))}`.replace(/:{3,}/, '::');
}
