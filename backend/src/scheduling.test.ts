import assert from 'node:assert/strict';
import test from 'node:test';
import { nextRecipientWindow, recommendActiveWindow, SEND_PLAN_MIN_NOTICE_MS } from './scheduling.js';

test('requires at least 24 hours between a send-plan announcement and sending', () => {
  assert.equal(SEND_PLAN_MIN_NOTICE_MS, 24 * 60 * 60 * 1000);
});

test('schedules only inside the recommended weekday local-time window', () => {
  const morning = nextRecipientWindow(new Date('2026-10-14T02:00:00Z'), 'America/New_York');
  const morningParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(morning);
  const morningHour = Number(morningParts.find((part) => part.type === 'hour')?.value);
  const morningMinute = Number(morningParts.find((part) => part.type === 'minute')?.value);
  const morningWeekday = morningParts.find((part) => part.type === 'weekday')?.value;
  assert.ok(morningHour * 60 + morningMinute >= 9 * 60 + 30);
  assert.ok(morningHour * 60 + morningMinute < 11 * 60 + 30);
  assert.ok(!['Sat', 'Sun'].includes(morningWeekday ?? ''));

  const afternoon = nextRecipientWindow(new Date('2026-10-14T02:00:00Z'), 'America/New_York', 'afternoon');
  const afternoonParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(afternoon);
  const afternoonHour = Number(afternoonParts.find((part) => part.type === 'hour')?.value);
  const afternoonMinute = Number(afternoonParts.find((part) => part.type === 'minute')?.value);
  assert.ok(afternoonHour * 60 + afternoonMinute >= 14 * 60);
  assert.ok(afternoonHour * 60 + afternoonMinute < 16 * 60);
});

test('uses the conservative default until a country has sufficient reply history', () => {
  const outcomes = Array.from({ length: 30 }, (_, index) => ({ hour: index % 2 ? 10 : 15, replied: index % 3 === 0 }));
  assert.equal(recommendActiveWindow(outcomes.slice(0, 20)).source, 'default');
  assert.equal(recommendActiveWindow(outcomes).source, 'default');
});

test('adapts to the better reply-rate window after sufficient market evidence', () => {
  const outcomes = [
    ...Array.from({ length: 20 }, () => ({ hour: 10, replied: false })),
    ...Array.from({ length: 20 }, (_, index) => ({ hour: 15, replied: index < 10 })),
  ];
  const recommendation = recommendActiveWindow(outcomes);
  assert.equal(recommendation.window, 'afternoon');
  assert.equal(recommendation.source, 'market-history');
});
