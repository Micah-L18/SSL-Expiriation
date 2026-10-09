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

const CHANNELS = ['email', 'push'];
// Resend's last_event for an email, mapped to the delivery status kept for it.
const EMAIL_EVENTS = {
  delivered: 'delivered',
  opened: 'delivered',
  clicked: 'delivered',
  bounced: 'bounced',
  suppressed: 'bounced',
  complained: 'complained',
  failed: 'failed',
  canceled: 'failed',
};

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
      const body = await res.json().catch(() => ({}));
      if (res.ok) return { sent: true, id: body.id || null };
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
    let error;
    await Promise.all(
      subscriptions.map(async (sub) => {
        try {
          await push.sendNotification(sub, payload, options);
          sent++;
        } catch (err) {
          failed++;
          error = `Push service replied ${err.statusCode || err.message}`;
          // The browser has dropped this subscription; stop sending to it.
          if (err.statusCode === 404 || err.statusCode === 410) store.removeSubscription(sub.endpoint);
        }
      })
    );
    return failed ? { sent, failed, error } : { sent, failed };
  }

  // Asks Resend what became of an email it accepted earlier. Resolves to
  // { status } with one of EMAIL_EVENTS' values, or 'unknown' with an error.
  async function emailDelivery(id) {
    try {
      const res = await fetch(`https://api.resend.com/emails/${encodeURIComponent(id)}`, {
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}` },
        signal: AbortSignal.timeout(15_000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { status: 'unknown', error: `Resend replied ${res.status}${body.message ? `: ${body.message}` : ''}` };
      const status = EMAIL_EVENTS[body.last_event] || 'sent';
      return status === 'sent' || status === 'delivered' ? { status } : { status, error: `Resend reports the email as ${body.last_event}` };
    } catch (err) {
      return { status: 'unknown', error: `Could not reach Resend: ${err.message}` };
    }
  }

  const senders = { email: sendEmail, push: sendPush };

  return {
    vapidPublicKey: vapid.publicKey,
    emailStatus: (settings) => ({ configured: Boolean(env.RESEND_API_KEY), from: emailFrom, to: emailTo(settings) }),
    emailDelivery,
    // Resolves to one result per channel asked for: { email?, push? }.
    async send(message, settings, channels = CHANNELS) {
      const results = await Promise.all(channels.map((channel) => senders[channel](message, settings)));
      return Object.fromEntries(channels.map((channel, i) => [channel, results[i]]));
    },
  };
}

// Turns a channel's send result into what is stored for it: sent, failed
// (worth another attempt) or skipped (the channel is off or not set up).
function deliveryOutcome(channel, result) {
  if (result.skipped) return { status: 'skipped', error: result.skipped, attempted: false };
  if (channel === 'email') {
    return result.sent ? { status: 'sent', messageId: result.id || null } : { status: 'failed', error: result.error || 'Email was not sent' };
  }
  if (result.sent > 0) return { status: 'sent', error: result.failed ? `${result.failed} device(s) could not be reached` : null };
  return { status: 'failed', error: result.error || 'No device could be reached' };
}

module.exports = { createNotifier, deliveryOutcome, CHANNELS };
