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
const { exitOnFatal } = require('./lib/fatal');

exitOnFatal();

const env = process.env;
const port = Number(env.PORT) || 3000;
const host = env.HOST || '127.0.0.1';
const dataDir = path.resolve(__dirname, env.DATA_DIR || 'data');
const intervalMs = (Number(env.CHECK_INTERVAL_HOURS) || 24) * 3_600_000;

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
// Listening on one specific address makes that address a way in; listening
// on all of them (0.0.0.0, ::) names none.
const bound = ['0.0.0.0', '::'].includes(host) ? [] : [host.includes(':') ? `[${host}]` : host];
const allowedHosts = [...bound, ...(env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean)];
const server = createApp({
  store,
  monitor,
  notifier,
  backups,
  allowedHosts,
  publicUrl: env.PUBLIC_URL || '',
  publicDir: path.join(__dirname, 'public'),
});

server.listen(port, host, () => {
  console.log(`SSL Tracker running at http://${host}:${port}`);
  if (!LOOPBACK.includes(bound[0] || host)) {
    console.warn(
      `WARNING: listening on ${host}, not just this machine. There is no login: anyone who can reach port ${port} ` +
        'can see and change everything. Keep it behind a private network (Tailscale), a firewall, or a Docker port ' +
        'published on 127.0.0.1 only.'
    );
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
