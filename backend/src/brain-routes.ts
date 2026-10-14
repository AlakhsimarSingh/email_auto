import type { FastifyInstance } from 'fastify';
import { prisma } from './db.js';
import { requireOwner, requireStepUp } from './auth.js';
import { cleanGuidanceText } from './brain-math.js';
import {
  applyFeedback, decideProposal, explainLead, getArmTable, getBrainOverview, previewReset, resetBrain, restoreBrain,
  runStrategist, saveBrainSettings, getBrainSettings,
} from './brain.js';

const MEMORY_LIMIT = 200;

function parseScope(value: unknown): { ok: true; scope: Record<string, string> } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, scope: {} };
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false };
  const input = value as Record<string, unknown>;
  const scope: Record<string, string> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (raw === undefined || raw === null || raw === '') continue;
    if (typeof raw !== 'string') return { ok: false };
    const text = raw.trim();
    if (key === 'niche' && text.length >= 1 && text.length <= 60 && !/[\u0000-\u001f|]/.test(text)) scope.niche = text;
    else if (key === 'country' && /^[A-Za-z]{2}$/.test(text)) scope.country = text.toUpperCase();
    else if (key === 'track' && (text === 'site' || text === 'no_site')) scope.track = text;
    else return { ok: false };
  }
  return { ok: true, scope };
}

function parseExpiry(value: unknown): { ok: true; value: Date | null | undefined } | { ok: false } {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null || value === '') return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false };
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now() || date.getTime() > Date.now() + 5 * 365 * 24 * 60 * 60 * 1000) return { ok: false };
  return { ok: true, value: date };
}

const FEEDBACK_STATUS: Record<string, number> = {
  invalid_feedback: 400,
  learning_frozen: 409,
  target_not_found: 404,
  no_matching_arms: 404,
  feedback_rate_limited: 429,
};

export function registerBrainRoutes(r: FastifyInstance) {
  // Review-time feedback is available to every signed-in admin; everything else is owner-only.
  r.post('/agent/feedback', async (request, reply) => {
    const body = request.body as { targetType?: unknown; targetId?: unknown; score?: unknown; note?: unknown } | null;
    const targetId = typeof body?.targetId === 'number' ? String(body.targetId) : body?.targetId;
    if (typeof body?.targetType !== 'string' || typeof targetId !== 'string' || !targetId.trim() || targetId.length > 120 ||
        typeof body.score !== 'number' || !Number.isInteger(body.score) ||
        (body.note !== undefined && body.note !== null && (typeof body.note !== 'string' || body.note.length > 300))) {
      return reply.code(400).send({ error: 'invalid_feedback' });
    }
    const result = await applyFeedback({
      targetType: body.targetType,
      targetId: targetId.trim(),
      score: body.score,
      note: typeof body.note === 'string' ? body.note : null,
      actor: request.auth!.email,
    });
    if (!result.ok) return reply.code(FEEDBACK_STATUS[result.error] ?? 400).send({ error: result.error });
    return reply.code(201).send({ ok: true, effect: result.effect });
  });

  r.get('/agent/overview', { preHandler: requireOwner }, async () => getBrainOverview());
  r.get('/agent/arms', { preHandler: requireOwner }, async () => getArmTable());

  r.get('/agent/explain/:leadId', { preHandler: requireOwner }, async (request, reply) => {
    const leadId = Number((request.params as { leadId: string }).leadId);
    if (!Number.isSafeInteger(leadId) || leadId < 1) return reply.code(400).send({ error: 'invalid_lead_id' });
    const explanation = await explainLead(leadId);
    if (!explanation) return reply.code(404).send({ error: 'lead_not_found' });
    return explanation;
  });

  r.patch('/agent/settings', { preHandler: requireOwner }, async (request, reply) => {
    const body = request.body as { learningRate?: unknown; explorationShare?: unknown; attributionDays?: unknown; autonomy?: unknown } | null;
    const patch: Record<string, number | string> = {};
    const range = (key: 'learningRate' | 'explorationShare' | 'attributionDays', min: number, max: number) => {
      const value = body?.[key];
      if (value === undefined) return true;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return false;
      patch[key] = key === 'attributionDays' ? Math.round(value) : value;
      return true;
    };
    if (!body || typeof body !== 'object' ||
        !range('learningRate', 0.25, 2) || !range('explorationShare', 0.15, 0.5) || !range('attributionDays', 7, 30) ||
        (body.autonomy !== undefined && body.autonomy !== 'L0' && body.autonomy !== 'L1')) {
      return reply.code(400).send({ error: 'invalid_brain_settings' });
    }
    if (body.autonomy !== undefined) patch.autonomy = body.autonomy;
    if (!Object.keys(patch).length) return reply.code(400).send({ error: 'invalid_brain_settings' });
    const settings = await saveBrainSettings(patch);
    await prisma.auditLog.create({ data: { actorEmail: request.auth!.email, action: 'agent.settings_updated', meta: patch } });
    return settings;
  });

  for (const action of ['freeze', 'unfreeze'] as const) {
    r.post(`/agent/learning/${action}`, { preHandler: requireOwner }, async (request) => {
      const settings = await saveBrainSettings({ frozen: action === 'freeze' });
      await prisma.auditLog.create({ data: { actorEmail: request.auth!.email, action: `agent.learning_${action}` } });
      return settings;
    });
  }

  r.get('/agent/memory', { preHandler: requireOwner }, async () => prisma.agentMemory.findMany({
    orderBy: [{ active: 'desc' }, { kind: 'asc' }, { id: 'asc' }],
    take: 300,
  }));

  r.post('/agent/memory', { preHandler: requireOwner }, async (request, reply) => {
    const body = request.body as { kind?: unknown; text?: unknown; scope?: unknown; expiresAt?: unknown } | null;
    if (body?.kind !== 'instruction' && body?.kind !== 'guardrail') return reply.code(400).send({ error: 'invalid_memory_kind' });
    const text = body.kind === 'guardrail' ? cleanGuidanceText(body.text, 2, 60) : cleanGuidanceText(body.text, 5, 300);
    const scope = parseScope(body.scope);
    const expiry = parseExpiry(body.expiresAt);
    if (!text || !scope.ok || !expiry.ok) return reply.code(400).send({ error: 'invalid_memory' });
    if (await prisma.agentMemory.count({ where: { active: true } }) >= MEMORY_LIMIT) return reply.code(409).send({ error: 'memory_limit_reached' });
    const item = await prisma.agentMemory.create({
      data: { kind: body.kind, text, scope: scope.scope, source: 'user', confidence: 1, expiresAt: expiry.value ?? null },
    });
    await prisma.auditLog.create({ data: { actorEmail: request.auth!.email, action: 'agent.memory_created', target: String(item.id), meta: { kind: item.kind } } });
    return reply.code(201).send(item);
  });

  r.patch('/agent/memory/:id', { preHandler: requireOwner }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const body = request.body as { text?: unknown; active?: unknown; scope?: unknown; expiresAt?: unknown } | null;
    if (!Number.isSafeInteger(id) || id < 1 || !body || typeof body !== 'object' ||
        (body.active !== undefined && typeof body.active !== 'boolean')) {
      return reply.code(400).send({ error: 'invalid_memory' });
    }
    const existing = await prisma.agentMemory.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'memory_not_found' });
    const data: { text?: string; active?: boolean; scope?: Record<string, string>; expiresAt?: Date | null; lastReinforcedAt?: Date; confidence?: number } = {};
    if (body.text !== undefined) {
      const text = existing.kind === 'guardrail' ? cleanGuidanceText(body.text, 2, 60) : cleanGuidanceText(body.text, existing.kind === 'lesson' ? 10 : 5, 300);
      if (!text) return reply.code(400).send({ error: 'invalid_memory' });
      data.text = text;
    }
    if (body.scope !== undefined) {
      const scope = parseScope(body.scope);
      if (!scope.ok) return reply.code(400).send({ error: 'invalid_memory' });
      data.scope = scope.scope;
    }
    if (body.expiresAt !== undefined) {
      const expiry = parseExpiry(body.expiresAt);
      if (!expiry.ok) return reply.code(400).send({ error: 'invalid_memory' });
      data.expiresAt = expiry.value ?? null;
    }
    if (body.active !== undefined) data.active = body.active;
    if (!Object.keys(data).length) return reply.code(400).send({ error: 'invalid_memory' });
    if (existing.kind === 'lesson' && (data.text !== undefined || data.active === true)) {
      data.lastReinforcedAt = new Date();
      data.confidence = Math.max(existing.confidence, 0.6);
    }
    const item = await prisma.agentMemory.update({ where: { id }, data });
    await prisma.auditLog.create({ data: { actorEmail: request.auth!.email, action: 'agent.memory_updated', target: String(id) } });
    return item;
  });

  r.delete('/agent/memory/:id', { preHandler: requireOwner }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isSafeInteger(id) || id < 1) return reply.code(400).send({ error: 'invalid_memory' });
    const removed = await prisma.agentMemory.deleteMany({ where: { id } });
    if (!removed.count) return reply.code(404).send({ error: 'memory_not_found' });
    await prisma.auditLog.create({ data: { actorEmail: request.auth!.email, action: 'agent.memory_deleted', target: String(id) } });
    return { ok: true };
  });

  r.get('/agent/proposals', { preHandler: requireOwner }, async (request, reply) => {
    const status = (request.query as { status?: unknown }).status;
    if (status !== undefined && status !== 'pending' && status !== 'all') return reply.code(400).send({ error: 'invalid_proposal_filter' });
    return prisma.agentProposal.findMany({
      where: status === 'all' ? {} : { status: 'pending' },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  });

  for (const decision of ['accept', 'reject'] as const) {
    r.post(`/agent/proposals/:id/${decision}`, { preHandler: requireOwner }, async (request, reply) => {
      const id = Number((request.params as { id: string }).id);
      if (!Number.isSafeInteger(id) || id < 1) return reply.code(400).send({ error: 'invalid_proposal_id' });
      const result = await decideProposal(id, decision, request.auth!.email);
      if (!result.ok) return reply.code(result.error === 'invalid_proposal_patch' ? 422 : 409).send({ error: result.error });
      return { ok: true };
    });
  }

  r.post('/agent/proposals/run', { preHandler: requireOwner }, async (request, reply) => {
    const result = await runStrategist({ force: true });
    if ('skipped' in result) return reply.code(409).send({ error: `strategist_${result.skipped}` });
    await prisma.auditLog.create({ data: { actorEmail: request.auth!.email, action: 'agent.strategist_run', meta: { created: result.created } } });
    return result;
  });

  r.get('/agent/reset/preview', { preHandler: requireOwner }, async () => ({ ...await previewReset(), settings: await getBrainSettings() }));

  r.post('/agent/reset', { preHandler: [requireOwner, requireStepUp] }, async (request, reply) => {
    const body = request.body as { confirm?: unknown; keepInstructions?: unknown } | null;
    if (body?.confirm !== 'RESET' || typeof body.keepInstructions !== 'boolean') return reply.code(400).send({ error: 'reset_confirmation_required' });
    const result = await resetBrain({ actor: request.auth!.email, keepInstructions: body.keepInstructions });
    if (!result.ok) return reply.code(409).send({ error: result.error });
    return result;
  });

  r.post('/agent/reset/restore', { preHandler: [requireOwner, requireStepUp] }, async (request, reply) => {
    const body = request.body as { snapshotId?: unknown } | null;
    if (body?.snapshotId !== undefined && (!Number.isSafeInteger(body.snapshotId) || Number(body.snapshotId) < 1)) {
      return reply.code(400).send({ error: 'invalid_snapshot_id' });
    }
    const result = await restoreBrain({ actor: request.auth!.email, snapshotId: typeof body?.snapshotId === 'number' ? body.snapshotId : undefined });
    if (!result.ok) return reply.code(result.error === 'no_restorable_snapshot' ? 404 : 409).send({ error: result.error });
    return result;
  });
}
