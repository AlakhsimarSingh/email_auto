'use client';

import { useCallback, useEffect, useState } from 'react';

type Reply = {
  id: number;
  classification: string;
  snippet: string | null;
  received_at: string;
  handled_at: string | null;
  business_name: string | null;
  contact_email: string | null;
  subject: string | null;
  sla_overdue: boolean;
};

export default function InboxPage() {
  const [replies, setReplies] = useState<Reply[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`/api/proxy/replies?status=${showAll ? 'all' : 'open'}`);
      if (response.status === 401) {
        location.href = '/login';
        return;
      }
      if (!response.ok) throw new Error('Could not load the reply inbox.');
      setReplies(await response.json());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load the reply inbox.');
    } finally {
      setLoading(false);
    }
  }, [showAll]);

  useEffect(() => { void load(); }, [load]);

  const resolve = async (id: number) => {
    setBusyId(id);
    setError('');
    try {
      const response = await fetch(`/api/proxy/replies/${id}/resolve`, { method: 'POST' });
      if (!response.ok) throw new Error(response.status === 409
        ? 'This reply was already handled.'
        : 'Could not mark this reply handled.');
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Could not update the reply.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <main className="admin-page">
      <div className="admin-content">
        <div className="admin-heading">
          <div>
            <div className="section-kicker">REPLY MANAGEMENT</div>
            <h1>Reply inbox</h1>
            <p>Review Gmail replies and keep follow-ups paused until each human response is handled.</p>
          </div>
          <button className="approve-button" onClick={() => setShowAll((current) => !current)}>
            {showAll ? 'Show open replies' : 'Show handled too'}
          </button>
        </div>
        <p className="reply-sla-note">Human replies are flagged after four hours without an owner acknowledgement.</p>
        {error && <div className="error-banner" role="alert">{error}</div>}
        {loading && <section className="admin-panel"><p>Loading replies…</p></section>}
        {!loading && !replies.length && (
          <section className="admin-panel">
            <h2>Inbox clear</h2>
            <p>No {showAll ? '' : 'open '}replies were found in the latest Gmail sync.</p>
          </section>
        )}
        {!loading && replies.map((item) => (
          <article className="admin-panel reply-card" key={item.id}>
            <div className="admin-panel-heading">
              <div>
                <div className="section-kicker">{item.classification.replaceAll('_', ' ')}</div>
                <h2>{item.business_name || item.contact_email || 'Unmatched Gmail reply'}</h2>
                <p>{item.contact_email || 'No matching outreach contact'} · {new Date(item.received_at).toLocaleString()}</p>
              </div>
              {item.sla_overdue
                ? <span className="stepup-state">SLA OVERDUE</span>
                : item.handled_at
                  ? <span className="stepup-state active">HANDLED</span>
                  : <span className="stepup-state active">OPEN</span>}
            </div>
            {item.subject && <p className="reply-subject"><strong>Subject:</strong> {item.subject}</p>}
            {item.snippet && <blockquote className="reply-snippet">{item.snippet}</blockquote>}
            {!item.handled_at && (
              <button className="approve-button" disabled={busyId === item.id} onClick={() => void resolve(item.id)}>
                {busyId === item.id ? 'Saving…' : 'Mark handled'}
              </button>
            )}
          </article>
        ))}
      </div>
    </main>
  );
}
