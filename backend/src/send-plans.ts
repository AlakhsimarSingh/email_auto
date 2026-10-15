import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './db.js';
import { notifySendPlanAnnounced } from './notifications.js';
import { nextRecipientWindow, recommendActiveWindow, SEND_PLAN_MIN_NOTICE_MS } from './scheduling.js';
import { getEffectiveDailyCap } from './warmup.js';
import { activity } from './activity.js';

type CreateSendPlanInput = {
  country?: string;
  emailIds?: number[];
  createdBy: string;
  adminUserId: number;
  now?: Date;
};

export type CreateSendPlanResult =
  | { id: string; state: string; announcedAt: Date; startsAt: Date; endsAt: Date; emailCount: number }
  | { error: 'no_enabled_markets' | 'invalid_or_disabled_plan_market' | 'some_emails_are_not_plan_eligible' | 'no_plan_eligible_emails' | 'send_plan_email_race' };

export async function createAnnouncedSendPlan({
  country: requestedCountry,
  emailIds,
  createdBy,
  adminUserId,
  now = new Date(),
}: CreateSendPlanInput): Promise<CreateSendPlanResult> {
  const notBefore = new Date(now.getTime() + SEND_PLAN_MIN_NOTICE_MS);
  const enabledMarkets = await prisma.market.findMany({ where: { enabled: true }, select: { code: true } });
  if (!enabledMarkets.length) return { error: 'no_enabled_markets' };
  const country = requestedCountry?.trim().toUpperCase() || enabledMarkets[0].code;
  const market = await prisma.market.findFirst({ where: { code: country, enabled: true }, select: { code: true, name: true } });
  if (!market) return { error: 'invalid_or_disabled_plan_market' };

  const planDailyCap = await getEffectiveDailyCap(now);
  const emails = await prisma.email.findMany({
    where: {
      ...(emailIds ? { id: { in: emailIds } } : {}),
      status: { in: ['drafted', 'held', 'approved'] },
      manualRequired: false,
      sendPlanItems: { none: {} },
      contact: { is: { email: { not: null } } },
      business: { is: { country } },
    },
    orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'asc' }],
    take: Math.min(planDailyCap, 50),
    include: {
      business: { select: { timezone: true, country: true } },
      replyRecords: { where: { classification: 'human' }, select: { id: true } },
    },
  });
  if (emailIds && emails.length !== emailIds.length) return { error: 'some_emails_are_not_plan_eligible' };
  if (!emails.length) return { error: 'no_plan_eligible_emails' };

  const historySince = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  const marketHistory = await prisma.email.findMany({
    where: { status: 'sent', sentAt: { gte: historySince }, business: { is: { country } } },
    select: {
      sentAt: true,
      business: { select: { timezone: true } },
      replyRecords: { where: { classification: 'human' }, select: { id: true }, take: 1 },
    },
    take: 5000,
    orderBy: { sentAt: 'desc' },
  });
  const outcomes = marketHistory.flatMap((sent) => {
    if (!sent.sentAt) return [];
    const timezone = sent.business?.timezone || 'UTC';
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(sent.sentAt);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    return [{ hour: hour + minute / 60, replied: sent.replyRecords.length > 0 }];
  });
  const recommendation = recommendActiveWindow(outcomes);
  const planId = randomUUID();
  const scheduled = emails.map((email) => {
    const timezone = email.business?.timezone || 'UTC';
    return {
      email,
      scheduledFor: nextRecipientWindow(notBefore, timezone, recommendation.window),
      timezone,
    };
  });
  const firstScheduled = scheduled.reduce((earliest, row) => row.scheduledFor < earliest.scheduledFor ? row : earliest);
  const startsAt = firstScheduled.scheduledFor;
  const endsAt = scheduled.reduce(
    (latest, row) => row.scheduledFor > latest ? row.scheduledFor : latest,
    new Date(startsAt.getTime() + 24 * 60 * 60 * 1000),
  );
  const needsReviewCount = emails.filter((email) => email.status === 'drafted').length;
  const plan = await prisma.$transaction(async (transaction) => {
    const created = await transaction.sendPlan.create({
      data: { id: planId, state: 'announced', announcedAt: now, startsAt, endsAt, createdBy },
    });
    for (const { email, scheduledFor } of scheduled) {
      const claimed = await transaction.email.updateMany({
        where: { id: email.id, status: { in: ['drafted', 'held', 'approved'] }, sendPlanItems: { none: {} } },
        data: { scheduledFor },
      });
      if (!claimed.count) throw new Error('SEND_PLAN_EMAIL_RACE');
      await transaction.sendPlanItem.create({ data: { sendPlanId: planId, emailId: email.id } });
    }
    await transaction.auditLog.create({
      data: {
        actorEmail: createdBy,
        action: 'send_plan.announced',
        target: planId,
        meta: {
          emailCount: emails.length,
          needsReviewCount,
          country: market.code,
          activeWindow: recommendation.window,
          activeWindowSource: recommendation.source,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
        },
      },
    });
    return created;
  }).catch((error: unknown) => {
    if ((error instanceof Error && error.message === 'SEND_PLAN_EMAIL_RACE') ||
        (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) return null;
    throw error;
  });
  if (!plan) return { error: 'send_plan_email_race' };

  try {
    const localStart = new Intl.DateTimeFormat('en-US', {
      timeZone: firstScheduled.timezone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(startsAt);
    await notifySendPlanAnnounced(plan.id, adminUserId, {
      country: market.name,
      businessCount: emails.length,
      needsReviewCount,
      localStart,
      windowSource: recommendation.source,
    });
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'send_plan_notification_failed',
      planId: plan.id,
      message: error instanceof Error ? error.message : String(error),
    }));
  }
  return { id: plan.id, state: plan.state, announcedAt: now, startsAt, endsAt, emailCount: emails.length };
}

export async function createPlansForEligibleMarkets() {
  const owner = await prisma.adminUser.findFirst({ where: { role: 'owner' }, select: { id: true, email: true } });
  if (!owner) {
    console.error(JSON.stringify({ level: 'error', event: 'automatic_send_plan_skipped', message: 'No owner account is configured.' }));
    return;
  }
  const now = new Date();
  const markets = await prisma.market.findMany({ where: { enabled: true }, select: { code: true } });
  const planEvents = await prisma.auditLog.findMany({
    where: {
      action: { in: ['send_plan.announced', 'send_plan.vetoed'] },
      createdAt: { gte: new Date(now.getTime() - SEND_PLAN_MIN_NOTICE_MS) },
    },
    select: { action: true, target: true, meta: true },
    take: 200,
  });
  const announcedCountries = new Map<string, string>();
  for (const event of planEvents) {
    if (event.action !== 'send_plan.announced' || !event.target ||
        typeof event.meta !== 'object' || event.meta === null || Array.isArray(event.meta)) continue;
    const country = event.meta.country;
    if (typeof country === 'string') announcedCountries.set(event.target, country);
  }
  const recentlyVetoedCountries = new Set(planEvents.flatMap((event) => {
    if (event.action !== 'send_plan.vetoed' || !event.target) return [];
    const country = announcedCountries.get(event.target);
    return country ? [country] : [];
  }));
  if (!markets.length) activity('plan', 'No markets are enabled, so no Send Plans can be prepared', 'warn');
  for (const market of markets) {
    const existingPlan = await prisma.sendPlan.findFirst({
      where: {
        state: { in: ['announced', 'frozen'] },
        endsAt: { gt: now },
        items: { some: { email: { business: { is: { country: market.code } } } } },
      },
      select: { id: true },
    });
    if (existingPlan) {
      activity('plan', `${market.code}: a Send Plan is already announced or running`);
      continue;
    }
    if (recentlyVetoedCountries.has(market.code)) {
      activity('plan', `${market.code}: you vetoed a plan recently, so waiting 24 hours before proposing another`);
      continue;
    }
    const recentlyPlanned = await prisma.sendPlan.findFirst({
      where: {
        createdAt: { gte: new Date(now.getTime() - SEND_PLAN_MIN_NOTICE_MS) },
        items: { some: { email: { business: { is: { country: market.code } } } } },
      },
      select: { id: true },
    });
    if (recentlyPlanned) {
      activity('plan', `${market.code}: a plan was created in the last 24 hours`);
      continue;
    }
    const result = await createAnnouncedSendPlan({
      country: market.code,
      createdBy: owner.email,
      adminUserId: owner.id,
      now,
    });
    if (!('error' in result)) {
      activity('plan', `Announced a Send Plan for ${market.code}: ${result.emailCount} ${result.emailCount === 1 ? 'email' : 'emails'} from ${result.startsAt.toISOString()} (at least 24 hours' notice)`, 'success');
    } else if (result.error === 'no_plan_eligible_emails') {
      activity('plan', `${market.code}: no approved emails yet to put in a plan`);
    }
    if ('error' in result && result.error !== 'no_plan_eligible_emails') {
      activity('plan', `${market.code}: could not create a Send Plan (${result.error.replaceAll('_', ' ')})`, 'error');
      console.error(JSON.stringify({
        level: 'error',
        event: 'automatic_send_plan_failed',
        country: market.code,
        error: result.error,
      }));
    }
  }
}
