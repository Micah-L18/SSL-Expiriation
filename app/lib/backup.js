'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DAY_MS } = require('./alerts');

const KEEP = 7;
const KEEP_CHECKS_DAYS = 400;
const SNAPSHOT_RE = /^tracker-.+\.db$/;

const backupDir = (dataDir) => path.join(dataDir, 'backups');
const snapshotFile = (dataDir, name) => path.join(backupDir(dataDir), `tracker-${name}.db`);

// Names start with a date, so sorting them by name is oldest first.
function listSnapshots(dataDir) {
  const dir = backupDir(dataDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => SNAPSHOT_RE.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

// Writes a consistent copy of an open database to backups/tracker-<name>.db,
// with vapid.json beside it, and removes all but the newest `keep` snapshots.
// Copying tracker.db by hand while the app runs can produce a broken file,
// because recent writes still sit in the write-ahead log; VACUUM INTO cannot.
function takeSnapshot(db, dataDir, name, keep = KEEP) {
  const file = snapshotFile(dataDir, name);
  fs.mkdirSync(backupDir(dataDir), { recursive: true });
  // Written under another name first, so a crash never leaves half a snapshot behind.
  const partial = `${file}.partial`;
  fs.rmSync(partial, { force: true });
  db.prepare('VACUUM INTO ?').run(partial);
  fs.renameSync(partial, file);

  const vapid = path.join(dataDir, 'vapid.json');
  if (fs.existsSync(vapid)) {
    const copy = path.join(backupDir(dataDir), 'vapid.json');
    fs.copyFileSync(vapid, copy);
    fs.chmodSync(copy, 0o600);
  }
  for (const old of listSnapshots(dataDir).slice(0, -keep)) fs.rmSync(old);
  return file;
}

function createBackups({ store, dataDir, now = () => new Date() }) {
  return {
    list: () => listSnapshots(dataDir),
    // Does the day's housekeeping the first time it is called each (UTC) day:
    // takes a snapshot, then drops check history too old to matter. Returns
    // the snapshot's path, or null when today's is already there.
    nightly() {
      const today = now().toISOString().slice(0, 10);
      if (fs.existsSync(snapshotFile(dataDir, today))) return null;
      const file = store.snapshot(dataDir, today);
      store.pruneChecks(new Date(now() - KEEP_CHECKS_DAYS * DAY_MS).toISOString());
      return file;
    },
  };
}

module.exports = { createBackups, takeSnapshot, listSnapshots };
