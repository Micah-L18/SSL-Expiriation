'use strict';

const { DatabaseSync } = require('node:sqlite');

const DEFAULT_SETTINGS = {
  sslThresholds: [30, 14, 7, 1],
  registrationThresholds: [30, 14, 7, 1],
  emailEnabled: true,
  emailTo: '',
  pushEnabled: true,
};

const SCHEMA = `
  PRAGMA foreign_keys = ON;
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
`;

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

// file is a path, or ':memory:' for tests.
function openStore(file) {
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
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
    lastCheckedAt: (domainId) =>
      db.prepare('SELECT MAX(checked_at) AS at FROM checks WHERE domain_id = ?').get(domainId).at,
    history: (domainId, limit = 50) =>
      db.prepare('SELECT * FROM checks WHERE domain_id = ? ORDER BY id DESC LIMIT ?').all(domainId, limit).map(toCheck),

    sentThresholds: (domainId, kind, expiresAt) =>
      db
        .prepare('SELECT threshold FROM alerts WHERE domain_id = ? AND kind = ? AND expires_at = ?')
        .all(domainId, kind, expiresAt)
        .map((r) => r.threshold),
    // Returns false when this alert was already claimed, which is what prevents duplicates.
    claimAlert: (domainId, kind, threshold, expiresAt) =>
      db
        .prepare('INSERT OR IGNORE INTO alerts (domain_id, kind, threshold, expires_at, sent_at) VALUES (?, ?, ?, ?, ?)')
        .run(domainId, kind, threshold, expiresAt, iso()).changes > 0,
    confirmAlert: (domainId, kind, threshold, expiresAt, channels) =>
      db
        .prepare('UPDATE alerts SET channels = ? WHERE domain_id = ? AND kind = ? AND threshold = ? AND expires_at = ?')
        .run(channels.join(','), domainId, kind, threshold, expiresAt),
    releaseAlert: (domainId, kind, threshold, expiresAt) =>
      db
        .prepare('DELETE FROM alerts WHERE domain_id = ? AND kind = ? AND threshold = ? AND expires_at = ?')
        .run(domainId, kind, threshold, expiresAt),
    listAlerts: (domainId, limit = 50) =>
      db
        .prepare("SELECT * FROM alerts WHERE domain_id = ? AND channels != '' ORDER BY id DESC LIMIT ?")
        .all(domainId, limit)
        .map((r) => ({
          kind: r.kind,
          threshold: r.threshold,
          expiresAt: r.expires_at,
          sentAt: r.sent_at,
          channels: r.channels.split(','),
        })),

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

module.exports = { openStore, DEFAULT_SETTINGS };
