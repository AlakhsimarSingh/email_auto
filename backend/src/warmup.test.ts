import assert from 'node:assert/strict';
import test from 'node:test';
import { warmupCap } from './warmup.js';

test('starts at the first warm-up stage and advances on configured stage boundaries', () => {
  const start = new Date('2026-01-01T00:00:00Z');
  const ramp = [3, 5, 7, 10];
  assert.equal(warmupCap(null, start, 10, ramp, 7).cap, 3);
  assert.equal(warmupCap(start, new Date('2026-01-07T23:59:59Z'), 10, ramp, 7).cap, 3);
  assert.equal(warmupCap(start, new Date('2026-01-08T00:00:00Z'), 10, ramp, 7).cap, 5);
  assert.equal(warmupCap(start, new Date('2027-01-01T00:00:00Z'), 8, ramp, 7).cap, 8);
});

test('rejects malformed or descending warm-up ramps', () => {
  assert.throws(() => warmupCap(null, new Date(), 10, [3, 2], 7), /positive integers in ascending order/);
});
