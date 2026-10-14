import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_ROI_SETTINGS, parseRoiSettings } from './analytics-extra.js';

test('ROI settings accept valid values and fill defaults', () => {
  assert.deepEqual(parseRoiSettings({}), DEFAULT_ROI_SETTINGS);
  const parsed = parseRoiSettings({ hourlyRate: 40, reviewMinutes: 2, currency: 'EUR' });
  assert.equal(parsed?.hourlyRate, 40);
  assert.equal(parsed?.reviewMinutes, 2);
  assert.equal(parsed?.replyMinutes, DEFAULT_ROI_SETTINGS.replyMinutes);
  assert.equal(parsed?.currency, 'EUR');
});

test('ROI settings reject out-of-range, mistyped and malformed input', () => {
  for (const bad of [null, [], 'x', { hourlyRate: -1 }, { hourlyRate: '40' }, { reviewMinutes: 500 }, { currency: 'usd' }, { currency: 'ZZZZ' }, { fixedMonthlyCost: Number.NaN }, { llmCostPerMillionTokens: 5000 }]) {
    assert.equal(parseRoiSettings(bad), null, JSON.stringify(bad));
  }
});
