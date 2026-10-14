'use client';

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';

type Analytics = {
  period_days: number;
  generated_at: string;
  sample_warning: boolean;
  kpis: {
    sent_today: number;
    sent_7d: number;
    sent_30d: number;
    human_replies_30d: number;
    bounce_rate_30d: number | null;
    complaint_rate_30d: number | null;
    human_reply_rate_30d: number | null;
    won_deals: number;
    won_value_by_currency: Array<{ currency: string; value_cents: number }>;
  };
  funnel: Record<string, number>;
  daily: Array<{ date: string; sent: number; replies: number; bounces: number }>;
};

type BreakdownRow = { key: string; n: number; replies: number; rate: number | null; lo: number | null; hi: number | null; insufficient: boolean };
type Breakdowns = { period_days: number; note: string; sample: number; dimensions: Array<{ dimension: string; label: string; rows: BreakdownRow[] }> };
type RoiSettings = { hourlyRate: number; reviewMinutes: number; replyMinutes: number; fixedMonthlyCost: number; llmCostPerMillionTokens: number; currency: string };
type Roi = {
  period_days: number;
  settings: RoiSettings;
  activity: { sent: number; reviewed_drafts: number; human_replies: number; llm_tokens: number };
  costs: { currency: string; llm: number; time: number; fixed: number; total: number };
  revenue_won: Array<{ currency: string; value_cents: number; deals: number }>;
  pipeline_open: Array<{ stage: string; currency: string; value_cents: number; deals: number }>;
  efficiency: { cost_per_reply: number | null; cost_per_100_sent: number | null; revenue_per_100_sent: Array<{ currency: string; value_cents: number }>; roi: number | null };
  notes: string[];
};

const percent = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(1)}%`;
const amount = (cents: number, currency: string) => {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }
};

export default function AnalyticsPage() {
  const [data, setData] = useState<Analytics | null>(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [breakdowns, setBreakdowns] = useState<Breakdowns | null>(null);
  const [roi, setRoi] = useState<Roi | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [roiForm, setRoiForm] = useState<Record<keyof RoiSettings, string> | null>(null);
  const [roiBusy, setRoiBusy] = useState(false);
  const [roiMessage, setRoiMessage] = useState('');

  const loadExtras = useCallback(async () => {
    try {
      const [breakdownResponse, roiResponse, accountResponse] = await Promise.all([
        fetch(`/api/proxy/analytics/breakdowns?days=${days}`),
        fetch(`/api/proxy/analytics/roi?days=${days}`),
        fetch('/api/proxy/auth/me'),
      ]);
      setBreakdowns(breakdownResponse.ok ? await breakdownResponse.json() as Breakdowns : null);
      setRoi(roiResponse.ok ? await roiResponse.json() as Roi : null);
      const account = accountResponse.ok ? await accountResponse.json() as { role?: string } : null;
      if (account?.role === 'owner') {
        const settingsResponse = await fetch('/api/proxy/settings/roi');
        if (settingsResponse.ok) {
          const settings = await settingsResponse.json() as RoiSettings;
          setIsOwner(true);
          setRoiForm({
            hourlyRate: String(settings.hourlyRate), reviewMinutes: String(settings.reviewMinutes), replyMinutes: String(settings.replyMinutes),
            fixedMonthlyCost: String(settings.fixedMonthlyCost), llmCostPerMillionTokens: String(settings.llmCostPerMillionTokens), currency: settings.currency,
          });
        }
      }
    } catch {
      setBreakdowns(null);
      setRoi(null);
    }
  }, [days]);

  const saveRoi = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!roiForm) return;
    setRoiBusy(true);
    setRoiMessage('');
    try {
      const response = await fetch('/api/proxy/settings/roi', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          hourlyRate: Number(roiForm.hourlyRate), reviewMinutes: Number(roiForm.reviewMinutes), replyMinutes: Number(roiForm.replyMinutes),
          fixedMonthlyCost: Number(roiForm.fixedMonthlyCost), llmCostPerMillionTokens: Number(roiForm.llmCostPerMillionTokens),
          currency: roiForm.currency.trim().toUpperCase(),
        }),
      });
      if (!response.ok) throw new Error('Check the values: rates must be non-negative numbers and the currency a 3-letter code.');
      setRoiMessage('Cost settings saved.');
      await loadExtras();
    } catch (saveError) {
      setRoiMessage(saveError instanceof Error ? saveError.message : 'Could not save cost settings.');
    } finally {
      setRoiBusy(false);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`/api/proxy/analytics?days=${days}`);
      if (response.status === 401) {
        location.href = '/login';
        return;
      }
      if (!response.ok) throw new Error('Could not load analytics.');
      setData(await response.json());
      void loadExtras();
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load analytics.');
    } finally {
      setLoading(false);
    }
  }, [days, loadExtras]);

  useEffect(() => { void load(); }, [load]);

  const maxValue = Math.max(1, ...(data?.daily.map((day) => day.sent + day.replies + day.bounces) ?? []));
  const funnelLabels: Record<string, string> = {
    sourced: 'Businesses sourced',
    audited: 'Audited',
    contactable: 'Contactable',
    drafted: 'Drafts and outreach',
    sent: 'Sent (last 30 days)',
    replied: 'Human replies (last 30 days)',
    won: 'Won deals',
  };

  return (
    <main className="admin-page">
      <div className="admin-content">
        <div className="admin-heading">
          <div>
            <div className="section-kicker">PERFORMANCE</div>
            <h1>Analytics</h1>
            <p>Outreach outcomes from your actual sends, replies, and recorded deals.</p>
          </div>
          <select className="analytics-range" value={days} onChange={(event) => setDays(Number(event.target.value))} aria-label="Analytics period">
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        {loading && <section className="admin-panel"><p>Loading analytics…</p></section>}
        {!loading && data && (
          <>
            {data.sample_warning && <div className="analytics-caveat">Small sample: fewer than 30 sends in the last 30 days. Treat rates as directional, not conclusive.</div>}
            <section className="analytics-kpis" aria-label="Outreach KPIs">
              <article className="admin-panel"><span>Sent today</span><strong>{data.kpis.sent_today}</strong><small>Cap configured separately</small></article>
              <article className="admin-panel"><span>Sent · 7 days</span><strong>{data.kpis.sent_7d}</strong><small>Rolling week</small></article>
              <article className="admin-panel"><span>Human reply rate</span><strong>{percent(data.kpis.human_reply_rate_30d)}</strong><small>{data.kpis.human_replies_30d} replies / {data.kpis.sent_30d} sends, 30 days</small></article>
              <article className="admin-panel"><span>Bounce rate</span><strong>{percent(data.kpis.bounce_rate_30d)}</strong><small>Gmail-classified bounces</small></article>
              <article className="admin-panel"><span>Complaint rate</span><strong>{percent(data.kpis.complaint_rate_30d)}</strong><small>Rules-classified complaints</small></article>
              <article className="admin-panel"><span>Won deals</span><strong>{data.kpis.won_deals}</strong><small>{data.kpis.won_value_by_currency.length
                ? data.kpis.won_value_by_currency.map((value) => amount(value.value_cents, value.currency)).join(' · ')
                : 'No won value recorded'}</small></article>
            </section>
            <section className="analytics-layout">
              <div className="admin-panel">
                <div className="admin-panel-heading">
                  <div><div className="section-kicker">LAST {days} DAYS</div><h2>Daily activity</h2><p>Replies are Gmail-classified responses; automated replies are excluded.</p></div>
                </div>
                <div className="activity-chart" style={{ gridTemplateColumns: `repeat(${data.daily.length}, minmax(5px, 1fr))` }} role="img" aria-label={`Daily sends, replies, and bounces over ${days} days`}>
                  {data.daily.map((day) => {
                    const sum = day.sent + day.replies + day.bounces;
                    return (
                      <div className="activity-day" key={day.date} title={`${day.date}: ${day.sent} sends, ${day.replies} replies, ${day.bounces} bounces`}>
                        <div className="activity-bar" style={{ height: `${Math.max(3, sum / maxValue * 100)}%` }}>
                          <span className="activity-sent" style={{ flexGrow: day.sent }} />
                          <span className="activity-replies" style={{ flexGrow: day.replies }} />
                          <span className="activity-bounces" style={{ flexGrow: day.bounces }} />
                        </div>
                        <small>{day.date.slice(5)}</small>
                      </div>
                    );
                  })}
                </div>
                <div className="chart-legend"><span><i className="activity-sent" /> Sent</span><span><i className="activity-replies" /> Replies</span><span><i className="activity-bounces" /> Bounces</span></div>
              </div>
              <div className="admin-panel">
                <div className="section-kicker">PIPELINE SNAPSHOT</div><h2>Lead funnel</h2>
                <div className="funnel-list">
                  {Object.entries(data.funnel).map(([key, value]) => (
                    <div className="funnel-row" key={key}><span>{funnelLabels[key] ?? key}</span><strong>{value.toLocaleString()}</strong></div>
                  ))}
                </div>
                <p className="analytics-footnote">Sourcing and audit totals are current database counts; send and reply totals use the last 30 days.</p>
              </div>
            </section>
            {roi && (
              <section className="admin-panel">
                <div className="admin-panel-heading"><div><div className="section-kicker">COST AND RETURN</div><h2>ROI · last {roi.period_days} days</h2><p>Costs only include the rates you set below; unset rates count as zero.</p></div></div>
                <div className="funnel-list">
                  <div className="funnel-row"><span>Activity</span><strong>{roi.activity.sent} sent · {roi.activity.reviewed_drafts} drafts reviewed · {roi.activity.human_replies} replies</strong></div>
                  <div className="funnel-row"><span>Costs ({roi.costs.currency})</span><strong>LLM {amount(Math.round(roi.costs.llm * 100), roi.costs.currency)} · time {amount(Math.round(roi.costs.time * 100), roi.costs.currency)} · fixed {amount(Math.round(roi.costs.fixed * 100), roi.costs.currency)} = {amount(Math.round(roi.costs.total * 100), roi.costs.currency)}</strong></div>
                  <div className="funnel-row"><span>Revenue won</span><strong>{roi.revenue_won.length ? roi.revenue_won.map((row) => `${amount(row.value_cents, row.currency)} (${row.deals})`).join(' · ') : 'None in this period'}</strong></div>
                  <div className="funnel-row"><span>Open pipeline</span><strong>{roi.pipeline_open.length ? roi.pipeline_open.map((row) => `${row.stage}: ${amount(row.value_cents, row.currency)} (${row.deals})`).join(' · ') : 'None'}</strong></div>
                  <div className="funnel-row"><span>Cost per reply · per 100 sent</span><strong>{roi.efficiency.cost_per_reply === null ? '—' : amount(Math.round(roi.efficiency.cost_per_reply * 100), roi.costs.currency)} · {roi.efficiency.cost_per_100_sent === null ? '—' : amount(Math.round(roi.efficiency.cost_per_100_sent * 100), roi.costs.currency)}</strong></div>
                  <div className="funnel-row"><span>Revenue per 100 sent</span><strong>{roi.efficiency.revenue_per_100_sent.length ? roi.efficiency.revenue_per_100_sent.map((row) => amount(row.value_cents, row.currency)).join(' · ') : '—'}</strong></div>
                  <div className="funnel-row"><span>ROI ({roi.costs.currency} revenue only)</span><strong>{roi.efficiency.roi === null ? '—' : `${(roi.efficiency.roi * 100).toFixed(0)}%`}</strong></div>
                </div>
                {roi.notes.map((note) => <p className="analytics-footnote" key={note}>{note}</p>)}
                {isOwner && roiForm && (
                  <form className="brain-form" onSubmit={saveRoi}>
                    <label>Your hourly rate<input type="number" min={0} max={10000} step="any" value={roiForm.hourlyRate} onChange={(event) => setRoiForm({ ...roiForm, hourlyRate: event.target.value })} /></label>
                    <label>Minutes per draft review<input type="number" min={0} max={120} step="any" value={roiForm.reviewMinutes} onChange={(event) => setRoiForm({ ...roiForm, reviewMinutes: event.target.value })} /></label>
                    <label>Minutes per reply handled<input type="number" min={0} max={240} step="any" value={roiForm.replyMinutes} onChange={(event) => setRoiForm({ ...roiForm, replyMinutes: event.target.value })} /></label>
                    <label>Fixed monthly cost<input type="number" min={0} max={1000000} step="any" value={roiForm.fixedMonthlyCost} onChange={(event) => setRoiForm({ ...roiForm, fixedMonthlyCost: event.target.value })} /></label>
                    <label>LLM cost per 1M tokens<input type="number" min={0} max={1000} step="any" value={roiForm.llmCostPerMillionTokens} onChange={(event) => setRoiForm({ ...roiForm, llmCostPerMillionTokens: event.target.value })} /></label>
                    <label>Currency<input value={roiForm.currency} maxLength={3} onChange={(event) => setRoiForm({ ...roiForm, currency: event.target.value.toUpperCase() })} /></label>
                    <div><button className="approve-button" type="submit" disabled={roiBusy}>{roiBusy ? 'Saving…' : 'Save cost settings'}</button></div>
                    {roiMessage && <div className="wide analytics-footnote" role="status">{roiMessage}</div>}
                  </form>
                )}
              </section>
            )}
            {breakdowns && (
              <section className="admin-panel">
                <div className="admin-panel-heading"><div><div className="section-kicker">BREAKDOWNS</div><h2>Reply rate by segment</h2><p>{breakdowns.note}</p></div></div>
                {!breakdowns.sample ? <p className="admin-empty">No real sends in this period yet.</p> : breakdowns.dimensions.map((group) => (
                  <div key={group.dimension}>
                    <h3 className="brain-subhead">{group.label}</h3>
                    <div className="brain-scroll"><table className="brain-table">
                      <thead><tr><th>Segment</th><th>Sends</th><th>Replies</th><th>Rate</th><th>90% range</th></tr></thead>
                      <tbody>{group.rows.map((row) => (
                        <tr key={row.key}>
                          <td>{row.key.replaceAll('_', ' ')} {row.insufficient && <span className="brain-tag warn">insufficient data</span>}</td>
                          <td>{row.n}</td><td>{row.replies}</td><td>{percent(row.rate)}</td>
                          <td>{row.lo === null || row.hi === null ? '—' : `${(row.lo * 100).toFixed(1)}% – ${(row.hi * 100).toFixed(1)}%`}</td>
                        </tr>))}</tbody>
                    </table></div>
                  </div>
                ))}
              </section>
            )}
            <p className="analytics-updated">Updated {new Date(data.generated_at).toLocaleString()} · <a href="/pipeline">Manage pipeline deals</a></p>
          </>
        )}
      </div>
    </main>
  );
}
