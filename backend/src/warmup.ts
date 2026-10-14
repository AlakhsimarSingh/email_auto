import { env } from './env.js';
import { prisma } from './db.js';

function configuredCap() {
  const cap = Number(env.DAILY_CAP ?? 10);
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > 1000) throw new Error('DAILY_CAP must be an integer from 1 to 1000');
  return cap;
}

function configuredRamp() {
  const text = env.WARMUP_RAMP?.trim() || '3,5,7,10';
  const values = text.split(',').map((value) => Number(value.trim()));
  if (!values.length || values.some((value) => !Number.isSafeInteger(value) || value < 1) ||
      values.some((value, index) => index > 0 && value < values[index - 1])) {
    throw new Error('WARMUP_RAMP must be comma-separated positive integers in ascending order');
  }
  return values;
}

function rampDays() {
  const value = Number(env.WARMUP_RAMP_DAYS ?? 7);
  if (!Number.isSafeInteger(value) || value < 1 || value > 90) {
    throw new Error('WARMUP_RAMP_DAYS must be an integer from 1 to 90');
  }
  return value;
}

export function warmupCap(firstSentAt: Date | null, now: Date, dailyCap = configuredCap(), ramp = configuredRamp(), daysPerStage = rampDays()) {
  if (!Number.isSafeInteger(dailyCap) || dailyCap < 1 || dailyCap > 1000) {
    throw new Error('dailyCap must be an integer from 1 to 1000');
  }
  if (!ramp.length || ramp.some((value) => !Number.isSafeInteger(value) || value < 1) ||
      ramp.some((value, index) => index > 0 && value < ramp[index - 1])) {
    throw new Error('WARMUP_RAMP must be comma-separated positive integers in ascending order');
  }
  if (!Number.isSafeInteger(daysPerStage) || daysPerStage < 1 || daysPerStage > 90) {
    throw new Error('WARMUP_RAMP_DAYS must be an integer from 1 to 90');
  }
  const stage = !firstSentAt
    ? 0
    : Math.min(ramp.length - 1, Math.max(0, Math.floor((now.getTime() - firstSentAt.getTime()) / (daysPerStage * 24 * 60 * 60_000))));
  return {
    cap: Math.min(dailyCap, ramp[stage]),
    stage: stage + 1,
    stages: ramp.map((cap) => Math.min(dailyCap, cap)),
    daysPerStage,
    firstSentAt: firstSentAt?.toISOString() ?? null,
  };
}

export async function getWarmupState(now = new Date()) {
  const firstSent = await prisma.email.findFirst({
    where: { status: 'sent', sentAt: { not: null } },
    orderBy: { sentAt: 'asc' },
    select: { sentAt: true },
  });
  return warmupCap(firstSent?.sentAt ?? null, now);
}

export async function getEffectiveDailyCap(now = new Date()) {
  return (await getWarmupState(now)).cap;
}
