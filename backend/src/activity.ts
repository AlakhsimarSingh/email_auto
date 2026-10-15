import { prisma } from './db.js';

// Live agent activity: an in-memory ring buffer read by the dashboard's Live page.
// Polling reads memory only; the buffer is saved to app_settings once per tick so it survives restarts.

export const STAGES = ['discover', 'audit', 'draft', 'plan', 'replies', 'followups', 'learn', 'send', 'notify'] as const;
export type Stage = typeof STAGES[number] | 'tick';
export type ActivityLevel = 'info' | 'success' | 'warn' | 'error';
export type ActivityEvent = { id: number; at: string; stage: Stage; level: ActivityLevel; message: string };
type StageStatus = 'idle' | 'running' | 'done' | 'error';
type StageState = { status: StageStatus; lastRunAt: string | null; lastMessage: string | null; durationMs: number | null };

const MAX_EVENTS = 300;
const PERSIST_EVENTS = 120;
const SETTING_KEY = 'activity_log';

const events: ActivityEvent[] = [];
let nextId = 1;
let current: { stage: Stage; message: string; startedAt: string } | null = null;
let tick: { running: boolean; startedAt: string | null; finishedAt: string | null; durationMs: number | null } = {
  running: false, startedAt: null, finishedAt: null, durationMs: null,
};
const stages = Object.fromEntries(
  STAGES.map((stage) => [stage, { status: 'idle', lastRunAt: null, lastMessage: null, durationMs: null } satisfies StageState]),
) as Record<typeof STAGES[number], StageState>;

export function activity(stage: Stage, message: string, level: ActivityLevel = 'info') {
  const event: ActivityEvent = { id: nextId++, at: new Date().toISOString(), stage, level, message: message.slice(0, 280) };
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  if (current && (current.stage === stage || stage !== 'tick')) current = { ...current, stage, message: event.message };
  if (stage !== 'tick') stages[stage].lastMessage = event.message;
}

/** Runs one tick stage, tracking its status and timing. Errors are recorded and swallowed so later stages still run. */
export async function runStage(stage: typeof STAGES[number], label: string, fn: () => Promise<unknown>) {
  const started = Date.now();
  current = { stage, message: label, startedAt: new Date(started).toISOString() };
  stages[stage] = { ...stages[stage], status: 'running', lastRunAt: current.startedAt };
  activity(stage, label);
  try {
    await fn();
    stages[stage] = { ...stages[stage], status: 'done', durationMs: Date.now() - started };
  } catch (error) {
    stages[stage] = { ...stages[stage], status: 'error', durationMs: Date.now() - started };
    activity(stage, `Failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    console.error(JSON.stringify({ level: 'error', event: `${stage}_stage_failed`, message: error instanceof Error ? error.message : String(error) }));
  }
}

export function tickStarted() {
  tick = { running: true, startedAt: new Date().toISOString(), finishedAt: tick.finishedAt, durationMs: tick.durationMs };
  activity('tick', 'Agent woke up and started a work cycle');
}

export async function tickFinished() {
  const finishedAt = new Date();
  const durationMs = tick.startedAt ? finishedAt.getTime() - new Date(tick.startedAt).getTime() : null;
  tick = { running: false, startedAt: tick.startedAt, finishedAt: finishedAt.toISOString(), durationMs };
  activity('tick', `Work cycle finished in ${durationMs === null ? '?' : Math.max(1, Math.round(durationMs / 1000))}s`, 'success');
  current = null;
  try {
    const value = { events: events.slice(-PERSIST_EVENTS), stages, tick };
    await prisma.appSetting.upsert({ where: { key: SETTING_KEY }, create: { key: SETTING_KEY, value }, update: { value } });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', event: 'activity_persist_failed', message: error instanceof Error ? error.message : String(error) }));
  }
}

/** Restores the last saved feed after a restart (Render free instances sleep and restart). */
export async function loadActivity() {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: SETTING_KEY } });
    const saved = row?.value as { events?: ActivityEvent[]; stages?: Record<string, StageState>; tick?: typeof tick } | undefined;
    if (!saved || !Array.isArray(saved.events)) return;
    events.splice(0, events.length, ...saved.events.slice(-MAX_EVENTS));
    nextId = Math.max(0, ...events.map((event) => event.id)) + 1;
    for (const stage of STAGES) {
      const state = saved.stages?.[stage];
      if (state) stages[stage] = { ...state, status: state.status === 'running' ? 'error' : state.status };
    }
    if (saved.tick) tick = { ...saved.tick, running: false };
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', event: 'activity_load_failed', message: error instanceof Error ? error.message : String(error) }));
  }
}

export function activitySnapshot(sinceId = 0) {
  return {
    now: new Date().toISOString(),
    tick,
    current,
    stages,
    events: events.filter((event) => event.id > sinceId).slice(-150),
    latestId: nextId - 1,
  };
}
