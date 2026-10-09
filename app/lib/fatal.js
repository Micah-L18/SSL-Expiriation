'use strict';

// After an error nothing caught, the process may be half-alive: still
// listening but no longer checking. Exiting non-zero hands it to whatever
// supervises it (Docker, systemd) to restart.
function exitOnFatal({ log = console } = {}) {
  for (const event of ['uncaughtException', 'unhandledRejection']) {
    process.on(event, (err) => {
      log.error(`Stopping after an unhandled error (${event}):`, err);
      process.exit(1);
    });
  }
}

module.exports = { exitOnFatal };
