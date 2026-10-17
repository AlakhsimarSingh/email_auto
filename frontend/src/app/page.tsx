'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

type Draft = {
  id: number;
  subject: string;
  body: string;
  name: string;
  city: string;
  website_url: string;
  to_email: string;
  findings: string[];
  screenshot_data: string | null;
  manual_required: boolean;
  original_subject: string | null;
  original_body: string | null;
  contact_source_url: string | null;
  score_signals: Array<{ key: string; evidence: string; sourceUrl?: string }> | null;
  draft_angle: string | null;
  portfolio_project: string | null;
  draft_confidence: number | null;
  selection?: Record<string, unknown> | null;
  agent_low_risk?: boolean;
  signature_preview?: string;
  draft_issues?: string[];
  draft_template?: 'pitch_v2' | null;
};

type HeldEmail = {
  id: number;
  subject: string;
  name: string;
  email: string;
  timezone: string | null;
  scheduled_for: string | null;
  hold_until: string | null;
};

type Stats = {
  to_review: number;
  queued: number;
  sent_24h: number;
  site_leads: number;
  no_site_leads: number;
  call_queue: number;
  pending_replies: number;
  overdue_replies: number;
};


function Icon({ name }: { name: 'grid' | 'mail' | 'clock' | 'send' | 'refresh' | 'check' | 'arrow' | 'spark' }) {
  const paths: Record<typeof name, ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m4 7 8 6 8-6" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    send: <><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>,
    refresh: <><path d="M20 7v5h-5" /><path d="M4 17v-5h5" /><path d="M5.6 9a7 7 0 0 1 11.6-2L20 12M4 12l2.8 5a7 7 0 0 0 11.6-2" /></>,
    check: <><path d="m5 12 4 4L19 6" /></>,
    arrow: <><path d="M7 17 17 7M7 7h10v10" /></>,
    spark: <><path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2L12 3Z" /><path d="m19 14 1.2 2.8L23 18l-2.8 1.2L19 22l-1.2-2.8L15 18l2.8-1.2L19 14Z" /></>,
  };

  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

export default function Review() {
  const [items, setItems] = useState<Draft[]>([]);
  const [held, setHeld] = useState<HeldEmail[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [rated, setRated] = useState<Record<number, 'up' | 'down'>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [draftResponse, statsResponse, heldResponse] = await Promise.all([
        fetch('/api/proxy/emails/review'),
        fetch('/api/proxy/stats'),
        fetch('/api/proxy/emails/held'),
      ]);
      if ([draftResponse, statsResponse, heldResponse].some((response) => response.status === 401)) {
        location.href = '/login';
        return;
      }
      if ([draftResponse, statsResponse, heldResponse].some((response) => !response.ok)) {
        throw new Error('Could not load dashboard data. Check the backend and try again.');
      }
      const [draftData, statsData, heldData] = await Promise.all([
        draftResponse.json(), statsResponse.json(), heldResponse.json(),
      ]);
      setItems(draftData);
      setStats(statsData);
      setHeld(heldData);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load dashboard data.');
    } finally {
      setLoading(false);
    }
  }, []);


  useEffect(() => { void load(); }, [load]);

  const edit = (id: number, key: 'subject' | 'body', value: string) => {
    setItems((current) => current.map((item) => item.id === id ? { ...item, [key]: value } : item));
  };

  const act = async (id: number, action: 'approve' | 'reject' | 'undo', draft?: Draft) => {
    setBusyId(id);
    setError('');
    try {
      const response = await fetch(`/api/proxy/emails/${id}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft ? { subject: draft.subject, body: draft.body } : {}),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        if (payload?.error === 'manual_draft_must_be_rewritten') {
          throw new Error('This draft needs manual writing. Edit the message before approving it.');
        }
        throw new Error(`Could not ${action} this draft. Please try again.`);
      }
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'The action failed. Please try again.');
    } finally {
      setBusyId(null);
    }
  };

  const rewrite = async (id: number) => {
    setBusyId(id);
    setError('');
    try {
      const response = await fetch(`/api/proxy/emails/${id}/regenerate`, { method: 'POST' });
      if (!response.ok) throw new Error(response.status === 404 ? 'This draft can no longer be rewritten (it may already be approved or rejected).' : 'Could not rewrite this draft. Please try again.');
      await load();
    } catch (rewriteError) {
      setError(rewriteError instanceof Error ? rewriteError.message : 'Could not rewrite this draft.');
    } finally {
      setBusyId(null);
    }
  };

  const rate = async (id: number, score: 3 | -3) => {
    setError('');
    try {
      const response = await fetch('/api/proxy/agent/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetType: 'email', targetId: id, score }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error === 'learning_frozen' ? 'Learning is frozen, so feedback was not applied.' : 'Could not save feedback. Please try again.');
      }
      setRated((current) => ({ ...current, [id]: score > 0 ? 'up' : 'down' }));
    } catch (rateError) {
      setError(rateError instanceof Error ? rateError.message : 'Could not save feedback.');
    }
  };

  return (
    <div className="dashboard-shell">

      <main className="main-content">

        <div className="dashboard-content">
          <section className="welcome-row">
            <div>
              <div className="eyebrow"><Icon name="spark" /> OUTREACH OVERVIEW</div>
              <h1>Your outreach at a glance</h1>
              <p className="page-subtitle">Track your drafts, queued emails, and recent sends.</p>
            </div>
            <button className="refresh-button" onClick={() => void load()} disabled={loading}>
              <Icon name="refresh" /> {loading ? 'Refreshing' : 'Refresh data'}
            </button>
          </section>

          {error && <div className="error-banner" role="alert">{error}</div>}
          {!!stats?.overdue_replies && (
            <a className="error-banner reply-sla-alert" href="/inbox">
              {stats.overdue_replies} human {stats.overdue_replies === 1 ? 'reply is' : 'replies are'} waiting longer than four hours. Review the inbox.
            </a>
          )}

          <section className="metrics-grid" aria-label="Email metrics">
            <article className="metric-card">
              <div className="metric-top"><span className="metric-icon lavender"><Icon name="mail" /></span><span className="metric-caption">NEEDS ATTENTION</span></div>
              <div className="metric-number">{loading && !stats ? '—' : stats?.to_review ?? 0}</div>
              <div className="metric-bottom"><strong>Drafts to review</strong><span>Awaiting your approval</span></div>
            </article>
            <article className="metric-card">
              <div className="metric-top"><span className="metric-icon mint"><Icon name="clock" /></span><span className="metric-caption">READY TO SEND</span></div>
              <div className="metric-number">{loading && !stats ? '—' : stats?.queued ?? 0}</div>
              <div className="metric-bottom"><strong>Queued emails</strong><span>Approved and scheduled</span></div>
            </article>
            <article className="metric-card">
              <div className="metric-top"><span className="metric-icon peach"><Icon name="send" /></span><span className="metric-caption">LAST 24 HOURS</span></div>
              <div className="metric-number">{loading && !stats ? '—' : stats?.sent_24h ?? 0}</div>
              <div className="metric-bottom"><strong>Emails sent</strong><span>Recorded in the last 24 hours</span></div>
            </article>
          </section>

          <section className="dashboard-grid">
            <div className="panel review-panel" id="review-queue">
              <div className="panel-heading">
                <div>
                  <div className="section-kicker">YOUR WORK QUEUE</div>
                  <h2>Drafts to review</h2>
                  <p>Check each message before approving it.</p>
                </div>
                <span className="queue-pill">{stats?.to_review ?? 0} pending</span>
              </div>

              {loading && <div className="empty-state"><span className="loading-spinner" /> Loading your drafts…</div>}
              {!loading && !items.length && (
                <div className="empty-state">
                  <span className="empty-icon"><Icon name="check" /></span>
                  <h3>All caught up</h3>
                  <p>No drafts are waiting for review. New drafts will appear here after a tick finds eligible businesses.</p>
                  <button className="text-button" onClick={() => void load()}>Check again <Icon name="arrow" /></button>
                </div>
              )}

              {!loading && items.map((draft) => (
                <article className="draft-card" key={draft.id}>
                  <div className="draft-meta">
                    <div className="business-avatar">{(draft.name || '?').slice(0, 1).toUpperCase()}</div>
                    <div className="business-info">
                      <strong>{draft.name}</strong>
                      <span>{draft.city} <span className="meta-separator">·</span> <a href={draft.website_url} target="_blank" rel="noreferrer">{draft.website_url}</a></span>
                    </div>
                    <span className="draft-status">Needs review</span>
                  </div>
                  {draft.screenshot_data && <img className="audit-thumbnail" src={`data:image/webp;base64,${draft.screenshot_data}`} alt={`Temporary PageSpeed preview of ${draft.name}'s website`} />}
                  <div className="recipient-line"><span>TO</span>{draft.to_email}</div>
                  {draft.contact_source_url && <div className="source-line">Contact published at <a href={draft.contact_source_url} target="_blank" rel="noreferrer">{draft.contact_source_url}</a></div>}
                  {draft.manual_required && (
                    <div className="manual-writing-warning" role="status">
                      {draft.draft_template === 'pitch_v2' ? (
                        <>
                          <strong>Written from the ready-made pitch.</strong> The AI version could not be used{draft.draft_issues?.length ? ':' : '.'}
                          {!!draft.draft_issues?.length && <ul>{draft.draft_issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
                          <span>The message below is built only from the verified findings. Read it, adjust anything that does not fit this business, and approve, or press Rewrite to try the AI again.</span>
                        </>
                      ) : (
                        <>
                          <strong>This draft uses the old wording.</strong>
                          <span>It was written before the new pitch. Press <b>Rewrite</b> to regenerate it, or edit the message yourself before approving.</span>
                        </>
                      )}
                    </div>
                  )}
                  {draft.draft_angle && <div className="draft-angle">Angle: {draft.draft_angle}</div>}
                  {draft.portfolio_project && <div className="draft-angle">Matched portfolio example: {draft.portfolio_project}</div>}
                  {draft.selection && (
                    <div className="draft-angle">
                      Why selected: {draft.selection.mode === 'explore' ? 'exploration pick' : 'highest expected value'}
                      {typeof draft.selection.segment === 'string' && <> · segment {draft.selection.segment.replace('|', ' · ')}</>}
                      {typeof draft.selection.segmentMean === 'number' && <> · estimated reply rate {(draft.selection.segmentMean * 100).toFixed(1)}%</>}
                    </div>
                  )}
                  {draft.agent_low_risk && <div className="draft-angle">Agent flag: low-risk draft (high confidence, and you rarely edit drafts like this). It still needs your approval.</div>}
                  {!!draft.findings?.length && (
                    <div className="finding-list">
                      {draft.findings.map((finding) => <span className="finding-tag" key={finding}>{finding.replaceAll('_', ' ')}</span>)}
                    </div>
                  )}
                  {!!draft.score_signals?.length && (
                    <details className="evidence-details">
                      <summary>Verified findings and evidence</summary>
                      <ul>
                        {draft.score_signals.map((signal, index) => (
                          <li key={`${signal.key}-${index}`}>
                            <strong>{signal.key.replaceAll('_', ' ')}</strong> — {signal.evidence}
                            {signal.sourceUrl && <> · <a href={signal.sourceUrl} target="_blank" rel="noreferrer">source</a></>}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  <label className="field-label" htmlFor={`subject-${draft.id}`}>Subject</label>
                  <input id={`subject-${draft.id}`} className="draft-subject" value={draft.subject} onChange={(event) => edit(draft.id, 'subject', event.target.value)} />
                  <label className="field-label" htmlFor={`body-${draft.id}`}>Message</label>
                  <textarea id={`body-${draft.id}`} className="draft-body" rows={8} value={draft.body} onChange={(event) => edit(draft.id, 'body', event.target.value)} />
                  {draft.signature_preview && (
                    <div className="signature-preview">
                      <span>Added automatically when sent</span>
                      <pre>{draft.signature_preview}</pre>
                    </div>
                  )}
                  {(draft.subject !== (draft.original_subject ?? draft.subject) || draft.body !== (draft.original_body ?? draft.body)) && (
                    <details className="draft-diff">
                      <summary>Review edits against original</summary>
                      <div><strong>Original</strong><pre>{draft.original_subject}\n\n{draft.original_body}</pre></div>
                      <div><strong>Current</strong><pre>{draft.subject}\n\n{draft.body}</pre></div>
                    </details>
                  )}
                  <div className="draft-actions">
                    <button className="approve-button" disabled={busyId === draft.id} onClick={() => void act(draft.id, 'approve', draft)}>
                      <Icon name="check" /> {busyId === draft.id ? 'Saving…' : 'Approve & queue'}
                    </button>
                    <button className="reject-button" disabled={busyId === draft.id} onClick={() => void rewrite(draft.id)}>{busyId === draft.id ? 'Working…' : 'Rewrite'}</button>
                    <button className="reject-button" disabled={busyId === draft.id} onClick={() => void act(draft.id, 'reject')}>Reject & suppress</button>
                    <button className="reject-button" disabled={!!rated[draft.id]} aria-label="Good draft" title="Good draft: teaches the agent" onClick={() => void rate(draft.id, 3)}>{rated[draft.id] === 'up' ? '👍 Thanks' : '👍'}</button>
                    <button className="reject-button" disabled={!!rated[draft.id]} aria-label="Poor draft" title="Poor draft: teaches the agent" onClick={() => void rate(draft.id, -3)}>{rated[draft.id] === 'down' ? '👎 Noted' : '👎'}</button>
                  </div>
                </article>
              ))}
            </div>

            <aside className="panel pipeline-panel">
              <div className="section-kicker">PIPELINE</div>
              <h2>Email activity</h2>
              <p className="panel-description">A snapshot of your current email workflow.</p>
              <div className="pipeline-list">
                <div className="pipeline-row">
                  <span className="pipeline-symbol lavender"><Icon name="mail" /></span>
                  <span className="pipeline-label"><strong>Needs review</strong><small>Drafts awaiting approval</small></span>
                  <b>{stats?.to_review ?? '—'}</b>
                </div>
                {!!held.length && (
                  <section className="held-list" aria-label="Undo window">
                    <h3>Undo window</h3>
                    <p>Approved emails are held before their local send window.</p>
                    {held.map((email) => (
                      <div className="held-item" key={email.id}>
                        <strong>{email.name}</strong>
                        <span>{email.email}</span>
                        <small>{email.hold_until ? `Undo available until ${new Date(email.hold_until).toLocaleTimeString()}` : 'Waiting to send'}</small>
                        <button className="reject-button" disabled={busyId === email.id} onClick={() => void act(email.id, 'undo')}>Undo approval</button>
                      </div>
                    ))}
                  </section>
                )}
                <div className="pipeline-row">
                  <span className="pipeline-symbol mint"><Icon name="clock" /></span>
                  <span className="pipeline-label"><strong>Queued</strong><small>Approved and scheduled</small></span>
                  <b>{stats?.queued ?? '—'}</b>
                </div>
                <div className="pipeline-row">
                  <span className="pipeline-symbol peach"><Icon name="send" /></span>
                  <span className="pipeline-label"><strong>Sent recently</strong><small>In the last 24 hours</small></span>
                  <b>{stats?.sent_24h ?? '—'}</b>
                </div>
                <div className="pipeline-row">
                  <span className="pipeline-symbol mint"><Icon name="grid" /></span>
                  <span className="pipeline-label"><strong>Website track</strong><small>Qualified businesses with websites</small></span>
                  <b>{stats?.site_leads ?? '—'}</b>
                </div>
                <div className="pipeline-row">
                  <span className="pipeline-symbol lavender"><Icon name="grid" /></span>
                  <span className="pipeline-label"><strong>No-website track</strong><small>Separate offer and research path</small></span>
                  <b>{stats?.no_site_leads ?? '—'}</b>
                </div>
                <div className="pipeline-row">
                  <span className="pipeline-symbol peach"><Icon name="clock" /></span>
                  <span className="pipeline-label"><strong>Manual call queue</strong><small>Phone listed; no eligible email found</small></span>
                  <b>{stats?.call_queue ?? '—'}</b>
                </div>
              </div>
              <div className="review-tip">
                <span className="tip-icon"><Icon name="spark" /></span>
                <div><strong>Keep it personal</strong><p>Review each draft for accuracy and make sure it sounds like you before queuing.</p></div>
              </div>
              <div className="pipeline-footnote"><span className="secure-dot" /> You’re in control of every send</div>
            </aside>
          </section>

          <footer className="dashboard-footer"><span>EmailAuto</span><span>Thoughtful outreach, one message at a time.</span></footer>
        </div>
      </main>
    </div>
  );
}
