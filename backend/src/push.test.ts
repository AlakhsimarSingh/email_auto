import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePushSubscription, pushConfiguration } from './push.js';

const subscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/subscription-token',
  keys: {
    p256dh: Buffer.alloc(65, 1).toString('base64url'),
    auth: Buffer.alloc(16, 2).toString('base64url'),
  },
};

test('accepts a valid Chrome Web Push subscription', () => {
  assert.deepEqual(parsePushSubscription(subscription), {
    endpoint: subscription.endpoint,
    keys: subscription.keys,
  });
});

test('rejects non-HTTPS, non-provider, and malformed subscriptions', () => {
  assert.equal(parsePushSubscription({ ...subscription, endpoint: 'http://fcm.googleapis.com/token' }), null);
  assert.equal(parsePushSubscription({ ...subscription, endpoint: 'https://127.0.0.1/admin' }), null);
  assert.equal(parsePushSubscription({ ...subscription, endpoint: 'https://example.com/push' }), null);
  assert.equal(parsePushSubscription({ ...subscription, keys: { p256dh: 'bad', auth: 'bad' } }), null);
  assert.equal(parsePushSubscription(null), null);
});

test('requires complete, structurally valid VAPID configuration', () => {
  const original = {
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
    subject: process.env.VAPID_SUBJECT,
  };
  try {
    process.env.VAPID_PUBLIC_KEY = Buffer.alloc(65, 1).toString('base64url');
    process.env.VAPID_PRIVATE_KEY = Buffer.alloc(32, 2).toString('base64url');
    process.env.VAPID_SUBJECT = 'mailto:push@example.com';
    assert.equal(pushConfiguration().configured, true);
    process.env.VAPID_PRIVATE_KEY = '';
    assert.throws(() => pushConfiguration(), /must all be configured together/);
  } finally {
    for (const [key, value] of Object.entries({
      VAPID_PUBLIC_KEY: original.publicKey,
      VAPID_PRIVATE_KEY: original.privateKey,
      VAPID_SUBJECT: original.subject,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
