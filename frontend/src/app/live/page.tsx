'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Stage = 'tick' | 'discover' | 'audit' | 'draft' | 'plan' | 'replies' | 'followups' | 'learn' | 'send' | 'notify';
type Level = 'info' | 'success' | 'warn' | 'error';
type ActivityEvent = { id: number; at: string; stage: Stage; level: Level; message: string };
type StageState = { status: 'idle' | 'running' | 'done' | 'error'; lastRunAt: string | null; lastMessage: string | null; durationMs: number | null };
type Snapshot = {
  now: string;
  tick: { running: boolean; startedAt: string | null; finishedAt: string | null; durationMs: number | null };
  current: { stage: Stage; message: string; startedAt: string } | null;
  stages: Record<Exclude<Stage, 'tick'>, StageState>;
  events: ActivityEvent[];
  latestId: number;
};
type Plan = { id: string; state: string; announced_at: string | null; starts_at: string; ends_at: string; countries: string[]; total: number; sent: number; failed: number };
type Summary = {
  dry_run: boolean;
  last_tick_at: string | null;
  businesses: Record<string, number>;
  emails: Record<string, number>;
  sent_24h: number;
  daily_cap: number;
  plans: Plan[];
};

const STAGE_INFO: Record<Stage, { label: string; color: string; glyph: string }> = {
  tick: { label: 'Work cycle', color: 'var(--gray)', glyph: '◷' },
  discover: { label: 'Finding businesses', color: 'var(--teal)', glyph: '⌕' },
  audit: { label: 'Researching', color: 'var(--indigo)', glyph: '◎' },
  draft: { label: 'Drafting', color: 'var(--purple)', glyph: '✎' },
  plan: { label: 'Send Plans', color: 'var(--orange)', glyph: '▤' },
  replies: { label: 'Checking replies', color: 'var(--tint)', glyph: '↩' },
  followups: { label: 'Follow-ups', color: 'var(--pink)', glyph: '↻' },
  learn: { label: 'Learning', color: '#a970ff', glyph: '✦' },
  send: { label: 'Sending', color: 'var(--green)', glyph: '➤' },
  notify: { label: 'Notifications', color: 'var(--red)', glyph: '●' },
};
const ORDER: Array<Exclude<Stage, 'tick'>> = ['discover', 'audit', 'draft', 'plan', 'replies', 'followups', 'learn', 'send', 'notify'];
const FILTERS = { all: 'All', research: 'Research', sending: 'Sending', issues: 'Issues' } as const;
type Filter = keyof typeof FILTERS;
const FILTER_STAGES: Record<Filter, Stage[] | null> = {
  all: null,
  research: ['discover', 'audit', 'draft'],
  sending: ['plan', 'send', 'replies', 'followups'],
  issues: null,
};
const TICK_INTERVAL_MS = 5 * 60_000;

function relative(iso: string | null, now: number) {
  if (!iso) return 'never';
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  const unit = abs < 60_000 ? `${Math.max(1, Math.round(abs / 1000))}s` : abs < 3_600_000 ? `${Math.round(abs / 60_000)}m` : abs < 86_400_000 ? `${Math.round(abs / 3_600_000)}h` : `${Math.round(abs / 86_400_000)}d`;
  return diff >= 0 ? `in ${unit}` : `${unit} ago`;
}
function clock(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function planPhase(plan: Plan, now: number): { label: string; tone: 'wait' | 'live' | 'done' | 'stop' } {
  const start = new Date(plan.starts_at).getTime();
  const end = new Date(plan.ends_at).getTime();
  if (plan.state === 'completed' || (plan.total > 0 && plan.sent === plan.total)) return { label: 'Completed', tone: 'done' };
  if (plan.state === 'vetoed') return { label: 'Vetoed', tone: 'stop' };
  if (plan.state === 'frozen') return { label: 'Frozen', tone: 'stop' };
  if (now < start) return { label: 'Announced', tone: 'wait' };
  if (now <= end) return { label: 'Sending', tone: 'live' };
  return { label: 'Window ended', tone: 'stop' };
}

export default function LivePage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [limit, setLimit] = useState(25);
  const [now, setNow] = useState(() => Date.now());
  const cursor = useRef(0);
  const freshIds = useRef(new Set<number>());
  // Poll faster while a work cycle is running.
  const snapshotRunning = useRef(false);
  snapshotRunning.current = !!snapshot?.tick.running;

  const pollActivity = useCallback(async () => {
    try {
      const response = await fetch(`/api/proxy/activity?since=${cursor.current}`, { cache: 'no-store' });
      if (response.status === 401) { location.href = '/login'; return; }
      if (!response.ok) throw new Error('Live activity is unavailable right now.');
      const data = await response.json() as Snapshot;
      // A smaller id means the backend restarted with a fresh counter; start over.
      const reset = data.latestId < cursor.current;
      if (reset) cursor.current = 0;
      const incoming = data.events;
      if (cursor.current > 0) incoming.forEach((event) => freshIds.current.add(event.id));
      cursor.current = data.latestId;
      setSnapshot(data);
      setEvents((previous) => (reset ? incoming : [...previous, ...incoming]).slice(-300));
      setError('');
    } catch (pollError) {
      setError(pollError instanceof Error ? pollError.message : 'Live activity is unavailable right now.');
    }
  }, []);

  const pollSummary = useCallback(async () => {
    try {
      const response = await fetch('/api/proxy/activity/summary', { cache: 'no-store' });
      if (response.ok) setSummary(await response.json() as Summary);
    } catch {
      // The feed still works without the summary; the next poll retries.
    }
  }, []);

  useEffect(() => {
    let activityTimer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const loop = async () => {
      if (document.visibilityState === 'visible') await pollActivity();
      if (!stopped) activityTimer = setTimeout(loop, snapshotRunning.current ? 2000 : 5000);
    };
    void loop();
    void pollSummary();
    const summaryTimer = setInterval(() => { if (document.visibilityState === 'visible') void pollSummary(); }, 20_000);
    const clockTimer = setInterval(() => setNow(Date.now()), 1000);
    const onVisible = () => { if (document.visibilityState === 'visible') { void pollActivity(); void pollSummary(); } };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(activityTimer);
      clearInterval(summaryTimer);
      clearInterval(clockTimer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [pollActivity, pollSummary]);


  const visibleEvents = useMemo(() => {
    const stagesFilter = FILTER_STAGES[filter];
    return [...events].reverse().filter((event) =>
      filter === 'issues' ? event.level === 'error' || event.level === 'warn' : !stagesFilter || stagesFilter.includes(event.stage));
  }, [events, filter]);

  const running = !!snapshot?.tick.running;
  const current = snapshot?.current;
  const lastFinished = snapshot?.tick.finishedAt ?? summary?.last_tick_at ?? null;
  const nextTickAt = lastFinished ? new Date(new Date(lastFinished).getTime() + TICK_INTERVAL_MS).toISOString() : null;
  const doneStages = snapshot ? ORDER.filter((stage) => running && snapshot.tick.startedAt && snapshot.stages[stage].lastRunAt && snapshot.stages[stage].lastRunAt! >= snapshot.tick.startedAt && snapshot.stages[stage].status !== 'running').length : 0;
  const b = summary?.businesses ?? {};
  const e = summary?.emails ?? {};

  return (
    <main className="admin-page">
      <div className="admin-content live-content">
        <div className="admin-heading">
          <div><div className="section-kicker">AGENT ACTIVITY</div><h1>Live</h1><p>What the agent is doing right now, where each Send Plan stands, and every step it takes.</p></div>
          {summary?.dry_run && <span className="stepup-state">DRY RUN</span>}
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}

        <section className={`live-now${running ? ' running' : ''}`} aria-live="polite">
          <div className="live-now-top">
            <span className={`live-pulse${running ? ' on' : ''}`} aria-hidden="true" />
            <span className="live-now-state">{!snapshot ? 'Connecting…' : running ? STAGE_INFO[current?.stage ?? 'tick'].label : 'Idle'}</span>
            {running && snapshot?.tick.startedAt && <span className="live-now-time">cycle running {relative(snapshot.tick.startedAt, now).replace(' ago', '')}</span>}
          </div>
          <p className="live-now-message">
            {!snapshot ? 'Loading live activity…'
              : running ? current?.message ?? 'Starting…'
                : lastFinished ? `Last cycle finished ${relative(lastFinished, now)}${snapshot.tick.durationMs ? ` and took ${Math.max(1, Math.round(snapshot.tick.durationMs / 1000))}s` : ''}.`
                  : 'No work cycle has run yet. The tick pinger starts one every 5 minutes.'}
          </p>
          {running ? (
            <div className="live-steps" aria-label={`${doneStages} of ${ORDER.length} steps done`}>
              {ORDER.map((stage) => {
                const state = snapshot!.stages[stage];
                const thisCycle = !!(snapshot!.tick.startedAt && state.lastRunAt && state.lastRunAt >= snapshot!.tick.startedAt);
                return <span key={stage} title={STAGE_INFO[stage].label} className={`live-step ${state.status === 'running' ? 'running' : thisCycle ? (state.status === 'error' ? 'error' : 'done') : ''}`} />;
              })}
            </div>
          ) : nextTickAt && (
            <p className="live-now-next">Next cycle expected {new Date(nextTickAt).getTime() > now ? relative(nextTickAt, now) : 'any moment'}</p>
          )}
        </section>

        <div className="live-grid">
          <div className="live-col">
            {!!summary?.plans.length && (
              <section className="admin-panel">
                <div className="admin-panel-heading"><div><div className="section-kicker">SEND PLANS</div><h2>Where each plan stands</h2></div></div>
                <div className="live-plans">
                  {summary.plans.map((plan) => {
                    const phase = planPhase(plan, now);
                    const pct = plan.total ? Math.round(plan.sent / plan.total * 100) : 0;
                    return (
                      <article className="live-plan" key={plan.id}>
                        <div className="live-plan-top">
                          <strong>{plan.countries.join(', ') || 'Plan'} · {plan.total} {plan.total === 1 ? 'email' : 'emails'}</strong>
                          <span className={`live-phase ${phase.tone}`}>{phase.tone === 'live' && <i />}{phase.label}</span>
                        </div>
                        <div className="live-progress"><span style={{ width: `${pct}%` }} /></div>
                        <div className="live-plan-meta">
                          <span>{plan.sent} of {plan.total} sent{plan.failed ? ` · ${plan.failed} cancelled` : ''}</span>
                          <span>{phase.label === 'Announced' ? `Starts ${relative(plan.starts_at, now)}` : phase.label === 'Sending' ? `Window ends ${relative(plan.ends_at, now)}` : `Ended ${relative(plan.ends_at, now)}`}</span>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            )}

            <section className="admin-panel live-feed-panel">
              <div className="admin-panel-heading">
                <div><div className="section-kicker">ACTIVITY</div><h2>Step by step</h2></div>
                <span className="live-badge"><span className={`live-pulse small${running ? ' on' : ''}`} />{running ? 'Live' : 'Watching'}</span>
              </div>
              <div className="filter-group live-filter" role="tablist" aria-label="Filter activity">
                {(Object.keys(FILTERS) as Filter[]).map((key) => (
                  <button key={key} role="tab" aria-selected={filter === key} className={`filter-button${filter === key ? ' selected' : ''}`} onClick={() => { setFilter(key); setLimit(25); }}>{FILTERS[key]}</button>
                ))}
              </div>
              {!visibleEvents.length ? (
                <p className="admin-empty">{snapshot ? 'Nothing here yet. Activity appears as soon as the next work cycle starts.' : 'Loading…'}</p>
              ) : (
                <ol className="live-feed">
                  {visibleEvents.slice(0, limit).map((event) => {
                    const info = STAGE_INFO[event.stage];
                    return (
                      <li key={event.id} className={`live-event ${event.level}${freshIds.current.has(event.id) ? ' fresh' : ''}`}>
                        <span className="live-event-icon" style={{ background: info.color }} aria-hidden="true">{info.glyph}</span>
                        <div className="live-event-body">
                          <p>{event.message}</p>
                          <small>{info.label} · {clock(event.at)}</small>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
              {visibleEvents.length > limit && (
                <button className="text-button live-more" onClick={() => setLimit((value) => value + 50)}>Show {Math.min(50, visibleEvents.length - limit)} more</button>
              )}
            </section>
          </div>

          <div className="live-col">
            <section className="admin-panel">
              <div className="admin-panel-heading"><div><div className="section-kicker">WORK CYCLE</div><h2>Each step</h2></div></div>
              <div className="live-stage-list">
                {ORDER.map((stage) => {
                  const state = snapshot?.stages[stage];
                  const info = STAGE_INFO[stage];
                  return (
                    <div className="live-stage" key={stage}>
                      <span className="live-event-icon" style={{ background: info.color }} aria-hidden="true">{info.glyph}</span>
                      <div className="live-stage-body">
                        <strong>{info.label}</strong>
                        <small>{state?.lastMessage ?? 'Not run yet'}</small>
                      </div>
                      <div className="live-stage-status">
                        {state?.status === 'running' ? <span className="live-spinner" aria-label="Running" />
                          : state?.status === 'error' ? <span className="live-status-icon error" aria-label="Error">!</span>
                            : state?.status === 'done' ? <span className="live-status-icon done" aria-label="Done">✓</span>
                              : <span className="live-status-icon idle" aria-label="Idle">–</span>}
                        <small>{state?.lastRunAt ? relative(state.lastRunAt, now) : ''}</small>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="admin-panel">
              <div className="admin-panel-heading"><div><div className="section-kicker">PIPELINE</div><h2>Right now</h2></div></div>
              <div className="funnel-list">
                <div className="funnel-row"><span>Waiting for research</span><strong>{b.new ?? 0}</strong></div>
                <div className="funnel-row"><span>Drafts to review</span><strong>{e.drafted ?? 0}</strong></div>
                <div className="funnel-row"><span>Approved · in undo window</span><strong>{(e.approved ?? 0)} · {(e.held ?? 0)}</strong></div>
                <div className="funnel-row"><span>Sent in last 24 hours</span><strong>{summary ? `${summary.sent_24h} of ${summary.daily_cap}` : '—'}</strong></div>
                <div className="funnel-row"><span>Contacted businesses</span><strong>{b.contacted ?? 0}</strong></div>
                <div className="funnel-row"><span>Manual call queue</span><strong>{b.call_queue ?? 0}</strong></div>
                <div className="funnel-row"><span>Skipped or cooling down</span><strong>{(b.skipped ?? 0) + (b.cooldown ?? 0)}</strong></div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}
