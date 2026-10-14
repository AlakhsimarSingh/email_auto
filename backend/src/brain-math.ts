// Pure learning math for the agent "Brain". No database, no network, no clocks:
// everything is deterministic given an RNG, so it can be unit-tested exhaustively.

export type Rng = () => number;

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/** Small seeded RNG (mulberry32) used for tests and for stable, jitter-free dashboard numbers. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function standardNormal(rng: Rng) {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Marsaglia-Tsang gamma sampler (scale 1). */
export function sampleGamma(shape: number, rng: Rng): number {
  const k = Number.isFinite(shape) && shape > 1e-3 ? shape : 1e-3;
  if (k < 1) {
    let u = 0;
    while (u === 0) u = rng();
    return sampleGamma(k + 1, rng) * Math.pow(u, 1 / k);
  }
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let attempts = 0; attempts < 1000; attempts++) {
    let x: number;
    let v: number;
    do {
      x = standardNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (u > 0 && Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  return d;
}

export function sampleBeta(alpha: number, beta: number, rng: Rng) {
  const x = sampleGamma(alpha, rng);
  const y = sampleGamma(beta, rng);
  return x + y > 0 ? x / (x + y) : 0.5;
}

const LANCZOS = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];

function logGamma(xx: number) {
  let y = xx;
  let tmp = xx + 5.5;
  tmp -= (xx + 0.5) * Math.log(tmp);
  let series = 1.000000000190015;
  for (const coefficient of LANCZOS) {
    y += 1;
    series += coefficient / y;
  }
  return -tmp + Math.log((2.5066282746310005 * series) / xx);
}

function betaContinuedFraction(a: number, b: number, x: number) {
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 3e-12) break;
  }
  return h;
}

/** Regularized incomplete beta function I_x(a, b), i.e. the Beta(a, b) CDF. */
export function betaCdf(x: number, a: number, b: number) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(a, b, x)) / a;
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

export function betaQuantile(p: number, a: number, b: number) {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (betaCdf(mid, a, b) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export type ArmCounts = { successes: number; failures: number; n?: number };
export type Posterior = { alpha: number; beta: number; mean: number; lo: number; hi: number; n: number };

/**
 * Beta posterior for an arm, shrunk toward a prior (usually the global rate).
 * priorStrength is the number of pseudo-observations the prior is worth.
 */
export function posterior(counts: ArmCounts, priorRate: number, priorStrength: number, level = 0.9): Posterior {
  const rate = clamp(priorRate, 0.001, 0.999);
  const strength = Math.max(0.1, priorStrength);
  const alpha = strength * rate + Math.max(0, counts.successes);
  const beta = strength * (1 - rate) + Math.max(0, counts.failures);
  const tail = (1 - level) / 2;
  return {
    alpha,
    beta,
    mean: alpha / (alpha + beta),
    lo: betaQuantile(tail, alpha, beta),
    hi: betaQuantile(1 - tail, alpha, beta),
    n: counts.n ?? Math.round(counts.successes + counts.failures),
  };
}

/** Global reply rate, shrunk toward a default so the first few sends cannot swing it. */
export function globalRate(counts: ArmCounts, defaultRate = 0.04, strength = 20) {
  const total = counts.successes + counts.failures;
  return (counts.successes + strength * defaultRate) / (total + strength);
}

/** Probability that each arm has the highest true rate (Monte Carlo over the posteriors). */
export function probabilityBest(posteriors: Array<{ alpha: number; beta: number }>, rng: Rng, draws = 4000) {
  if (!posteriors.length) return [];
  const wins = new Array<number>(posteriors.length).fill(0);
  for (let i = 0; i < draws; i++) {
    let best = 0;
    let bestValue = -1;
    for (let j = 0; j < posteriors.length; j++) {
      const value = sampleBeta(posteriors[j].alpha, posteriors[j].beta, rng);
      if (value > bestValue) {
        bestValue = value;
        best = j;
      }
    }
    wins[best]++;
  }
  return wins.map((count) => count / draws);
}

/** Wilson score interval (default 90%) for observed rates in analytics tables. */
export function wilsonInterval(successes: number, n: number, z = 1.645) {
  if (n <= 0) return { lo: 0, hi: 1 };
  const p = successes / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

// ---------------------------------------------------------------------------
// Re-contact policy (README section 10)
// ---------------------------------------------------------------------------

/** P(k, dt) = P_seg * gamma^(k-1) * (1 - e^(-dt/tau)); first contacts (k = 1) have no time factor. */
export function recontactFactor(gamma: number, sequenceNo: number, daysSinceLast: number | null, tauDays: number) {
  if (sequenceNo <= 1) return 1;
  const days = Math.max(0, daysSinceLast ?? 0);
  return Math.pow(gamma, sequenceNo - 1) * (1 - Math.exp(-days / Math.max(1, tauDays)));
}

export function recontactProbability(segmentRate: number, gamma: number, sequenceNo: number, daysSinceLast: number | null, tauDays: number) {
  return segmentRate * recontactFactor(gamma, sequenceNo, daysSinceLast, tauDays);
}

/**
 * Learned re-contact penalty: ratio of shrunk reply rates for sequences >= 2 versus sequence 1,
 * blended toward the prior until there is real data on re-contacts.
 */
export function learnGamma(
  sequence1: ArmCounts,
  sequence2Plus: ArmCounts,
  options: { prior?: number; defaultRate?: number; rateStrength?: number; blendScale?: number } = {},
) {
  const prior = options.prior ?? 0.4;
  const defaultRate = options.defaultRate ?? 0.04;
  const strength = options.rateStrength ?? 20;
  const blendScale = options.blendScale ?? 30;
  const overall = globalRate(
    { successes: sequence1.successes + sequence2Plus.successes, failures: sequence1.failures + sequence2Plus.failures },
    defaultRate,
    strength,
  );
  // Hierarchical prior: first contacts shrink toward the overall rate, re-contacts toward overall * prior gamma,
  // so with no re-contact data the ratio equals the prior instead of drifting toward 1.
  const shrink = (counts: ArmCounts, center: number) => (counts.successes + strength * center) / (counts.successes + counts.failures + strength);
  const n2 = sequence2Plus.successes + sequence2Plus.failures;
  const ratio = shrink(sequence2Plus, overall * prior) / shrink(sequence1, overall);
  const weight = n2 / (n2 + blendScale);
  return { gamma: clamp(weight * ratio + (1 - weight) * prior, 0.05, 1), weight, ratio, n2 };
}

// ---------------------------------------------------------------------------
// Candidate ranking: Thompson sampling + shrinkage + exploration share
// ---------------------------------------------------------------------------

export type Candidate = {
  id: number;
  segment: string;
  successes: number;
  failures: number;
  score: number | null;
  leadMultiplier?: number;
  completedSequences: number;
  daysSinceLastSend: number | null;
};

export type SelectionParams = {
  globalRate: number;
  priorStrength: number;
  gamma: number;
  minP: number;
  maxSequences: number;
  tauDays: number;
  explorationShare: number;
  overrides: Record<string, number>;
  slots: number;
};

export type SelectedCandidate = {
  id: number;
  mode: 'exploit' | 'explore';
  segment: string;
  theta: number;
  segmentMean: number;
  multiplier: number;
  gamma: number;
  sequenceNo: number;
  recontact: number;
  override: number;
  ev: number;
};

export type RejectedCandidate = {
  id: number;
  reason: 'sequence_limit' | 'below_min_probability';
  sequenceNo: number;
  probability: number;
};

export function scoreMultiplier(score: number | null) {
  return 0.5 + clamp(score ?? 40, 0, 100) / 100;
}

export function selectCandidates(candidates: Candidate[], params: SelectionParams, rng: Rng) {
  const eligible: SelectedCandidate[] = [];
  const rejected: RejectedCandidate[] = [];
  for (const candidate of candidates) {
    const sequenceNo = candidate.completedSequences + 1;
    const dist = posterior(candidate, params.globalRate, params.priorStrength);
    const factor = recontactFactor(params.gamma, sequenceNo, candidate.daysSinceLastSend, params.tauDays);
    if (sequenceNo >= 2) {
      if (sequenceNo > params.maxSequences) {
        rejected.push({ id: candidate.id, reason: 'sequence_limit', sequenceNo, probability: dist.mean * factor });
        continue;
      }
      if (dist.mean * factor < params.minP) {
        rejected.push({ id: candidate.id, reason: 'below_min_probability', sequenceNo, probability: dist.mean * factor });
        continue;
      }
    }
    const multiplier = candidate.leadMultiplier ?? scoreMultiplier(candidate.score);
    const override = clamp(params.overrides[candidate.segment] ?? 1, 0.25, 2);
    const theta = sampleBeta(dist.alpha, dist.beta, rng);
    eligible.push({
      id: candidate.id,
      mode: 'exploit',
      segment: candidate.segment,
      theta,
      segmentMean: dist.mean,
      multiplier,
      gamma: params.gamma,
      sequenceNo,
      recontact: factor,
      override,
      ev: theta * multiplier * factor * override,
    });
  }
  eligible.sort((a, b) => b.ev - a.ev || a.id - b.id);
  const selected: SelectedCandidate[] = [];
  const remaining = [...eligible];
  const share = clamp(params.explorationShare, 0, 1);
  while (selected.length < params.slots && remaining.length) {
    let index = 0;
    let mode: 'exploit' | 'explore' = 'exploit';
    if (remaining.length > 1 && rng() < share) {
      index = 1 + Math.floor(rng() * (remaining.length - 1));
      mode = 'explore';
    }
    const [picked] = remaining.splice(index, 1);
    selected.push({ ...picked, mode });
  }
  return { selected, rejected };
}

// ---------------------------------------------------------------------------
// Lead scorer: small L2-regularized logistic regression
// ---------------------------------------------------------------------------

export const SCORER_FINDINGS = [
  'no_https', 'not_mobile_friendly', 'missing_meta', 'old_copyright', 'no_booking_link', 'slow_lcp',
  'mobile_performance', 'accessibility', 'seo', 'no_website_listing', 'social_only', 'phone_no_booking',
] as const;

export function leadFeatureNames() {
  return ['score', 'no_site', 'finding_count', 'has_phone', 'recontact', ...SCORER_FINDINGS];
}

export function leadFeatures(input: { score: number | null; track: string; findings: string[]; hasPhone: boolean; sequenceNo: number }) {
  const found = new Set(input.findings);
  return [
    clamp(input.score ?? 40, 0, 100) / 100,
    input.track === 'no_site' ? 1 : 0,
    Math.min(input.findings.length, 12) / 12,
    input.hasPhone ? 1 : 0,
    input.sequenceNo > 1 ? 1 : 0,
    ...SCORER_FINDINGS.map((id) => (found.has(id) ? 1 : 0)),
  ];
}

export type LogisticModel = {
  names: string[];
  means: number[];
  scales: number[];
  weights: number[];
  bias: number;
  baseRate: number;
};

const sigmoid = (z: number) => 1 / (1 + Math.exp(-clamp(z, -30, 30)));

export function predictLogistic(model: LogisticModel, features: number[]) {
  let z = model.bias;
  for (let j = 0; j < model.weights.length; j++) {
    z += model.weights[j] * (((features[j] ?? 0) - model.means[j]) / model.scales[j]);
  }
  return sigmoid(z);
}

export function trainLogistic(
  X: number[][],
  y: number[],
  names: string[],
  options: { l2?: number; epochs?: number; learningRate?: number } = {},
): LogisticModel {
  const n = X.length;
  const d = names.length;
  if (!n || n !== y.length) throw new Error('Training data is empty or mismatched');
  const l2 = options.l2 ?? 0.05;
  const epochs = options.epochs ?? 400;
  const lr = options.learningRate ?? 0.5;
  const means = new Array<number>(d).fill(0);
  const scales = new Array<number>(d).fill(1);
  for (let j = 0; j < d; j++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += X[i][j];
    means[j] = sum / n;
    let variance = 0;
    for (let i = 0; i < n; i++) variance += (X[i][j] - means[j]) ** 2;
    const std = Math.sqrt(variance / n);
    scales[j] = std > 1e-9 ? std : 1;
  }
  const Z = X.map((row) => row.map((value, j) => (value - means[j]) / scales[j]));
  const prevalence = clamp(y.reduce((sum, value) => sum + value, 0) / n, 0.005, 0.995);
  let bias = Math.log(prevalence / (1 - prevalence));
  const weights = new Array<number>(d).fill(0);
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradient = new Array<number>(d).fill(0);
    let biasGradient = 0;
    for (let i = 0; i < n; i++) {
      let z = bias;
      for (let j = 0; j < d; j++) z += weights[j] * Z[i][j];
      const error = sigmoid(z) - y[i];
      biasGradient += error;
      for (let j = 0; j < d; j++) gradient[j] += error * Z[i][j];
    }
    bias -= (lr * biasGradient) / n;
    for (let j = 0; j < d; j++) weights[j] -= lr * (gradient[j] / n + l2 * weights[j]);
  }
  return { names, means, scales, weights, bias, baseRate: prevalence };
}

/** Rank-based AUC (Mann-Whitney, ties averaged). Returns null if one class is missing. */
export function aucScore(y: number[], p: number[]) {
  const positives = y.filter((value) => value === 1).length;
  const negatives = y.length - positives;
  if (!positives || !negatives) return null;
  const order = y.map((_, i) => i).sort((a, b) => p[a] - p[b]);
  const ranks = new Array<number>(y.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && p[order[j + 1]] === p[order[i]]) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[order[k]] = rank;
    i = j + 1;
  }
  let positiveRankSum = 0;
  for (let k = 0; k < y.length; k++) if (y[k] === 1) positiveRankSum += ranks[k];
  return (positiveRankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

export const SCORER_MIN_LABELED = 150;
export const SCORER_MIN_POSITIVES = 10;
export const SCORER_MIN_HOLDOUT_AUC = 0.55;

/** Trains with a deterministic 20% holdout; only returns a model that beats chance on the holdout. */
export function trainScorer(X: number[][], y: number[], names: string[]) {
  const n = X.length;
  const positives = y.reduce((sum, value) => sum + value, 0);
  const base = { n, positives, holdoutN: 0, holdoutAuc: null as number | null, adopted: false, reason: '' };
  if (n < SCORER_MIN_LABELED) return { model: null, metrics: { ...base, reason: `needs at least ${SCORER_MIN_LABELED} labeled sends` } };
  if (positives < SCORER_MIN_POSITIVES) return { model: null, metrics: { ...base, reason: `needs at least ${SCORER_MIN_POSITIVES} replies` } };
  const trainX: number[][] = [];
  const trainY: number[] = [];
  const holdX: number[][] = [];
  const holdY: number[] = [];
  X.forEach((row, index) => {
    if (index % 5 === 0) {
      holdX.push(row);
      holdY.push(y[index]);
    } else {
      trainX.push(row);
      trainY.push(y[index]);
    }
  });
  const trial = trainLogistic(trainX, trainY, names);
  const holdoutAuc = aucScore(holdY, holdX.map((row) => predictLogistic(trial, row)));
  const metrics = { ...base, holdoutN: holdY.length, holdoutAuc };
  if (holdoutAuc === null) return { model: null, metrics: { ...metrics, reason: 'holdout set lacks both outcomes' } };
  if (holdoutAuc < SCORER_MIN_HOLDOUT_AUC) {
    return { model: null, metrics: { ...metrics, reason: `holdout AUC ${holdoutAuc.toFixed(2)} is not better than chance` } };
  }
  return { model: trainLogistic(X, y, names), metrics: { ...metrics, adopted: true, reason: 'adopted' } };
}

export function leadMultiplierFromModel(model: LogisticModel, features: number[]) {
  return clamp(predictLogistic(model, features) / Math.max(0.005, model.baseRate), 0.4, 2.5);
}

// ---------------------------------------------------------------------------
// Outcomes and rewards (README section 12.2)
// ---------------------------------------------------------------------------

export type ReplySentiment = 'positive' | 'neutral' | 'negative';

export function replySentiment(snippet: string | null | undefined): ReplySentiment {
  const text = (snippet ?? '').toLowerCase();
  if (/\b(not interested|no thanks|no thank you|not looking|not at this time|not right now|we('| a)re good|already have|don'?t need|no need)\b/.test(text)) return 'negative';
  if (/\b(interested|sounds good|let'?s (talk|chat|connect)|tell me more|send (me )?(the |a |an )?(outline|details|info|proposal|quote)|how much|pricing|quote|call me|happy to (chat|talk)|yes\b)/.test(text)) return 'positive';
  return 'neutral';
}

export type OutcomeInput = {
  replies: Array<{ classification: string; snippet: string | null }>;
  hardSuppressed: boolean;
  windowEnded: boolean;
};

export type Outcome = {
  outcome: 'reply' | 'negative_reply' | 'hard_negative' | 'no_reply' | 'pending';
  success: 0 | 1;
  extraFailures: number;
  reward: number;
};

export function decideOutcome(input: OutcomeInput): Outcome {
  const hard = input.replies.filter((reply) => ['unsubscribe', 'complaint', 'bounce'].includes(reply.classification));
  if (hard.length || input.hardSuppressed) {
    const complaint = hard.some((reply) => reply.classification === 'complaint');
    return { outcome: 'hard_negative', success: 0, extraFailures: complaint ? 2 : 0.5, reward: complaint ? -5 : -1 };
  }
  const humans = input.replies.filter((reply) => reply.classification === 'human');
  if (humans.length) {
    const sentiments = humans.map((reply) => replySentiment(reply.snippet));
    if (sentiments.some((value) => value !== 'negative')) {
      return { outcome: 'reply', success: 1, extraFailures: 0, reward: sentiments.includes('positive') ? 1 : 0.3 };
    }
    return { outcome: 'negative_reply', success: 0, extraFailures: 0, reward: -0.3 };
  }
  if (input.windowEnded) return { outcome: 'no_reply', success: 0, extraFailures: 0, reward: 0 };
  return { outcome: 'pending', success: 0, extraFailures: 0, reward: 0 };
}

/** Downstream reward for a deal: +3 once a call happened, +10 on won (value-weighted, bounded 0.5x to 3x). */
export function dealReward(stage: string, valueCents: number) {
  let reward = ['call', 'proposal', 'won'].includes(stage) ? 3 : 0;
  if (stage === 'won') {
    const amount = valueCents / 100;
    reward += amount > 0 ? 10 * clamp(amount / 1000, 0.5, 3) : 10;
  }
  return reward;
}

// ---------------------------------------------------------------------------
// Arm keys, angles, styles, time bands
// ---------------------------------------------------------------------------

export function segmentKey(niche: string | null | undefined, country: string | null | undefined) {
  const cleanNiche = (niche ?? '').trim().toLowerCase().replace(/\|/g, '/').slice(0, 60) || 'unknown';
  const cleanCountry = (country ?? '').trim().toUpperCase().slice(0, 2) || '??';
  return `${cleanNiche}|${cleanCountry}`;
}

export const ANGLES = ['mobile usability', 'trust and accessibility', 'booking and conversion', 'search visibility'] as const;

export const ANGLE_FINDINGS: Record<string, string[]> = {
  'mobile usability': ['not_mobile_friendly', 'mobile_performance', 'slow_lcp'],
  'trust and accessibility': ['no_https', 'accessibility', 'old_copyright'],
  'booking and conversion': ['no_booking_link', 'phone_no_booking', 'no_website_listing', 'social_only'],
  'search visibility': ['missing_meta', 'seo'],
};

export function applicableAngles(findings: string[]) {
  const found = new Set(findings);
  return ANGLES.filter((angle) => ANGLE_FINDINGS[angle].some((id) => found.has(id)));
}

export const SUBJECT_STYLES = ['question', 'short', 'plain'] as const;
export type SubjectStyle = (typeof SUBJECT_STYLES)[number];

export const STYLE_HINTS: Record<SubjectStyle, string> = {
  question: 'Write the subject as a short, specific question that ends with a question mark.',
  short: 'Write a subject of at most five words, with no question mark.',
  plain: 'Write the subject as a plain statement of six to ten words, with no question mark.',
};

export function subjectStyleOf(subject: string | null | undefined): SubjectStyle {
  const text = (subject ?? '').trim();
  if (text.endsWith('?')) return 'question';
  if (text.split(/\s+/).filter(Boolean).length <= 5) return 'short';
  return 'plain';
}

export type HourBand = 'morning' | 'afternoon' | 'other';

export function hourBandOf(date: Date, timeZone: string | null | undefined): HourBand {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: timeZone || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  }
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  const local = hour + minute / 60;
  if (local >= 9.5 && local < 11.5) return 'morning';
  if (local >= 14 && local < 16) return 'afternoon';
  return 'other';
}

// ---------------------------------------------------------------------------
// Edit diffs (what the owner changes in a draft)
// ---------------------------------------------------------------------------

export type EditDiff = {
  subjectChanged: boolean;
  subjectWordsBefore: number;
  subjectWordsAfter: number;
  wordsBefore: number;
  wordsAfter: number;
  wordsDelta: number;
  openingChanged: boolean;
  closingChanged: boolean;
  removed: string[];
  added: string[];
  editDistance: number;
};

export function tokenizeWords(text: string) {
  return text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
}

export function wordEditDistance(a: string, b: string) {
  const left = tokenizeWords(a).slice(0, 3000);
  const right = tokenizeWords(b).slice(0, 3000);
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, j) => j);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[right.length];
}

export function splitSentences(text: string) {
  return text.split(/(?<=[.!?])\s+|\n+/).map((part) => part.trim()).filter(Boolean);
}

const normalizeSentence = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?,;:\s]+$/g, '').trim();

function leadSentence(sentences: string[], fromEnd: boolean) {
  const ordered = fromEnd ? [...sentences].reverse() : sentences;
  return ordered.find((sentence) => tokenizeWords(sentence).length >= 4) ?? '';
}

export function summarizeEdit(original: { subject: string; body: string }, final: { subject: string; body: string }): EditDiff {
  const beforeSentences = splitSentences(original.body);
  const afterSentences = splitSentences(final.body);
  const beforeSet = new Set(beforeSentences.map(normalizeSentence));
  const afterSet = new Set(afterSentences.map(normalizeSentence));
  const clip = (value: string) => value.slice(0, 160);
  const wordsBefore = tokenizeWords(original.body).length;
  const wordsAfter = tokenizeWords(final.body).length;
  return {
    subjectChanged: normalizeSentence(original.subject) !== normalizeSentence(final.subject),
    subjectWordsBefore: tokenizeWords(original.subject).length,
    subjectWordsAfter: tokenizeWords(final.subject).length,
    wordsBefore,
    wordsAfter,
    wordsDelta: wordsAfter - wordsBefore,
    openingChanged: normalizeSentence(leadSentence(beforeSentences, false)) !== normalizeSentence(leadSentence(afterSentences, false)),
    closingChanged: normalizeSentence(leadSentence(beforeSentences, true)) !== normalizeSentence(leadSentence(afterSentences, true)),
    removed: beforeSentences.filter((sentence) => !afterSet.has(normalizeSentence(sentence))).slice(0, 6).map(clip),
    added: afterSentences.filter((sentence) => !beforeSet.has(normalizeSentence(sentence))).slice(0, 6).map(clip),
    editDistance: wordEditDistance(`${original.subject}\n${original.body}`, `${final.subject}\n${final.body}`),
  };
}

export type EditLesson = { key: string; text: string; evidence: number; rationale: string };

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** Deterministic lesson candidates from recurring edit patterns (no LLM needed). */
export function deriveEditLessons(edits: EditDiff[], minSample = 5): EditLesson[] {
  if (edits.length < minSample) return [];
  const lessons: EditLesson[] = [];
  const total = edits.length;
  const shortened = edits.filter((edit) => edit.wordsDelta <= -8);
  if (shortened.length / total >= 0.6) {
    const typical = Math.round(median(shortened.map((edit) => -edit.wordsDelta)));
    lessons.push({
      key: 'edit:shorten',
      text: `Keep drafts concise: the owner usually trims them by about ${typical} words.`,
      evidence: shortened.length,
      rationale: `${shortened.length} of the last ${total} edited drafts were shortened by 8 or more words.`,
    });
  }
  const lengthened = edits.filter((edit) => edit.wordsDelta >= 8);
  if (lengthened.length / total >= 0.6) {
    lessons.push({
      key: 'edit:lengthen',
      text: 'Add a little more concrete detail: the owner usually expands drafts.',
      evidence: lengthened.length,
      rationale: `${lengthened.length} of the last ${total} edited drafts were lengthened by 8 or more words.`,
    });
  }
  const opening = edits.filter((edit) => edit.openingChanged);
  if (opening.length / total >= 0.5) {
    lessons.push({
      key: 'edit:opening',
      text: 'Open plainly with the single specific observation: the owner usually rewrites the opening sentence.',
      evidence: opening.length,
      rationale: `The opening sentence was rewritten in ${opening.length} of ${total} edited drafts.`,
    });
  }
  const closing = edits.filter((edit) => edit.closingChanged);
  if (closing.length / total >= 0.5) {
    lessons.push({
      key: 'edit:closing',
      text: 'Keep the closing question short and low-pressure: the owner usually rewrites the last sentence.',
      evidence: closing.length,
      rationale: `The closing sentence was rewritten in ${closing.length} of ${total} edited drafts.`,
    });
  }
  const subjectEdits = edits.filter((edit) => edit.subjectChanged);
  if (subjectEdits.length / total >= 0.5) {
    const meanDelta = subjectEdits.reduce((sum, edit) => sum + (edit.subjectWordsAfter - edit.subjectWordsBefore), 0) / subjectEdits.length;
    if (meanDelta <= -1) {
      lessons.push({
        key: 'edit:subject-shorter',
        text: 'Prefer shorter subject lines.',
        evidence: subjectEdits.length,
        rationale: `Subjects were changed in ${subjectEdits.length} of ${total} edits, on average by ${meanDelta.toFixed(1)} words.`,
      });
    } else if (meanDelta >= 1) {
      lessons.push({
        key: 'edit:subject-longer',
        text: 'Prefer slightly more descriptive subject lines.',
        evidence: subjectEdits.length,
        rationale: `Subjects were changed in ${subjectEdits.length} of ${total} edits, on average by +${meanDelta.toFixed(1)} words.`,
      });
    }
  }
  return lessons;
}

// ---------------------------------------------------------------------------
// Text safety for anything that reaches a prompt
// ---------------------------------------------------------------------------

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Removes contact details and the business name before text is shown to an LLM. */
export function scrubForLlm(text: string, businessName?: string | null) {
  let result = text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/https?:\/\/\S+/gi, '[link]')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[number]');
  const name = businessName?.trim();
  if (name && name.length >= 3) result = result.replace(new RegExp(escapeRegExp(name), 'gi'), '[business]');
  return result;
}

/** Validates owner- or model-written guidance. Returns cleaned text or null. */
export function cleanGuidanceText(value: unknown, minLength: number, maxLength: number) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length < minLength || text.length > maxLength) return null;
  if (/[\u0000-\u001f\u007f]/.test(text)) return null;
  if (/https?:\/\/|www\.|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) return null;
  return text;
}

// ---------------------------------------------------------------------------
// Memory retrieval and decay
// ---------------------------------------------------------------------------

export type MemoryItem = {
  id: number;
  kind: string;
  scope: unknown;
  text: string;
  confidence: number;
  active: boolean;
  expiresAt: Date | null;
};

export type MemoryContext = { niche: string | null; country: string | null; track: string | null };

function scopeMatches(scope: unknown, context: MemoryContext) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return { matches: true, specificity: 0 };
  const value = scope as Record<string, unknown>;
  let specificity = 0;
  if (typeof value.niche === 'string' && value.niche.trim()) {
    if (value.niche.trim().toLowerCase() !== (context.niche ?? '').trim().toLowerCase()) return { matches: false, specificity };
    specificity++;
  }
  if (typeof value.country === 'string' && value.country.trim()) {
    if (value.country.trim().toUpperCase() !== (context.country ?? '').trim().toUpperCase()) return { matches: false, specificity };
    specificity++;
  }
  if (typeof value.track === 'string' && value.track.trim()) {
    if (value.track.trim() !== (context.track ?? '')) return { matches: false, specificity };
    specificity++;
  }
  return { matches: true, specificity };
}

const MEMORY_PRIORITY: Record<string, number> = { instruction: 0, preference: 1, lesson: 2 };

export function selectMemory(items: MemoryItem[], context: MemoryContext, now: Date, limits = { maxItems: 8, maxChars: 700 }) {
  const live = items.filter((item) => item.active && (!item.expiresAt || item.expiresAt > now) && item.confidence >= 0.25);
  const matched = live.flatMap((item) => {
    const result = scopeMatches(item.scope, context);
    return result.matches ? [{ item, specificity: result.specificity }] : [];
  });
  const banned = matched
    .filter(({ item }) => item.kind === 'guardrail')
    .map(({ item }) => item.text.trim())
    .filter(Boolean)
    .slice(0, 50);
  const guidance = matched
    .filter(({ item }) => item.kind !== 'guardrail')
    .sort((a, b) =>
      (MEMORY_PRIORITY[a.item.kind] ?? 3) - (MEMORY_PRIORITY[b.item.kind] ?? 3) ||
      b.specificity - a.specificity ||
      b.item.confidence - a.item.confidence ||
      a.item.id - b.item.id);
  const instructions: Array<{ id: number; text: string }> = [];
  let chars = 0;
  for (const { item } of guidance) {
    if (instructions.length >= limits.maxItems) break;
    if (chars + item.text.length > limits.maxChars) continue;
    instructions.push({ id: item.id, text: item.text });
    chars += item.text.length;
  }
  return { instructions, banned };
}

export function containsBannedPhrase(text: string, banned: string[]) {
  const haystack = text.toLowerCase();
  return banned.find((phrase) => phrase.trim() && haystack.includes(phrase.trim().toLowerCase())) ?? null;
}

/** Lessons that are not reinforced for 45+ days lose 15% confidence per weekly pass. */
export function decayLesson(confidence: number, daysSinceReinforced: number) {
  return daysSinceReinforced <= 45 ? confidence : confidence * 0.85;
}

// ---------------------------------------------------------------------------
// Strategy proposals (never applied without owner approval)
// ---------------------------------------------------------------------------

export type SegmentStat = { key: string; successes: number; failures: number; n: number };
export type SegmentProposal = { kind: 'segment_boost' | 'segment_reduce'; key: string; multiplier: number; mean: number; lo: number; hi: number; n: number };

export function deriveSegmentProposals(segments: SegmentStat[], baseline: number, priorStrength: number, minN = 30, maxProposals = 3): SegmentProposal[] {
  const proposals: SegmentProposal[] = [];
  for (const segment of segments) {
    if (segment.n < minN) continue;
    const dist = posterior(segment, baseline, priorStrength);
    if (dist.hi < baseline * 0.5) proposals.push({ kind: 'segment_reduce', key: segment.key, multiplier: 0.5, mean: dist.mean, lo: dist.lo, hi: dist.hi, n: segment.n });
    else if (dist.lo > baseline * 1.5) proposals.push({ kind: 'segment_boost', key: segment.key, multiplier: 1.5, mean: dist.mean, lo: dist.lo, hi: dist.hi, n: segment.n });
  }
  return proposals.sort((a, b) => b.n - a.n).slice(0, maxProposals);
}
