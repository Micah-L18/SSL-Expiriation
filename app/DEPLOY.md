# Putting the tracker on a server

This sets the tracker up on a small cloud server, open to the internet over
HTTPS and protected by one password. It takes about half an hour.

What you end up with:

- The tracker at `https://tracker.example.com` (your own name), with a
  certificate that [Caddy](https://caddyserver.com) gets from Let's Encrypt
  and renews by itself.
- A login screen. Nothing but the page itself and an up/down answer is
  readable without the password.
- Daily snapshots of the database on the server.
- UptimeRobot emailing you if the tracker itself stops.

Throughout, replace `tracker.example.com` with your own name.

## 1. What you need

- **A server.** The smallest plan of any provider is enough (1 vCPU, 1 GB of
  memory, a few dollars a month). Choose Ubuntu 24.04 LTS, and add your SSH
  key when creating it.
- **A domain name** you can add a DNS record to.
- **A [Resend](https://resend.com) account** for alert emails; the free tier
  is enough. Read [the note on who the emails can reach](#7-email-alerts-and-the-resend-test-sender)
  before creating it.
- **An [UptimeRobot](https://uptimerobot.com) account**; the free tier is
  enough.

## 2. DNS

Add an `A` record for the name, pointing at the server's IPv4 address:

| Type | Name | Value |
| --- | --- | --- |
| A | `tracker` | `203.0.113.10` (your server's address) |

Add an `AAAA` record only if the server has an IPv6 address and you put that
address in it. A wrong `AAAA` record makes the certificate fail.

Check that it has taken effect before going on (it can take a few minutes):

```sh
dig +short tracker.example.com      # should print the server's address
```

## 3. Firewall

Only three ports should be open: 22 for SSH (so you can manage the server),
and 80 and 443 for the tracker. Port 80 is needed: Let's Encrypt uses it to
check that the name is yours, and it redirects visitors to HTTPS.

Set this in **your provider's firewall** (called Firewall, Security Group or
Network Security depending on the provider), applied to the server:

| Port | Protocol | From |
| --- | --- | --- |
| 22 | TCP | anywhere (or just your own IP address, if it is fixed) |
| 80 | TCP | anywhere |
| 443 | TCP | anywhere |
| 443 | UDP | anywhere (optional: HTTP/3) |

Then the same on the server itself:

```sh
ssh root@tracker.example.com
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw enable
ufw status
```

Use both. Docker opens the ports it publishes without asking `ufw`, so `ufw`
alone is not a reliable outer wall on a Docker server; the provider's firewall
is. This setup publishes only 80 and 443, and the tracker's own port 3000 is
not published at all, so the two agree.

## 4. Install Docker

On the server:

```sh
curl -fsSL https://get.docker.com | sh
docker compose version      # needs 2.24 or newer
```

Docker starts on boot by itself, and with it the tracker.

Turn on automatic security updates for the system too, if your provider's
image does not have them on already:

```sh
apt-get install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades
```

## 5. Get the app and configure it

```sh
git clone https://github.com/Micah-L18/SSL-Expiriation.git /opt/ssl-tracker
cd /opt/ssl-tracker/app
cp .env.example .env
chmod 600 .env
nano .env
```

Fill in these lines:

```
DOMAIN=tracker.example.com
RESEND_API_KEY=re_...
ALERT_EMAIL_TO=you@example.com
```

Leave the rest as it is. Under Docker, `HOST`, `PORT`, `DATA_DIR`,
`PUBLIC_URL` and `TRUST_PROXY` in `.env` are ignored: `compose.yml` sets them,
and takes `PUBLIC_URL` from `DOMAIN`.

Now the password. Build the app and let it hash the password you choose:

```sh
docker compose build
docker compose run --rm --no-deps tracker node scripts/hash-password.js
```

It asks for the password twice and shows nothing as you type. Use a long one,
at least 12 characters; a few random words from a password manager is ideal.
This password is all that stands between the internet and the tracker. It
prints one line:

```
AUTH_PASSWORD_HASH=scrypt:32768:8:1:...
```

Paste that whole line into `.env`, replacing the empty `AUTH_PASSWORD_HASH=`
line. The password itself is stored nowhere; keep it in your password manager.

## 6. First run

```sh
docker compose up -d
docker compose ps
```

Both `tracker` and `caddy` should be `Up`, and `tracker` turns `(healthy)`
within a minute. Caddy fetches the certificate on first start, which takes a
few seconds. Then:

```sh
curl -i https://tracker.example.com/api/health
```

should answer `HTTP/2 200` and `{"ok":true}`.

Open `https://tracker.example.com`, sign in, and then:

1. Add a domain and see its dates appear.
2. In alert settings, send a test alert and check that the email arrives.
3. On your phone, open the address, add it to the Home Screen, and turn on
   push notifications in alert settings. Send another test alert.

If something is off:

| What you see | Cause |
| --- | --- |
| `docker compose` says `Set DOMAIN in .env` | `DOMAIN` is empty in `.env`. |
| `tracker` keeps restarting; `docker compose logs tracker` says `Not starting` | `AUTH_PASSWORD_HASH` is missing or was not pasted whole. |
| The browser warns about the certificate, or cannot connect | The DNS record does not point at this server yet, or port 80 or 443 is closed. `docker compose logs caddy` says which. Fix it and Caddy tries again by itself. |
| "This address is not allowed to reach the tracker" | The app was opened at another name or at the IP address. Use `https://` and the name in `DOMAIN`. |
| "Too many attempts" when signing in | Five wrong passwords from your address. Wait as long as it says (30 seconds at first, up to 15 minutes). |

## 7. Email alerts and the Resend test sender

Alerts are sent from Resend's built-in test address,
`onboarding@resend.dev`. It needs no setup, but it has one hard limit:

**It only delivers to the email address the Resend account was created
with.** Nobody else can receive alerts through it.

So:

- Create the Resend account with the email address the alerts should go to
  (Lachie's), and set `ALERT_EMAIL_TO` to that same address.
- Create the API key with **full access**. A "sending access" key can send,
  but the tracker cannot then check whether an email was delivered or bounced.
- Do not change the alert address in the app's settings to anything else:
  Resend refuses those emails. The tracker shows that under delivery problems
  in alert settings, and keeps sending push notifications, but no email
  arrives.

To send to any other address, or to more than one, verify a domain you own in
Resend (Domains, Add domain, then add the DNS records it lists) and set the
sender in `.env` to an address on it:

```
ALERT_EMAIL_FROM=SSL Tracker <alerts@example.com>
```

Then `docker compose up -d` to apply it.

## 8. UptimeRobot: knowing the tracker itself is alive

A tracker that has stopped cannot warn you about anything, including that it
has stopped. UptimeRobot watches it from outside and emails you through its
own system, so this works even when the server or Resend is down.

### The HTTP monitor (do this one)

In UptimeRobot, choose New monitor:

- **Monitor type:** HTTP / website
- **URL:** `https://tracker.example.com/api/health`
- **Interval:** 5 minutes
- **Alert contact:** your email, and the app's push notifications if you use it

`/api/health` answers `200` while the tracker is working and `503` once its
scheduler has gone 3 hours without completing a run. Anything that is not a
`2xx` counts as down for UptimeRobot, so this one monitor catches the server
being off, the app having crashed, the certificate being broken and the
scheduler having stalled. Without a login the address reveals nothing but
`{"ok":true}`; it does not need the password.

To see the alert work once, run `docker compose stop tracker` on the server,
wait for UptimeRobot's email, then `docker compose start tracker`.

### The heartbeat monitor (optional)

This works the other way round: the tracker calls UptimeRobot once an hour,
after every completed scheduler run, and UptimeRobot alerts when the calls
stop. It adds little on top of the HTTP monitor; use it if you want a second
opinion. Heartbeat monitors are not on every UptimeRobot plan, so check yours;
[healthchecks.io](https://healthchecks.io) offers the same on its free tier.

- **Monitor type:** Heartbeat
- **Interval:** 1 hour, with 2 hours of grace before it alerts

Copy the URL it gives you into `.env`:

```
HEARTBEAT_URL=https://heartbeat.uptimerobot.com/...
```

and apply it with `docker compose up -d`. The first call arrives within the
hour. Signed in, `https://tracker.example.com/api/health` shows the time of
the last call and the reason if one failed.

## 9. Updating

```sh
cd /opt/ssl-tracker
git pull
cd app
docker compose pull caddy
docker compose up -d --build
```

The tracker is away for a few seconds. Data, the password and the certificate
are kept. Before a new version changes the database it writes a snapshot of it
as it was (`tracker-<timestamp>-schema-v<N>.db` in the backups), so a bad
update can be undone: check out the previous version with `git`, restore that
snapshot as in the next section, and start again.

Changing the password is the same as setting it: run `hash-password.js` again
(section 5), replace the line in `.env`, `docker compose up -d`. Every device
is signed out and has to sign in with the new password.

## 10. Backups and restoring

Once a day the tracker writes a snapshot of its database to
`/data/backups/tracker-YYYY-MM-DD.db` inside its volume and keeps the newest
seven, plus a copy of `vapid.json`, the keys for push notifications.

Those snapshots are on the same disk as the data. They save you from a bad
update or a damaged database, not from losing the server. Copy them off the
server now and then. From your own computer:

```sh
ssh root@tracker.example.com 'cd /opt/ssl-tracker/app && rm -rf /root/backups && docker compose cp tracker:/data/backups /root/backups'
scp -r root@tracker.example.com:/root/backups ./tracker-backups
```

Also keep a copy of `.env`; it holds the password hash and the Resend key.

### Restore a snapshot on the same server

```sh
cd /opt/ssl-tracker/app
docker compose exec tracker ls /data/backups        # pick a snapshot
docker compose stop tracker
docker compose run --rm --no-deps tracker sh -c 'rm -f /data/tracker.db-wal /data/tracker.db-shm && cp /data/backups/tracker-YYYY-MM-DD.db /data/tracker.db'
docker compose up -d
```

Domains, check history, settings, alert history and push subscriptions are
back as they were at the snapshot. Checks that are due run within the hour,
and alerts sent before the snapshot are not sent again. Devices that signed in
after the snapshot was taken have to sign in again.

### Move to a new server

Do sections 2 to 5 on the new server, using your saved `.env`. Then, before
the first `docker compose up -d`, put your saved backups in:

```sh
scp -r ./tracker-backups root@NEW-SERVER-ADDRESS:/root/backups      # from your computer

cd /opt/ssl-tracker/app                                             # on the new server
docker compose create tracker
docker compose cp /root/backups/tracker-YYYY-MM-DD.db tracker:/data/tracker.db
docker compose cp /root/backups/vapid.json tracker:/data/vapid.json
docker compose run --rm --no-deps --user root tracker chown node:node /data/tracker.db /data/vapid.json
docker compose up -d
```

Without the original `vapid.json`, every device has to turn push
notifications on again.

## Day-to-day commands

Run these in `/opt/ssl-tracker/app`.

| Command | What it does |
| --- | --- |
| `docker compose ps` | Is it running, and healthy? |
| `docker compose logs -f tracker` | The tracker's log |
| `docker compose logs caddy` | Certificate and HTTPS problems |
| `docker compose restart tracker` | Restart the tracker |
| `docker compose down` | Stop everything; data is kept |
| `docker compose down -v` | Stop everything and **delete all data and the certificate** |
