'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { openStore } = require('../lib/db');
const { createApp } = require('../lib/api');
const { hashPassword, parseHash, verifyPassword, limitKey } = require('../lib/auth');

const PASSWORD = 'correct horse battery staple';
const DAY_MS = 86_400_000;

// A real hash of PASSWORD at a low cost, so that the tests stay fast.
function cheapHash(password = PASSWORD) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32, { N: 1024, r: 8, p: 1 });
  return `scrypt:1024:8:1:${salt.toString('hex')}:${key.toString('hex')}`;
}

// The real server on a file database, with a login, a fake clock and one
// tracked domain. Requests go through node:http so cookies and proxy headers
// can be set by hand.
async function start(t, { passwordHash = cheapHash(), ...options } = {}) {
  const clock = { now: new Date('2026-10-09T12:00:00Z') };
  const now = () => clock.now;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-auth-'));
  const dbFile = path.join(dir, 'tracker.db');
  const store = openStore(dbFile);
  store.addDomain('example.com');
  const calls = { checkAll: 0 };
  const monitor = {
    status: () => ({ lastTick: null, heartbeat: { enabled: false, lastAt: null, lastError: null } }),
    checkAll: async () => void calls.checkAll++,
    checkDomain: async () => {},
  };
  const notifier = { vapidPublicKey: 'key', emailStatus: () => ({ configured: false, from: '', to: '' }), send: async () => ({}) };
  const publicDir = path.join(dir, 'public');
  fs.mkdirSync(publicDir);
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<h1>shell</h1>');
  const makeApp = (hash) => createApp({ store, monitor, notifier, publicDir, now, passwordHash: hash, ...options });
  let server = makeApp(passwordHash);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.close();
    store.close();
    fs.rmSync(dir, { recursive: true });
  });

  function request(method, url, { cookie, json, ip, origin } = {}) {
    const { port } = server.address();
    const headers = { host: `127.0.0.1:${port}` };
    if (cookie) headers.cookie = cookie;
    if (ip) headers['x-forwarded-for'] = ip;
    if (origin) headers.origin = origin;
    if (json !== undefined) headers['content-type'] = 'application/json';
    return new Promise((resolve, reject) => {
      const req = http.request({ port, host: '127.0.0.1', method, path: url, headers }, (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          const isJson = /json/.test(res.headers['content-type'] || '');
          resolve({ status: res.statusCode, headers: res.headers, text, body: isJson && text ? JSON.parse(text) : null });
        });
      });
      req.on('error', reject);
      req.end(json !== undefined ? JSON.stringify(json) : undefined);
    });
  }
  const login = (password = PASSWORD, extra = {}) => request('POST', '/api/login', { json: { password }, ...extra });
  // Signs in and returns the Cookie header a browser would send from then on.
  async function signIn() {
    const res = await login();
    assert.equal(res.status, 200);
    return res.headers['set-cookie'][0].split(';')[0];
  }
  // The same data folder under a server with another password, as after a
  // change to .env and a restart.
  async function restart(hash) {
    server.close();
    server = makeApp(hash);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  }
  const advance = (ms) => (clock.now = new Date(clock.now.getTime() + ms));
  return { request, login, signIn, restart, advance, store, calls, dbFile };
}

// Every route that holds or changes data, with a body that would be accepted.
const PROTECTED = [
  ['GET', '/api/domains'],
  ['POST', '/api/domains', { host: 'new.example' }],
  ['GET', '/api/domains/1'],
  ['DELETE', '/api/domains/1'],
  ['POST', '/api/domains/1/check'],
  ['POST', '/api/check'],
  ['GET', '/api/settings'],
  ['PUT', '/api/settings', { emailEnabled: false }],
  ['GET', '/api/push/vapid-public-key'],
  ['POST', '/api/push/subscribe', { endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } }],
  ['POST', '/api/push/unsubscribe', { endpoint: 'https://push.example/1' }],
  ['POST', '/api/alerts/test'],
  ['POST', '/api/logout'],
];

test('a hashed password verifies, and nothing else does', async () => {
  const hash = await hashPassword(PASSWORD);
  assert.match(hash, /^scrypt:32768:8:1:[0-9a-f]{32}:[0-9a-f]{64}$/);
  assert.notEqual(hash, await hashPassword(PASSWORD), 'each hash has its own salt');
  const parsed = parseHash(hash);
  assert.equal(await verifyPassword(PASSWORD, parsed), true);
  for (const wrong of [`${PASSWORD} `, PASSWORD.toUpperCase(), '', 'x'.repeat(5000), undefined, null, 12, {}]) {
    assert.equal(await verifyPassword(wrong, parsed), false);
  }
});

test('hash-password.js prints a line for .env, and refuses a short password', async () => {
  const run = (input) => spawnSync(process.execPath, [path.join(__dirname, '../scripts/hash-password.js')], { input, encoding: 'utf8' });
  const good = run(`${PASSWORD}\n`);
  assert.equal(good.status, 0, good.stderr);
  const [, hash] = /^AUTH_PASSWORD_HASH=(\S+)\n$/.exec(good.stdout);
  assert.equal(await verifyPassword(PASSWORD, parseHash(hash)), true);
  assert.doesNotMatch(hash, /[$#"'\s\\]/, 'needs no quoting in .env or in a Compose file');

  const short = run('too short\n');
  assert.equal(short.status, 1);
  assert.equal(short.stdout, '');
  assert.match(short.stderr, /at least 12 characters/);
});

test('without a session every data route answers 401 and does nothing', async (t) => {
  const { request, store, calls } = await start(t);
  for (const [method, url, json] of PROTECTED) {
    const res = await request(method, url, { json });
    assert.equal(res.status, 401, `${method} ${url}`);
    assert.deepEqual(res.body, { error: 'Sign in to continue' });
    assert.match(res.headers['content-type'], /^application\/json/);
  }
  assert.deepEqual(store.listDomains().map((d) => d.host), ['example.com']);
  assert.equal(store.getSettings().emailEnabled, true);
  assert.equal(store.countSubscriptions(), 0);
  assert.equal(calls.checkAll, 0);
});

test('without a session, routes that do not exist look the same as ones that do', async (t) => {
  const { request } = await start(t);
  for (const [method, url] of [['GET', '/api/nope'], ['GET', '/api'], ['PATCH', '/api/domains'], ['GET', '/api/domains/999']]) {
    assert.equal((await request(method, url)).status, 401, `${method} ${url}`);
  }
});

test('the static shell loads without a session', async (t) => {
  const { request } = await start(t);
  const res = await request('GET', '/');
  assert.equal(res.status, 200);
  assert.equal(res.text, '<h1>shell</h1>');
});

test('signing in sets a session cookie that opens the API', async (t) => {
  const { request, login } = await start(t);
  assert.deepEqual((await request('GET', '/api/session')).body, { authenticated: false, loginRequired: true });

  const res = await login();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { authenticated: true });
  assert.equal(res.headers['set-cookie'].length, 1);
  const [pair, ...attributes] = res.headers['set-cookie'][0].split('; ');
  assert.match(pair, /^tracker_session=[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(attributes, ['Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${30 * 86400}`]);

  assert.deepEqual((await request('GET', '/api/session', { cookie: pair })).body, { authenticated: true, loginRequired: true });
  const domains = await request('GET', '/api/domains', { cookie: pair });
  assert.equal(domains.status, 200);
  assert.equal(domains.body.domains[0].host, 'example.com');
  // Alongside other cookies, as a browser sends them.
  assert.equal((await request('GET', '/api/domains', { cookie: `theme=dark; ${pair}; other=1` })).status, 200);
});

test('with an https PUBLIC_URL the cookie is Secure and bound to the host', async (t) => {
  const { login, request } = await start(t, { publicUrl: 'https://tracker.example.com' });
  const res = await login();
  const [pair, ...attributes] = res.headers['set-cookie'][0].split('; ');
  assert.match(pair, /^__Host-tracker_session=/);
  assert.ok(attributes.includes('Secure'));
  assert.ok(attributes.includes('HttpOnly'));
  assert.ok(attributes.includes('SameSite=Strict'));
  assert.equal((await request('GET', '/api/domains', { cookie: pair })).status, 200);
});

test('a wrong password gets one generic answer and no cookie', async (t) => {
  const { login, request } = await start(t);
  for (const password of ['wrong', `${PASSWORD}x`, 'x'.repeat(2000)]) {
    const res = await login(password, { ip: '198.51.100.1' });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: 'Incorrect password' });
    assert.equal(res.headers['set-cookie'], undefined);
  }
  for (const json of [{}, { password: '' }, { password: 5 }, { password: null }]) {
    const res = await request('POST', '/api/login', { json });
    assert.equal(res.status, 400);
    assert.equal(res.headers['set-cookie'], undefined);
  }
  assert.equal((await request('POST', '/api/login')).status, 415);
  assert.equal((await request('GET', '/api/login')).status, 405);
});

test('a made-up or tampered cookie is not a session', async (t) => {
  const { request, signIn } = await start(t);
  const cookie = await signIn();
  const forged = [
    'tracker_session=',
    'tracker_session=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    `${cookie}x`,
    cookie.replace('tracker_session', '__Host-tracker_session'),
    "tracker_session=' OR 1=1 --",
  ];
  for (const bad of forged) assert.equal((await request('GET', '/api/domains', { cookie: bad })).status, 401, bad);
});

test('only a hash of the session token is stored', async (t) => {
  const { signIn, dbFile } = await start(t);
  const token = (await signIn()).split('=')[1];
  const db = new DatabaseSync(dbFile);
  t.after(() => db.close());
  const rows = db.prepare('SELECT * FROM sessions').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token_hash, crypto.createHash('sha256').update(token).digest('hex'));
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(token));
  assert.equal(rows[0].expires_at, '2026-11-08T12:00:00.000Z');
});

test('a session ends after 30 days', async (t) => {
  const { request, signIn, advance, dbFile } = await start(t);
  const cookie = await signIn();
  advance(30 * DAY_MS - 1000);
  assert.equal((await request('GET', '/api/domains', { cookie })).status, 200);
  advance(1000);
  assert.equal((await request('GET', '/api/domains', { cookie })).status, 401);
  assert.deepEqual((await request('GET', '/api/session', { cookie })).body, { authenticated: false, loginRequired: true });

  // The next sign-in clears the expired row out.
  await signIn();
  const db = new DatabaseSync(dbFile);
  t.after(() => db.close());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
});

test('signing out ends that session only, and clears the cookie', async (t) => {
  const { request, signIn } = await start(t);
  const phone = await signIn();
  const laptop = await signIn();
  const res = await request('POST', '/api/logout', { cookie: phone });
  assert.equal(res.status, 204);
  assert.match(res.headers['set-cookie'][0], /^tracker_session=; Path=\/; HttpOnly; SameSite=Strict; Max-Age=0$/);
  assert.equal((await request('GET', '/api/domains', { cookie: phone })).status, 401, 'the token itself is dead, not just forgotten by the browser');
  assert.equal((await request('GET', '/api/domains', { cookie: laptop })).status, 200);
});

test('changing the password signs every device out', async (t) => {
  const { request, signIn, restart } = await start(t);
  const cookie = await signIn();
  await restart(cheapHash('a brand new password'));
  assert.equal((await request('GET', '/api/domains', { cookie })).status, 401);
});

test('after five tries an address has to wait, even with the right password', async (t) => {
  const { login, advance } = await start(t, { trustProxy: true });
  const ip = '203.0.113.7';
  for (let i = 0; i < 5; i++) assert.equal((await login('wrong', { ip })).status, 401, `try ${i + 1}`);

  const blocked = await login('wrong', { ip });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers['retry-after'], '30');
  assert.deepEqual(blocked.body, { error: 'Too many attempts. Wait a while and try again.', retryAfter: 30 });
  const right = await login(PASSWORD, { ip });
  assert.equal(right.status, 429, 'the answer must not reveal that the password was right');
  assert.equal(right.headers['set-cookie'], undefined);

  advance(29_000);
  assert.equal((await login(PASSWORD, { ip })).status, 429);
  advance(1000);
  assert.equal((await login(PASSWORD, { ip })).status, 200);
});

test('the wait doubles with every further try, up to 15 minutes', async (t) => {
  const { login, advance } = await start(t, { trustProxy: true });
  const ip = '203.0.113.8';
  for (let i = 0; i < 4; i++) await login('wrong', { ip });
  const waits = [];
  for (let i = 0; i < 8; i++) {
    assert.equal((await login('wrong', { ip })).status, 401);
    const wait = (await login('wrong', { ip })).body.retryAfter;
    waits.push(wait);
    advance(wait * 1000);
  }
  assert.deepEqual(waits, [30, 60, 120, 240, 480, 900, 900, 900]);
});

test('a burst of parallel tries does not get past the limit', async (t) => {
  const { login } = await start(t, { trustProxy: true });
  const results = await Promise.all(Array.from({ length: 40 }, () => login('wrong', { ip: '203.0.113.9' })));
  assert.equal(results.filter((r) => r.status === 401).length, 5);
  assert.equal(results.filter((r) => r.status === 429).length, 35);
});

test('the limit is per address: one being blocked does not lock out another', async (t) => {
  const { login } = await start(t, { trustProxy: true });
  for (let i = 0; i < 6; i++) await login('wrong', { ip: '203.0.113.10' });
  assert.equal((await login('wrong', { ip: '203.0.113.10' })).status, 429);
  assert.equal((await login(PASSWORD, { ip: '203.0.113.11' })).status, 200);
  // Only the proxy's own entry counts; a client cannot talk its way to a fresh address.
  assert.equal((await login(PASSWORD, { ip: '198.51.100.99, 203.0.113.10' })).status, 429);
});

test('a successful sign-in clears the count, and tries are forgotten after an hour', async (t) => {
  const { login, advance } = await start(t, { trustProxy: true });
  const ip = '203.0.113.12';
  for (let i = 0; i < 4; i++) await login('wrong', { ip });
  assert.equal((await login(PASSWORD, { ip })).status, 200);
  for (let i = 0; i < 4; i++) assert.equal((await login('wrong', { ip })).status, 401);
  advance(3_600_001);
  for (let i = 0; i < 4; i++) assert.equal((await login('wrong', { ip })).status, 401);
  assert.equal((await login(PASSWORD, { ip })).status, 200);
});

test('without TRUST_PROXY the forwarded header is ignored', async (t) => {
  const { login } = await start(t);
  for (let i = 0; i < 5; i++) await login('wrong', { ip: `203.0.113.${i}` });
  assert.equal((await login(PASSWORD, { ip: '203.0.113.200' })).status, 429, 'all of them came from the same socket address');
});

test('IPv6 addresses are limited by their /64 network', () => {
  assert.equal(limitKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64');
  assert.equal(limitKey('2001:db8:1:2::1'), '2001:db8:1:2::/64');
  assert.equal(limitKey('2001:0db8:0001:0002::'), '2001:db8:1:2::/64');
  assert.equal(limitKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(limitKey('::1'), '0:0:0:0::/64');
  assert.equal(limitKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(limitKey('203.0.113.7'), '203.0.113.7');
});

test('health without a session says up or down and nothing else', async (t) => {
  const { request, signIn, advance } = await start(t);
  const anonymous = await request('GET', '/api/health');
  assert.equal(anonymous.status, 200);
  assert.deepEqual(anonymous.body, { ok: true });

  const signedIn = await request('GET', '/api/health', { cookie: await signIn() });
  assert.equal(signedIn.status, 200);
  assert.deepEqual(Object.keys(signedIn.body), ['ok', 'startedAt', 'lastTick', 'domains', 'lastBackupAt', 'heartbeat']);
  assert.equal(signedIn.body.domains, 1);

  advance(3 * 3_600_000);
  const stalled = await request('GET', '/api/health');
  assert.equal(stalled.status, 503);
  assert.deepEqual(stalled.body, { ok: false });
});

test('health answers HEAD, which uptime monitors use', async (t) => {
  const { request, advance } = await start(t);
  const up = await request('HEAD', '/api/health');
  assert.equal(up.status, 200);
  assert.equal(up.text, '');
  advance(3 * 3_600_000);
  assert.equal((await request('HEAD', '/api/health')).status, 503);
});

test('the Origin check still applies to signing in and to a signed-in session', async (t) => {
  const { request, login, signIn, calls } = await start(t);
  const foreign = await login(PASSWORD, { origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers['set-cookie'], undefined);

  const cookie = await signIn();
  assert.equal((await request('POST', '/api/check', { cookie, origin: 'https://evil.example' })).status, 403);
  assert.equal(calls.checkAll, 0);
  assert.equal((await request('POST', '/api/logout', { cookie, origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('GET', '/api/domains', { cookie })).status, 200, 'still signed in');
});

test('with no password set the login is off and everything is open, as before', async (t) => {
  const { request, login } = await start(t, { passwordHash: '' });
  assert.deepEqual((await request('GET', '/api/session')).body, { authenticated: true, loginRequired: false });
  assert.equal((await request('GET', '/api/domains')).status, 200);
  assert.equal(Object.keys((await request('GET', '/api/health')).body).length, 6);
  assert.equal((await login()).status, 400);
  const out = await request('POST', '/api/logout');
  assert.equal(out.status, 204);
  assert.equal(out.headers['set-cookie'], undefined);
});
