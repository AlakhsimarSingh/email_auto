import webPush from 'web-push';
import { env } from './env.js';
import { prisma } from './db.js';

type PushKeys = { p256dh: string; auth: string };
export type PushSubscriptionInput = { endpoint: string; keys: PushKeys };
export type PushPayload = {
  title: string;
  body: string;
  tag: string;
  url: '/inbox' | '/#review-queue' | '/notifications' | '/settings#send-plans';
  notificationId?: string;
  close?: boolean;
};

const allowedEndpointHosts = [
  'fcm.googleapis.com',
  'push.services.mozilla.com',
  'web.push.apple.com',
];

export function parsePushSubscription(value: unknown): PushSubscriptionInput | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof input.endpoint !== 'string' || input.endpoint.length > 4096) return null;
  if (typeof input.keys?.p256dh !== 'string' || typeof input.keys.auth !== 'string') return null;
  if (input.keys.p256dh.length > 256 || input.keys.auth.length > 128) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(input.keys.p256dh) || !/^[A-Za-z0-9_-]+$/.test(input.keys.auth)) return null;
  try {
    const endpoint = new URL(input.endpoint);
    const allowedHost = allowedEndpointHosts.some((host) =>
      endpoint.hostname === host || (host === 'push.services.mozilla.com' && endpoint.hostname.endsWith(`.${host}`)),
    );
    if (
      endpoint.protocol !== 'https:' ||
      !allowedHost ||
      endpoint.username ||
      endpoint.password ||
      (endpoint.port && endpoint.port !== '443')
    ) return null;
    const p256dh = Buffer.from(input.keys.p256dh, 'base64url');
    const auth = Buffer.from(input.keys.auth, 'base64url');
    if (p256dh.length !== 65 || auth.length !== 16) return null;
    return { endpoint: endpoint.toString(), keys: input.keys as PushKeys };
  } catch {
    return null;
  }
}

export function pushConfiguration() {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim() ?? '';
  const privateKey = env.VAPID_PRIVATE_KEY?.trim() ?? '';
  const subject = env.VAPID_SUBJECT?.trim() ?? '';
  const configured = Boolean(publicKey && privateKey && subject);
  if ((publicKey || privateKey || subject) && !configured) {
    throw new Error('VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT must all be configured together');
  }
  if (configured) {
    const validBase64Url = /^[A-Za-z0-9_-]+$/;
    let validSubject = /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subject);
    if (!validSubject) {
      try {
        const parsedSubject = new URL(subject);
        validSubject = parsedSubject.protocol === 'https:' && Boolean(parsedSubject.hostname) &&
          !parsedSubject.username && !parsedSubject.password;
      } catch {
        validSubject = false;
      }
    }
    if (
      !validBase64Url.test(publicKey) ||
      !validBase64Url.test(privateKey) ||
      Buffer.from(publicKey, 'base64url').length !== 65 ||
      Buffer.from(privateKey, 'base64url').length !== 32 ||
      !validSubject
    ) throw new Error('VAPID keys or subject are invalid');
  }
  return { configured, publicKey: configured ? publicKey : null, privateKey, subject };
}

function sendPush(endpoint: string, keys: PushKeys, payload: string) {
  const config = pushConfiguration();
  if (!config.configured || !config.publicKey) throw new Error('Web Push is not configured');
  webPush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  return webPush.sendNotification({ endpoint, keys }, payload, { TTL: 300, urgency: 'high' });
}

export async function sendDevicePush(
  device: { id: string; endpoint: string; p256dh: string; auth: string },
  payload: PushPayload,
) {
  try {
    await sendPush(device.endpoint, { p256dh: device.p256dh, auth: device.auth }, JSON.stringify(payload));
    await prisma.pushDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
    return { ok: true as const };
  } catch (error) {
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
      ? Number(error.statusCode)
      : null;
    if (statusCode === 404 || statusCode === 410) {
      await prisma.pushDevice.deleteMany({ where: { id: device.id } });
      return { ok: false as const, expired: true };
    }
    throw error;
  }
}
