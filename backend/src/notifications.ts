import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { env } from './env.js';
import { prisma } from './db.js';
import { sendDevicePush } from './push.js';

type NotificationInput = {
  eventKey: string;
  eventType: 'reply' | 'plan' | 'digest' | 'sla' | 'health';
  priority: 0 | 1 | 2;
  title: string;
  body: string;
  url: '/inbox' | '/#review-queue' | '/notifications' | '/settings#send-plans';
  adminUserId?: number;
  digestFrequency?: 'daily' | 'weekly';
};

type StoredTarget = { chatId?: string; url?: string; token?: string };
type ChannelKind = 'telegram' | 'ntfy';

function encryptionKey() {
  const encoded = env.GMAIL_TOKEN_ENCRYPTION_KEY?.trim();
  if (!encoded) throw new Error('GMAIL_TOKEN_ENCRYPTION_KEY must be configured before saving notification channels');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('GMAIL_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  return key;
}

function encryptTarget(value: StoredTarget) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { targetCiphertext: ciphertext, targetIv: iv, targetAuthTag: cipher.getAuthTag() };
}

function decryptTarget(record: { targetCiphertext: Uint8Array; targetIv: Uint8Array; targetAuthTag: Uint8Array }): StoredTarget {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), record.targetIv);
  decipher.setAuthTag(record.targetAuthTag);
  return JSON.parse(Buffer.concat([decipher.update(record.targetCiphertext), decipher.final()]).toString('utf8')) as StoredTarget;
}

function targetHash(kind: ChannelKind, target: string) {
  return createHash('sha256').update(`${kind}:${target}`).digest('hex');
}

function telegramToken() {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  return token;
}

async function telegramApi<T>(method: string, payload?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${telegramToken()}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json() as { ok?: boolean; result?: T };
  if (!response.ok || !result.ok || result.result === undefined) {
    throw new Error(`Telegram ${method} failed with HTTP ${response.status}`);
  }
  return result.result;
}

function localClock(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    hour: Number(value('hour')),
    minute: Number(value('minute')),
    weekday: new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date),
  };
}

export function isWithinQuietHours(now: Date, timeZone: string, start: string | null, end: string | null) {
  if (!start || !end) return false;
  const match = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  if (!match(start) || !match(end) || start === end) return false;
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  const quiet = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const current = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const from = quiet(start);
  const to = quiet(end);
  return from < to ? current >= from && current < to : current >= from || current < to;
}

export function shouldAttemptDelivery(status: string, attempts: number, lastAttemptAt: Date | null, now: Date) {
  return attempts < 3 && status !== 'sent' &&
    !(status === 'sending' && lastAttemptAt && lastAttemptAt.getTime() > now.getTime() - 120_000);
}

export function validNtfyTarget(urlValue: unknown, tokenValue: unknown) {
  if (typeof urlValue !== 'string' || urlValue.length > 300 || typeof tokenValue !== 'string' || tokenValue.length > 512) return null;
  try {
    const url = new URL(urlValue.trim());
    const topic = url.pathname.replace(/^\/+|\/+$/g, '');
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'ntfy.sh' ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(topic)
    ) return null;
    return { url: `https://ntfy.sh/${topic}`, token: tokenValue.trim() || undefined };
  } catch {
    return null;
  }
}

export async function createNtfyChannel(adminUserId: number, urlValue: unknown, tokenValue: unknown) {
  const target = validNtfyTarget(urlValue, tokenValue);
  if (!target) throw new Error('Use an HTTPS ntfy.sh topic with a long, private topic name.');
  const hash = targetHash('ntfy', target.url);
  const stored = await prisma.notificationChannel.upsert({
    where: { adminUserId_type_targetHash: { adminUserId, type: 'ntfy', targetHash: hash } },
    create: {
      adminUserId,
      type: 'ntfy',
      label: 'ntfy · private topic',
      targetHash: hash,
      ...encryptTarget(target),
    },
    update: { enabled: true, ...encryptTarget(target) },
    select: { id: true, type: true, label: true, enabled: true },
  });
  return stored;
}

export async function createTelegramLink(adminUserId: number) {
  const backendOrigin = env.BACKEND_PUBLIC_URL?.trim();
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!backendOrigin || !webhookSecret) throw new Error('Set BACKEND_PUBLIC_URL and TELEGRAM_WEBHOOK_SECRET before linking Telegram.');
  const parsedOrigin = new URL(backendOrigin);
  if (parsedOrigin.protocol !== 'https:' || parsedOrigin.username || parsedOrigin.password || parsedOrigin.search || parsedOrigin.hash) {
    throw new Error('BACKEND_PUBLIC_URL must be a public HTTPS backend origin.');
  }
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(webhookSecret)) throw new Error('TELEGRAM_WEBHOOK_SECRET must use 1-256 letters, numbers, underscores, or hyphens.');

  const bot = await telegramApi<{ username?: string }>('getMe');
  if (!bot.username) throw new Error('The Telegram bot did not return a public username.');
  const webhookUrl = new URL('/internal/telegram/webhook', parsedOrigin).toString();
  await telegramApi('setWebhook', {
    url: webhookUrl,
    secret_token: webhookSecret,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: false,
  });
  const token = randomBytes(24).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const now = new Date();
  await prisma.notificationLinkToken.deleteMany({ where: { adminUserId, expiresAt: { lte: now } } });
  await prisma.notificationLinkToken.create({
    data: { adminUserId, tokenHash, expiresAt: new Date(now.getTime() + 10 * 60_000) },
  });
  return { url: `https://t.me/${bot.username}?start=${token}`, expiresInSeconds: 600 };
}

function hmacEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

async function acknowledge(id: string, actor: string) {
  const changed = await prisma.workspaceNotification.updateMany({
    where: { id, acknowledgedAt: null },
    data: { acknowledgedAt: new Date(), acknowledgedBy: actor.slice(0, 254) },
  });
  if (!changed.count) return false;
  const devices = await prisma.pushDevice.findMany({
    where: { enabled: true, session: { revokedAt: null, expiresAt: { gt: new Date() } } },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });
  await Promise.allSettled(devices.map((device) => sendDevicePush(device, {
    title: '',
    body: '',
    tag: `workspace-${id}`,
    url: '/notifications',
    notificationId: id,
    close: true,
  })));
  return true;
}

async function sendChannelMessage(
  channel: {
    id: string;
    type: string;
    targetCiphertext: Uint8Array;
    targetIv: Uint8Array;
    targetAuthTag: Uint8Array;
  },
  notification: { id: string; title: string; body: string; url: string },
  escalation: boolean,
) {
  const target = decryptTarget(channel);
  const title = escalation ? `Unacknowledged: ${notification.title}` : notification.title;
  const body = escalation ? `${notification.body} Please acknowledge in the workspace.` : notification.body;
  if (channel.type === 'telegram' && target.chatId) {
    const result = await telegramApi<{ message_id?: number }>('sendMessage', {
      chat_id: target.chatId,
      text: `${title}\n${body}`,
      reply_markup: {
        inline_keyboard: [[{ text: 'Open workspace', url: new URL(notification.url, env.APP_ORIGIN).toString() }], [
          { text: 'Acknowledge', callback_data: `ack:${notification.id}` },
        ]],
      },
      disable_web_page_preview: true,
    });
    return result.message_id ? String(result.message_id) : null;
  }
  if (channel.type === 'ntfy' && target.url) {
    const headers = new Headers({
      'content-type': 'text/plain; charset=utf-8',
      'X-Title': title.slice(0, 100),
      'X-Tags': notification.id.replace(/-/g, '').slice(0, 16),
      'X-Priority': escalation ? '5' : '4',
      'Click': new URL(notification.url, env.APP_ORIGIN).toString(),
    });
    if (target.token) headers.set('Authorization', `Bearer ${target.token}`);
    const response = await fetch(target.url, {
      method: 'POST',
      headers,
      body: body.slice(0, 300),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`ntfy delivery failed with HTTP ${response.status}`);
    return response.headers.get('X-Request-Id');
  }
  throw new Error('Notification channel target is invalid');
}

async function deliver(
  notification: { id: string; eventType: string; priority: number; title: string; body: string; url: string },
  escalation = false,
  adminUserId?: number,
  digestFrequency?: 'daily' | 'weekly',
) {
  const now = new Date();
  const timezone = env.NOTIFICATION_TIMEZONE?.trim() || 'Asia/Kolkata';
  const devices = await prisma.pushDevice.findMany({
    where: {
      enabled: true,
      muted: false,
      ...(adminUserId ? { adminUserId } : {}),
      session: { revokedAt: null, expiresAt: { gt: now } },
      adminUser: { role: { in: ['owner', 'admin'] } },
    },
    select: {
      id: true, adminUserId: true, endpoint: true, p256dh: true, auth: true,
      isPrimary: true, quietStart: true, quietEnd: true,
      notifyReplies: true, notifyPlans: true, notifyDigest: true, digestFrequency: true,
    },
  });
  const channels = await prisma.notificationChannel.findMany({
    where: { enabled: true, muted: false, ...(adminUserId ? { adminUserId } : {}) },
    select: {
      id: true, adminUserId: true, type: true, targetCiphertext: true, targetIv: true, targetAuthTag: true,
      isPrimary: true, quietStart: true, quietEnd: true,
      notifyReplies: true, notifyPlans: true, notifyDigest: true, digestFrequency: true,
    },
  });
  const accepts = (target: {
    isPrimary: boolean;
    quietStart: string | null;
    quietEnd: string | null;
    notifyReplies: boolean;
    notifyPlans: boolean;
    notifyDigest: boolean;
    digestFrequency: string;
  }) => {
    if (notification.priority === 0) return true;
    if (notification.eventType === 'reply' && !target.notifyReplies) return false;
    if (notification.eventType === 'sla' && !target.notifyReplies) return false;
    if (notification.eventType === 'plan' && !target.notifyPlans) return false;
    if (notification.eventType === 'digest' && (!target.notifyDigest || !target.isPrimary)) return false;
    if (notification.eventType !== 'digest' && notification.priority === 2 && !target.isPrimary) return false;
    if (notification.eventType === 'digest' && target.digestFrequency === 'off') return false;
    if (notification.eventType === 'digest' && digestFrequency && target.digestFrequency !== digestFrequency) return false;
    if (notification.priority > 0 && isWithinQuietHours(now, timezone, target.quietStart, target.quietEnd)) return false;
    return true;
  };

  const targets = [
    ...devices.filter(accepts).map((device) => ({ kind: 'device' as const, id: device.id, target: device })),
    ...channels.filter(accepts).map((channel) => ({ kind: 'channel' as const, id: channel.id, target: channel })),
  ];
  const suffix = escalation ? ':escalation' : '';
  await Promise.all(targets.map(async ({ kind, id, target }) => {
    const idempotencyKey = `${notification.id}:${kind}:${id}${suffix}`;
    const delivery = await prisma.notificationDelivery.upsert({
      where: { idempotencyKey },
      create: {
        idempotencyKey,
        notificationId: notification.id,
        ...(kind === 'device' ? { deviceId: id } : { channelId: id }),
      },
      update: {},
      select: { id: true, status: true, attempts: true, lastAttemptAt: true },
    });
    if (!shouldAttemptDelivery(delivery.status, delivery.attempts, delivery.lastAttemptAt, now)) return;
    const claimed = await prisma.notificationDelivery.updateMany({
      where: {
        id: delivery.id,
        attempts: { lt: 3 },
        OR: [
          { status: { in: ['pending', 'failed'] } },
          { status: 'sending', lastAttemptAt: null },
          { status: 'sending', lastAttemptAt: { lte: new Date(now.getTime() - 120_000) } },
        ],
      },
      data: { status: 'sending', lastError: null, lastAttemptAt: now, attempts: { increment: 1 } },
    });
    if (!claimed.count) return;
    try {
      let externalMessageId: string | null = null;
      if (kind === 'device') {
        const result = await sendDevicePush(target, {
          title: escalation ? `Unacknowledged: ${notification.title}` : notification.title,
          body: escalation ? `${notification.body} Open the workspace to review.` : notification.body,
          tag: `workspace-${notification.id}`,
          url: notification.url as '/inbox' | '/#review-queue' | '/notifications',
          notificationId: notification.id,
        });
        if (!result.ok) return;
      } else {
        externalMessageId = await sendChannelMessage(target, notification, escalation);
      }
      await prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: { status: 'sent', sentAt: new Date(), externalMessageId },
      });
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number(error.statusCode)
        : null;
      const message = error instanceof Error ? error.message : 'Unknown notification delivery failure';
      await prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: { status: 'failed', lastError: `${message.slice(0, 140)}${code ? ` (${code})` : ''}` },
      });
      console.error('[notifications] channel delivery failed', { notificationId: notification.id, targetId: id, kind, statusCode: code });
    }
  }));
}

export async function dispatchNotification(input: NotificationInput) {
  const notification = await prisma.workspaceNotification.upsert({
    where: { eventKey: input.eventKey },
    create: {
      eventKey: input.eventKey,
      eventType: input.eventType,
      priority: input.priority,
      title: input.title.slice(0, 100),
      body: input.body.slice(0, 300),
      url: input.url,
    },
    update: {},
  });
  if (!notification.acknowledgedAt) await deliver(notification, false, input.adminUserId, input.digestFrequency);
  return notification;
}

export async function acknowledgeWorkspaceNotification(id: string, actor: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return false;
  return acknowledge(id, actor);
}

export async function testNotificationChannel(channelId: string, adminUserId: number) {
  const channel = await prisma.notificationChannel.findFirst({
    where: { id: channelId, adminUserId, enabled: true },
    select: { id: true, type: true, targetCiphertext: true, targetIv: true, targetAuthTag: true },
  });
  if (!channel) return false;
  await sendChannelMessage(channel, {
    id: randomUUID(),
    title: 'Test notification',
    body: 'Notifications are connected to this channel.',
    url: '/notifications',
  }, false);
  return true;
}

export async function removeNotificationChannel(channelId: string, adminUserId: number) {
  const result = await prisma.notificationChannel.deleteMany({ where: { id: channelId, adminUserId } });
  return result.count > 0;
}

export async function telegramWebhookConfigured(requestSecret: string) {
  const expected = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  return Boolean(expected && hmacEqual(requestSecret, expected));
}

export async function processTelegramUpdate(value: unknown) {
  if (!value || typeof value !== 'object') return;
  const update = value as {
    message?: { text?: unknown; chat?: { id?: unknown; type?: unknown } };
    callback_query?: { id?: unknown; data?: unknown; message?: { chat?: { id?: unknown } } };
  };
  const chatId = update.message?.chat?.id;
  const text = update.message?.text;
  if (
    update.message?.chat?.type === 'private' &&
    (typeof chatId === 'number' || typeof chatId === 'string') &&
    typeof text === 'string'
  ) {
    const match = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{24,64})$/.exec(text.trim());
    if (match) {
      const tokenHash = createHash('sha256').update(match[1]).digest('hex');
      const link = await prisma.notificationLinkToken.findFirst({
        where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
      });
      if (!link) {
        await telegramApi('sendMessage', { chat_id: chatId, text: 'That link is invalid or expired. Generate a fresh Telegram link in your workspace settings.' });
        return;
      }
      const key = String(chatId);
      const hash = targetHash('telegram', key);
      const linked = await prisma.$transaction(async (transaction) => {
        const consumed = await transaction.notificationLinkToken.updateMany({
          where: { id: link.id, usedAt: null, expiresAt: { gt: new Date() } },
          data: { usedAt: new Date() },
        });
        if (!consumed.count) return false;
        await transaction.notificationChannel.upsert({
          where: { adminUserId_type_targetHash: { adminUserId: link.adminUserId, type: 'telegram', targetHash: hash } },
          create: {
            adminUserId: link.adminUserId,
            type: 'telegram',
            label: 'Telegram chat',
            targetHash: hash,
            ...encryptTarget({ chatId: key }),
          },
          update: { enabled: true, ...encryptTarget({ chatId: key }) },
        });
        return true;
      });
      if (!linked) {
        await telegramApi('sendMessage', { chat_id: chatId, text: 'That link is invalid or expired. Generate a fresh Telegram link in your workspace settings.' });
        return;
      }
      await telegramApi('sendMessage', { chat_id: chatId, text: 'EmailAuto notifications are connected. You can return to the workspace.' });
    }
  }

  const callback = update.callback_query;
  if (typeof callback?.id === 'string' && typeof callback.data === 'string' && callback.data.startsWith('ack:')) {
    const callbackChatId = callback.message?.chat?.id;
    if (typeof callbackChatId === 'number' || typeof callbackChatId === 'string') {
      const hash = targetHash('telegram', String(callbackChatId));
      const channel = await prisma.notificationChannel.findFirst({
        where: { type: 'telegram', targetHash: hash, enabled: true },
        select: { adminUserId: true },
      });
      const notificationId = callback.data.slice(4);
      if (channel && await acknowledgeWorkspaceNotification(notificationId, `telegram-admin-${channel.adminUserId}`)) {
        await telegramApi('answerCallbackQuery', { callback_query_id: callback.id, text: 'Acknowledged on your workspace devices.' });
      } else {
        await telegramApi('answerCallbackQuery', { callback_query_id: callback.id, text: 'Already acknowledged or no longer available.' });
      }
    }
  }
}

async function localDigestForAdmin(adminUserId: number, now: Date) {
  const timezone = env.NOTIFICATION_TIMEZONE?.trim() || 'Asia/Kolkata';
  const local = localClock(now, timezone);
  const target = env.NOTIFICATION_DIGEST_TIME?.trim() || '08:30';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(target)) throw new Error('NOTIFICATION_DIGEST_TIME must be HH:MM');
  const currentMinutes = local.hour * 60 + local.minute;
  const targetMinutes = Number(target.slice(0, 2)) * 60 + Number(target.slice(3));
  if (currentMinutes < targetMinutes) return;
  const frequencies = local.weekday === 'Mon' ? ['daily', 'weekly'] as const : ['daily'] as const;
  for (const frequency of frequencies) {
    const [channels, devices] = await Promise.all([
      prisma.notificationChannel.count({
        where: { adminUserId, enabled: true, muted: false, isPrimary: true, notifyDigest: true, digestFrequency: frequency },
      }),
      prisma.pushDevice.count({
        where: {
          adminUserId,
          enabled: true,
          muted: false,
          notifyDigest: true,
          digestFrequency: frequency,
          isPrimary: true,
          session: { revokedAt: null, expiresAt: { gt: now } },
        },
      }),
    ]);
    if (!channels && !devices) continue;
    const weekly = frequency === 'weekly';
    const since = new Date(now.getTime() - (weekly ? 7 : 1) * 24 * 60 * 60 * 1000);
    const [drafts, openReplies, sends, replyCount, announcedPlans] = await Promise.all([
      prisma.email.count({ where: { status: 'drafted', createdAt: { gte: since } } }),
      prisma.replyRecord.count({ where: { classification: 'human', handledAt: null } }),
      prisma.email.count({ where: { status: 'sent', sentAt: { gte: since } } }),
      prisma.replyRecord.count({ where: { classification: 'human', receivedAt: { gte: since } } }),
      prisma.sendPlan.count({ where: { state: 'announced', endsAt: { gte: now } } }),
    ]);
    await dispatchNotification({
      eventKey: `digest:${local.date}:${frequency}:${adminUserId}`,
      eventType: 'digest',
      priority: 2,
      title: weekly ? 'Weekly outreach digest' : 'Daily outreach digest',
      body: `${weekly ? 'past week' : 'past 24 hours'}: ${sends} sent, ${replyCount} replies, ${drafts} drafts. ${openReplies} replies need attention; ${announcedPlans} send plans are active.`,
      url: '/notifications',
      adminUserId,
      digestFrequency: frequency,
    });
  }
}

export async function runNotificationMaintenance(now = new Date()) {
  const escalationMinutes = Number(env.NOTIFICATION_ESCALATION_MINUTES ?? 15);
  if (!Number.isSafeInteger(escalationMinutes) || escalationMinutes < 5 || escalationMinutes > 1440) {
    throw new Error('NOTIFICATION_ESCALATION_MINUTES must be between 5 and 1440');
  }
  const escalationBefore = new Date(now.getTime() - escalationMinutes * 60_000);
  const dueEscalations = await prisma.workspaceNotification.findMany({
    where: { priority: 0, acknowledgedAt: null, escalatedAt: null, createdAt: { lte: escalationBefore } },
    take: 50,
  });
  for (const notification of dueEscalations) {
    await deliver(notification, true);
    await prisma.workspaceNotification.updateMany({
      where: { id: notification.id, acknowledgedAt: null, escalatedAt: null },
      data: { escalatedAt: now },
    });
  }

  const retryableNotifications = await prisma.workspaceNotification.findMany({
    where: {
      acknowledgedAt: null,
      createdAt: { gte: new Date(now.getTime() - 7 * 24 * 60 * 60_000) },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  for (const notification of retryableNotifications) {
    await deliver(notification);
  }

  const staleReplies = await prisma.replyRecord.findMany({
    where: { classification: 'human', handledAt: null, receivedAt: { lte: new Date(now.getTime() - 4 * 60 * 60_000) } },
    select: { id: true },
    take: 50,
  });
  for (const record of staleReplies) {
    await dispatchNotification({
      eventKey: `reply-sla:${record.id}`,
      eventType: 'sla',
      priority: 0,
      title: 'Reply needs attention',
      body: 'A reply has been waiting for more than four hours. Review the inbox.',
      url: '/inbox',
    });
  }

  const soon = new Date(now.getTime() + 60 * 60_000);
  const plans = await prisma.sendPlan.findMany({
    where: { state: 'announced', startsAt: { gt: now, lte: soon } },
    select: { id: true },
    take: 50,
  });
  const owner = await prisma.adminUser.findFirst({ where: { role: 'owner' }, select: { id: true } });
  if (owner) {
    for (const plan of plans) {
      await dispatchNotification({
        eventKey: `plan-reminder:${plan.id}`,
        eventType: 'plan',
        priority: 0,
        title: 'Send plan starts soon',
        body: 'An announced send plan is scheduled to start within the next hour.',
        url: '/notifications',
        adminUserId: owner.id,
      });
    }
  }

  const admins = await prisma.adminUser.findMany({
    where: {
      OR: [
        { notificationChannels: { some: { enabled: true, notifyDigest: true, digestFrequency: { not: 'off' } } } },
        { pushDevices: { some: { enabled: true, isPrimary: true, notifyDigest: true, session: { revokedAt: null, expiresAt: { gt: now } } } } },
      ],
    },
    select: { id: true },
    take: 100,
  });
  for (const admin of admins) {
    await localDigestForAdmin(admin.id, now);
  }

  const retentionKey = 'notification_retention_last_run';
  const retentionDay = localClock(now, 'UTC').date;
  const lastRetention = await prisma.appSetting.findUnique({ where: { key: retentionKey }, select: { value: true } });
  if (lastRetention?.value !== retentionDay) {
    await prisma.$transaction([
      prisma.workspaceNotification.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 180 * 24 * 60 * 60_000) } } }),
      prisma.notificationLinkToken.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 30 * 24 * 60 * 60_000) } } }),
      prisma.seedTestRecord.deleteMany({ where: { testedAt: { lt: new Date(now.getTime() - 365 * 24 * 60 * 60_000) } } }),
      prisma.appSetting.upsert({
        where: { key: retentionKey },
        create: { key: retentionKey, value: retentionDay },
        update: { value: retentionDay },
      }),
    ]);
  }
}

export async function notifyAdminsOfReply(eventKey: string) {
  await dispatchNotification({
    eventKey: `reply:${eventKey}`,
    eventType: 'reply',
    priority: 1,
    title: 'A reply is waiting',
    body: 'Open the inbox to review a new reply.',
    url: '/inbox',
  });
}

export async function notifySendPlanAnnounced(
  planId: string,
  adminUserId: number,
  details: {
    country: string;
    businessCount: number;
    needsReviewCount: number;
    localStart: string;
    windowSource: 'default' | 'market-history';
  },
) {
  await dispatchNotification({
    eventKey: `send-plan-announced:${planId}`,
    eventType: 'plan',
    priority: 0,
    title: `${details.country} send plan · ${details.businessCount} businesses`,
    body: `${details.localStart} local time. ${details.needsReviewCount} ${details.needsReviewCount === 1 ? 'draft needs' : 'drafts need'} review before the planned send. ${
      details.windowSource === 'market-history' ? 'Timing follows your market’s reply history.' : 'Using the default morning engagement window.'
    } Open Send Plans in Settings to review the businesses.`,
    url: '/settings#send-plans',
    adminUserId,
  });
}

export async function ntfyConfiguredTarget(urlValue: unknown, tokenValue: unknown) {
  const target = validNtfyTarget(urlValue, tokenValue);
  if (!target) return null;
  const response = await fetch(target.url, {
    method: 'HEAD',
    headers: target.token ? { authorization: `Bearer ${target.token}` } : undefined,
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 401 || response.status === 403) throw new Error('ntfy could not authenticate this private topic');
  if (!response.ok && response.status !== 405) throw new Error(`ntfy topic check failed with HTTP ${response.status}`);
  return target;
}
