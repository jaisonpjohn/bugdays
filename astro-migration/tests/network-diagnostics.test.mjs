import assert from 'node:assert/strict';
import test from 'node:test';
import { dnsReportRows, dnsReportsDiffer, normalizeDnsTarget, selectedDnsTypes, validateDnsSource } from '../src/lib/dns-lookup.ts';
import { analyzeTlsConnection, certificateMatchesIdentity, dnsPatternMatches, tlsInspectionErrorMessage, validateTlsInspectResult } from '../src/lib/tls-certificate-check.ts';

test('DNS targets accept URLs and ports while IPs select PTR', () => {
  assert.equal(normalizeDnsTarget('https://Api.Example.com:8443/path'), 'api.example.com');
  assert.equal(normalizeDnsTarget('example.com:443'), 'example.com');
  assert.equal(normalizeDnsTarget('[2001:db8::1]'), '2001:db8::1');
  assert.deepEqual(selectedDnsTypes('8.8.8.8', ['A', 'TXT']), ['PTR']);
  assert.throws(() => normalizeDnsTarget('user@example.com/path'));
});

test('DNS reports distinguish resolver answer data and export stable rows', () => {
  const source = resolver => ({ query: 'app.internal', resolver, reverseLookup: false, elapsedMs: 5, forwardAddresses: [], results: [{ recordType: 'A', status: 'NOERROR', elapsedMs: 5, answers: [{ name: 'app.internal', type: 'A', ttl: 60, data: resolver === 'public' ? '192.0.2.1' : '10.0.0.4' }] }] });
  const report = { version: 1, target: 'app.internal', lookedUpAt: new Date(0).toISOString(), requestedTypes: ['A'], sources: [source('public'), source('system')] };
  assert.equal(dnsReportsDiffer(report), true);
  assert.equal(dnsReportRows(report).length, 3);
  assert.equal(dnsReportRows(report)[0][0], 'Resolver');
});

test('system DNS response validation bounds imported and shared data', () => {
  const valid = validateDnsSource({
    query: '1.1.1.1', resolver: 'system', reverseLookup: true, elapsedMs: 10,
    results: [{ recordType: 'PTR', status: 'NOERROR', elapsedMs: 8, answers: [{ name: '1.1.1.1.in-addr.arpa.', type: 'PTR', ttl: 60, data: 'one.one.one.one' }] }],
    forwardConfirmed: true, forwardAddresses: ['1.1.1.1'],
  }, 'system', '1.1.1.1');
  assert.equal(valid.forwardConfirmed, true);
  assert.throws(() => validateDnsSource({ query: '1.1.1.1', resolver: 'system', results: [{ recordType: 'PTR', status: 'NOERROR', answers: [{ data: '<script>' }] }] }, 'system', '1.1.1.1'));
});

test('TLS hostname matching follows exact, wildcard, and IP SAN rules', () => {
  assert.equal(dnsPatternMatches('*.example.com', 'api.example.com'), true);
  assert.equal(dnsPatternMatches('*.example.com', 'v2.api.example.com'), false);
  assert.equal(dnsPatternMatches('*.example.com', 'example.com'), false);
  const report = { subject: 'CN=legacy.example.com', subjectAlternativeNames: [{ type: 'dns', value: '*.example.com' }, { type: 'ip', value: '10.0.0.8' }] };
  assert.equal(certificateMatchesIdentity(report, 'api.example.com').matches, true);
  assert.equal(certificateMatchesIdentity(report, '10.0.0.8').matches, true);
  assert.equal(certificateMatchesIdentity(report, '10.0.0.9').matches, false);
});

test('TLS analysis flags a mismatched, untrusted, expiring chain', () => {
  const leaf = {
    subject: 'CN=wrong.example.com', issuer: 'CN=Example Intermediate', status: 'valid', statusLabel: 'Valid · 4 days remaining', daysRemaining: 4,
    notBefore: new Date('2026-01-01T00:00:00Z'), notAfter: new Date('2026-09-20T00:00:00Z'), selfSigned: false,
    signatureAlgorithm: 'SHA-256 with RSA', publicKey: 'RSA · 2,048 bits', subjectAlternativeNames: [{ type: 'dns', value: 'wrong.example.com' }],
    isCertificateAuthority: false, extendedKeyUsages: ['TLS web server authentication'],
  };
  const result = { host: 'api.example.com', port: 443, serverName: 'api.example.com', peerAddress: '192.0.2.1:443', validation: { trusted: false, error: 'Unknown issuer' }, certificates: [{ position: 0, derBase64: 'MA==' }], connectedAt: Date.now(), elapsedMs: 10 };
  const analysis = analyzeTlsConnection(result, [leaf]);
  assert.equal(analysis.identityMatches, false);
  assert.ok(analysis.issues.some(issue => issue.title === 'Name mismatch'));
  assert.ok(analysis.issues.some(issue => issue.title === 'Leaf certificate expires soon'));
  assert.ok(analysis.issues.some(issue => issue.title === 'Intermediate certificate may be missing'));
});

test('TLS analysis separates SNI coverage from direct IP SAN coverage', () => {
  const leaf = {
    subject: 'CN=bugdays.com', issuer: 'CN=Example CA', status: 'valid', statusLabel: 'Valid', daysRemaining: 60,
    notBefore: new Date('2026-01-01T00:00:00Z'), notAfter: new Date('2027-01-01T00:00:00Z'), selfSigned: false,
    signatureAlgorithm: 'ECDSA with SHA-256', publicKey: 'EC · P-256', subjectAlternativeNames: [{ type: 'dns', value: 'bugdays.com' }],
    isCertificateAuthority: false, extendedKeyUsages: ['TLS web server authentication'],
  };
  const result = { host: '104.21.96.82', port: 443, serverName: 'bugdays.com', peerAddress: '104.21.96.82:443', validation: { trusted: true }, certificates: [{ position: 0, derBase64: 'MA==' }], connectedAt: Date.now(), elapsedMs: 10 };
  const analysis = analyzeTlsConnection(result, [leaf]);
  assert.equal(analysis.identityMatches, true);
  assert.equal(analysis.connectionTargetMatches, false);
  assert.ok(analysis.issues.some(issue => issue.title === 'IP address is not covered'));
});

test('TLS handshake failures by bare IP explain when SNI is required', () => {
  const message = tlsInspectionErrorMessage(new Error('TLS handshake failed: received fatal alert: HandshakeFailure'), '104.21.96.82', '104.21.96.82');
  assert.match(message, /require a hostname \(SNI\)/);
  assert.equal(tlsInspectionErrorMessage(new Error('Connection refused'), '104.21.96.82', '104.21.96.82'), 'Connection refused');
});

test('TLS bridge snapshots are strictly validated before rendering', () => {
  const valid = validateTlsInspectResult({
    host: 'example.com', port: 443, serverName: 'example.com', peerAddress: '192.0.2.1:443',
    validation: { trusted: true }, certificates: [{ position: 0, derBase64: 'MA==' }], connectedAt: 1, elapsedMs: 4,
  });
  assert.equal(valid.validation.trusted, true);
  assert.throws(() => validateTlsInspectResult({ ...valid, certificates: [{ position: 0, derBase64: '<script>' }] }));
});
