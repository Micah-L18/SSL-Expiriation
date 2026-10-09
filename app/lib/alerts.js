'use strict';

const DAY_MS = 86_400_000;
const EXPIRED = 0;

function daysLeft(expiresAt, now) {
  return Math.floor((new Date(expiresAt) - now) / DAY_MS);
}

// Returns the threshold (in days) an alert should be sent for right now, or
// null. `sent` holds the thresholds already alerted for this same expiry date.
// Only the tightest crossed threshold fires, so a domain added with 5 days
// left gets the 7-day alert and not the 30- and 14-day ones as well. Once
// expired, an alert goes out as threshold 0 (reminderDue repeats it weekly).
function dueThreshold({ expiresAt, now, thresholds, sent }) {
  if (!thresholds.length) return null;
  const left = daysLeft(expiresAt, now);
  const crossed = thresholds.filter((t) => t >= left);
  if (!crossed.length) return null;
  const threshold = new Date(expiresAt) <= now ? EXPIRED : Math.min(...crossed);
  return sent.some((s) => s <= threshold) ? null : threshold;
}

// Returns a clean, descending list of day thresholds, or null when invalid.
function normalizeThresholds(value) {
  if (!Array.isArray(value) || value.length > 12) return null;
  if (!value.every((n) => Number.isInteger(n) && n >= 1 && n <= 365)) return null;
  return [...new Set(value)].sort((a, b) => b - a);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const KINDS = {
  ssl: {
    thing: 'SSL certificate',
    check: 'SSL check',
    dateLabel: 'Certificate expires',
    metaLabel: 'Issued by',
    action: 'Renew it to keep the site secure.',
  },
  registration: {
    thing: 'Domain registration',
    check: 'Registration lookup',
    dateLabel: 'Registration expires',
    metaLabel: 'Registrar',
    action: 'Renew it with your registrar to keep the domain.',
  },
};

// The one shape every alert takes: `body` is the short push text, `lines` the
// extra facts listed under the email.
function compose({ title, action, body = action, lines, tag, url }) {
  const all = url ? [...lines, url] : lines;
  return {
    title,
    body,
    text: `${title}.\n${action}\n\n${all.join('\n')}\n`,
    html: `<p><strong>${escapeHtml(title)}.</strong> ${escapeHtml(action)}</p><p>${all.map(escapeHtml).join('<br>')}</p>`,
    tag,
    url: url || '/',
  };
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// meta is the issuer (ssl) or registrar (registration), when known. reminder
// marks the weekly repeat sent while something stays expired.
function buildMessage({ host, kind, expiresAt, now, meta, url, reminder = false }) {
  const k = KINDS[kind];
  const left = daysLeft(expiresAt, now);
  const expired = new Date(expiresAt) <= now;
  const when = expired ? 'has expired' : left === 0 ? 'expires today' : `expires in ${plural(left, 'day')}`;
  const date = new Date(expiresAt).toUTCString().replace(/ \d\d:\d\d:\d\d GMT$/, '');
  const lines = [`${k.dateLabel}: ${date}`];
  if (meta) lines.push(`${k.metaLabel}: ${meta}`);
  return compose({
    title: reminder ? `Reminder: ${k.thing} for ${host} is still expired` : `${k.thing} for ${host} ${when}`,
    action: k.action,
    body: `${k.dateLabel} ${date}. ${k.action}`,
    lines,
    tag: `${kind}:${host}`,
    url,
  });
}

// since is when the first check of the failing run was made.
function buildFailingMessage({ host, kind, error, since, now, url }) {
  const days = Math.floor((now - new Date(since)) / DAY_MS);
  return compose({
    title: `${KINDS[kind].check} for ${host} has been failing for ${plural(days, 'day')}`,
    action: 'Its expiry date cannot be read until this is fixed, so no reminders will be sent for it.',
    body: `Last error: ${error}`,
    lines: [`Last error: ${error}`, `Failing since: ${new Date(since).toUTCString()}`],
    tag: `${kind}-check:${host}`,
    url,
  });
}

function buildRecoveredMessage({ host, kind, url }) {
  return compose({
    title: `${KINDS[kind].check} for ${host} is working again`,
    action: 'Expiry reminders for it are back on.',
    lines: [],
    tag: `${kind}-check:${host}`,
    url,
  });
}

function buildUntrustedMessage({ host, reason, issuer, url }) {
  const lines = [`Reason: ${reason || 'Not trusted'}`];
  if (issuer) lines.push(`Issued by: ${issuer}`);
  return compose({
    title: `SSL certificate for ${host} is not trusted`,
    action: 'Browsers will show a security warning. Check the certificate, its hostname and its chain.',
    body: `Reason: ${reason || 'Not trusted'}. Browsers will show a security warning.`,
    lines,
    tag: `ssl-trust:${host}`,
    url,
  });
}

// While something stays expired the "has expired" alert repeats weekly.
// Returns which weekly repeat is due (1, 2, ...) or null. firstSentAt is when
// the original expired alert went out.
function reminderDue({ firstSentAt, now }) {
  const weeks = Math.floor((now - new Date(firstSentAt)) / (7 * DAY_MS));
  return weeks >= 1 ? weeks : null;
}

module.exports = {
  DAY_MS,
  daysLeft,
  dueThreshold,
  reminderDue,
  normalizeThresholds,
  buildMessage,
  buildFailingMessage,
  buildRecoveredMessage,
  buildUntrustedMessage,
};
