import type { FastifyInstance } from 'fastify';
import { prisma } from './db.js';
import { requireOwner } from './auth.js';
import { hourBandOf, subjectStyleOf, wilsonInterval } from './brain-math.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ROI_KEY = 'roi_settings';

export type RoiSettings = {
  hourlyRate: number;
  reviewMinutes: number;
  replyMinutes: number;
  fixedMonthlyCost: number;
  llmCostPerMillionTokens: number;
  currency: string;
};

export const DEFAULT_ROI_SETTINGS: RoiSettings = {
  hourlyRate: 0,
  reviewMinutes: 3,
  replyMinutes: 10,
  fixedMonthlyCost: 0,
  llmCostPerMillionTokens: 0,
  currency: 'USD',
};

const RANGES: Record<Exclude<keyof RoiSettings, 'currency'>, [number, number]> = {
  hourlyRate: [0, 10_000],
  reviewMinutes: [0, 120],
  replyMinutes: [0, 240],
  fixedMonthlyCost: [0, 1_000_000],
  llmCostPerMillionTokens: [0, 1000],
};

/** Strict parse used for writes; returns null if anything is out of range. */
export function parseRoiSettings(value: unknown): RoiSettings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const result: RoiSettings = { ...DEFAULT_ROI_SETTINGS };
  for (const key of Object.keys(RANGES) as Array<keyof typeof RANGES>) {
    const raw = input[key];
    if (raw === undefined) continue;
    const [min, max] = RANGES[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min || raw > max) return null;
    result[key] = raw;
  }
  if (input.currency !== undefined) {
    if (typeof input.currency !== 'string' || !/^[A-Z]{3}$/.test(input.currency)) return null;
    try { new Intl.NumberFormat('en-US', { style: 'currency', currency: input.currency }).format(0); } catch { return null; }
    result.currency = input.currency;
  }
  return result;
}

async function getRoiSettings() {
  const row = await prisma.appSetting.findUnique({ where: { key: ROI_KEY }, select: { value: true } });
  return parseRoiSettings(row?.value) ?? DEFAULT_ROI_SETTINGS;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

function parseDays(value: unknown) {
  const days = value === undefined ? 30 : Number(value);
  return Number.isSafeInteger(days) && days >= 7 && days <= 90 ? days : null;
}

type Row = { key: string; n: number; replies: number; rate: number | null; lo: number | null; hi: number | null; insufficient: boolean };

function toRows(counts: Map<string, { n: number; replies: number }>): Row[] {
  return [...counts.entries()]
    .map(([key, value]) => {
      const interval = wilsonInterval(value.replies, value.n);
      return {
        key,
        n: value.n,
        replies: value.replies,
        rate: value.n ? value.replies / value.n : null,
        lo: value.n ? interval.lo : null,
        hi: value.n ? interval.hi : null,
        insufficient: value.n < 30,
      };
    })
    .sort((a, b) => b.n - a.n || a.key.localeCompare(b.key))
    .slice(0, 12);
}

function weekday(date: Date, timeZone: string | null) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timeZone || 'UTC', weekday: 'short' }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(date);
  }
}

export function registerAnalyticsExtraRoutes(r: FastifyInstance) {
  r.get('/analytics/breakdowns', async (request, reply) => {
    const days = parseDays((request.query as { days?: unknown }).days);
    if (days === null) return reply.code(400).send({ error: 'analytics_days_must_be_7_to_90' });
    const now = new Date();
    const since = new Date(now.getTime() - days * DAY_MS);
    const sent = await prisma.email.findMany({
      where: { status: 'sent', sentAt: { gte: since, lte: now }, gmailMessageId: { not: 'dry-run' } },
      orderBy: { sentAt: 'desc' },
      take: 5000,
      select: {
        id: true, sentAt: true, sequenceStep: true, subject: true, draftAngle: true, portfolioProject: true,
        gmailThreadId: true, businessId: true,
        business: { select: { niche: true, country: true, track: true, timezone: true, score: true, findings: true } },
      },
    });
    const humanReplies = await prisma.replyRecord.findMany({
      where: { classification: 'human', receivedAt: { gte: since } },
      select: { threadId: true, receivedAt: true },
    });
    const repliedThreads = new Set(humanReplies.map((row) => row.threadId));
    const businessIds = [...new Set(sent.flatMap((row) => row.businessId === null ? [] : [row.businessId]))];
    const history = businessIds.length
      ? await prisma.email.findMany({
        where: { businessId: { in: businessIds }, status: 'sent', sequenceStep: 0, sentAt: { not: null }, gmailMessageId: { not: 'dry-run' } },
        select: { id: true, businessId: true, sentAt: true },
      })
      : [];
    const sequenceOf = new Map<number, number>();
    const byBusiness = new Map<number, Array<{ id: number; sentAt: Date }>>();
    for (const row of history) {
      if (row.businessId === null || !row.sentAt) continue;
      byBusiness.set(row.businessId, [...(byBusiness.get(row.businessId) ?? []), { id: row.id, sentAt: row.sentAt }]);
    }
    for (const rows of byBusiness.values()) {
      rows.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime() || a.id - b.id).forEach((row, index) => sequenceOf.set(row.id, index + 1));
    }

    const dimensions = new Map<string, Map<string, { n: number; replies: number }>>();
    const add = (dimension: string, key: string, replied: boolean) => {
      const map = dimensions.get(dimension) ?? new Map<string, { n: number; replies: number }>();
      dimensions.set(dimension, map);
      const entry = map.get(key) ?? { n: 0, replies: 0 };
      entry.n++;
      if (replied) entry.replies++;
      map.set(key, entry);
    };

    for (const email of sent.filter((row) => row.sequenceStep === 0 && row.sentAt)) {
      const replied = Boolean(email.gmailThreadId && repliedThreads.has(email.gmailThreadId));
      const business = email.business;
      add('niche', business?.niche?.trim().toLowerCase() || 'unknown', replied);
      add('country', business?.country?.toUpperCase() || 'unknown', replied);
      add('track', business?.track ?? 'unknown', replied);
      add('subject_style', subjectStyleOf(email.subject), replied);
      add('angle', email.draftAngle ?? 'none', replied);
      add('send_hour_band', hourBandOf(email.sentAt!, business?.timezone), replied);
      add('weekday', weekday(email.sentAt!, business?.timezone ?? null), replied);
      add('sequence', (sequenceOf.get(email.id) ?? 1) === 1 ? '1st contact' : 're-contact', replied);
      add('portfolio_piece', email.portfolioProject ?? 'none', replied);
      const score = business?.score;
      add('opportunity_score', score === null || score === undefined ? 'unscored' : score < 40 ? '0-39' : score < 60 ? '40-59' : score < 80 ? '60-79' : '80-100', replied);
      const findings = Array.isArray(business?.findings) ? business!.findings.filter((item): item is string => typeof item === 'string') : [];
      for (const finding of findings) add('finding', finding, replied);
    }

    // Follow-up step: a reply is credited to the last message in the thread sent before it.
    const threads = new Map<string, Array<{ step: number; sentAt: Date }>>();
    for (const email of sent) {
      if (!email.gmailThreadId || !email.sentAt) continue;
      threads.set(email.gmailThreadId, [...(threads.get(email.gmailThreadId) ?? []), { step: email.sequenceStep, sentAt: email.sentAt }]);
    }
    const stepReplies = new Map<number, number>();
    for (const reply of humanReplies) {
      const candidates = (threads.get(reply.threadId) ?? []).filter((row) => row.sentAt <= reply.receivedAt).sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
      if (candidates.length) stepReplies.set(candidates[0].step, (stepReplies.get(candidates[0].step) ?? 0) + 1);
    }
    const stepCounts = new Map<string, { n: number; replies: number }>();
    for (const email of sent) {
      const key = email.sequenceStep === 0 ? 'initial' : `follow-up ${email.sequenceStep}`;
      stepCounts.set(key, { n: (stepCounts.get(key)?.n ?? 0) + 1, replies: 0 });
    }
    for (const [step, count] of stepReplies) {
      const key = step === 0 ? 'initial' : `follow-up ${step}`;
      const entry = stepCounts.get(key);
      if (entry) entry.replies = count;
    }
    dimensions.set('follow_up_step', stepCounts);

    const labels: Record<string, string> = {
      niche: 'Niche', country: 'Country', track: 'Track', subject_style: 'Subject style', angle: 'Angle',
      send_hour_band: 'Send window (recipient local)', weekday: 'Weekday (recipient local)', sequence: 'Sequence',
      portfolio_piece: 'Portfolio piece cited', opportunity_score: 'Opportunity score', finding: 'Finding present', follow_up_step: 'Message in sequence',
    };
    return {
      period_days: days,
      generated_at: now.toISOString(),
      note: 'Rates use first-contact sends in the period and Gmail-classified human replies. Dry-run sends are excluded. Intervals are 90% Wilson intervals; rows with fewer than 30 sends are marked insufficient.',
      sample: sent.filter((row) => row.sequenceStep === 0).length,
      dimensions: [...dimensions.entries()].map(([dimension, counts]) => ({ dimension, label: labels[dimension] ?? dimension, rows: toRows(counts) })),
    };
  });

  r.get('/settings/roi', { preHandler: requireOwner }, async () => getRoiSettings());

  r.put('/settings/roi', { preHandler: requireOwner }, async (request, reply) => {
    const settings = parseRoiSettings(request.body);
    if (!settings) return reply.code(400).send({ error: 'invalid_roi_settings' });
    await prisma.$transaction([
      prisma.appSetting.upsert({ where: { key: ROI_KEY }, create: { key: ROI_KEY, value: settings }, update: { value: settings } }),
      prisma.auditLog.create({ data: { actorEmail: request.auth!.email, action: 'settings.roi_updated', target: ROI_KEY } }),
    ]);
    return settings;
  });

  r.get('/analytics/roi', async (request, reply) => {
    const days = parseDays((request.query as { days?: unknown }).days);
    if (days === null) return reply.code(400).send({ error: 'analytics_days_must_be_7_to_90' });
    const now = new Date();
    const since = new Date(now.getTime() - days * DAY_MS);
    const settings = await getRoiSettings();
    const [sent, reviewedSent, manualRejected, humanReplies, usage, wonDeals, openDeals] = await Promise.all([
      prisma.email.count({ where: { status: 'sent', sentAt: { gte: since }, gmailMessageId: { not: 'dry-run' } } }),
      prisma.email.count({ where: { status: { in: ['held', 'approved', 'sending', 'sent'] }, createdAt: { gte: since } } }),
      prisma.email.count({ where: { status: 'rejected', error: null, createdAt: { gte: since } } }),
      prisma.replyRecord.count({ where: { classification: 'human', receivedAt: { gte: since } } }),
      prisma.dailyTokenUsage.aggregate({ where: { day: { gte: since } }, _sum: { totalTokens: true } }),
      prisma.deal.groupBy({ by: ['currency'], where: { stage: 'won', updatedAt: { gte: since } }, _sum: { valueCents: true }, _count: { _all: true } }),
      prisma.deal.groupBy({ by: ['stage', 'currency'], where: { stage: { notIn: ['won', 'lost'] } }, _sum: { valueCents: true }, _count: { _all: true } }),
    ]);
    const reviewed = reviewedSent + manualRejected;
    const tokens = usage._sum.totalTokens ?? 0;
    const llmCost = (tokens / 1_000_000) * settings.llmCostPerMillionTokens;
    const timeCost = ((reviewed * settings.reviewMinutes + humanReplies * settings.replyMinutes) / 60) * settings.hourlyRate;
    const fixedCost = settings.fixedMonthlyCost * (days / 30);
    const total = llmCost + timeCost + fixedCost;
    const wonInCostCurrency = (wonDeals.find((row) => row.currency === settings.currency)?._sum.valueCents ?? 0) / 100;
    const notes = [
      'Costs only include the rates you configure; unset rates count as zero.',
      'Won value is attributed to the period of the deal’s last update, and currencies are not converted.',
      'Reviewed drafts and time costs are estimates from your configured minutes, not tracked time.',
    ];
    if (wonDeals.some((row) => row.currency !== settings.currency)) notes.push(`ROI uses only ${settings.currency} revenue; deals in other currencies are listed separately.`);
    return {
      period_days: days,
      generated_at: now.toISOString(),
      settings,
      activity: { sent, reviewed_drafts: reviewed, human_replies: humanReplies, llm_tokens: tokens },
      costs: { currency: settings.currency, llm: round2(llmCost), time: round2(timeCost), fixed: round2(fixedCost), total: round2(total) },
      revenue_won: wonDeals.map((row) => ({ currency: row.currency, value_cents: row._sum.valueCents ?? 0, deals: row._count._all })),
      pipeline_open: openDeals.map((row) => ({ stage: row.stage, currency: row.currency, value_cents: row._sum.valueCents ?? 0, deals: row._count._all })),
      efficiency: {
        cost_per_reply: humanReplies && total > 0 ? round2(total / humanReplies) : null,
        cost_per_100_sent: sent && total > 0 ? round2((total / sent) * 100) : null,
        revenue_per_100_sent: sent ? wonDeals.map((row) => ({ currency: row.currency, value_cents: Math.round(((row._sum.valueCents ?? 0) / sent) * 100) })) : [],
        roi: total > 0 && wonInCostCurrency > 0 ? round2((wonInCostCurrency - total) / total) : null,
      },
      notes,
    };
  });
}
