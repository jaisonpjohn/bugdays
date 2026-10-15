import type { CertificateReport } from './certificate-inspector.ts';
import type { TlsIssue } from './tls-certificate-check.ts';

export interface CertificateLink {
  index: number;
  issuerIndex?: number;
  status: 'verified' | 'invalid' | 'unsupported' | 'issuer-not-supplied' | 'self-signed';
}
export interface CertificateChainAnalysis { links: CertificateLink[]; issues: TlsIssue[] }

export function certificateRole(report: CertificateReport): string {
  return report.selfSigned ? 'Self-signed' : report.isCertificateAuthority ? 'CA / intermediate' : 'End entity';
}

/** A bounded bundle inspection, not trust-path validation, revocation checking, or a root store. */
export async function analyzeCertificateChain(reports: CertificateReport[]): Promise<CertificateChainAnalysis> {
  if (reports.length > 20) throw new Error('Inspect at most 20 certificates at a time.');
  const issues: TlsIssue[] = [];
  const links: CertificateLink[] = [];
  const fingerprints = new Set<string>();
  for (const [index, report] of reports.entries()) {
    const label = `Certificate ${index + 1}`;
    if (fingerprints.has(report.sha256Fingerprint)) issues.push({ severity: 'warning', title: `${label} is a duplicate`, detail: 'Its SHA-256 fingerprint matches an earlier certificate. Input order and duplicates are retained in exports.' });
    fingerprints.add(report.sha256Fingerprint);
    if (report.status !== 'valid') issues.push({ severity: 'error', title: `${label}: ${report.statusLabel}`, detail: `Valid from ${report.notBefore.toISOString()} to ${report.notAfter.toISOString()}.` });
    else if (report.daysRemaining <= 30) issues.push({ severity: 'warning', title: `${label} expires soon`, detail: report.statusLabel });
    if (/\b(?:SHA-1|MD5)\b/i.test(report.signatureAlgorithm)) issues.push({ severity: 'warning', title: `${label} uses a legacy signature`, detail: report.signatureAlgorithm });
    const bits = /RSA\s*·\s*([\d,]+) bits/.exec(report.publicKey);
    if (bits && Number(bits[1].replaceAll(',', '')) < 2048) issues.push({ severity: 'warning', title: `${label} has a weak RSA key`, detail: report.publicKey });
    if (report.selfSigned === true) { links.push({ index, status: 'self-signed' }); continue; }
    const candidates = reports.flatMap((candidate, candidateIndex) => candidateIndex !== index && candidate.subject === report.issuer && candidate.sha256Fingerprint !== report.sha256Fingerprint ? [candidateIndex] : []);
    if (!candidates.length) { links.push({ index, status: 'issuer-not-supplied' }); continue; }
    let issuerIndex: number | undefined;
    let unsupported = false;
    for (const candidate of candidates) {
      try {
        if (await report.certificate.verify({ publicKey: reports[candidate].certificate.publicKey, signatureOnly: true }, globalThis.crypto)) { issuerIndex = candidate; break; }
      } catch { unsupported = true; }
    }
    if (issuerIndex === undefined) {
      links.push({ index, status: unsupported ? 'unsupported' : 'invalid' });
      issues.push({ severity: unsupported ? 'info' : 'error', title: `${label}: ${unsupported ? 'signature could not be checked' : 'signature did not verify'}`, detail: unsupported ? 'This browser could not verify the signature algorithm against the supplied issuer candidates. No verification pass is claimed.' : 'The supplied certificates with the named issuer did not verify this signature. Check for the wrong issuer key or changed certificate data.' });
      continue;
    }
    links.push({ index, issuerIndex, status: 'verified' });
    const issuer = reports[issuerIndex];
    if (!issuer.isCertificateAuthority) issues.push({ severity: 'error', title: `${label}: issuer is not a CA`, detail: `Certificate ${issuerIndex + 1} verifies the signature but is not marked as a certificate authority.` });
    if (issuer.keyUsages.length && !issuer.keyUsages.includes('Certificate signing')) issues.push({ severity: 'error', title: `${label}: issuer cannot sign certificates`, detail: `Certificate ${issuerIndex + 1} has Key Usage restrictions without certificate signing.` });
    if (issuerIndex !== index + 1) issues.push({ severity: 'warning', title: `${label}: issuer is elsewhere in the bundle`, detail: `Its signature verifies with certificate ${issuerIndex + 1}. This is a bundle, not a leaf-first ordered chain; the input is not reordered automatically.` });
  }
  if (!issues.length) issues.push({ severity: 'pass', title: 'No date or supplied-signature issues found', detail: 'This is a file inspection, not a trust decision. An omitted root can be normal; an issuer not supplied cannot be checked here. Revocation and application policy are not checked.' });
  return { links, issues };
}

export function certificateReportRows(reports: CertificateReport[], analysis: CertificateChainAnalysis | null): string[][] {
  return [['Position', 'Role', 'Subject', 'Issuer', 'Not before (UTC)', 'Not after (UTC)', 'Days remaining', 'Status', 'SANs', 'Public key', 'Signature algorithm', 'Signature check', 'SHA-256'], ...reports.map((report, index) => [
    String(index + 1), certificateRole(report), report.subject, report.issuer,
    report.notBefore.toISOString(), report.notAfter.toISOString(), String(report.daysRemaining), report.status,
    report.subjectAlternativeNames.map(name => `${name.type}:${name.value}`).join('; '), report.publicKey, report.signatureAlgorithm,
    analysis?.links[index]?.status || 'not-checked', report.sha256Fingerprint,
  ])];
}
