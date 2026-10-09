'use strict';

const tls = require('node:tls');
const { domainToASCII } = require('node:url');

const TIMEOUT_MS = 10_000;
const HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/;

// Accepts what people paste ("https://Example.com/path") and returns a bare
// lowercase hostname, or null when it is not a public-looking domain name.
function normalizeHost(input) {
  if (typeof input !== 'string') return null;
  const bare = input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
  const host = domainToASCII(bare);
  return HOST_RE.test(host) ? host : null;
}

function firstOf(value) {
  return Array.isArray(value) ? value[0] : value;
}

// cert is the object returned by tlsSocket.getPeerCertificate().
function parseCertificate(cert) {
  if (!cert || !cert.valid_to) return { ok: false, error: 'Server did not present a certificate' };
  const expires = new Date(cert.valid_to);
  if (Number.isNaN(expires.getTime())) return { ok: false, error: 'Certificate has an unreadable expiry date' };
  const from = new Date(cert.valid_from);
  const issuer = cert.issuer || {};
  const subject = cert.subject || {};
  return {
    ok: true,
    expiresAt: expires.toISOString(),
    validFrom: Number.isNaN(from.getTime()) ? null : from.toISOString(),
    issuer: firstOf(issuer.O) || firstOf(issuer.CN) || null,
    subject: firstOf(subject.CN) || null,
    fingerprint: cert.fingerprint256 || null,
  };
}

function readCertificate(host, port, timeout) {
  return new Promise((resolve) => {
    // rejectUnauthorized is off so expired or untrusted certificates can still
    // be read; trust is reported separately.
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false });
    const finish = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout, () => finish({ ok: false, error: `Timed out connecting to ${host}:${port}` }));
    socket.once('error', (err) => finish({ ok: false, error: `Could not connect: ${err.code || err.message}` }));
    socket.once('secureConnect', () => {
      const result = parseCertificate(socket.getPeerCertificate());
      if (result.ok) {
        result.trusted = socket.authorized;
        result.trustError = socket.authorized ? null : String(socket.authorizationError || 'Not trusted');
      }
      finish(result);
    });
  });
}

// One retry, so a dropped connection does not show as a failed check for a day.
async function checkSsl(host, { port = 443, timeout = TIMEOUT_MS } = {}) {
  const first = await readCertificate(host, port, timeout);
  return first.ok ? first : readCertificate(host, port, timeout);
}

function eventDate(events, action) {
  const event = (events || []).find((e) => e.eventAction === action);
  const date = event && new Date(event.eventDate);
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

function registrarName(entities) {
  const registrar = (entities || []).find((e) => (e.roles || []).includes('registrar'));
  if (!registrar) return null;
  const vcard = (registrar.vcardArray && registrar.vcardArray[1]) || [];
  const fn = vcard.find((field) => field[0] === 'fn');
  return (fn && fn[3]) || registrar.handle || null;
}

// body is an RDAP domain response (RFC 9083).
function parseRdap(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Registry returned an unreadable response' };
  const detail = {
    domain: (body.ldhName || '').toLowerCase() || null,
    registrar: registrarName(body.entities),
    registeredAt: eventDate(body.events, 'registration'),
    statuses: body.status || [],
  };
  const expiresAt = eventDate(body.events, 'expiration');
  if (!expiresAt) return { ok: false, unsupported: true, error: 'Registry does not publish an expiry date for this domain', ...detail };
  return { ok: true, expiresAt, ...detail };
}

// Looks a domain up through the rdap.org bootstrap, which redirects to the
// registry that owns the TLD. Subdomains are not registered objects, so on
// "not found" the leftmost label is dropped and the parent is tried.
async function checkRegistration(host, { fetch = globalThis.fetch, baseUrl = 'https://rdap.org', timeout = TIMEOUT_MS } = {}) {
  let name = host;
  for (;;) {
    let res;
    try {
      res = await fetch(`${baseUrl}/domain/${name}`, {
        // rdap.org turns away requests that carry Node's default user agent.
        headers: { accept: 'application/rdap+json', 'user-agent': 'ssl-tracker/1.0' },
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      const reason = err.name === 'TimeoutError' ? 'timed out' : (err.cause && err.cause.code) || err.message;
      return { ok: false, error: `Registration lookup failed: ${reason}` };
    }
    if (res.ok) {
      let body;
      try {
        body = await res.json();
      } catch {
        return { ok: false, error: 'Registry returned an unreadable response' };
      }
      const result = parseRdap(body);
      return { ...result, domain: result.domain || name };
    }
    if (res.status === 404 || res.status === 400) {
      const problem = await res.json().catch(() => ({}));
      if (/no rdap service/i.test(problem.title || '')) {
        const tld = name.split('.').pop();
        return { ok: false, unsupported: true, error: `The .${tld} registry does not offer registration lookups (RDAP)` };
      }
      const parent = name.split('.').slice(1).join('.');
      if (parent.includes('.')) {
        name = parent;
        continue;
      }
      return { ok: false, error: 'No registration record found for this domain' };
    }
    if (res.status === 429) return { ok: false, error: 'Registration lookup was rate limited. It will be retried.' };
    return { ok: false, error: `Registration lookup failed (HTTP ${res.status})` };
  }
}

module.exports = { normalizeHost, parseCertificate, checkSsl, parseRdap, checkRegistration };
