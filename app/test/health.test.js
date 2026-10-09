'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { openStore } = require('../lib/db');
const { createMonitor } = require('../lib/monitor');
const { createBackups } = require('../lib/backup');
const { createApp } = require('../lib/api');

const HOUR_MS = 3_600_000;

// The real scheduler, backups and server on a temp data folder, with a fake
// clock and a fake fetch that records every heartbeat request.
async function start(t, { heartbeatUrl = '', maintain, beat = async () => ({ ok: true, status: 200 }) } = {}) {
  const clock = { now: new Date('2026-10-08T12:00:00Z') };
  const now = () => clock.now;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-health-'));
  const store = openStore(path.join(dataDir, 'tracker.db'));
  const backups = createBackups({ store, dataDir, now });
  const beats = [];
  const errors = [];
  const monitor = createMonitor({
    store,
    now,
    heartbeatUrl,
    maintain: maintain || (() => backups.nightly()),
    fetch: async (url, options = {}) => {
      beats.push({ url, method: options.method || 'GET' });
      return beat();
    },
    notifier: { emailDelivery: async () => ({ status: 'sent' }), send: async () => ({}) },
    checkers: { ssl: async () => ({ ok: false, error: 'offline' }), registration: async () => ({ ok: false, error: 'offline' }) },
    log: { error: (message) => errors.push(message) },
  });
  const server = createApp({ store, monitor, backups, notifier: {}, publicDir: dataDir, now });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.close();
    store.close();
    fs.rmSync(dataDir, { recursive: true });
  });
  const health = async () => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
    return { status: res.status, body: await res.json() };
  };
  const advance = (ms) => (clock.now = new Date(clock.now.getTime() + ms));
  return { store, monitor, beats, errors, health, advance, now };
}

test('with HEARTBEAT_URL set, each completed tick sends one GET to it', async (t) => {
  const { monitor, beats, advance } = await start(t, { heartbeatUrl: 'https://hc.example/ping/abc' });
  assert.deepEqual(beats, [], 'nothing is sent before a tick has completed');
  await monitor.tick();
  assert.deepEqual(beats, [{ url: 'https://hc.example/ping/abc', method: 'GET' }]);
  advance(HOUR_MS);
  await monitor.tick();
  assert.equal(beats.length, 2);
});

test('without HEARTBEAT_URL no request is made', async (t) => {
  const { monitor, beats, health } = await start(t);
  await monitor.tick();
  await monitor.tick();
  assert.deepEqual(beats, []);
  assert.deepEqual((await health()).body.heartbeat, { enabled: false, lastAt: null, lastError: null });
});

test('a heartbeat that cannot be delivered is reported, and does not stop the scheduler', async (t) => {
  let beat = async () => {
    throw new Error('getaddrinfo ENOTFOUND hc.example');
  };
  const { monitor, errors, health, now } = await start(t, { heartbeatUrl: 'https://hc.example/ping/abc', beat: () => beat() });
  await monitor.tick();
  assert.deepEqual(errors, ['Heartbeat failed: getaddrinfo ENOTFOUND hc.example']);
  let { status, body } = await health();
  assert.equal(status, 200);
  assert.deepEqual(body.heartbeat, { enabled: true, lastAt: now().toISOString(), lastError: 'getaddrinfo ENOTFOUND hc.example' });

  beat = async () => ({ ok: false, status: 404 });
  await monitor.tick();
  assert.equal((await health()).body.heartbeat.lastError, 'HTTP 404');

  beat = async () => ({ ok: true, status: 200 });
  await monitor.tick();
  assert.equal((await health()).body.heartbeat.lastError, null);
});

test('health reports the last tick, the domain count and the last backup', async (t) => {
  const { store, monitor, health, now } = await start(t);
  let { status, body } = await health();
  assert.equal(status, 200, 'a freshly started app is given time to finish its first tick');
  assert.deepEqual(body, {
    ok: true,
    startedAt: now().toISOString(),
    lastTick: null,
    domains: 0,
    lastBackupAt: null,
    heartbeat: { enabled: false, lastAt: null, lastError: null },
  });

  store.addDomain('example.com');
  store.addDomain('example.org');
  await monitor.tick();
  ({ status, body } = await health());
  assert.equal(status, 200);
  assert.deepEqual(body.lastTick, { at: now().toISOString(), ok: true, errors: [] });
  assert.equal(body.domains, 2);
  // The snapshot file is stamped by the real clock, not the fake one.
  assert.ok(Math.abs(Date.now() - new Date(body.lastBackupAt)) < 60_000);
});

test('a tick that completed with errors is reported as such', async (t) => {
  const { monitor, health } = await start(t, {
    maintain: () => {
      throw new Error('disk full');
    },
  });
  await monitor.tick();
  const { status, body } = await health();
  assert.equal(status, 200, 'the scheduler is still running');
  assert.equal(body.lastTick.ok, false);
  assert.deepEqual(body.lastTick.errors, ['Housekeeping failed: disk full']);
});

test('health turns 503 when no tick has completed in 3 hours', async (t) => {
  const { monitor, health, advance } = await start(t);
  advance(3 * HOUR_MS - 1000);
  assert.equal((await health()).status, 200);
  advance(1000);
  let { status, body } = await health();
  assert.equal(status, 503, 'never ticked since starting 3 hours ago');
  assert.equal(body.ok, false);

  await monitor.tick();
  assert.equal((await health()).status, 200);
  advance(3 * HOUR_MS - 1000);
  assert.equal((await health()).status, 200);
  advance(1000);
  ({ status, body } = await health());
  assert.equal(status, 503);
  assert.equal(body.ok, false);
  assert.ok(body.lastTick.at, 'it still says when the last tick was');
});

test('an unhandled error stops the process with a non-zero exit code', () => {
  const fatal = JSON.stringify(path.join(__dirname, '../lib/fatal'));
  const run = (code) =>
    spawnSync(process.execPath, ['-e', `require(${fatal}).exitOnFatal(); ${code}; setInterval(() => {}, 1000);`], {
      encoding: 'utf8',
      timeout: 10_000,
    });

  const rejected = run(`Promise.reject(new Error('lost promise'))`);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /unhandled error \(unhandledRejection\).*lost promise/s);

  const thrown = run(`setTimeout(() => { throw new Error('boom') }, 1)`);
  assert.equal(thrown.status, 1);
  assert.match(thrown.stderr, /unhandled error \(uncaughtException\).*boom/s);
});
