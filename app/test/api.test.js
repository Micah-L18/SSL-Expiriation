'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openStore } = require('../lib/db');
const { createMonitor } = require('../lib/monitor');
const { createNotifier } = require('../lib/notify');
const { createApp } = require('../lib/api');
const { DAY_MS } = require('../lib/alerts');

// Starts the real server on a random port with fake network checks, a fake
// clock and a notifier that records what it was asked to send.
async function start(t, { delivers = true } = {}) {
  const clock = { now: new Date('2026-10-08T12:00:00Z') };
  const now = () => clock.now;
  const inDays = (days) => new Date(clock.now.getTime() + days * DAY_MS).toISOString();
  const results = {
    ssl: { ok: true, expiresAt: inDays(60.5), validFrom: inDays(-30), issuer: "Let's Encrypt", subject: 'example.com', trusted: true, trustError: null },
    registration: { ok: true, expiresAt: inDays(200.5), domain: 'example.com', registrar: 'Namecheap, Inc.', registeredAt: inDays(-900), statuses: [] },
  };
  const sent = [];
  const store = openStore(':memory:');
  const notifier = {
    vapidPublicKey: 'test-public-key',
    emailStatus: (settings) => ({ configured: true, from: 'from@example.com', to: settings.emailTo || 'env@example.com' }),
    async send(message) {
      sent.push(message.title);
      return { email: { sent: delivers }, push: { sent: 0, failed: 0 } };
    },
  };
  const resolve = (result) => (typeof result === 'function' ? result() : result);
  const checkers = { ssl: async () => resolve(results.ssl), registration: async () => resolve(results.registration) };
  const monitor = createMonitor({ store, checkers, notifier, now, log: { error() {} } });
  const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-public-'));
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<h1>hello</h1>');
  const server = createApp({ store, monitor, notifier, publicDir, now });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.close();
    store.close();
    fs.rmSync(publicDir, { recursive: true });
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  async function api(method, url, body) {
    const res = await fetch(base + url, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  return { api, base, clock, inDays, results, sent, store, monitor };
}

test('adding a domain checks it straight away and returns both expiries', async (t) => {
  const { api, inDays } = await start(t);
  const { status, body } = await api('POST', '/api/domains', { host: 'https://Example.com/' });
  assert.equal(status, 201);
  assert.equal(body.domain.host, 'example.com');
  assert.equal(body.domain.status, 'healthy');
  assert.deepEqual(
    { ...body.domain.ssl, checkedAt: null },
    {
      status: 'healthy',
      ok: true,
      checkedAt: null,
      error: null,
      expiresAt: inDays(60.5),
      daysLeft: 60,
      stale: false,
      validFrom: inDays(-30),
      issuer: "Let's Encrypt",
      subject: 'example.com',
      trusted: true,
      trustError: null,
    }
  );
  assert.equal(body.domain.registration.registrar, 'Namecheap, Inc.');
  assert.equal(body.domain.registration.daysLeft, 200);

  const list = await api('GET', '/api/domains');
  assert.equal(list.body.domains.length, 1);
  assert.equal(list.body.domains[0].id, body.domain.id);
});

test('rejects invalid, duplicate and non-JSON domain requests', async (t) => {
  const { api, base } = await start(t);
  assert.equal((await api('POST', '/api/domains', { host: 'not a domain' })).status, 400);
  assert.equal((await api('POST', '/api/domains', {})).status, 400);
  await api('POST', '/api/domains', { host: 'example.com' });
  const dup = await api('POST', '/api/domains', { host: 'EXAMPLE.com' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.domain.host, 'example.com');
  assert.match(dup.body.error, /already/);

  const form = await fetch(`${base}/api/domains`, { method: 'POST', body: 'host=example.org' });
  assert.equal(form.status, 415);
  const broken = await fetch(`${base}/api/domains`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(broken.status, 400);
});

test('detail returns check history and removing a domain deletes it', async (t) => {
  const { api } = await start(t);
  const { body } = await api('POST', '/api/domains', { host: 'example.com' });
  const id = body.domain.id;
  await api('POST', `/api/domains/${id}/check`);

  const detail = await api('GET', `/api/domains/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.history.length, 4);
  assert.deepEqual(detail.body.history.map((h) => h.kind).sort(), ['registration', 'registration', 'ssl', 'ssl']);
  const sslCheck = detail.body.history.find((h) => h.kind === 'ssl');
  assert.equal(sslCheck.ok, true);
  assert.equal(sslCheck.issuer, "Let's Encrypt");
  assert.equal(sslCheck.checkedAt, '2026-10-08T12:00:00.000Z');
  assert.deepEqual(detail.body.alerts, []);

  assert.equal((await api('DELETE', `/api/domains/${id}`)).status, 204);
  assert.equal((await api('GET', `/api/domains/${id}`)).status, 404);
  assert.equal((await api('DELETE', `/api/domains/${id}`)).status, 404);
  assert.equal((await api('POST', `/api/domains/${id}/check`)).status, 404);
  assert.deepEqual((await api('GET', '/api/domains')).body.domains, []);
});

test('a failed check is reported, keeping the last known expiry', async (t) => {
  const { api, results, inDays } = await start(t);
  const { body } = await api('POST', '/api/domains', { host: 'example.com' });
  const expiresAt = inDays(60.5);
  results.ssl = { ok: false, error: 'Could not connect: ECONNREFUSED' };
  results.registration = { ok: false, unsupported: true, error: 'No lookups for this TLD' };

  const { body: after } = await api('POST', `/api/domains/${body.domain.id}/check`);
  assert.equal(after.domain.status, 'failed');
  assert.equal(after.domain.ssl.status, 'failed');
  assert.equal(after.domain.ssl.error, 'Could not connect: ECONNREFUSED');
  assert.equal(after.domain.ssl.expiresAt, expiresAt);
  assert.equal(after.domain.ssl.stale, true);
  assert.equal(after.domain.registration.error, 'No lookups for this TLD');
  assert.equal(after.domain.registration.status, 'unsupported');

  results.ssl = { ok: true, expiresAt, issuer: 'X' };
  const { body: recovered } = await api('POST', `/api/domains/${body.domain.id}/check`);
  assert.equal(recovered.domain.status, 'healthy', 'an unsupported registry does not mark the domain as failed');
});

test('a checker that throws is recorded as a failed check', async (t) => {
  const { api, results } = await start(t);
  results.ssl = () => {
    throw new Error('boom');
  };
  const { status, body } = await api('POST', '/api/domains', { host: 'example.com' });
  assert.equal(status, 201);
  assert.equal(body.domain.ssl.status, 'failed');
  assert.match(body.domain.ssl.error, /boom/);
  assert.equal(body.domain.ssl.expiresAt, null);
  assert.equal(body.domain.registration.status, 'healthy');
});

test('each threshold alerts once, and a renewal starts a new cycle', async (t) => {
  const { api, results, inDays, clock, sent } = await start(t);
  results.ssl = { ...results.ssl, expiresAt: inDays(20.5) };
  const { body } = await api('POST', '/api/domains', { host: 'example.com' });
  const id = body.domain.id;
  assert.equal(body.domain.status, 'soon');
  assert.deepEqual(sent, ['SSL certificate for example.com expires in 20 days']);

  await api('POST', `/api/domains/${id}/check`);
  await api('POST', '/api/check');
  assert.equal(sent.length, 1, 're-checking does not repeat the alert');

  clock.now = new Date(clock.now.getTime() + 7 * DAY_MS);
  await api('POST', `/api/domains/${id}/check`);
  assert.deepEqual(sent.slice(1), ['SSL certificate for example.com expires in 13 days']);

  clock.now = new Date(clock.now.getTime() + 14 * DAY_MS);
  const expired = await api('POST', `/api/domains/${id}/check`);
  await api('POST', `/api/domains/${id}/check`);
  assert.equal(expired.body.domain.status, 'expired');
  assert.deepEqual(sent.slice(2), ['SSL certificate for example.com has expired']);

  const detail = await api('GET', `/api/domains/${id}`);
  assert.deepEqual(detail.body.alerts.map((a) => [a.kind, a.threshold, a.channels]), [
    ['ssl', 0, ['email']],
    ['ssl', 14, ['email']],
    ['ssl', 30, ['email']],
  ]);

  results.ssl = { ...results.ssl, expiresAt: inDays(5.5) };
  await api('POST', `/api/domains/${id}/check`);
  assert.deepEqual(sent.slice(3), ['SSL certificate for example.com expires in 5 days']);
});

test('SSL and registration use their own thresholds', async (t) => {
  const { api, results, inDays, sent } = await start(t);
  const saved = await api('PUT', '/api/settings', { sslThresholds: [7], registrationThresholds: [60, 30] });
  assert.deepEqual(saved.body.settings.registrationThresholds, [60, 30]);
  results.ssl = { ...results.ssl, expiresAt: inDays(20.5) };
  results.registration = { ...results.registration, expiresAt: inDays(45.5) };

  const { body } = await api('POST', '/api/domains', { host: 'example.com' });
  assert.deepEqual(sent, ['Domain registration for example.com expires in 45 days']);
  assert.equal(body.domain.ssl.status, 'healthy');
  assert.equal(body.domain.registration.status, 'soon');
});

test('an alert that reaches nobody is retried on the next check', async (t) => {
  const { api, results, inDays, sent } = await start(t, { delivers: false });
  results.ssl = { ...results.ssl, expiresAt: inDays(5.5) };
  const { body } = await api('POST', '/api/domains', { host: 'example.com' });
  await api('POST', `/api/domains/${body.domain.id}/check`);
  assert.equal(sent.length, 2);
  assert.deepEqual((await api('GET', `/api/domains/${body.domain.id}`)).body.alerts, []);
});

test('overlapping checks of one domain share a single run', async (t) => {
  const { store, monitor, results, inDays, sent } = await start(t);
  results.ssl = { ...results.ssl, expiresAt: inDays(5.5) };
  const domain = store.addDomain('example.com');
  await Promise.all([monitor.checkDomain(domain), monitor.checkDomain(domain), monitor.checkAll()]);
  assert.equal(sent.length, 1);
  assert.equal(store.history(domain.id).length, 2);
});

test('settings have defaults, can be updated in part, and are validated', async (t) => {
  const { api } = await start(t);
  const initial = await api('GET', '/api/settings');
  assert.deepEqual(initial.body, {
    settings: {
      sslThresholds: [30, 14, 7, 1],
      registrationThresholds: [30, 14, 7, 1],
      emailEnabled: true,
      emailTo: 'env@example.com',
      pushEnabled: true,
    },
    email: { configured: true, from: 'from@example.com' },
    push: { subscriptions: 0 },
  });

  const updated = await api('PUT', '/api/settings', { sslThresholds: [3, 60, 3], emailTo: ' lachie@example.com ', pushEnabled: false });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body.settings, {
    sslThresholds: [60, 3],
    registrationThresholds: [30, 14, 7, 1],
    emailEnabled: true,
    emailTo: 'lachie@example.com',
    pushEnabled: false,
  });
  assert.deepEqual((await api('GET', '/api/settings')).body, updated.body);

  for (const bad of [{ sslThresholds: [0] }, { registrationThresholds: 'weekly' }, { emailEnabled: 'yes' }, { emailTo: 'nope' }]) {
    assert.equal((await api('PUT', '/api/settings', bad)).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual((await api('GET', '/api/settings')).body, updated.body);
});

test('push: public key, subscribe, re-subscribe and unsubscribe', async (t) => {
  const { api } = await start(t);
  assert.deepEqual((await api('GET', '/api/push/vapid-public-key')).body, { publicKey: 'test-public-key' });

  const sub = { endpoint: 'https://push.example/abc', expirationTime: null, keys: { p256dh: 'p', auth: 'a' } };
  assert.equal((await api('POST', '/api/push/subscribe', sub)).status, 201);
  assert.equal((await api('POST', '/api/push/subscribe', sub)).status, 201);
  assert.equal((await api('GET', '/api/settings')).body.push.subscriptions, 1);
  assert.equal((await api('POST', '/api/push/subscribe', { endpoint: 'https://push.example/abc' })).status, 400);

  assert.deepEqual((await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint })).body, { ok: true, removed: true });
  assert.deepEqual((await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint })).body, { ok: true, removed: false });
  assert.equal((await api('GET', '/api/settings')).body.push.subscriptions, 0);
});

test('test alert reports what each channel did', async (t) => {
  const { api, sent } = await start(t);
  const { status, body } = await api('POST', '/api/alerts/test');
  assert.equal(status, 200);
  assert.deepEqual(body, { email: { sent: true }, push: { sent: 0, failed: 0 } });
  assert.deepEqual(sent, ['Test alert from SSL Tracker']);
});

test('serves the frontend and refuses paths outside it', async (t) => {
  const { api, base } = await start(t);
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  assert.equal(await home.text(), '<h1>hello</h1>');

  assert.equal((await fetch(`${base}/missing.js`)).status, 404);
  assert.equal((await fetch(`${base}/..%2f..%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/%E0%A4%A`)).status, 400);
  assert.equal((await api('GET', '/api/nope')).status, 404);
  assert.equal((await api('PATCH', '/api/domains')).status, 405);
});

test('notifier sends email through Resend and push through web-push', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-data-'));
  const store = openStore(':memory:');
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true });
  });
  store.saveSubscription({ endpoint: 'https://push.example/live', keys: { p256dh: 'p', auth: 'a' } });
  store.saveSubscription({ endpoint: 'https://push.example/gone', keys: { p256dh: 'p', auth: 'a' } });

  const requests = [];
  const fakeFetch = async (url, options) => {
    requests.push({ url, auth: options.headers.authorization, body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ id: '1' }) };
  };
  const pushed = [];
  const push = {
    async sendNotification(sub, payload, options) {
      if (sub.endpoint.endsWith('gone')) throw Object.assign(new Error('gone'), { statusCode: 410 });
      pushed.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), subject: options.vapidDetails.subject });
    },
  };
  const env = { RESEND_API_KEY: 're_test', ALERT_EMAIL_TO: 'lachie@example.com', ALERT_EMAIL_FROM: 'Tracker <alerts@example.com>' };
  const notifier = createNotifier({ store, dataDir, env, fetch: fakeFetch, push });
  const message = { title: 'T', body: 'B', text: 'text', html: '<p>html</p>', tag: 'ssl:a.com', url: '/' };

  const outcome = await notifier.send(message, store.getSettings());
  assert.deepEqual(outcome, { email: { sent: true }, push: { sent: 1, failed: 1 } });
  assert.deepEqual(requests, [
    {
      url: 'https://api.resend.com/emails',
      auth: 'Bearer re_test',
      body: { from: 'Tracker <alerts@example.com>', to: ['lachie@example.com'], subject: 'T', text: 'text', html: '<p>html</p>' },
    },
  ]);
  assert.deepEqual(pushed, [
    { endpoint: 'https://push.example/live', payload: { title: 'T', body: 'B', tag: 'ssl:a.com', url: '/' }, subject: 'mailto:lachie@example.com' },
  ]);
  assert.equal(store.countSubscriptions(), 1, 'the expired subscription is dropped');

  const off = await notifier.send(message, { ...store.getSettings(), emailEnabled: false, pushEnabled: false });
  assert.equal(off.email.sent, false);
  assert.equal(off.push.sent, 0);
  assert.equal(requests.length, 1);

  const again = createNotifier({ store, dataDir, env: {}, fetch: fakeFetch, push });
  assert.equal(again.vapidPublicKey, notifier.vapidPublicKey, 'VAPID keys persist in the data dir');
  assert.match((await again.send(message, store.getSettings())).email.skipped, /RESEND_API_KEY/);
});
