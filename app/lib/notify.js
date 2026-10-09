'use strict';

const fs = require('node:fs');
const path = require('node:path');
const webpush = require('web-push');

// Keys are generated once and kept in the data dir: browsers tie their push
// subscriptions to the public key, so it must survive restarts.
function loadVapidKeys(dataDir) {
  const file = path.join(dataDir, 'vapid.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}

function createNotifier({ store, dataDir, env = process.env, fetch = globalThis.fetch, push = webpush }) {
  const vapid = loadVapidKeys(dataDir);
  const emailFrom = env.ALERT_EMAIL_FROM || 'SSL Tracker <onboarding@resend.dev>';
  const emailTo = (settings) => settings.emailTo || env.ALERT_EMAIL_TO || '';
  const vapidSubject = env.VAPID_SUBJECT || `mailto:${env.ALERT_EMAIL_TO || 'alerts@example.com'}`;

  async function sendEmail(message, settings) {
    const to = emailTo(settings);
    if (!settings.emailEnabled) return { sent: false, skipped: 'Email alerts are turned off' };
    if (!env.RESEND_API_KEY) return { sent: false, skipped: 'RESEND_API_KEY is not set' };
    if (!to) return { sent: false, skipped: 'No alert email address is set' };
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: emailFrom, to: [to], subject: message.title, text: message.text, html: message.html }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return { sent: true };
      const body = await res.json().catch(() => ({}));
      return { sent: false, error: `Resend replied ${res.status}${body.message ? `: ${body.message}` : ''}` };
    } catch (err) {
      return { sent: false, error: `Could not reach Resend: ${err.message}` };
    }
  }

  async function sendPush(message, settings) {
    if (!settings.pushEnabled) return { sent: 0, failed: 0, skipped: 'Push alerts are turned off' };
    const subscriptions = store.listSubscriptions();
    if (!subscriptions.length) return { sent: 0, failed: 0, skipped: 'No devices are subscribed' };
    const payload = JSON.stringify({ title: message.title, body: message.body, tag: message.tag, url: message.url });
    const options = { vapidDetails: { subject: vapidSubject, publicKey: vapid.publicKey, privateKey: vapid.privateKey }, TTL: 86_400 };
    let sent = 0;
    let failed = 0;
    await Promise.all(
      subscriptions.map(async (sub) => {
        try {
          await push.sendNotification(sub, payload, options);
          sent++;
        } catch (err) {
          failed++;
          // The browser has dropped this subscription; stop sending to it.
          if (err.statusCode === 404 || err.statusCode === 410) store.removeSubscription(sub.endpoint);
        }
      })
    );
    return { sent, failed };
  }

  return {
    vapidPublicKey: vapid.publicKey,
    emailStatus: (settings) => ({ configured: Boolean(env.RESEND_API_KEY), from: emailFrom, to: emailTo(settings) }),
    async send(message, settings) {
      const [email, pushResult] = await Promise.all([sendEmail(message, settings), sendPush(message, settings)]);
      return { email, push: pushResult };
    },
  };
}

function deliveredChannels(outcome) {
  const channels = [];
  if (outcome.email.sent) channels.push('email');
  if (outcome.push.sent > 0) channels.push('push');
  return channels;
}

module.exports = { createNotifier, deliveredChannels };
