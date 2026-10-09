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

const HOUR_MS = 3_600_000;
const SUBSCRIPTION = { endpoint: 'https://push.example/phone', keys: { p256dh: 'p', auth: 'a' } };

// The real notifier, monitor and HTTP API, with Resend and the push service
// replaced by fakes. `resend` and `pushService` are switches a test flips to
// change how those services behave; one domain exists whose certificate
// expires in 5 days, so its first check raises exactly one alert.
async function start(t, { env = { RESEND_API_KEY: 're_test', ALERT_EMAIL_TO: 'lachie@example.com' }, subscribed = true } = {}) {
  const clock = { now: new Date('2026-10-08T12:00:00Z') };
  const now = () => clock.now;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-delivery-'));
  const store = openStore(':memory:');
  if (subscribed) store.saveSubscription(SUBSCRIPTION);

  // send: 'accept' | 'reject' (HTTP 500) | 'down' (network error). event is
  // what the status lookup reports; statusDown makes that lookup fail.
  const resend = { send: 'accept', event: 'sent', statusDown: false, emails: [], lookups: [] };
  const fakeFetch = async (url, options = {}) => {
    if (options.method === 'POST') {
      if (resend.send === 'down') throw new Error('getaddrinfo ENOTFOUND api.resend.com');
      if (resend.send === 'reject') return { ok: false, status: 500, json: async () => ({ message: 'Internal server error' }) };
      resend.emails.push(JSON.parse(options.body).subject);
      return { ok: true, status: 200, json: async () => ({ id: `msg_${resend.emails.length}` }) };
    }
    resend.lookups.push(url);
    if (resend.statusDown) throw new Error('fetch failed');
    return { ok: true, status: 200, json: async () => ({ id: url.split('/').pop(), last_event: resend.event }) };
  };
  const pushService = { up: true, pushes: [] };
  const push = {
    async sendNotification(sub, payload) {
      if (!pushService.up) throw Object.assign(new Error('unavailable'), { statusCode: 503 });
      pushService.pushes.push(JSON.parse(payload).title);
    },
  };

  const notifier = createNotifier({ store, dataDir, env, fetch: fakeFetch, push });
  const expiresAt = new Date(clock.now.getTime() + 5.5 * DAY_MS).toISOString();
  const checkers = {
    ssl: async () => ({ ok: true, expiresAt, issuer: "Let's Encrypt", trusted: true }),
    registration: async () => ({ ok: true, expiresAt: new Date(clock.now.getTime() + 300 * DAY_MS).toISOString(), domain: 'example.com' }),
  };
  const monitor = createMonitor({ store, checkers, notifier, now, log: { error() {} } });
  const server = createApp({ store, monitor, notifier, publicDir: dataDir, now });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.close();
    store.close();
    fs.rmSync(dataDir, { recursive: true });
  });

  const get = async (url) => (await fetch(`http://127.0.0.1:${server.address().port}${url}`)).json();
  const domain = store.addDomain('example.com');
  const tick = async () => {
    clock.now = new Date(clock.now.getTime() + HOUR_MS);
    await monitor.tick();
  };
  // The domain's one alert, as the API reports it.
  const alert = async () => {
    const { alerts } = await get(`/api/domains/${domain.id}`);
    assert.equal(alerts.length, 1);
    return alerts[0];
  };
  return { store, monitor, domain, resend, pushService, tick, alert, get, clock };
}

const TITLE = 'SSL certificate for example.com expires in 5 days';

test('an accepted email is recorded with its Resend id, then confirmed as delivered on a later tick', async (t) => {
  const { monitor, domain, resend, pushService, tick, alert, get } = await start(t);
  await monitor.checkDomain(domain);
  assert.deepEqual(resend.emails, [TITLE]);
  assert.deepEqual(pushService.pushes, [TITLE]);

  let { channels, deliveries } = await alert();
  assert.deepEqual(channels, ['email', 'push']);
  assert.deepEqual(deliveries.email, { status: 'sent', attempts: 1, error: null, messageId: 'msg_1', updatedAt: '2026-10-08T12:00:00.000Z' });
  assert.deepEqual(deliveries.push, { status: 'sent', attempts: 1, error: null, messageId: null, updatedAt: '2026-10-08T12:00:00.000Z' });
  assert.deepEqual(resend.lookups, [], 'the status is not asked for until a later tick');

  await tick();
  assert.deepEqual(resend.lookups, ['https://api.resend.com/emails/msg_1']);
  assert.equal((await alert()).deliveries.email.status, 'sent', 'Resend has no news yet');

  resend.event = 'delivered';
  await tick();
  ({ deliveries } = await alert());
  assert.equal(deliveries.email.status, 'delivered');
  assert.equal(deliveries.email.attempts, 1);

  for (let i = 0; i < 5; i++) await tick();
  assert.equal(resend.lookups.length, 2, 'a confirmed email is not looked up again');
  assert.deepEqual(resend.emails, [TITLE], 'nothing was sent twice');
  assert.deepEqual(pushService.pushes, [TITLE]);

  const settings = await get('/api/settings');
  assert.equal(settings.email.last.status, 'delivered');
  assert.equal(settings.push.last.status, 'sent');
  assert.deepEqual(settings.deliveryProblems, []);
});

test('a bounced email is recorded and reported, and not sent again', async (t) => {
  const { monitor, domain, resend, tick, alert, get } = await start(t);
  await monitor.checkDomain(domain);
  resend.event = 'bounced';
  await tick();

  const { channels, deliveries } = await alert();
  assert.deepEqual(channels, ['push']);
  assert.equal(deliveries.email.status, 'bounced');
  assert.equal(deliveries.email.error, 'Resend reports the email as bounced');
  assert.equal(deliveries.email.messageId, 'msg_1');

  for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual(resend.emails, [TITLE]);
  assert.equal(resend.lookups.length, 1);

  const settings = await get('/api/settings');
  assert.equal(settings.email.last.status, 'bounced');
  assert.deepEqual(
    settings.deliveryProblems.map((p) => [p.host, p.domainId, p.kind, p.type, p.title, p.channel, p.status, p.error]),
    [['example.com', domain.id, 'ssl', 'expiry', TITLE, 'email', 'bounced', 'Resend reports the email as bounced']]
  );
});

test('with Resend down the email is retried on later ticks while push is sent only once', async (t) => {
  const { monitor, domain, resend, pushService, tick, alert, get } = await start(t);
  resend.send = 'down';
  await monitor.checkDomain(domain);
  let { channels, deliveries } = await alert();
  assert.deepEqual(channels, ['push']);
  assert.equal(deliveries.email.status, 'failed');
  assert.match(deliveries.email.error, /Could not reach Resend: .*ENOTFOUND/);
  assert.equal(deliveries.push.status, 'sent');
  assert.equal((await get('/api/settings')).deliveryProblems.length, 1);

  resend.send = 'reject';
  await tick();
  ({ deliveries } = await alert());
  assert.equal(deliveries.email.attempts, 2);
  assert.equal(deliveries.email.error, 'Resend replied 500: Internal server error');

  resend.send = 'accept';
  await tick();
  ({ channels, deliveries } = await alert());
  assert.deepEqual(channels, ['email', 'push']);
  assert.deepEqual([deliveries.email.status, deliveries.email.attempts, deliveries.email.messageId], ['sent', 3, 'msg_1']);

  for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual(resend.emails, [TITLE]);
  assert.deepEqual(pushService.pushes, [TITLE], 'the channel that worked was never repeated');
  assert.deepEqual((await get('/api/settings')).deliveryProblems, []);
});

test('a channel that keeps failing is given up on after five attempts', async (t) => {
  const { monitor, domain, resend, pushService, tick, alert, get } = await start(t);
  pushService.up = false;
  await monitor.checkDomain(domain);
  for (let i = 0; i < 10; i++) await tick();

  const { channels, deliveries } = await alert();
  assert.deepEqual(channels, ['email']);
  assert.deepEqual([deliveries.push.status, deliveries.push.attempts, deliveries.push.error], ['failed', 5, 'Push service replied 503']);
  assert.deepEqual(resend.emails, [TITLE], 'the email that worked was never repeated');

  pushService.up = true;
  await tick();
  assert.deepEqual(pushService.pushes, []);
  const { deliveryProblems, push } = await get('/api/settings');
  assert.deepEqual(deliveryProblems.map((p) => [p.channel, p.status, p.attempts]), [['push', 'failed', 5]]);
  assert.equal(push.last.status, 'failed');
});

test('when the status lookup fails the email stays as sent and is asked about again', async (t) => {
  const { monitor, domain, resend, tick, alert } = await start(t);
  await monitor.checkDomain(domain);
  resend.statusDown = true;
  await tick();
  await tick();
  assert.equal((await alert()).deliveries.email.status, 'sent');
  assert.equal(resend.lookups.length, 2);

  resend.statusDown = false;
  resend.event = 'delivered';
  await tick();
  assert.equal((await alert()).deliveries.email.status, 'delivered');
});

test('an alert that reached nobody is sent once a channel is set up', async (t) => {
  const { store, monitor, domain, resend, pushService, tick, alert } = await start(t, { env: {}, subscribed: false });
  await monitor.checkDomain(domain);
  await tick();
  let { channels, deliveries } = await alert();
  assert.deepEqual(channels, []);
  assert.deepEqual([deliveries.email.status, deliveries.email.attempts, deliveries.email.error], ['skipped', 0, 'RESEND_API_KEY is not set']);
  assert.deepEqual([deliveries.push.status, deliveries.push.error], ['skipped', 'No devices are subscribed']);

  store.saveSubscription(SUBSCRIPTION);
  await tick();
  await tick();
  ({ channels, deliveries } = await alert());
  assert.deepEqual(channels, ['push']);
  assert.equal(deliveries.push.attempts, 1);
  assert.deepEqual(pushService.pushes, [TITLE]);
  assert.deepEqual(resend.emails, []);
});

test('a channel that is switched off is not retried when the other one got through', async (t) => {
  const { store, monitor, domain, resend, pushService, tick, alert } = await start(t);
  store.saveSettings({ pushEnabled: false });
  await monitor.checkDomain(domain);
  store.saveSettings({ pushEnabled: true });
  for (let i = 0; i < 3; i++) await tick();
  assert.equal((await alert()).deliveries.push.status, 'skipped');
  assert.deepEqual(pushService.pushes, []);
  assert.deepEqual(resend.emails, [TITLE]);
});
