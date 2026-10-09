'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { takeSnapshot } = require('./backup');

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
  // 3: what happened to an alert is tracked per channel instead of as one list.
  `
  CREATE TABLE deliveries (
    alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    message_id TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (alert_id, channel)
  );
  INSERT INTO deliveries (alert_id, channel, status, attempts, updated_at)
    SELECT id, 'email', 'sent', 1, sent_at FROM alerts WHERE ',' || channels || ',' LIKE '%,email,%';
  INSERT INTO deliveries (alert_id, channel, status, attempts, updated_at)
    SELECT id, 'push', 'sent', 1, sent_at FROM alerts WHERE ',' || channels || ',' LIKE '%,push,%';
  DELETE FROM alerts WHERE channels = '';
  ALTER TABLE alerts DROP COLUMN channels;
  `,
  // 4: login sessions. Only a hash of each session token is kept, so a copy
  // of the database (a backup, say) cannot be used to sign in.
  `
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    credential TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  `,
];

const CHANNELS = ['email', 'push'];
// Delivery statuses that mean the alert reached, or may yet reach, a person.
const REACHED = "('sent', 'delivered')";

function schemaVersion(db) {
  return db.prepare('PRAGMA user_version').get().user_version;
}

// dataDir is where a snapshot goes before an existing database is changed;
// null (an in-memory database) skips that.
function migrate(db, dataDir, now) {
  const from = schemaVersion(db);
  if (from >= MIGRATIONS.length) return;
  const existing = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n > 0;
  if (existing && dataDir) {
    const stamp = now().toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '');
    takeSnapshot(db, dataDir, `${stamp}-schema-v${from}`);
  }
  for (let version = from; version < MIGRATIONS.length; version++) {
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

function toDelivery(row) {
  return {
    status: row.status,
    attempts: row.attempts,
    error: row.error,
    messageId: row.message_id,
    updatedAt: row.updated_at,
  };
}

// file is a path, or ':memory:' for tests. An existing database on an older
// schema is snapshotted into <its folder>/backups and then upgraded.
function openStore(file, { now = () => new Date() } = {}) {
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db, file === ':memory:' ? null : path.dirname(file), now);
  const iso = () => new Date().toISOString();

  function toAlert(row) {
    const deliveries = {};
    for (const d of db.prepare('SELECT * FROM deliveries WHERE alert_id = ?').all(row.id)) deliveries[d.channel] = toDelivery(d);
    return {
      kind: row.kind,
      type: row.type,
      title: row.message ? JSON.parse(row.message).title : null,
      threshold: row.threshold,
      expiresAt: row.expires_at,
      sentAt: row.sent_at,
      channels: CHANNELS.filter((c) => deliveries[c] && ['sent', 'delivered'].includes(deliveries[c].status)),
      deliveries,
    };
  }

  return {
    close: () => db.close(),
    snapshot: (dataDir, name) => takeSnapshot(db, dataDir, name),

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
    // Deletes checks made before the given time, except the latest good check
    // of each domain and kind: that one holds the dates still being shown.
    pruneChecks: (before) =>
      db
        .prepare(
          'DELETE FROM checks WHERE checked_at < ? AND id NOT IN (SELECT MAX(id) FROM checks WHERE ok = 1 GROUP BY domain_id, kind)'
        )
        .run(before).changes,
    history: (domainId, limit = 50) =>
      db.prepare('SELECT * FROM checks WHERE domain_id = ? ORDER BY id DESC LIMIT ?').all(domainId, limit).map(toCheck),

    sentThresholds: (domainId, kind, expiresAt) =>
      db
        .prepare("SELECT threshold FROM alerts WHERE domain_id = ? AND kind = ? AND type = 'expiry' AND expires_at = ?")
        .all(domainId, kind, expiresAt)
        .map((r) => r.threshold),
    getAlert(domainId, kind, type, key) {
      const row = db.prepare('SELECT * FROM alerts WHERE domain_id = ? AND kind = ? AND type = ? AND key = ?').get(domainId, kind, type, key);
      return row && toAlert(row);
    },
    // Returns the new alert's id, or null when this alert was already claimed,
    // which is what prevents duplicates. Every channel starts out pending.
    claimAlert({ domainId, kind, type, key, threshold = null, expiresAt = null, message, at = iso() }) {
      const { changes, lastInsertRowid } = db
        .prepare(
          'INSERT OR IGNORE INTO alerts (domain_id, kind, type, key, threshold, expires_at, sent_at, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(domainId, kind, type, key, threshold, expiresAt, at, JSON.stringify(message));
      if (!changes) return null;
      const id = Number(lastInsertRowid);
      const pending = db.prepare("INSERT INTO deliveries (alert_id, channel, status, updated_at) VALUES (?, ?, 'pending', ?)");
      for (const channel of CHANNELS) pending.run(id, channel, at);
      return id;
    },
    // attempted is false when nothing was actually sent (a skipped channel, or
    // a status update for an earlier send), so it does not use up an attempt.
    recordDelivery: (alertId, channel, { status, error = null, messageId = null, attempted = true }, at = iso()) =>
      db
        .prepare(
          'UPDATE deliveries SET status = ?, error = ?, message_id = COALESCE(?, message_id), attempts = attempts + ?, updated_at = ? ' +
            'WHERE alert_id = ? AND channel = ?'
        )
        .run(status, error, messageId, attempted ? 1 : 0, at, alertId, channel),
    // Channels still owed a send: ones that failed (or never finished) with
    // attempts left, and skipped ones on a recent alert that reached nobody.
    owedDeliveries: ({ maxAttempts, skippedSince }) =>
      db
        .prepare(
          `SELECT d.alert_id AS alertId, d.channel, a.message FROM deliveries d JOIN alerts a ON a.id = d.alert_id
           WHERE a.message IS NOT NULL AND (
             (d.status IN ('pending', 'failed') AND d.attempts < ?)
             OR (d.status = 'skipped' AND a.sent_at > ? AND NOT EXISTS
               (SELECT 1 FROM deliveries o WHERE o.alert_id = d.alert_id AND o.status IN ${REACHED}))
           ) ORDER BY d.alert_id`
        )
        .all(maxAttempts, skippedSince)
        .map((r) => ({ ...r, message: JSON.parse(r.message) })),
    // Emails the provider accepted but has not yet reported as delivered or bounced.
    unconfirmedEmails: (since) =>
      db
        .prepare(
          "SELECT alert_id AS alertId, message_id AS messageId FROM deliveries " +
            "WHERE channel = 'email' AND status = 'sent' AND message_id IS NOT NULL AND updated_at > ?"
        )
        .all(since),
    listAlerts: (domainId, limit = 50) =>
      db.prepare('SELECT * FROM alerts WHERE domain_id = ? ORDER BY id DESC LIMIT ?').all(domainId, limit).map(toAlert),
    lastDelivery(channel) {
      const row = db
        .prepare("SELECT * FROM deliveries WHERE channel = ? AND status NOT IN ('pending', 'skipped') ORDER BY updated_at DESC, alert_id DESC LIMIT 1")
        .get(channel);
      return row ? toDelivery(row) : null;
    },
    deliveryProblems: (since, limit = 20) =>
      db
        .prepare(
          `SELECT d.*, a.kind, a.type, a.message, m.id AS domain_id, m.host FROM deliveries d
           JOIN alerts a ON a.id = d.alert_id JOIN domains m ON m.id = a.domain_id
           WHERE d.status IN ('failed', 'bounced', 'complained') AND d.updated_at > ?
           ORDER BY d.updated_at DESC, d.alert_id DESC LIMIT ?`
        )
        .all(since, limit)
        .map((r) => ({
          domainId: r.domain_id,
          host: r.host,
          kind: r.kind,
          type: r.type,
          title: r.message ? JSON.parse(r.message).title : null,
          channel: r.channel,
          ...toDelivery(r),
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

    // credential names the password a session was opened with; a session from
    // before a password change no longer counts.
    addSession: (tokenHash, credential, createdAt, expiresAt) =>
      db.prepare('INSERT INTO sessions (token_hash, credential, created_at, expires_at) VALUES (?, ?, ?, ?)').run(tokenHash, credential, createdAt, expiresAt),
    hasSession: (tokenHash, credential, at) =>
      Boolean(db.prepare('SELECT 1 FROM sessions WHERE token_hash = ? AND credential = ? AND expires_at > ?').get(tokenHash, credential, at)),
    deleteSession: (tokenHash) => db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash).changes > 0,
    deleteExpiredSessions: (at) => db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(at).changes,

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
