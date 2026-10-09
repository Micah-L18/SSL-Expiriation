'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { dueThreshold, normalizeThresholds, daysLeft, buildMessage, DAY_MS } = require('../lib/alerts');

const now = new Date('2026-10-08T12:00:00Z');
const inDays = (days) => new Date(now.getTime() + days * DAY_MS).toISOString();
const due = (days, sent = [], thresholds = [30, 14, 7, 1]) =>
  dueThreshold({ expiresAt: inDays(days), now, thresholds, sent });

test('daysLeft counts whole days remaining', () => {
  assert.equal(daysLeft(inDays(30.5), now), 30);
  assert.equal(daysLeft(inDays(0.5), now), 0);
  assert.equal(daysLeft(inDays(-0.5), now), -1);
});

test('no alert while expiry is beyond every threshold', () => {
  assert.equal(due(31.5), null);
  assert.equal(due(200), null);
});

test('alerts when a threshold is crossed', () => {
  assert.equal(due(30.5), 30);
  assert.equal(due(14), 14);
  assert.equal(due(1.2), 1);
});

test('does not repeat an alert for the same threshold', () => {
  assert.equal(due(29, [30]), null);
  assert.equal(due(15, [30]), null);
  assert.equal(due(14.5, [30]), 14);
  assert.equal(due(3, [30, 14, 7]), null);
});

test('a domain added late gets only the tightest crossed threshold', () => {
  assert.equal(due(5), 7);
  assert.equal(due(4, [7]), null);
  assert.equal(due(1, [7]), 1);
});

test('sends one expired alert, as threshold 0', () => {
  assert.equal(due(-0.1, [30, 14, 7, 1]), 0);
  assert.equal(due(-5, [0]), null);
});

test('changing thresholds never re-sends for a looser threshold', () => {
  assert.equal(due(5, [7], [30, 14, 10, 7, 1]), null);
  assert.equal(due(5, [7], [30, 14, 1]), null);
  assert.equal(due(5, [7], [30, 14, 7, 5, 1]), 5);
});

test('an empty threshold list turns alerts off', () => {
  assert.equal(due(3, [], []), null);
  assert.equal(due(-3, [], []), null);
});

test('normalizeThresholds sorts, de-duplicates and rejects bad input', () => {
  assert.deepEqual(normalizeThresholds([7, 30, 7, 1]), [30, 7, 1]);
  assert.deepEqual(normalizeThresholds([]), []);
  for (const bad of [[0], [366], [1.5], ['7'], 'x', null, [-1]]) assert.equal(normalizeThresholds(bad), null);
});

test('buildMessage describes the expiry and escapes HTML', () => {
  const ssl = buildMessage({ host: 'example.com', kind: 'ssl', expiresAt: inDays(7.5), now, meta: 'A <b>& Co' });
  assert.equal(ssl.title, 'SSL certificate for example.com expires in 7 days');
  assert.match(ssl.text, /Issued by: A <b>& Co/);
  assert.ok(!ssl.html.includes('<b>'));
  assert.equal(ssl.tag, 'ssl:example.com');

  const reg = buildMessage({ host: 'example.com', kind: 'registration', expiresAt: inDays(1.5), now });
  assert.equal(reg.title, 'Domain registration for example.com expires in 1 day');
  assert.equal(buildMessage({ host: 'a.io', kind: 'ssl', expiresAt: inDays(-2), now }).title, 'SSL certificate for a.io has expired');
  assert.equal(buildMessage({ host: 'a.io', kind: 'ssl', expiresAt: inDays(0.5), now }).title, 'SSL certificate for a.io expires today');
});
