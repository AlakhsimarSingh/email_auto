import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { SignJWT, createRemoteJWKSet, jwtVerify } from 'jose';
import { env } from './env.js';
import { prisma } from './db.js';
import { ensureConfiguredOwner } from './owner.js';
import { gmailAccessToken, gmailConnectionStatus, revokeGmailConnection, storeGmailRefreshToken, verifyGmailOwner } from './gmail.js';

const ADMIN_SESSION_DAYS = 14;
const OWNER_SESSION_DAYS = 90;
const OTP_MINUTES = 10;
const MAX_OTP_ATTEMPTS = 5;
const OTP_REQUEST_COOLDOWN_MS = 60_000;
const OTP_MAX_REQUESTS_PER_EMAIL_PER_HOUR = 5;
const OTP_MAX_REQUESTS_PER_IP_PER_HOUR = 30;
const SESSION_ISSUER = 'email-automator';
const SESSION_AUDIENCE = 'email-automator-backend';
const googleJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export type AuthContext = {
  sessionId: string;
  userId: number;
  email: string;
  role: string;
  stepUpUntil: Date | null;
};

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

type GoogleIdentity = { email: string; sub: string; issuedAt: number };

function sessionDays(role: string) {
  return role === 'owner' ? OWNER_SESSION_DAYS : ADMIN_SESSION_DAYS;
}

function secret(name: 'SESSION_SECRET' | 'OTP_PEPPER') {
  const value = env[name]?.trim();
  if (!value || value.length < 32 || value.startsWith('change-me')) {
    throw new Error(`${name} must be configured with at least 32 random characters`);
  }
  return value;
}

function sessionKey() {
  return new TextEncoder().encode(secret('SESSION_SECRET'));
}

function otpDigest(email: string, code: string) {
  return createHmac('sha256', secret('OTP_PEPPER')).update(`${email}:${code}`).digest();
}

function hmacText(value: string) {
  return createHmac('sha256', secret('OTP_PEPPER')).update(value).digest('hex');
}

function deviceLabel(request: FastifyRequest) {
  const userAgent = String(request.headers['user-agent'] ?? '').replace(/[\r\n]/g, '').slice(0, 180);
  return userAgent || 'Unknown device';
}

function normalizeEmail(value: unknown) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function webAuthnConfig() {
  const appOrigin = env.APP_ORIGIN?.trim();
  if (!appOrigin) throw new Error('APP_ORIGIN must be set to the public frontend origin for passkeys');
  const origin = new URL(appOrigin).origin;
  const hostname = new URL(origin).hostname;
  const rpID = env.WEBAUTHN_RP_ID?.trim() || hostname;
  if (hostname !== rpID && !hostname.endsWith(`.${rpID}`)) {
    throw new Error('WEBAUTHN_RP_ID must match APP_ORIGIN or be one of its parent domains');
  }
  if (new URL(origin).protocol !== 'https:' && hostname !== 'localhost') {
    throw new Error('Passkeys require HTTPS outside localhost');
  }
  return { origin, rpID };
}

async function storePasskeyChallenge(
  challenge: string,
  purpose: string,
  adminUserId: number | null,
  sessionId: string | null,
  requestIpHash: string,
) {
  const now = new Date();
  await prisma.passkeyChallenge.deleteMany({ where: { expiresAt: { lte: now } } });
  return prisma.passkeyChallenge.create({
    data: {
      id: randomUUID(),
      challenge,
      purpose,
      adminUserId,
      sessionId,
      requestIpHash,
      expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
    },
  });
}

async function googleIdentity(credential: unknown): Promise<GoogleIdentity | null> {
  if (typeof credential !== 'string' || credential.length > 8192) return null;
  try {
    const { payload } = await jwtVerify(credential, googleJwks, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: env.GOOGLE_CLIENT_ID,
    });
    if (
      payload.email_verified !== true ||
      typeof payload.email !== 'string' ||
      typeof payload.sub !== 'string' ||
      typeof payload.iat !== 'number'
    ) return null;
    return { email: payload.email.toLowerCase(), sub: payload.sub, issuedAt: payload.iat };
  } catch {
    return null;
  }
}

async function createSession(request: FastifyRequest, userId: number, email: string, role: string) {
  const id = randomUUID();
  const now = new Date();
  const expiresIn = sessionDays(role) * 24 * 60 * 60;
  const token = await signSessionToken(id, email, role);
  await prisma.authSession.create({
    data: {
      id,
      adminUserId: userId,
      deviceLabel: deviceLabel(request),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + expiresIn * 1000),
    },
  });
  return { token, expiresIn };
}

function signSessionToken(id: string, email: string, role: string) {
  return new SignJWT({ email, role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(id)
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${sessionDays(role)}d`)
    .sign(sessionKey());
}

function sendSession(reply: FastifyReply, session: { token: string; expiresIn: number }) {
  return reply.send(session);
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  const authorization = String(request.headers.authorization ?? '');
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match) return reply.code(401).send({ error: 'unauthorized' });

  let sessionId: string;
  try {
    const { payload } = await jwtVerify(match[1], sessionKey(), {
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
    });
    if (typeof payload.sub !== 'string') return reply.code(401).send({ error: 'unauthorized' });
    sessionId = payload.sub;
  } catch {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  const now = new Date();
  const session = await prisma.authSession.findUnique({
    where: { id: sessionId },
    include: { adminUser: { select: { id: true, email: true, role: true } } },
  });
  if (!session || session.revokedAt || session.expiresAt <= now) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  await prisma.authSession.update({
    where: { id: session.id },
    data: {
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + sessionDays(session.adminUser.role) * 24 * 60 * 60 * 1000),
    },
  });
  request.auth = {
    sessionId: session.id,
    userId: session.adminUser.id,
    email: session.adminUser.email,
    role: session.adminUser.role,
    stepUpUntil: session.stepUpUntil,
  };
  reply.header('x-session-token', await signSessionToken(session.id, session.adminUser.email, session.adminUser.role));
  reply.header('x-session-expires-in', String(sessionDays(session.adminUser.role) * 24 * 60 * 60));
}

export async function requireOwner(request: FastifyRequest, reply: FastifyReply) {
  if (request.auth?.role !== 'owner') return reply.code(403).send({ error: 'forbidden' });
}

export async function requireStepUp(request: FastifyRequest, reply: FastifyReply) {
  if (!request.auth?.stepUpUntil || request.auth.stepUpUntil <= new Date()) {
    return reply.code(403).send({ error: 'step_up_required' });
  }
}

async function sendOtp(email: string, code: string) {
  const accessToken = await gmailAccessToken();
  const message = [
    `From: ${env.OWNER_EMAIL}`,
    `To: ${email}`,
    'Subject: Your EmailAuto sign-in code',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    `Your EmailAuto sign-in code is ${code}. It expires in ${OTP_MINUTES} minutes. If you did not request it, ignore this email.`,
  ].join('\r\n');
  const sendResponse = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ raw: Buffer.from(message).toString('base64url') }),
    signal: AbortSignal.timeout(15000),
  });
  if (!sendResponse.ok) {
    throw new Error(`Gmail could not deliver the admin sign-in code (HTTP ${sendResponse.status})`);
  }
}

function gmailRedirectUri() {
  const origin = env.APP_ORIGIN?.trim();
  if (!origin) throw new Error('APP_ORIGIN must be configured before connecting Gmail');
  return new URL('/api/gmail/callback', origin).toString();
}

export async function registerAuthRoutes(app: FastifyInstance) {
  app.decorateRequest('auth', null);
  secret('SESSION_SECRET');
  secret('OTP_PEPPER');
  await ensureConfiguredOwner();

  app.post('/auth/google', async (request, reply) => {
    const body = request.body as { credential?: unknown } | null;
    const identity = await googleIdentity(body?.credential);
    if (!identity) return reply.code(401).send({ error: 'bad credential' });

    const ownerEmail = env.OWNER_EMAIL.toLowerCase();
    let user = await prisma.adminUser.findUnique({ where: { email: identity.email } });
    if (identity.email === ownerEmail) {
      if (!user) {
        user = await prisma.adminUser.create({ data: { email: ownerEmail, role: 'owner' } });
      }
      const configuredSub = env.OWNER_GOOGLE_SUB?.trim();
      if (configuredSub && configuredSub !== identity.sub) return reply.code(403).send({ error: 'not allowed' });
      if (!user.googleSub) {
        await prisma.adminUser.updateMany({
          where: { id: user.id, googleSub: null, role: 'owner' },
          data: { googleSub: identity.sub },
        });
        user = await prisma.adminUser.findUnique({ where: { id: user.id } });
      }
      if (!user || user.role !== 'owner' || user.googleSub !== identity.sub) {
        return reply.code(403).send({ error: 'not allowed' });
      }
    } else if (!user || user.role !== 'admin') {
      return reply.code(403).send({ error: 'not allowed' });
    }

    const session = await createSession(request, user.id, user.email, user.role);
    await prisma.auditLog.create({
      data: {
        actorEmail: user.email,
        action: 'auth.google.sign_in',
        target: session.token ? 'session' : null,
        meta: { method: 'google', device: deviceLabel(request) },
      },
    });
    return sendSession(reply, session);
  });

  app.post('/auth/otp/request', async (request, reply) => {
    const body = request.body as { email?: unknown } | null;
    const email = normalizeEmail(body?.email);
    const generic = { message: 'If this email is allowed, a sign-in code was sent.' };
    if (!email) return reply.send(generic);

    const ipHash = hmacText(request.ip);
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const emailHash = hmacText(email);
    const rateLimit = await prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'email:' + emailHash}, 0))`;
      await transaction.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'ip:' + ipHash}, 0))`;
      const [user, recentEmailRequests, recentIpRequests, recentEmailCooldown] = await Promise.all([
        transaction.adminUser.findUnique({ where: { email }, select: { id: true, role: true } }),
        transaction.authOtpRequest.count({ where: { emailHash, createdAt: { gte: since } } }),
        transaction.authOtpRequest.count({ where: { requestIpHash: ipHash, createdAt: { gte: since } } }),
        transaction.authOtpRequest.findFirst({ where: { emailHash }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      ]);
      const limited =
        recentEmailRequests >= OTP_MAX_REQUESTS_PER_EMAIL_PER_HOUR ||
        recentIpRequests >= OTP_MAX_REQUESTS_PER_IP_PER_HOUR ||
        (recentEmailCooldown && Date.now() - recentEmailCooldown.createdAt.getTime() < OTP_REQUEST_COOLDOWN_MS);
      if (limited) return { limited: true, user: null };

      await transaction.authOtpRequest.create({ data: { id: randomUUID(), emailHash, requestIpHash: ipHash } });
      const expiredBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
      await Promise.all([
        transaction.authOtpRequest.deleteMany({ where: { createdAt: { lt: expiredBefore } } }),
        transaction.authOtp.deleteMany({ where: { createdAt: { lt: expiredBefore } } }),
      ]);
      return { limited: false, user };
    });
    if (rateLimit.limited || !rateLimit.user || rateLimit.user.role !== 'admin') return reply.send(generic);

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const otp = await prisma.authOtp.create({
      data: {
        id: randomUUID(),
        email,
        codeHmac: otpDigest(email, code).toString('hex'),
        requestIpHash: ipHash,
        expiresAt: new Date(Date.now() + OTP_MINUTES * 60 * 1000),
      },
    });
    try {
      await sendOtp(email, code);
    } catch (error) {
      await prisma.authOtp.update({ where: { id: otp.id }, data: { usedAt: new Date() } });
      request.log.error({ err: error, event: 'otp_delivery_failed' }, 'Could not send admin sign-in code');
    }
    return reply.send(generic);
  });

  app.post('/auth/otp/verify', async (request, reply) => {
    const body = request.body as { email?: unknown; code?: unknown } | null;
    const email = normalizeEmail(body?.email);
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!email || !/^\d{6}$/.test(code)) return reply.code(401).send({ error: 'invalid_or_expired_code' });

    const now = new Date();
    const otp = await prisma.authOtp.findFirst({
      where: { email, usedAt: null, expiresAt: { gt: now }, attempts: { lt: MAX_OTP_ATTEMPTS } },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp) return reply.code(401).send({ error: 'invalid_or_expired_code' });

    const expected = Buffer.from(otp.codeHmac, 'hex');
    const received = otpDigest(email, code);
    const valid = expected.length === received.length && timingSafeEqual(expected, received);
    const attempt = await prisma.authOtp.updateMany({
      where: { id: otp.id, usedAt: null, expiresAt: { gt: now }, attempts: { lt: MAX_OTP_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (!attempt.count || !valid) return reply.code(401).send({ error: 'invalid_or_expired_code' });

    const consumed = await prisma.authOtp.updateMany({
      where: { id: otp.id, usedAt: null, expiresAt: { gt: new Date() }, attempts: { lte: MAX_OTP_ATTEMPTS } },
      data: { usedAt: new Date() },
    });
    if (!consumed.count) return reply.code(401).send({ error: 'invalid_or_expired_code' });

    const user = await prisma.adminUser.findUnique({ where: { email } });
    if (!user || user.role !== 'admin') return reply.code(401).send({ error: 'invalid_or_expired_code' });
    const session = await createSession(request, user.id, user.email, user.role);
    await prisma.auditLog.create({
      data: {
        actorEmail: user.email,
        action: 'auth.otp.sign_in',
        target: 'session',
        meta: { method: 'otp', device: deviceLabel(request) },
      },
    });
    return sendSession(reply, session);
  });

  app.post('/auth/passkeys/authenticate/options', async (request, reply) => {
    const body = request.body as { email?: unknown } | null;
    const email = normalizeEmail(body?.email);
    if (!email || email !== env.OWNER_EMAIL.toLowerCase()) {
      return reply.code(401).send({ error: 'passkey_unavailable' });
    }
    const user = await prisma.adminUser.findUnique({ where: { email }, select: { id: true } });
    if (!user) return reply.code(401).send({ error: 'passkey_unavailable' });
    const ipHash = hmacText(request.ip);
    const recentAttempts = await prisma.passkeyChallenge.count({
      where: { requestIpHash: ipHash, purpose: 'login', createdAt: { gt: new Date(Date.now() - 10 * 60 * 1000) } },
    });
    if (recentAttempts >= 30) return reply.code(429).send({ error: 'passkey_unavailable' });
    const credentials = await prisma.passkeyCredential.findMany({
      where: { adminUserId: user.id },
      select: { id: true },
    });
    if (!credentials.length) return reply.code(401).send({ error: 'passkey_unavailable' });
    const { rpID } = webAuthnConfig();
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: credentials.map(({ id }) => ({ id })),
      userVerification: 'required',
    });
    const challenge = await storePasskeyChallenge(options.challenge, 'login', user.id, null, ipHash);
    return reply.send({ options, challengeId: challenge.id });
  });

  app.post('/auth/passkeys/authenticate/verify', async (request, reply) => {
    const body = request.body as { challengeId?: unknown; credential?: unknown } | null;
    const response = body?.credential;
    if (
      typeof body?.challengeId !== 'string' ||
      !response || typeof response !== 'object' ||
      !('id' in response) || typeof response.id !== 'string' || response.id.length > 1024
    ) return reply.code(400).send({ error: 'invalid_passkey_response' });

    const email = env.OWNER_EMAIL.toLowerCase();
    const user = await prisma.adminUser.findUnique({ where: { email } });
    if (!user || user.role !== 'owner') return reply.code(401).send({ error: 'invalid_passkey_response' });
    const [challenge, passkey] = await Promise.all([
      prisma.passkeyChallenge.findFirst({
        where: {
          id: body.challengeId,
          purpose: 'login',
          adminUserId: user.id,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
      }),
      prisma.passkeyCredential.findFirst({
        where: { id: response.id, adminUserId: user.id },
      }),
    ]);
    if (!challenge || !passkey) return reply.code(401).send({ error: 'invalid_passkey_response' });

    let verification;
    try {
      const { origin, rpID } = webAuthnConfig();
      verification = await verifyAuthenticationResponse({
        response: response as AuthenticationResponseJSON,
        expectedChallenge: challenge.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
        credential: {
          id: passkey.id,
          publicKey: passkey.publicKey,
          counter: Number(passkey.counter),
        },
      });
    } catch (error) {
      request.log.warn({ err: error }, 'Passkey authentication verification failed');
      return reply.code(401).send({ error: 'invalid_passkey_response' });
    }
    if (!verification.verified) return reply.code(401).send({ error: 'invalid_passkey_response' });

    try {
      await prisma.$transaction(async (transaction) => {
        const used = await transaction.passkeyChallenge.updateMany({
          where: { id: challenge.id, usedAt: null, expiresAt: { gt: new Date() } },
          data: { usedAt: new Date() },
        });
        if (!used.count) throw new Error('PASSKEY_CHALLENGE_REPLAY');
        const updated = await transaction.passkeyCredential.updateMany({
          where: { id: passkey.id, counter: passkey.counter },
          data: {
            counter: BigInt(verification.authenticationInfo.newCounter),
            backedUp: verification.authenticationInfo.credentialBackedUp,
            lastUsedAt: new Date(),
          },
        });
        if (!updated.count) throw new Error('PASSKEY_COUNTER_REPLAY');
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('PASSKEY_')) {
        return reply.code(401).send({ error: 'invalid_passkey_response' });
      }
      throw error;
    }

    const session = await createSession(request, user.id, user.email, user.role);
    await prisma.auditLog.create({
      data: { actorEmail: user.email, action: 'auth.passkey.sign_in', target: 'session', meta: { device: deviceLabel(request) } },
    });
    return sendSession(reply, session);
  });

  app.post('/auth/logout', { preHandler: authenticate }, async (request, reply) => {
    if (request.auth) {
      await prisma.$transaction(async (transaction) => {
        await transaction.authSession.updateMany({
          where: { id: request.auth!.sessionId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await transaction.pushDevice.deleteMany({ where: { sessionId: request.auth!.sessionId } });
      });
      await prisma.auditLog.create({
        data: { actorEmail: request.auth.email, action: 'auth.logout', target: request.auth.sessionId },
      });
    }
    return reply.send({ ok: true });
  });

  app.post('/auth/reauth', { preHandler: authenticate }, async (request, reply) => {
    if (!request.auth || request.auth.role !== 'owner') return reply.code(403).send({ error: 'forbidden' });
    const body = request.body as { credential?: unknown } | null;
    const identity = await googleIdentity(body?.credential);
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (
      !identity ||
      identity.email !== env.OWNER_EMAIL.toLowerCase() ||
      identity.issuedAt < nowSeconds - 5 * 60 ||
      identity.issuedAt > nowSeconds + 30
    ) {
      return reply.code(401).send({ error: 'fresh_owner_auth_required' });
    }
    const owner = await prisma.adminUser.findUnique({ where: { id: request.auth.userId }, select: { googleSub: true } });
    if (!owner?.googleSub || owner.googleSub !== identity.sub) return reply.code(403).send({ error: 'not_allowed' });
    const stepUpUntil = new Date(Date.now() + 5 * 60 * 1000);
    await prisma.authSession.update({ where: { id: request.auth.sessionId }, data: { stepUpUntil } });
    await prisma.auditLog.create({
      data: { actorEmail: request.auth.email, action: 'auth.step_up', target: request.auth.sessionId },
    });
    return reply.send({ ok: true, expiresAt: stepUpUntil.toISOString() });
  });

  app.post('/auth/gmail/connect-url', { preHandler: [authenticate, requireOwner, requireStepUp] }, async (request) => {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      throw new Error('Google OAuth client credentials are required to connect Gmail');
    }
    const state = randomBytes(32).toString('base64url');
    const now = new Date();
    await prisma.gmailOAuthState.deleteMany({ where: { expiresAt: { lte: now } } });
    await prisma.gmailOAuthState.create({
      data: {
        id: randomUUID(),
        stateHash: hmacText(`gmail-oauth:${state}`),
        adminUserId: request.auth!.userId,
        sessionId: request.auth!.sessionId,
        expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
      },
    });
    const authorizationUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authorizationUrl.search = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: gmailRedirectUri(),
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/gmail.modify',
      access_type: 'offline',
      prompt: 'consent',
      state,
    }).toString();
    return { url: authorizationUrl.toString() };
  });

  app.post('/auth/gmail/callback', { preHandler: [authenticate, requireOwner, requireStepUp] }, async (request, reply) => {
    const body = request.body as { code?: unknown; state?: unknown } | null;
    if (
      typeof body?.code !== 'string' || body.code.length > 4096 ||
      typeof body.state !== 'string' || body.state.length > 256
    ) return reply.code(400).send({ error: 'invalid_gmail_oauth_callback' });
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      throw new Error('Google OAuth client credentials are required to connect Gmail');
    }
    const state = await prisma.gmailOAuthState.findFirst({
      where: {
        stateHash: hmacText(`gmail-oauth:${body.state}`),
        adminUserId: request.auth!.userId,
        sessionId: request.auth!.sessionId,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (!state) return reply.code(401).send({ error: 'invalid_gmail_oauth_state' });
    const consumed = await prisma.gmailOAuthState.updateMany({
      where: { id: state.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (!consumed.count) return reply.code(401).send({ error: 'invalid_gmail_oauth_state' });

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        code: body.code,
        redirect_uri: gmailRedirectUri(),
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(15000),
    });
    const tokenData = await tokenResponse.json() as { access_token?: string; refresh_token?: string; scope?: string; error?: string };
    if (!tokenResponse.ok || !tokenData.access_token || !tokenData.refresh_token) {
      request.log.error({ event: 'gmail_oauth_exchange_failed', status: tokenResponse.status, error: tokenData.error });
      return reply.code(502).send({ error: 'gmail_oauth_exchange_failed' });
    }
    // Google's granular consent lets the user untick the Gmail permission and still returns tokens.
    if (!tokenData.scope?.split(' ').includes('https://www.googleapis.com/auth/gmail.modify')) {
      request.log.warn({ event: 'gmail_scope_not_granted', scope: tokenData.scope });
      return reply.code(400).send({ error: 'gmail_scope_not_granted' });
    }
    try {
      await verifyGmailOwner(tokenData.access_token);
    } catch (error) {
      request.log.error({ err: error, event: 'gmail_owner_verification_failed' });
      const message = error instanceof Error ? error.message : '';
      const code = /SERVICE_DISABLED|accessNotConfigured|has not been used|is disabled/i.test(message) ? 'gmail_api_disabled'
        : message.includes('OWNER_EMAIL') ? 'gmail_wrong_account' : 'gmail_verification_failed';
      return reply.code(502).send({ error: code });
    }
    await storeGmailRefreshToken(tokenData.refresh_token);
    await prisma.auditLog.create({
      data: { actorEmail: request.auth!.email, action: 'gmail.connect', target: env.OWNER_EMAIL },
    });
    return reply.send({ ok: true });
  });

  app.post('/auth/gmail/status', { preHandler: [authenticate, requireOwner] }, async (request, reply) => {
    try {
      return await gmailConnectionStatus();
    } catch (error) {
      request.log.error({ err: error, event: 'gmail_status_failed' }, 'Could not verify Gmail connection');
      return reply.code(503).send({ error: 'gmail_status_unavailable' });
    }
  });

  app.post('/auth/gmail/disconnect', { preHandler: [authenticate, requireOwner, requireStepUp] }, async (request) => {
    await revokeGmailConnection();
    await prisma.auditLog.create({
      data: { actorEmail: request.auth!.email, action: 'gmail.disconnect', target: env.OWNER_EMAIL },
    });
    return { ok: true };
  });

  app.register(async (protectedRoutes) => {
    protectedRoutes.addHook('preHandler', authenticate);
    protectedRoutes.get('/auth/me', async (request) => ({
      email: request.auth!.email,
      role: request.auth!.role,
      stepUpUntil: request.auth!.stepUpUntil?.toISOString() ?? null,
    }));
    protectedRoutes.get('/admins', { preHandler: requireOwner }, async () => {
      const admins = await prisma.adminUser.findMany({
        orderBy: [{ role: 'asc' }, { email: 'asc' }],
        select: {
          id: true,
          email: true,
          role: true,
          createdAt: true,
          sessions: { where: { revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true } },
        },
      });
      return admins.map(({ sessions, ...admin }) => ({ ...admin, activeSessions: sessions.length }));
    });
    protectedRoutes.get('/auth/passkeys', { preHandler: requireOwner }, async (request) =>
      prisma.passkeyCredential.findMany({
        where: { adminUserId: request.auth!.userId },
        orderBy: { createdAt: 'desc' },
        select: { id: true, label: true, deviceType: true, backedUp: true, createdAt: true, lastUsedAt: true },
      }));
    protectedRoutes.post('/auth/passkeys/register/options', { preHandler: requireOwner }, async (request, reply) => {
      const { rpID } = webAuthnConfig();
      const existing = await prisma.passkeyCredential.findMany({
        where: { adminUserId: request.auth!.userId },
        select: { id: true },
      });
      if (existing.length >= 10) return reply.code(400).send({ error: 'passkey_limit_reached' });
      const options = await generateRegistrationOptions({
        rpName: 'EmailAuto',
        rpID,
        userID: new TextEncoder().encode(String(request.auth!.userId)),
        userName: request.auth!.email,
        userDisplayName: request.auth!.email,
        attestationType: 'none',
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        excludeCredentials: existing.map(({ id }) => ({ id })),
      });
      const challenge = await storePasskeyChallenge(
        options.challenge,
        'register',
        request.auth!.userId,
        request.auth!.sessionId,
        hmacText(request.ip),
      );
      return reply.send({ options, challengeId: challenge.id });
    });
    protectedRoutes.post('/auth/passkeys/register/verify', { preHandler: [requireOwner, requireStepUp] }, async (request, reply) => {
      const body = request.body as { challengeId?: unknown; credential?: unknown; label?: unknown } | null;
      const response = body?.credential;
      if (
        typeof body?.challengeId !== 'string' ||
        !response || typeof response !== 'object' ||
        !('id' in response) || typeof response.id !== 'string' || response.id.length > 1024
      ) return reply.code(400).send({ error: 'invalid_passkey_response' });
      const challenge = await prisma.passkeyChallenge.findFirst({
        where: {
          id: body.challengeId,
          purpose: 'register',
          adminUserId: request.auth!.userId,
          sessionId: request.auth!.sessionId,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
      if (!challenge) return reply.code(401).send({ error: 'invalid_passkey_response' });

      let verification;
      try {
        const { origin, rpID } = webAuthnConfig();
        verification = await verifyRegistrationResponse({
          response: response as RegistrationResponseJSON,
          expectedChallenge: challenge.challenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          requireUserVerification: true,
        });
      } catch (error) {
        request.log.warn({ err: error }, 'Passkey registration verification failed');
        return reply.code(400).send({ error: 'invalid_passkey_response' });
      }
      if (!verification.verified) return reply.code(400).send({ error: 'invalid_passkey_response' });
      const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
      const label = typeof body.label === 'string' && body.label.trim()
        ? body.label.trim().slice(0, 80)
        : 'Passkey';

      try {
        await prisma.$transaction(async (transaction) => {
          const used = await transaction.passkeyChallenge.updateMany({
            where: { id: challenge.id, usedAt: null, expiresAt: { gt: new Date() } },
            data: { usedAt: new Date() },
          });
          if (!used.count) throw new Error('PASSKEY_CHALLENGE_REPLAY');
          await transaction.passkeyCredential.create({
            data: {
              id: credential.id,
              adminUserId: request.auth!.userId,
              publicKey: credential.publicKey,
              counter: BigInt(credential.counter),
              transports: credential.transports ?? [],
              deviceType: credentialDeviceType,
              backedUp: credentialBackedUp,
              label,
            },
          });
          await transaction.auditLog.create({
            data: { actorEmail: request.auth!.email, action: 'auth.passkey.register', target: credential.id, meta: { label } },
          });
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'PASSKEY_CHALLENGE_REPLAY') {
          return reply.code(401).send({ error: 'invalid_passkey_response' });
        }
        throw error;
      }
      return reply.code(201).send({ ok: true });
    });
    protectedRoutes.delete('/auth/passkeys/:id', { preHandler: [requireOwner, requireStepUp] }, async (request, reply) => {
      const id = (request.params as { id: string }).id;
      const result = await prisma.$transaction(async (transaction) => {
        const deleted = await transaction.passkeyCredential.deleteMany({
          where: { id, adminUserId: request.auth!.userId },
        });
        if (!deleted.count) return 0;
        await transaction.auditLog.create({
          data: { actorEmail: request.auth!.email, action: 'auth.passkey.remove', target: id },
        });
        return deleted.count;
      });
      if (!result) return reply.code(404).send({ error: 'passkey_not_found' });
      return reply.send({ ok: true });
    });
    protectedRoutes.post('/admins', { preHandler: [requireOwner, requireStepUp] }, async (request, reply) => {
      const body = request.body as { email?: unknown } | null;
      const email = normalizeEmail(body?.email);
      if (!email || email === env.OWNER_EMAIL.toLowerCase()) {
        return reply.code(400).send({ error: 'invalid_admin_email' });
      }
      const admin = await prisma.$transaction(async (transaction) => {
        const created = await transaction.adminUser.upsert({
          where: { email },
          update: {},
          create: { email, role: 'admin', addedBy: request.auth!.email },
          select: { id: true, email: true, role: true, createdAt: true },
        });
        await transaction.auditLog.create({
          data: { actorEmail: request.auth!.email, action: 'admin.add', target: email },
        });
        return created;
      });
      return reply.code(201).send(admin);
    });
    protectedRoutes.delete('/admins/:id', { preHandler: [requireOwner, requireStepUp] }, async (request, reply) => {
      const id = Number((request.params as { id: string }).id);
      if (!Number.isInteger(id) || id < 1) return reply.code(400).send({ error: 'invalid_admin_id' });
      const target = await prisma.adminUser.findUnique({ where: { id }, select: { email: true, role: true } });
      if (!target) return reply.code(404).send({ error: 'admin_not_found' });
      if (target.role === 'owner' || target.email === env.OWNER_EMAIL.toLowerCase()) {
        return reply.code(403).send({ error: 'owner_protected' });
      }
      await prisma.$transaction(async (transaction) => {
        await transaction.adminUser.delete({ where: { id } });
        await transaction.auditLog.create({
          data: { actorEmail: request.auth!.email, action: 'admin.remove', target: target.email },
        });
      });
      return reply.send({ ok: true });
    });
    protectedRoutes.get('/sessions', { preHandler: requireOwner }, async () => prisma.authSession.findMany({
      where: { revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
      take: 100,
      select: {
        id: true, deviceLabel: true, createdAt: true, lastSeenAt: true, expiresAt: true,
        adminUser: { select: { email: true, role: true } },
      },
    }));
    protectedRoutes.delete('/sessions/:id', { preHandler: requireOwner }, async (request, reply) => {
      const id = (request.params as { id: string }).id;
      const result = await prisma.$transaction(async (transaction) => {
        const changed = await transaction.authSession.updateMany({
          where: { id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        if (!changed.count) return 0;
        await transaction.pushDevice.deleteMany({ where: { sessionId: id } });
        await transaction.auditLog.create({
          data: { actorEmail: request.auth!.email, action: 'session.revoke', target: id },
        });
        return changed.count;
      });
      if (!result) return reply.code(404).send({ error: 'session_not_found' });
      return reply.send({ ok: true });
    });
    protectedRoutes.get('/audit-log', { preHandler: requireOwner }, async () => prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    }));
  });
}
