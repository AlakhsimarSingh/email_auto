import assert from 'node:assert/strict';
import test from 'node:test';
import { MAJOR_CITIES, marketPriorScore, scoreCity } from './targeting.js';

const none = { researched: 0, drafts: 0, waiting: 0 };

test('bigger cities in stronger markets rank higher before any evidence', () => {
  const big = scoreCity({ marketScore: 70, population: 6000, languageFit: 1, stats: none }).score;
  const small = scoreCity({ marketScore: 70, population: 400, languageFit: 1, stats: none }).score;
  const weakMarket = scoreCity({ marketScore: 40, population: 6000, languageFit: 1, stats: none }).score;
  assert.ok(big > small && big > weakMarket);
});

test('learned draft yield moves cities up or down as research accumulates', () => {
  const untried = scoreCity({ marketScore: 70, population: 2000, languageFit: 1, stats: none }).score;
  const productive = scoreCity({ marketScore: 70, population: 2000, languageFit: 1, stats: { researched: 120, drafts: 36, waiting: 400 } }).score;
  const barren = scoreCity({ marketScore: 70, population: 2000, languageFit: 1, stats: { researched: 120, drafts: 2, waiting: 400 } }).score;
  assert.ok(productive > untried, 'a city where 30% of leads became drafts beats an untried one');
  assert.ok(barren < untried, 'a city where almost nothing converts falls below an untried one');
});

test('non-English-speaking and used-up cities are discounted', () => {
  const base = scoreCity({ marketScore: 70, population: 4000, languageFit: 1, stats: none }).score;
  assert.ok(scoreCity({ marketScore: 70, population: 4000, languageFit: 0.55, stats: none }).score < base * 0.6);
  const usedUp = scoreCity({ marketScore: 70, population: 4000, languageFit: 1, stats: { researched: 300, drafts: 60, waiting: 5 } });
  assert.equal(usedUp.exhausted, true);
});

test('every supported market has cities and the market prior matches the scorecard weights', () => {
  for (const code of ['US', 'CA', 'GB', 'AU', 'AE', 'SG']) assert.ok(MAJOR_CITIES[code]?.length, `${code} has no cities`);
  const market = { code: 'CA', name: 'Canada', clientValueScore: 80, leadSupplyScore: 70, emailYieldScore: 60, responseScore: 70, communicationFitScore: 90, compliancePenalty: 5 };
  assert.equal(Math.round(marketPriorScore(market)), Math.round((80 * 30 + 70 * 20 + 60 * 10 + 70 * 25 + 90 * 10) / 95 - 5));
});
