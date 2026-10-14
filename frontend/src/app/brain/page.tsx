'use client';

import Script from 'next/script';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import './brain.css';

type Settings = { frozen: boolean; learningRate: number; explorationShare: number; attributionDays: number; autonomy: 'L0' | 'L1' };
type Overview = {
  settings: Settings;
  counts: { activeMemory: number; pendingProposals: number; labeledSends: number };
  gamma: { gamma: number; source: 'prior' | 'learned'; trainedOn: number };
  scorer: { active: { version: number; trainedOn: number; trainedAt: string } | null; lastAttempt: { at?: string; reason?: string; holdoutAuc?: number | null } | null; needed: number; labeled: number };
  policy: { minP: number; maxSequences: number; tauDays: number };
  autonomy: { level: string; eligible: boolean; reviewed: number; editRate: number | null; minReviewed: number; maxEditRate: number };
  lastStrategistRun: string | null;
  snapshot: { id: number; kind: string; createdAt: string; restoreUntil: string } | null;
  rewardPoints90d: { events: number; deals: number };
  curve: Array<{ week: string; labeled: number; replies: number; replyRate: number | null; reviewed: number; edited: number; editRate: number | null; avgEditDistance: number | null }>;
  feedback: Array<{ id: number; targetType: string; targetId: string; score: number; note: string | null; effect: number; createdBy: string; createdAt: string }>;
};
type ArmTable = { baseline: number; dimensions: Array<{ dimension: string; arms: Array<{ key: string; n: number; successes: number; failures: number; mean: number; lo: number; hi: number; probBest: number | null; insufficient: boolean }> }> };
type Memory = { id: number; kind: string; scope: Record<string, string>; text: string; source: string; confidence: number; evidenceCount: number; active: boolean; expiresAt: string | null };
type Proposal = { id: number; kind: string; summary: string; rationale: string; createdAt: string };
type ResetPreview = {
  willErase: { memory: number; instructionsAndGuardrails: number; arms: number; feedback: number; proposals: number; models: number; draftEdits: number };
  preserved: string[];
  snapshots: Array<{ id: number; kind: string; createdAt: string; restoreUntil: string; createdBy: string }>;
};
type Explain = {
  business: { id: number; name: string | null; niche: string | null; country: string | null; track: string; score: number | null; status: string | null };
  segment: { key: string; mean: number; lo: number; hi: number; n: number; baseline: number; override: number };
  multiplier: { source: string; scorerVersion: number | null };
  policy: { canEmail: boolean; reasons: string[]; sequenceNo: number; completedSequences: number; gamma: number; gammaSource: string; probability: number; minP: number; maxSequences: number; daysSinceLastSend: number | null };
  exploration: { share: number };
  lastSelection: { emailId: number; emailStatus: string | null; info: Record<string, unknown>; memory: Array<{ id: number; kind: string; text: string }> } | null;
};

const pct = (value: number | null | undefined, digits = 1) => (value === null || value === undefined ? '—' : `${(value * 100).toFixed(digits)}%`);
const when = (value: string | null) => (value ? new Date(value).toLocaleString() : 'never');
const errorText: Record<string, string> = {
  step_up_required: 'Verify the owner Google account first (button in the Danger zone).',
  tick_in_progress_try_again: 'A background tick is running. Try again in a minute.',
  memory_limit_reached: 'You have reached the limit of 200 active memory items.',
  invalid_memory: 'That memory item is not valid. Text cannot contain links or email addresses.',
  learning_frozen: 'Learning is frozen. Unfreeze it first.',
  no_restorable_snapshot: 'That snapshot is no longer available.',
};

async function request<T>(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  const response = await fetch(`/api/proxy/${path}`, init);
  if (response.status === 401) location.href = '/login';
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  return { ok: response.ok, status: response.status, data };
}
const send = (method: string, body?: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

export default function BrainPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [arms, setArms] = useState<ArmTable | null>(null);
  const [memory, setMemory] = useState<Memory[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [preview, setPreview] = useState<ResetPreview | null>(null);
  const [explain, setExplain] = useState<Explain | null>(null);
  const [leadId, setLeadId] = useState('');
  const [draftSettings, setDraftSettings] = useState<Settings | null>(null);
  const [kind, setKind] = useState<'instruction' | 'guardrail'>('instruction');
  const [text, setText] = useState('');
  const [niche, setNiche] = useState('');
  const [country, setCountry] = useState('');
  const [track, setTrack] = useState('');
  const [expires, setExpires] = useState('');
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [keepInstructions, setKeepInstructions] = useState(true);
  const [confirmText, setConfirmText] = useState('');
  const [verified, setVerified] = useState(false);
  const [notOwner, setNotOwner] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const fail = (code?: string, fallback = 'Something went wrong. Please try again.') => setError(code && errorText[code] ? errorText[code] : fallback);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const me = await request<{ role?: string }>('auth/me');
      if (!me.ok) { fail(undefined, 'Could not load your account.'); return; }
      if (me.data.role !== 'owner') { setNotOwner(true); return; }
      const [ov, ar, mem, prop, prev] = await Promise.all([
        request<Overview>('agent/overview'), request<ArmTable>('agent/arms'), request<Memory[]>('agent/memory'),
        request<Proposal[]>('agent/proposals'), request<ResetPreview>('agent/reset/preview'),
      ]);
      if (![ov, ar, mem, prop, prev].every((result) => result.ok)) throw new Error('Could not load the Brain. Check the backend and try again.');
      setOverview(ov.data); setDraftSettings(ov.data.settings); setArms(ar.data); setMemory(mem.data as unknown as Memory[]);
      setProposals(prop.data as unknown as Proposal[]); setPreview(prev.data);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load the Brain.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const act = async (work: () => Promise<{ ok: boolean; data: { error?: string } } | void>, success?: string) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await work();
      if (result && !result.ok) { fail(result.data.error); return false; }
      if (success) setNotice(success);
      await load();
      return true;
    } catch {
      setError('Network error. Please try again.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const initGoogle = () => {
    const google = (window as any).google?.accounts?.id;
    const button = document.getElementById('brain-reauth');
    if (!google || !button) return;
    google.initialize({
      client_id: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
      callback: async (result: { credential?: string }) => {
        if (!result.credential) { setError('Google could not verify the owner account.'); return; }
        const response = await request('auth/reauth', send('POST', { credential: result.credential }));
        if (!response.ok) { setError('Owner verification failed. Sign in with the configured owner Google account.'); return; }
        setVerified(true);
        setNotice('Owner verified. Protected actions are enabled for five minutes.');
      },
    });
    google.renderButton(button, { theme: 'filled_black', size: 'large', shape: 'rectangular', text: 'continue_with', width: 280 });
  };

  const saveSettings = (event: FormEvent) => {
    event.preventDefault();
    if (!draftSettings) return;
    const { learningRate, explorationShare, attributionDays, autonomy } = draftSettings;
    void act(() => request('agent/settings', send('PATCH', { learningRate, explorationShare, attributionDays, autonomy })), 'Learning settings saved.');
  };

  const addMemory = (event: FormEvent) => {
    event.preventDefault();
    const scope: Record<string, string> = {};
    if (niche.trim()) scope.niche = niche.trim();
    if (country.trim()) scope.country = country.trim();
    if (track) scope.track = track;
    void act(async () => {
      const result = await request('agent/memory', send('POST', { kind, text, scope, expiresAt: expires ? new Date(`${expires}T23:59:59`).toISOString() : null }));
      if (result.ok) { setText(''); setNiche(''); setCountry(''); setTrack(''); setExpires(''); }
      return result;
    }, kind === 'guardrail' ? 'Banned phrase added.' : 'Instruction added. It will be used for new drafts.');
  };

  const runExplain = async (event: FormEvent) => {
    event.preventDefault();
    setError(''); setExplain(null);
    const result = await request<Explain>(`agent/explain/${encodeURIComponent(leadId.trim())}`);
    if (!result.ok) { setError(result.status === 404 ? 'No lead with that ID.' : 'Enter a numeric lead ID.'); return; }
    setExplain(result.data);
  };

  const dangerous = !!(busy || !verified);
  const canReset = !dangerous && confirmText === 'RESET';

  return (
    <main className="admin-page">
      <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" onReady={initGoogle} onError={() => setError('Google verification could not load.')} />
      <header className="admin-header">
        <a className="brand" href="/"><span className="brand-mark">E</span><span>Email<span className="brand-light">Auto</span></span></a>
        <a className="admin-back" href="/">← Back to workspace</a>
      </header>
      <div className="admin-content">
        <div className="admin-heading">
          <div><div className="section-kicker">LEARNING AGENT</div><h1>Brain</h1><p>What the agent has learned, what it is allowed to change, and how to steer or reset it.</p></div>
          {overview && <span className={`stepup-state${overview.settings.frozen ? '' : ' active'}`}>{overview.settings.frozen ? 'LEARNING FROZEN' : 'LEARNING ACTIVE'}</span>}
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        {notice && <div className="admin-notice" role="status">{notice}</div>}
        {notOwner && <section className="admin-panel"><p className="admin-empty">Only the workspace owner can view or change the Brain.</p></section>}
        {loading && !overview && !notOwner && <section className="admin-panel"><p className="admin-empty">Loading what the agent has learned…</p></section>}

        {overview && arms && draftSettings && preview && (
          <>
            {overview.counts.labeledSends < 30 && <div className="analytics-caveat">Only {overview.counts.labeledSends} sends have a measured outcome so far. The agent leans on its priors and shows wide uncertainty until there is more data; rows with fewer than 30 sends are marked insufficient.</div>}
            <div className="brain-grid">
              <section className="brain-card"><span>Sends with a measured outcome</span><strong>{overview.counts.labeledSends}</strong><small>Real sends only; dry-run sends never teach the agent. Outcome window {overview.settings.attributionDays} days.</small></section>
              <section className="brain-card"><span>Overall reply rate (shrunk)</span><strong>{pct(arms.baseline)}</strong><small>Starts at a 4% prior and moves with evidence.</small></section>
              <section className="brain-card"><span>Re-contact penalty γ</span><strong>{overview.gamma.gamma.toFixed(2)}</strong><small>{overview.gamma.source === 'learned' ? `Learned from ${overview.gamma.trainedOn} re-contacts` : 'Prior value (no re-contact data yet)'} · min {pct(overview.policy.minP, 0)} reply chance, max {overview.policy.maxSequences} sequences</small></section>
              <section className="brain-card"><span>Lead scorer</span><strong>{overview.scorer.active ? `v${overview.scorer.active.version}` : 'Not trained'}</strong><small>{overview.scorer.active ? `Trained on ${overview.scorer.active.trainedOn} sends` : `${overview.scorer.labeled} of ${overview.scorer.needed} labeled sends needed`}{overview.scorer.lastAttempt?.reason && !overview.scorer.active ? ` · last attempt: ${overview.scorer.lastAttempt.reason}` : ''}</small></section>
              <section className="brain-card"><span>Reward points · 90 days</span><strong>{overview.rewardPoints90d.events + overview.rewardPoints90d.deals}</strong><small>Replies and penalties {overview.rewardPoints90d.events} · calls and wins {overview.rewardPoints90d.deals}</small></section>
              <section className="brain-card"><span>Draft quality</span><strong>{overview.autonomy.editRate === null ? '—' : pct(1 - overview.autonomy.editRate, 0)} unchanged</strong><small>Last {overview.autonomy.reviewed} reviewed agent drafts. {overview.autonomy.level === 'L1' ? (overview.autonomy.eligible ? 'Low-risk drafts are flagged in review.' : `Flags appear after ${overview.autonomy.minReviewed} reviews with at most ${pct(overview.autonomy.maxEditRate, 0)} edited.`) : 'Autonomy L0: every draft needs your review.'}</small></section>
            </div>

            <section className="admin-panel">
              <div className="admin-panel-heading">
                <div><div className="section-kicker">CONTROLS</div><h2>Learning settings</h2><p>The agent can never change compliance rules, suppression, daily caps, the spam guard or admin access. Every change is audit-logged.</p></div>
                <button className={overview.settings.frozen ? 'approve-button' : 'reject-button'} disabled={busy} onClick={() => void act(() => request(`agent/learning/${overview.settings.frozen ? 'unfreeze' : 'freeze'}`, send('POST')), overview.settings.frozen ? 'Learning resumed.' : 'Learning frozen. The agent keeps using what it knows but stops updating.')}>{overview.settings.frozen ? 'Resume learning' : 'Freeze learning'}</button>
              </div>
              <form className="brain-settings" onSubmit={saveSettings}>
                <label>Learning rate: {draftSettings.learningRate.toFixed(2)}×<input type="range" min={0.25} max={2} step={0.05} value={draftSettings.learningRate} onChange={(event) => setDraftSettings({ ...draftSettings, learningRate: Number(event.target.value) })} /></label>
                <label>Minimum exploration: {pct(draftSettings.explorationShare, 0)}<input type="range" min={0.15} max={0.5} step={0.05} value={draftSettings.explorationShare} onChange={(event) => setDraftSettings({ ...draftSettings, explorationShare: Number(event.target.value) })} /></label>
                <label>Outcome window: {draftSettings.attributionDays} days<input type="range" min={7} max={30} step={1} value={draftSettings.attributionDays} onChange={(event) => setDraftSettings({ ...draftSettings, attributionDays: Number(event.target.value) })} /></label>
                <label>Autonomy<select value={draftSettings.autonomy} onChange={(event) => setDraftSettings({ ...draftSettings, autonomy: event.target.value as 'L0' | 'L1' })}><option value="L0">L0 · you review every draft</option><option value="L1">L1 · flag low-risk drafts (you still approve)</option></select></label>
                <div><button className="approve-button" type="submit" disabled={busy}>Save settings</button></div>
              </form>
            </section>

            <section className="admin-panel">
              <div className="admin-panel-heading">
                <div><div className="section-kicker">PROPOSALS</div><h2>Waiting for your decision</h2><p>Last strategist run: {when(overview.lastStrategistRun)}. Nothing here changes behavior until you accept it.</p></div>
                <button className="reject-button" disabled={busy || overview.settings.frozen} onClick={() => void act(async () => { const result = await request<{ created: number }>('agent/proposals/run', send('POST')); if (result.ok) setNotice(result.data.created ? `${result.data.created} new proposal(s).` : 'No new proposals right now.'); return result; })}>Run strategist now</button>
              </div>
              {!proposals.length ? <p className="admin-empty">No pending proposals.</p> : proposals.map((proposal) => (
                <div className="brain-row" key={proposal.id}>
                  <div className="brain-main"><strong>{proposal.summary}</strong><small>{proposal.rationale}</small><small><span className="brain-tag">{proposal.kind.replace('_', ' ')}</span>{when(proposal.createdAt)}</small></div>
                  <div className="brain-actions">
                    <button className="approve-button" disabled={busy} onClick={() => void act(() => request(`agent/proposals/${proposal.id}/accept`, send('POST')), 'Proposal accepted.')}>Accept</button>
                    <button className="reject-button" disabled={busy} onClick={() => void act(() => request(`agent/proposals/${proposal.id}/reject`, send('POST')), 'Proposal rejected. It will not be proposed again for 30 days.')}>Reject</button>
                  </div>
                </div>
              ))}
            </section>

            <section className="admin-panel">
              <div className="admin-panel-heading"><div><div className="section-kicker">MEMORY</div><h2>Instructions and banned phrases</h2><p>Instruction text is sent to your LLM provider with each draft request, so keep it to style rules and never include private details. Links and email addresses are not allowed.</p></div></div>
              <form className="brain-form" onSubmit={addMemory}>
                <label>Type<select value={kind} onChange={(event) => setKind(event.target.value as 'instruction' | 'guardrail')}><option value="instruction">Instruction</option><option value="guardrail">Banned phrase</option></select></label>
                <label className="wide">{kind === 'guardrail' ? 'Phrase drafts must never contain' : 'Instruction'}<input value={text} onChange={(event) => setText(event.target.value)} required minLength={kind === 'guardrail' ? 2 : 5} maxLength={kind === 'guardrail' ? 60 : 300} placeholder={kind === 'guardrail' ? 'game-changer' : 'For restaurants, don’t mention SEO'} /></label>
                <label>Niche (optional)<input value={niche} onChange={(event) => setNiche(event.target.value)} maxLength={60} placeholder="restaurant" /></label>
                <label>Country (optional)<input value={country} onChange={(event) => setCountry(event.target.value.toUpperCase())} maxLength={2} placeholder="CA" /></label>
                <label>Track (optional)<select value={track} onChange={(event) => setTrack(event.target.value)}><option value="">Any</option><option value="site">Has website</option><option value="no_site">No website</option></select></label>
                <label>Expires (optional)<input type="date" value={expires} onChange={(event) => setExpires(event.target.value)} /></label>
                <div><button className="approve-button" type="submit" disabled={busy || !text.trim()}>Add</button></div>
              </form>
              {!memory.length ? <p className="admin-empty">No memory yet. Accepted proposals and your instructions appear here.</p> : memory.map((item) => (
                <div className="brain-row" key={item.id}>
                  <div className="brain-main">
                    {editing?.id === item.id
                      ? <input className="brain-input" value={editing.text} maxLength={300} onChange={(event) => setEditing({ id: item.id, text: event.target.value })} />
                      : <strong style={{ opacity: item.active ? 1 : 0.5 }}>{item.text}</strong>}
                    <small>
                      <span className={`brain-tag${item.kind === 'guardrail' ? ' bad' : item.kind === 'lesson' ? ' warn' : ' good'}`}>{item.kind === 'guardrail' ? 'banned phrase' : item.kind}</span>
                      {Object.entries(item.scope ?? {}).map(([key, value]) => <span className="brain-tag" key={key}>{key}: {value}</span>)}
                      {item.source} · confidence {pct(item.confidence, 0)}{item.evidenceCount ? ` · ${item.evidenceCount} supporting edits` : ''}{item.expiresAt ? ` · expires ${new Date(item.expiresAt).toLocaleDateString()}` : ''}{item.active ? '' : ' · off'}
                    </small>
                  </div>
                  <div className="brain-actions">
                    {editing?.id === item.id ? (
                      <>
                        <button className="approve-button" disabled={busy} onClick={() => void act(async () => { const result = await request(`agent/memory/${item.id}`, send('PATCH', { text: editing.text })); if (result.ok) setEditing(null); return result; }, 'Saved.')}>Save</button>
                        <button className="reject-button" onClick={() => setEditing(null)}>Cancel</button>
                      </>
                    ) : (
                      <>
                        <button className="reject-button" disabled={busy} onClick={() => void act(() => request(`agent/memory/${item.id}`, send('PATCH', { active: !item.active })))}>{item.active ? 'Turn off' : 'Turn on'}</button>
                        <button className="reject-button" disabled={busy} onClick={() => setEditing({ id: item.id, text: item.text })}>Edit</button>
                        <button className="reject-button danger" disabled={busy} onClick={() => { if (confirm('Delete this memory item?')) void act(() => request(`agent/memory/${item.id}`, { method: 'DELETE' }), 'Deleted.'); }}>Delete</button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </section>

            <section className="admin-panel">
              <div className="admin-panel-heading"><div><div className="section-kicker">WHAT IT HAS LEARNED</div><h2>Reply-rate estimates</h2><p>The bar shows a 90% credible interval; the marker is the estimate. Small samples are pulled toward the overall rate of {pct(arms.baseline)}.</p></div></div>
              {!arms.dimensions.length ? <p className="admin-empty">No measured outcomes yet.</p> : arms.dimensions.filter((group) => group.dimension !== 'global').map((group) => {
                const scale = Math.max(0.05, ...group.arms.map((arm) => arm.hi));
                return (
                  <div key={group.dimension}>
                    <h3 className="brain-subhead">{group.dimension.replaceAll('_', ' ')}</h3>
                    <div className="brain-scroll"><table className="brain-table">
                      <thead><tr><th>Arm</th><th>Sends</th><th>Replies</th><th>Estimate</th><th>Range</th><th>Best?</th></tr></thead>
                      <tbody>{group.arms.map((arm) => (
                        <tr key={arm.key}>
                          <td>{arm.key.replace('|', ' · ')} {arm.insufficient && <span className="brain-tag warn">insufficient</span>}</td>
                          <td>{arm.n}</td><td>{arm.successes}</td><td>{pct(arm.mean)}</td>
                          <td><div className="brain-bar" title={`${pct(arm.lo)} to ${pct(arm.hi)}`}><span style={{ left: `${arm.lo / scale * 100}%`, width: `${Math.max(1, (arm.hi - arm.lo) / scale * 100)}%` }} /><i style={{ left: `${Math.min(99, arm.mean / scale * 100)}%` }} /></div></td>
                          <td>{arm.probBest === null ? '—' : pct(arm.probBest, 0)}</td>
                        </tr>))}</tbody>
                    </table></div>
                  </div>
                );
              })}
            </section>

            <section className="admin-panel">
              <div className="admin-panel-heading"><div><div className="section-kicker">LEARNING CURVE</div><h2>Weekly results and draft quality</h2><p>Reply rate of sends with a closed outcome window, plus how often you edit the agent’s drafts.</p></div></div>
              {!overview.curve.length ? <p className="admin-empty">Nothing to chart yet.</p> : <div className="brain-scroll"><table className="brain-table">
                <thead><tr><th>Week of</th><th>Measured</th><th>Replies</th><th>Reply rate</th><th>Drafts reviewed</th><th>Edited</th><th>Avg words changed</th></tr></thead>
                <tbody>{overview.curve.map((week) => (
                  <tr key={week.week}><td>{week.week}</td><td>{week.labeled}</td><td>{week.replies}</td><td>{pct(week.replyRate)}</td><td>{week.reviewed}</td><td>{week.edited}{week.editRate !== null ? ` (${pct(week.editRate, 0)})` : ''}</td><td>{week.avgEditDistance === null ? '—' : week.avgEditDistance.toFixed(0)}</td></tr>))}</tbody>
              </table></div>}
            </section>

            <section className="admin-panel">
              <div className="admin-panel-heading"><div><div className="section-kicker">EXPLAIN</div><h2>Why can or can’t we email this business?</h2><p>Shows the segment estimate, re-contact policy and how the last draft was chosen.</p></div></div>
              <form className="otp-input-row" style={{ marginTop: 14, maxWidth: 360 }} onSubmit={runExplain}><input inputMode="numeric" value={leadId} onChange={(event) => setLeadId(event.target.value)} placeholder="Lead ID" aria-label="Lead ID" required /><button type="submit">Explain</button></form>
              {explain && (
                <div className="brain-explain">
                  <div><strong>{explain.business.name ?? `Lead ${explain.business.id}`}</strong> · {explain.business.niche ?? 'unknown niche'} · {explain.business.country ?? '??'} · {explain.business.track === 'site' ? 'has website' : 'no website'} · status {explain.business.status ?? 'n/a'} · opportunity {explain.business.score ?? '—'}</div>
                  <div><span className={`brain-tag ${explain.policy.canEmail ? 'good' : 'bad'}`}>{explain.policy.canEmail ? 'can email' : 'cannot email now'}</span>Sequence #{explain.policy.sequenceNo} of at most {explain.policy.maxSequences} · estimated reply chance {pct(explain.policy.probability, 2)} (minimum {pct(explain.policy.minP, 1)}){explain.policy.daysSinceLastSend !== null ? ` · ${Math.round(explain.policy.daysSinceLastSend)} days since last send` : ''}</div>
                  {!!explain.policy.reasons.length && <ul>{explain.policy.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
                  <div>Segment <strong>{explain.segment.key.replace('|', ' · ')}</strong>: {pct(explain.segment.mean)} (90% range {pct(explain.segment.lo)}–{pct(explain.segment.hi)}, {explain.segment.n} sends, overall {pct(explain.segment.baseline)}){explain.segment.override !== 1 ? ` · your approved weighting ${explain.segment.override}×` : ''}. Lead weighting uses the {explain.multiplier.source}{explain.multiplier.scorerVersion ? ` v${explain.multiplier.scorerVersion}` : ''}. γ = {explain.policy.gamma.toFixed(2)} ({explain.policy.gammaSource}).</div>
                  {explain.lastSelection ? <div>Last draft #{explain.lastSelection.emailId} ({explain.lastSelection.emailStatus}) was chosen by <strong>{String(explain.lastSelection.info.mode ?? 'exploit')}</strong>{explain.lastSelection.info.angle ? `, angle “${String(explain.lastSelection.info.angle)}”` : ''}{explain.lastSelection.info.subjectStyle ? `, ${String(explain.lastSelection.info.subjectStyle)} subject` : ''}.{explain.lastSelection.memory.length ? ` Guidance used: ${explain.lastSelection.memory.map((item) => `“${item.text}”`).join('; ')}.` : ''}</div> : <div>No agent-selected draft exists for this business yet.</div>}
                </div>
              )}
            </section>

            <section className="admin-panel">
              <div className="admin-panel-heading"><div><div className="section-kicker">FEEDBACK</div><h2>Recent reward and penalty history</h2><p>Each rating counts as at most ±3 pseudo-observations, so one click cannot hijack the policy.</p></div></div>
              {!overview.feedback.length ? <p className="admin-empty">No feedback yet. Use 👍 / 👎 on a draft in the review queue.</p> : overview.feedback.map((item) => (
                <div className="brain-row" key={item.id}><div className="brain-main"><strong>{item.score > 0 ? '+' : ''}{item.score} on {item.targetType.replace('_', ' ')} {item.targetId}</strong><small>{item.note ?? 'No note'} · effect {item.effect > 0 ? '+' : ''}{item.effect.toFixed(1)} · {item.createdBy} · {when(item.createdAt)}</small></div></div>))}
            </section>
          </>
        )}

        <section className="admin-panel brain-danger" id="danger-zone" style={notOwner ? { display: 'none' } : undefined}>
          <div className="admin-panel-heading">
            <div><div className="section-kicker">DANGER ZONE</div><h2>Reset the agent’s brain</h2><p>Erases learned state only. Suppression, contact ledger, sent emails, replies, deals, admins, settings and enabled markets are never touched. A snapshot is kept for 7 days.</p></div>
            <span className={`stepup-state${verified ? ' active' : ''}`}>{verified ? 'OWNER VERIFIED' : 'VERIFICATION REQUIRED'}</span>
          </div>
          <div id="brain-reauth" style={{ marginTop: 14 }} />
          {preview && (
            <>
              <div className="funnel-list">
                <div className="funnel-row"><span>Reply-rate estimates (arms)</span><strong>{preview.willErase.arms}</strong></div>
                <div className="funnel-row"><span>Memory items ({preview.willErase.instructionsAndGuardrails} are your instructions / banned phrases)</span><strong>{preview.willErase.memory}</strong></div>
                <div className="funnel-row"><span>Feedback · proposals · models · draft edits</span><strong>{preview.willErase.feedback} · {preview.willErase.proposals} · {preview.willErase.models} · {preview.willErase.draftEdits}</strong></div>
              </div>
              <div className="brain-confirm">
                <label><input type="checkbox" checked={keepInstructions} onChange={(event) => setKeepInstructions(event.target.checked)} /> Keep my instructions and banned phrases</label>
                <input className="brain-input" type="text" value={confirmText} onChange={(event) => setConfirmText(event.target.value)} placeholder="Type RESET" aria-label="Type RESET to confirm" style={{ width: 140 }} />
                <button className="reject-button danger" disabled={!canReset} onClick={() => void act(async () => { const result = await request('agent/reset', send('POST', { confirm: 'RESET', keepInstructions })); if (result.ok) setConfirmText(''); return result; }, 'Agent brain reset. A 7-day snapshot was saved.')}>Reset agent brain</button>
              </div>
              {preview.snapshots.map((snapshot) => (
                <div className="brain-row" key={snapshot.id}>
                  <div className="brain-main"><strong>{snapshot.kind === 'reset' ? 'Snapshot before reset' : 'Snapshot before restore'} · {when(snapshot.createdAt)}</strong><small>By {snapshot.createdBy} · restorable until {when(snapshot.restoreUntil)}</small></div>
                  <button className="reject-button" disabled={dangerous} onClick={() => { if (confirm('Restore this snapshot? The current learned state is saved first.')) void act(() => request('agent/reset/restore', send('POST', { snapshotId: snapshot.id })), 'Snapshot restored.'); }}>Restore</button>
                </div>
              ))}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
