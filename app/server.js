'use strict';

const fs = require('node:fs');
const path = require('node:path');

const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const { openStore } = require('./lib/db');
const { checkSsl, checkRegistration } = require('./lib/checks');
const { createNotifier } = require('./lib/notify');
const { createMonitor } = require('./lib/monitor');
const { createApp, LOOPBACK } = require('./lib/api');
const { createBackups } = require('./lib/backup');
const { parseHash } = require('./lib/auth');
const { exitOnFatal } = require('./lib/fatal');

exitOnFatal();

const env = process.env;
const port = Number(env.PORT) || 3000;
const host = env.HOST || '127.0.0.1';
const dataDir = path.resolve(__dirname, env.DATA_DIR || 'data');
const intervalMs = (Number(env.CHECK_INTERVAL_HOURS) || 24) * 3_600_000;
// Listening on one specific address makes that address a way in; listening
// on all of them (0.0.0.0, ::) names none.
const bound = ['0.0.0.0', '::'].includes(host) ? [] : [host.includes(':') ? `[${host}]` : host];
const passwordHash = (env.AUTH_PASSWORD_HASH || '').trim();

function refuseToStart(message) {
  console.error(`Not starting: ${message}`);
  process.exit(1);
}
if (passwordHash && !parseHash(passwordHash)) {
  refuseToStart('AUTH_PASSWORD_HASH is not a valid hash. Create one with: node scripts/hash-password.js');
}
if (!passwordHash && !LOOPBACK.includes(bound[0] || host)) {
  refuseToStart(
    `HOST=${host} lets other machines reach the tracker, and no password is set. ` +
      'Create one with "node scripts/hash-password.js" and put the AUTH_PASSWORD_HASH line it prints in .env, ' +
      'or set HOST=127.0.0.1.'
  );
}

fs.mkdirSync(dataDir, { recursive: true });
const store = openStore(path.join(dataDir, 'tracker.db'));
const notifier = createNotifier({ store, dataDir, env });
const backups = createBackups({ store, dataDir });
const monitor = createMonitor({
  store,
  notifier,
  maintain: () => backups.nightly(),
  checkers: { ssl: checkSsl, registration: checkRegistration },
  publicUrl: env.PUBLIC_URL || '',
  heartbeatUrl: env.HEARTBEAT_URL || '',
});
const allowedHosts = [...bound, ...(env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean)];
const server = createApp({
  store,
  monitor,
  notifier,
  backups,
  allowedHosts,
  passwordHash,
  trustProxy: env.TRUST_PROXY === '1',
  publicUrl: env.PUBLIC_URL || '',
  publicDir: path.join(__dirname, 'public'),
});

server.listen(port, host, () => {
  console.log(`SSL Tracker running at http://${host}:${port}`);
  if (!passwordHash) {
    console.log('Login is off: AUTH_PASSWORD_HASH is not set. Anyone who can reach this address can see and change everything.');
  }
  if (!env.RESEND_API_KEY) console.log('Email alerts are off: RESEND_API_KEY is not set.');
  if (!env.HEARTBEAT_URL) console.log('Heartbeat is off: HEARTBEAT_URL is not set, so nothing will tell you if the tracker stops.');
  monitor.start({ intervalMs });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    monitor.stop();
    server.close(() => {
      store.close();
      process.exit(0);
    });
    server.closeAllConnections();
  });
}
