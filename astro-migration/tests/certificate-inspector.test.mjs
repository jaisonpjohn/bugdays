import assert from 'node:assert/strict';
import test from 'node:test';
import { certificateFixture } from './fixtures/certificate-chain.mjs';
import { parseCertificateInput, inspectCertificate, inspectCertificates, certificatePem, certificateDer, certificateBase64, certificateHex, certificateChainPem, certificateBundlePem, certificateBundleDer, MAX_CERTIFICATE_BYTES } from '../src/lib/certificate-inspector.ts';
import { analyzeCertificateChain, certificateReportRows } from '../src/lib/certificate-chain.ts';
import { certificateMatchesIdentity, normalizeCertificateIdentity } from '../src/lib/tls-certificate-check.ts';

const fixture = await certificateFixture();
const now = new Date('2026-10-14T12:00:00Z');
test('all single-certificate conversions preserve signed DER and fingerprints', async () => {
  const expected = (await inspectCertificate(fixture.leaf, now)).sha256Fingerprint;
  for (const [input, format] of [[certificatePem(fixture.leaf), 'pem'], [certificateDer(fixture.leaf), 'der'], [certificateBase64(fixture.leaf), 'base64'], [certificateHex(fixture.leaf), 'hex']]) {
    const parsed = parseCertificateInput(input);
    assert.equal(parsed.sourceFormat, format);
    assert.equal(parsed.certificates.length, 1);
    assert.equal((await inspectCertificate(parsed.certificates[0], now)).sha256Fingerprint, expected);
  }
});
test('PEM chains and PEM/binary PKCS7 retain every certificate', () => {
  for (const input of [certificateChainPem(fixture.chain), certificateBundlePem(fixture.chain), certificateBundleDer(fixture.chain)]) {
    const parsed = parseCertificateInput(input);
    assert.equal(parsed.certificates.length, 3);
    assert.deepEqual(new Set(parsed.certificates.map(item => item.serialNumber)), new Set(fixture.chain.map(item => item.serialNumber)));
  }
});
test('rejects private-key variants even beside a valid certificate', () => {
  for (const label of ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'DSA PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'ENCRYPTED PRIVATE KEY']) {
    assert.throws(() => parseCertificateInput(`${certificatePem(fixture.leaf)}\n-----BEGIN ${label}-----\nsynthetic-test-only\n-----END ${label}-----`), /public certificate/);
  }
});
test('bounded input rejects empty, malformed, oversized, incomplete and trailing DER data', () => {
  for (const input of ['', 'hello world', 'abcd', new Uint8Array(), new Uint8Array([...new Uint8Array(certificateDer(fixture.leaf)), 0])]) assert.throws(() => parseCertificateInput(input));
  assert.throws(() => parseCertificateInput('x'.repeat(MAX_CERTIFICATE_BYTES + 1)), /5 MiB/);
  assert.throws(() => parseCertificateInput(certificateChainPem(Array(21).fill(fixture.leaf))), /20 certificates/);
  assert.throws(() => parseCertificateInput(`${certificatePem(fixture.leaf)}\n-----BEGIN CERTIFICATE-----\nMI`), /incomplete/);
});
test('validity boundaries and sub-day labels are truthful', async () => {
  const end = fixture.leaf.notAfter.getTime();
  assert.equal((await inspectCertificate(fixture.leaf, new Date(end))).status, 'valid');
  const expired = await inspectCertificate(fixture.leaf, new Date(end + 60_000));
  assert.equal(expired.daysRemaining, -1);
  assert.equal(expired.statusLabel, 'Expired 1 minute ago');
  assert.match((await inspectCertificate(fixture.leaf, new Date(end - 3_600_000))).statusLabel, /1 hour remaining/);
  assert.match((await inspectCertificate(fixture.leaf, new Date(fixture.leaf.notBefore.getTime() - 1000))).statusLabel, /Valid in less than a minute/);
});
test('SAN checks cover IDN, IPv6, wildcard depth and never fall back to Common Name', async () => {
  const leaf = await inspectCertificate(fixture.leaf, now);
  for (const identity of ['example.test', 'API.example.test.', '127.0.0.1', '[2001:db8:0:0::1]', 'bücher.example']) assert.equal(certificateMatchesIdentity(leaf, identity).matches, true, identity);
  for (const identity of ['example.invalid', 'deep.api.example.test', '127.0.0.2']) assert.equal(certificateMatchesIdentity(leaf, identity).matches, false, identity);
  assert.equal(certificateMatchesIdentity(await inspectCertificate(fixture.cnOnly, now), 'example.test').matches, false);
  for (const identity of ['https://example.test', '*.example.test', 'example.test/path', '0127.0.0.1', 'a..test', 'a_test', 'bad\\host']) assert.throws(() => normalizeCertificateIdentity(identity), identity);
});
test('supplied issuer signatures verify independently of trust and certificate order', async () => {
  const reports = await inspectCertificates(fixture.chain, now);
  const analysis = await analyzeCertificateChain(reports);
  assert.deepEqual(analysis.links.map(item => item.status), ['verified', 'verified', 'self-signed']);
  assert.equal(analysis.links[0].issuerIndex, 1);
  assert.equal(analysis.issues[0].severity, 'pass');
  const shuffled = await analyzeCertificateChain([reports[2], reports[0], reports[1]]);
  assert.ok(shuffled.issues.some(item => /elsewhere/.test(item.title)));
  const rows = certificateReportRows(reports, analysis);
  assert.equal(rows.length, 4);
  assert.ok(rows[1].includes('verified'));
});
test('wrong issuer keys, missing issuers and duplicate certificates are not false verification passes', async () => {
  const wrong = await analyzeCertificateChain(await inspectCertificates([fixture.leaf, fixture.wrongIssuer], now));
  assert.equal(wrong.links[0].status, 'invalid');
  assert.ok(wrong.issues.some(item => /did not verify/.test(item.title)));
  const single = await analyzeCertificateChain(await inspectCertificates([fixture.leaf], now));
  assert.equal(single.links[0].status, 'issuer-not-supplied');
  const duplicate = await analyzeCertificateChain(await inspectCertificates([...fixture.chain, fixture.leaf], now));
  assert.ok(duplicate.issues.some(item => /duplicate/.test(item.title)));
});
test('unsupported self-signature verification stays unknown rather than self-signed by name', async () => {
  const cert = new Proxy(fixture.root, { get(target, property) { if (property === 'isSelfSigned') return async () => { throw new Error('unsupported'); }; const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value; } });
  assert.equal((await inspectCertificate(cert, now)).selfSigned, null);
});
