// Synthetic public certificates only. Test signing keys are generated in memory, never exported.
import 'reflect-metadata';
import { BasicConstraintsExtension, KeyUsagesExtension, KeyUsageFlags, SubjectAlternativeNameExtension, ExtendedKeyUsageExtension, X509CertificateGenerator } from '@peculiar/x509';

export async function certificateFixture() {
  const algorithm = { name: 'ECDSA', namedCurve: 'P-256' };
  const signingAlgorithm = { name: 'ECDSA', hash: 'SHA-256' };
  const keys = await Promise.all([0, 1, 2, 3].map(() => crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])));
  const dates = { notBefore: new Date('2026-01-01T00:00:00Z'), notAfter: new Date('2036-01-01T00:00:00Z') };
  const caExtensions = [new BasicConstraintsExtension(true, 2, true), new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true)];
  const root = await X509CertificateGenerator.createSelfSigned({ name: 'CN=Example Test Root', keys: keys[0], signingAlgorithm, serialNumber: '01', ...dates, extensions: caExtensions }, crypto);
  const intermediate = await X509CertificateGenerator.create({ subject: 'CN=Example Test Intermediate', issuer: root.subject, publicKey: keys[1].publicKey, signingKey: keys[0].privateKey, signingAlgorithm, serialNumber: '02', ...dates, extensions: caExtensions }, crypto);
  const leafParams = { subject: 'CN=example.test', issuer: intermediate.subject, publicKey: keys[2].publicKey, signingKey: keys[1].privateKey, signingAlgorithm, serialNumber: '03', ...dates, extensions: [new BasicConstraintsExtension(false, undefined, true), new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true), new ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1']), new SubjectAlternativeNameExtension([{ type: 'dns', value: 'example.test' }, { type: 'dns', value: '*.example.test' }, { type: 'dns', value: 'xn--bcher-kva.example' }, { type: 'ip', value: '127.0.0.1' }, { type: 'ip', value: '2001:db8::1' }])] };
  const leaf = await X509CertificateGenerator.create(leafParams, crypto);
  const wrongIssuer = await X509CertificateGenerator.create({ subject: intermediate.subject, issuer: root.subject, publicKey: keys[3].publicKey, signingKey: keys[0].privateKey, signingAlgorithm, serialNumber: '04', ...dates, extensions: caExtensions }, crypto);
  const cnOnly = await X509CertificateGenerator.create({ ...leafParams, extensions: [], serialNumber: '05' }, crypto);
  return { root, intermediate, leaf, wrongIssuer, cnOnly, chain: [leaf, intermediate, root] };
}
