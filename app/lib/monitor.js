'use strict';

const {
  dueThreshold,
  reminderDue,
  buildMessage,
  buildFailingMessage,
  buildRecoveredMessage,
  buildUntrustedMessage,
  DAY_MS,
} = require('./alerts');
const { deliveryOutcome, CHANNELS } = require('./notify');

const HOUR_MS = 3_600_000;
const CONCURRENCY = 4;
const KINDS = ['ssl', 'registration'];
// A failed check is tried again on each of the next hourly ticks this many
// times, then left until its normal daily turn.
const QUICK_RETRIES = 3;
// How long a check must keep failing before it is worth an alert.
const FAILING_AFTER_DAYS = 3;
// Sends tried per channel for one alert, the first one included.
const MAX_ATTEMPTS = 5;
// An alert that reached nobody because no channel was set up is still worth
// sending for this long, should a channel appear.
const UNREACHED_DAYS = 7;
// How long to keep asking the email provider whether an email arrived.
const CONFIRM_DAYS = 3;

// checkers: { ssl(host), registration(host) }, each resolving to
// { ok, expiresAt?, error?, ...detail }.
function createMonitor({ store, checkers, notifier, now = () => new Date(), publicUrl = '', log = console }) {
  const running = new Map();
  let timer = null;

  const guarded = (promise) => promise.catch((err) => ({ ok: false, error: `Check failed: ${err.message}` }));

  const sending = new Set();

  // Sends an alert on the given channels and records what happened to each.
  async function deliver(alertId, message, channels) {
    if (sending.has(alertId)) return;
    sending.add(alertId);
    try {
      let results = {};
      let thrown = null;
      try {
        results = await notifier.send(message, store.getSettings(), channels);
      } catch (err) {
        thrown = err.message;
        log.error(`Alert "${message.title}" failed: ${thrown}`);
      }
      for (const channel of channels) {
        const outcome = results[channel] ? deliveryOutcome(channel, results[channel]) : { status: 'failed', error: thrown };
        store.recordDelivery(alertId, channel, outcome, now().toISOString());
      }
    } finally {
      sending.delete(alertId);
    }
  }

  // alert is { type, key, threshold?, expiresAt? }; type and key are what make
  // it unique for this domain and kind. Once claimed an alert is never sent
  // again as a whole; only the channels that did not get through are retried.
  async function sendAlert(domain, kind, alert, message) {
    const id = store.claimAlert({ domainId: domain.id, kind, ...alert, message, at: now().toISOString() });
    if (id) await deliver(id, message, CHANNELS);
  }

  async function retryDeliveries() {
    const owed = store.owedDeliveries({
      maxAttempts: MAX_ATTEMPTS,
      skippedSince: new Date(now() - UNREACHED_DAYS * DAY_MS).toISOString(),
    });
    const byAlert = Map.groupBy(owed, (d) => d.alertId);
    for (const [alertId, rows] of byAlert) await deliver(alertId, rows[0].message, rows.map((r) => r.channel));
  }

  // "Sent" only means the provider accepted the email; ask what became of it.
  async function confirmEmails() {
    for (const { alertId, messageId } of store.unconfirmedEmails(new Date(now() - CONFIRM_DAYS * DAY_MS).toISOString())) {
      const { status, error } = await notifier.emailDelivery(messageId);
      if (status === 'sent' || status === 'unknown') continue; // no news yet; ask again next tick
      store.recordDelivery(alertId, 'email', { status, error, attempted: false }, now().toISOString());
    }
  }

  // before is the failure streak as it stood ahead of this check.
  async function alertIfDue(domain, kind, result, before) {
    const settings = store.getSettings();
    const thresholds = kind === 'ssl' ? settings.sslThresholds : settings.registrationThresholds;
    if (!thresholds.length) return; // alerts for this kind are turned off
    const send = (alert, message) => sendAlert(domain, kind, alert, message);
    const about = { host: domain.host, kind, now: now(), url: publicUrl };

    if (!result.ok) {
      // A registry with no expiry lookup is a permanent state, not a failure.
      if (result.unsupported) return;
      const streak = store.failureStreak(domain.id, kind);
      if (streak.count < 3 || now() - new Date(streak.since) < FAILING_AFTER_DAYS * DAY_MS) return;
      return send({ type: 'failing', key: String(streak.afterId) }, buildFailingMessage({ ...about, error: result.error, since: streak.since }));
    }

    const failing = String(before.afterId);
    if (before.count && store.getAlert(domain.id, kind, 'failing', failing)) {
      await send({ type: 'recovered', key: failing }, buildRecoveredMessage(about));
    }

    const { expiresAt } = result;
    const expiry = { ...about, expiresAt, meta: kind === 'ssl' ? result.issuer : result.registrar };
    const expired = new Date(expiresAt) <= now();
    const threshold = dueThreshold({ expiresAt, now: now(), thresholds, sent: store.sentThresholds(domain.id, kind, expiresAt) });
    if (threshold !== null) {
      await send({ type: 'expiry', key: `${expiresAt}:${threshold}`, threshold, expiresAt }, buildMessage(expiry));
    } else if (expired) {
      const first = store.getAlert(domain.id, kind, 'expiry', `${expiresAt}:0`);
      const week = first && reminderDue({ firstSentAt: first.sentAt, now: now() });
      if (week) await send({ type: 'reminder', key: `${expiresAt}:${week}`, threshold: 0, expiresAt }, buildMessage({ ...expiry, reminder: true }));
    }

    // An expired certificate is untrusted too; the expiry alerts already cover that.
    if (kind === 'ssl' && result.trusted === false && !expired) {
      await send(
        { type: 'untrusted', key: result.fingerprint || expiresAt, expiresAt },
        buildUntrustedMessage({ ...about, reason: result.trustError, issuer: result.issuer })
      );
    }
  }

  async function run(domain, kind) {
    const result = await guarded(checkers[kind](kind === 'registration' ? domain.registrable || domain.host : domain.host));
    const current = store.getDomain(domain.id);
    if (!current) return; // removed while the check was in flight
    const before = store.failureStreak(domain.id, kind);
    store.addCheck(domain.id, kind, result, now().toISOString());
    if (kind === 'registration' && result.ok && result.domain && result.domain !== current.registrable) {
      store.setRegistrable(domain.id, result.domain);
    }
    await alertIfDue(domain, kind, result, before);
  }

  // Each check of a domain only ever runs once at a time; overlapping callers share the run.
  function checkKind(domain, kind) {
    const key = `${domain.id}:${kind}`;
    if (!running.has(key)) {
      running.set(
        key,
        run(domain, kind).finally(() => running.delete(key))
      );
    }
    return running.get(key);
  }

  const checkDomain = (domain, kinds = KINDS) => Promise.all(kinds.map((kind) => checkKind(domain, kind)));

  // jobs: [domain, kinds] pairs.
  async function checkMany(jobs) {
    const queue = [...jobs];
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        await checkDomain(...job).catch((err) => log.error(`Check of ${job[0].host} failed: ${err.message}`));
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }

  function dueKinds(domain, intervalMs) {
    const cutoff = new Date(now() - intervalMs).toISOString();
    return KINDS.filter((kind) => {
      const latest = store.latestCheck(domain.id, kind);
      if (!latest || latest.checkedAt <= cutoff) return true;
      // A failed check does not count as checked: it is retried on the next
      // ticks, and only after those does it wait for its daily turn.
      return !latest.ok && !latest.detail.unsupported && store.failureStreak(domain.id, kind).count <= QUICK_RETRIES;
    });
  }

  function checkDue(intervalMs) {
    const jobs = store.listDomains().map((domain) => [domain, dueKinds(domain, intervalMs)]);
    return checkMany(jobs.filter(([, kinds]) => kinds.length));
  }

  // One scheduler pass: follows up on alerts already sent, then checks
  // whatever is due. Each step is independent, so one failing does not stop the rest.
  async function tick(intervalMs = DAY_MS) {
    const steps = { 'Email status check': confirmEmails, 'Alert retry': retryDeliveries, 'Scheduled check': () => checkDue(intervalMs) };
    for (const [name, step] of Object.entries(steps)) {
      try {
        await step();
      } catch (err) {
        log.error(`${name} failed: ${err.message}`);
      }
    }
  }

  return {
    checkDomain,
    checkAll: () => checkMany(store.listDomains().map((domain) => [domain, KINDS])),
    tick,
    // Ticks every hour, so a restart or a sleeping machine never skips a day.
    start({ intervalMs = DAY_MS } = {}) {
      tick(intervalMs);
      timer = setInterval(() => tick(intervalMs), Math.min(HOUR_MS, intervalMs));
    },
    stop: () => clearInterval(timer),
  };
}

module.exports = { createMonitor };
