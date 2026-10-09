'use strict';

const { DatabaseSync } = require('node:sqlite');

const DEFAULT_SETTINGS = {
  sslThresholds: [30, 14, 7, 1],
  registrationThresholds: [30, 14, 7, 1],
  emailEnabled: true,
  emailTo: '',
  pushEnabled: true,
};

// One entry per schema version, applied in order and tracked in PRAGMA
// user_version. Never edit a released entry; add a new one instead.
const MIGRATIONS = [
  // 1: the original schema. Databases from before versioning already have it.
  `
  CREATE TABLE IF NOT EXISTS domains (
    id INTEGER PRIMARY KEY,
    host TEXT NOT NULL UNIQUE,
    registrable TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS checks (
    id INTEGER PRIMARY KEY,
    domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    ok INTEGER NOT NULL,
    expires_at TEXT,
    detail TEXT NOT NULL DEFAULT '{}',
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS checks_by_domain ON checks(domain_id, kind, id);
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY,
    domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    threshold INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    channels TEXT NOT NULL DEFAULT '',
    UNIQUE (domain_id, kind, threshold, expires_at)
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    subscription TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`,
  // 2: alerts get a type and a de-duplication key, so there can be alerts
  // that are not about a threshold (failing checks, untrusted certificates).
  `
  CREATE TABLE alerts_new (
    id INTEGER PRIMARY KEY,
    domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    type TEXT NOT NULL,
    key TEXT NOT NULL,
    threshold INTEGER,
    expires_at TEXT,
    sent_at TEXT NOT NULL,
    channels TEXT NOT NULL DEFAULT '',
    message TEXT,
    UNIQUE (domain_id, kind, type, key)
  );
  INSERT INTO alerts_new (id, domain_id, kind, type, key, threshold, expires_at, sent_at, channels)
    SELECT id, domain_id, kind, 'expiry', expires_at || ':' || threshold, threshold, expires_at, sent_at, channels FROM alerts;
  DROP TABLE alerts;
  ALTER TABLE alerts_new RENAME TO alerts;
  `,
];

function schemaVersion(db) {
  return db.prepare('PRAGMA user_version').get().user_version;
}

function migrate(db) {
  for (let version = schemaVersion(db); version < MIGRATIONS.length; version++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

function toDomain(row) {
  return row && { id: row.id, host: row.host, registrable: row.registrable, createdAt: row.created_at };
}

function toCheck(row) {
  return row && {
    id: row.id,
    kind: row.kind,
    checkedAt: row.checked_at,
    ok: row.ok === 1,
    expiresAt: row.expires_at,
    detail: JSON.parse(row.detail),
    error: row.error,
  };
}

function toAlert(row) {
  return row && {
    kind: row.kind,
    type: row.type,
    title: row.message ? JSON.parse(row.message).title : null,
    threshold: row.threshold,
    expiresAt: row.expires_at,
    sentAt: row.sent_at,
    channels: row.channels ? row.channels.split(',') : [],
  };
}

// file is a path, or ':memory:' for tests.
function openStore(file) {
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  const iso = () => new Date().toISOString();

  return {
    close: () => db.close(),

    listDomains: () => db.prepare('SELECT * FROM domains ORDER BY host').all().map(toDomain),
    getDomain: (id) => toDomain(db.prepare('SELECT * FROM domains WHERE id = ?').get(id)),
    getDomainByHost: (host) => toDomain(db.prepare('SELECT * FROM domains WHERE host = ?').get(host)),
    addDomain(host) {
      const { lastInsertRowid } = db.prepare('INSERT INTO domains (host, created_at) VALUES (?, ?)').run(host, iso());
      return this.getDomain(Number(lastInsertRowid));
    },
    removeDomain: (id) => db.prepare('DELETE FROM domains WHERE id = ?').run(id).changes > 0,
    setRegistrable: (id, name) => db.prepare('UPDATE domains SET registrable = ? WHERE id = ?').run(name, id),

    addCheck(domainId, kind, { ok, expiresAt = null, error = null, ...detail }, checkedAt = iso()) {
      db.prepare(
        'INSERT INTO checks (domain_id, kind, checked_at, ok, expires_at, detail, error) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(domainId, kind, checkedAt, ok ? 1 : 0, expiresAt, JSON.stringify(detail), error);
    },
    latestCheck: (domainId, kind) =>
      toCheck(db.prepare('SELECT * FROM checks WHERE domain_id = ? AND kind = ? ORDER BY id DESC LIMIT 1').get(domainId, kind)),
    latestOkCheck: (domainId, kind) =>
      toCheck(
        db.prepare('SELECT * FROM checks WHERE domain_id = ? AND kind = ? AND ok = 1 ORDER BY id DESC LIMIT 1').get(domainId, kind)
      ),
    // The run of failed checks since the last good one. afterId is that good
    // check's id (0 when there has never been one) and names the run.
    failureStreak(domainId, kind) {
      const { afterId } = db
        .prepare('SELECT COALESCE(MAX(id), 0) AS afterId FROM checks WHERE domain_id = ? AND kind = ? AND ok = 1')
        .get(domainId, kind);
      const { count, since } = db
        .prepare('SELECT COUNT(*) AS count, MIN(checked_at) AS since FROM checks WHERE domain_id = ? AND kind = ? AND id > ?')
        .get(domainId, kind, afterId);
      return { afterId, count, since };
    },
    history: (domainId, limit = 50) =>
      db.prepare('SELECT * FROM checks WHERE domain_id = ? ORDER BY id DESC LIMIT ?').all(domainId, limit).map(toCheck),

    sentThresholds: (domainId, kind, expiresAt) =>
      db
        .prepare("SELECT threshold FROM alerts WHERE domain_id = ? AND kind = ? AND type = 'expiry' AND expires_at = ?")
        .all(domainId, kind, expiresAt)
        .map((r) => r.threshold),
    getAlert: (domainId, kind, type, key) =>
      toAlert(db.prepare('SELECT * FROM alerts WHERE domain_id = ? AND kind = ? AND type = ? AND key = ?').get(domainId, kind, type, key)),
    // Returns the new alert's id, or null when this alert was already claimed,
    // which is what prevents duplicates.
    claimAlert({ domainId, kind, type, key, threshold = null, expiresAt = null, message, at = iso() }) {
      const { changes, lastInsertRowid } = db
        .prepare(
          'INSERT OR IGNORE INTO alerts (domain_id, kind, type, key, threshold, expires_at, sent_at, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(domainId, kind, type, key, threshold, expiresAt, at, JSON.stringify(message));
      return changes > 0 ? Number(lastInsertRowid) : null;
    },
    confirmAlert: (id, channels) => db.prepare('UPDATE alerts SET channels = ? WHERE id = ?').run(channels.join(','), id),
    releaseAlert: (id) => db.prepare('DELETE FROM alerts WHERE id = ?').run(id),
    listAlerts: (domainId, limit = 50) =>
      db
        .prepare("SELECT * FROM alerts WHERE domain_id = ? AND channels != '' ORDER BY id DESC LIMIT ?")
        .all(domainId, limit)
        .map(toAlert),

    getSettings() {
      const settings = { ...DEFAULT_SETTINGS };
      for (const { key, value } of db.prepare('SELECT key, value FROM settings').all()) {
        if (key in settings) settings[key] = JSON.parse(value);
      }
      return settings;
    },
    saveSettings(patch) {
      const upsert = db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      );
      for (const [key, value] of Object.entries(patch)) upsert.run(key, JSON.stringify(value));
    },

    listSubscriptions: () =>
      db.prepare('SELECT subscription FROM push_subscriptions').all().map((r) => JSON.parse(r.subscription)),
    countSubscriptions: () => db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n,
    saveSubscription: (sub) =>
      db
        .prepare(
          'INSERT INTO push_subscriptions (endpoint, subscription, created_at) VALUES (?, ?, ?) ' +
            'ON CONFLICT(endpoint) DO UPDATE SET subscription = excluded.subscription'
        )
        .run(sub.endpoint, JSON.stringify(sub), iso()),
    removeSubscription: (endpoint) =>
      db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint).changes > 0,
  };
}

module.exports = { openStore, DEFAULT_SETTINGS, SCHEMA_VERSION: MIGRATIONS.length };
