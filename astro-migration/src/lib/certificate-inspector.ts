import 'reflect-metadata';
import {
  BasicConstraintsExtension,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  X509Certificate,
  X509Certificates,
} from '@peculiar/x509';

export type CertificateSourceFormat = 'pem' | 'der' | 'base64' | 'hex' | 'pkcs7';

export interface CertificateInput {
  certificates: X509Certificate[];
  sourceFormat: CertificateSourceFormat;
  sourceLabel: string;
}

export interface CertificateExtensionReport {
  name: string;
  oid: string;
  critical: boolean;
  summary: string;
}

export interface CertificateReport {
  certificate: X509Certificate;
  subject: string;
  issuer: string;
  serialNumber: string;
  notBefore: Date;
  notAfter: Date;
  status: 'valid' | 'expired' | 'not-yet-valid';
  statusLabel: string;
  daysRemaining: number;
  selfSigned: boolean;
  signatureAlgorithm: string;
  publicKey: string;
  subjectAlternativeNames: Array<{ type: string; value: string }>;
  isCertificateAuthority: boolean;
  pathLength?: number;
  keyUsages: string[];
  extendedKeyUsages: string[];
  sha1Fingerprint: string;
  sha256Fingerprint: string;
  extensions: CertificateExtensionReport[];
  textDump: string;
}

const EXTENDED_USAGE_NAMES: Record<string, string> = {
  '1.3.6.1.5.5.7.3.1': 'TLS web server authentication',
  '1.3.6.1.5.5.7.3.2': 'TLS web client authentication',
  '1.3.6.1.5.5.7.3.3': 'Code signing',
  '1.3.6.1.5.5.7.3.4': 'Email protection',
  '1.3.6.1.5.5.7.3.8': 'Time stamping',
  '1.3.6.1.5.5.7.3.9': 'OCSP signing',
  '2.5.29.37.0': 'Any extended key usage',
};

const KEY_USAGE_FLAGS: Array<[KeyUsageFlags, string]> = [
  [KeyUsageFlags.digitalSignature, 'Digital signature'],
  [KeyUsageFlags.nonRepudiation, 'Content commitment'],
  [KeyUsageFlags.keyEncipherment, 'Key encipherment'],
  [KeyUsageFlags.dataEncipherment, 'Data encipherment'],
  [KeyUsageFlags.keyAgreement, 'Key agreement'],
  [KeyUsageFlags.keyCertSign, 'Certificate signing'],
  [KeyUsageFlags.cRLSign, 'CRL signing'],
  [KeyUsageFlags.encipherOnly, 'Encipher only'],
  [KeyUsageFlags.decipherOnly, 'Decipher only'],
];

function sourceLabel(format: CertificateSourceFormat): string {
  if (format === 'pem') return 'PEM certificate';
  if (format === 'der') return 'DER / CER certificate';
  if (format === 'base64') return 'Base64 DER certificate';
  if (format === 'hex') return 'Hex DER certificate';
  return 'PKCS#7 certificate bundle';
}

function trySingleCertificate(value: string | BufferSource): X509Certificate | null {
  try {
    return new X509Certificate(value);
  } catch {
    return null;
  }
}

function tryCertificateBundle(value: string | BufferSource): X509Certificate[] | null {
  try {
    const bundle = new X509Certificates(value);
    return bundle.length ? Array.from(bundle) : null;
  } catch {
    return null;
  }
}

export function parseCertificateInput(input: string | ArrayBuffer | Uint8Array): CertificateInput {
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) throw new Error('Paste a certificate or choose a certificate file first.');
    if (/-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(trimmed)) {
      throw new Error('This inspector only needs the public certificate. Remove the private key and paste the CERTIFICATE block.');
    }

    const certificateBlocks = trimmed.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (certificateBlocks?.length) {
      return {
        certificates: certificateBlocks.map(block => new X509Certificate(block)),
        sourceFormat: 'pem',
        sourceLabel: certificateBlocks.length > 1 ? 'PEM certificate chain' : sourceLabel('pem'),
      };
    }

    if (/-----BEGIN (?:PKCS7|CMS)-----/.test(trimmed)) {
      const certificates = tryCertificateBundle(trimmed);
      if (certificates) return { certificates, sourceFormat: 'pkcs7', sourceLabel: sourceLabel('pkcs7') };
    }

    const compact = trimmed.replace(/\s+/g, '');
    const format: CertificateSourceFormat = /^[0-9a-f]+$/i.test(compact) && compact.length % 2 === 0 ? 'hex' : 'base64';
    const certificate = trySingleCertificate(compact);
    if (certificate) return { certificates: [certificate], sourceFormat: format, sourceLabel: sourceLabel(format) };
    const certificates = tryCertificateBundle(compact);
    if (certificates) return { certificates, sourceFormat: 'pkcs7', sourceLabel: sourceLabel('pkcs7') };
  } else {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const certificate = trySingleCertificate(bytes);
    if (certificate) return { certificates: [certificate], sourceFormat: 'der', sourceLabel: sourceLabel('der') };
    const certificates = tryCertificateBundle(bytes);
    if (certificates) return { certificates, sourceFormat: 'pkcs7', sourceLabel: sourceLabel('pkcs7') };
  }
  throw new Error('That does not look like a supported X.509 certificate. Try PEM, DER/CER, Base64 DER, hex DER, or PKCS#7.');
}

function fingerprint(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

function keyDescription(certificate: X509Certificate): string {
  const algorithm = certificate.publicKey.algorithm as Algorithm & {
    modulusLength?: number;
    namedCurve?: string;
    publicExponent?: Uint8Array;
  };
  const name = algorithm.name || 'Unknown';
  if (algorithm.modulusLength) return `RSA · ${algorithm.modulusLength.toLocaleString()} bits`;
  if (algorithm.namedCurve) return `${name.includes('ECD') ? 'Elliptic curve' : name} · ${algorithm.namedCurve}`;
  if (/Ed25519/i.test(name)) return 'Ed25519';
  if (/Ed448/i.test(name)) return 'Ed448';
  return name;
}

function signatureDescription(certificate: X509Certificate): string {
  const algorithm = certificate.signatureAlgorithm as Algorithm & { hash?: Algorithm };
  const name = algorithm.name === 'RSASSA-PKCS1-v1_5' ? 'RSA PKCS#1 v1.5' : algorithm.name;
  return algorithm.hash?.name ? `${algorithm.hash.name} with ${name}` : name || 'Unknown';
}

function extensionSummary(certificate: X509Certificate, oid: string): string {
  if (oid === '2.5.29.17') {
    const san = certificate.getExtension(SubjectAlternativeNameExtension);
    return san ? san.names.items.map(item => `${item.type.toUpperCase()}: ${item.value}`).join(', ') : '';
  }
  if (oid === '2.5.29.19') {
    const constraints = certificate.getExtension(BasicConstraintsExtension);
    if (!constraints) return '';
    return constraints.ca ? `Certificate authority${constraints.pathLength === undefined ? '' : ` · path length ${constraints.pathLength}`}` : 'End-entity certificate';
  }
  if (oid === '2.5.29.15') {
    const usage = certificate.getExtension(KeyUsagesExtension);
    return usage ? KEY_USAGE_FLAGS.filter(([flag]) => Boolean(usage.usages & flag)).map(([, name]) => name).join(', ') : '';
  }
  if (oid === '2.5.29.37') {
    const usage = certificate.getExtension(ExtendedKeyUsageExtension);
    return usage ? usage.usages.map(oidValue => EXTENDED_USAGE_NAMES[String(oidValue)] || String(oidValue)).join(', ') : '';
  }
  return '';
}

export async function inspectCertificate(certificate: X509Certificate, now = new Date()): Promise<CertificateReport> {
  const currentTime = now.getTime();
  const startTime = certificate.notBefore.getTime();
  const endTime = certificate.notAfter.getTime();
  const status = currentTime < startTime ? 'not-yet-valid' : currentTime > endTime ? 'expired' : 'valid';
  const daysRemaining = Math.ceil((endTime - currentTime) / 86_400_000);
  const san = certificate.getExtension(SubjectAlternativeNameExtension);
  const constraints = certificate.getExtension(BasicConstraintsExtension);
  const keyUsage = certificate.getExtension(KeyUsagesExtension);
  const extendedUsage = certificate.getExtension(ExtendedKeyUsageExtension);
  const crypto = globalThis.crypto;
  const [sha1, sha256, selfSigned] = await Promise.all([
    certificate.getThumbprint('SHA-1', crypto),
    certificate.getThumbprint('SHA-256', crypto),
    certificate.isSelfSigned(crypto).catch(() => certificate.subject === certificate.issuer),
  ]);

  return {
    certificate,
    subject: certificate.subject,
    issuer: certificate.issuer,
    serialNumber: certificate.serialNumber.toUpperCase(),
    notBefore: certificate.notBefore,
    notAfter: certificate.notAfter,
    status,
    statusLabel: status === 'expired'
      ? `Expired ${Math.abs(daysRemaining).toLocaleString()} day${Math.abs(daysRemaining) === 1 ? '' : 's'} ago`
      : status === 'not-yet-valid'
        ? `Valid in ${Math.ceil((startTime - currentTime) / 86_400_000).toLocaleString()} days`
        : daysRemaining === 0
          ? 'Expires today'
          : `Valid · ${daysRemaining.toLocaleString()} day${daysRemaining === 1 ? '' : 's'} remaining`,
    daysRemaining,
    selfSigned,
    signatureAlgorithm: signatureDescription(certificate),
    publicKey: keyDescription(certificate),
    subjectAlternativeNames: san ? san.names.items.map(item => ({ type: item.type, value: item.value })) : [],
    isCertificateAuthority: constraints?.ca || false,
    pathLength: constraints?.pathLength,
    keyUsages: keyUsage ? KEY_USAGE_FLAGS.filter(([flag]) => Boolean(keyUsage.usages & flag)).map(([, name]) => name) : [],
    extendedKeyUsages: extendedUsage ? extendedUsage.usages.map(value => EXTENDED_USAGE_NAMES[String(value)] || String(value)) : [],
    sha1Fingerprint: fingerprint(sha1),
    sha256Fingerprint: fingerprint(sha256),
    extensions: certificate.extensions.map(extension => ({
      name: (extension.constructor as { NAME?: string }).NAME || 'Extension',
      oid: extension.type,
      critical: extension.critical,
      summary: extensionSummary(certificate, extension.type),
    })),
    textDump: certificate.toString('text'),
  };
}

export async function inspectCertificates(certificates: X509Certificate[]): Promise<CertificateReport[]> {
  return Promise.all(certificates.map(certificate => inspectCertificate(certificate)));
}

export function certificatePem(certificate: X509Certificate): string {
  return certificate.toString('pem');
}

export function certificateDer(certificate: X509Certificate): ArrayBuffer {
  return certificate.rawData.slice(0);
}

export function certificateBase64(certificate: X509Certificate): string {
  return certificate.toString('base64');
}

export function certificateHex(certificate: X509Certificate): string {
  return certificate.toString('hex').toUpperCase();
}

export function certificateChainPem(certificates: X509Certificate[]): string {
  return certificates.map(certificate => certificate.toString('pem')).join('\n');
}

export function certificateBundlePem(certificates: X509Certificate[]): string {
  return new X509Certificates(certificates).toString('pem');
}

export function certificateBundleDer(certificates: X509Certificate[]): ArrayBuffer {
  return new X509Certificates(certificates).export('raw');
}

export function reportToJson(report: CertificateReport): string {
  return JSON.stringify({
    subject: report.subject,
    issuer: report.issuer,
    serialNumber: report.serialNumber,
    validity: {
      notBefore: report.notBefore.toISOString(),
      notAfter: report.notAfter.toISOString(),
      status: report.status,
      daysRemaining: report.daysRemaining,
    },
    selfSigned: report.selfSigned,
    certificateAuthority: report.isCertificateAuthority,
    pathLength: report.pathLength,
    signatureAlgorithm: report.signatureAlgorithm,
    publicKey: report.publicKey,
    subjectAlternativeNames: report.subjectAlternativeNames,
    keyUsages: report.keyUsages,
    extendedKeyUsages: report.extendedKeyUsages,
    fingerprints: { sha1: report.sha1Fingerprint, sha256: report.sha256Fingerprint },
    extensions: report.extensions,
  }, null, 2);
}
