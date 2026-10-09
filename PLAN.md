# Certwatch / SSL Tracker: stack review and next-work roadmap

Author: Moose (Head of Engineering). Date: 2026-10-09. Based on a read of `app/server.js`, `app/lib/*.js`, `app/public/sw.js`, `app/README.md` and `.env.example` at commit 74b09a4. Nothing was run; findings are from reading the code.

## Verdict

The stack is right. Keep it. The gaps are not in the technology, they are in what happens when something goes wrong quietly: a check that keeps failing, an email that never lands, or the tracker itself stopping. For a set-and-forget tool those are the only failures that matter, so they are the top of the work list.

## 1. Stack

**Keep:** Node + built-in `node:sqlite` + one dependency (`web-push`) + plain HTML/CSS/JS PWA. No build step, tiny attack surface, nothing to keep patched except Node itself. All database access sits in `app/lib/db.js`, and checkers/notifier are injected into the monitor, so parts can be swapped without a rewrite.

**Change:**

| What | Why |
| --- | --- |
| Pin the Node major (Docker image tag + `engines` in `package.json`) | `node:sqlite` is still a young API. Pinning stops a Node upgrade from breaking the app silently. If it ever becomes a problem, swapping to `better-sqlite3` is a one-file change in `db.js`. |
| Add schema versioning (`PRAGMA user_version`) | Schema is `CREATE TABLE IF NOT EXISTS` only. The first column change would have no upgrade path. |
| Add CI (GitHub Actions running `npm test`) | 36 tests exist but nothing runs them on a push. |
| Create a `staging` branch | Company policy: merge feature branches into staging for full testing, never push to main. Only `main` and `feat/ssl-tracker` exist. |

**Growth, more domains:** fine into the low thousands on SQLite. The real limits are (a) RDAP rate limits, see section 3, and (b) `POST /api/check` holding one HTTP request open while every domain is checked, which will time out somewhere past roughly 100 domains. Neither needs fixing for Lachie today; (a) is on the list, (b) is parked.

**Growth, more users:** do not build it now. The path when needed is: a users table, an owner column on domains/settings/subscriptions, built-in login. SQLite still copes for a small team; Postgres only becomes relevant if this turns into a hosted service. Building multi-user now would roughly double the code for a user who does not exist.

**Upcoming industry change to design for:** certificate lifetimes are being shortened across the industry (towards 47 days by 2029) and short-lived auto-renewed certs are already common. A fixed 30-day SSL threshold will start firing on certs that are about to auto-renew normally. Item B8 makes thresholds lifetime-aware.

## 2. Security

**Recommendation: private network with Tailscale, plus `tailscale serve` for HTTPS.** One tool solves both problems: only Lachie's devices can reach the app, and it gets a real HTTPS certificate (required for push and install) that renews itself. Push notifications still arrive when the VPN is off, because they are delivered by Apple/Google, not by the tracker; the VPN is only needed to open the app.

| Option | Pros | Cons |
| --- | --- | --- |
| **Tailscale (recommended)** | Nothing exposed to the internet. HTTPS included. No password to manage. Free for personal use. No code to write. | Lachie installs Tailscale on phone and server. App only opens with Tailscale on. |
| Reverse proxy (Caddy) + basic auth on a public address | Opens from any browser. Standard setup. | Publicly reachable, so it gets scanned and brute-forced. Needs a public domain and open ports. Browser basic-auth prompts work poorly with installed PWAs and service workers on phones. |
| Built-in login | Best experience, needed anyway for multi-user. | Most code and most risk: sessions, password hashing, rate limiting, reset flow. All for one user. |

**Code-level findings to fix regardless of the option chosen (item B4):**

- No `Host` header check. A malicious web page can use DNS rebinding to reach `127.0.0.1:3000` from Lachie's browser and read or change everything. Fix: allowlist of hosts (loopback, the `PUBLIC_URL` host, optional extras).
- `POST /api/check`, `POST /api/domains/:id/check` and `POST /api/alerts/test` take no body, so the JSON content-type guard in `readJson` never runs for them. Any website can trigger them with a plain form post. Fix: reject state-changing requests whose `Origin` does not match.
- No security headers (Content-Security-Policy, frame-ancestors, referrer-policy).
- `HOST=0.0.0.0` exposes an unauthenticated app with no warning. Log a loud warning at startup.
- Public repo: confirm `app/data/` (database and VAPID private key) and `.env` were never committed in history. They are git-ignored now; the history has not been checked.

## 3. Reliability

**Silent failures found in the code (highest priority):**

1. `alertIfDue` returns immediately when a check fails. If a site becomes unreachable or RDAP keeps failing, Lachie hears nothing, ever. The UI shows stale dates but nobody is looking; that is the point of the tool.
2. An untrusted certificate (wrong hostname, self-signed, broken chain) is recorded as `trusted: false` but never alerts.
3. A failed check counts as checked, so it is not retried for 24 hours. One network blip costs a day.
4. An alert is marked done if ANY channel delivered. If push works and email fails, email is never retried.
5. `sent: true` for email only means Resend accepted the request, not that it was delivered. A bounce is invisible.
6. The expired alert fires once. If nobody acts, nothing more is said.

**Proving email and push really work:**

- Store the Resend message id and ask Resend for its status on the next tick; record delivered or bounced, and surface a bounce in the app.
- Verify a sending domain in Resend. The default sender `onboarding@resend.dev` only delivers to the Resend account owner's own inbox (Owner decision D3).
- Ship a smoke script (`npm run smoke`) that adds a host with a known-expired certificate so a REAL alert travels the whole path, then removes it. Acceptance is a human confirming the email and the phone notification arrived, on iPhone and Android.
- iOS only allows web push after the app is added to the Home Screen. The UI must say so (item F1).

**Scheduler failure handling:** the hourly tick already catches errors and overlapping runs are de-duplicated, which is good. Add: quick retry of failed checks (next hourly tick, up to 3 times, then back to daily), and exit non-zero on an unhandled error so Docker/systemd restarts the process instead of leaving it half-alive.

**Dead-man's switch:** after every completed tick, ping an external heartbeat URL (`HEARTBEAT_URL`, e.g. a free healthchecks.io check). If the pings stop because the machine is off, the process crashed or the network is down, that outside service emails Lachie. It must be external: a dead tracker cannot report its own death. Also make `GET /api/health` honest (it returns `ok: true` unconditionally today): last tick time, last tick result, and HTTP 503 if no tick has completed in 3 hours.

**RDAP rate limits and fallback:** every lookup goes through the rdap.org redirector, four at a time, and subdomains can take several requests each. Changes: look the registry up directly using the IANA RDAP bootstrap list (cached in the data folder, refreshed weekly) with rdap.org as fallback; run registration lookups one at a time with a short gap; honour `Retry-After` on HTTP 429; check registration weekly instead of daily while more than 60 days remain (registration dates barely change); for registries with no RDAP expiry (e.g. `.de`), let Lachie type the expiry date in by hand rather than adding a fragile WHOIS parser.

**SQLite backups:** the database runs in WAL mode, so copying the file while the app runs can produce a broken copy. Add a nightly `VACUUM INTO` snapshot to `DATA_DIR/backups/` (keep 7) plus a copy of `vapid.json`, and take one before every schema migration. Document restore. Also prune check history older than 400 days; the `checks` table grows forever today.

## 4. Run and operate

- **Deployment: Docker Compose is the primary path**, systemd stays documented as the alternative. Docker pins the Node version (the one real fragility of this stack), restarts on crash, and gives a health check for free. Compose file: one service, a named volume for `data/`, port published on `127.0.0.1` only, `restart: unless-stopped`, non-root user, `HEALTHCHECK` against `/api/health`.
- **The host must be always on.** The hourly catch-up logic survives sleep and restarts, but nothing is checked while the machine is asleep. A laptop is the wrong home for this (Owner decision D2).
- **HTTPS for push:** `tailscale serve` in front of `127.0.0.1:3000`. Set `PUBLIC_URL` to the resulting `https://<machine>.<tailnet>.ts.net` address so alert links work.
- **Upgrade path:** `git pull`, then `docker compose up -d --build`. On start the app backs up the database, runs any pending migrations, then serves. Roll back by checking out the previous tag and restoring the pre-migration backup. Tag releases (`v1.0.0`) on main so there is something to roll back to.
- **Running cost:** expected to be zero on the free tiers of Resend, Tailscale and healthchecks.io at this scale, plus the electricity of an always-on box.

## 5. Prioritised work list

Branching: Corin works on `feat/reliability`, Nerys on `feat/pwa-readiness`, both cut from `feat/ssl-tracker`. Corin owns `app/lib/**`, `app/server.js`, `app/test/**`, `app/README.md`, Docker and CI files. Nerys owns `app/public/**` only. No shared files, so they run in parallel. Both merge into a new `staging` branch for the full test; main is only updated with Owner approval.

Effort: S = under half a day, M = about a day. Every backend item must keep `npm test` green and add tests for its new behaviour.

### P0: makes it trustworthy (do first)

| ID | Item | Owner | Effort | Depends on | Acceptance criteria |
| --- | --- | --- | --- | --- | --- |
| B1 | Alert on silent failures | Corin | M | none | A check that has failed for 3 days running sends one alert naming the host and the error, and one recovery alert when it works again. An untrusted certificate sends one alert per certificate. Failed checks are retried on the next hourly tick, up to 3 times, then daily. A still-expired item re-alerts weekly. Tests cover each rule and prove no duplicates. |
| B2 | Per-channel delivery tracking | Corin | M | none | Each alert records the outcome per channel. A channel that failed is retried on later ticks (max 5 attempts) even if the other channel succeeded. The Resend message id is stored and its status fetched on a later tick; a bounce is recorded and exposed in `GET /api/settings` and in the domain alert list. Tests with a fake fetch cover accepted, bounced and Resend-down. |
| B3 | Heartbeat and honest health | Corin | S | none | With `HEARTBEAT_URL` set, each completed tick sends one GET to it; unset means no request. `GET /api/health` returns last tick time, last tick result, domain count and backup time, and HTTP 503 when no tick completed in 3 hours. An unhandled error exits the process non-zero. Documented in README and `.env.example`. |
| B4 | Request hardening | Corin | S | none | Requests with a `Host` outside the allowlist get 403. State-changing requests with a foreign `Origin` get 403, including the three body-less POST routes. Responses carry a Content-Security-Policy, `frame-ancestors 'none'` and a referrer policy, and the existing UI still works under that policy. Startup logs a warning when `HOST` is not loopback. Report whether `app/data/` or `.env` ever appear in git history. |
| B5 | Backups, migrations, pruning | Corin | S | none | Nightly snapshot into `DATA_DIR/backups/`, 7 kept, `vapid.json` copied alongside. `PRAGMA user_version` migration runner; a backup is taken before any migration. Checks older than 400 days are pruned but the latest good check per domain and kind is always kept. Restore steps in README. A test restores a snapshot and reads domains from it. |
| O1 | Docker, CI, staging branch | Corin | S | B3 | `Dockerfile` (pinned Node 24 image, non-root, health check) and `compose.yml` (data volume, port on 127.0.0.1, restart policy). `engines` set in `package.json`. GitHub Actions workflow runs `npm test` on Node 22 and 24 for every pull request. `staging` branch created from `feat/ssl-tracker`. README has a Docker quick start and a Tailscale section (`tailscale serve`, `PUBLIC_URL`). |
| F1 | PWA install and push readiness | Nerys | S | none | PNG icons at 192 and 512 (including a maskable one) and an apple-touch-icon are in place and referenced; the manifest passes a Lighthouse installability check. The push enable flow detects iOS outside an installed app and tells the user to add it to the Home Screen first. Blocked or unsupported notification states show a clear message, not a dead button. Service worker cache name bumped. Checked at 375px width. |

### P1: proves it and makes it resilient

| ID | Item | Owner | Effort | Depends on | Acceptance criteria |
| --- | --- | --- | --- | --- | --- |
| B6 | RDAP resilience and manual expiry | Corin | M | B5 (needs migrations) | Registry found from a cached IANA bootstrap list with rdap.org as fallback. Registration lookups run one at a time and honour `Retry-After`. Registration is checked weekly while more than 60 days remain. New endpoint to set or clear a manual registration expiry for a domain; manual dates alert exactly like looked-up ones and are labelled as manual in the API. Tests cover bootstrap hit, fallback, 429 back-off and manual dates. |
| Q1 | Real delivery proof | Corin, then Lachie/Owner on real phones | S | B1, B2, O1, decisions D1 and D3 | `npm run smoke` adds a host with a known-expired certificate against a running instance, waits for the alert, prints per-channel results and removes the host. A short checklist in README: email received at the real address from the verified sender, push received on an iPhone (installed to Home Screen) and an Android phone with the app closed, tapping the notification opens the app. Result recorded in the report. |
| F2 | Tracker health and delivery status in the UI | Nerys (Vaydah reviews the design first) | M | B1, B2, B3, B6 | Settings shows a health panel: last check run, heartbeat on or off, sender verified or not, last backup, any bounced or failed deliveries. Domain detail shows failing-check and untrusted-certificate states and their alerts. Unsupported registries offer a field to enter the expiry date by hand. The test-alert button shows the result per channel. All from live API data, no placeholders. |

### P2: later, only when needed

| ID | Item | Owner | Effort | Trigger |
| --- | --- | --- | --- | --- |
| B8 | Lifetime-aware SSL thresholds (ignore thresholds longer than a third of the certificate's lifetime) | Corin | S | Before short-lived certs make the 30-day alert noisy; cheap enough to do after P1. |
| B9 | One product name everywhere (frontend and branding say Certwatch, backend emails and logs say SSL Tracker) | Corin + Nerys | S | Before Lachie receives his first real alert, ideally with Q1. |
| B7 | Make check-all run in the background with progress | Corin + Nerys | M | Only when the list passes roughly 100 domains. |
| M1 | Multi-user and built-in login | Corin + Nerys | L | Only if the Owner decides more people will use it (decision D5). |

**Suggested order to delegate:** start B1 to B5 (Corin, in that order, one branch) and F1 (Nerys) immediately and in parallel. Then O1, then B6 and Q1, then F2. The Owner decisions below block only Q1 and the Tailscale part of O1.

## 6. Decisions for the Owner

**D1. How does Lachie reach the app safely?**
Like I'm 5: the app has no lock on its door, so we either hide the house or add a lock.
- **Tailscale private network (recommended).** Pros: invisible to the internet, HTTPS for push included, free, no code. Cons: Lachie needs the Tailscale app on his phone to open the tracker (alerts still arrive without it).
- Public address with a password at the proxy. Pros: opens anywhere. Cons: exposed to the internet, needs a public domain, password prompts are clumsy in an installed phone app.
- Built-in login. Pros: nicest experience, needed for multi-user. Cons: the most work and the most security risk for one user.

**D2. Which machine runs it?**
Like I'm 5: the watchdog can only watch while its computer is awake.
- **An always-on box Lachie already has: home server, NAS, mini PC or Raspberry Pi (recommended).** Pros: free, private. Cons: he has to keep it powered and online.
- A small cloud server. Pros: always on, not tied to his home internet. Cons: a few dollars a month, one more thing to own.
- His everyday laptop or desktop. Pros: nothing to buy. Cons: no checks while it sleeps; alerts can arrive days late. Not recommended.
Also needed: can that machine run Docker? If not we use the systemd route.

**D3. What address do alert emails come from?**
Like I'm 5: letters need a return address on a street you own, or the post office only delivers to you.
- **Verify a domain Lachie owns in Resend (recommended).** Pros: delivers to any inbox, far less likely to land in spam. Cons: a one-off job of adding a few DNS records.
- Keep Resend's default test sender. Pros: zero setup. Cons: only delivers to the email address of the Resend account itself, and can stop working.
We need: the domain name and who can add the DNS records.

**D4. Who tells Lachie if the tracker itself dies?**
Like I'm 5: if the watchdog falls asleep, someone else has to bark.
- **An outside heartbeat service such as healthchecks.io, free tier (recommended).** Pros: catches a dead machine, crashed app or lost internet. Cons: one small extra account.
- A monthly all-is-well email from the tracker. Pros: no extra account, also proves email works. Cons: Lachie has to notice an email that did NOT come; slow.
- Both. Pros: belt and braces. Cons: one more email a month.
- Nothing. Not recommended: the tool can fail silently, which defeats its purpose.

**D5. Build for more users now or later?**
Like I'm 5: do we build one bedroom or a hotel?
- **Later (recommended).** Pros: ships sooner, stays simple and safe; the code is laid out so it can be added. Cons: a few days of rework when the day comes.
- Now. Pros: ready for a team. Cons: roughly doubles the work and adds login security risk for users who do not exist yet.

## Risks and open questions

- Nothing here was executed. Before starting, Corin should confirm the 36 tests pass on the pinned Node version.
- Whether `app/data/tracker.db` or `vapid.json` ever reached the public repo's history is unverified (part of B4). If they did, the VAPID key must be regenerated and the history cleaned, with Owner approval.
- RDAP and Resend limits vary by provider and plan; B6 and B2 are written to back off rather than assume a number.
- The repo name `SSL-Expiriation` contains a typo. Renaming is optional and the Owner's call; it does not affect the app.
