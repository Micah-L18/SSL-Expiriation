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

Data lives in `app/data/` (`tracker.db` and `vapid.json`). Back that folder up;
deleting `vapid.json` invalidates every push subscription.

### Configuration (`.env`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Address to listen on. `0.0.0.0` exposes it to your network. |
| `PORT` | `3000` | Port to listen on. |
| `RESEND_API_KEY` | none | API key from [Resend](https://resend.com). Email alerts are off without it. |
| `ALERT_EMAIL_TO` | none | Where alerts go. Can be overridden in the app's alert settings. |
| `ALERT_EMAIL_FROM` | `SSL Tracker <onboarding@resend.dev>` | Sender. Use an address on a domain verified in Resend; the default only delivers to your own Resend login email. |
| `PUBLIC_URL` | none | The address you open the app at; used as the link in alerts. |
| `VAPID_SUBJECT` | `mailto:ALERT_EMAIL_TO` | Contact address given to browser push services. |
| `DATA_DIR` | `data` | Where the database and push keys are stored. |
| `CHECK_INTERVAL_HOURS` | `24` | How often each domain is re-checked. |

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
  `CHECK_INTERVAL_HOURS`. The app looks hourly for domains that are due, so a
  restart or a sleeping machine does not skip a day.
- **Alerts**: one alert per threshold crossed, per expiry date. With thresholds
  30/14/7/1 you get at most four reminders plus one "has expired" notice. A
  domain added with 5 days left gets only the 7-day alert. Renewing (a new
  expiry date) starts a fresh cycle. If an alert reaches no one (email not
  configured, no devices subscribed) it is retried at the next check.

## API

All bodies are JSON (`Content-Type: application/json`). Errors are
`{ "error": "message" }` with a 4xx/5xx status.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
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
| POST | `/api/alerts/test` | | `{ email: { sent, skipped?, error? }, push: { sent, failed, skipped? } }` |
| GET | `/api/health` | | `{ ok: true }` |

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
    "trustError": null
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
{ "kind": "registration", "threshold": 14, "expiresAt": "...", "sentAt": "...", "channels": ["email", "push"] }
// threshold 0 is the "has expired" alert

// Settings
{
  "settings": {
    "sslThresholds": [30, 14, 7, 1],           // days before expiry; 1-365; [] turns that kind off
    "registrationThresholds": [30, 14, 7, 1],
    "emailEnabled": true,
    "emailTo": "lachie@example.com",           // "" falls back to ALERT_EMAIL_TO
    "pushEnabled": true
  },
  "email": { "configured": true, "from": "SSL Tracker <alerts@example.com>" },  // configured: RESEND_API_KEY is set
  "push": { "subscriptions": 1 }
}
```

`soon` means within the largest threshold for that kind (30 days by default).

Push messages arrive in the service worker as JSON:
`{ "title", "body", "tag", "url" }`.

## Tests

```sh
npm test
```
