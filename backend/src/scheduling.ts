export type ActiveWindow = 'morning' | 'afternoon';

export const SEND_PLAN_MIN_NOTICE_MS = 24 * 60 * 60 * 1000;

export type WindowOutcome = {
  hour: number;
  replied: boolean;
};

export function recommendActiveWindow(outcomes: WindowOutcome[]) {
  const samples = {
    morning: { sent: 0, replies: 0 },
    afternoon: { sent: 0, replies: 0 },
  };
  for (const outcome of outcomes) {
    if (!Number.isFinite(outcome.hour) || outcome.hour < 0 || outcome.hour >= 24) continue;
    if (!(outcome.hour >= 9.5 && outcome.hour < 11.5) && !(outcome.hour >= 14 && outcome.hour < 16)) continue;
    const window = outcome.hour >= 14 && outcome.hour < 16 ? 'afternoon' : 'morning';
    samples[window].sent++;
    if (outcome.replied) samples[window].replies++;
  }
  const total = samples.morning.sent + samples.afternoon.sent;
  if (total < 40 || samples.morning.sent < 15 || samples.afternoon.sent < 15) {
    return { window: 'morning' as const, source: 'default' as const, samples };
  }
  const morningRate = (samples.morning.replies + 1) / (samples.morning.sent + 10);
  const afternoonRate = (samples.afternoon.replies + 1) / (samples.afternoon.sent + 10);
  return {
    window: afternoonRate > morningRate ? 'afternoon' as const : 'morning' as const,
    source: 'market-history' as const,
    samples,
  };
}

export function nextRecipientWindow(earliest: Date, timeZone: string, activeWindow: ActiveWindow = 'morning') {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const candidate = new Date(earliest);
  candidate.setUTCSeconds(0, 0);
  const minute = candidate.getUTCMinutes();
  candidate.setUTCMinutes(minute + ((15 - minute % 15) % 15));
  for (let i = 0; i < 8 * 24 * 4; i++, candidate.setUTCMinutes(candidate.getUTCMinutes() + 15)) {
    const parts = formatter.formatToParts(candidate);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    const weekday = parts.find((part) => part.type === 'weekday')?.value;
    const localMinutes = hour * 60 + minute;
    const inWindow = activeWindow === 'morning'
      ? localMinutes >= 9 * 60 + 30 && localMinutes < 11 * 60 + 30
      : localMinutes >= 14 * 60 && localMinutes < 16 * 60;
    if (weekday && !['Sat', 'Sun'].includes(weekday) && inWindow) return new Date(candidate);
  }
  throw new Error(`Could not find a send window for timezone ${timeZone}`);
}
