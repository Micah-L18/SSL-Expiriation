# SSL Tracker

A private, self-hosted tracker for SSL certificate expiry and domain registration
expiry. It checks every domain daily and sends an email and/or a push
notification as each expiry gets close.

Single user, one password. Run it on your own machine or server.

## Setup

There are two ways to run it.

### On a server, with Docker

This is the recommended way: open to the internet over HTTPS, behind a login.
`compose.yml` runs the app together with [Caddy](https://caddyserver.com),
which gets and renews the certificate. **[DEPLOY.md](DEPLOY.md) has every
step**: firewall, DNS, the password, first run, updating, backups and outside
monitoring. In short, on a server whose DNS name already points at it:

```sh
cd app
cp .env.example .env          # set DOMAIN and the email settings
docker compose build
docker compose run --rm --no-deps tracker node scripts/hash-password.js
# paste the AUTH_PASSWORD_HASH line it prints into .env, then:
docker compose up -d
```

Needs Docker with Compose 2.24 or newer, and ports 80 and 443 open.

- The app's own port is not published; only Caddy can reach it.
- `HOST`, `PORT`, `DATA_DIR`, `PUBLIC_URL` and `TRUST_PROXY` in `.env` are
  ignored under Docker; `compose.yml` sets them.
- `docker compose ps` shows `healthy` while the scheduler is running (it asks
  `/api/health` every minute).
- Data lives in the `data` volume (`/data` in the container), which survives
  rebuilds and `docker compose down`. `docker compose down -v` deletes it.
- The containers restart by themselves after a crash or a reboot.

### Without Docker

Needs Node.js 22.13 or newer in the 22 line, or Node.js 24 (it uses Node's
built-in SQLite; other versions are not tested).

```sh
cd app
npm install
cp .env.example .env    # then fill in the email settings
npm start
```

Open http://127.0.0.1:3000.

Data lives in `app/data/` (`tracker.db` and `vapid.json`). See
[Backups and restore](#backups-and-restore). To keep it running, see
[Start on boot](#start-on-boot).

### Configuration (`.env`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Address to listen on. Anything but a loopback address needs `AUTH_PASSWORD_HASH`; the app refuses to start without it. |
| `AUTH_PASSWORD_HASH` | none | The login password, hashed. See [Login](#login). Without it the login is off. |
| `TRUST_PROXY` | off | Set to `1` only when a reverse proxy sits in front, so failed logins are counted per visitor and not all against the proxy. |
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

### HTTPS with Tailscale

For running the app without Docker on a machine at home or in the office.

Browsers only allow push notifications and app install on HTTPS (or on
`localhost`). [Tailscale](https://tailscale.com) gives the app a real
certificate that renews itself, and only your own devices can reach it. It is free for personal use.

1. Install Tailscale on the machine running the tracker and on your phone, and
   sign both in to the same account.
2. In the Tailscale admin console, under DNS, turn on MagicDNS and HTTPS
   certificates.
3. On the tracker machine, with the app running on `127.0.0.1:3000`:

   ```sh
   tailscale serve --bg 3000
   ```

   It prints the address, like `https://machine.your-tailnet.ts.net`.
   `tailscale serve status` shows it again, and it survives reboots.
4. Put that address in `.env` and restart the app:

   ```
   PUBLIC_URL=https://machine.your-tailnet.ts.net
   ```

   The links in alerts then point at it, and the app accepts requests for it.
   Without this step the app answers `403` at that address.
5. Open the address on your phone with Tailscale switched on, add the app to
   the Home Screen and enable push in the alert settings.

Keep `HOST=127.0.0.1`: Tailscale reaches the app
through the loopback address. Alerts still arrive when Tailscale is switched
off, because they are delivered by email and by Apple's and Google's push
services; Tailscale is only needed to open the app. Do not use
`tailscale funnel`: that publishes the app to the whole internet.

#### Another reverse proxy

Any proxy with a certificate works the same way: keep `HOST=127.0.0.1`, set
`PUBLIC_URL` to the HTTPS address. With [Caddy](https://caddyserver.com):

```
tracker.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Set `AUTH_PASSWORD_HASH` (see [Login](#login)) and `TRUST_PROXY=1`. With
`HOST=127.0.0.1` the app starts without a password, and the proxy would then
hand the open app to everyone who can reach it.

### Login

One password protects everything. It is never stored: `.env` holds a scrypt
hash of it.

```sh
node scripts/hash-password.js      # asks twice, shows nothing as you type
```

Copy the `AUTH_PASSWORD_HASH=...` line it prints into `.env` and restart. Use
a long password (the script refuses fewer than 12 characters); a few random
words from a password manager is ideal. To change the password, do the same
again: every device is signed out and has to sign in with the new one. A
forgotten password is fixed the same way, by whoever can edit `.env`.

- **No password set.** The login is off and the app says so at startup. That
  is only allowed while `HOST` is a loopback address; with any other `HOST` the
  app refuses to start.
- **Sessions.** Signing in sets a cookie that lasts 30 days, then the password
  is asked for again. The cookie is `HttpOnly` and `SameSite=Strict`, and
  `Secure` when `PUBLIC_URL` starts with `https://`. The database keeps only a
  hash of each session token, so a backup cannot be used to sign in.
- **Wrong passwords.** An address gets five tries. After the fifth it has to
  wait 30 seconds, and the wait doubles with every further try up to 15
  minutes. During a wait even the right password is refused. A successful
  sign-in, or an hour without tries, clears the count. IPv6 addresses are
  counted by their /64 network.
- **What works without signing in.** The page itself (HTML, CSS, scripts),
  `/api/session`, `/api/login`, and `/api/health`, which then says only whether
  the tracker is up. Everything else answers `401`.

### Which addresses the app answers to

The app refuses the requests that would let another website reach it through
the browser of someone who is signed in.

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

These checks stand beside the login, not in place of it.

### Knowing the tracker is alive

A tracker that has stopped cannot tell you so. Two things cover that.
[DEPLOY.md](DEPLOY.md#8-uptimerobot-knowing-the-tracker-itself-is-alive) sets
both up with UptimeRobot.

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
the first run finishes). Without a session it says only that much,
`{ "ok": true }` or `{ "ok": false }`, which is all an uptime monitor needs.
Signed in, it gives the detail:

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

Under Docker the files are in the `data` volume and the commands differ; see
[DEPLOY.md](DEPLOY.md#10-backups-and-restoring).

### Upgrading

```sh
git pull
docker compose up -d --build     # or: npm install && restart npm start
```

The database carries a schema version. When a new version of the app starts
on an older database it first writes a snapshot named
`data/backups/tracker-<timestamp>-schema-v<N>.db` (the database exactly as the
old version left it), then upgrades it. To go back, check out the previous
version of the app and restore that snapshot as above; an older app cannot
read a database that a newer one has upgraded.

Check history older than 400 days is deleted daily. The latest successful
check of each domain is always kept, however old.

### Start on boot

Under Docker there is nothing to do beyond making Docker start on boot. Without
Docker:

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

Every route needs the session cookie except `/api/session`, `/api/login` and
`/api/health`. Without one the answer is `401 { "error": "Sign in to continue" }`,
whatever the path or method. A page that gets a `401` should show the login
screen. See [Login](#login) for the rules behind this.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/api/session` | | `{ authenticated, loginRequired }`. Always `200`. `loginRequired` is `false` when no password is set; `authenticated` is then always `true`. |
| POST | `/api/login` | `{ password }` | `200 { authenticated: true }` and the session cookie. `401 { error: "Incorrect password" }`. `429 { error, retryAfter }` (seconds, also in the `Retry-After` header) while this address has to wait. `400` when `password` is missing or no password is set on the server. |
| POST | `/api/logout` | | `204`, ends this session and clears the cookie. `401` when not signed in. |

The cookie is `tracker_session` (`__Host-tracker_session` over HTTPS):
`Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`, plus `Secure` when
`PUBLIC_URL` is `https://`. Scripts cannot read it; the browser sends it by
itself on same-origin requests.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET, HEAD | `/api/health` | | `{ ok }` without a session, `Health` with one; `503` when the scheduler has stopped. See [Knowing the tracker is alive](#knowing-the-tracker-is-alive). |
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

GitHub Actions runs the same on Node 22 and 24 for every pull request
(`.github/workflows/test.yml`).
