'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { openStore } = require('../lib/db');
const { createApp } = require('../lib/api');

// The real server with a monitor and notifier that only count what reached
// them. Requests go through node:http so that Host and Origin can be set
// freely, as an attacker's browser would send them.
async function start(t, options = {}) {
  const store = openStore(':memory:');
  const domain = store.addDomain('example.com');
  const calls = { checkAll: 0, checkDomain: 0, testAlert: 0 };
  const monitor = {
    status: () => ({ lastTick: null, heartbeat: { enabled: false, lastAt: null, lastError: null } }),
    checkAll: async () => void calls.checkAll++,
    checkDomain: async () => void calls.checkDomain++,
  };
  const notifier = {
    emailStatus: () => ({ configured: false, from: '', to: '' }),
    send: async () => ({ email: { sent: Boolean(++calls.testAlert) } }),
  };
  const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-public-'));
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<h1>hello</h1>');
  const server = createApp({ store, monitor, notifier, publicDir, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.close();
    store.close();
    fs.rmSync(publicDir, { recursive: true });
  });
  const { port } = server.address();

  function request(method, url, { host = `127.0.0.1:${port}`, origin, json, form } = {}) {
    const headers = { host };
    if (origin !== undefined) headers.origin = origin;
    if (json !== undefined) headers['content-type'] = 'application/json';
    if (form !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
    return new Promise((resolve, reject) => {
      const req = http.request({ port, host: '127.0.0.1', method, path: url, headers }, (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      });
      req.on('error', reject);
      req.end(json !== undefined ? JSON.stringify(json) : form);
    });
  }
  return { request, calls, store, domain, port };
}

const BODYLESS = (id) => ['/api/check', `/api/domains/${id}/check`, '/api/alerts/test'];

test('a Host outside the allowlist gets 403, on pages and on the API', async (t) => {
  const { request, port } = await start(t);
  for (const host of [`evil.example:${port}`, 'evil.example', `192.168.1.20:${port}`, `127.0.0.1.evil.example:${port}`, 'a b']) {
    for (const url of ['/', '/api/domains', '/api/health']) {
      const res = await request('GET', url, { host });
      assert.equal(res.status, 403, `${host} ${url}`);
      assert.doesNotMatch(res.text, /example\.com|hello/, 'nothing is given away');
    }
  }
});

test('loopback names are always allowed, with or without a port', async (t) => {
  const { request, port } = await start(t);
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`, `[::1]:${port}`, 'localhost']) {
    assert.equal((await request('GET', '/api/domains', { host })).status, 200, host);
  }
});

test('the PUBLIC_URL host and the extra hosts are allowed, and nothing else', async (t) => {
  const { request, port } = await start(t, {
    publicUrl: 'https://tracker.tail1234.ts.net',
    allowedHosts: ['192.168.1.20', 'nas.lan:3000'],
  });
  for (const host of ['tracker.tail1234.ts.net', `192.168.1.20:${port}`, 'nas.lan', `nas.lan:${port}`]) {
    assert.equal((await request('GET', '/api/domains', { host })).status, 200, host);
  }
  for (const host of ['other.tail1234.ts.net', 'ts.net', '192.168.1.21']) {
    assert.equal((await request('GET', '/api/domains', { host })).status, 403, host);
  }
});

test('the three body-less POST routes refuse a foreign Origin', async (t) => {
  const { request, calls, domain, port } = await start(t);
  for (const origin of ['https://evil.example', `http://evil.example:${port}`, `http://localhost:${port + 1}`, 'null', 'nonsense']) {
    for (const url of BODYLESS(domain.id)) {
      assert.equal((await request('POST', url, { origin })).status, 403, `${origin} ${url}`);
      // What a plain cross-site <form method="post"> sends.
      assert.equal((await request('POST', url, { origin, form: 'a=1' })).status, 403, `${origin} ${url} as a form`);
    }
  }
  assert.deepEqual(calls, { checkAll: 0, checkDomain: 0, testAlert: 0 }, 'nothing was run');
});

test('every other state-changing route refuses a foreign Origin too', async (t) => {
  const { request, store, domain } = await start(t);
  const origin = 'https://evil.example';
  const attempts = [
    ['POST', '/api/domains', { host: 'attacker.example' }],
    ['DELETE', `/api/domains/${domain.id}`, undefined],
    ['PUT', '/api/settings', { emailTo: 'attacker@evil.example' }],
    ['POST', '/api/push/subscribe', { endpoint: 'https://push.evil.example/x', keys: { p256dh: 'a', auth: 'b' } }],
    ['POST', '/api/push/unsubscribe', { endpoint: 'https://push.example/x' }],
  ];
  for (const [method, url, json] of attempts) {
    assert.equal((await request(method, url, { origin, json })).status, 403, `${method} ${url}`);
  }
  assert.deepEqual(store.listDomains().map((d) => d.host), ['example.com']);
  assert.equal(store.getSettings().emailTo, '');
  assert.equal(store.countSubscriptions(), 0);
});

test('the app itself, and tools that send no Origin, still get through', async (t) => {
  const { request, calls, domain, port } = await start(t);
  for (const url of BODYLESS(domain.id)) {
    assert.equal((await request('POST', url, { origin: `http://127.0.0.1:${port}` })).status, 200, `same origin ${url}`);
    assert.equal((await request('POST', url, { host: `localhost:${port}`, origin: `http://localhost:${port}` })).status, 200);
    assert.equal((await request('POST', url)).status, 200, `no origin ${url}`);
  }
  assert.deepEqual(calls, { checkAll: 3, checkDomain: 3, testAlert: 3 });
  // Reading is not state-changing: a foreign page cannot see the answer anyway.
  assert.equal((await request('GET', '/api/domains', { origin: 'https://evil.example' })).status, 200);
});

test('behind an HTTPS proxy the PUBLIC_URL origin is accepted, whatever Host the proxy passes on', async (t) => {
  const { request, calls, port } = await start(t, { publicUrl: 'https://tracker.tail1234.ts.net/' });
  const origin = 'https://tracker.tail1234.ts.net';
  assert.equal((await request('POST', '/api/check', { origin, host: 'tracker.tail1234.ts.net' })).status, 200);
  assert.equal((await request('POST', '/api/check', { origin, host: `127.0.0.1:${port}` })).status, 200);
  assert.equal((await request('POST', '/api/check', { origin: 'http://tracker.tail1234.ts.net', host: `127.0.0.1:${port}` })).status, 403);
  assert.equal((await request('POST', '/api/check', { origin: 'https://evil.tail1234.ts.net', host: 'tracker.tail1234.ts.net' })).status, 403);
  assert.equal(calls.checkAll, 2);
});

test('every response carries the security headers', async (t) => {
  const { request } = await start(t);
  const responses = [
    await request('GET', '/'),
    await request('GET', '/api/domains'),
    await request('GET', '/missing.html'),
    await request('GET', '/', { host: 'evil.example' }),
    await request('POST', '/api/check', { origin: 'https://evil.example' }),
  ];
  assert.deepEqual(responses.map((r) => r.status), [200, 200, 404, 403, 403]);
  for (const { headers } of responses) {
    const csp = headers['content-security-policy'];
    assert.match(csp, /(^|; )default-src 'self'(;|$)/);
    assert.match(csp, /(^|; )script-src 'self'(;|$)/, 'no inline or third-party scripts');
    assert.match(csp, /(^|; )frame-ancestors 'none'(;|$)/);
    assert.match(csp, /(^|; )object-src 'none'(;|$)/);
    assert.equal(headers['x-frame-options'], 'DENY');
    assert.equal(headers['referrer-policy'], 'no-referrer');
    assert.equal(headers['x-content-type-options'], 'nosniff');
  }
});

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Starts the real server.js on a free port and collects what it logs until
// it says it is running.
async function boot(t, env) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-boot-'));
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '../server.js')], {
    env: { PATH: process.env.PATH, DATA_DIR: dataDir, PORT: String(port), ...env },
  });
  t.after(() => {
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return new Promise((resolve, reject) => {
    let output = '';
    let started = false;
    const collect = (chunk) => {
      output += chunk;
      // The heartbeat line is the last thing logged at startup. Stdout and
      // stderr arrive separately, so stop the server and read both to the end.
      if (!started && /Heartbeat is off/.test(output)) {
        started = true;
        child.kill();
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('close', (code) => (started ? resolve(output) : reject(new Error(`server.js exited with ${code}: ${output}`))));
  });
}

// A cheap but valid hash; the password behind it is never used here.
const SOME_HASH = `scrypt:1024:8:1:${'ab'.repeat(16)}:${'cd'.repeat(32)}`;

test('startup is refused when HOST is not loopback and no password is set', async (t) => {
  for (const HOST of ['0.0.0.0', '::']) {
    await assert.rejects(boot(t, { HOST }), /exited with 1: Not starting: HOST=\S+ lets other machines reach the tracker, and no password is set/);
  }
  assert.match(await boot(t, { HOST: '0.0.0.0', AUTH_PASSWORD_HASH: SOME_HASH }), /SSL Tracker running/);
});

test('startup is refused when the password hash is not a usable one', async (t) => {
  for (const AUTH_PASSWORD_HASH of ['hunter2', 'scrypt:1000:8:1:abcd:ef', `${SOME_HASH}zz`]) {
    await assert.rejects(boot(t, { AUTH_PASSWORD_HASH }), /exited with 1: Not starting: AUTH_PASSWORD_HASH is not a valid hash/);
  }
});

test('on loopback the app starts without a password and says the login is off', async (t) => {
  assert.match(await boot(t, {}), /Login is off/);
  assert.match(await boot(t, { HOST: '127.0.0.1' }), /Login is off/);
  assert.doesNotMatch(await boot(t, { AUTH_PASSWORD_HASH: SOME_HASH }), /Login is off/);
});
