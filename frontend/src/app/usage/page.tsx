'use client';

import { useCallback, useEffect, useState } from 'react';

type Usage = {
  generated_at: string;
  process_uptime_seconds: number;
  database: { bytes: number; limit_bytes: number; limit_source: string; percent: number };
  llm: { daily_budget: number; used_today: number; month_tokens: number; daily_history: { day: string; tokens: number }[] };
  queue: { pending: number; sent_today: number; by_status: Record<string, number> };
  last_tick_at: string | null;
  pagespeed?: { calls_today: number; month_calls: number; daily_quota: number };
  contact_search?: Record<'tavily' | 'hunter', { configured: boolean; month_calls: number; monthly_limit: number }>;
  render_instance_hours: number | null;
  render_instance_hours_note: string;
};

type Health = {
  generated_at: string;
  status: 'insufficient_data' | 'healthy' | 'warning' | 'red';
  sample_size: number;
  period_days: number;
  metrics: { sent: number; replies: number; bounces: number; complaints: number; suppressions: number; open_replies: number; bounce_rate: number | null; complaint_rate: number | null };
  warmup: { cap: number; stage: number; stages: number[]; daysPerStage: number; firstSentAt: string | null; sent_today: number };
  note: string | null;
};

type SeedTest = { id: string; mailboxProvider: string; placement: string; testedAt: string };

function formatTokens(value: number) { return new Intl.NumberFormat().format(value); }
function formatPercent(value: number | null) { return value === null ? '—' : `${(value * 100).toFixed(2)}%`; }
function formatBytes(value: number) {
  const mb = value / (1024 * 1024);
  return `${mb.toFixed(mb < 100 ? 1 : 0)} MB`;
}

export default function UsagePage() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [seedTests, setSeedTests] = useState<SeedTest[]>([]);
  const [email, setEmail] = useState('');
  const [provider, setProvider] = useState('');
  const [placement, setPlacement] = useState('inbox');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const responses = await Promise.all([
        fetch('/api/proxy/usage'),
        fetch('/api/proxy/inbox-health'),
        fetch('/api/proxy/inbox-health/seed-tests'),
      ]);
      if (responses.some((response) => response.status === 401)) { location.href = '/login'; return; }
      if (responses.some((response) => !response.ok)) throw new Error('Could not load usage and inbox health.');
      const [usageData, healthData, seedData] = await Promise.all(responses.map((response) => response.json()));
      setUsage(usageData as Usage);
      setHealth(healthData as Health);
      setSeedTests(seedData as SeedTest[]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load usage and inbox health.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const logSeedResult = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/proxy/inbox-health/seed-tests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), mailboxProvider: provider.trim(), placement }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error === 'invalid_seed_test' ? 'Enter a valid email, mailbox provider, and placement.' : 'Could not record seed test.');
      setEmail('');
      setProvider('');
      setNotice('Inbox placement recorded. The recipient address is hashed and not stored in the activity list.');
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not record seed test.');
    } finally {
      setBusy(false);
    }
  };

  const dbPercent = usage ? usage.database.percent * 100 : 0;
  const dbWarning = dbPercent >= 80;
  const budgetPercent = usage ? Math.min(usage.llm.used_today / Math.max(usage.llm.daily_budget, 1) * 100, 100) : 0;

  return (
    <main className="admin-page">
      <div className="admin-content">
        <div className="admin-heading">
          <div><div className="section-kicker">OPERATIONS</div><h1>Usage & inbox health</h1><p>Measured workload, database capacity, sending health, and manually observed mailbox placement.</p></div>
          <button className="reject-button" disabled={loading} onClick={() => void load()}>Refresh</button>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        {notice && <div className="admin-notice" role="status">{notice}</div>}
        {loading && !usage ? <section className="admin-panel"><p className="admin-empty">Loading live operational metrics…</p></section> : usage && health && (
          <>
            <div className="analytics-kpis">
              <section className="admin-panel"><span>LLM tokens today</span><strong>{formatTokens(usage.llm.used_today)}</strong><small>of {formatTokens(usage.llm.daily_budget)} budget</small><div className="ops-progress"><span style={{ width: `${budgetPercent}%` }} /></div></section>
              <section className="admin-panel"><span>Database size</span><strong>{formatBytes(usage.database.bytes)}</strong><small>of {formatBytes(usage.database.limit_bytes)} configured limit</small><div className={`ops-progress${dbWarning ? ' warning' : ''}`}><span style={{ width: `${Math.min(dbPercent, 100)}%` }} /></div></section>
              <section className="admin-panel"><span>Inbox health · 30 days</span><strong className={`health-status ${health.status}`}>{health.status.replace('_', ' ')}</strong><small>{health.sample_size} sends in sample · {health.metrics.open_replies} open replies</small></section>
              <section className="admin-panel"><span>Queue / sent today</span><strong>{usage.queue.pending} / {usage.queue.sent_today}</strong><small>pending / sent today</small></section>
              <section className="admin-panel"><span>Service uptime</span><strong>{Math.floor(usage.process_uptime_seconds / 3600)}h {Math.floor(usage.process_uptime_seconds % 3600 / 60)}m</strong><small>Last tick: {usage.last_tick_at ? new Date(usage.last_tick_at).toLocaleString() : 'not recorded'}</small></section>
              <section className="admin-panel"><span>Warm-up cap</span><strong>{health.warmup.sent_today} / {health.warmup.cap}</strong><small>{health.warmup.firstSentAt ? `Stage ${health.warmup.stage} of ${health.warmup.stages.length} · ${health.warmup.daysPerStage} days per stage` : 'Starts with the first real send'} · {health.warmup.stages.join(' → ')}</small></section>
            </div>

            {(health.note || dbWarning) && <div className="analytics-caveat">{health.note ?? `Database size is ${dbPercent.toFixed(0)}% of the configured limit. Review Supabase usage and retention.`}</div>}
            <div className="analytics-layout">
              <section className="admin-panel" id="inbox-health">
                <div className="admin-panel-heading"><div><div className="section-kicker">INBOX HEALTH</div><h2>Sending outcomes</h2><p>Observed over the last {health.period_days} days.</p></div><span className={`health-status ${health.status}`}>{health.status.replace('_', ' ')}</span></div>
                <div className="funnel-list">
                  <div className="funnel-row"><span>Delivered send attempts</span><strong>{health.metrics.sent}</strong></div>
                  <div className="funnel-row"><span>Human replies</span><strong>{health.metrics.replies}</strong></div>
                  <div className="funnel-row"><span>Bounces</span><strong>{health.metrics.bounces} · {formatPercent(health.metrics.bounce_rate)}</strong></div>
                  <div className="funnel-row"><span>Complaints</span><strong>{health.metrics.complaints} · {formatPercent(health.metrics.complaint_rate)}</strong></div>
                  <div className="funnel-row"><span>Suppressed recipients</span><strong>{health.metrics.suppressions}</strong></div>
                </div>
                <p className="analytics-footnote">Health rates are not reliable until at least 30 sends. Red status is a safety signal; review provider reputation before enabling live sends.</p>
              </section>
              <section className="admin-panel">
                <div className="admin-panel-heading"><div><div className="section-kicker">RESOURCE LIMITS</div><h2>Current usage</h2></div></div>
                <div className="funnel-list">
                  <div className="funnel-row"><span>LLM tokens this month</span><strong>{formatTokens(usage.llm.month_tokens)}</strong></div>
                  <div className="funnel-row"><span>Queue by status</span><strong>{Object.entries(usage.queue.by_status).map(([key, value]) => `${key}: ${value}`).join(' · ') || 'No records'}</strong></div>
                  <div className="funnel-row"><span>Database occupancy</span><strong>{dbPercent.toFixed(1)}%</strong></div>
                  <div className="funnel-row"><span>PageSpeed calls today / this month</span><strong>{usage.pagespeed ? `${formatTokens(usage.pagespeed.calls_today)} of ${formatTokens(usage.pagespeed.daily_quota)} · ${formatTokens(usage.pagespeed.month_calls)}` : 'Unavailable'}</strong></div>
                  {usage.contact_search && (['tavily', 'hunter'] as const).map((provider) => {
                    const item = usage.contact_search![provider];
                    return <div className="funnel-row" key={provider}><span>{provider === 'tavily' ? 'Tavily' : 'Hunter.io'} email searches this month</span><strong>{item.configured ? `${formatTokens(item.month_calls)} of ${formatTokens(item.monthly_limit)}` : 'Not configured'}</strong></div>;
                  })}
                  <div className="funnel-row"><span>Backend awake hours (self-measured)</span><strong>{usage.render_instance_hours === null ? 'Unavailable' : `${usage.render_instance_hours} of 750`}</strong></div>
                </div>
                <p className="analytics-footnote">{usage.render_instance_hours_note} Database limit is a configured warning threshold, not a live Supabase plan entitlement check.</p>
              </section>
            </div>

            <section className="admin-panel">
              <div className="admin-panel-heading"><div><div className="section-kicker">MANUAL PLACEMENT CHECK</div><h2>Record seed inbox test</h2><p>Send your own seed messages separately and record where they land. This does not send an email from the app; recipient addresses are hashed before storage.</p></div></div>
              <form className="seed-test-form" onSubmit={logSeedResult}>
                <label>Email used for test<input type="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></label>
                <label>Mailbox provider<input required maxLength={80} value={provider} onChange={(event) => setProvider(event.target.value)} placeholder="Gmail, Outlook…" /></label>
                <label>Placement<select value={placement} onChange={(event) => setPlacement(event.target.value)}><option value="inbox">Inbox</option><option value="spam">Spam</option><option value="missing">Missing</option></select></label>
                <button className="approve-button" type="submit" disabled={busy}>{busy ? 'Recording…' : 'Record result'}</button>
              </form>
              {!seedTests.length ? <p className="admin-empty">No manual placement results recorded yet.</p> : <div className="seed-test-history">{seedTests.map((test) => <div className="funnel-row" key={test.id}><span>{test.mailboxProvider} · {new Date(test.testedAt).toLocaleString()}</span><strong className={`placement-badge ${test.placement}`}>{test.placement}</strong></div>)}</div>}
            </section>
            <p className="analytics-updated">Updated {new Date(usage.generated_at).toLocaleString()} · Awake hours are measured by the backend itself, not read from Render billing.</p>
          </>
        )}
      </div>
    </main>
  );
}
