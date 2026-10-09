'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openStore, SCHEMA_VERSION } = require('../lib/db');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-db-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  return dir;
}

// Builds a database exactly as the first release (schema version 0) left it.
function createV0Database(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(fs.readFileSync(path.join(__dirname, 'fixtures', 'schema-v0.sql'), 'utf8'));
  db.exec(`
    INSERT INTO domains (id, host, registrable, created_at) VALUES
      (1, 'example.com', 'example.com', '2026-09-01T00:00:00.000Z'),
      (2, 'shop.example.org', 'example.org', '2026-09-02T00:00:00.000Z');
    INSERT INTO checks (domain_id, kind, checked_at, ok, expires_at, detail, error) VALUES
      (1, 'ssl', '2026-10-01T00:00:00.000Z', 1, '2026-10-20T00:00:00.000Z', '{"issuer":"Let''s Encrypt"}', NULL),
      (1, 'registration', '2026-10-01T00:00:00.000Z', 0, NULL, '{}', 'Registration lookup failed (HTTP 503)');
    INSERT INTO alerts (domain_id, kind, threshold, expires_at, sent_at, channels) VALUES
      (1, 'ssl', 30, '2026-10-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z', 'email,push'),
      (1, 'ssl', 14, '2026-10-20T00:00:00.000Z', '2026-10-06T00:00:00.000Z', 'email'),
      (1, 'registration', 7, '2026-10-12T00:00:00.000Z', '2026-10-06T00:00:00.000Z', '');
    INSERT INTO settings (key, value) VALUES ('sslThresholds', '[30,14,3]'), ('emailTo', '"lachie@example.com"');
    INSERT INTO push_subscriptions (endpoint, subscription, created_at) VALUES
      ('https://push.example/a', '{"endpoint":"https://push.example/a","keys":{"p256dh":"p","auth":"a"}}', '2026-09-01T00:00:00.000Z');
  `);
  db.close();
}

const version = (file) => {
  const db = new DatabaseSync(file);
  try {
    return db.prepare('PRAGMA user_version').get().user_version;
  } finally {
    db.close();
  }
};

test('a new database is created at the current schema version, with nothing to back up', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'tracker.db');
  openStore(file).close();
  assert.equal(version(file), SCHEMA_VERSION);
  assert.equal(fs.existsSync(path.join(dir, 'backups')), false);
});

test('a snapshot is taken before an existing database is upgraded', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'tracker.db');
  createV0Database(file);
  fs.writeFileSync(path.join(dir, 'vapid.json'), '{"publicKey":"pub","privateKey":"priv"}');
  openStore(file, { now: () => new Date('2026-10-09T08:30:15.123Z') }).close();

  const backups = path.join(dir, 'backups');
  assert.deepEqual(fs.readdirSync(backups).sort(), ['tracker-2026-10-09T083015Z-schema-v0.db', 'vapid.json']);
  assert.equal(fs.readFileSync(path.join(backups, 'vapid.json'), 'utf8'), '{"publicKey":"pub","privateKey":"priv"}');

  // The snapshot is the database as it was: old version, old alerts table.
  const snapshot = path.join(backups, 'tracker-2026-10-09T083015Z-schema-v0.db');
  assert.equal(version(snapshot), 0);
  const db = new DatabaseSync(snapshot);
  t.after(() => db.close());
  assert.deepEqual(db.prepare('SELECT threshold, channels FROM alerts ORDER BY id').all().map((r) => ({ ...r })), [
    { threshold: 30, channels: 'email,push' },
    { threshold: 14, channels: 'email' },
    { threshold: 7, channels: '' },
  ]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM domains').get().n, 2);

  // An up-to-date database is not snapshotted again on the next start.
  openStore(file).close();
  assert.equal(fs.readdirSync(backups).length, 2);
});

test('a database from the first release upgrades with its data intact', (t) => {
  const file = path.join(tempDir(t), 'tracker.db');
  createV0Database(file);
  assert.equal(version(file), 0);

  let store = openStore(file);
  assert.equal(version(file), SCHEMA_VERSION);
  assert.deepEqual(store.listDomains().map((d) => [d.id, d.host, d.registrable]), [
    [1, 'example.com', 'example.com'],
    [2, 'shop.example.org', 'example.org'],
  ]);
  assert.equal(store.latestCheck(1, 'ssl').detail.issuer, "Let's Encrypt");
  assert.equal(store.latestCheck(1, 'registration').error, 'Registration lookup failed (HTTP 503)');
  assert.deepEqual(store.getSettings().sslThresholds, [30, 14, 3]);
  assert.equal(store.getSettings().emailTo, 'lachie@example.com');
  assert.equal(store.countSubscriptions(), 1);

  // Alerts already sent stay sent, so the upgrade cannot cause a repeat.
  assert.deepEqual(store.sentThresholds(1, 'ssl', '2026-10-20T00:00:00.000Z').sort(), [14, 30]);
  assert.deepEqual(
    store.listAlerts(1).map((a) => [a.type, a.threshold, a.channels]),
    [
      ['expiry', 14, ['email']],
      ['expiry', 30, ['email', 'push']],
    ]
  );
  assert.deepEqual(store.listAlerts(1)[1].deliveries, {
    email: { status: 'sent', attempts: 1, error: null, messageId: null, updatedAt: '2026-09-20T00:00:00.000Z' },
    push: { status: 'sent', attempts: 1, error: null, messageId: null, updatedAt: '2026-09-20T00:00:00.000Z' },
  });
  assert.deepEqual(Object.keys(store.listAlerts(1)[0].deliveries), ['email']);
  assert.deepEqual(store.owedDeliveries({ maxAttempts: 5, skippedSince: '' }), [], 'nothing old is re-sent');
  // The registration row was a claim that never reached anyone; it is dropped so the alert can go out.
  assert.deepEqual(store.sentThresholds(1, 'registration', '2026-10-12T00:00:00.000Z'), []);
  const repeat = { domainId: 1, kind: 'ssl', type: 'expiry', key: '2026-10-20T00:00:00.000Z:14', message: {} };
  assert.equal(store.claimAlert(repeat), null);
  store.close();

  // Opening it again changes nothing.
  store = openStore(file);
  assert.equal(store.listAlerts(1).length, 2);
  store.close();
});
