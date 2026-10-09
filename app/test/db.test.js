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
      (1, 'ssl', 14, '2026-10-20T00:00:00.000Z', '2026-10-06T00:00:00.000Z', 'email');
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

test('a new database is created at the current schema version', (t) => {
  const file = path.join(tempDir(t), 'tracker.db');
  openStore(file).close();
  assert.equal(version(file), SCHEMA_VERSION);
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
  const repeat = { domainId: 1, kind: 'ssl', type: 'expiry', key: '2026-10-20T00:00:00.000Z:14', message: {} };
  assert.equal(store.claimAlert(repeat), null);
  store.close();

  // Opening it again changes nothing.
  store = openStore(file);
  assert.equal(store.listAlerts(1).length, 2);
  store.close();
});
