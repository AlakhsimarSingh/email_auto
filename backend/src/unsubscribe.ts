import { createHash, randomBytes } from 'node:crypto';
import { env } from './env.js';
import { prisma } from './db.js';

export async function unsubscribeToken(email: string) {
  const normalized = email.trim().toLowerCase();
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  await prisma.unsubscribeToken.create({ data: { tokenHash, email: normalized } });
  return token;
}

export async function verifyUnsubscribeToken(token: string) {
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) return null;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const record = await prisma.unsubscribeToken.findUnique({
    where: { tokenHash },
    select: { email: true },
  });
  return record?.email ?? null;
}

export async function unsubscribeUrl(email: string) {
  const origin = env.APP_ORIGIN?.trim();
  if (!origin) throw new Error('APP_ORIGIN must be configured before sending');
  const url = new URL(`/api/unsubscribe/${await unsubscribeToken(email)}`, origin);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    throw new Error('Live one-click unsubscribe requires an HTTPS APP_ORIGIN');
  }
  return url.toString();
}
