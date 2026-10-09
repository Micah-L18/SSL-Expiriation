'use strict';

const { dueThreshold, buildMessage, DAY_MS } = require('./alerts');
const { deliveredChannels } = require('./notify');

const HOUR_MS = 3_600_000;
const CONCURRENCY = 4;

// checkers: { ssl(host), registration(host) }, each resolving to
// { ok, expiresAt?, error?, ...detail }.
function createMonitor({ store, checkers, notifier, now = () => new Date(), publicUrl = '', log = console }) {
  const running = new Map();
  let timer = null;

  const guarded = (promise) => promise.catch((err) => ({ ok: false, error: `Check failed: ${err.message}` }));

  async function alertIfDue(domain, kind, result) {
    if (!result.ok) return;
    const settings = store.getSettings();
    const thresholds = kind === 'ssl' ? settings.sslThresholds : settings.registrationThresholds;
    const key = [domain.id, kind];
    const threshold = dueThreshold({
      expiresAt: result.expiresAt,
      now: now(),
      thresholds,
      sent: store.sentThresholds(...key, result.expiresAt),
    });
    if (threshold === null || !store.claimAlert(...key, threshold, result.expiresAt)) return;

    const message = buildMessage({
      host: domain.host,
      kind,
      expiresAt: result.expiresAt,
      now: now(),
      meta: kind === 'ssl' ? result.issuer : result.registrar,
      url: publicUrl,
    });
    let channels = [];
    try {
      channels = deliveredChannels(await notifier.send(message, settings));
    } catch (err) {
      log.error(`Alert for ${domain.host} failed: ${err.message}`);
    }
    // Nothing got through, so give the claim back and let the next check retry.
    if (channels.length) store.confirmAlert(...key, threshold, result.expiresAt, channels);
    else store.releaseAlert(...key, threshold, result.expiresAt);
  }

  async function run(domain) {
    const [ssl, registration] = await Promise.all([
      guarded(checkers.ssl(domain.host)),
      guarded(checkers.registration(domain.registrable || domain.host)),
    ]);
    if (!store.getDomain(domain.id)) return; // removed while the check was in flight
    const checkedAt = now().toISOString();
    store.addCheck(domain.id, 'ssl', ssl, checkedAt);
    store.addCheck(domain.id, 'registration', registration, checkedAt);
    if (registration.ok && registration.domain && registration.domain !== domain.registrable)store.setRegistrable(domain.id, registration.domain);
    await alertIfDue(domain, 'ssl', ssl);
    await alertIfDue(domain, 'registration', registration);
  }

  // A domain is only ever checked once at a time; overlapping callers share the run.
  function checkDomain(domain) {
    if (!running.has(domain.id)) {
      running.set(
        domain.id,
        run(domain).finally(() => running.delete(domain.id))
      );
    }
    return running.get(domain.id);
  }

  async function checkMany(domains) {
    const queue = [...domains];
    const worker = async () => {
      for (let d = queue.shift(); d; d = queue.shift()) {
        await checkDomain(d).catch((err) => log.error(`Check of ${d.host} failed: ${err.message}`));
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }

  function checkStale(intervalMs) {
    const cutoff = new Date(now() - intervalMs).toISOString();
    return checkMany(store.listDomains().filter((d) => (store.lastCheckedAt(d.id) || '') <= cutoff));
  }

  return {
    checkDomain,
    checkAll: () => checkMany(store.listDomains()),
    // Looks every hour for domains not checked within the interval, so a
    // restart or a sleeping machine never skips a day.
    start({ intervalMs = DAY_MS } = {}) {
      const tick = () => checkStale(intervalMs).catch((err) => log.error(`Scheduled check failed: ${err.message}`));
      tick();
      timer = setInterval(tick, Math.min(HOUR_MS, intervalMs));
    },
    stop: () => clearInterval(timer),
  };
}

module.exports = { createMonitor };
