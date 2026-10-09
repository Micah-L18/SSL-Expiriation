'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openStore } = require('../lib/db');
const { createBackups } = require('../lib/backup');
const { createMonitor } = require('../lib/monitor');
const { createNotifier } = require('../lib/notify');
const { DAY_MS } = require('../lib/alerts');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-backup-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  return dir;
}

// A file-backed store in a temp data dir, with a clock the test controls.
function setup(t) {
  const dataDir = tempDir(t);
  const clock = { now: new Date('2026-10-08T23:30:00Z') };
  const now = () => clock.now;
  const store = openStore(path.join(dataDir, 'tracker.db'), { now });
  t.after(() => store.close());
  const backups = createBackups({ store, dataDir, now });
  const names = () => fs.readdirSync(path.join(dataDir, 'backups')).sort();
  const advance = (ms) => (clock.now = new Date(clock.now.getTime() + ms));
  return { dataDir, clock, now, store, backups, names, advance };
}

test('a snapshot is taken once a day, with vapid.json beside it', (t) => {
  const { dataDir, store, backups, names, advance } = setup(t);
  const { vapidPublicKey } = createNotifier({ store, dataDir, env: {} });
  store.addDomain('example.com');

  const file = backups.nightly();
  assert.equal(file, path.join(dataDir, 'backups', 'tracker-2026-10-08.db'));
  assert.deepEqual(names(), ['tracker-2026-10-08.db', 'vapid.json']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'backups', 'vapid.json'), 'utf8')).publicKey, vapidPublicKey);

  assert.equal(backups.nightly(), null, 'only one a day');
  advance(3_600_000);
  assert.ok(backups.nightly(), 'a new day has started');
  assert.deepEqual(names(), ['tracker-2026-10-08.db', 'tracker-2026-10-09.db', 'vapid.json']);
});

test('only the newest seven snapshots are kept', (t) => {
  const { backups, names, advance } = setup(t);
  for (let day = 0; day < 10; day++) {
    backups.nightly();
    advance(DAY_MS);
  }
  assert.deepEqual(names(), ['11', '12', '13', '14', '15', '16', '17'].map((d) => `tracker-2026-10-${d}.db`));
  assert.equal(backups.list().length, 7);
});

test('restoring a snapshot brings back the domains, their checks and the push keys', (t) => {
  const { dataDir, store, backups } = setup(t);
  const { vapidPublicKey } = createNotifier({ store, dataDir, env: {} });
  const domain = store.addDomain('example.com');
  store.addDomain('shop.example.org');
  store.addCheck(domain.id, 'ssl', { ok: true, expiresAt: '2026-12-25T00:00:00.000Z', issuer: "Let's Encrypt" });
  store.saveSettings({ emailTo: 'lachie@example.com' });
  store.saveSubscription({ endpoint: 'https://push.example/a', keys: { p256dh: 'p', auth: 'a' } });
  const snapshot = backups.nightly();
  // Changes after the snapshot are not part of it.
  store.removeDomain(domain.id);

  // The restore steps from the README, into an empty data folder.
  const restoredDir = tempDir(t);
  fs.copyFileSync(snapshot, path.join(restoredDir, 'tracker.db'));
  fs.copyFileSync(path.join(dataDir, 'backups', 'vapid.json'), path.join(restoredDir, 'vapid.json'));

  const restored = openStore(path.join(restoredDir, 'tracker.db'));
  t.after(() => restored.close());
  assert.deepEqual(restored.listDomains().map((d) => d.host), ['example.com', 'shop.example.org']);
  const check = restored.latestCheck(restored.getDomainByHost('example.com').id, 'ssl');
  assert.equal(check.expiresAt, '2026-12-25T00:00:00.000Z');
  assert.equal(check.detail.issuer, "Let's Encrypt");
  assert.equal(restored.getSettings().emailTo, 'lachie@example.com');
  assert.equal(restored.countSubscriptions(), 1);
  assert.equal(createNotifier({ store: restored, dataDir: restoredDir, env: {} }).vapidPublicKey, vapidPublicKey);
  assert.equal(fs.existsSync(path.join(restoredDir, 'backups')), false, 'a snapshot is already on the current schema');
});

test('checks older than 400 days are pruned, keeping the latest good check of each kind', (t) => {
  const { store, backups, now, advance } = setup(t);
  const ago = (days) => new Date(now().getTime() - days * DAY_MS).toISOString();
  const good = (expiresAt) => ({ ok: true, expiresAt });
  const bad = { ok: false, error: 'Could not connect: ETIMEDOUT' };
  const a = store.addDomain('a.example.com');
  const b = store.addDomain('b.example.com');

  // a: an old good SSL check followed only by failures; a recent registration history.
  store.addCheck(a.id, 'ssl', good('2025-01-01T00:00:00.000Z'), ago(600));
  store.addCheck(a.id, 'ssl', good('2025-06-01T00:00:00.000Z'), ago(500));
  store.addCheck(a.id, 'ssl', bad, ago(450));
  store.addCheck(a.id, 'ssl', bad, ago(399));
  store.addCheck(a.id, 'registration', good('2027-01-01T00:00:00.000Z'), ago(450));
  store.addCheck(a.id, 'registration', good('2028-01-01T00:00:00.000Z'), ago(10));
  // b: only old checks.
  store.addCheck(b.id, 'ssl', good('2025-03-01T00:00:00.000Z'), ago(420));
  store.addCheck(b.id, 'ssl', good('2025-09-01T00:00:00.000Z'), ago(410));
  store.addCheck(b.id, 'registration', bad, ago(410));

  backups.nightly();
  const kept = (domain) => store.history(domain.id).map((c) => [c.kind, c.ok, c.expiresAt]).reverse();
  assert.deepEqual(kept(a), [
    ['ssl', true, '2025-06-01T00:00:00.000Z'],
    ['ssl', false, null],
    ['registration', true, '2028-01-01T00:00:00.000Z'],
  ]);
  assert.deepEqual(kept(b), [['ssl', true, '2025-09-01T00:00:00.000Z']]);
  assert.equal(store.latestOkCheck(a.id, 'ssl').expiresAt, '2025-06-01T00:00:00.000Z');

  // The snapshot was taken first, so it still holds everything.
  const snapshot = openStore(backups.list()[0]);
  t.after(() => snapshot.close());
  assert.equal(snapshot.history(a.id).length, 6);

  advance(DAY_MS);
  backups.nightly();
  assert.equal(store.history(a.id).length, 3, 'pruning again removes nothing more');
});

test('the scheduler runs the housekeeping every tick, and survives it failing', async (t) => {
  const { store, backups, names, now } = setup(t);
  const errors = [];
  const monitorWith = (maintain) =>
    createMonitor({ store, now, maintain, notifier: {}, checkers: {}, log: { error: (message) => errors.push(message) } });

  await monitorWith(() => backups.nightly()).tick();
  await monitorWith(() => backups.nightly()).tick();
  assert.deepEqual(names(), ['tracker-2026-10-08.db']);

  await monitorWith(() => {
    throw new Error('disk full');
  }).tick();
  assert.deepEqual(errors, ['Housekeeping failed: disk full']);
});
