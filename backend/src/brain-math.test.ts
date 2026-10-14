import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ANGLES, applicableAngles, aucScore, betaCdf, betaQuantile, cleanGuidanceText, containsBannedPhrase, dealReward,
  decayLesson, decideOutcome, deriveEditLessons, deriveSegmentProposals, globalRate, hourBandOf, leadFeatureNames,
  leadFeatures, learnGamma, mulberry32, posterior, predictLogistic, probabilityBest, recontactProbability,
  replySentiment, sampleBeta, scrubForLlm, segmentKey, selectCandidates, selectMemory, splitSentences,
  subjectStyleOf, summarizeEdit, trainLogistic, trainScorer, wilsonInterval, wordEditDistance,
  type Candidate, type EditDiff, type MemoryItem, type SelectionParams,
} from './brain-math.js';

const near = (actual: number, expected: number, tolerance: number, message?: string) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, message ?? `${actual} is not within ${tolerance} of ${expected}`);

test('beta sampler converges on the analytical mean', () => {
  const rng = mulberry32(42);
  let sum = 0;
  for (let i = 0; i < 6000; i++) sum += sampleBeta(2, 8, rng);
  near(sum / 6000, 0.2, 0.01);
  const sparse = mulberry32(7);
  let sparseSum = 0;
  for (let i = 0; i < 6000; i++) sparseSum += sampleBeta(0.8, 19.2, sparse);
  near(sparseSum / 6000, 0.04, 0.005);
});

test('beta CDF matches the binomial identity for integer parameters', () => {
  const binomial = (a: number, b: number, x: number) => {
    const n = a + b - 1;
    let total = 0;
    let coefficient = 1;
    for (let j = 0; j <= n; j++) {
      if (j > 0) coefficient = (coefficient * (n - j + 1)) / j;
      if (j >= a) total += coefficient * x ** j * (1 - x) ** (n - j);
    }
    return total;
  };
  for (const [a, b, x] of [[2, 5, 0.2], [3, 3, 0.5], [1, 9, 0.1], [10, 4, 0.7]] as const) {
    near(betaCdf(x, a, b), binomial(a, b, x), 1e-8);
  }
  near(betaCdf(0.3, 1, 1), 0.3, 1e-9);
  assert.equal(betaCdf(0, 2, 2), 0);
  assert.equal(betaCdf(1, 2, 2), 1);
});

test('beta quantile inverts the CDF', () => {
  for (const p of [0.05, 0.5, 0.95]) near(betaCdf(betaQuantile(p, 3, 7), 3, 7), p, 1e-6);
});

test('posterior shrinks small samples toward the prior and keeps an ordered interval', () => {
  const empty = posterior({ successes: 0, failures: 0 }, 0.04, 20);
  near(empty.mean, 0.04, 1e-9);
  const one = posterior({ successes: 1, failures: 0 }, 0.04, 20);
  near(one.mean, 1.8 / 21, 1e-9);
  assert.ok(one.mean < 0.1, 'one lucky reply must not look like a 100% rate');
  assert.ok(one.lo < one.mean && one.mean < one.hi);
  const data = posterior({ successes: 60, failures: 940 }, 0.04, 20);
  assert.ok(data.hi - data.lo < one.hi - one.lo, 'more data narrows the interval');
});

test('global rate is shrunk toward the default', () => {
  near(globalRate({ successes: 0, failures: 0 }), 0.04, 1e-9);
  assert.ok(globalRate({ successes: 2, failures: 0 }) < 0.15);
});

test('re-contact probability reproduces the README worked example', () => {
  near(recontactProbability(0.04, 0.4, 2, 90, 60), 0.0124, 0.0002);
  near(recontactProbability(0.04, 0.4, 3, 180, 60), 0.0061, 0.0002);
  assert.equal(recontactProbability(0.04, 0.4, 1, null, 60), 0.04);
});

test('learned gamma stays at the prior without re-contact data and moves with evidence', () => {
  const none = learnGamma({ successes: 20, failures: 480 }, { successes: 0, failures: 0 });
  near(none.gamma, 0.4, 1e-9);
  const worse = learnGamma({ successes: 40, failures: 960 }, { successes: 10, failures: 990 });
  assert.ok(worse.gamma > 0.2 && worse.gamma < 0.35, `gamma was ${worse.gamma}`);
  const tiny = learnGamma({ successes: 40, failures: 960 }, { successes: 0, failures: 3 });
  assert.ok(tiny.gamma > 0.35 && tiny.gamma <= 0.4, `three silent re-contacts cannot swing gamma (was ${tiny.gamma})`);
});

const params = (overrides: Partial<SelectionParams> = {}): SelectionParams => ({
  globalRate: 0.04,
  priorStrength: 20,
  gamma: 0.4,
  minP: 0.01,
  maxSequences: 3,
  tauDays: 60,
  explorationShare: 0,
  overrides: {},
  slots: 1,
  ...overrides,
});

const candidate = (id: number, extra: Partial<Candidate> = {}): Candidate => ({
  id, segment: `seg${id}|US`, successes: 0, failures: 0, score: 50, completedSequences: 0, daysSinceLastSend: null, ...extra,
});

test('selection enforces the sequence limit and the minimum re-contact probability', () => {
  const result = selectCandidates([
    candidate(1, { completedSequences: 3, daysSinceLastSend: 400 }),
    candidate(2, { completedSequences: 2, daysSinceLastSend: 180 }),
    candidate(3, { completedSequences: 1, daysSinceLastSend: 90 }),
    candidate(4),
  ], params({ slots: 10 }), mulberry32(1));
  assert.deepEqual(result.rejected.map((row) => [row.id, row.reason]), [[1, 'sequence_limit'], [2, 'below_min_probability']]);
  assert.deepEqual(result.selected.map((row) => row.id).sort(), [3, 4]);
});

test('Thompson sampling shifts allocation toward segments that reply', () => {
  const good = candidate(1, { successes: 40, failures: 160 });
  const bad = candidate(2, { successes: 0, failures: 200 });
  let goodFirst = 0;
  for (let seed = 0; seed < 300; seed++) {
    const { selected } = selectCandidates([bad, good], params(), mulberry32(seed));
    if (selected[0].id === 1) goodFirst++;
  }
  assert.ok(goodFirst > 285, `good segment won ${goodFirst}/300`);
});

test('shrinkage stops one lucky reply from dominating', () => {
  const lucky = candidate(1, { successes: 1, failures: 0 });
  const proven = candidate(2, { successes: 30, failures: 270 });
  let luckyFirst = 0;
  for (let seed = 0; seed < 300; seed++) {
    if (selectCandidates([lucky, proven], params(), mulberry32(seed)).selected[0].id === 1) luckyFirst++;
  }
  // Raw rates would make the lucky segment win every time; shrinkage keeps it well below a coin flip.
  assert.ok(luckyFirst < 150, `lucky segment won ${luckyFirst}/300`);
});

test('exploration share picks a non-top candidate at roughly the configured rate', () => {
  let explored = 0;
  const runs = 3000;
  const rng = mulberry32(99);
  for (let i = 0; i < runs; i++) {
    const { selected } = selectCandidates([1, 2, 3, 4, 5].map((id) => candidate(id)), params({ explorationShare: 0.15 }), rng);
    if (selected[0].mode === 'explore') explored++;
  }
  near(explored / runs, 0.15, 0.03);
});

test('selection never returns duplicates and respects the slot count', () => {
  const { selected } = selectCandidates([1, 2, 3, 4, 5, 6].map((id) => candidate(id)), params({ slots: 3, explorationShare: 0.5 }), mulberry32(5));
  assert.equal(selected.length, 3);
  assert.equal(new Set(selected.map((row) => row.id)).size, 3);
});

test('an owner-approved segment override changes ranking', () => {
  const a = candidate(1, { segment: 'dentist|US' });
  const b = candidate(2, { segment: 'cafe|US' });
  let aFirst = 0;
  for (let seed = 0; seed < 200; seed++) {
    if (selectCandidates([a, b], params({ overrides: { 'dentist|US': 0.25 } }), mulberry32(seed)).selected[0].id === 1) aFirst++;
  }
  assert.ok(aFirst < 40, `reduced segment still won ${aFirst}/200`);
});

test('AUC handles perfect, reversed and tied rankings', () => {
  assert.equal(aucScore([0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9]), 1);
  assert.equal(aucScore([0, 0, 1, 1], [0.9, 0.8, 0.2, 0.1]), 0);
  assert.equal(aucScore([0, 1, 0, 1], [0.5, 0.5, 0.5, 0.5]), 0.5);
  assert.equal(aucScore([1, 1], [0.1, 0.2]), null);
});

function syntheticLeads(count: number, signal: boolean, seed: number) {
  const rng = mulberry32(seed);
  const names = leadFeatureNames();
  const X: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < count; i++) {
    const noBooking = rng() < 0.5;
    const findings = noBooking ? ['no_booking_link', 'missing_meta'] : ['missing_meta'];
    const score = Math.round(30 + rng() * 60);
    X.push(leadFeatures({ score, track: rng() < 0.3 ? 'no_site' : 'site', findings, hasPhone: rng() < 0.4, sequenceNo: 1 }));
    const probability = signal ? (noBooking ? 0.3 : 0.05) : 0.15;
    y.push(rng() < probability ? 1 : 0);
  }
  return { X, y, names };
}

test('lead scorer learns a real signal and refuses to train on too little data', () => {
  const { X, y, names } = syntheticLeads(1500, true, 11);
  const trained = trainScorer(X, y, names);
  assert.ok(trained.model, `expected adoption, got ${trained.metrics.reason}`);
  assert.ok((trained.metrics.holdoutAuc ?? 0) > 0.6);
  const withGap = predictLogistic(trained.model!, leadFeatures({ score: 60, track: 'site', findings: ['no_booking_link', 'missing_meta'], hasPhone: false, sequenceNo: 1 }));
  const withoutGap = predictLogistic(trained.model!, leadFeatures({ score: 60, track: 'site', findings: ['missing_meta'], hasPhone: false, sequenceNo: 1 }));
  assert.ok(withGap > withoutGap * 2, `${withGap} vs ${withoutGap}`);

  const small = syntheticLeads(100, true, 3);
  assert.equal(trainScorer(small.X, small.y, small.names).model, null);
  const fewReplies = syntheticLeads(300, true, 3);
  assert.equal(trainScorer(fewReplies.X, fewReplies.y.map(() => 0), fewReplies.names).model, null);
});

test('lead scorer is not adopted when the data carries no signal', () => {
  const { X, y, names } = syntheticLeads(2000, false, 21);
  const trained = trainScorer(X, y, names);
  assert.equal(trained.model, null, trained.metrics.reason);
});

test('logistic training rejects mismatched input', () => {
  assert.throws(() => trainLogistic([], [], ['a']));
  assert.throws(() => trainLogistic([[1]], [1, 0], ['a']));
});

test('outcomes follow the reward table', () => {
  assert.deepEqual(decideOutcome({ replies: [{ classification: 'complaint', snippet: null }], hardSuppressed: false, windowEnded: false }),
    { outcome: 'hard_negative', success: 0, extraFailures: 2, reward: -5 });
  assert.equal(decideOutcome({ replies: [{ classification: 'bounce', snippet: null }], hardSuppressed: false, windowEnded: false }).reward, -1);
  assert.equal(decideOutcome({ replies: [], hardSuppressed: true, windowEnded: false }).outcome, 'hard_negative');
  const positive = decideOutcome({ replies: [{ classification: 'human', snippet: 'Sounds good, tell me more' }], hardSuppressed: false, windowEnded: false });
  assert.deepEqual([positive.outcome, positive.success, positive.reward], ['reply', 1, 1]);
  const neutral = decideOutcome({ replies: [{ classification: 'human', snippet: 'Who is this?' }], hardSuppressed: false, windowEnded: false });
  assert.deepEqual([neutral.success, neutral.reward], [1, 0.3]);
  const negative = decideOutcome({ replies: [{ classification: 'human', snippet: 'No thanks, not interested' }], hardSuppressed: false, windowEnded: false });
  assert.deepEqual([negative.outcome, negative.success, negative.reward], ['negative_reply', 0, -0.3]);
  assert.equal(decideOutcome({ replies: [{ classification: 'auto_reply', snippet: null }], hardSuppressed: false, windowEnded: false }).outcome, 'pending');
  assert.equal(decideOutcome({ replies: [{ classification: 'auto_reply', snippet: null }], hardSuppressed: false, windowEnded: true }).outcome, 'no_reply');
  assert.equal(decideOutcome({ replies: [], hardSuppressed: false, windowEnded: false }).outcome, 'pending');
  const mixed = decideOutcome({ replies: [{ classification: 'human', snippet: 'No thanks' }, { classification: 'human', snippet: 'Actually, how much?' }], hardSuppressed: false, windowEnded: false });
  assert.equal(mixed.success, 1);
});

test('reply sentiment is rules-based and conservative', () => {
  assert.equal(replySentiment('We are not interested, thanks'), 'negative');
  assert.equal(replySentiment('Yes please send the outline'), 'positive');
  assert.equal(replySentiment('Who is this?'), 'neutral');
  assert.equal(replySentiment(null), 'neutral');
});

test('deal rewards add a call bonus and bounded value weighting', () => {
  assert.equal(dealReward('replied', 0), 0);
  assert.equal(dealReward('conversation', 0), 0);
  assert.equal(dealReward('call', 0), 3);
  assert.equal(dealReward('won', 0), 13);
  assert.equal(dealReward('won', 200_000), 23);
  assert.equal(dealReward('won', 100), 8);
  assert.equal(dealReward('won', 99_999_999), 33);
  assert.equal(dealReward('lost', 5000), 0);
});

test('angles only apply when a matching finding exists', () => {
  assert.deepEqual(applicableAngles(['no_booking_link']), ['booking and conversion']);
  assert.deepEqual(applicableAngles(['no_https', 'missing_meta']), ['trust and accessibility', 'search visibility']);
  assert.deepEqual(applicableAngles(['robots_disallow']), []);
  assert.equal(ANGLES.length, 4);
});

test('subject style and hour band classification', () => {
  assert.equal(subjectStyleOf('Quick question about Acme?'), 'question');
  assert.equal(subjectStyleOf('Acme website note'), 'short');
  assert.equal(subjectStyleOf('A few notes on how Acme appears on phones'), 'plain');
  assert.equal(hourBandOf(new Date('2026-10-14T14:00:00Z'), 'America/Toronto'), 'morning');
  assert.equal(hourBandOf(new Date('2026-10-14T18:30:00Z'), 'America/Toronto'), 'afternoon');
  assert.equal(hourBandOf(new Date('2026-10-14T12:00:00Z'), 'America/Toronto'), 'other');
  assert.equal(hourBandOf(new Date('2026-10-14T10:00:00Z'), 'Not/AZone'), 'morning');
  assert.equal(segmentKey(' Dentist|X ', 'ca'), 'dentist/x|CA');
  assert.equal(segmentKey(null, null), 'unknown|??');
});

test('edit summaries capture what the owner changed', () => {
  const original = {
    subject: 'Quick note about Acme Dental website',
    body: 'Hi,\n\nI love your clinic and noticed the homepage has no meta description. I can fix that for you this week. Would a short outline help?\n\nSam',
  };
  const edited = {
    subject: 'Acme website note',
    body: 'Hi,\n\nThe homepage has no meta description. Would a short outline help?\n\nSam',
  };
  const diff = summarizeEdit(original, edited);
  assert.equal(diff.subjectChanged, true);
  assert.ok(diff.subjectWordsAfter < diff.subjectWordsBefore);
  assert.ok(diff.wordsDelta < 0);
  assert.equal(diff.openingChanged, true);
  assert.equal(diff.closingChanged, false);
  assert.ok(diff.removed.some((sentence) => sentence.includes('love your clinic')));
  assert.ok(diff.editDistance > 5);
  const same = summarizeEdit(original, original);
  assert.equal(same.editDistance, 0);
  assert.equal(same.subjectChanged, false);
  assert.deepEqual(same.removed, []);
  assert.equal(wordEditDistance('a b c', 'a x c'), 1);
  assert.equal(wordEditDistance('', 'a b'), 2);
  assert.deepEqual(splitSentences('One. Two!\nThree'), ['One.', 'Two!', 'Three']);
});

const edit = (overrides: Partial<EditDiff> = {}): EditDiff => ({
  subjectChanged: false, subjectWordsBefore: 6, subjectWordsAfter: 6, wordsBefore: 100, wordsAfter: 100, wordsDelta: 0,
  openingChanged: false, closingChanged: false, removed: [], added: [], editDistance: 0, ...overrides,
});

test('recurring edits become lesson candidates only with enough evidence', () => {
  assert.deepEqual(deriveEditLessons([edit({ wordsDelta: -20 }), edit({ wordsDelta: -20 })]), []);
  const six = Array.from({ length: 6 }, (_, i) => edit({ wordsDelta: -10 - i, openingChanged: i < 4, subjectChanged: true, subjectWordsAfter: 4 }));
  const lessons = deriveEditLessons(six);
  const keys = lessons.map((lesson) => lesson.key);
  assert.ok(keys.includes('edit:shorten'));
  assert.ok(keys.includes('edit:opening'));
  assert.ok(keys.includes('edit:subject-shorter'));
  assert.ok(!keys.includes('edit:closing'));
  assert.ok(lessons.every((lesson) => cleanGuidanceText(lesson.text, 10, 200) !== null));
  assert.deepEqual(deriveEditLessons(Array.from({ length: 6 }, () => edit())), []);
});

test('LLM scrubbing removes contact details and the business name', () => {
  const scrubbed = scrubForLlm('Hi Acme Dental, email me at sam@acme.com or +1 (416) 555-0199, see https://acme.com/x', 'Acme Dental');
  assert.equal(scrubbed, 'Hi [business], email me at [email] or [number], see [link]');
  assert.equal(scrubForLlm('plain text', 'a+b'), 'plain text');
  assert.equal(scrubForLlm('A+B Co sells', 'A+B Co'), '[business] sells');
});

test('guidance text validation blocks links, addresses and control characters', () => {
  assert.equal(cleanGuidanceText('  Keep it   short.  ', 5, 300), 'Keep it short.');
  assert.equal(cleanGuidanceText('See https://example.com', 5, 300), null);
  assert.equal(cleanGuidanceText('Write to me@example.com', 5, 300), null);
  assert.equal(cleanGuidanceText('www.example.com is great', 5, 300), null);
  assert.equal(cleanGuidanceText('abc', 5, 300), null);
  assert.equal(cleanGuidanceText('x'.repeat(301), 5, 300), null);
  assert.equal(cleanGuidanceText('bad\u0007text here', 5, 300), null);
  assert.equal(cleanGuidanceText(42, 1, 10), null);
});

const memory = (id: number, kind: string, text: string, extra: Partial<MemoryItem> = {}): MemoryItem => ({
  id, kind, text, scope: {}, confidence: 1, active: true, expiresAt: null, ...extra,
});

test('memory retrieval respects scope, expiry, priority and the size budget', () => {
  const now = new Date('2026-10-15T00:00:00Z');
  const items = [
    memory(1, 'lesson', 'Lesson global'),
    memory(2, 'instruction', 'Instruction global'),
    memory(3, 'instruction', 'Restaurants: skip SEO', { scope: { niche: 'Restaurant' } }),
    memory(4, 'instruction', 'Canada only', { scope: { country: 'CA' } }),
    memory(5, 'instruction', 'Expired', { expiresAt: new Date('2026-10-01T00:00:00Z') }),
    memory(6, 'instruction', 'Inactive', { active: false }),
    memory(7, 'guardrail', 'game-changer'),
    memory(8, 'guardrail', 'Toronto only phrase', { scope: { niche: 'dentist' } }),
    memory(9, 'lesson', 'Faded lesson', { confidence: 0.1 }),
  ];
  const restaurant = selectMemory(items, { niche: 'restaurant', country: 'US', track: 'site' }, now);
  assert.deepEqual(restaurant.instructions.map((item) => item.id), [3, 2, 1]);
  assert.deepEqual(restaurant.banned, ['game-changer']);
  const dentistCanada = selectMemory(items, { niche: 'dentist', country: 'CA', track: 'site' }, now);
  assert.deepEqual(dentistCanada.instructions.map((item) => item.id), [4, 2, 1]);
  assert.deepEqual(dentistCanada.banned, ['game-changer', 'Toronto only phrase']);
  const tight = selectMemory(items, { niche: 'restaurant', country: 'US', track: 'site' }, now, { maxItems: 1, maxChars: 700 });
  assert.deepEqual(tight.instructions.map((item) => item.id), [3]);
  const tiny = selectMemory(items, { niche: 'restaurant', country: 'US', track: 'site' }, now, { maxItems: 8, maxChars: 20 });
  assert.deepEqual(tiny.instructions.map((item) => item.id), [2]);
});

test('banned phrase check is case-insensitive and lesson decay waits for 45 days', () => {
  assert.equal(containsBannedPhrase('A GAME-CHANGER for you', ['game-changer']), 'game-changer');
  assert.equal(containsBannedPhrase('nothing here', ['game-changer', '']), null);
  assert.equal(decayLesson(0.8, 30), 0.8);
  near(decayLesson(0.8, 60), 0.68, 1e-9);
});

test('segment proposals need real evidence and stay bounded', () => {
  const proposals = deriveSegmentProposals([
    { key: 'cafe|US', successes: 0, failures: 200, n: 200 },
    { key: 'dentist|CA', successes: 30, failures: 70, n: 100 },
    { key: 'florist|US', successes: 0, failures: 10, n: 10 },
    { key: 'gym|US', successes: 8, failures: 192, n: 200 },
  ], 0.04, 20);
  assert.deepEqual(proposals.map((p) => [p.key, p.kind]), [['cafe|US', 'segment_reduce'], ['dentist|CA', 'segment_boost']]);
  assert.equal(deriveSegmentProposals([], 0.04, 20).length, 0);
});

test('credible and Wilson intervals behave', () => {
  assert.deepEqual(wilsonInterval(0, 0), { lo: 0, hi: 1 });
  const interval = wilsonInterval(5, 100);
  assert.ok(interval.lo < 0.05 && interval.hi > 0.05);
  const best = probabilityBest([{ alpha: 30, beta: 70 }, { alpha: 5, beta: 95 }], mulberry32(3));
  assert.ok(best[0] > 0.99);
  const even = probabilityBest([{ alpha: 10, beta: 90 }, { alpha: 10, beta: 90 }], mulberry32(3));
  near(even[0], 0.5, 0.05);
  assert.deepEqual(probabilityBest([], mulberry32(1)), []);
});
