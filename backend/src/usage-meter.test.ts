import assert from 'node:assert/strict';
import test from 'node:test';
import { parseUsageRow } from './usage-meter.js';

test('parses daily usage-meter rows and defaults missing counters to zero', () => {
  assert.deepEqual(parseUsageRow('usage_meter:2026-10-15', { pagespeed_calls: 7, awake_seconds: 3600 }), { day: '2026-10-15', pagespeedCalls: 7, awakeSeconds: 3600 });
  assert.deepEqual(parseUsageRow('usage_meter:2026-10-14', { awake_seconds: '120' }), { day: '2026-10-14', pagespeedCalls: 0, awakeSeconds: 120 });
});

test('ignores unrelated keys and rejects malformed counter values', () => {
  assert.equal(parseUsageRow('brain_settings', { pagespeed_calls: 1 }), null);
  assert.equal(parseUsageRow('usage_meter:2026-10-15', [1, 2]), null);
  assert.deepEqual(parseUsageRow('usage_meter:2026-10-15', { pagespeed_calls: -4, awake_seconds: 'x' }), { day: '2026-10-15', pagespeedCalls: 0, awakeSeconds: 0 });
});
