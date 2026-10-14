import assert from 'node:assert/strict';
import test from 'node:test';
import { isWithinQuietHours, shouldAttemptDelivery, validNtfyTarget } from './notifications.js';

test('quiet hours support same-day and overnight windows in the selected timezone', () => {
  assert.equal(isWithinQuietHours(new Date('2026-06-01T22:30:00Z'), 'UTC', '22:00', '07:00'), true);
  assert.equal(isWithinQuietHours(new Date('2026-06-02T03:00:00Z'), 'UTC', '22:00', '07:00'), true);
  assert.equal(isWithinQuietHours(new Date('2026-06-02T08:00:00Z'), 'UTC', '22:00', '07:00'), false);
  assert.equal(isWithinQuietHours(new Date('2026-06-02T12:30:00Z'), 'UTC', '12:00', '13:00'), true);
  assert.equal(isWithinQuietHours(new Date('2026-06-02T12:30:00Z'), 'UTC', '12:00', '12:00'), false);
});

test('ntfy targets are restricted to private HTTPS ntfy.sh topics', () => {
  assert.deepEqual(validNtfyTarget('https://ntfy.sh/private_topic_0123456789', ''), {
    url: 'https://ntfy.sh/private_topic_0123456789',
    token: undefined,
  });
  assert.equal(validNtfyTarget('http://ntfy.sh/private_topic_0123456789', ''), null);
  assert.equal(validNtfyTarget('https://ntfy.example.com/private_topic_0123456789', ''), null);
  assert.equal(validNtfyTarget('https://ntfy.sh/short', ''), null);
  assert.equal(validNtfyTarget('https://ntfy.sh/private_topic_0123456789?redirect=example.com', ''), null);
});

test('notification delivery attempts are capped and stale in-flight sends can recover', () => {
  const now = new Date('2026-06-02T12:00:00Z');
  assert.equal(shouldAttemptDelivery('pending', 0, null, now), true);
  assert.equal(shouldAttemptDelivery('failed', 2, null, now), true);
  assert.equal(shouldAttemptDelivery('failed', 3, null, now), false);
  assert.equal(shouldAttemptDelivery('sent', 1, null, now), false);
  assert.equal(shouldAttemptDelivery('sending', 1, new Date(now.getTime() - 60_000), now), false);
  assert.equal(shouldAttemptDelivery('sending', 1, new Date(now.getTime() - 180_000), now), true);
});
