# SSL Tracker

A private, self-hosted tracker for SSL certificate expiry and domain registration
expiry. It checks every domain daily and sends an email and/or a push
notification as each expiry gets close.

Single user, no login. Run it on your own machine or server.

## Setup

Needs Node.js 22.13 or newer (it uses Node's built-in SQLite).

```sh
cd app
npm install
cp .env.example .env    # then fill in the email settings
npm start
```

Open http://127.0.0.1:3000.

Data lives in `app/data/` (`tracker.db` and `vapid.json`). See
[Backups and restore](#backups-and-restore).

### Configuration (`.env`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Address to listen on. `0.0.0.0` exposes it to your network; the app logs a warning at startup when this is not a loopback address. |
| `PORT` | `3000` | Port to listen on. |
| `RESEND_API_KEY` | none | API key from [Resend](https://resend.com). Email alerts are off without it. |
| `ALERT_EMAIL_TO` | none | Where alerts go. Can be overridden in the app's alert settings. |
| `ALERT_EMAIL_FROM` | `SSL Tracker <onboarding@resend.dev>` | Sender. Use an address on a domain verified in Resend; the default only delivers to your own Resend login email. |
| `PUBLIC_URL` | none | The address you open the app at; used as the link in alerts, and allowed as a `Host` and `Origin`. |
| `ALLOWED_HOSTS` | none | Extra hostnames or IPs the app may be opened at, comma separated. See [Which addresses the app answers to](#which-addresses-the-app-answers-to). |
| `VAPID_SUBJECT` | `mailto:ALERT_EMAIL_TO` | Contact address given to browser push services. |
| `DATA_DIR` | `data` | Where the database and push keys are stored. |
| `CHECK_INTERVAL_HOURS` | `24` | How often each domain is re-checked. |
| `HEARTBEAT_URL` | none | Fetched after every completed scheduler run. See [Knowing the tracker is alive](#knowing-the-tracker-is-alive). |

### HTTPS (needed for push notifications)

Browsers only allow push notifications and app install on HTTPS (or on
`localhost`). To use them from a phone or another computer, put a reverse proxy
with a certificate in front and keep `HOST=127.0.0.1`. With
[Caddy](https://caddyserver.com) that is two lines:

```
tracker.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

There is no login, so anyone who can reach the address can see and change your
domains. Keep it on a private network or VPN (Tailscale works well), or add
authentication at the proxy (`basic_auth` in Caddy).

### Which addresses the app answers to

There is no login, so the app refuses the requests that would let another
website reach it through your browser.

- **Host allowlist.** A request is answered only when its `Host` header names
  this machine (`localhost`, `127.0.0.1`, `[::1]`), the host of `PUBLIC_URL`,
  the address in `HOST` when that is a specific one, or an entry in
  `ALLOWED_HOSTS`. Anything else gets `403`. If you open the app at an address
  and get "This address is not allowed to reach the tracker", add that address
  to `PUBLIC_URL` or `ALLOWED_HOSTS` and restart. The port does not matter.
- **Origin check.** A request that changes something (`POST`, `PUT`,
  `DELETE`) and carries an `Origin` header gets `403` unless that origin is the
  app itself or `PUBLIC_URL`. Scripts and `curl` send no `Origin` and are not
  affected.
- **Headers.** Every response carries a `Content-Security-Policy` (scripts
  from the app only, fonts from Google Fonts, `frame-ancestors 'none'`),
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and
  `X-Content-Type-Options: nosniff`.

None of this is a substitute for keeping the app off the public internet:
anyone who can reach it directly can still use it.

### Knowing the tracker is alive

A tracker that has stopped cannot tell you so. Two things cover that.

**Heartbeat.** Set `HEARTBEAT_URL` and the app sends one GET request to it
after every completed scheduler run, which is once an hour. Create a check at
an outside service such as [healthchecks.io](https://healthchecks.io) (the
free tier is enough) with a period of 1 hour and a grace time of 2 hours, and
paste its ping URL in. When the pings stop (machine off, app crashed, network
down) that service emails you. Without `HEARTBEAT_URL` no request is made.

The ping means "the scheduler is running", not "every check passed": a run
that finished with errors still pings. Failing checks have their own alerts.

**Health.** `GET /api/health` answers `200` while the scheduler is running and
`503` once 3 hours pass without a completed run (counted from startup until
the first run finishes):

```json
{
  "ok": true,
  "startedAt": "2026-10-09T08:00:00.000Z",
  "lastTick": { "at": "2026-10-09T09:00:03.120Z", "ok": true, "errors": [] },
  "domains": 12,
  "lastBackupAt": "2026-10-09T08:00:04.000Z",
  "heartbeat": { "enabled": true, "lastAt": "2026-10-09T09:00:03.120Z", "lastError": null }
}
```

`lastTick` is `null` until the first run finishes; `lastTick.ok` is `false`
when a step of that run failed, with the reasons in `errors`. `lastBackupAt`
is `null` before the first snapshot. `heartbeat.lastError` says why the last
ping did not get through.

An error nothing handled stops the process with exit code 1 rather than leave
it half-alive, so run it under something that restarts it: Docker, or systemd
with `Restart=on-failure` (see [Start on boot](#start-on-boot)).

### Backups and restore

Once a day the app writes a snapshot of the database to
`data/backups/tracker-YYYY-MM-DD.db` (dates are UTC) and keeps the newest
seven. `vapid.json`, the push keys, is copied to `data/backups/vapid.json`
each time. A snapshot is a complete, ordinary SQLite file.

The backups sit on the same disk as the data, so they protect against a bad
upgrade or a damaged database, not a dead disk. Copy `data/backups/` somewhere
else now and then. Do not copy `data/tracker.db` itself while the app is
running: recent changes live in the `tracker.db-wal` file beside it and a plain
copy can come out broken.

To restore:

1. Stop the app.
2. Move the damaged files out of the way:
   `mkdir data/broken && mv data/tracker.db* data/broken/`
3. Copy the snapshot you want into place:
   `cp data/backups/tracker-2026-10-09.db data/tracker.db`
4. If `data/vapid.json` is missing or was replaced, restore it too:
   `cp data/backups/vapid.json data/vapid.json`. Without the original
   `vapid.json` every device has to turn push notifications on again.
5. Start the app. Domains, check history, settings, alert history and push
   subscriptions are back as of the snapshot. Checks that are due run within
   the hour, and alerts already sent before the snapshot are not sent again.

On a new machine: install the app, create `data/`, and do steps 3 to 5.

### Upgrading

The database carries a schema version. When a new version of the app starts
on an older database it first writes a snapshot named
`data/backups/tracker-<timestamp>-schema-v<N>.db` (the database exactly as the
old version left it), then upgrades it. To go back, check out the previous
version of the app and restore that snapshot as above; an older app cannot
read a database that a newer one has upgraded.

Check history older than 400 days is deleted daily. The latest successful
check of each domain is always kept, however old.

### Start on boot

Linux (systemd), as `/etc/systemd/system/ssl-tracker.service`:

```ini
[Unit]
Description=SSL Tracker
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/path/to/app
ExecStart=/usr/bin/npm start
Restart=on-failure
User=youruser

[Install]
WantedBy=multi-user.target
```

Then `sudo systemctl enable --now ssl-tracker`.

Alternatives: `pm2 start server.js --name ssl-tracker && pm2 save && pm2 startup`
on any OS, or a launchd agent on macOS.

## How it works

- **SSL**: connects to port 443 and reads the certificate (expiry, issuer, and
  whether it is trusted).
- **Domain registration**: looked up over RDAP through rdap.org. For a
  subdomain, the registered parent domain is found automatically. Some
  registries (for example `.de`) do not publish expiry dates; those show as
  `unsupported` and never alert.
- **Schedule**: each domain is checked when added and then every
  `CHECK_INTERVAL_HOURS`. The app looks hourly for checks that are due, so a
  restart or a sleeping machine does not skip a day. A check that fails does
  not count as done: it is tried again on each of the next three hourly looks,
  and only then waits for its normal daily turn.
- **Expiry alerts**: one alert per threshold crossed, per expiry date. With
  thresholds 30/14/7/1 you get at most four reminders plus one "has expired"
  notice, which then repeats weekly for as long as it stays expired. A domain
  added with 5 days left gets only the 7-day alert. Renewing (a new expiry
  date) starts a fresh cycle.
- **Failing checks**: when a check has failed for three days running you get
  one alert naming the host and the error, and one more when it works again.
  Shorter outages stay quiet.
- **Untrusted certificates**: a certificate browsers would reject (self-signed,
  wrong hostname, broken chain) sends one alert per certificate.
- Removing every threshold for SSL or for registration turns off all alerts of
  that kind.
- **Delivery**: every alert is sent once, and what happened is recorded per
  channel (email, push). A channel that fails is tried again on the following
  hourly looks, five attempts in all, without repeating the channel that
  worked. For email, "sent" only means Resend accepted it, so the app asks
  Resend afterwards whether it was delivered or bounced (for up to three days)
  and records the answer. This needs a Resend API key with full access; a
  "sending access" key can send but not read the status back, so emails stay
  at `sent`. An alert that reached no one because nothing was set up (no API
  key, no devices subscribed) is sent if a channel appears within a week.

## API

All bodies are JSON (`Content-Type: application/json`). Errors are
`{ "error": "message" }` with a 4xx/5xx status. `403` means the `Host` or
`Origin` was refused; see
[Which addresses the app answers to](#which-addresses-the-app-answers-to).

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/api/health` | | `Health`, with `503` when the scheduler has stopped. See [Knowing the tracker is alive](#knowing-the-tracker-is-alive). |
| GET | `/api/domains` | | `{ domains: Domain[] }` |
| POST | `/api/domains` | `{ host }` | `201 { domain }` after the first check finishes (can take up to ~20s). `400` invalid, `409 { error, domain }` already tracked. |
| GET | `/api/domains/:id` | | `{ domain, history: Check[], alerts: Alert[] }` (latest 50 of each, newest first) |
| DELETE | `/api/domains/:id` | | `204` |
| POST | `/api/domains/:id/check` | | `{ domain }` after re-checking |
| POST | `/api/check` | | `{ domains }` after re-checking all |
| GET | `/api/settings` | | `Settings` |
| PUT | `/api/settings` | any subset of `settings` | `Settings` |
| GET | `/api/push/vapid-public-key` | | `{ publicKey }` |
| POST | `/api/push/subscribe` | `PushSubscription.toJSON()` | `201 { ok: true }` |
| POST | `/api/push/unsubscribe` | `{ endpoint }` | `{ ok: true, removed }` |
| POST | `/api/alerts/test` | | `{ email: { sent, id?, skipped?, error? }, push: { sent, failed, skipped?, error? } }` |

```jsonc
// Domain
{
  "id": 1,
  "host": "example.com",
  "createdAt": "2026-10-08T12:00:00.000Z",
  "status": "healthy",            // worst of the two: expired | failed | soon | pending | healthy | unsupported
  "ssl": {                        // null until first checked
    "status": "healthy",          // healthy | soon | expired | failed
    "ok": true,                   // did the latest check succeed
    "checkedAt": "2026-10-08T12:00:00.000Z",
    "error": null,                // reason when ok is false
    "expiresAt": "2026-12-25T00:00:00.000Z",
    "daysLeft": 77,               // whole days; negative once expired
    "stale": false,               // true: latest check failed, dates are from the last good one
    "validFrom": "2026-09-26T00:00:00.000Z",
    "issuer": "Let's Encrypt",
    "subject": "example.com",
    "trusted": true,              // false for self-signed, wrong host, expired
    "trustError": null,
    "fingerprint": "AB:CD:..."    // SHA-256 of the certificate
  },
  "registration": {               // null until first checked
    "status": "healthy",          // healthy | soon | expired | failed | unsupported
    "ok": true, "checkedAt": "...", "error": null,
    "expiresAt": "2027-08-13T04:00:00.000Z", "daysLeft": 307, "stale": false,
    "domain": "example.com",      // the registered domain that was looked up
    "registrar": "Namecheap, Inc.",
    "registeredAt": "1995-08-14T04:00:00.000Z",
    "statuses": ["client transfer prohibited"]
  }
}

// Check (history entry): same detail fields as above for its kind
{ "id": 7, "kind": "ssl", "checkedAt": "...", "ok": true, "expiresAt": "...", "error": null, "issuer": "..." }

// Alert
{
  "kind": "registration",         // ssl | registration
  "type": "expiry",               // expiry | reminder (weekly, while expired) | failing | recovered | untrusted
  "title": "Domain registration for example.com expires in 14 days",
  "threshold": 14,                // expiry and reminder only; 0 is the "has expired" alert
  "expiresAt": "...",             // null for failing and recovered
  "sentAt": "...",
  "channels": ["email", "push"],  // the channels that got through
  "deliveries": { "email": Delivery, "push": Delivery }
}

// Delivery: what happened to one alert on one channel
{
  "status": "delivered",          // see below
  "attempts": 1,                  // sends tried, 5 at most
  "error": null,                  // why it failed, bounced or was skipped
  "messageId": "49a3...",         // Resend's id for the email; null for push
  "updatedAt": "..."
}
// status: pending   being sent
//         sent      accepted by Resend / at least one device was reached
//         delivered Resend confirmed delivery (email only)
//         bounced   the address rejected it (email only; not retried)
//         complained marked as spam by the recipient (email only)
//         failed    not sent; retried hourly until attempts reaches 5
//         skipped   the channel was off or not set up

// Settings
{
  "settings": {
    "sslThresholds": [30, 14, 7, 1],           // days before expiry; 1-365; [] turns that kind off
    "registrationThresholds": [30, 14, 7, 1],
    "emailEnabled": true,
    "emailTo": "lachie@example.com",           // "" falls back to ALERT_EMAIL_TO
    "pushEnabled": true
  },
  "email": {
    "configured": true,                        // RESEND_API_KEY is set
    "from": "SSL Tracker <alerts@example.com>",
    "last": Delivery                           // the most recent email attempt; null before the first
  },
  "push": { "subscriptions": 1, "last": Delivery },
  "deliveryProblems": [                        // failed, bounced or complained in the last 30 days, newest first (max 20)
    { "domainId": 1, "host": "example.com", "kind": "ssl", "type": "expiry", "title": "...", "channel": "email", ...Delivery }
  ]
}
```

`soon` means within the largest threshold for that kind (30 days by default).

Push messages arrive in the service worker as JSON:
`{ "title", "body", "tag", "url" }`.

## Tests

```sh
npm test
```
