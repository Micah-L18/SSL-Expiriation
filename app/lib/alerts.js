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
// expired, a single alert goes out as threshold 0.
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
  ssl: { thing: 'SSL certificate', dateLabel: 'Certificate expires', metaLabel: 'Issued by', action: 'Renew it to keep the site secure.' },
  registration: {
    thing: 'Domain registration',
    dateLabel: 'Registration expires',
    metaLabel: 'Registrar',
    action: 'Renew it with your registrar to keep the domain.',
  },
};

// meta is the issuer (ssl) or registrar (registration), when known.
function buildMessage({ host, kind, expiresAt, now, meta, url }) {
  const k = KINDS[kind];
  const left = daysLeft(expiresAt, now);
  const expired = new Date(expiresAt) <= now;
  const when = expired ? 'has expired' : left === 0 ? 'expires today' : `expires in ${left} day${left === 1 ? '' : 's'}`;
  const date = new Date(expiresAt).toUTCString().replace(/ \d\d:\d\d:\d\d GMT$/, '');
  const title = `${k.thing} for ${host} ${when}`;
  const lines = [`${k.dateLabel}: ${date}`];
  if (meta) lines.push(`${k.metaLabel}: ${meta}`);
  if (url) lines.push(url);
  return {
    title,
    body: `${k.dateLabel} ${date}. ${k.action}`,
    text: `${title}.\n${k.action}\n\n${lines.join('\n')}\n`,
    html:
      `<p><strong>${escapeHtml(title)}.</strong> ${escapeHtml(k.action)}</p>` +
      `<p>${lines.map(escapeHtml).join('<br>')}</p>`,
    tag: `${kind}:${host}`,
    url: url || '/',
  };
}

module.exports = { DAY_MS, daysLeft, dueThreshold, normalizeThresholds, buildMessage };
