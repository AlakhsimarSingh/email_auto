'use client';

import { useCallback, useEffect, useState } from 'react';

type Deal = {
  businessId: number;
  stage: string;
  valueCents: number;
  currency: string;
  notes: string | null;
  business: {
    id: number;
    name: string | null;
    city: string | null;
    country: string | null;
    niche: string | null;
    emails: Array<{ subject: string | null; sentAt: string | null }>;
  };
};

const stages = ['replied', 'conversation', 'call', 'proposal', 'won', 'lost'];

function DealCard({ deal, onSaved }: { deal: Deal; onSaved: () => void }) {
  const [stage, setStage] = useState(deal.stage);
  const [amount, setAmount] = useState((deal.valueCents / 100).toFixed(2));
  const [currency, setCurrency] = useState(deal.currency);
  const [notes, setNotes] = useState(deal.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount < 0 || parsedAmount > 20_000_000) {
      setError('Enter a valid, non-negative deal value.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/proxy/deals/${deal.businessId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          stage,
          valueCents: Math.round(parsedAmount * 100),
          currency: currency.toUpperCase(),
          notes,
        }),
      });
      if (!response.ok) throw new Error('Could not save this deal.');
      onSaved();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save this deal.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="deal-card">
      <div className="deal-card-heading">
        <div>
          <a href={`/leads/${deal.business.id}`}><strong>{deal.business.name || 'Unnamed business'}</strong></a>
          <span>{[deal.business.niche, deal.business.city, deal.business.country].filter(Boolean).join(' · ')}</span>
        </div>
        <span className={`deal-stage-badge stage-${stage}`}>{stage}</span>
      </div>
      {deal.business.emails[0]?.subject && <p className="deal-subject">{deal.business.emails[0].subject}</p>}
      <label className="field-label" htmlFor={`deal-stage-${deal.businessId}`}>Stage</label>
      <select id={`deal-stage-${deal.businessId}`} value={stage} onChange={(event) => setStage(event.target.value)}>
        {stages.map((option) => <option key={option} value={option}>{option[0]?.toUpperCase()}{option.slice(1)}</option>)}
      </select>
      <div className="deal-value-row">
        <label className="field-label" htmlFor={`deal-value-${deal.businessId}`}>Deal value</label>
        <input id={`deal-value-${deal.businessId}`} type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} />
        <input aria-label="Three-letter currency code" maxLength={3} value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} />
      </div>
      <label className="field-label" htmlFor={`deal-notes-${deal.businessId}`}>Notes</label>
      <textarea id={`deal-notes-${deal.businessId}`} rows={2} maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} />
      {error && <p className="deal-error" role="alert">{error}</p>}
      <button className="approve-button" onClick={() => void save()} disabled={busy}>
        {busy ? 'Saving…' : 'Save deal'}
      </button>
    </article>
  );
}

export default function PipelinePage() {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/proxy/deals');
      if (response.status === 401) {
        location.href = '/login';
        return;
      }
      if (!response.ok) throw new Error('Could not load pipeline deals.');
      setDeals(await response.json());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load pipeline deals.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <main className="admin-page">
      <div className="admin-content">
        <div className="admin-heading">
          <div><div className="section-kicker">SALES PIPELINE</div><h1>Deals</h1><p>Every human reply starts in Replied. Track the next step and record a value when known.</p></div>
          <a className="admin-back" href="/analytics">Analytics →</a>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        {loading && <section className="admin-panel"><p>Loading deals…</p></section>}
        {!loading && !deals.length && <section className="admin-panel"><h2>No replied leads yet</h2><p>Human Gmail replies create pipeline cards automatically.</p></section>}
        {!loading && !!deals.length && (
          <div className="pipeline-board">
            {stages.map((stage) => {
              const items = deals.filter((deal) => deal.stage === stage);
              return (
                <section className="pipeline-column" key={stage}>
                  <div className="pipeline-column-heading"><h2>{stage}</h2><span>{items.length}</span></div>
                  {items.map((deal) => <DealCard key={deal.businessId} deal={deal} onSaved={() => void load()} />)}
                  {!items.length && <p className="pipeline-column-empty">No deals in this stage.</p>}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
