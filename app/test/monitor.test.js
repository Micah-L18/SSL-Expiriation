'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openStore } = require('../lib/db');
const { createMonitor } = require('../lib/monitor');
const { DAY_MS } = require('../lib/alerts');

const HOUR_MS = 3_600_000;

// A monitor on an in-memory store with a fake clock, fake checks that count
// how often they run, and a notifier that records the titles it was given.
function setup(t) {
  const clock = { now: new Date('2026-10-08T12:00:00Z') };
  const now = () => clock.now;
  const inDays = (days) => new Date(clock.now.getTime() + days * DAY_MS).toISOString();
  const results = {
    ssl: { ok: true, expiresAt: inDays(200.5), issuer: "Let's Encrypt", trusted: true, trustError: null, fingerprint: 'AA' },
    registration: { ok: true, expiresAt: inDays(300.5), domain: 'example.com', registrar: 'Namecheap, Inc.' },
  };
  const calls = { ssl: 0, registration: 0 };
  const checker = (kind) => async () => {
    calls[kind]++;
    return results[kind];
  };
  const sent = [];
  const store = openStore(':memory:');
  t.after(() => store.close());
  const notifier = {
    emailDelivery: async () => ({ status: 'sent' }),
    async send(message) {
      sent.push(message);
      return { email: { sent: true }, push: { sent: 0, failed: 0, skipped: 'No devices are subscribed' } };
    },
  };
  const monitor = createMonitor({
    store,
    notifier,
    now,
    checkers: { ssl: checker('ssl'), registration: checker('registration') },
    log: { error() {} },
  });
  const domain = store.addDomain('example.com');
  // Moves the clock on and runs the scheduler, as the hourly timer would.
  const tickAfter = async (ms) => {
    clock.now = new Date(clock.now.getTime() + ms);
    await monitor.tick();
  };
  const titles = () => sent.map((m) => m.title);
  return { clock, inDays, results, calls, sent, titles, store, monitor, domain, tickAfter };
}

const DOWN = { ok: false, error: 'Could not connect: ECONNREFUSED' };

test('a failed check is retried on the next three hourly ticks, then daily', async (t) => {
  const { results, calls, tickAfter, titles } = setup(t);
  results.ssl = DOWN;
  await tickAfter(0);
  assert.deepEqual(calls, { ssl: 1, registration: 1 });

  for (let hour = 1; hour <= 3; hour++) await tickAfter(HOUR_MS);
  assert.deepEqual(calls, { ssl: 4, registration: 1 }, 'only the failed check is retried');

  for (let hour = 4; hour <= 23; hour++) await tickAfter(HOUR_MS);
  assert.deepEqual(calls, { ssl: 4, registration: 1 }, 'after three retries it waits for its daily turn');

  await tickAfter(HOUR_MS);
  assert.deepEqual(calls, { ssl: 4, registration: 2 }, 'the healthy check is due a day after it last ran');
  for (let hour = 25; hour <= 27; hour++) await tickAfter(HOUR_MS);
  assert.deepEqual(calls, { ssl: 5, registration: 2 }, 'the failed one is due a day after its last retry');
  await tickAfter(HOUR_MS);
  assert.equal(calls.ssl, 5, 'and is not retried hourly again');
  assert.deepEqual(titles(), []);
});

test('a retry that succeeds ends the retries', async (t) => {
  const { results, calls, tickAfter } = setup(t);
  const good = results.ssl;
  results.ssl = DOWN;
  await tickAfter(0);
  results.ssl = good;
  await tickAfter(HOUR_MS);
  await tickAfter(HOUR_MS);
  assert.equal(calls.ssl, 2);
});

test('a registry without expiry lookups is not retried and never alerts', async (t) => {
  const { results, calls, tickAfter, titles } = setup(t);
  results.registration = { ok: false, unsupported: true, error: 'The .de registry does not offer registration lookups (RDAP)' };
  await tickAfter(0);
  for (let hour = 1; hour <= 5; hour++) await tickAfter(HOUR_MS);
  assert.equal(calls.registration, 1);
  for (let day = 1; day <= 5; day++) await tickAfter(DAY_MS);
  assert.equal(calls.registration, 6);
  assert.deepEqual(titles(), []);
});

test('a check failing for three days sends one alert, and one more when it recovers', async (t) => {
  const { results, tickAfter, titles, sent, store, domain } = setup(t);
  const good = results.ssl;
  await tickAfter(0);
  results.ssl = DOWN;
  for (let hour = 1; hour <= 71; hour++) await tickAfter(HOUR_MS);
  assert.deepEqual(titles(), [], 'nothing before three full days of failures');

  for (let hour = 72; hour <= 24 * 10; hour++) await tickAfter(HOUR_MS);
  assert.deepEqual(titles(), ['SSL check for example.com has been failing for 3 days']);
  assert.match(sent[0].text, /Last error: Could not connect: ECONNREFUSED/);
  assert.match(sent[0].body, /ECONNREFUSED/);

  results.ssl = good;
  for (let hour = 0; hour <= 48; hour++) await tickAfter(HOUR_MS);
  assert.deepEqual(titles().slice(1), ['SSL check for example.com is working again']);
  assert.deepEqual(
    store.listAlerts(domain.id).map((a) => [a.kind, a.type, a.title]),
    [
      ['ssl', 'recovered', 'SSL check for example.com is working again'],
      ['ssl', 'failing', 'SSL check for example.com has been failing for 3 days'],
    ]
  );

  // A second outage is a new run of failures, so it alerts again.
  results.ssl = DOWN;
  for (let hour = 0; hour <= 24 * 4; hour++) await tickAfter(HOUR_MS);
  assert.equal(titles().length, 3);
  assert.match(titles()[2], /has been failing for 3 days/);
});

test('a short outage sends neither a failing nor a recovery alert', async (t) => {
  const { results, tickAfter, titles } = setup(t);
  const good = results.registration;
  results.registration = { ok: false, error: 'Registration lookup failed (HTTP 503)' };
  await tickAfter(0);
  for (let hour = 1; hour <= 50; hour++) await tickAfter(HOUR_MS);
  results.registration = good;
  for (let hour = 0; hour <= 48; hour++) await tickAfter(HOUR_MS);
  assert.deepEqual(titles(), []);
});

test('an untrusted certificate alerts once per certificate', async (t) => {
  const { results, tickAfter, titles, sent, monitor, domain, inDays } = setup(t);
  results.ssl = { ...results.ssl, trusted: false, trustError: 'DEPTH_ZERO_SELF_SIGNED_CERT' };
  await tickAfter(0);
  await monitor.checkDomain(domain);
  for (let day = 1; day <= 3; day++) await tickAfter(DAY_MS);
  assert.deepEqual(titles(), ['SSL certificate for example.com is not trusted']);
  assert.match(sent[0].text, /Reason: DEPTH_ZERO_SELF_SIGNED_CERT/);

  results.ssl = { ...results.ssl, fingerprint: 'BB', trustError: 'ERR_TLS_CERT_ALTNAME_INVALID' };
  await tickAfter(DAY_MS);
  await tickAfter(DAY_MS);
  assert.equal(titles().length, 2, 'a different untrusted certificate is a new alert');

  results.ssl = { ...results.ssl, fingerprint: 'CC', trusted: true, trustError: null };
  await tickAfter(DAY_MS);
  assert.equal(titles().length, 2);

  // An expired certificate is reported as expired, not as untrusted as well.
  results.ssl = { ...results.ssl, fingerprint: 'DD', expiresAt: inDays(-1), trusted: false, trustError: 'CERT_HAS_EXPIRED' };
  await tickAfter(DAY_MS);
  assert.deepEqual(titles().slice(2), ['SSL certificate for example.com has expired']);
});

test('something still expired re-alerts weekly, never more often', async (t) => {
  const { results, tickAfter, titles, monitor, domain, inDays } = setup(t);
  results.registration = { ...results.registration, expiresAt: inDays(-2) };
  await tickAfter(0);
  for (let day = 1; day <= 22; day++) {
    await tickAfter(DAY_MS);
    await monitor.checkDomain(domain);
  }
  assert.deepEqual(titles(), [
    'Domain registration for example.com has expired',
    'Reminder: Domain registration for example.com is still expired',
    'Reminder: Domain registration for example.com is still expired',
    'Reminder: Domain registration for example.com is still expired',
  ]);

  // Renewing ends the reminders.
  results.registration = { ...results.registration, expiresAt: inDays(365) };
  for (let day = 1; day <= 15; day++) await tickAfter(DAY_MS);
  assert.equal(titles().length, 4);
});

test('turning off the thresholds for a kind silences all of its alerts', async (t) => {
  const { results, tickAfter, titles, store } = setup(t);
  store.saveSettings({ sslThresholds: [] });
  results.ssl = { ...results.ssl, trusted: false, trustError: 'self signed' };
  await tickAfter(0);
  results.ssl = DOWN;
  for (let hour = 0; hour <= 24 * 5; hour++) await tickAfter(HOUR_MS);
  assert.deepEqual(titles(), []);
});
