'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
const { normalizeHost, parseCertificate, checkSsl, parseRdap, checkRegistration } = require('../lib/checks');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name));

test('normalizeHost cleans pasted input and rejects non-domains', () => {
  assert.equal(normalizeHost('  HTTPS://Example.com/path?q=1 '), 'example.com');
  assert.equal(normalizeHost('sub.example.co.uk:443'), 'sub.example.co.uk');
  assert.equal(normalizeHost('example.com.'), 'example.com');
  assert.equal(normalizeHost('bücher.de'), 'xn--bcher-kva.de');
  for (const bad of ['', 'localhost', '192.168.1.1', 'exa mple.com', '-a.com', 'a..com', null, 42]) {
    assert.equal(normalizeHost(bad), null, String(bad));
  }
});

test('parseCertificate reads expiry, issuer and subject', () => {
  const result = parseCertificate({
    subject: { CN: 'example.com' },
    issuer: { C: 'US', O: "Let's Encrypt", CN: 'R11' },
    valid_from: 'Sep  3 12:00:00 2026 GMT',
    valid_to: 'Nov  2 12:00:00 2026 GMT',
    fingerprint256: 'AB:CD',
  });
  assert.deepEqual(result, {
    ok: true,
    expiresAt: '2026-11-02T12:00:00.000Z',
    validFrom: '2026-09-03T12:00:00.000Z',
    issuer: "Let's Encrypt",
    subject: 'example.com',
    fingerprint: 'AB:CD',
  });
});

test('parseCertificate falls back to the issuer common name', () => {
  const result = parseCertificate({ issuer: { CN: ['Amazon RSA 2048 M03'] }, valid_to: 'Feb 27 00:00:00 2027 GMT' });
  assert.equal(result.issuer, 'Amazon RSA 2048 M03');
  assert.equal(result.subject, null);
  assert.equal(result.validFrom, null);
});

test('parseCertificate reports a missing or unreadable certificate', () => {
  assert.equal(parseCertificate({}).ok, false);
  assert.equal(parseCertificate(null).ok, false);
  assert.equal(parseCertificate({ valid_to: 'not a date' }).ok, false);
});

test('checkSsl reads the certificate from a live TLS server', async (t) => {
  const server = tls.createServer({ cert: fixture('localhost-cert.pem'), key: fixture('localhost-key.pem') });
  server.on('tlsClientError', () => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const result = await checkSsl('localhost', { port: server.address().port });
  assert.equal(result.ok, true);
  assert.equal(result.expiresAt, '2036-10-06T05:44:42.000Z');
  assert.equal(result.issuer, 'Test Issuer Org');
  assert.equal(result.subject, 'localhost');
  assert.equal(result.trusted, false); // self-signed
  assert.ok(result.trustError);
});

test('checkSsl fails gracefully when nothing is listening', async () => {
  const server = tls.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));

  const result = await checkSsl('localhost', { port });
  assert.equal(result.ok, false);
  assert.match(result.error, /Could not connect/);
});

const rdapBody = {
  objectClassName: 'domain',
  ldhName: 'EXAMPLE.COM',
  status: ['client transfer prohibited'],
  events: [
    { eventAction: 'registration', eventDate: '1995-08-14T04:00:00Z' },
    { eventAction: 'expiration', eventDate: '2027-08-13T04:00:00Z' },
    { eventAction: 'last changed', eventDate: '2026-08-14T08:01:43Z' },
  ],
  entities: [
    { roles: ['abuse'], handle: 'x' },
    { roles: ['registrar'], handle: '376', vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'Namecheap, Inc.']]] },
  ],
};

test('parseRdap reads expiry, registration date and registrar', () => {
  assert.deepEqual(parseRdap(rdapBody), {
    ok: true,
    expiresAt: '2027-08-13T04:00:00.000Z',
    domain: 'example.com',
    registrar: 'Namecheap, Inc.',
    registeredAt: '1995-08-14T04:00:00.000Z',
    statuses: ['client transfer prohibited'],
  });
});

test('parseRdap falls back to the registrar handle', () => {
  const result = parseRdap({ ...rdapBody, entities: [{ roles: ['registrar'], handle: '376' }] });
  assert.equal(result.registrar, '376');
});

test('parseRdap fails when the registry publishes no expiry', () => {
  const result = parseRdap({ ldhName: 'example.ch', events: [{ eventAction: 'registration', eventDate: '2001-01-01T00:00:00Z' }] });
  assert.equal(result.ok, false);
  assert.match(result.error, /expiry date/);
  assert.equal(result.unsupported, true);
  assert.equal(result.registrar, null);
  assert.equal(parseRdap('nope').ok, false);
});

// Fake rdap.org: answers from a { 'domain': [status, body] } table.
function fakeRdap(table) {
  const asked = [];
  const fetch = async (url) => {
    const name = url.split('/domain/')[1];
    asked.push(name);
    const [status, body] = table[name] || [404, {}];
    return { ok: status === 200, status, json: async () => body };
  };
  return { fetch, asked };
}

test('checkRegistration walks up from a subdomain to the registered domain', async () => {
  const { fetch, asked } = fakeRdap({ 'example.com': [200, rdapBody] });
  const result = await checkRegistration('shop.www.example.com', { fetch });
  assert.equal(result.ok, true);
  assert.equal(result.domain, 'example.com');
  assert.deepEqual(asked, ['shop.www.example.com', 'www.example.com', 'example.com']);
});

test('checkRegistration reports TLDs without RDAP, without retrying parents', async () => {
  const { fetch, asked } = fakeRdap({ 'www.nic.de': [404, { title: 'No RDAP service is available for this resource' }] });
  const result = await checkRegistration('www.nic.de', { fetch });
  assert.equal(result.ok, false);
  assert.equal(result.unsupported, true);
  assert.match(result.error, /\.de registry/);
  assert.deepEqual(asked, ['www.nic.de']);
});

test('checkRegistration handles not found, rate limits, server errors and network failures', async () => {
  const notFound = fakeRdap({});
  assert.match((await checkRegistration('nope.com', { fetch: notFound.fetch })).error, /No registration record/);
  assert.deepEqual(notFound.asked, ['nope.com']);

  assert.match((await checkRegistration('a.com', { fetch: fakeRdap({ 'a.com': [429, {}] }).fetch })).error, /rate limited/);
  assert.match((await checkRegistration('a.com', { fetch: fakeRdap({ 'a.com': [503, {}] }).fetch })).error, /HTTP 503/);

  const offline = async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  };
  const result = await checkRegistration('a.com', { fetch: offline });
  assert.deepEqual(result, { ok: false, error: 'Registration lookup failed: ENOTFOUND' });
});
