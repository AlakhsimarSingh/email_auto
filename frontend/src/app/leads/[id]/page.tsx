'use client';

import { use, useEffect, useState } from 'react';

type Signal = { key: string; evidence: string; sourceUrl?: string };
type Lead = {
  id: number;
  name: string | null;
  niche: string | null;
  city: string | null;
  country: string | null;
  track: string;
  status: string | null;
  websiteUrl: string | null;
  phone: string | null;
  timezone: string | null;
  latitude: number | null;
  longitude: number | null;
  score: number | null;
  scoreSignals: Signal[];
  findings: string[];
  callScript: string | null;
  openingHours: string | null;
  osmUrl: string | null;
  mapUrl: string | null;
  contacts: Array<{ id: number; email: string | null; sourceUrl: string | null }>;
  emails: Array<{ id: number; status: string | null; subject: string | null; createdAt: string | null }>;
};

function LeadDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [lead, setLead] = useState<Lead | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    fetch(`/api/proxy/leads/${encodeURIComponent(id)}`, { cache: 'no-store' })
      .then(async (response) => {
        if (response.status === 401) {
          location.href = '/login';
          return null;
        }
        if (!response.ok) throw new Error(response.status === 404 ? 'This lead no longer exists.' : 'Could not load this lead.');
        return response.json() as Promise<Lead>;
      })
      .then((data) => { if (active && data) setLead(data); })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Could not load this lead.');
      });
    return () => { active = false; };
  }, [id]);

  return (
    <div className="dashboard-shell">
      <aside className="sidebar">
        <a className="brand" href="/"><span className="brand-mark">E</span><span>Email<span className="brand-light">Auto</span></span></a>
        <div className="nav-label">WORKSPACE</div>
        <nav className="side-nav" aria-label="Main navigation">
          <a className="nav-item" href="/">Overview</a>
          <a className="nav-item active" href="/leads">Leads</a>
          <a className="nav-item" href="/markets">Markets</a>
          <a className="nav-item" href="/admin">Admin & security</a>
        </nav>
      </aside>
      <main className="main-content">
        <header className="topbar"><div className="breadcrumb"><a href="/leads">Leads</a><span className="crumb-divider">/</span><strong>Lead details</strong></div></header>
        <div className="dashboard-content">
          {error && <div className="error-banner" role="alert">{error}</div>}
          {!lead && !error && <div className="panel empty-state"><span className="loading-spinner" /> Loading lead details…</div>}
          {lead && (
            <>
              <section className="welcome-row">
                <div><div className="eyebrow">{lead.track === 'no_site' ? 'NO-WEBSITE TRACK' : 'WEBSITE TRACK'}</div><h1>{lead.name || 'Unnamed business'}</h1><p className="page-subtitle">{[lead.niche, lead.city, lead.country].filter(Boolean).join(' · ')}</p></div>
                <a className="refresh-button" href="/leads">← Back to leads</a>
              </section>
              {lead.track === 'no_site' && lead.callScript && <div className="call-script"><strong>Manual call script</strong><p>{lead.callScript}</p><span>No automated calling or messaging is performed.</span></div>}
              <div className="lead-detail-grid">
                <section className="panel">
                  <div className="section-kicker">VERIFIED OPPORTUNITY SIGNALS</div>
                  <h2>Why this lead surfaced</h2>
                  <p className="panel-description">Only evidence-backed signals are used in generated drafts.</p>
                  <div className="evidence-list">
                    {lead.scoreSignals?.length ? lead.scoreSignals.map((signal, index) => (
                      <article className="evidence-item" key={`${signal.key}-${index}`}>
                        <div><strong>{signal.key.replaceAll('_', ' ')}</strong><p>{signal.evidence}</p></div>
                        {signal.sourceUrl && <a href={signal.sourceUrl} target="_blank" rel="noreferrer">Evidence ↗</a>}
                      </article>
                    )) : <p className="muted-text">No audit evidence is available yet.</p>}
                  </div>
                </section>
                <aside className="panel lead-facts">
                  <div className="section-kicker">LEAD PROFILE</div>
                  <div className="score-ring"><strong>{lead.score ?? '—'}</strong><span>opportunity / 100</span></div>
                  <dl>
                    <dt>Track</dt><dd>{lead.track === 'no_site' ? 'No website linked' : 'Website audit'}</dd>
                    <dt>Status</dt><dd>{(lead.status || 'unknown').replaceAll('_', ' ')}</dd>
                    <dt>Phone</dt><dd>{lead.phone ? <a href={`tel:${lead.phone}`}>{lead.phone}</a> : 'Not listed'}</dd>
                    <dt>Timezone</dt><dd>{lead.timezone || 'Unknown'}</dd>
                    <dt>Opening hours</dt><dd>{lead.openingHours || 'Not listed'}</dd>
                    <dt>Website</dt><dd>{lead.websiteUrl ? <a href={lead.websiteUrl} target="_blank" rel="noreferrer">{lead.websiteUrl}</a> : 'No business website linked'}</dd>
                  </dl>
                  <div className="lead-external-links">
                    {lead.mapUrl && <a href={lead.mapUrl} target="_blank" rel="noreferrer">Open map ↗</a>}
                    {lead.osmUrl && <a href={lead.osmUrl} target="_blank" rel="noreferrer">OpenStreetMap ↗</a>}
                  </div>
                </aside>
              </div>
              <section className="panel lead-contacts">
                <div className="panel-heading"><div><div className="section-kicker">PUBLIC CONTACT SOURCES</div><h2>Contact details</h2></div></div>
                {lead.contacts.length ? lead.contacts.map((contact) => (
                  <div className="contact-source" key={contact.id}>
                    <strong>{contact.email ? <a href={`mailto:${contact.email}`}>{contact.email}</a> : 'No email address'}</strong>
                    <span>{contact.sourceUrl ? <a href={contact.sourceUrl} target="_blank" rel="noreferrer">{contact.sourceUrl}</a> : 'Source not recorded'}</span>
                  </div>
                )) : <p className="muted-text">No published email found. If a phone is available, this lead is in the manual call queue.</p>}
              </section>
              {!!lead.emails.length && <section className="panel lead-contacts">
                <div className="section-kicker">OUTREACH HISTORY</div><h2>Drafts and messages</h2>
                {lead.emails.map((email) => <div className="contact-source" key={email.id}><strong>{email.subject || 'Untitled message'}</strong><span>{email.status} · {email.createdAt ? new Date(email.createdAt).toLocaleString() : ''}</span></div>)}
              </section>}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

export default function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  return <LeadDetail params={params} />;
}
