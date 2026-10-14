import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { env } from './env.js';
import { prisma } from './db.js';
import { dispatchNotification } from './notifications.js';
import { pruneUsage } from './usage-meter.js';
import {
  ANGLES, applicableAngles, clamp, cleanGuidanceText, decideOutcome, dealReward, deriveEditLessons, deriveSegmentProposals,
  globalRate, hourBandOf, leadFeatureNames, leadFeatures, leadMultiplierFromModel, learnGamma, mulberry32,
  posterior, probabilityBest, replySentiment, sampleBeta, scrubForLlm, segmentKey, selectCandidates, selectMemory,
  SUBJECT_STYLES, subjectStyleOf, summarizeEdit, trainScorer, decayLesson, recontactProbability,
  type EditDiff, type LogisticModel, type MemoryContext, type SubjectStyle,
} from './brain-math.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SETTINGS_KEY = 'brain_settings';
const OVERRIDES_KEY = 'brain_overrides';
const PRIOR_RATE = 0.04;
const GLOBAL_STRENGTH = 20;
const SEGMENT_STRENGTH = 15;
const GAMMA_PRIOR = 0.4;
const HARD_SUPPRESSION_REASONS = ['one_click_unsubscribe', 'reply_unsubscribe', 'complaint', 'hard_bounce'];
const REVIEWED_STATUSES = ['held', 'approved', 'sending', 'sent'];

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function logInfo(event: string, details: Record<string, unknown> = {}) {
  console.info(JSON.stringify({ level: 'info', event, ...details }));
}

function logError(event: string, error: unknown, details: Record<string, unknown> = {}) {
  console.error(JSON.stringify({ level: 'error', event, message: errorMessage(error), ...details }));
}

function envNumber(name: string, fallback: number, min: number, max: number) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

/** Compliance-style policy: configured by the owner in the environment, never changed by the agent. */
export function recontactPolicy() {
  return {
    minP: envNumber('RECONTACT_MIN_P', 0.01, 0.0001, 0.5),
    maxSequences: Math.round(envNumber('RECONTACT_MAX_SEQUENCES', 3, 1, 10)),
    tauDays: envNumber('RECONTACT_FORGET_DAYS', 60, 1, 730),
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type BrainSettings = {
  frozen: boolean;
  learningRate: number;
  explorationShare: number;
  attributionDays: number;
  autonomy: 'L0' | 'L1';
};

export const DEFAULT_BRAIN_SETTINGS: BrainSettings = {
  frozen: false,
  learningRate: 1,
  explorationShare: 0.15,
  attributionDays: 14,
  autonomy: 'L0',
};

export function normalizeBrainSettings(value: unknown): BrainSettings {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const number = (key: string, fallback: number, min: number, max: number) => {
    const candidate = source[key];
    return typeof candidate === 'number' && Number.isFinite(candidate) ? clamp(candidate, min, max) : fallback;
  };
  return {
    frozen: source.frozen === true,
    learningRate: number('learningRate', DEFAULT_BRAIN_SETTINGS.learningRate, 0.25, 2),
    explorationShare: number('explorationShare', DEFAULT_BRAIN_SETTINGS.explorationShare, 0.15, 0.5),
    attributionDays: Math.round(number('attributionDays', DEFAULT_BRAIN_SETTINGS.attributionDays, 7, 30)),
    autonomy: source.autonomy === 'L1' ? 'L1' : 'L0',
  };
}

export async function getBrainSettings() {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY }, select: { value: true } });
  return normalizeBrainSettings(row?.value);
}

export async function saveBrainSettings(patch: Partial<BrainSettings>) {
  const next = normalizeBrainSettings({ ...(await getBrainSettings()), ...patch });
  await prisma.appSetting.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, value: next },
    update: { value: next },
  });
  return next;
}

export async function getOverrides(): Promise<Record<string, number>> {
  const row = await prisma.appSetting.findUnique({ where: { key: OVERRIDES_KEY }, select: { value: true } });
  const value = row?.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, multiplier]) =>
    typeof multiplier === 'number' && Number.isFinite(multiplier) ? [[key, clamp(multiplier, 0.25, 2)] as const] : []));
}

async function dueToRun(key: string, minimumMs: number, now: Date) {
  const row = await prisma.appSetting.findUnique({ where: { key }, select: { value: true } });
  const last = typeof row?.value === 'string' ? Date.parse(row.value) : NaN;
  return !(Number.isFinite(last) && now.getTime() - last < minimumMs);
}

async function markRun(key: string, now: Date) {
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value: now.toISOString() },
    update: { value: now.toISOString() },
  });
}

// ---------------------------------------------------------------------------
// Learned parameters
// ---------------------------------------------------------------------------

async function latestModel(kind: string) {
  return prisma.agentModel.findFirst({ where: { kind }, orderBy: { version: 'desc' } });
}

async function saveModel(kind: string, params: Prisma.InputJsonValue, trainedOn: number, metrics?: Prisma.InputJsonValue) {
  const previous = await latestModel(kind);
  return prisma.agentModel.create({
    data: { kind, version: (previous?.version ?? 0) + 1, params, trainedOn, ...(metrics ? { metrics } : {}) },
  });
}

export async function currentGamma() {
  const model = await latestModel('gamma');
  const params = model?.params;
  const value = params && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>).gamma : null;
  if (typeof value === 'number' && Number.isFinite(value)) return { gamma: clamp(value, 0.05, 1), source: 'learned' as const, trainedOn: model!.trainedOn };
  return { gamma: GAMMA_PRIOR, source: 'prior' as const, trainedOn: 0 };
}

function parseScorer(params: unknown): LogisticModel | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const value = params as Record<string, unknown>;
  const names = leadFeatureNames();
  const numbers = (candidate: unknown) => Array.isArray(candidate) && candidate.length === names.length && candidate.every((item) => typeof item === 'number' && Number.isFinite(item));
  if (!Array.isArray(value.names) || value.names.join('|') !== names.join('|') ||
      !numbers(value.means) || !numbers(value.scales) || !numbers(value.weights) ||
      typeof value.bias !== 'number' || typeof value.baseRate !== 'number') return null;
  return {
    names, means: value.means as number[], scales: value.scales as number[], weights: value.weights as number[],
    bias: value.bias, baseRate: value.baseRate,
  };
}

export async function currentScorer() {
  const model = await latestModel('lead_scorer');
  const parsed = model ? parseScorer(model.params) : null;
  return parsed && model ? { model: parsed, version: model.version, trainedOn: model.trainedOn, createdAt: model.createdAt } : null;
}

async function currentGlobalRate() {
  const arm = await prisma.agentArm.findUnique({ where: { dimension_key: { dimension: 'global', key: 'all' } } });
  return globalRate({ successes: arm?.successes ?? 0, failures: arm?.failures ?? 0 }, PRIOR_RATE, GLOBAL_STRENGTH);
}

// ---------------------------------------------------------------------------
// Selection (allocation bandit + re-contact policy)
// ---------------------------------------------------------------------------

export type PoolBusiness = {
  id: number;
  niche: string | null;
  country: string | null;
  track: string;
  score: number | null;
  findings: Prisma.JsonValue | null;
  phone: string | null;
};

export type SelectionInfo = {
  mode: 'exploit' | 'explore';
  segment: string;
  theta: number;
  segmentMean: number;
  multiplier: number;
  multiplierSource: 'scorer' | 'score';
  gamma: number;
  sequenceNo: number;
  ev: number;
  override: number;
  angle?: string;
  subjectStyle?: string;
  memoryIds?: number[];
  selectedAt: string;
};

function asStringArray(value: Prisma.JsonValue | null | undefined) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export async function chooseCandidates<T extends PoolBusiness>(businesses: T[], slots: number) {
  if (!businesses.length || slots < 1) return [];
  const ids = businesses.map((business) => business.id);
  const now = new Date();
  const [settings, overrides, gammaState, scorer, baseline, ledgerRows, sequenceRows] = await Promise.all([
    getBrainSettings(),
    getOverrides(),
    currentGamma(),
    currentScorer(),
    currentGlobalRate(),
    prisma.contactLedger.findMany({ where: { businessId: { in: ids } }, select: { businessId: true, lastContactAt: true } }),
    prisma.email.groupBy({
      by: ['businessId'],
      where: { businessId: { in: ids }, status: 'sent', sequenceStep: 0, gmailMessageId: { not: 'dry-run' } },
      _count: { _all: true },
    }),
  ]);
  const segments = businesses.map((business) => segmentKey(business.niche, business.country));
  const arms = await prisma.agentArm.findMany({ where: { dimension: 'niche_region', key: { in: [...new Set(segments)] } } });
  const armByKey = new Map(arms.map((arm) => [arm.key, arm]));
  const lastContact = new Map<number, Date>();
  for (const row of ledgerRows) {
    if (row.businessId !== null && row.lastContactAt && (!lastContact.get(row.businessId) || row.lastContactAt > lastContact.get(row.businessId)!)) {
      lastContact.set(row.businessId, row.lastContactAt);
    }
  }
  const completed = new Map(sequenceRows.flatMap((row) => row.businessId === null ? [] : [[row.businessId, row._count._all] as const]));
  const policy = recontactPolicy();
  const byId = new Map(businesses.map((business) => [business.id, business]));
  const result = selectCandidates(
    businesses.map((business, index) => {
      const arm = armByKey.get(segments[index]);
      const completedSequences = completed.get(business.id) ?? 0;
      const last = lastContact.get(business.id);
      return {
        id: business.id,
        segment: segments[index],
        successes: arm?.successes ?? 0,
        failures: arm?.failures ?? 0,
        score: business.score,
        leadMultiplier: scorer
          ? leadMultiplierFromModel(scorer.model, leadFeatures({
            score: business.score, track: business.track, findings: asStringArray(business.findings),
            hasPhone: Boolean(business.phone), sequenceNo: completedSequences + 1,
          }))
          : undefined,
        completedSequences,
        daysSinceLastSend: last ? (now.getTime() - last.getTime()) / DAY_MS : null,
      };
    }),
    {
      globalRate: baseline,
      priorStrength: SEGMENT_STRENGTH,
      gamma: gammaState.gamma,
      minP: policy.minP,
      maxSequences: policy.maxSequences,
      tauDays: policy.tauDays,
      explorationShare: settings.explorationShare,
      overrides,
      slots,
    },
    Math.random,
  );
  await applyRecontactRejections(result.rejected, now);
  return result.selected.map((pick) => {
    const info: SelectionInfo = {
      mode: pick.mode,
      segment: pick.segment,
      theta: Number(pick.theta.toFixed(5)),
      segmentMean: Number(pick.segmentMean.toFixed(5)),
      multiplier: Number(pick.multiplier.toFixed(4)),
      multiplierSource: scorer ? 'scorer' : 'score',
      gamma: pick.gamma,
      sequenceNo: pick.sequenceNo,
      ev: Number(pick.ev.toFixed(6)),
      override: pick.override,
      selectedAt: now.toISOString(),
    };
    return { business: byId.get(pick.id)!, info, completedSequences: pick.sequenceNo - 1 };
  });
}

async function applyRecontactRejections(rejected: Array<{ id: number; reason: 'sequence_limit' | 'below_min_probability'; sequenceNo: number; probability: number }>, now: Date) {
  for (const row of rejected) {
    try {
      if (row.reason === 'sequence_limit') {
        await prisma.contactLedger.updateMany({
          where: { businessId: row.id, status: { in: ['cooldown', 'eligible'] } },
          data: { status: 'blocked', blockReason: 'sequence_limit' },
        });
      } else {
        await prisma.contactLedger.updateMany({
          where: { businessId: row.id, status: 'cooldown' },
          data: { eligibleAfter: new Date(now.getTime() + 30 * DAY_MS) },
        });
      }
      logInfo('recontact_policy_rejected', { businessId: row.id, reason: row.reason, sequenceNo: row.sequenceNo, probability: Number(row.probability.toFixed(5)) });
    } catch (error) {
      logError('recontact_policy_update_failed', error, { businessId: row.id });
    }
  }
}

function thompsonPick<T extends string>(options: readonly T[], arms: Map<string, { successes: number; failures: number }>, baseline: number) {
  if (options.length === 1) return options[0];
  let best = options[0];
  let bestValue = -1;
  for (const option of options) {
    const arm = arms.get(option);
    const dist = posterior({ successes: arm?.successes ?? 0, failures: arm?.failures ?? 0 }, baseline, SEGMENT_STRENGTH);
    const value = sampleBeta(dist.alpha, dist.beta, Math.random);
    if (value > bestValue) {
      bestValue = value;
      best = option;
    }
  }
  return best;
}

async function armMap(dimension: string) {
  const rows = await prisma.agentArm.findMany({ where: { dimension } });
  return new Map(rows.map((row) => [row.key, row]));
}

export async function chooseAngle(findings: string[], usedAngles: string[]) {
  const applicable = applicableAngles(findings);
  const unused = applicable.filter((angle) => !usedAngles.includes(angle));
  const pool = unused.length ? unused
    : applicable.length ? applicable
      : ANGLES.filter((angle) => !usedAngles.includes(angle));
  const options: readonly string[] = pool.length ? pool : ANGLES;
  if (options.length === 1) return options[0];
  return thompsonPick(options, await armMap('angle'), await currentGlobalRate());
}

export async function chooseSubjectStyle(): Promise<SubjectStyle> {
  return thompsonPick(SUBJECT_STYLES, await armMap('subject_style'), await currentGlobalRate());
}

export async function getDraftingMemory(context: MemoryContext) {
  const items = await prisma.agentMemory.findMany({ where: { active: true }, orderBy: { id: 'asc' }, take: 300 });
  return selectMemory(items, context, new Date());
}

// ---------------------------------------------------------------------------
// Learning from outcomes
// ---------------------------------------------------------------------------

export async function learnFromOutcomes(now = new Date()) {
  const settings = await getBrainSettings();
  if (settings.frozen) return { learned: 0, skipped: 'frozen' as const };
  const pending = await prisma.email.findMany({
    where: {
      status: 'sent',
      sequenceStep: 0,
      learnedAt: null,
      sentAt: { not: null, lte: now },
      gmailMessageId: { not: 'dry-run' },
      gmailThreadId: { not: null },
    },
    orderBy: { sentAt: 'asc' },
    take: 200,
    include: {
      business: { select: { niche: true, country: true, track: true, timezone: true } },
      contact: { select: { email: true } },
    },
  });
  let learned = 0;
  for (const email of pending) {
    try {
      const sentAt = email.sentAt!;
      const windowEnd = new Date(sentAt.getTime() + settings.attributionDays * DAY_MS);
      const [replies, suppression] = await Promise.all([
        prisma.replyRecord.findMany({
          where: { threadId: email.gmailThreadId!, receivedAt: { gte: sentAt, lte: windowEnd } },
          select: { classification: true, snippet: true },
        }),
        email.contact?.email
          ? prisma.suppression.findUnique({ where: { email: email.contact.email }, select: { createdAt: true, reason: true } })
          : Promise.resolve(null),
      ]);
      const hardSuppressed = Boolean(
        suppression?.createdAt && suppression.createdAt >= sentAt && suppression.createdAt <= windowEnd &&
        HARD_SUPPRESSION_REASONS.includes(suppression.reason ?? ''),
      );
      const outcome = decideOutcome({ replies, hardSuppressed, windowEnded: windowEnd <= now });
      if (outcome.outcome === 'pending') continue;
      const earlier = email.businessId === null ? 0 : await prisma.email.count({
        where: { businessId: email.businessId, sequenceStep: 0, status: 'sent', gmailMessageId: { not: 'dry-run' }, sentAt: { lt: sentAt } },
      });
      const weight = settings.learningRate;
      const successes = outcome.success ? weight : 0;
      const failures = outcome.success ? 0 : weight * (1 + outcome.extraFailures);
      const dimensions = [
        { dimension: 'global', key: 'all' },
        { dimension: 'track', key: email.business?.track ?? 'site' },
        { dimension: 'niche_region', key: segmentKey(email.business?.niche, email.business?.country) },
        { dimension: 'angle', key: email.draftAngle ?? 'none' },
        { dimension: 'subject_style', key: subjectStyleOf(email.subject) },
        { dimension: 'hour_band', key: hourBandOf(sentAt, email.business?.timezone) },
        { dimension: 'sequence', key: earlier === 0 ? '1' : '2plus' },
      ];
      const didLearn = await prisma.$transaction(async (transaction) => {
        const claimed = await transaction.email.updateMany({
          where: { id: email.id, learnedAt: null },
          data: { learnedAt: now, learnOutcome: outcome.outcome },
        });
        if (!claimed.count) return false;
        for (const { dimension, key } of dimensions) {
          await transaction.agentArm.upsert({
            where: { dimension_key: { dimension, key } },
            create: { dimension, key, successes, failures, n: 1 },
            update: { successes: { increment: successes }, failures: { increment: failures }, n: { increment: 1 } },
          });
        }
        return true;
      });
      if (didLearn) learned++;
    } catch (error) {
      logError('learn_outcome_failed', error, { emailId: email.id });
    }
  }
  if (learned) logInfo('brain_learned_outcomes', { learned });
  return { learned };
}

// ---------------------------------------------------------------------------
// Feedback (capped pseudo-observations)
// ---------------------------------------------------------------------------

export const FEEDBACK_TARGETS = ['email', 'lead', 'niche_region', 'niche', 'region', 'week'] as const;

export type FeedbackResult = { ok: true; effect: number; arms: string[] } | { ok: false; error: string };

export async function applyFeedback(input: { targetType: string; targetId: string; score: number; note: string | null; actor: string }): Promise<FeedbackResult> {
  if (!(FEEDBACK_TARGETS as readonly string[]).includes(input.targetType) || !Number.isInteger(input.score) || input.score < -5 || input.score > 5 || input.score === 0) {
    return { ok: false, error: 'invalid_feedback' };
  }
  const settings = await getBrainSettings();
  if (settings.frozen) return { ok: false, error: 'learning_frozen' };
  const recent = await prisma.agentFeedback.count({ where: { createdBy: input.actor, createdAt: { gte: new Date(Date.now() - DAY_MS) } } });
  if (recent >= 30) return { ok: false, error: 'feedback_rate_limited' };

  let targets: Array<{ dimension: string; key: string }> = [];
  const numericId = Number(input.targetId);
  if (input.targetType === 'email') {
    if (!Number.isSafeInteger(numericId) || numericId < 1) return { ok: false, error: 'invalid_feedback' };
    const email = await prisma.email.findUnique({
      where: { id: numericId },
      select: { subject: true, draftAngle: true, business: { select: { niche: true, country: true } } },
    });
    if (!email) return { ok: false, error: 'target_not_found' };
    targets = [
      { dimension: 'niche_region', key: segmentKey(email.business?.niche, email.business?.country) },
      { dimension: 'subject_style', key: subjectStyleOf(email.subject) },
      ...(email.draftAngle ? [{ dimension: 'angle', key: email.draftAngle }] : []),
    ];
  } else if (input.targetType === 'lead') {
    if (!Number.isSafeInteger(numericId) || numericId < 1) return { ok: false, error: 'invalid_feedback' };
    const business = await prisma.business.findUnique({ where: { id: numericId }, select: { niche: true, country: true } });
    if (!business) return { ok: false, error: 'target_not_found' };
    targets = [{ dimension: 'niche_region', key: segmentKey(business.niche, business.country) }];
  } else if (input.targetType === 'niche_region') {
    const [niche, country] = input.targetId.split('|');
    if (!niche || !country) return { ok: false, error: 'invalid_feedback' };
    targets = [{ dimension: 'niche_region', key: segmentKey(niche, country) }];
  } else if (input.targetType === 'niche' || input.targetType === 'region') {
    const needle = input.targetId.trim().toLowerCase();
    if (!needle) return { ok: false, error: 'invalid_feedback' };
    const arms = await prisma.agentArm.findMany({ where: { dimension: 'niche_region' }, select: { key: true } });
    const matching = arms.filter((arm) => {
      const [niche, country] = arm.key.split('|');
      return input.targetType === 'niche' ? niche === needle : country === needle.toUpperCase();
    });
    if (!matching.length) return { ok: false, error: 'no_matching_arms' };
    targets = matching.map((arm) => ({ dimension: 'niche_region', key: arm.key }));
  } else {
    targets = [{ dimension: 'global', key: 'all' }];
  }

  const total = Math.min(3, Math.abs(input.score) * 0.6);
  const each = total / targets.length;
  const positive = input.score > 0;
  const note = input.note ? input.note.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300) || null : null;
  await prisma.$transaction(async (transaction) => {
    for (const target of targets) {
      await transaction.agentArm.upsert({
        where: { dimension_key: target },
        create: { ...target, successes: positive ? each : 0, failures: positive ? 0 : each, n: 0 },
        update: positive ? { successes: { increment: each } } : { failures: { increment: each } },
      });
    }
    await transaction.agentFeedback.create({
      data: { targetType: input.targetType, targetId: input.targetId.slice(0, 120), score: input.score, note, effect: positive ? total : -total, createdBy: input.actor },
    });
  });
  return { ok: true, effect: positive ? total : -total, arms: targets.map((target) => `${target.dimension}:${target.key}`) };
}

// ---------------------------------------------------------------------------
// Edit capture and the low-risk signal
// ---------------------------------------------------------------------------

export async function recordDraftEdit(
  emailId: number,
  original: { subject: string; body: string },
  final: { subject: string; body: string },
  businessName: string | null,
) {
  const diff = summarizeEdit(original, final);
  if (diff.editDistance === 0 && !diff.subjectChanged) {
    await prisma.draftEdit.deleteMany({ where: { emailId } });
    return null;
  }
  const scrubbed: EditDiff = {
    ...diff,
    removed: diff.removed.map((sentence) => scrubForLlm(sentence, businessName)),
    added: diff.added.map((sentence) => scrubForLlm(sentence, businessName)),
  };
  const data = scrubbed as unknown as Prisma.InputJsonValue;
  await prisma.draftEdit.upsert({
    where: { emailId },
    create: { emailId, diff: data, editDistance: diff.editDistance },
    update: { diff: data, editDistance: diff.editDistance, createdAt: new Date() },
  });
  return scrubbed;
}

export async function autoApproveSignal() {
  const settings = await getBrainSettings();
  const recent = await prisma.email.findMany({
    where: { sequenceStep: 0, draftConfidence: { not: null }, status: { in: REVIEWED_STATUSES } },
    orderBy: { id: 'desc' },
    take: 30,
    select: { draftEdit: { select: { id: true } } },
  });
  const reviewed = recent.length;
  const edited = recent.filter((email) => email.draftEdit).length;
  const editRate = reviewed ? edited / reviewed : null;
  const history = reviewed >= 20 && editRate !== null && editRate <= 0.15;
  return {
    level: settings.autonomy,
    eligible: settings.autonomy === 'L1' && history,
    reviewed,
    editRate,
    minReviewed: 20,
    maxEditRate: 0.15,
  };
}

// ---------------------------------------------------------------------------
// Token budget helper (shared daily budget with drafting)
// ---------------------------------------------------------------------------

async function reserveTokens(estimate: number) {
  const configured = Number(env.LLM_DAILY_TOKEN_BUDGET ?? 30000);
  const budget = Number.isSafeInteger(configured) && configured >= 0 ? configured : 30000;
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  await prisma.dailyTokenUsage.upsert({ where: { day }, create: { day, totalTokens: 0 }, update: {} });
  const reserved = await prisma.dailyTokenUsage.updateMany({
    where: { day, totalTokens: { lte: budget - estimate } },
    data: { totalTokens: { increment: estimate } },
  });
  return reserved.count ? day : null;
}

async function settleTokens(day: Date, estimate: number, actual: number | null) {
  await prisma.dailyTokenUsage.update({ where: { day }, data: { totalTokens: { increment: (actual ?? 0) - estimate } } });
}

// ---------------------------------------------------------------------------
// Strategist (weekly): proposals only, never applied automatically
// ---------------------------------------------------------------------------

const normalizeText = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?\s]+$/g, '').trim();
const hashKey = (value: string) => createHash('sha256').update(normalizeText(value)).digest('hex').slice(0, 24);

type ProposalDraft = { kind: string; summary: string; rationale: string; patch: Prisma.InputJsonValue; dedupeKey: string };

function asEditDiff(value: Prisma.JsonValue): EditDiff | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const numeric = ['subjectWordsBefore', 'subjectWordsAfter', 'wordsBefore', 'wordsAfter', 'wordsDelta', 'editDistance'];
  const booleans = ['subjectChanged', 'openingChanged', 'closingChanged'];
  if (!numeric.every((key) => typeof record[key] === 'number') || !booleans.every((key) => typeof record[key] === 'boolean') ||
      !Array.isArray(record.removed) || !Array.isArray(record.added)) return null;
  return record as unknown as EditDiff;
}

async function llmLessons(edits: EditDiff[]): Promise<Array<{ text: string; rationale: string }>> {
  if (env.BRAIN_STRATEGIST_LLM !== 'true' || !env.LLM_API_KEY || edits.length < 5) return [];
  const sample = edits.slice(0, 12).map((edit) => ({
    wordsDelta: edit.wordsDelta,
    subjectChanged: edit.subjectChanged,
    removed: edit.removed.slice(0, 2),
    added: edit.added.slice(0, 2),
  }));
  const request = {
    model: env.LLM_STRATEGIST_MODEL || env.LLM_MODEL,
    response_format: { type: 'json_object' },
    max_completion_tokens: 500,
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content: 'You review how a freelancer edits drafted cold emails. From the anonymized edit samples, propose at most 3 short, general writing rules that would have prevented the edits. Rules must be 10-200 characters, contain no names, links, email addresses or numbers about specific businesses, and describe style only. Return JSON: {"lessons":[{"text":string,"rationale":string}]}.',
      },
      { role: 'user', content: JSON.stringify({ edits: sample }) },
    ],
  };
  const estimate = Math.ceil(JSON.stringify(request).length / 3) + 500;
  const day = await reserveTokens(estimate);
  if (!day) return [];
  let actual: number | null = null;
  try {
    const baseUrl = (env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.LLM_API_KEY}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error(`LLM request failed with HTTP ${response.status}`);
    const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }>; usage?: { total_tokens?: unknown } };
    actual = typeof payload.usage?.total_tokens === 'number' && Number.isSafeInteger(payload.usage.total_tokens) ? payload.usage.total_tokens : estimate;
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('LLM response did not include message content');
    const parsed: unknown = JSON.parse(content);
    const lessons = parsed && typeof parsed === 'object' ? (parsed as { lessons?: unknown }).lessons : null;
    if (!Array.isArray(lessons)) throw new Error('LLM response did not include a lessons array');
    return lessons.slice(0, 3).flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const text = cleanGuidanceText((item as { text?: unknown }).text, 10, 200);
      const rationale = cleanGuidanceText((item as { rationale?: unknown }).rationale, 1, 200) ?? 'Suggested from recurring edits.';
      return text ? [{ text, rationale }] : [];
    });
  } catch (error) {
    logError('strategist_llm_failed', error);
    return [];
  } finally {
    await settleTokens(day, estimate, actual).catch((error) => logError('strategist_token_settle_failed', error));
  }
}

export async function runStrategist(options: { force?: boolean } = {}) {
  const now = new Date();
  const settings = await getBrainSettings();
  if (settings.frozen) return { created: 0, skipped: 'frozen' as const };
  if (!options.force && !await dueToRun('brain_strategist_last_run', 7 * DAY_MS, now)) return { created: 0, skipped: 'not_due' as const };

  const drafts: ProposalDraft[] = [];
  const overrides = await getOverrides();
  const [armRows, baseline, editRows, memory] = await Promise.all([
    prisma.agentArm.findMany({ where: { dimension: 'niche_region' } }),
    currentGlobalRate(),
    prisma.draftEdit.findMany({ orderBy: { createdAt: 'desc' }, take: 60, select: { diff: true } }),
    prisma.agentMemory.findMany({ where: { kind: 'lesson', active: true } }),
  ]);
  for (const proposal of deriveSegmentProposals(
    armRows.map((arm) => ({ key: arm.key, successes: arm.successes, failures: arm.failures, n: arm.n })),
    baseline,
    SEGMENT_STRENGTH,
  )) {
    if ((overrides[proposal.key] ?? 1) === proposal.multiplier) continue;
    const verb = proposal.kind === 'segment_boost' ? 'Prioritise' : 'De-prioritise';
    drafts.push({
      kind: proposal.kind,
      summary: `${verb} ${proposal.key.replace('|', ' in ')} (${proposal.multiplier}x allocation)`,
      rationale: `${proposal.n} labeled sends; 90% credible reply-rate interval ${(proposal.lo * 100).toFixed(1)}%-${(proposal.hi * 100).toFixed(1)}% against a ${(baseline * 100).toFixed(1)}% overall rate.`,
      patch: { key: proposal.key, multiplier: proposal.multiplier },
      dedupeKey: `${proposal.kind}:${proposal.key}`,
    });
  }
  const edits = editRows.flatMap((row) => { const diff = asEditDiff(row.diff); return diff ? [diff] : []; });
  const lessonCandidates = [
    ...deriveEditLessons(edits).map((lesson) => ({ text: lesson.text, rationale: lesson.rationale, evidence: lesson.evidence })),
    ...(await llmLessons(edits)).map((lesson) => ({ ...lesson, evidence: edits.length })),
  ];
  const reinforced = new Set<number>();
  for (const lesson of lessonCandidates) {
    const existing = memory.find((item) => normalizeText(item.text) === normalizeText(lesson.text));
    if (existing) {
      if (!reinforced.has(existing.id)) {
        reinforced.add(existing.id);
        await prisma.agentMemory.update({
          where: { id: existing.id },
          data: { lastReinforcedAt: now, evidenceCount: Math.max(existing.evidenceCount, lesson.evidence), confidence: Math.min(1, existing.confidence + 0.1) },
        });
      }
      continue;
    }
    drafts.push({
      kind: 'lesson',
      summary: `Add lesson: ${lesson.text}`,
      rationale: lesson.rationale,
      patch: { text: lesson.text, scope: {}, evidence: lesson.evidence },
      dedupeKey: `lesson:${hashKey(lesson.text)}`,
    });
  }

  let created = 0;
  for (const proposal of drafts) {
    const blocking = await prisma.agentProposal.findFirst({
      where: {
        dedupeKey: proposal.dedupeKey,
        OR: [
          { status: 'pending' },
          { status: 'rejected', decidedAt: { gte: new Date(now.getTime() - 30 * DAY_MS) } },
          { status: 'accepted', decidedAt: { gte: new Date(now.getTime() - 90 * DAY_MS) } },
        ],
      },
      select: { id: true },
    });
    if (blocking) continue;
    await prisma.agentProposal.create({ data: proposal });
    created++;
  }
  await markRun('brain_strategist_last_run', now);
  if (created) {
    logInfo('strategist_proposals_created', { created });
    try {
      await dispatchNotification({
        eventKey: `brain-proposals:${now.toISOString().slice(0, 10)}`,
        eventType: 'digest',
        priority: 2,
        title: `${created} new agent ${created === 1 ? 'proposal' : 'proposals'}`,
        body: 'The agent has suggestions waiting for your approval. Open Brain from the workspace menu to review them.',
        url: '/notifications',
      });
    } catch (error) {
      logError('strategist_notification_failed', error);
    }
  }
  return { created };
}

export async function decideProposal(id: number, decision: 'accept' | 'reject', actor: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const proposal = await prisma.agentProposal.findUnique({ where: { id } });
  if (!proposal || proposal.status !== 'pending') return { ok: false, error: 'proposal_not_pending' };
  const patch = proposal.patch && typeof proposal.patch === 'object' && !Array.isArray(proposal.patch) ? proposal.patch as Record<string, unknown> : {};
  let lessonText: string | null = null;
  let overrideKey: string | null = null;
  let overrideValue = 1;
  if (decision === 'accept') {
    if (proposal.kind === 'lesson') {
      lessonText = cleanGuidanceText(patch.text, 10, 200);
      if (!lessonText) return { ok: false, error: 'invalid_proposal_patch' };
    } else if (proposal.kind === 'segment_boost' || proposal.kind === 'segment_reduce') {
      if (typeof patch.key !== 'string' || typeof patch.multiplier !== 'number' || !Number.isFinite(patch.multiplier)) return { ok: false, error: 'invalid_proposal_patch' };
      overrideKey = patch.key.slice(0, 120);
      overrideValue = clamp(patch.multiplier, 0.25, 2);
    } else {
      return { ok: false, error: 'invalid_proposal_patch' };
    }
  }
  const decided = await prisma.$transaction(async (transaction) => {
    const claimed = await transaction.agentProposal.updateMany({
      where: { id, status: 'pending' },
      data: { status: decision === 'accept' ? 'accepted' : 'rejected', decidedAt: new Date(), decidedBy: actor },
    });
    if (!claimed.count) return false;
    if (lessonText) {
      await transaction.agentMemory.create({
        data: {
          kind: 'lesson', scope: {}, text: lessonText, source: 'strategist', confidence: 0.6,
          evidenceCount: typeof patch.evidence === 'number' ? Math.max(0, Math.round(patch.evidence)) : 0,
        },
      });
    }
    if (overrideKey) {
      const row = await transaction.appSetting.findUnique({ where: { key: OVERRIDES_KEY }, select: { value: true } });
      const current = row?.value && typeof row.value === 'object' && !Array.isArray(row.value) ? row.value as Record<string, Prisma.InputJsonValue> : {};
      const next = { ...current, [overrideKey]: overrideValue };
      await transaction.appSetting.upsert({ where: { key: OVERRIDES_KEY }, create: { key: OVERRIDES_KEY, value: next }, update: { value: next } });
    }
    await transaction.auditLog.create({
      data: { actorEmail: actor, action: `agent.proposal_${decision}ed`, target: String(id), meta: { kind: proposal.kind } },
    });
    return true;
  });
  return decided ? { ok: true } : { ok: false, error: 'proposal_not_pending' };
}

// ---------------------------------------------------------------------------
// Periodic model training and housekeeping
// ---------------------------------------------------------------------------

export async function relearnGamma(now = new Date()) {
  if (!await dueToRun('brain_gamma_last_run', DAY_MS, now)) return;
  const arms = await prisma.agentArm.findMany({ where: { dimension: 'sequence' } });
  const first = arms.find((arm) => arm.key === '1');
  const later = arms.find((arm) => arm.key === '2plus');
  const learned = learnGamma(
    { successes: first?.successes ?? 0, failures: first?.failures ?? 0 },
    { successes: later?.successes ?? 0, failures: later?.failures ?? 0 },
    { prior: GAMMA_PRIOR, defaultRate: PRIOR_RATE },
  );
  const current = await currentGamma();
  const changed = current.source === 'prior' ? learned.n2 > 0 : Math.abs(learned.gamma - current.gamma) >= 0.01;
  if (changed) {
    await saveModel('gamma', { gamma: Number(learned.gamma.toFixed(4)), ratio: Number(learned.ratio.toFixed(4)), weight: Number(learned.weight.toFixed(4)) }, Math.round(learned.n2));
    logInfo('brain_gamma_updated', { gamma: learned.gamma, n2: learned.n2 });
  }
  await markRun('brain_gamma_last_run', now);
}

export async function trainScorerIfDue(options: { force?: boolean } = {}, now = new Date()) {
  if (!options.force && !await dueToRun('brain_scorer_last_run', 7 * DAY_MS, now)) return null;
  const labeled = await prisma.email.findMany({
    where: { sequenceStep: 0, status: 'sent', learnedAt: { not: null }, learnOutcome: { in: ['reply', 'negative_reply', 'hard_negative', 'no_reply'] }, gmailMessageId: { not: 'dry-run' }, businessId: { not: null } },
    orderBy: { sentAt: 'desc' },
    take: 3000,
    select: { id: true, businessId: true, sentAt: true, learnOutcome: true, business: { select: { score: true, track: true, findings: true, phone: true } } },
  });
  const businessIds = [...new Set(labeled.map((email) => email.businessId!))];
  const history = businessIds.length
    ? await prisma.email.findMany({
      where: { businessId: { in: businessIds }, sequenceStep: 0, status: 'sent', sentAt: { not: null } },
      select: { id: true, businessId: true, sentAt: true },
    })
    : [];
  const sequenceNo = new Map<number, number>();
  const grouped = new Map<number, Array<{ id: number; sentAt: Date }>>();
  for (const row of history) {
    if (row.businessId === null || !row.sentAt) continue;
    grouped.set(row.businessId, [...(grouped.get(row.businessId) ?? []), { id: row.id, sentAt: row.sentAt }]);
  }
  for (const rows of grouped.values()) {
    rows.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime() || a.id - b.id).forEach((row, index) => sequenceNo.set(row.id, index + 1));
  }
  const X = labeled.map((email) => leadFeatures({
    score: email.business?.score ?? null,
    track: email.business?.track ?? 'site',
    findings: asStringArray(email.business?.findings as Prisma.JsonValue | null),
    hasPhone: Boolean(email.business?.phone),
    sequenceNo: sequenceNo.get(email.id) ?? 1,
  }));
  const y = labeled.map((email) => (email.learnOutcome === 'reply' ? 1 : 0));
  const result = trainScorer(X, y, leadFeatureNames());
  if (result.model) {
    await saveModel('lead_scorer', result.model as unknown as Prisma.InputJsonValue, labeled.length, result.metrics as unknown as Prisma.InputJsonValue);
    logInfo('brain_scorer_adopted', { n: labeled.length, holdoutAuc: result.metrics.holdoutAuc });
  }
  const summary = { at: now.toISOString(), ...result.metrics };
  await prisma.appSetting.upsert({
    where: { key: 'brain_scorer_last_attempt' },
    create: { key: 'brain_scorer_last_attempt', value: summary as unknown as Prisma.InputJsonValue },
    update: { value: summary as unknown as Prisma.InputJsonValue },
  });
  await markRun('brain_scorer_last_run', now);
  return result.metrics;
}

export async function runBrainHousekeeping(now = new Date()) {
  const settings = await getBrainSettings();
  if (await dueToRun('brain_housekeeping_last_run', DAY_MS, now)) {
    await prisma.$transaction([
      prisma.resetSnapshot.deleteMany({ where: { restoreUntil: { lt: now } } }),
      prisma.draftEdit.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 365 * DAY_MS) } } }),
      prisma.agentFeedback.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 730 * DAY_MS) } } }),
      prisma.agentProposal.deleteMany({ where: { status: { not: 'pending' }, decidedAt: { lt: new Date(now.getTime() - 365 * DAY_MS) } } }),
    ]);
    // Daily usage-meter rows are tiny; keep about 13 months for year-over-year comparison.
    await pruneUsage(400, now);
    await markRun('brain_housekeeping_last_run', now);
  }
  if (!settings.frozen && await dueToRun('brain_decay_last_run', 7 * DAY_MS, now)) {
    const lessons = await prisma.agentMemory.findMany({ where: { kind: 'lesson', active: true } });
    for (const lesson of lessons) {
      const days = (now.getTime() - lesson.lastReinforcedAt.getTime()) / DAY_MS;
      const confidence = decayLesson(lesson.confidence, days);
      if (confidence !== lesson.confidence) {
        await prisma.agentMemory.update({ where: { id: lesson.id }, data: { confidence, active: confidence >= 0.25 } });
      }
    }
    await markRun('brain_decay_last_run', now);
  }
}

async function safely(name: string, task: () => Promise<unknown>) {
  try {
    await task();
  } catch (error) {
    logError(`brain_${name}_failed`, error);
  }
}

/** Called once per tick. Each step is isolated so one failure never blocks sending or reply polling. */
export async function runBrainCycle() {
  await safely('learn', () => learnFromOutcomes());
  const settings = await getBrainSettings();
  if (settings.frozen) return;
  await safely('gamma', () => relearnGamma());
  await safely('scorer', () => trainScorerIfDue());
  await safely('strategist', () => runStrategist());
  await safely('housekeeping', () => runBrainHousekeeping());
}

// ---------------------------------------------------------------------------
// Read models for the Brain page
// ---------------------------------------------------------------------------

export async function getArmTable() {
  const [rows, baseline] = await Promise.all([prisma.agentArm.findMany({ orderBy: [{ dimension: 'asc' }, { n: 'desc' }] }), currentGlobalRate()]);
  const dimensions = new Map<string, typeof rows>();
  for (const row of rows) dimensions.set(row.dimension, [...(dimensions.get(row.dimension) ?? []), row]);
  return {
    baseline,
    dimensions: [...dimensions.entries()].map(([dimension, arms]) => {
      const posteriors = arms.map((arm) => posterior({ successes: arm.successes, failures: arm.failures, n: arm.n }, baseline, dimension === 'global' ? GLOBAL_STRENGTH : SEGMENT_STRENGTH));
      const best = arms.length >= 2 && dimension !== 'global' ? probabilityBest(posteriors, mulberry32(12345)) : arms.map(() => null);
      return {
        dimension,
        arms: arms.map((arm, index) => ({
          key: arm.key,
          n: arm.n,
          successes: Number(arm.successes.toFixed(2)),
          failures: Number(arm.failures.toFixed(2)),
          mean: posteriors[index].mean,
          lo: posteriors[index].lo,
          hi: posteriors[index].hi,
          probBest: best[index],
          insufficient: arm.n < 30,
        })),
      };
    }),
  };
}

const weekStart = (date: Date) => {
  const result = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  result.setUTCDate(result.getUTCDate() - ((result.getUTCDay() + 6) % 7));
  return result.toISOString().slice(0, 10);
};

export async function getBrainOverview() {
  const now = new Date();
  const since = new Date(now.getTime() - 84 * DAY_MS);
  const [settings, gamma, scorer, labeledCount, memoryCount, pending, lastStrategist, lastScorer, snapshot, signal, learnedRows, reviewedRows, editRows, replyRows, dealRows, feedbackRows] = await Promise.all([
    getBrainSettings(),
    currentGamma(),
    currentScorer(),
    prisma.email.count({ where: { learnedAt: { not: null }, sequenceStep: 0, gmailMessageId: { not: 'dry-run' } } }),
    prisma.agentMemory.count({ where: { active: true } }),
    prisma.agentProposal.count({ where: { status: 'pending' } }),
    prisma.appSetting.findUnique({ where: { key: 'brain_strategist_last_run' }, select: { value: true } }),
    prisma.appSetting.findUnique({ where: { key: 'brain_scorer_last_attempt' }, select: { value: true } }),
    prisma.resetSnapshot.findFirst({ where: { restoredAt: null, restoreUntil: { gt: now } }, orderBy: { createdAt: 'desc' }, select: { id: true, kind: true, createdAt: true, restoreUntil: true, counts: true } }),
    autoApproveSignal(),
    prisma.email.findMany({
      where: { learnedAt: { not: null }, sequenceStep: 0, gmailMessageId: { not: 'dry-run' }, sentAt: { gte: since } },
      select: { sentAt: true, learnOutcome: true },
    }),
    prisma.email.findMany({ where: { status: { in: ['held', 'approved', 'sending', 'sent', 'rejected'] }, createdAt: { gte: since } }, select: { createdAt: true } }),
    prisma.draftEdit.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true, editDistance: true } }),
    prisma.replyRecord.findMany({ where: { receivedAt: { gte: since } }, select: { classification: true, snippet: true } }),
    prisma.deal.findMany({ select: { stage: true, valueCents: true } }),
    prisma.agentFeedback.findMany({ orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, targetType: true, targetId: true, score: true, note: true, effect: true, createdBy: true, createdAt: true } }),
  ]);
  const weeks = new Map<string, { labeled: number; replies: number; reviewed: number; edited: number; distance: number }>();
  const bucket = (key: string) => {
    const existing = weeks.get(key) ?? { labeled: 0, replies: 0, reviewed: 0, edited: 0, distance: 0 };
    weeks.set(key, existing);
    return existing;
  };
  for (const row of learnedRows) if (row.sentAt) { const week = bucket(weekStart(row.sentAt)); week.labeled++; if (row.learnOutcome === 'reply') week.replies++; }
  for (const row of reviewedRows) if (row.createdAt) bucket(weekStart(row.createdAt)).reviewed++;
  for (const row of editRows) { const week = bucket(weekStart(row.createdAt)); week.edited++; week.distance += row.editDistance; }
  const eventReward = replyRows.reduce((sum, row) => {
    if (row.classification === 'human') {
      const sentiment = replySentiment(row.snippet);
      return sum + (sentiment === 'positive' ? 1 : sentiment === 'neutral' ? 0.3 : -0.3);
    }
    if (row.classification === 'complaint') return sum - 5;
    if (row.classification === 'unsubscribe' || row.classification === 'bounce') return sum - 1;
    return sum;
  }, 0);
  return {
    settings,
    counts: { activeMemory: memoryCount, pendingProposals: pending, labeledSends: labeledCount },
    gamma,
    scorer: {
      active: scorer ? { version: scorer.version, trainedOn: scorer.trainedOn, trainedAt: scorer.createdAt } : null,
      lastAttempt: lastScorer?.value ?? null,
      needed: 150,
      labeled: labeledCount,
    },
    policy: recontactPolicy(),
    autonomy: signal,
    lastStrategistRun: typeof lastStrategist?.value === 'string' ? lastStrategist.value : null,
    snapshot,
    rewardPoints90d: {
      events: Number(eventReward.toFixed(1)),
      deals: Number(dealRows.reduce((sum, deal) => sum + dealReward(deal.stage, deal.valueCents), 0).toFixed(1)),
    },
    curve: [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, value]) => ({
      week,
      labeled: value.labeled,
      replies: value.replies,
      replyRate: value.labeled ? value.replies / value.labeled : null,
      reviewed: value.reviewed,
      edited: value.edited,
      editRate: value.reviewed ? value.edited / value.reviewed : null,
      avgEditDistance: value.edited ? value.distance / value.edited : null,
    })),
    feedback: feedbackRows,
  };
}

export async function explainLead(businessId: number) {
  const now = new Date();
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      id: true, name: true, niche: true, country: true, track: true, score: true, status: true, findings: true, phone: true,
      contacts: { select: { email: true } },
    },
  });
  if (!business) return null;
  const emails = business.contacts.flatMap((contact) => contact.email ? [contact.email] : []);
  const [suppressions, ledgers, sequences, lastEmail, arm, baseline, gammaState, scorer, settings, overrides] = await Promise.all([
    emails.length ? prisma.suppression.findMany({ where: { email: { in: emails } }, select: { reason: true } }) : Promise.resolve([]),
    prisma.contactLedger.findMany({ where: { businessId }, select: { status: true, eligibleAfter: true, lastContactAt: true, blockReason: true } }),
    prisma.email.count({ where: { businessId, status: 'sent', sequenceStep: 0 } }),
    prisma.email.findFirst({ where: { businessId, selectionInfo: { not: Prisma.DbNull } }, orderBy: { id: 'desc' }, select: { id: true, status: true, selectionInfo: true } }),
    prisma.agentArm.findUnique({ where: { dimension_key: { dimension: 'niche_region', key: segmentKey(business.niche, business.country) } } }),
    currentGlobalRate(),
    currentGamma(),
    currentScorer(),
    getBrainSettings(),
    getOverrides(),
  ]);
  const policy = recontactPolicy();
  const segment = segmentKey(business.niche, business.country);
  const dist = posterior({ successes: arm?.successes ?? 0, failures: arm?.failures ?? 0, n: arm?.n ?? 0 }, baseline, SEGMENT_STRENGTH);
  const sequenceNo = sequences + 1;
  const lastContact = ledgers.map((row) => row.lastContactAt).filter((date): date is Date => date !== null).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const daysSince = lastContact ? (now.getTime() - lastContact.getTime()) / DAY_MS : null;
  const probability = sequenceNo === 1 ? dist.mean : recontactProbability(dist.mean, gammaState.gamma, sequenceNo, daysSince, policy.tauDays);
  const reasons: string[] = [];
  if (suppressions.length) reasons.push(`Contact is suppressed (${suppressions.map((row) => row.reason ?? 'unspecified').join(', ')}).`);
  for (const ledger of ledgers) {
    if (!['eligible', 'in_review', 'cooldown'].includes(ledger.status)) reasons.push(`Contact ledger is ${ledger.status}${ledger.blockReason ? ` (${ledger.blockReason})` : ''}.`);
    else if (ledger.status === 'cooldown' && ledger.eligibleAfter && ledger.eligibleAfter > now) {
      reasons.push(`Cooling down for ${Math.ceil((ledger.eligibleAfter.getTime() - now.getTime()) / DAY_MS)} more days.`);
    }
  }
  if (['replied', 'rejected'].includes(business.status ?? '')) reasons.push(`Business status is ${business.status}.`);
  if (sequenceNo > policy.maxSequences) reasons.push(`Reached the ${policy.maxSequences}-sequence limit.`);
  else if (sequenceNo >= 2 && probability < policy.minP) reasons.push(`Estimated reply probability ${(probability * 100).toFixed(2)}% is below the ${(policy.minP * 100).toFixed(1)}% minimum.`);
  const selection = lastEmail?.selectionInfo && typeof lastEmail.selectionInfo === 'object' && !Array.isArray(lastEmail.selectionInfo)
    ? lastEmail.selectionInfo as Record<string, unknown> : null;
  const memoryIds = selection && Array.isArray(selection.memoryIds) ? selection.memoryIds.filter((id): id is number => typeof id === 'number') : [];
  const memory = memoryIds.length ? await prisma.agentMemory.findMany({ where: { id: { in: memoryIds } }, select: { id: true, kind: true, text: true } }) : [];
  return {
    business: { id: business.id, name: business.name, niche: business.niche, country: business.country, track: business.track, score: business.score, status: business.status },
    segment: { key: segment, mean: dist.mean, lo: dist.lo, hi: dist.hi, n: arm?.n ?? 0, baseline, override: overrides[segment] ?? 1 },
    multiplier: {
      source: scorer ? 'lead scorer model' : 'opportunity score',
      scorerVersion: scorer?.version ?? null,
    },
    policy: {
      canEmail: reasons.length === 0,
      reasons,
      sequenceNo,
      completedSequences: sequences,
      gamma: gammaState.gamma,
      gammaSource: gammaState.source,
      probability,
      minP: policy.minP,
      maxSequences: policy.maxSequences,
      daysSinceLastSend: daysSince,
    },
    exploration: { share: settings.explorationShare },
    lastSelection: selection ? { emailId: lastEmail!.id, emailStatus: lastEmail!.status, info: selection, memory } : null,
  };
}

// ---------------------------------------------------------------------------
// Snapshot, reset and restore
// ---------------------------------------------------------------------------

type BrainState = {
  memory: Array<Record<string, unknown>>;
  arms: Array<Record<string, unknown>>;
  feedback: Array<Record<string, unknown>>;
  proposals: Array<Record<string, unknown>>;
  models: Array<Record<string, unknown>>;
  edits: Array<Record<string, unknown>>;
  settings: { brain_settings: unknown; brain_overrides: unknown };
};

const jsonSafe = <T>(value: T) => JSON.parse(JSON.stringify(value)) as T;

async function collectState(): Promise<BrainState> {
  const [memory, arms, feedback, proposals, models, edits, settingRows] = await Promise.all([
    prisma.agentMemory.findMany(),
    prisma.agentArm.findMany(),
    prisma.agentFeedback.findMany(),
    prisma.agentProposal.findMany(),
    prisma.agentModel.findMany(),
    prisma.draftEdit.findMany({ orderBy: { createdAt: 'desc' }, take: 500 }),
    prisma.appSetting.findMany({ where: { key: { in: [SETTINGS_KEY, OVERRIDES_KEY] } } }),
  ]);
  const setting = (key: string) => settingRows.find((row) => row.key === key)?.value ?? null;
  return jsonSafe({
    memory, arms, feedback, proposals, models, edits,
    settings: { brain_settings: setting(SETTINGS_KEY), brain_overrides: setting(OVERRIDES_KEY) },
  }) as BrainState;
}

function countState(state: BrainState) {
  return { memory: state.memory.length, arms: state.arms.length, feedback: state.feedback.length, proposals: state.proposals.length, models: state.models.length, draftEdits: state.edits.length };
}

export async function previewReset() {
  const [memory, instructions, arms, feedback, proposals, models, draftEdits, snapshots] = await Promise.all([
    prisma.agentMemory.count(),
    prisma.agentMemory.count({ where: { kind: { in: ['instruction', 'guardrail'] } } }),
    prisma.agentArm.count(),
    prisma.agentFeedback.count(),
    prisma.agentProposal.count(),
    prisma.agentModel.count(),
    prisma.draftEdit.count(),
    prisma.resetSnapshot.findMany({ where: { restoredAt: null, restoreUntil: { gt: new Date() } }, orderBy: { createdAt: 'desc' }, select: { id: true, kind: true, createdAt: true, restoreUntil: true, counts: true, createdBy: true } }),
  ]);
  return {
    willErase: { memory, instructionsAndGuardrails: instructions, arms, feedback, proposals, models, draftEdits },
    preserved: ['suppressions', 'contact ledger', 'sent emails and replies', 'deals', 'admins', 'markets and settings'],
    snapshots,
  };
}

async function withTickLease<T>(task: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  const now = new Date();
  const acquired = await prisma.lease.updateMany({ where: { id: 1, until: { lt: now } }, data: { until: new Date(now.getTime() + 3 * 60 * 1000) } });
  if (!acquired.count) return { ok: false };
  try {
    return { ok: true, value: await task() };
  } finally {
    await prisma.lease.update({ where: { id: 1 }, data: { until: new Date(0) } }).catch((error) => logError('brain_lease_release_failed', error));
  }
}

export async function resetBrain(input: { actor: string; keepInstructions: boolean }): Promise<{ ok: true; snapshotId: number; counts: Record<string, number> } | { ok: false; error: string }> {
  const leased = await withTickLease(async () => {
    const before = await getBrainSettings();
    await saveBrainSettings({ frozen: true });
    try {
      const state = await collectState();
      const counts = countState(state);
      const restoreUntil = new Date(Date.now() + 7 * DAY_MS);
      const snapshot = await prisma.$transaction(async (transaction) => {
        const created = await transaction.resetSnapshot.create({
          data: { kind: 'reset', payload: state as unknown as Prisma.InputJsonValue, counts, createdBy: input.actor, restoreUntil },
          select: { id: true },
        });
        await transaction.draftEdit.deleteMany();
        await transaction.agentFeedback.deleteMany();
        await transaction.agentProposal.deleteMany();
        await transaction.agentModel.deleteMany();
        await transaction.agentArm.deleteMany();
        await transaction.agentMemory.deleteMany(input.keepInstructions ? { where: { kind: { notIn: ['instruction', 'guardrail'] } } } : undefined);
        await transaction.appSetting.deleteMany({ where: { key: { in: [OVERRIDES_KEY, 'brain_scorer_last_attempt', 'brain_strategist_last_run', 'brain_gamma_last_run', 'brain_scorer_last_run', 'brain_decay_last_run'] } } });
        const defaults = normalizeBrainSettings({ ...DEFAULT_BRAIN_SETTINGS, frozen: before.frozen });
        await transaction.appSetting.upsert({ where: { key: SETTINGS_KEY }, create: { key: SETTINGS_KEY, value: defaults }, update: { value: defaults } });
        await transaction.auditLog.create({
          data: { actorEmail: input.actor, action: 'agent.reset', target: String(created.id), meta: { keepInstructions: input.keepInstructions, counts } },
        });
        return created;
      });
      return { snapshotId: snapshot.id, counts };
    } catch (error) {
      await saveBrainSettings({ frozen: before.frozen });
      throw error;
    }
  });
  if (!leased.ok) return { ok: false, error: 'tick_in_progress_try_again' };
  return { ok: true, ...leased.value };
}

const asRecords = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)) : []);
const str = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback);
const num = (value: unknown, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const date = (value: unknown, fallback = new Date()) => {
  const parsed = typeof value === 'string' ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : fallback;
};
const json = (value: unknown) => (value === null || value === undefined ? {} : value) as Prisma.InputJsonValue;

export async function restoreBrain(input: { actor: string; snapshotId?: number }): Promise<{ ok: true; snapshotId: number; counts: Record<string, number> } | { ok: false; error: string }> {
  const now = new Date();
  const snapshot = await prisma.resetSnapshot.findFirst({
    where: { ...(input.snapshotId ? { id: input.snapshotId } : {}), restoredAt: null, restoreUntil: { gt: now } },
    orderBy: { createdAt: 'desc' },
  });
  if (!snapshot) return { ok: false, error: 'no_restorable_snapshot' };
  const payload = snapshot.payload && typeof snapshot.payload === 'object' && !Array.isArray(snapshot.payload) ? snapshot.payload as Record<string, unknown> : null;
  if (!payload) return { ok: false, error: 'snapshot_payload_invalid' };
  const leased = await withTickLease(async () => {
    const before = await getBrainSettings();
    await saveBrainSettings({ frozen: true });
    try {
      const current = await collectState();
      const emailIds = new Set((await prisma.email.findMany({ where: { id: { in: asRecords(payload.edits).map((row) => num(row.emailId)).filter((id) => id > 0) } }, select: { id: true } })).map((row) => row.id));
      await prisma.$transaction(async (transaction) => {
        await transaction.resetSnapshot.create({
          data: { kind: 'pre_restore', payload: current as unknown as Prisma.InputJsonValue, counts: countState(current), createdBy: input.actor, restoreUntil: new Date(now.getTime() + 7 * DAY_MS) },
        });
        await transaction.draftEdit.deleteMany();
        await transaction.agentFeedback.deleteMany();
        await transaction.agentProposal.deleteMany();
        await transaction.agentModel.deleteMany();
        await transaction.agentArm.deleteMany();
        await transaction.agentMemory.deleteMany();
        await transaction.agentMemory.createMany({
          data: asRecords(payload.memory).map((row) => ({
            kind: str(row.kind, 'instruction'), scope: json(row.scope), text: str(row.text), source: str(row.source, 'user'),
            confidence: num(row.confidence, 1), evidenceCount: Math.round(num(row.evidenceCount)), active: row.active !== false,
            expiresAt: row.expiresAt ? date(row.expiresAt) : null, lastReinforcedAt: date(row.lastReinforcedAt), createdAt: date(row.createdAt),
          })).filter((row) => row.text),
        });
        await transaction.agentArm.createMany({
          data: asRecords(payload.arms).map((row) => ({
            dimension: str(row.dimension), key: str(row.key), successes: Math.max(0, num(row.successes)), failures: Math.max(0, num(row.failures)), n: Math.max(0, Math.round(num(row.n))),
          })).filter((row) => row.dimension && row.key),
          skipDuplicates: true,
        });
        await transaction.agentFeedback.createMany({
          data: asRecords(payload.feedback).map((row) => ({
            targetType: str(row.targetType), targetId: str(row.targetId), score: Math.round(clamp(num(row.score), -5, 5)), note: typeof row.note === 'string' ? row.note : null,
            effect: num(row.effect), createdBy: str(row.createdBy, input.actor), createdAt: date(row.createdAt),
          })).filter((row) => row.targetType && row.score !== 0),
        });
        await transaction.agentProposal.createMany({
          data: asRecords(payload.proposals).map((row) => ({
            kind: str(row.kind), summary: str(row.summary), rationale: str(row.rationale), patch: json(row.patch), dedupeKey: str(row.dedupeKey),
            status: ['pending', 'accepted', 'rejected'].includes(str(row.status)) ? str(row.status) : 'pending', createdAt: date(row.createdAt),
            decidedAt: row.decidedAt ? date(row.decidedAt) : null, decidedBy: typeof row.decidedBy === 'string' ? row.decidedBy : null,
          })).filter((row) => row.kind && row.summary && row.dedupeKey),
        });
        await transaction.agentModel.createMany({
          data: asRecords(payload.models).map((row) => ({
            kind: str(row.kind), version: Math.max(1, Math.round(num(row.version, 1))), params: json(row.params), trainedOn: Math.max(0, Math.round(num(row.trainedOn))),
            ...(row.metrics ? { metrics: json(row.metrics) } : {}), createdAt: date(row.createdAt),
          })).filter((row) => row.kind),
          skipDuplicates: true,
        });
        await transaction.draftEdit.createMany({
          data: asRecords(payload.edits).filter((row) => emailIds.has(num(row.emailId))).map((row) => ({
            emailId: num(row.emailId), diff: json(row.diff), editDistance: Math.max(0, Math.round(num(row.editDistance))), createdAt: date(row.createdAt),
          })),
          skipDuplicates: true,
        });
        const restored = payload.settings && typeof payload.settings === 'object' ? payload.settings as Record<string, unknown> : {};
        const restoredSettings = normalizeBrainSettings({ ...(normalizeBrainSettings(restored.brain_settings)), frozen: before.frozen });
        await transaction.appSetting.upsert({ where: { key: SETTINGS_KEY }, create: { key: SETTINGS_KEY, value: restoredSettings }, update: { value: restoredSettings } });
        if (restored.brain_overrides && typeof restored.brain_overrides === 'object') {
          await transaction.appSetting.upsert({ where: { key: OVERRIDES_KEY }, create: { key: OVERRIDES_KEY, value: restored.brain_overrides as Prisma.InputJsonValue }, update: { value: restored.brain_overrides as Prisma.InputJsonValue } });
        } else {
          await transaction.appSetting.deleteMany({ where: { key: OVERRIDES_KEY } });
        }
        await transaction.resetSnapshot.update({ where: { id: snapshot.id }, data: { restoredAt: now } });
        await transaction.auditLog.create({ data: { actorEmail: input.actor, action: 'agent.restore', target: String(snapshot.id), meta: { counts: snapshot.counts } } });
      });
    } catch (error) {
      await saveBrainSettings({ frozen: before.frozen });
      throw error;
    }
  });
  if (!leased.ok) return { ok: false, error: 'tick_in_progress_try_again' };
  const counts = snapshot.counts && typeof snapshot.counts === 'object' && !Array.isArray(snapshot.counts) ? snapshot.counts as Record<string, number> : {};
  return { ok: true, snapshotId: snapshot.id, counts };
}
