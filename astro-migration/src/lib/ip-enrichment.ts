import { parseIp } from './ip-address.ts';

export interface IpEnrichment {
  version: 1;
  ip: string;
  lookedUpAt: string;
  specialUse?: string;
  network?: { asn?: number; organization?: string; isp?: string; domain?: string };
  location?: {
    continent?: string; continentCode?: string; country?: string; countryCode?: string;
    region?: string; regionCode?: string; city?: string; postal?: string;
    latitude?: number; longitude?: number; timezone?: string; utcOffset?: string; flagEmoji?: string;
  };
  security?: { anonymous?: boolean; proxy?: boolean; vpn?: boolean; tor?: boolean; hosting?: boolean; relay?: boolean; mobile?: boolean };
  reverseDns: string[];
  sources: ('ipwhois' | 'cloudflare-dns')[];
  warnings: string[];
}

const text = (value: unknown, max = 160): string | undefined => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
const finite = (value: unknown, min: number, max: number): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
const compact = <T extends object>(value: T): T | undefined => Object.values(value).some(item => item !== undefined) ? value : undefined;

export function normalizeIpWhois(input: unknown, expectedIp: string): Pick<IpEnrichment, 'network' | 'location' | 'security'> {
  const value = input as any;
  const returnedIp = typeof value?.ip === 'string' ? parseIp(value.ip)?.address : undefined;
  if (!value || value.success !== true || returnedIp !== expectedIp) throw new Error('Invalid IP geolocation response.');
  const asn = Number.isInteger(value.connection?.asn) && value.connection.asn > 0 && value.connection.asn <= 4294967295 ? value.connection.asn : undefined;
  const network = compact({
    asn,
    organization: text(value.connection?.org),
    isp: text(value.connection?.isp),
    domain: text(value.connection?.domain, 253),
  });
  const location = compact({
    continent: text(value.continent, 80), continentCode: text(value.continent_code, 8),
    country: text(value.country, 80), countryCode: text(value.country_code, 8),
    region: text(value.region, 100), regionCode: text(value.region_code, 20), city: text(value.city, 100), postal: text(value.postal, 30),
    latitude: finite(value.latitude, -90, 90), longitude: finite(value.longitude, -180, 180),
    timezone: text(value.timezone?.id, 80), utcOffset: text(value.timezone?.utc, 10), flagEmoji: text(value.flag?.emoji, 16),
  });
  const securityKeys = ['anonymous', 'proxy', 'vpn', 'tor', 'hosting', 'relay', 'mobile'] as const;
  const security = compact(Object.fromEntries(securityKeys.map(key => [key, typeof value.security?.[key] === 'boolean' ? value.security[key] : undefined])) as IpEnrichment['security']);
  return { ...(network ? { network } : {}), ...(location ? { location } : {}), ...(security ? { security } : {}) };
}

export function reverseDnsName(address: string): string {
  const ip = parseIp(address);
  if (!ip) throw new Error('Invalid IP address.');
  if (ip.version === 4) return ip.address.split('.').reverse().join('.') + '.in-addr.arpa';
  return ip.value.toString(16).padStart(32, '0').split('').reverse().join('.') + '.ip6.arpa';
}

export function normalizePtrResponse(input: unknown): string[] {
  const value = input as any;
  if (!value || value.Status !== 0 || !Array.isArray(value.Answer)) return [];
  return [...new Set(value.Answer
    .filter((answer: any) => answer?.type === 12 && typeof answer.data === 'string')
    .map((answer: any) => answer.data.replace(/\.$/, '').trim().toLowerCase())
    .filter((hostname: string) => hostname.length <= 253 && /^[a-z0-9_.-]+$/i.test(hostname)))]
    .slice(0, 10) as string[];
}

/** Rebuild third-party, shared, and imported enrichment using only known bounded fields. */
export function validateIpEnrichment(input: unknown, expectedIp: string): IpEnrichment {
  const value = input as any;
  const ip = typeof value?.ip === 'string' ? parseIp(value.ip)?.address : undefined;
  if (!value || value.version !== 1 || ip !== expectedIp) throw new Error('Invalid IP enrichment data.');
  const requiredText = (candidate: unknown, max = 160) => {
    const result = text(candidate, max);
    if (!result || result !== candidate) throw new Error('Invalid IP enrichment data.');
    return result;
  };
  const optionalText = (candidate: unknown, max = 160) => candidate === undefined ? undefined : requiredText(candidate, max);
  const stringList = (candidate: unknown, maxItems: number, maxLength: number) => {
    if (!Array.isArray(candidate) || candidate.length > maxItems) throw new Error('Invalid IP enrichment data.');
    return candidate.map(item => requiredText(item, maxLength));
  };
  const network = value.network === undefined ? undefined : compact({
    asn: value.network && Number.isInteger(value.network.asn) && value.network.asn > 0 && value.network.asn <= 4294967295 ? value.network.asn : value.network?.asn === undefined ? undefined : (() => { throw new Error('Invalid IP enrichment data.'); })(),
    organization: optionalText(value.network?.organization), isp: optionalText(value.network?.isp), domain: optionalText(value.network?.domain, 253),
  });
  const location = value.location === undefined ? undefined : compact({
    continent: optionalText(value.location?.continent, 80), continentCode: optionalText(value.location?.continentCode, 8),
    country: optionalText(value.location?.country, 80), countryCode: optionalText(value.location?.countryCode, 8),
    region: optionalText(value.location?.region, 100), regionCode: optionalText(value.location?.regionCode, 20), city: optionalText(value.location?.city, 100), postal: optionalText(value.location?.postal, 30),
    latitude: value.location?.latitude === undefined ? undefined : finite(value.location.latitude, -90, 90) ?? (() => { throw new Error('Invalid IP enrichment data.'); })(),
    longitude: value.location?.longitude === undefined ? undefined : finite(value.location.longitude, -180, 180) ?? (() => { throw new Error('Invalid IP enrichment data.'); })(),
    timezone: optionalText(value.location?.timezone, 80), utcOffset: optionalText(value.location?.utcOffset, 10), flagEmoji: optionalText(value.location?.flagEmoji, 16),
  });
  let security: IpEnrichment['security'];
  if (value.security !== undefined) {
    security = {};
    for (const key of ['anonymous', 'proxy', 'vpn', 'tor', 'hosting', 'relay', 'mobile'] as const) {
      if (value.security?.[key] !== undefined && typeof value.security[key] !== 'boolean') throw new Error('Invalid IP enrichment data.');
      if (typeof value.security?.[key] === 'boolean') security[key] = value.security[key];
    }
    if (!Object.keys(security).length) security = undefined;
  }
  const sources = stringList(value.sources, 2, 30);
  if (sources.some(source => !['ipwhois', 'cloudflare-dns'].includes(source))) throw new Error('Invalid IP enrichment data.');
  return {
    version: 1,
    ip,
    lookedUpAt: requiredText(value.lookedUpAt, 100),
    ...(value.specialUse === undefined ? {} : { specialUse: requiredText(value.specialUse, 100) }),
    ...(network ? { network } : {}),
    ...(location ? { location } : {}),
    ...(security ? { security } : {}),
    reverseDns: stringList(value.reverseDns, 10, 253),
    sources: sources as IpEnrichment['sources'],
    warnings: stringList(value.warnings, 4, 240),
  };
}
