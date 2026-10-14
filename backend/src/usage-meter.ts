import { prisma } from './db.js';

// Daily counters in app_settings under `usage_meter:YYYY-MM-DD`; one small row per day.
const PREFIX = 'usage_meter:';
const FLUSH_MS = 5 * 60_000;

type Counter = 'pagespeed_calls' | 'awake_seconds';

function dayKey(date = new Date()) {
  return `${PREFIX}${date.toISOString().slice(0, 10)}`;
}

/** Atomically adds `amount` to one counter for today's row. */
export async function incrementUsage(counter: Counter, amount = 1, date = new Date()) {
  if (!(amount > 0)) return;
  const key = dayKey(date);
  const path = `{${counter}}`;
  await prisma.$executeRaw`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (${key}, jsonb_build_object(${counter}::text, ${amount}::bigint), now())
    ON CONFLICT (key) DO UPDATE SET
      value = jsonb_set(app_settings.value, ${path}::text[], to_jsonb(COALESCE((app_settings.value->>${counter}::text)::bigint, 0) + ${amount}::bigint)),
      updated_at = now()`;
}

export function recordPageSpeedCall() {
  return incrementUsage('pagespeed_calls').catch((error) => {
    console.error(JSON.stringify({ level: 'error', event: 'usage_meter_failed', counter: 'pagespeed_calls', message: error instanceof Error ? error.message : String(error) }));
  });
}

export type UsageDay = { day: string; pagespeedCalls: number; awakeSeconds: number };

export function parseUsageRow(key: string, value: unknown): UsageDay | null {
  if (!key.startsWith(PREFIX) || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const num = (raw: unknown) => {
    const parsed = Number(raw ?? 0);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  };
  return { day: key.slice(PREFIX.length), pagespeedCalls: num(record.pagespeed_calls), awakeSeconds: num(record.awake_seconds) };
}

/** Days of the current UTC month, newest first. */
export async function monthUsage(now = new Date()) {
  const monthPrefix = `${PREFIX}${now.toISOString().slice(0, 7)}-`;
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: monthPrefix } }, orderBy: { key: 'desc' } });
  return rows.map((row) => parseUsageRow(row.key, row.value)).filter((row): row is UsageDay => row !== null);
}

export async function pruneUsage(keepDays: number, now = new Date()) {
  const cutoff = dayKey(new Date(now.getTime() - keepDays * 24 * 60 * 60_000));
  const result = await prisma.appSetting.deleteMany({ where: { key: { startsWith: PREFIX, lt: cutoff } } });
  return result.count;
}

/**
 * Self-measured awake time: while the process runs it adds elapsed wall-clock seconds every few minutes.
 * This approximates Render instance-hours for a single instance; it cannot see time spent starting up or billed after exit.
 */
export function startAwakeMeter() {
  let last = Date.now();
  const flush = async () => {
    const now = Date.now();
    const elapsed = Math.round((now - last) / 1000);
    last = now;
    try {
      await incrementUsage('awake_seconds', elapsed);
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'usage_meter_failed', counter: 'awake_seconds', message: error instanceof Error ? error.message : String(error) }));
    }
  };
  const timer = setInterval(() => void flush(), FLUSH_MS);
  timer.unref();
  return { flush, stop: () => clearInterval(timer) };
}
