'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { daysLeft, normalizeThresholds, DAY_MS } = require('./alerts');
const { normalizeHost } = require('./checks');
const { createAuth } = require('./auth');

const MAX_BODY = 100_000;
// How long a failed or bounced delivery stays listed in the settings response.
const PROBLEM_DAYS = 30;
// The scheduler ticks hourly; this long without a completed tick means it has stopped.
const STALLED_MS = 3 * 3_600_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
const READ_ONLY = ['GET', 'HEAD', 'OPTIONS'];
// The only API routes that answer without a session.
const NO_SESSION_NEEDED = ['/api/login', '/api/session', '/api/health'];
// The stylesheet loads its fonts from Google Fonts, and the domain list sets a
// style attribute on each row; nothing else may come from outside or inline.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "style-src-attr 'unsafe-inline'",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
const SECURITY_HEADERS = {
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

// The hostname of a Host header or of an entry in a host list ("example.com",
// "example.com:3000", "[::1]:3000"), or null when it is not one.
function hostnameOf(value) {
  if (typeof value !== 'string' || !/^[^\s\/@?#\\]+$/.test(value)) return null;
  try {
    return new URL(`http://${value}`).hostname || null;
  } catch {
    return null;
  }
}

function originOf(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

// Worst first: a domain's overall status is the worst of its two checks.
// "unsupported" (a registry with no expiry lookup) is permanent, so it is left
// out unless there is nothing else to go on.
const SEVERITY = ['expired', 'failed', 'soon', 'pending', 'healthy'];

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  // Requiring JSON also stops other websites from posting to this app with a plain form.
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
    throw new HttpError(415, 'Send the request body as application/json');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body is too large');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {}
  throw new HttpError(400, 'Request body must be a JSON object');
}

// allowedHosts: hostnames the app may be opened at besides loopback and the
// host of publicUrl. passwordHash: empty turns the login off. trustProxy: a
// reverse proxy in front supplies the client address.
function createApp({
  store,
  monitor,
  notifier,
  backups,
  publicDir,
  publicUrl = '',
  allowedHosts = [],
  passwordHash = '',
  trustProxy = false,
  now = () => new Date(),
}) {
  const startedAt = now();
  const publicOrigin = originOf(publicUrl);
  const auth = createAuth({ store, passwordHash, trustProxy, now, secure: Boolean(publicOrigin && publicOrigin.protocol === 'https:') });
  const hosts = new Set([...LOOPBACK, publicOrigin && publicOrigin.hostname, ...allowedHosts.map(hostnameOf)].filter(Boolean));

  // These two checks stop another website from reaching the app through the
  // browser of someone who is signed in (or, with the login off, of anyone).
  function guard(req) {
    // DNS rebinding: a page on evil.example re-points its own name at this
    // machine and is then, to the browser, same-origin with the app. The Host
    // header still says evil.example.
    if (!hosts.has(hostnameOf(req.headers.host))) {
      throw new HttpError(403, 'This address is not allowed to reach the tracker. Set PUBLIC_URL or ALLOWED_HOSTS to the address you open it at.');
    }
    // Cross-site requests: any page can post a form here, and the routes that
    // take no body have no JSON content type to refuse. Browsers always say
    // where such a request came from.
    const { origin } = req.headers;
    if (READ_ONLY.includes(req.method) || origin === undefined) return;
    const from = originOf(origin);
    const same = from && (from.host === req.headers.host.toLowerCase() || (publicOrigin && from.origin === publicOrigin.origin));
    if (!same) throw new HttpError(403, 'Requests from other websites are not allowed');
  }

  // Unhealthy means the scheduler has stopped ticking. A tick that completed
  // with errors still counts as alive; lastTick says what went wrong. Without
  // a session the answer is up or down and nothing more.
  function health(req) {
    const { lastTick, heartbeat } = monitor.status();
    const ok = now() - (lastTick ? new Date(lastTick.at) : startedAt) < STALLED_MS;
    if (!auth.signedIn(req)) return [ok ? 200 : 503, { ok }];
    const body = {
      ok,
      startedAt: startedAt.toISOString(),
      lastTick,
      domains: store.listDomains().length,
      lastBackupAt: backups ? backups.lastAt() : null,
      heartbeat,
    };
    return [ok ? 200 : 503, body];
  }

  function describeCheck(domain, kind, soonDays) {
    const latest = store.latestCheck(domain.id, kind);
    if (!latest) return null;
    // After a failed check, keep showing the last dates that were read successfully.
    const known = latest.ok ? latest : store.latestOkCheck(domain.id, kind);
    const expiresAt = known ? known.expiresAt : null;
    const left = expiresAt ? daysLeft(expiresAt, now()) : null;
    let status = latest.detail.unsupported ? 'unsupported' : 'failed';
    if (latest.ok) status = new Date(expiresAt) <= now() ? 'expired' : left <= soonDays ? 'soon' : 'healthy';
    return {
      status,
      ok: latest.ok,
      checkedAt: latest.checkedAt,
      error: latest.error,
      expiresAt,
      daysLeft: left,
      stale: !latest.ok && Boolean(known),
      ...(known ? known.detail : latest.detail),
    };
  }

  function describeDomain(domain) {
    const settings = store.getSettings();
    const soon = (thresholds) => (thresholds.length ? Math.max(...thresholds) : 30);
    const ssl = describeCheck(domain, 'ssl', soon(settings.sslThresholds));
    const registration = describeCheck(domain, 'registration', soon(settings.registrationThresholds));
    const statuses = [ssl, registration].map((c) => (c ? c.status : 'pending'));
    return {
      id: domain.id,
      host: domain.host,
      createdAt: domain.createdAt,
      status: SEVERITY.find((s) => statuses.includes(s) && s !== 'unsupported') || 'unsupported',
      ssl,
      registration,
    };
  }

  function describeSettings() {
    const settings = store.getSettings();
    const email = notifier.emailStatus(settings);
    return {
      settings: { ...settings, emailTo: email.to },
      email: { configured: email.configured, from: email.from, last: store.lastDelivery('email') },
      push: { subscriptions: store.countSubscriptions(), last: store.lastDelivery('push') },
      deliveryProblems: store.deliveryProblems(new Date(now() - PROBLEM_DAYS * DAY_MS).toISOString()),
    };
  }

  function requireDomain(id) {
    const domain = store.getDomain(Number(id));
    if (!domain) throw new HttpError(404, 'Domain not found');
    return domain;
  }

  function validateSettings(body) {
    const patch = {};
    for (const key of ['sslThresholds', 'registrationThresholds']) {
      if (!(key in body)) continue;
      patch[key] = normalizeThresholds(body[key]);
      if (!patch[key]) throw new HttpError(400, `${key} must be a list of whole days between 1 and 365`);
    }
    for (const key of ['emailEnabled', 'pushEnabled']) {
      if (!(key in body)) continue;
      if (typeof body[key] !== 'boolean') throw new HttpError(400, `${key} must be true or false`);
      patch[key] = body[key];
    }
    if ('emailTo' in body) {
      const emailTo = typeof body.emailTo === 'string' ? body.emailTo.trim() : null;
      if (emailTo === null || (emailTo && !EMAIL_RE.test(emailTo))) throw new HttpError(400, 'emailTo must be an email address');
      patch.emailTo = emailTo;
    }
    return patch;
  }

  const routes = [
    ['GET', /^\/api\/health$/, health],

    ['GET', /^\/api\/session$/, (req) => [200, { authenticated: auth.signedIn(req), loginRequired: auth.enabled }]],
    [
      'POST',
      /^\/api\/login$/,
      async (req) => {
        if (!auth.enabled) throw new HttpError(400, 'No password is set on this server, so there is nothing to sign in to');
        const { password } = await readJson(req);
        if (typeof password !== 'string' || !password) throw new HttpError(400, 'Enter the password');
        const { cookie, retryAfter } = await auth.login(req, password);
        if (retryAfter) {
          return [429, { error: 'Too many attempts. Wait a while and try again.', retryAfter }, { 'retry-after': String(retryAfter) }];
        }
        // One message for every way a login can fail.
        if (!cookie) throw new HttpError(401, 'Incorrect password');
        return [200, { authenticated: true }, { 'set-cookie': cookie }];
      },
    ],
    ['POST', /^\/api\/logout$/, (req) => [204, undefined, auth.enabled ? { 'set-cookie': auth.logout(req) } : {}]],

    ['GET', /^\/api\/domains$/, () => [200, { domains: store.listDomains().map(describeDomain) }]],
    [
      'POST',
      /^\/api\/domains$/,
      async (req) => {
        const body = await readJson(req);
        const host = normalizeHost(body.host);
        if (!host) throw new HttpError(400, 'Enter a valid domain name, like example.com');
        const existing = store.getDomainByHost(host);
        if (existing) throw new HttpError(409, `${host} is already being tracked`, { domain: describeDomain(existing) });
        const domain = store.addDomain(host);
        await monitor.checkDomain(domain);
        return [201, { domain: describeDomain(domain) }];
      },
    ],
    [
      'GET',
      /^\/api\/domains\/(\d+)$/,
      (req, id) => {
        const domain = requireDomain(id);
        const history = store.history(domain.id).map(({ detail, ...check }) => ({ ...check, ...detail }));
        return [200, { domain: describeDomain(domain), history, alerts: store.listAlerts(domain.id) }];
      },
    ],
    [
      'DELETE',
      /^\/api\/domains\/(\d+)$/,
      (req, id) => {
        store.removeDomain(requireDomain(id).id);
        return [204];
      },
    ],
    [
      'POST',
      /^\/api\/domains\/(\d+)\/check$/,
      async (req, id) => {
        const domain = requireDomain(id);
        await monitor.checkDomain(domain);
        return [200, { domain: describeDomain(domain) }];
      },
    ],
    [
      'POST',
      /^\/api\/check$/,
      async () => {
        await monitor.checkAll();
        return [200, { domains: store.listDomains().map(describeDomain) }];
      },
    ],

    ['GET', /^\/api\/settings$/, () => [200, describeSettings()]],
    [
      'PUT',
      /^\/api\/settings$/,
      async (req) => {
        store.saveSettings(validateSettings(await readJson(req)));
        return [200, describeSettings()];
      },
    ],

    ['GET', /^\/api\/push\/vapid-public-key$/, () => [200, { publicKey: notifier.vapidPublicKey }]],
    [
      'POST',
      /^\/api\/push\/subscribe$/,
      async (req) => {
        const { endpoint, keys } = await readJson(req);
        const valid =
          typeof endpoint === 'string' &&
          /^https:\/\//.test(endpoint) &&
          keys &&
          typeof keys.p256dh === 'string' &&
          typeof keys.auth === 'string';
        if (!valid) throw new HttpError(400, 'Send the browser PushSubscription as JSON (endpoint and keys)');
        store.saveSubscription({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } });
        return [201, { ok: true }];
      },
    ],
    [
      'POST',
      /^\/api\/push\/unsubscribe$/,
      async (req) => {
        const { endpoint } = await readJson(req);
        if (typeof endpoint !== 'string') throw new HttpError(400, 'endpoint is required');
        return [200, { ok: true, removed: store.removeSubscription(endpoint) }];
      },
    ],
    [
      'POST',
      /^\/api\/alerts\/test$/,
      async () => {
        const message = {
          title: 'Test alert from SSL Tracker',
          body: 'Alerts are working. This is what an expiry reminder will look like.',
          text: 'Alerts are working. Expiry reminders will arrive at this address.\n',
          html: '<p>Alerts are working. Expiry reminders will arrive at this address.</p>',
          tag: 'test',
          url: '/',
        };
        return [200, await notifier.send(message, store.getSettings())];
      },
    ],
  ];

  async function handleApi(req, res, pathname) {
    // Asked first, so that without a session nothing shows which routes exist.
    if (!NO_SESSION_NEEDED.includes(pathname) && !auth.signedIn(req)) throw new HttpError(401, 'Sign in to continue');
    const matches = routes.filter(([, pattern]) => pattern.test(pathname));
    if (!matches.length) throw new HttpError(404, 'Not found');
    // Uptime monitors often ask with HEAD; Node leaves the body off the reply.
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const route = matches.find((m) => m[0] === method);
    if (!route) throw new HttpError(405, 'Method not allowed');
    const [status, body, headers] = await route[2](req, ...pathname.match(route[1]).slice(1));
    if (body === undefined) res.writeHead(status, headers).end();
    else sendJson(res, status, body, headers);
  }

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    const file = path.join(publicDir, pathname.endsWith('/') ? `${pathname}index.html` : pathname);
    if (!file.startsWith(publicDir + path.sep)) throw new HttpError(404, 'Not found');
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {}
    if (!stat || !stat.isFile()) throw new HttpError(404, 'Not found');
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': stat.size,
      // Always revalidate, so a new frontend or service worker is picked up straight away.
      'cache-control': 'no-cache',
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  }

  return http.createServer(async (req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    try {
      guard(req);
      let pathname;
      try {
        pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      } catch {
        throw new HttpError(400, 'Bad request');
      }
      if (pathname === '/api' || pathname.startsWith('/api/')) await handleApi(req, res, pathname);
      else serveStatic(req, res, pathname);
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      if (res.headersSent) return res.end();
      const status = err instanceof HttpError ? err.status : 500;
      sendJson(res, status, { error: status === 500 ? 'Something went wrong on the server' : err.message, ...err.extra });
    }
  });
}

module.exports = { createApp, LOOPBACK };
