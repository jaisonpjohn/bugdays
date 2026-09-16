import type { CertificateReport } from './certificate-inspector.ts';
import { parseIp } from './ip-address.ts';

export interface TlsCertificatePayload { position: number; derBase64: string }
export interface TlsInspectResult {
  host: string;
  port: number;
  serverName: string;
  peerAddress: string;
  tlsVersion?: string;
  cipherSuite?: string;
  alpn?: string;
  validation: { trusted: boolean; error?: string };
  certificates: TlsCertificatePayload[];
  connectedAt: number;
  elapsedMs: number;
}

export interface TlsIssue {
  severity: 'error' | 'warning' | 'pass' | 'info';
  title: string;
  detail: string;
}

export interface TlsAnalysis {
  identityMatches: boolean;
  matchedIdentity?: string;
  issues: TlsIssue[];
}

function normalizedHost(value: string): string {
  return value.trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

export function dnsPatternMatches(patternValue: string, hostnameValue: string): boolean {
  const pattern = normalizedHost(patternValue);
  const hostname = normalizedHost(hostnameValue);
  if (pattern === hostname) return true;
  if (!pattern.startsWith('*.')) return false;
  const suffix = pattern.slice(2);
  const labels = hostname.split('.');
  return labels.length === suffix.split('.').length + 1 && hostname.endsWith(`.${suffix}`);
}

export function certificateMatchesIdentity(report: CertificateReport, identityValue: string): { matches: boolean; matched?: string } {
  const identity = normalizedHost(identityValue);
  const ip = parseIp(identity);
  const sans = report.subjectAlternativeNames;
  if (ip) {
    const match = sans.find(name => name.type.toLowerCase() === 'ip' && parseIp(name.value)?.address === ip.address);
    return { matches: Boolean(match), ...(match ? { matched: match.value } : {}) };
  }
  const dnsNames = sans.filter(name => name.type.toLowerCase() === 'dns');
  const match = dnsNames.find(name => dnsPatternMatches(name.value, identity));
  if (match) return { matches: true, matched: match.value };
  if (!dnsNames.length) {
    const commonName = /(?:^|,\s*)CN=([^,]+)/i.exec(report.subject)?.[1];
    if (commonName && dnsPatternMatches(commonName, identity)) return { matches: true, matched: commonName };
  }
  return { matches: false };
}

export function analyzeTlsConnection(result: TlsInspectResult, reports: CertificateReport[]): TlsAnalysis {
  const issues: TlsIssue[] = [];
  const leaf = reports[0];
  if (!leaf) return { identityMatches: false, issues: [{ severity: 'error', title: 'No certificate', detail: 'The service did not present a certificate.' }] };
  const identity = certificateMatchesIdentity(leaf, result.serverName);
  issues.push(identity.matches
    ? { severity: 'pass', title: 'Name matches', detail: `${result.serverName} is covered by ${identity.matched}.` }
    : { severity: 'error', title: 'Name mismatch', detail: `The leaf certificate does not cover ${result.serverName} in its Subject Alternative Names.` });

  issues.push(result.validation.trusted
    ? { severity: 'pass', title: 'Chain trusted', detail: 'The chain passed this device’s root-store, validity, and name checks.' }
    : { severity: 'error', title: 'Trust check failed', detail: result.validation.error || 'The chain was presented but did not pass this device’s trust check.' });

  for (const [index, report] of reports.entries()) {
    const label = index === 0 ? 'Leaf certificate' : `Certificate ${index + 1}`;
    if (report.status === 'expired') issues.push({ severity: 'error', title: `${label} expired`, detail: `${commonName(report.subject)} expired on ${report.notAfter.toLocaleString()}.` });
    else if (report.status === 'not-yet-valid') issues.push({ severity: 'error', title: `${label} is not valid yet`, detail: `Its validity starts ${report.notBefore.toLocaleString()}.` });
    else if (report.daysRemaining <= 30) issues.push({ severity: 'warning', title: `${label} expires soon`, detail: `${commonName(report.subject)} has ${report.daysRemaining} day${report.daysRemaining === 1 ? '' : 's'} remaining.` });
    if (/\b(?:MD5|SHA-1)\b/i.test(report.signatureAlgorithm)) issues.push({ severity: 'warning', title: `${label} uses a legacy signature`, detail: report.signatureAlgorithm });
    const rsaBits = /RSA\s*·\s*([\d,]+) bits/i.exec(report.publicKey);
    if (rsaBits && Number(rsaBits[1].replaceAll(',', '')) < 2048) issues.push({ severity: 'warning', title: `${label} has a weak RSA key`, detail: report.publicKey });
  }
  if (leaf.isCertificateAuthority) issues.push({ severity: 'warning', title: 'Leaf is marked as a CA', detail: 'A service certificate is normally an end-entity certificate, not a certificate authority.' });
  if (leaf.extendedKeyUsages.length && !leaf.extendedKeyUsages.some(value => /TLS web server|Any extended/i.test(value))) issues.push({ severity: 'warning', title: 'Server authentication usage is missing', detail: 'The leaf certificate has Extended Key Usage values, but none authorizes TLS server authentication.' });

  for (let index = 0; index < reports.length - 1; index++) {
    if (reports[index].issuer !== reports[index + 1].subject) issues.push({ severity: 'warning', title: 'Chain order or intermediate may be wrong', detail: `Certificate ${index + 1} names an issuer that is not certificate ${index + 2}.` });
  }
  if (reports.length === 1 && !leaf.selfSigned && !result.validation.trusted) issues.push({ severity: 'warning', title: 'Intermediate certificate may be missing', detail: 'The server sent only the leaf certificate and the trust check failed.' });
  return { identityMatches: identity.matches, matchedIdentity: identity.matched, issues };
}

function commonName(subject: string): string {
  return /(?:^|,\s*)CN=([^,]+)/i.exec(subject)?.[1] || subject || 'Certificate';
}

export async function checkTlsBridge(bridgeValue: string): Promise<{ version: string }> {
  const base = normalizeBridgeUrl(bridgeValue);
  try {
    const response = await fetch(`${base}/api/v1/capabilities`, { cache: 'no-store' });
    if (!response.ok) throw new Error();
    const payload = await response.json() as any;
    if (payload?.capabilities?.tlsInspection !== true) throw new Error('outdated');
    return { version: typeof payload.version === 'string' ? payload.version : 'current' };
  } catch (error) {
    if (error instanceof Error && error.message === 'outdated') throw new Error('Holy CORS is running, but this version does not include TLS certificate inspection. Update it and retry.');
    throw new Error(`Could not reach Holy CORS at ${base}. Start or update the bridge, then retry.`);
  }
}

export async function inspectTlsService(host: string, port: number, serverName: string, bridgeValue: string): Promise<TlsInspectResult> {
  const base = normalizeBridgeUrl(bridgeValue);
  await checkTlsBridge(base);
  const response = await fetch(`${base}/api/v1/tls/inspect`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host, port, serverName: serverName || undefined, timeoutMs: 10_000 }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof (payload as any).error === 'string' ? (payload as any).error : `TLS inspection failed with HTTP ${response.status}.`);
  return validateTlsInspectResult(payload);
}

export function validateTlsInspectResult(input: unknown): TlsInspectResult {
  const value = input as any;
  const text = (candidate: unknown, max: number) => typeof candidate === 'string' && candidate.length <= max ? candidate : undefined;
  if (!value || !text(value.host, 253) || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || !text(value.serverName, 253) || !text(value.peerAddress, 300)) throw new Error('Invalid TLS inspection response.');
  if (!value.validation || typeof value.validation.trusted !== 'boolean' || !Array.isArray(value.certificates) || !value.certificates.length || value.certificates.length > 20) throw new Error('Invalid TLS inspection response.');
  const certificates = value.certificates.map((certificate: any, index: number) => {
    if (certificate?.position !== index || typeof certificate.derBase64 !== 'string' || certificate.derBase64.length > 1_000_000 || !/^[A-Za-z0-9+/]+=*$/.test(certificate.derBase64)) throw new Error('Invalid TLS certificate data.');
    return { position: index, derBase64: certificate.derBase64 };
  });
  return {
    host: value.host, port: value.port, serverName: value.serverName, peerAddress: value.peerAddress,
    ...(text(value.tlsVersion, 80) ? { tlsVersion: value.tlsVersion } : {}),
    ...(text(value.cipherSuite, 120) ? { cipherSuite: value.cipherSuite } : {}),
    ...(text(value.alpn, 80) ? { alpn: value.alpn } : {}),
    validation: { trusted: value.validation.trusted, ...(text(value.validation.error, 1000) ? { error: value.validation.error } : {}) },
    certificates,
    connectedAt: Number.isFinite(value.connectedAt) ? value.connectedAt : Date.now(), elapsedMs: Number.isFinite(value.elapsedMs) ? value.elapsedMs : 0,
  };
}

function normalizeBridgeUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '');
  const url = new URL(normalized);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Bridge URL must start with http:// or https://.');
  return normalized;
}

export function tlsReportRows(result: TlsInspectResult, reports: CertificateReport[]): string[][] {
  const rows = [['Position', 'Role', 'Subject', 'Issuer', 'Not before', 'Not after', 'Days remaining', 'Status', 'SANs', 'Public key', 'Signature', 'SHA-256']];
  reports.forEach((report, index) => rows.push([
    String(index + 1), index === 0 ? 'Leaf' : report.selfSigned ? 'Root' : 'Intermediate', report.subject, report.issuer,
    report.notBefore.toISOString(), report.notAfter.toISOString(), String(report.daysRemaining), report.status,
    report.subjectAlternativeNames.map(name => `${name.type}:${name.value}`).join('; '), report.publicKey, report.signatureAlgorithm, report.sha256Fingerprint,
  ]));
  return rows;
}

export function tlsShareSnapshot(result: TlsInspectResult): TlsInspectResult {
  return JSON.parse(JSON.stringify(result));
}
