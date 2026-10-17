import { env } from './env.js';
import Fastify from 'fastify';
import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { lookup, resolveMx } from 'node:dns/promises';
import { disconnectDb, prisma } from './db.js';
import { runTick } from './jobs.js';
import { authenticate, registerAuthRoutes, requireOwner, requireStepUp } from './auth.js';
import { nextRecipientWindow, SEND_PLAN_MIN_NOTICE_MS } from './scheduling.js';
import { createAnnouncedSendPlan } from './send-plans.js';
import { verifyUnsubscribeToken } from './unsubscribe.js';
import { getPortfolioSettings, parsePortfolioSettings, portfolioEmailFooter, PORTFOLIO_SETTING_KEY } from './portfolio.js';
import { parsePushSubscription, pushConfiguration, sendDevicePush } from './push.js';
import {
  acknowledgeWorkspaceNotification,
  createNtfyChannel,
  createTelegramLink,
  ntfyConfiguredTarget,
  processTelegramUpdate,
  removeNotificationChannel,
  runNotificationMaintenance,
  telegramWebhookConfigured,
  testNotificationChannel,
} from './notifications.js';
import { getEffectiveDailyCap, getWarmupState } from './warmup.js';
import { activitySnapshot, loadActivity } from './activity.js';
import { importBusinesses, importTargets, parseImportBatch } from './imports.js';
import { NICHE_PRESETS, nichePreset } from './niches.js';
import { getTargetingSettings, lastAutoPicks, refreshAutoTargeting, saveTargetingSettings, syncCampaigns } from './targeting.js';
import { registerBrainRoutes } from './brain-routes.js';
import { registerAnalyticsExtraRoutes } from './analytics-extra.js';
import { autoApproveSignal, recordDraftEdit } from './brain.js';
import { monthUsage, startAwakeMeter } from './usage-meter.js';

const app = Fastify({ logger: true });
app.addHook('onClose', disconnectDb);
app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
  done(null, body);
});
await registerAuthRoutes(app);
const t0 = Date.now();

/** Settings → Targeting: mode, business types, cities (with reasons in automatic mode). */
async function targetingState() {
  const settings = await getTargetingSettings();
  // Automatic mode is the default, so make sure it has picked cities before showing them.
  const auto = settings.mode === 'auto' ? await refreshAutoTargeting() : await lastAutoPicks();
  const [campaigns, markets] = await Promise.all([
    prisma.campaign.findMany({ where: { active: true }, select: { niche: true, city: true, country: true } }),
    prisma.market.findMany({ where: { enabled: true }, select: { code: true, name: true }, orderBy: { name: 'asc' } }),
  ]);
  const cities = new Map<string, { city: string; country: string }>();
  for (const campaign of campaigns) {
    if (campaign.city && campaign.country) cities.set(`${campaign.country}:${campaign.city.toLowerCase()}`, { city: campaign.city, country: campaign.country });
  }
  return {
    mode: settings.mode,
    cityCount: settings.cityCount,
    presets: NICHE_PRESETS.map(({ id, label, group }) => ({ id, label, group })),
    selected: settings.niches,
    legacy: campaigns.filter((campaign) => !nichePreset(campaign.niche)).map((campaign) => `${campaign.niche} – ${campaign.city}`),
    cities: [...cities.values()],
    autoPicks: settings.mode === 'auto' ? auto?.picks ?? [] : [],
    autoPickedAt: settings.mode === 'auto' ? auto?.at ?? null : null,
    markets,
  };
}
const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// public: no DB, no data (UptimeRobot keep-alive). Fastify serves HEAD automatically.
app.get('/health', async () => ({ ok: true, uptimeSec: Math.round((Date.now() - t0) / 1000) }));

app.post('/internal/telegram/webhook', async (request, reply) => {
  const secret = request.headers['x-telegram-bot-api-secret-token'];
  const requestSecret = typeof secret === 'string' ? secret : '';
  if (!await telegramWebhookConfigured(requestSecret)) return reply.code(401).send({ error: 'invalid_webhook_secret' });
  await processTelegramUpdate(request.body);
  return reply.code(200).send({ ok: true });
});

app.get('/unsubscribe/:token', async (request, reply) => {
  const { token } = request.params as { token: string };
  const email = await verifyUnsubscribeToken(token);
  if (!email) return reply.code(400).type('text/plain; charset=utf-8').send('Invalid unsubscribe link.');
  return reply.type('text/html; charset=utf-8').send('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Unsubscribe</title></head><body><main><h1>Unsubscribe from outreach</h1><p>Use the button below to stop further email to this address.</p><form method="post"><button type="submit">Unsubscribe</button></form></main></body></html>');
});

app.post('/unsubscribe/:token', async (request, reply) => {
  const { token } = request.params as { token: string };
  const email = await verifyUnsubscribeToken(token);
  if (!email) return reply.code(400).send({ error: 'invalid_unsubscribe_token' });
  await prisma.$transaction(async (transaction) => {
    await transaction.suppression.upsert({
      where: { email },
      create: { email, reason: 'one_click_unsubscribe' },
      update: { reason: 'one_click_unsubscribe' },
    });
    await transaction.contactLedger.upsert({
      where: { email },
      create: { email, domain: email.split('@')[1] ?? '', status: 'blocked', blockReason: 'one_click_unsubscribe' },
      update: { status: 'blocked', blockReason: 'one_click_unsubscribe' },
    });
    await transaction.email.updateMany({
      where: {
        contact: { is: { email } },
        status: { in: ['drafted', 'held', 'approved', 'sending'] },
      },
      data: { status: 'rejected', holdUntil: null, scheduledFor: null, error: 'one_click_unsubscribe' },
    });
    await transaction.replyRecord.create({
      data: {
        gmailMessageId: `unsubscribe:${randomUUID()}`,
        threadId: 'one-click-unsubscribe',
        classification: 'unsubscribe',
        receivedAt: new Date(),
        handledAt: new Date(),
        snippet: 'Recipient used the one-click unsubscribe link.',
      },
    });
  });
  return reply.code(200).type('text/html; charset=utf-8').send('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Unsubscribed</title></head><body><main><h1>You are unsubscribed</h1><p>No further outreach emails will be sent to this address.</p></main></body></html>');
});

// tick: called every ~5 min by cron-job.org with header x-tick-key
app.post('/internal/tick', async (req, reply) => {
  if (!safeEq(String(req.headers['x-tick-key'] ?? ''), env.TICK_SECRET)) return reply.code(401).send();
  runTick().catch((e) => app.log.error(e));
  return reply.code(202).send({ accepted: true });
});

// Open-data importer (GitHub Actions): which cities/categories to fetch, and where to push results.
app.get('/internal/import/targets', async (req, reply) => {
  if (!safeEq(String(req.headers['x-tick-key'] ?? ''), env.TICK_SECRET)) return reply.code(401).send();
  return importTargets();
});
app.post('/internal/import', async (req, reply) => {
  if (!safeEq(String(req.headers['x-tick-key'] ?? ''), env.TICK_SECRET)) return reply.code(401).send();
  let batch;
  try {
    batch = parseImportBatch(req.body);
  } catch (error) {
    return reply.code(400).send({ error: 'invalid_import', message: error instanceof Error ? error.message : 'Invalid import batch' });
  }
  return importBusinesses(batch);
});

// authenticated API
app.register(async (r) => {
  r.addHook('preHandler', authenticate);
  registerBrainRoutes(r);
  registerAnalyticsExtraRoutes(r);
  r.get('/push/config', async (request, reply) => {
    try {
      const { configured, publicKey } = pushConfiguration();
      return { configured, publicKey };
    } catch (error) {
      request.log.error({ err: error }, 'Web Push configuration is incomplete');
      return reply.code(503).send({ error: 'push_configuration_incomplete' });
    }
  });
  r.get('/devices', async (request) => prisma.pushDevice.findMany({
    where: { adminUserId: request.auth!.userId, sessionId: request.auth!.sessionId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, label: true, enabled: true, isPrimary: true, muted: true, quietStart: true, quietEnd: true,
      notifyReplies: true, notifyPlans: true, notifyDigest: true, digestFrequency: true,
      lastSeenAt: true, createdAt: true, lastTestAt: true,
    },
  }));
  r.post('/devices', async (request, reply) => {
    const body = request.body as { label?: unknown; subscription?: unknown } | null;
    const subscription = parsePushSubscription(body?.subscription);
    if (!subscription) return reply.code(400).send({ error: 'invalid_push_subscription' });
    const label = typeof body?.label === 'string' ? body.label.trim() : '';
    if (!label || label.length > 80) {
      return reply.code(400).send({ error: 'invalid_device_label' });
    }
    const existing = await prisma.pushDevice.findUnique({ where: { endpoint: subscription.endpoint } });
    if (existing && existing.adminUserId !== request.auth!.userId) {
      return reply.code(409).send({ error: 'push_subscription_already_registered' });
    }
    const [otherPrimaryDevices, primaryChannels] = await Promise.all([
      prisma.pushDevice.count({ where: { adminUserId: request.auth!.userId, isPrimary: true, ...(existing ? { id: { not: existing.id } } : {}) } }),
      prisma.notificationChannel.count({ where: { adminUserId: request.auth!.userId, isPrimary: true } }),
    ]);
    const makePrimary = !existing?.isPrimary && otherPrimaryDevices + primaryChannels === 0;
    let device;
    try {
      device = await prisma.$transaction(async (transaction) => {
        if (makePrimary) {
          await transaction.pushDevice.updateMany({ where: { adminUserId: request.auth!.userId }, data: { isPrimary: false } });
          await transaction.notificationChannel.updateMany({ where: { adminUserId: request.auth!.userId }, data: { isPrimary: false } });
        }
        return existing
          ? transaction.pushDevice.update({
            where: { id: existing.id },
            data: {
              sessionId: request.auth!.sessionId,
              label,
              p256dh: subscription.keys.p256dh,
              auth: subscription.keys.auth,
              enabled: true,
              ...(makePrimary ? { isPrimary: true } : {}),
              lastSeenAt: new Date(),
            },
          })
          : transaction.pushDevice.create({
            data: {
              adminUserId: request.auth!.userId,
              sessionId: request.auth!.sessionId,
              label,
              endpoint: subscription.endpoint,
              p256dh: subscription.keys.p256dh,
              auth: subscription.keys.auth,
              isPrimary: makePrimary,
            },
          });
      });
    } catch (error) {
      if (!existing && typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
        return reply.code(409).send({ error: 'push_subscription_already_registered' });
      }
      throw error;
    }
    return reply.code(existing ? 200 : 201).send({ id: device.id, label: device.label, enabled: device.enabled });
  });
  r.delete('/devices/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const removed = await prisma.pushDevice.deleteMany({
      where: { id, adminUserId: request.auth!.userId, sessionId: request.auth!.sessionId },
    });
    if (!removed.count) return reply.code(404).send({ error: 'device_not_found' });
    return { ok: true };
  });
  r.patch('/devices/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      isPrimary?: unknown; muted?: unknown; quietStart?: unknown; quietEnd?: unknown;
      notifyReplies?: unknown; notifyPlans?: unknown; notifyDigest?: unknown; digestFrequency?: unknown;
    } | null;
    if (!body || Object.keys(body).length === 0 ||
        body.isPrimary !== undefined && typeof body.isPrimary !== 'boolean' ||
        body.muted !== undefined && typeof body.muted !== 'boolean' ||
        body.notifyReplies !== undefined && typeof body.notifyReplies !== 'boolean' ||
        body.notifyPlans !== undefined && typeof body.notifyPlans !== 'boolean' ||
        body.notifyDigest !== undefined && typeof body.notifyDigest !== 'boolean' ||
        body.digestFrequency !== undefined && !['daily', 'weekly', 'off'].includes(String(body.digestFrequency))) {
      return reply.code(400).send({ error: 'invalid_device_preferences' });
    }
    const timeValid = (value: unknown) => value === null || value === undefined ||
      typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    if (!timeValid(body.quietStart) || !timeValid(body.quietEnd) ||
        (body.quietStart == null) !== (body.quietEnd == null)) {
      return reply.code(400).send({ error: 'invalid_quiet_hours' });
    }
    const device = await prisma.pushDevice.findFirst({
      where: { id, adminUserId: request.auth!.userId, sessionId: request.auth!.sessionId },
      select: { id: true },
    });
    if (!device) return reply.code(404).send({ error: 'device_not_found' });
    const data: {
      isPrimary?: boolean; muted?: boolean; quietStart?: string | null; quietEnd?: string | null;
      notifyReplies?: boolean; notifyPlans?: boolean; notifyDigest?: boolean; digestFrequency?: string;
    } = {};
    if (typeof body.isPrimary === 'boolean') data.isPrimary = body.isPrimary;
    if (typeof body.muted === 'boolean') data.muted = body.muted;
    if (typeof body.quietStart === 'string' || body.quietStart === null) data.quietStart = body.quietStart;
    if (typeof body.quietEnd === 'string' || body.quietEnd === null) data.quietEnd = body.quietEnd;
    if (typeof body.notifyReplies === 'boolean') data.notifyReplies = body.notifyReplies;
    if (typeof body.notifyPlans === 'boolean') data.notifyPlans = body.notifyPlans;
    if (typeof body.notifyDigest === 'boolean') data.notifyDigest = body.notifyDigest;
    if (typeof body.digestFrequency === 'string') data.digestFrequency = body.digestFrequency;
    await prisma.$transaction(async (transaction) => {
      if (body.isPrimary === true) {
        await transaction.pushDevice.updateMany({ where: { adminUserId: request.auth!.userId }, data: { isPrimary: false } });
        await transaction.notificationChannel.updateMany({ where: { adminUserId: request.auth!.userId }, data: { isPrimary: false } });
      }
      await transaction.pushDevice.update({ where: { id }, data });
    });
    return { ok: true };
  });
  r.post('/devices/:id/test', async (request, reply) => {
    let configured: boolean;
    try {
      configured = pushConfiguration().configured;
    } catch (error) {
      request.log.error({ err: error }, 'Web Push configuration is incomplete');
      return reply.code(503).send({ error: 'push_configuration_incomplete' });
    }
    if (!configured) return reply.code(503).send({ error: 'push_not_configured' });
    const { id } = request.params as { id: string };
    const device = await prisma.pushDevice.findFirst({
      where: { id, adminUserId: request.auth!.userId, sessionId: request.auth!.sessionId },
      select: { id: true, endpoint: true, p256dh: true, auth: true, lastTestAt: true },
    });
    if (!device) return reply.code(404).send({ error: 'device_not_found' });
    const now = new Date();
    const testSlot = await prisma.pushDevice.updateMany({
      where: { id: device.id, OR: [{ lastTestAt: null }, { lastTestAt: { lt: new Date(now.getTime() - 60_000) } }] },
      data: { lastTestAt: now },
    });
    if (!testSlot.count) return reply.code(429).send({ error: 'push_test_rate_limited' });
    try {
      const result = await sendDevicePush(device, {
        title: 'Test notification',
        body: 'Push notifications are set up on this device.',
        tag: 'push-test',
        url: '/inbox',
      });
      if (!result.ok) return reply.code(410).send({ error: 'push_subscription_expired' });
      return { ok: true };
    } catch (error) {
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number(error.statusCode)
        : null;
      request.log.error({ statusCode, deviceId: device.id }, 'Test push delivery failed');
      return reply.code(502).send({ error: 'push_delivery_failed' });
    }
  });
  r.get('/notifications', async () => prisma.workspaceNotification.findMany({
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true, eventType: true, priority: true, title: true, body: true, url: true,
      createdAt: true, acknowledgedAt: true, escalatedAt: true,
    },
  }));
  r.post('/notifications/:id/ack', async (request, reply) => {
    const { id } = request.params as { id: string };
    const changed = await acknowledgeWorkspaceNotification(id, request.auth!.email);
    if (!changed) {
      const exists = await prisma.workspaceNotification.findUnique({ where: { id }, select: { acknowledgedAt: true } });
      if (!exists) return reply.code(404).send({ error: 'notification_not_found' });
      return reply.code(409).send({ error: 'notification_already_acknowledged' });
    }
    return { ok: true };
  });
  r.get('/notifications/channels', async (request) => prisma.notificationChannel.findMany({
    where: { adminUserId: request.auth!.userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, type: true, label: true, enabled: true, isPrimary: true, muted: true,
      quietStart: true, quietEnd: true, notifyReplies: true, notifyPlans: true,
      notifyDigest: true, digestFrequency: true, createdAt: true,
    },
  }));
  r.post('/notifications/telegram/link', async (request, reply) => {
    try {
      return await createTelegramLink(request.auth!.userId);
    } catch (error) {
      request.log.error({ err: error instanceof Error ? error.message : 'UnknownError' }, 'Telegram link setup failed');
      return reply.code(503).send({
        error: 'telegram_setup_unavailable',
        message: error instanceof Error ? error.message : 'Telegram setup is not available.',
      });
    }
  });
  r.post('/notifications/channels/ntfy', async (request, reply) => {
    const body = request.body as { url?: unknown; token?: unknown } | null;
    try {
      const verified = await ntfyConfiguredTarget(body?.url, body?.token);
      if (!verified) return reply.code(400).send({ error: 'invalid_ntfy_topic' });
      return reply.code(201).send(await createNtfyChannel(request.auth!.userId, body?.url, body?.token));
    } catch (error) {
      request.log.warn({ err: error instanceof Error ? error.message : 'UnknownError' }, 'ntfy topic verification failed');
      return reply.code(502).send({
        error: 'ntfy_topic_unavailable',
        message: error instanceof Error ? error.message : 'Could not verify the ntfy topic.',
      });
    }
  });
  r.post('/notifications/channels/:id/test', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      if (!await testNotificationChannel(id, request.auth!.userId)) return reply.code(404).send({ error: 'notification_channel_not_found' });
      return { ok: true };
    } catch (error) {
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : null;
      request.log.error({ channelId: id, statusCode }, 'Notification channel test failed');
      return reply.code(502).send({ error: 'notification_channel_test_failed' });
    }
  });
  r.patch('/notifications/channels/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      isPrimary?: unknown; muted?: unknown; quietStart?: unknown; quietEnd?: unknown;
      notifyReplies?: unknown; notifyPlans?: unknown; notifyDigest?: unknown; digestFrequency?: unknown;
    } | null;
    if (!body || Object.keys(body).length === 0 ||
        body.isPrimary !== undefined && typeof body.isPrimary !== 'boolean' ||
        body.muted !== undefined && typeof body.muted !== 'boolean' ||
        body.notifyReplies !== undefined && typeof body.notifyReplies !== 'boolean' ||
        body.notifyPlans !== undefined && typeof body.notifyPlans !== 'boolean' ||
        body.notifyDigest !== undefined && typeof body.notifyDigest !== 'boolean' ||
        body.digestFrequency !== undefined && !['daily', 'weekly', 'off'].includes(String(body.digestFrequency))) {
      return reply.code(400).send({ error: 'invalid_notification_preferences' });
    }
    const timeValid = (value: unknown) => value === null || value === undefined ||
      typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    if (!timeValid(body.quietStart) || !timeValid(body.quietEnd) ||
        (body.quietStart == null) !== (body.quietEnd == null)) {
      return reply.code(400).send({ error: 'invalid_quiet_hours' });
    }
    const data: {
      isPrimary?: boolean; muted?: boolean; quietStart?: string | null; quietEnd?: string | null;
      notifyReplies?: boolean; notifyPlans?: boolean; notifyDigest?: boolean; digestFrequency?: string;
    } = {};
    if (typeof body.isPrimary === 'boolean') data.isPrimary = body.isPrimary;
    if (typeof body.muted === 'boolean') data.muted = body.muted;
    if (typeof body.quietStart === 'string' || body.quietStart === null) data.quietStart = body.quietStart;
    if (typeof body.quietEnd === 'string' || body.quietEnd === null) data.quietEnd = body.quietEnd;
    if (typeof body.notifyReplies === 'boolean') data.notifyReplies = body.notifyReplies;
    if (typeof body.notifyPlans === 'boolean') data.notifyPlans = body.notifyPlans;
    if (typeof body.notifyDigest === 'boolean') data.notifyDigest = body.notifyDigest;
    if (typeof body.digestFrequency === 'string') data.digestFrequency = body.digestFrequency;
    const channel = await prisma.notificationChannel.findFirst({
      where: { id, adminUserId: request.auth!.userId },
      select: { id: true },
    });
    if (!channel) return reply.code(404).send({ error: 'notification_channel_not_found' });
    await prisma.$transaction(async (transaction) => {
      if (body.isPrimary === true) {
        await transaction.pushDevice.updateMany({ where: { adminUserId: request.auth!.userId }, data: { isPrimary: false } });
        await transaction.notificationChannel.updateMany({ where: { adminUserId: request.auth!.userId }, data: { isPrimary: false } });
      }
      await transaction.notificationChannel.update({ where: { id }, data });
    });
    return { ok: true };
  });
  r.delete('/notifications/channels/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!await removeNotificationChannel(id, request.auth!.userId)) return reply.code(404).send({ error: 'notification_channel_not_found' });
    return { ok: true };
  });
  // Live page: the feed is in memory, so this is cheap to poll every few seconds.
  r.get('/activity', async (request) => {
    const since = Number((request.query as { since?: string }).since ?? 0);
    return activitySnapshot(Number.isSafeInteger(since) && since > 0 ? since : 0);
  });
  // Live page: database-backed pipeline and Send Plan progress, polled less often.
  r.get('/activity/summary', async () => {
    const now = new Date();
    const [businesses, emails, sentToday, cap, plans, lastTick] = await Promise.all([
      prisma.business.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.email.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.email.count({ where: { status: 'sent', sentAt: { gt: new Date(now.getTime() - 24 * 60 * 60_000) } } }),
      getEffectiveDailyCap(now),
      prisma.sendPlan.findMany({
        where: { OR: [{ state: { in: ['announced', 'frozen'] }, endsAt: { gt: now } }, { createdAt: { gt: new Date(now.getTime() - 3 * 24 * 60 * 60_000) } }] },
        orderBy: { startsAt: 'asc' },
        take: 8,
        select: {
          id: true, state: true, announcedAt: true, startsAt: true, endsAt: true,
          items: { select: { email: { select: { status: true, business: { select: { country: true } } } } } },
        },
      }),
      prisma.appSetting.findUnique({ where: { key: 'tick_last_finished' }, select: { value: true } }),
    ]);
    const count = (rows: Array<{ status: string | null; _count: { _all: number } }>) =>
      Object.fromEntries(rows.map((row) => [row.status ?? 'unknown', row._count._all]));
    return {
      generated_at: now.toISOString(),
      dry_run: env.DRY_RUN !== 'false',
      last_tick_at: typeof lastTick?.value === 'string' ? lastTick.value : null,
      businesses: count(businesses),
      emails: count(emails),
      sent_24h: sentToday,
      daily_cap: cap,
      plans: plans.map((plan) => {
        const statuses = plan.items.map((item) => item.email.status);
        return {
          id: plan.id,
          state: plan.state,
          announced_at: plan.announcedAt?.toISOString() ?? null,
          starts_at: plan.startsAt.toISOString(),
          ends_at: plan.endsAt.toISOString(),
          countries: [...new Set(plan.items.map((item) => item.email.business?.country).filter(Boolean))],
          total: statuses.length,
          sent: statuses.filter((status) => status === 'sent').length,
          failed: statuses.filter((status) => status === 'failed' || status === 'rejected').length,
        };
      }),
    };
  });
  r.get('/usage', async (request, reply) => {
    const limitMb = Number(env.SUPABASE_DB_LIMIT_MB ?? 500);
    if (!Number.isFinite(limitMb) || limitMb < 1 || limitMb > 100_000) {
      request.log.error('SUPABASE_DB_LIMIT_MB must be a positive number no greater than 100000');
      return reply.code(503).send({ error: 'usage_configuration_invalid' });
    }
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [dbResult, tokens, lastTick, pending, sentToday, emailCounts, meter] = await Promise.all([
      prisma.$queryRaw<Array<{ bytes: bigint }>>`SELECT pg_database_size(current_database())::bigint AS bytes`,
      prisma.dailyTokenUsage.findMany({ where: { day: { gte: monthStart } }, orderBy: { day: 'desc' } }),
      prisma.appSetting.findUnique({ where: { key: 'tick_last_finished' }, select: { value: true } }),
      prisma.email.count({ where: { status: { in: ['drafted', 'held', 'approved'] } } }),
      prisma.email.count({ where: { status: 'sent', sentAt: { gte: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) } } }),
      prisma.email.groupBy({ by: ['status'], _count: { _all: true } }),
      monthUsage(now),
    ]);
    const today = now.toISOString().slice(0, 10);
    const awakeSeconds = meter.reduce((sum, row) => sum + row.awakeSeconds, 0);
    const dbBytes = Number(dbResult[0]?.bytes ?? 0n);
    const dailyBudget = Number(env.LLM_DAILY_TOKEN_BUDGET ?? 30000);
    return {
      generated_at: now.toISOString(),
      process_uptime_seconds: Math.round((Date.now() - t0) / 1000),
      database: { bytes: dbBytes, limit_bytes: limitMb * 1024 * 1024, limit_source: 'SUPABASE_DB_LIMIT_MB', percent: dbBytes / (limitMb * 1024 * 1024) },
      llm: { daily_budget: dailyBudget, used_today: tokens.find((row) => row.day.toISOString().slice(0, 10) === now.toISOString().slice(0, 10))?.totalTokens ?? 0, month_tokens: tokens.reduce((sum, row) => sum + row.totalTokens, 0), daily_history: tokens.map((row) => ({ day: row.day.toISOString().slice(0, 10), tokens: row.totalTokens })) },
      queue: { pending: pending, sent_today: sentToday, by_status: Object.fromEntries(emailCounts.map((row) => [row.status ?? 'unknown', row._count._all])) },
      last_tick_at: typeof lastTick?.value === 'string' ? lastTick.value : null,
      pagespeed: { calls_today: meter.find((row) => row.day === today)?.pagespeedCalls ?? 0, month_calls: meter.reduce((sum, row) => sum + row.pagespeedCalls, 0), daily_quota: 25_000 },
      contact_search: {
        tavily: { configured: !!env.TAVILY_API_KEY?.trim(), month_calls: meter.reduce((sum, row) => sum + row.tavilyCalls, 0), monthly_limit: Number(env.TAVILY_MONTHLY_LIMIT ?? 950) },
        hunter: { configured: !!env.HUNTER_API_KEY?.trim(), month_calls: meter.reduce((sum, row) => sum + row.hunterCalls, 0), monthly_limit: Number(env.HUNTER_MONTHLY_LIMIT ?? 45) },
      },
      render_instance_hours: Math.round(awakeSeconds / 36) / 100,
      render_instance_hours_note: 'Self-measured backend awake hours this UTC month (flushed every 5 minutes; excludes cold starts). Render bills per instance, so confirm against the Render dashboard; the free plan allows 750 hours/month.',
    };
  });
  r.get('/inbox-health', async () => {
    const now = new Date();
    const since = new Date(now.getTime() - 30 * 24 * 60 * 60_000);
    const [sent, bounces, complaints, replies, suppressions, openReplies, dailySends, warmupRamp] = await Promise.all([
      prisma.email.count({ where: { status: 'sent', sentAt: { gte: since } } }),
      prisma.replyRecord.count({ where: { classification: 'bounce', receivedAt: { gte: since } } }),
      prisma.replyRecord.count({ where: { classification: 'complaint', receivedAt: { gte: since } } }),
      prisma.replyRecord.count({ where: { classification: 'human', receivedAt: { gte: since } } }),
      prisma.suppression.count({ where: { createdAt: { gte: since } } }),
      prisma.replyRecord.count({ where: { classification: 'human', handledAt: null } }),
      prisma.email.count({ where: { status: 'sent', sentAt: { gte: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) } } }),
      getWarmupState(),
    ]);
    const bounceRate = sent ? bounces / sent : null;
    const complaintRate = sent ? complaints / sent : null;
    const status = sent < 30 ? 'insufficient_data' :
      (bounceRate ?? 0) >= 0.05 || (complaintRate ?? 0) >= 0.003 ? 'red' :
        (bounceRate ?? 0) >= 0.02 || (complaintRate ?? 0) >= 0.001 ? 'warning' : 'healthy';
    return {
      generated_at: now.toISOString(),
      status,
      sample_size: sent,
      period_days: 30,
      metrics: { sent, replies, bounces, complaints, suppressions, open_replies: openReplies, bounce_rate: bounceRate, complaint_rate: complaintRate },
      warmup: { ...warmupRamp, sent_today: dailySends },
      thresholds: { warning_bounce_rate: 0.02, red_bounce_rate: 0.05, warning_complaint_rate: 0.001, red_complaint_rate: 0.003 },
      note: sent < 30 ? 'Fewer than 30 real sends; health rates are not statistically reliable.' : null,
    };
  });
  r.get('/inbox-health/seed-tests', async (request) => prisma.seedTestRecord.findMany({
    where: { adminUserId: request.auth!.userId },
    orderBy: { testedAt: 'desc' },
    take: 50,
    select: { id: true, mailboxProvider: true, placement: true, testedAt: true },
  }));
  r.post('/inbox-health/seed-tests', async (request, reply) => {
    const body = request.body as { email?: unknown; mailboxProvider?: unknown; placement?: unknown } | null;
    if (typeof body?.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) ||
        body.email.length > 254 || typeof body.mailboxProvider !== 'string' || body.mailboxProvider.trim().length < 2 ||
        body.mailboxProvider.length > 80 || !['inbox', 'spam', 'missing'].includes(String(body.placement))) {
      return reply.code(400).send({ error: 'invalid_seed_test' });
    }
    const emailHash = createHash('sha256').update(body.email.trim().toLowerCase()).digest('hex');
    const record = await prisma.seedTestRecord.create({
      data: { adminUserId: request.auth!.userId, emailHash, mailboxProvider: body.mailboxProvider.trim(), placement: String(body.placement) },
      select: { id: true, mailboxProvider: true, placement: true, testedAt: true },
    });
    return reply.code(201).send(record);
  });
  r.get('/stats', async () => {
    const [sent24h, toReview, queued, held, siteLeads, noSiteLeads, callQueue, pendingReplies, overdueReplies] = await Promise.all([
      prisma.email.count({ where: { status: 'sent', sentAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) } } }),
      prisma.email.count({ where: { status: 'drafted' } }),
      prisma.email.count({ where: { status: 'approved' } }),
      prisma.email.count({ where: { status: 'held' } }),
      prisma.business.count({ where: { track: 'site', status: { notIn: ['skipped', 'rejected'] } } }),
      prisma.business.count({ where: { track: 'no_site', status: { notIn: ['skipped', 'rejected'] } } }),
      prisma.business.count({ where: { status: 'call_queue' } }),
      prisma.replyRecord.count({ where: { handledAt: null, classification: { in: ['human', 'unsubscribe', 'complaint', 'bounce'] } } }),
      prisma.replyRecord.count({
        where: {
          handledAt: null,
          classification: 'human',
          receivedAt: { lt: new Date(Date.now() - 4 * 60 * 60 * 1000) },
        },
      }),
    ]);
    return {
      sent_24h: sent24h,
      to_review: toReview,
      queued: queued + held,
      held,
      site_leads: siteLeads,
      no_site_leads: noSiteLeads,
      call_queue: callQueue,
      pending_replies: pendingReplies,
      overdue_replies: overdueReplies,
    };
  });
  r.get('/replies', async (request, reply) => {
    const query = request.query as { status?: unknown };
    if (query.status !== undefined && query.status !== 'open' && query.status !== 'all') {
      return reply.code(400).send({ error: 'invalid_reply_filter' });
    }
    const records = await prisma.replyRecord.findMany({
      where: query.status === 'all' ? {} : { handledAt: null },
      orderBy: { receivedAt: 'desc' },
      take: 100,
      include: {
        email: {
          select: {
            subject: true,
            contact: { select: { email: true } },
            business: { select: { name: true } },
          },
        },
      },
    });
    const now = Date.now();
    return records.map((record) => ({
      id: record.id,
      classification: record.classification,
      snippet: record.snippet,
      received_at: record.receivedAt.toISOString(),
      handled_at: record.handledAt?.toISOString() ?? null,
      business_name: record.email?.business?.name ?? null,
      contact_email: record.email?.contact?.email ?? null,
      subject: record.email?.subject ?? null,
      sla_overdue: record.classification === 'human' && !record.handledAt &&
        now - record.receivedAt.getTime() > 4 * 60 * 60 * 1000,
    }));
  });
  r.post('/replies/:id/resolve', async (request, reply) => {
    const { id } = request.params as { id: string };
    const replyId = Number(id);
    if (!Number.isSafeInteger(replyId) || replyId < 1) return reply.code(400).send({ error: 'invalid_reply_id' });
    const handledAt = new Date();
    const changed = await prisma.$transaction(async (transaction) => {
      const result = await transaction.replyRecord.updateMany({
        where: { id: replyId, handledAt: null },
        data: { handledAt },
      });
      if (result.count) {
        await transaction.auditLog.create({
          data: { actorEmail: request.auth!.email, action: 'reply.handled', target: String(replyId) },
        });
      }
      return result.count;
    });
    if (!changed) return reply.code(409).send({ error: 'reply_already_handled_or_missing' });
    return { ok: true, handled_at: handledAt.toISOString() };
  });
  r.get('/analytics', async (request, reply) => {
    const query = request.query as { days?: unknown };
    const days = query.days === undefined ? 30 : Number(query.days);
    if (!Number.isSafeInteger(days) || days < 7 || days > 90) {
      return reply.code(400).send({ error: 'analytics_days_must_be_7_to_90' });
    }
    const now = new Date();
    const today = new Date(now);
    today.setUTCHours(0, 0, 0, 0);
    const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const weekSince = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthSince = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const [
      sentToday,
      sent7d,
      sent30d,
      bounce30d,
      humanReplies30d,
      complaint30d,
      sourced,
      audited,
      contactable,
      drafted,
      wonDeals,
      wonValue,
      sentRows,
      replyRows,
    ] = await Promise.all([
      prisma.email.count({ where: { status: 'sent', sentAt: { gte: today } } }),
      prisma.email.count({ where: { status: 'sent', sentAt: { gte: weekSince } } }),
      prisma.email.count({ where: { status: 'sent', sentAt: { gte: monthSince } } }),
      prisma.replyRecord.count({ where: { classification: 'bounce', receivedAt: { gte: monthSince } } }),
      prisma.replyRecord.count({ where: { classification: 'human', receivedAt: { gte: monthSince } } }),
      prisma.replyRecord.count({ where: { classification: 'complaint', receivedAt: { gte: monthSince } } }),
      prisma.business.count(),
      prisma.business.count({ where: { auditedAt: { not: null } } }),
      prisma.business.count({ where: { contacts: { some: { email: { not: null } } } } }),
      prisma.email.count({ where: { status: { in: ['drafted', 'held', 'approved', 'sent'] } } }),
      prisma.deal.count({ where: { stage: 'won' } }),
      prisma.deal.groupBy({ by: ['currency'], where: { stage: 'won' }, _sum: { valueCents: true } }),
      prisma.email.findMany({
        where: { status: 'sent', sentAt: { gte: since, lte: now } },
        select: { sentAt: true },
      }),
      prisma.replyRecord.findMany({
        where: { emailId: { not: null }, receivedAt: { gte: since, lte: now }, classification: { in: ['human', 'bounce', 'complaint', 'unsubscribe'] } },
        select: { receivedAt: true, classification: true },
      }),
    ]);
    const byDay = new Map<string, { sent: number; replies: number; bounces: number }>();
    for (let offset = days - 1; offset >= 0; offset--) {
      const day = new Date(now);
      day.setUTCHours(0, 0, 0, 0);
      day.setUTCDate(day.getUTCDate() - offset);
      const key = day.toISOString().slice(0, 10);
      byDay.set(key, { sent: 0, replies: 0, bounces: 0 });
    }
    for (const row of sentRows) {
      if (!row.sentAt) continue;
      const day = byDay.get(row.sentAt.toISOString().slice(0, 10));
      if (day) day.sent++;
    }
    for (const row of replyRows) {
      const day = byDay.get(row.receivedAt.toISOString().slice(0, 10));
      if (!day) continue;
      if (row.classification === 'bounce') day.bounces++;
      else day.replies++;
    }
    return {
      period_days: days,
      generated_at: now.toISOString(),
      kpis: {
        sent_today: sentToday,
        sent_7d: sent7d,
        sent_30d: sent30d,
        human_replies_30d: humanReplies30d,
        bounce_rate_30d: sent30d ? bounce30d / sent30d : null,
        complaint_rate_30d: sent30d ? complaint30d / sent30d : null,
        human_reply_rate_30d: sent30d ? humanReplies30d / sent30d : null,
        won_deals: wonDeals,
        won_value_by_currency: wonValue.map((row) => ({ currency: row.currency, value_cents: row._sum.valueCents ?? 0 })),
      },
      funnel: { sourced, audited, contactable, drafted, sent: sent30d, replied: humanReplies30d, won: wonDeals },
      daily: Array.from(byDay, ([date, values]) => ({ date, ...values })),
      sample_warning: sent30d < 30,
    };
  });
  r.get('/deals', async () => prisma.deal.findMany({
    orderBy: { updatedAt: 'desc' },
    take: 500,
    include: {
      business: {
        select: {
          id: true,
          name: true,
          city: true,
          country: true,
          niche: true,
          emails: { orderBy: { sentAt: 'desc' }, take: 1, select: { subject: true, sentAt: true } },
        },
      },
    },
  }));
  r.put('/deals/:businessId', async (request, reply) => {
    const { businessId: rawId } = request.params as { businessId: string };
    const businessId = Number(rawId);
    const body = request.body as { stage?: unknown; valueCents?: unknown; currency?: unknown; notes?: unknown } | null;
    const stages = ['replied', 'conversation', 'call', 'proposal', 'won', 'lost'];
    const stage = typeof body?.stage === 'string' ? body.stage : null;
    if (!body || !Number.isSafeInteger(businessId) || businessId < 1 ||
        !stage || !stages.includes(stage) ||
        body.valueCents !== undefined && (!Number.isSafeInteger(body.valueCents) || Number(body.valueCents) < 0 || Number(body.valueCents) > 2_000_000_000) ||
        body.currency !== undefined && (typeof body.currency !== 'string' || !/^[A-Z]{3}$/.test(body.currency)) ||
        body.notes !== undefined && (typeof body.notes !== 'string' || body.notes.length > 2000)) {
      return reply.code(400).send({ error: 'invalid_deal' });
    }
    if (typeof body.currency === 'string') {
      try {
        new Intl.NumberFormat('en-US', { style: 'currency', currency: body.currency }).format(0);
      } catch {
        return reply.code(400).send({ error: 'invalid_deal_currency' });
      }
    }
    if (!await prisma.business.findUnique({ where: { id: businessId }, select: { id: true } })) {
      return reply.code(404).send({ error: 'business_not_found' });
    }
    const deal = await prisma.$transaction(async (transaction) => {
      const updated = await transaction.deal.upsert({
        where: { businessId },
        create: {
          businessId,
          stage,
          valueCents: typeof body.valueCents === 'number' ? body.valueCents : 0,
          currency: typeof body.currency === 'string' ? body.currency : 'USD',
          notes: typeof body.notes === 'string' ? body.notes.trim() || null : null,
        },
        update: {
          stage,
          ...(typeof body.valueCents === 'number' ? { valueCents: body.valueCents } : {}),
          ...(typeof body.currency === 'string' ? { currency: body.currency } : {}),
          ...(typeof body.notes === 'string' ? { notes: body.notes.trim() || null } : {}),
        },
      });
      await transaction.auditLog.create({
        data: { actorEmail: request.auth!.email, action: 'deal.updated', target: String(businessId), meta: { stage: updated.stage, valueCents: updated.valueCents } },
      });
      return updated;
    });
    return deal;
  });
  r.get('/send-plans', { preHandler: requireOwner }, async () =>
    prisma.sendPlan.findMany({
      orderBy: { createdAt: 'desc' },
      take: 30,
      include: {
        items: {
          select: {
            email: {
              select: {
                id: true, subject: true, status: true, scheduledFor: true,
                business: { select: { name: true, city: true, country: true, timezone: true } },
              },
            },
          },
        },
      },
    }));
  r.get('/settings/targeting', { preHandler: requireOwner }, async () => targetingState());
  r.put('/settings/targeting', { preHandler: requireOwner }, async (request, reply) => {
    const body = request.body as { mode?: unknown; cityCount?: unknown; niches?: unknown; cities?: unknown } | null;
    const mode = body?.mode === 'manual' ? 'manual' : 'auto';
    const cityCount = Number(body?.cityCount ?? 5);
    const enabled = new Set((await prisma.market.findMany({ where: { enabled: true }, select: { code: true } })).map((market) => market.code));
    const niches = Array.isArray(body?.niches) ? [...new Set(body.niches.filter((id): id is string => typeof id === 'string' && !!nichePreset(id)))] : [];
    const cities = Array.isArray(body?.cities) ? body.cities.flatMap((raw) => {
      const item = raw as { city?: unknown; country?: unknown } | null;
      const city = typeof item?.city === 'string' ? item.city.trim() : '';
      const country = typeof item?.country === 'string' ? item.country.trim().toUpperCase() : '';
      return city && city.length <= 80 && /^[\p{L} .'-]+$/u.test(city) && enabled.has(country) ? [{ city, country }] : [];
    }) : [];
    if (!niches.length || !Number.isSafeInteger(cityCount) || cityCount < 1 || cityCount > 10 ||
        (mode === 'manual' && (!cities.length || cities.length > 10))) {
      return reply.code(400).send({ error: 'invalid_targeting', message: mode === 'manual'
        ? 'Choose at least one business type and 1–10 cities in enabled markets.'
        : 'Choose at least one business type and 1–10 cities for automatic targeting.' });
    }
    await saveTargetingSettings({ mode, cityCount, niches });
    if (mode === 'auto') await refreshAutoTargeting({ force: true });
    else await syncCampaigns(niches, cities);
    await prisma.auditLog.create({ data: { actorEmail: request.auth!.email, action: 'settings.targeting_updated', meta: { mode, cityCount, niches, cities: mode === 'manual' ? cities : [] } } });
    return targetingState();
  });
  r.get('/settings/portfolio', { preHandler: requireOwner }, getPortfolioSettings);
  r.put('/settings/portfolio', { preHandler: [requireOwner, requireStepUp] }, async (request, reply) => {
    let settings;
    try {
      settings = parsePortfolioSettings(request.body);
    } catch (error) {
      return reply.code(400).send({
        error: 'invalid_portfolio_settings',
        message: error instanceof Error ? error.message : 'Portfolio settings are invalid.',
      });
    }
    await prisma.$transaction(async (transaction) => {
      await transaction.appSetting.upsert({
        where: { key: PORTFOLIO_SETTING_KEY },
        create: { key: PORTFOLIO_SETTING_KEY, value: settings },
        update: { value: settings },
      });
      await transaction.auditLog.create({
        data: {
          actorEmail: request.auth!.email,
          action: 'settings.portfolio_updated',
          target: PORTFOLIO_SETTING_KEY,
          meta: { hasPortfolioUrl: Boolean(settings.portfolioUrl), latestWorkCount: settings.latestWork.length },
        },
      });
    });
    return settings;
  });
  r.post('/send-plans', { preHandler: [requireOwner, requireStepUp] }, async (request, reply) => {
    const body = request.body as { emailIds?: unknown; country?: unknown } | null;
    const ids = body?.emailIds;
    if (ids !== undefined && (!Array.isArray(ids) || ids.length < 1 || ids.length > 50 ||
      !ids.every((id) => Number.isSafeInteger(id) && Number(id) > 0))) {
      return reply.code(400).send({ error: 'invalid_send_plan_email_ids' });
    }
    const result = await createAnnouncedSendPlan({
      country: typeof body?.country === 'string' ? body.country : undefined,
      emailIds: Array.isArray(ids) ? ids as number[] : undefined,
      createdBy: request.auth!.email,
      adminUserId: request.auth!.userId,
    });
    if ('error' in result) {
      const status = result.error === 'invalid_or_disabled_plan_market' ? 400
        : result.error === 'no_enabled_markets' || result.error === 'send_plan_email_race' ? 409
          : 409;
      return reply.code(status).send({ error: result.error });
    }
    return reply.code(201).send({
      id: result.id,
      state: result.state,
      announced_at: result.announcedAt.toISOString(),
      starts_at: result.startsAt.toISOString(),
      ends_at: result.endsAt.toISOString(),
      email_count: result.emailCount,
    });
  });
  r.post('/send-plans/:id/veto', { preHandler: [requireOwner, requireStepUp] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const plan = await prisma.sendPlan.updateMany({
      where: { id, state: { in: ['announced', 'frozen'] }, startsAt: { gt: new Date() } },
      data: { state: 'vetoed', vetoedAt: new Date() },
    });
    if (!plan.count) return reply.code(409).send({ error: 'send_plan_not_vetoable' });
    await prisma.$transaction(async (transaction) => {
      const itemRows = await transaction.sendPlanItem.findMany({ where: { sendPlanId: id }, select: { emailId: true } });
      await transaction.email.updateMany({
        where: { id: { in: itemRows.map((item) => item.emailId) }, status: { in: ['drafted', 'held', 'approved'] } },
        data: { scheduledFor: null },
      });
      await transaction.sendPlanItem.deleteMany({ where: { sendPlanId: id } });
      await transaction.auditLog.create({ data: { actorEmail: request.auth!.email, action: 'send_plan.vetoed', target: id } });
    });
    return { ok: true };
  });
  r.post('/send-plans/:id/freeze', { preHandler: [requireOwner, requireStepUp] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const plan = await prisma.sendPlan.updateMany({
      where: { id, state: 'announced', startsAt: { gt: new Date() } },
      data: { state: 'frozen', frozenAt: new Date() },
    });
    if (!plan.count) return reply.code(409).send({ error: 'send_plan_not_freezable' });
    await prisma.auditLog.create({ data: { actorEmail: request.auth!.email, action: 'send_plan.frozen', target: id } });
    return { ok: true };
  });
  r.post('/send-plans/:id/reschedule', { preHandler: [requireOwner, requireStepUp] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { startsAt?: unknown } | null;
    const startsAt = typeof body?.startsAt === 'string' ? new Date(body.startsAt) : null;
    const current = await prisma.sendPlan.findUnique({
      where: { id },
      include: { items: { include: { email: { include: { business: { select: { timezone: true } } } } } } },
    });
    const earliest = new Date(Date.now() + SEND_PLAN_MIN_NOTICE_MS);
    if (!current || !startsAt || !Number.isFinite(startsAt.getTime()) || startsAt < earliest ||
        !current.announcedAt || startsAt.getTime() - current.announcedAt.getTime() < SEND_PLAN_MIN_NOTICE_MS ||
        !['announced', 'frozen'].includes(current.state)) {
      return reply.code(400).send({ error: 'invalid_send_plan_reschedule' });
    }
    const items = current.items.map((item) => ({
      emailId: item.emailId,
      scheduledFor: nextRecipientWindow(startsAt, item.email.business?.timezone || 'UTC'),
    }));
    const endsAt = items.reduce((latest, item) => item.scheduledFor > latest ? item.scheduledFor : latest, new Date(startsAt.getTime() + 24 * 60 * 60 * 1000));
    await prisma.$transaction(async (transaction) => {
      await transaction.sendPlan.update({
        where: { id },
        data: { state: 'announced', startsAt, endsAt, frozenAt: null },
      });
      for (const item of items) {
        await transaction.email.updateMany({
          where: { id: item.emailId, status: { in: ['drafted', 'held', 'approved'] } },
          data: { scheduledFor: item.scheduledFor },
        });
      }
      await transaction.auditLog.create({
        data: { actorEmail: request.auth!.email, action: 'send_plan.rescheduled', target: id, meta: { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() } },
      });
    });
    return { ok: true, starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString() };
  });
  r.post('/leads', async (request, reply) => {
    const body = request.body as {
      name?: unknown; niche?: unknown; city?: unknown; country?: unknown; track?: unknown;
      websiteUrl?: unknown; phone?: unknown; email?: unknown; sourceUrl?: unknown;
    } | null;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const city = typeof body?.city === 'string' ? body.city.trim() : '';
    const country = typeof body?.country === 'string' ? body.country.trim().toUpperCase() : '';
    const track = body?.track;
    const niche = typeof body?.niche === 'string' ? body.niche.trim() : '';
    const phone = typeof body?.phone === 'string' ? body.phone.trim() : '';
    const websiteUrl = typeof body?.websiteUrl === 'string' ? body.websiteUrl.trim() : '';
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const sourceUrl = typeof body?.sourceUrl === 'string' ? body.sourceUrl.trim() : '';
    if (!name || name.length > 180 || !city || city.length > 120 || !/^[A-Z]{2}$/.test(country) ||
        !['site', 'no_site'].includes(String(track)) || niche.length > 120 || phone.length > 50 ||
        (track === 'site' && !websiteUrl) || (track === 'no_site' && !phone && !email)) {
      return reply.code(400).send({ error: 'invalid_lead' });
    }
    const market = await prisma.market.findUnique({ where: { code: country }, select: { enabled: true } });
    if (!market?.enabled) return reply.code(403).send({ error: 'market_not_enabled' });
    let normalizedWebsite: string | null = null;
    if (websiteUrl) {
      try {
        const parsed = new URL(websiteUrl);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
        normalizedWebsite = parsed.toString();
      } catch {
        return reply.code(400).send({ error: 'invalid_website_url' });
      }
    }
    if (email) {
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email) || !sourceUrl) {
        return reply.code(400).send({ error: 'valid_email_and_source_url_required' });
      }
      const emailDomain = email.split('@')[1]?.toLowerCase() ?? '';
      if (['mailinator.com', 'yopmail.com', 'tempmail.com', 'guerrillamail.com', '10minutemail.com', 'trashmail.com', 'dispostable.com']
        .some((domain) => emailDomain === domain || emailDomain.endsWith(`.${domain}`))) {
        return reply.code(400).send({ error: 'disposable_email_not_allowed' });
      }
      try {
        const parsedSource = new URL(sourceUrl);
        if (!['http:', 'https:'].includes(parsedSource.protocol) || parsedSource.username || parsedSource.password) throw new Error();
      } catch {
        return reply.code(400).send({ error: 'invalid_contact_source_url' });
      }
      if (['GB', 'DE', 'NL', 'IE'].includes(country) &&
          /@(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|protonmail|proton)\./i.test(email)) {
        return reply.code(400).send({ error: 'personal_email_not_allowed_in_market' });
      }
      const domain = email.split('@')[1]!;
      let hasMailRoute = false;
      try { hasMailRoute = (await resolveMx(domain)).length > 0; } catch {}
      if (!hasMailRoute) {
        try { hasMailRoute = (await lookup(domain, { all: true })).length > 0; } catch {}
      }
      if (!hasMailRoute) return reply.code(400).send({ error: 'email_domain_has_no_mail_route' });
      const [suppressed, duplicate] = await Promise.all([
        prisma.suppression.findUnique({ where: { email }, select: { email: true } }),
        prisma.contact.findFirst({ where: { email }, select: { id: true } }),
      ]);
      if (suppressed || duplicate) return reply.code(409).send({ error: 'email_suppressed_or_already_used' });
    }
    const lead = await prisma.$transaction(async (tx) => {
      const business = await tx.business.create({
        data: {
          name, niche: niche || null, city, country, track: String(track), websiteUrl: normalizedWebsite,
          phone: phone || null, status: 'new',
          callScript: track === 'no_site' ? `Hi, I found ${name} in ${city}'s public business listings. Is the person who handles your website or online bookings available?` : null,
        },
        select: { id: true },
      });
      if (email) await tx.contact.create({ data: { businessId: business.id, email, sourceUrl } });
      return business;
    });
    return reply.code(201).send({ id: lead.id });
  });
  r.get('/leads', async (request, reply) => {
    const query = request.query as { cursor?: string; track?: string; status?: string };
    const cursor = query.cursor ? Number(query.cursor) : undefined;
    if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 1)) {
      return reply.code(400).send({ error: 'invalid_cursor' });
    }
    if (query.track && !['site', 'no_site'].includes(query.track)) {
      return reply.code(400).send({ error: 'invalid_track' });
    }
    const leads = await prisma.business.findMany({
      where: {
        ...(query.track ? { track: query.track } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: { id: 'desc' },
      take: 50,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true, name: true, niche: true, city: true, country: true, track: true, status: true,
        websiteUrl: true, phone: true, timezone: true, score: true, socialOnly: true, findings: true,
        contacts: { where: { email: { not: null } }, select: { email: true }, take: 1 },
      },
    });
    return leads.map((lead) => ({ ...lead, email: lead.contacts[0]?.email ?? null, contacts: undefined }));
  });
  r.get('/leads/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const leadId = Number(id);
    if (!Number.isSafeInteger(leadId) || leadId < 1) return reply.code(400).send({ error: 'invalid_lead_id' });
    const lead = await prisma.business.findUnique({
      where: { id: leadId },
      include: {
        contacts: { select: { id: true, email: true, sourceUrl: true } },
        emails: { select: { id: true, status: true, subject: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 10 },
      },
    });
    if (!lead) return reply.code(404).send({ error: 'lead_not_found' });
    const tags = lead.osmTags && typeof lead.osmTags === 'object' && !Array.isArray(lead.osmTags)
      ? lead.osmTags as Record<string, unknown>
      : {};
    return {
      id: lead.id,
      osmId: lead.osmId,
      name: lead.name,
      niche: lead.niche,
      city: lead.city,
      country: lead.country,
      track: lead.track,
      phone: lead.phone,
      latitude: lead.latitude,
      longitude: lead.longitude,
      timezone: lead.timezone,
      socialOnly: lead.socialOnly,
      score: lead.score,
      scoreSignals: lead.scoreSignals ?? [],
      findings: lead.findings ?? [],
      status: lead.status,
      websiteUrl: lead.websiteUrl,
      callScript: lead.callScript,
      auditedAt: lead.auditedAt,
      contacts: lead.contacts,
      emails: lead.emails,
      osmUrl: lead.osmId ? `https://www.openstreetmap.org/${lead.osmId}` : null,
      mapUrl: lead.latitude !== null && lead.longitude !== null
        ? `https://www.openstreetmap.org/?mlat=${lead.latitude}&mlon=${lead.longitude}#map=16/${lead.latitude}/${lead.longitude}`
        : null,
      openingHours: typeof tags.opening_hours === 'string' ? tags.opening_hours : null,
    };
  });
  r.get('/markets', async () => {
    const markets = await prisma.market.findMany({ orderBy: [{ enabled: 'desc' }, { name: 'asc' }] });
    return Promise.all(markets.map(async (market) => {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const [businesses, audited, withEmail, sends] = await Promise.all([
        prisma.business.count({
          where: {
            country: market.code,
            createdAt: { gte: since },
            status: { in: ['review', 'queued', 'contacted', 'call_queue'] },
          },
        }),
        prisma.business.count({ where: { country: market.code, auditedAt: { not: null } } }),
        prisma.business.count({
          where: {
            country: market.code,
            status: { in: ['review', 'queued', 'contacted'] },
            contacts: { some: { email: { not: null } } },
          },
        }),
        prisma.email.count({ where: { status: 'sent', business: { is: { country: market.code } } } }),
      ]);
      const supplyData = Math.min(100, businesses * 10);
      const yieldData = audited ? Math.round((withEmail / audited) * 100) : market.emailYieldScore;
      const priorScore = (
        market.clientValueScore * 30 +
        market.leadSupplyScore * 20 +
        market.emailYieldScore * 10 +
        market.responseScore * 25 +
        market.communicationFitScore * 10
      ) / 95;
      const dataScore = (
        market.clientValueScore * 30 +
        supplyData * 20 +
        yieldData * 10 +
        market.responseScore * 25 +
        market.communicationFitScore * 10
      ) / 95;
      const evidenceWeight = sends / (sends + 150);
      const score = Math.max(0, Math.min(100, Math.round((priorScore * (1 - evidenceWeight) + dataScore * evidenceWeight) - market.compliancePenalty)));
      return {
        code: market.code,
        name: market.name,
        enabled: market.enabled,
        score,
        priorScore: Math.round(priorScore),
        evidenceWeight: Number(evidenceWeight.toFixed(2)),
        sends,
        replies: 0,
        responseEvidenceAvailable: false,
        leadsLast7Days: businesses,
        audited,
        emailFound: withEmail,
        emailYield: audited ? Math.round((withEmail / audited) * 100) : null,
        components: {
          clientValue: market.clientValueScore,
          leadSupply: supplyData,
          emailYield: yieldData,
          response: market.responseScore,
          communicationFit: market.communicationFitScore,
          compliancePenalty: market.compliancePenalty,
        },
        gdpPppPerCapita: market.gdpPppPerCapita,
        gdpReferenceYear: market.gdpReferenceYear,
        gdpUpdatedAt: market.gdpUpdatedAt,
      };
    }));
  });
  r.post('/markets/refresh-world-bank', { preHandler: [requireOwner, requireStepUp] }, async (request) => {
    const markets = await prisma.market.findMany({ select: { code: true, gdpUpdatedAt: true } });
    const refreshedRecently = markets.length > 0 && markets.every(
      (market) => market.gdpUpdatedAt && Date.now() - market.gdpUpdatedAt.getTime() < 30 * 24 * 60 * 60 * 1000,
    );
    if (refreshedRecently) return { updated: 0, cached: true };
    const codes = markets.map((market) => market.code).join(';');
    const response = await fetch(
      `https://api.worldbank.org/v2/country/${codes}/indicator/NY.GDP.PCAP.PP.CD?format=json&date=2018:2025&per_page=1000`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) },
    );
    if (!response.ok) throw new Error(`World Bank API returned HTTP ${response.status}`);
    const payload: unknown = await response.json();
    if (!Array.isArray(payload) || !Array.isArray(payload[1])) throw new Error('World Bank API returned an invalid response');
    const byCountry = new Map<string, { value: number; year: number }>();
    for (const row of payload[1]) {
      if (!row || typeof row !== 'object') continue;
      const value = row as { countryiso3code?: unknown; value?: unknown; date?: unknown };
      const code = typeof value.countryiso3code === 'string' ? value.countryiso3code : null;
      const gdp = typeof value.value === 'number' ? value.value : null;
      const year = typeof value.date === 'string' ? Number(value.date) : NaN;
      if (code && gdp && Number.isInteger(year) && !byCountry.has(code)) byCountry.set(code, { value: gdp, year });
    }
    const codeToAlpha3: Record<string, string> = {
      US: 'USA', CA: 'CAN', GB: 'GBR', AU: 'AUS', AE: 'ARE', SG: 'SGP',
      DE: 'DEU', NL: 'NLD', IE: 'IRL', NZ: 'NZL',
    };
    const observed = markets.flatMap((market) => {
      const data = byCountry.get(codeToAlpha3[market.code] ?? market.code);
      return data ? [{ code: market.code, ...data }] : [];
    });
    const logValues = observed.map((entry) => Math.log(entry.value));
    const minLog = Math.min(...logValues);
    const maxLog = Math.max(...logValues);
    const now = new Date();
    const updates = await Promise.all(observed.map((entry) => {
      const clientValueScore = maxLog === minLog
        ? 50
        : Math.round(35 + ((Math.log(entry.value) - minLog) / (maxLog - minLog)) * 65);
      return prisma.market.update({
        where: { code: entry.code },
        data: {
          gdpPppPerCapita: entry.value,
          gdpReferenceYear: entry.year,
          gdpUpdatedAt: now,
          clientValueScore,
        },
      });
    }));
    if (request.auth) {
      await prisma.auditLog.create({
        data: {
          actorEmail: request.auth.email,
          action: 'market.world_bank_refresh',
          meta: { updated: updates.length, asOf: now.toISOString() },
        },
      });
    }
    return { updated: updates.filter(Boolean).length, asOf: now.toISOString() };
  });
  r.post('/markets/:code/enabled', { preHandler: [requireOwner, requireStepUp] }, async (request, reply) => {
    const { code } = request.params as { code: string };
    const body = request.body as { enabled?: unknown } | null;
    if (!/^[A-Z]{2}$/.test(code) || typeof body?.enabled !== 'boolean') {
      return reply.code(400).send({ error: 'invalid_market_update' });
    }
    const market = await prisma.market.findUnique({ where: { code } });
    if (!market) return reply.code(404).send({ error: 'market_not_on_allowlist' });
    await prisma.market.update({ where: { code }, data: { enabled: body.enabled } });
    if (request.auth) {
      await prisma.auditLog.create({
        data: { actorEmail: request.auth.email, action: body.enabled ? 'market.enabled' : 'market.disabled', target: code },
      });
    }
    return { ok: true };
  });
  r.get('/emails/review', async (request) => {
    const signal = await autoApproveSignal();
    // Reviewers see the signature that sendDue appends, so portfolio links are visible before approval.
    const portfolio = await getPortfolioSettings().catch((error) => {
      request.log.error({ err: error }, 'Stored portfolio settings are invalid');
      return { portfolioUrl: null, latestWork: [] };
    });
    const signaturePreview = (body: string) =>
      `${portfolioEmailFooter(portfolio, body)}\n\n--\n${env.SENDER_NAME ?? ''}, ${env.POSTAL_ADDRESS ?? ''}\nTo stop receiving these emails, unsubscribe here: [one-click unsubscribe link]`.trimStart();
    const emails = await prisma.email.findMany({
      where: { status: 'drafted', business: { is: { status: 'review' } }, contact: { isNot: null } },
      orderBy: { createdAt: 'asc' },
      take: 50,
      include: {
        business: { select: { name: true, city: true, country: true, timezone: true, websiteUrl: true, findings: true, scoreSignals: true, screenshot: true } },
        contact: { select: { email: true, sourceUrl: true } },
      },
    });
    return emails.map((email) => ({
      id: email.id,
      subject: email.subject,
      body: email.body,
      name: email.business?.name,
      city: email.business?.city,
      website_url: email.business?.websiteUrl,
      findings: email.business?.findings,
      score_signals: email.business?.scoreSignals,
      to_email: email.contact?.email,
      contact_source_url: email.contact?.sourceUrl,
      manual_required: email.manualRequired,
      original_subject: email.origSubject,
      original_body: email.origBody,
      draft_angle: email.draftAngle,
      portfolio_project: email.portfolioProject,
      draft_confidence: email.draftConfidence,
      selection: email.selectionInfo ?? null,
      agent_low_risk: signal.eligible && !email.manualRequired && (email.draftConfidence ?? 0) >= 0.8,
      screenshot_data: email.business?.screenshot ? Buffer.from(email.business.screenshot).toString('base64') : null,
      signature_preview: signaturePreview(email.body ?? ''),
    }));
  });
  r.post('/emails/:id/approve', async (req, reply) => {
    const { id } = req.params as { id: string };
    const emailId = Number(id);
    const body = req.body as { subject?: unknown; body?: unknown } | null;
    if (!Number.isSafeInteger(emailId) || emailId < 1 || typeof body?.subject !== 'string' || body.subject.length > 500 || typeof body.body !== 'string' || body.body.length > 10000) {
      return reply.code(400).send({ error: 'invalid_approval' });
    }
    const subject = body.subject.trim();
    const message = body.body.trim();
    const email = await prisma.email.findFirst({
      where: { id: emailId, status: 'drafted' },
      include: {
        business: { select: { timezone: true, name: true } },
        sendPlanItems: { select: { id: true } },
      },
    });
    if (!email) return reply.code(409).send({ error: 'draft_no_longer_pending' });
    if (!subject || !message || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(subject + message)) {
      return reply.code(400).send({ error: 'invalid_approval_content' });
    }
    if (email.manualRequired && message === (email.origBody ?? '').trim()) {
      return reply.code(400).send({ error: 'manual_draft_must_be_rewritten' });
    }
    const holdMinutes = Number(env.SEND_HOLD_MINUTES ?? 30);
    const holdUntil = new Date(Date.now() + (Number.isSafeInteger(holdMinutes) && holdMinutes >= 0 ? holdMinutes : 30) * 60_000);
    let scheduledFor: Date;
    try {
      const jitteredRelease = new Date(holdUntil.getTime() + randomInt(4, 16) * 60_000);
      scheduledFor = email.sendPlanItems.length && email.scheduledFor
        ? email.scheduledFor
        : nextRecipientWindow(jitteredRelease, email.business?.timezone || 'UTC');
    } catch {
      scheduledFor = nextRecipientWindow(holdUntil, 'UTC');
    }
    const changed = await prisma.$transaction(async (transaction) => {
      const update = await transaction.email.updateMany({
        where: { id: email.id, status: 'drafted' },
        data: {
          subject,
          body: message,
          status: 'held',
          holdUntil,
          scheduledFor,
          manualRequired: false,
          error: null,
        },
      });
      if (!update.count) return false;
      await transaction.email.update({
        where: { id: email.id },
        data: { origSubject: email.origSubject ?? email.subject, origBody: email.origBody ?? email.body },
      });
      if (email.businessId !== null) {
        await transaction.business.update({
          where: { id: email.businessId },
          data: { status: 'queued', screenshot: null, screenshotExpiresAt: null },
        });
      }
      return true;
    });
    if (!changed) return reply.code(409).send({ error: 'draft_no_longer_pending' });
    if (!email.manualRequired && email.sequenceStep === 0 && email.draftConfidence !== null) {
      await recordDraftEdit(
        email.id,
        { subject: (email.origSubject ?? email.subject ?? '').trim(), body: (email.origBody ?? email.body ?? '').trim() },
        { subject, body: message },
        email.business?.name ?? null,
      ).catch((error) => req.log.error({ err: error }, 'Could not record draft edit'));
    }
    return { ok: true, held_until: holdUntil.toISOString(), scheduled_for: scheduledFor.toISOString() };
  });
  r.get('/emails/held', async () => {
    const emails = await prisma.email.findMany({
      where: { status: 'held', holdUntil: { gt: new Date() } },
      orderBy: { scheduledFor: 'asc' },
      take: 50,
      include: {
        business: { select: { name: true, timezone: true } },
        contact: { select: { email: true } },
      },
    });
    return emails.map((email) => ({
      id: email.id,
      subject: email.subject,
      name: email.business?.name,
      email: email.contact?.email,
      timezone: email.business?.timezone,
      scheduled_for: email.scheduledFor?.toISOString() ?? null,
      hold_until: email.holdUntil?.toISOString() ?? null,
    }));
  });
  r.post('/emails/:id/undo', async (req, reply) => {
    const { id } = req.params as { id: string };
    const emailId = Number(id);
    if (!Number.isSafeInteger(emailId) || emailId < 1) return reply.code(400).send({ error: 'invalid_email_id' });
    const email = await prisma.email.findFirst({
      where: { id: emailId, status: 'held', holdUntil: { gt: new Date() } },
      select: { id: true, businessId: true },
    });
    if (!email) return reply.code(409).send({ error: 'held_email_no_longer_undoable' });
    const undone = await prisma.$transaction(async (transaction) => {
      const changed = await transaction.email.updateMany({
        where: { id: email.id, status: 'held', holdUntil: { gt: new Date() } },
        data: { status: 'drafted', holdUntil: null, scheduledFor: null },
      });
      if (!changed.count) return false;
      if (email.businessId !== null) {
        await transaction.business.update({
          where: { id: email.businessId },
          data: { status: 'review' },
        });
      }
      return true;
    });
    if (!undone) return reply.code(409).send({ error: 'held_email_no_longer_undoable' });
    return { ok: true };
  });
  r.post('/emails/:id/reject', async (req, reply) => {
    const { id } = req.params as { id: string };
    const emailId = Number(id);
    if (!Number.isSafeInteger(emailId) || emailId < 1) return reply.code(400).send({ error: 'invalid_email_id' });
    const email = await prisma.email.findFirst({
      where: { id: emailId, status: 'drafted' },
      select: { id: true, businessId: true, contact: { select: { email: true } } },
    });
    if (!email) return reply.code(409).send({ error: 'draft_no_longer_pending' });
    await prisma.$transaction([
      prisma.email.update({ where: { id: email.id }, data: { status: 'rejected' } }),
      ...(email.contact?.email ? [
        prisma.suppression.upsert({
          where: { email: email.contact.email },
          update: { reason: 'manual_rejection' },
          create: { email: email.contact.email, reason: 'manual_rejection' },
        }),
        prisma.contactLedger.upsert({
          where: { email: email.contact.email },
          create: { email: email.contact.email, domain: email.contact.email.split('@')[1] ?? '', businessId: email.businessId, status: 'blocked', blockReason: 'manual_rejection' },
          update: { status: 'blocked', blockReason: 'manual_rejection' },
        }),
      ] : []),
      ...(email.businessId === null ? [] : [prisma.business.update({
        where: { id: email.businessId },
        data: { status: 'rejected', screenshot: null, screenshotExpiresAt: null },
      })]),
    ]);
    return { ok: true };
  });
  r.post('/suppress', async (req) => {
    const { email } = req.body as any;
    const normalizedEmail = String(email).toLowerCase();
    await prisma.suppression.upsert({
      where: { email: normalizedEmail },
      update: {},
      create: { email: normalizedEmail, reason: 'manual' },
    });
    return { ok: true };
  });
});

await loadActivity();
await app.listen({ port: Number(env.PORT ?? 8080), host: '0.0.0.0' });

const awakeMeter = startAwakeMeter();
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void awakeMeter.flush().finally(() => process.exit(0));
  });
}
