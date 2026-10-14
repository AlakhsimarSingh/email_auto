import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from './env.js';
import { prisma } from './db.js';

const TOKEN_ID = 'gmail_refresh_token';

function encryptionKey() {
  const encoded = env.GMAIL_TOKEN_ENCRYPTION_KEY?.trim();
  if (!encoded) throw new Error('GMAIL_TOKEN_ENCRYPTION_KEY must be configured before connecting Gmail');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('GMAIL_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  return key;
}

function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

function decrypt(secret: { ciphertext: Uint8Array; iv: Uint8Array; authTag: Uint8Array }) {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), secret.iv);
  decipher.setAuthTag(secret.authTag);
  return Buffer.concat([decipher.update(secret.ciphertext), decipher.final()]).toString('utf8');
}

async function configuredRefreshToken() {
  const stored = await prisma.integrationSecret.findUnique({ where: { id: TOKEN_ID } });
  if (stored) return decrypt(stored) || null;
  return env.GMAIL_REFRESH_TOKEN?.trim() || null;
}

export async function storeGmailRefreshToken(refreshToken: string | null) {
  const encrypted = encrypt(refreshToken ?? '');
  await prisma.integrationSecret.upsert({
    where: { id: TOKEN_ID },
    update: encrypted,
    create: { id: TOKEN_ID, ...encrypted },
  });
}

export async function revokeGmailConnection() {
  encryptionKey();
  const refreshToken = await configuredRefreshToken();
  if (refreshToken) {
    const response = await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Google could not revoke the Gmail grant (HTTP ${response.status})`);
  }
  await storeGmailRefreshToken(null);
}

export async function gmailAccessToken() {
  const refreshToken = await configuredRefreshToken();
  if (!refreshToken) throw new Error('Gmail is not connected. Connect the owner mailbox in Admin & security.');
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error('Google OAuth client configuration is required to access Gmail');
  }
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json() as { access_token?: string; error?: string };
  if (!response.ok || !data.access_token) {
    throw new Error(`Google rejected the Gmail refresh token (HTTP ${response.status}${data.error ? `: ${data.error}` : ''})`);
  }
  return data.access_token;
}

export async function verifyGmailOwner(accessToken: string) {
  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null) as { error?: { message?: string; details?: Array<{ reason?: string }> } } | null;
    const reason = detail?.error?.details?.find((item) => item.reason)?.reason ?? detail?.error?.message?.slice(0, 200);
    throw new Error(`Gmail mailbox identity could not be verified (HTTP ${response.status}${reason ? `: ${reason}` : ''})`);
  }
  const profile = await response.json() as { emailAddress?: string };
  const email = profile.emailAddress?.trim().toLowerCase();
  if (!email || email !== env.OWNER_EMAIL.toLowerCase()) {
    throw new Error('The connected Gmail mailbox does not match OWNER_EMAIL');
  }
  return email;
}

export async function gmailConnectionStatus() {
  const stored = await prisma.integrationSecret.findUnique({ where: { id: TOKEN_ID } });
  const refreshToken = stored ? decrypt(stored) : env.GMAIL_REFRESH_TOKEN?.trim();
  if (!refreshToken) return { connected: false, source: stored ? 'database' : 'none' };
  const accessToken = await gmailAccessToken();
  const email = await verifyGmailOwner(accessToken);
  return { connected: true, email, source: stored ? 'database' : 'environment' };
}
