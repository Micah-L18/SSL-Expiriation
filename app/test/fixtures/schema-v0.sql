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
