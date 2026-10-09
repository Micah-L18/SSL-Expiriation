'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

// Cost of hashing a new password. A stored hash carries its own numbers, so
// raising these later does not lock out a password hashed with the old ones.
const SCRYPT = { N: 32768, r: 8, p: 1 };
const KEY_BYTES = 32;
const MAX_PASSWORD = 1024;
const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 86_400_000;

// An address gets this many tries in a row; from then on each further try is
// followed by a wait that doubles, up to the longest one. A try is forgotten
// an hour after the last one, or at once when the password is right.
const FREE_ATTEMPTS = 5;
const FIRST_WAIT_MS = 30_000;
const LONGEST_WAIT_MS = 15 * 60_000;
const FORGET_MS = 3_600_000;
const MAX_TRACKED = 10_000;

function derive(password, salt, { N, r, p }, length) {
  return scrypt(password, salt, length, { N, r, p, maxmem: 256 * N * r });
}

// Hashes look like scrypt:32768:8:1:<salt>:<key>, with no characters that
// need quoting in a .env file.
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await derive(password, salt, SCRYPT, KEY_BYTES);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('hex'), key.toString('hex')].join(':');
}

// The parts of a stored hash, or null when it is not one this app can check.
function parseHash(stored) {
  const match = /^scrypt:(\d+):(\d+):(\d+):((?:[0-9a-f]{2}){8,}):((?:[0-9a-f]{2}){16,})$/.exec(String(stored).trim());
  if (!match) return null;
  const [N, r, p] = match.slice(1, 4).map(Number);
  const sane = N >= 1024 && N <= 2 ** 20 && (N & (N - 1)) === 0 && r >= 1 && r <= 32 && p >= 1 && p <= 16;
  return sane ? { N, r, p, salt: Buffer.from(match[4], 'hex'), key: Buffer.from(match[5], 'hex') } : null;
}

async function verifyPassword(password, parsed) {
  if (typeof password !== 'string' || password.length > MAX_PASSWORD) return false;
  const key = await derive(password, parsed.salt, parsed, parsed.key.length);
  return crypto.timingSafeEqual(key, parsed.key);
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// What failed logins are counted against: the address itself for IPv4, and
// the /64 network for IPv6, where one customer holds a whole /64 of addresses.
function limitKey(address) {
  let ip = String(address || '');
  if (ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  if (!net.isIPv6(ip)) return ip;
  const [head, tail = ''] = ip.split('%')[0].split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':') + '::/64';
}

function createLoginLimiter({ now }) {
  const attempts = new Map();

  function forget(time) {
    for (const [key, entry] of attempts) {
      if (time - entry.lastAt > FORGET_MS) attempts.delete(key);
    }
    // Still full of live entries: drop the oldest rather than grow without end.
    for (const key of attempts.keys()) {
      if (attempts.size < MAX_TRACKED) break;
      attempts.delete(key);
    }
  }

  return {
    // Counts a try before the password is looked at, so a burst of parallel
    // requests cannot all slip through. Returns 0, or the seconds left to wait.
    attempt(address) {
      const key = limitKey(address);
      const time = now().getTime();
      let entry = attempts.get(key);
      if (entry && time - entry.lastAt > FORGET_MS) entry = undefined;
      if (entry && time < entry.blockedUntil) return Math.ceil((entry.blockedUntil - time) / 1000);
      if (!entry && attempts.size >= MAX_TRACKED) forget(time);
      entry = entry || { count: 0, blockedUntil: 0 };
      entry.count++;
      entry.lastAt = time;
      if (entry.count >= FREE_ATTEMPTS) {
        entry.blockedUntil = time + Math.min(FIRST_WAIT_MS * 2 ** Math.min(entry.count - FREE_ATTEMPTS, 10), LONGEST_WAIT_MS);
      }
      attempts.delete(key);
      attempts.set(key, entry);
      return 0;
    },
    succeed: (address) => void attempts.delete(limitKey(address)),
  };
}

// passwordHash: the AUTH_PASSWORD_HASH value; empty means login is off and
// every request counts as signed in. secure: mark the cookie HTTPS-only.
// trustProxy: take the client address from the reverse proxy in front.
function createAuth({ store, passwordHash = '', secure = false, trustProxy = false, now = () => new Date() }) {
  const parsed = passwordHash ? parseHash(passwordHash) : null;
  if (passwordHash && !parsed) {
    throw new Error('AUTH_PASSWORD_HASH is not a valid hash. Create one with: node scripts/hash-password.js');
  }
  const enabled = Boolean(parsed);
  // Sessions are tied to the hash they were opened with, so changing the
  // password signs every device out.
  const credential = enabled ? sha256(passwordHash.trim()) : '';
  // The __Host- prefix makes browsers refuse the cookie unless it is Secure
  // and set by this exact host.
  const cookieName = secure ? '__Host-tracker_session' : 'tracker_session';
  const cookie = (value, maxAge) =>
    `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const limiter = createLoginLimiter({ now });

  function tokenOf(req) {
    for (const part of (req.headers.cookie || '').split(';')) {
      const [name, value] = part.trim().split('=');
      if (name === cookieName && value) return value;
    }
    return null;
  }

  function clientAddress(req) {
    // The proxy appends the address it saw, so only the last entry is its
    // word; anything before that came from the client and proves nothing.
    const forwarded = trustProxy && String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
    return forwarded || req.socket.remoteAddress;
  }

  return {
    enabled,
    signedIn(req) {
      if (!enabled) return true;
      const token = tokenOf(req);
      return Boolean(token) && store.hasSession(sha256(token), credential, now().toISOString());
    },
    // { cookie } on success, { retryAfter } (seconds) when this address has
    // to wait, {} when the password is wrong.
    async login(req, password) {
      const address = clientAddress(req);
      const retryAfter = limiter.attempt(address);
      if (retryAfter) return { retryAfter };
      if (!(await verifyPassword(password, parsed))) return {};
      limiter.succeed(address);
      const token = crypto.randomBytes(32).toString('base64url');
      const at = now();
      store.deleteExpiredSessions(at.toISOString());
      store.addSession(sha256(token), credential, at.toISOString(), new Date(at.getTime() + SESSION_MS).toISOString());
      return { cookie: cookie(token, SESSION_MS / 1000) };
    },
    // Ends the session the request carries; returns the cookie that clears it.
    logout(req) {
      const token = tokenOf(req);
      if (token) store.deleteSession(sha256(token));
      return cookie('', 0);
    },
  };
}

module.exports = { createAuth, hashPassword, parseHash, verifyPassword, limitKey, SESSION_DAYS };
