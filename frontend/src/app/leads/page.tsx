'use client';

import { useEffect, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';

type Lead = {
  id: number;
  name: string | null;
  niche: string | null;
  city: string | null;
  country: string | null;
  track: 'site' | 'no_site';
  status: string | null;
  websiteUrl: string | null;
  phone: string | null;
  timezone: string | null;
  score: number | null;
  socialOnly: boolean;
  findings: string[] | null;
  email: string | null;
};
type MarketOption = { code: string; name: string; enabled: boolean };

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (quoted && character === '"' && text[index + 1] === '"') {
      cell += '"';
      index++;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      row.push(cell.trim());
      cell = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index++;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += character;
    }
  }
  if (quoted) throw new Error('CSV has an unclosed quoted field.');
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

export default function LeadsPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [markets, setMarkets] = useState<MarketOption[]>([]);
  const [track, setTrack] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load(selectedTrack = track) {
    setLoading(true);
    setError('');
    try {
      const query = selectedTrack ? `?track=${selectedTrack}` : '';
      const [response, marketResponse] = await Promise.all([
        fetch(`/api/proxy/leads${query}`, { cache: 'no-store' }),
        fetch('/api/proxy/markets', { cache: 'no-store' }),
      ]);
      if (response.status === 401 || marketResponse.status === 401) {
        location.href = '/login';
        return;
      }
      if (!response.ok || !marketResponse.ok) throw new Error('Could not load leads. Check the backend and try again.');
      setLeads(await response.json());
      setMarkets((await marketResponse.json()).filter((market: MarketOption) => market.enabled));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load leads.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  function filter(nextTrack: string) {
    setTrack(nextTrack);
    void load(nextTrack);
  }

  async function addLead(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setSaving(true);
    setError('');
    try {
      const form = new FormData(formElement);
      const values: Record<string, string> = {};
      form.forEach((value, key) => { values[key] = String(value); });
      const response = await fetch('/api/proxy/leads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error === 'market_not_enabled' ? 'Choose an enabled market.' : 'Could not add this lead. Check the business details and contact source.');
      }
      formElement.reset();
      setNotice('Lead added to the research queue.');
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not add this lead.');
    } finally {
      setSaving(false);
    }
  }

  async function importCsv(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setImporting(true);
    setError('');
    setNotice('');
    try {
      if (file.size > 1_000_000) throw new Error('CSV files are limited to 1 MB.');
      const rows = parseCsv(await file.text());
      if (rows.length < 2) throw new Error('CSV must include a header row and at least one lead.');
      const headers = rows[0]!.map((header) => header.toLowerCase().replaceAll('_', ''));
      const required = ['name', 'city', 'country', 'track'];
      if (required.some((header) => !headers.includes(header))) {
        throw new Error('CSV needs name, city, country, and track columns.');
      }
      if (rows.length > 51) throw new Error('Import is limited to 50 leads at a time.');
      const failures: string[] = [];
      let imported = 0;
      for (const [index, values] of rows.slice(1).entries()) {
        const lead = Object.fromEntries(headers.map((header, column) => [header, values[column] ?? '']));
        const response = await fetch('/api/proxy/leads', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: lead.name,
            city: lead.city,
            country: lead.country,
            track: lead.track,
            niche: lead.niche,
            websiteUrl: lead.websiteurl,
            phone: lead.phone,
            email: lead.email,
            sourceUrl: lead.sourceurl,
          }),
        });
        if (response.status === 401) {
          location.href = '/login';
          return;
        }
        if (response.ok) imported++;
        else {
          const result = await response.json().catch(() => ({}));
          failures.push(`row ${index + 2}: ${result.error || response.status}`);
        }
      }
      setNotice(`Imported ${imported} of ${rows.length - 1} leads${failures.length ? `; failed ${failures.join(', ')}` : '.'}`);
      await load();
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'CSV import failed.');
    } finally {
      setImporting(false);
      input.value = '';
    }
  }

  return (
    <div className="dashboard-shell">
      <main className="main-content">
        <div className="dashboard-content">
          <section className="welcome-row">
            <div><div className="eyebrow">LEAD RESEARCH</div><h1>Prospect pipeline</h1><p className="page-subtitle">Verified signals, contact sources, and no-website call queue.</p></div>
            <button className="refresh-button" onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh leads'}</button>
          </section>
          {error && <div className="error-banner" role="alert">{error}</div>}
          {notice && <div className="success-banner" role="status">{notice}</div>}
          <details className="panel add-lead-panel">
            <summary>Add a lead manually</summary>
            <p className="panel-description">Enter a business and only a published email with its source URL. No email addresses are guessed.</p>
            <form className="manual-lead-form" onSubmit={(event) => void addLead(event)}>
              <label>Business name<input name="name" required maxLength={180} /></label>
              <label>City<input name="city" required maxLength={120} /></label>
              <label>Niche<input name="niche" maxLength={120} /></label>
              <label>Enabled market<select name="country" required>{markets.map((market) => <option key={market.code} value={market.code}>{market.name}</option>)}</select></label>
              <label>Track<select name="track" required><option value="site">Website</option><option value="no_site">No website linked</option></select></label>
              <label>Website URL<input name="websiteUrl" type="url" placeholder="https://" /></label>
              <label>Phone<input name="phone" type="tel" maxLength={50} /></label>
              <label>Published email<input name="email" type="email" /></label>
              <label className="manual-source-field">Email source URL<input name="sourceUrl" type="url" placeholder="Required if an email is entered" /></label>
              <button className="approve-button" disabled={saving || !markets.length}>{saving ? 'Adding…' : 'Add to research queue'}</button>
            </form>
            <div className="csv-import">
              <label htmlFor="lead-csv">Or import CSV (up to 50 rows)</label>
              <input id="lead-csv" type="file" accept=".csv,text/csv" disabled={importing} onChange={(event) => void importCsv(event)} />
              <small>Headers: name, city, country, track; optional: niche, websiteUrl, phone, email, sourceUrl. An email always needs a published source URL.</small>
            </div>
          </details>
          <section className="panel">
            <div className="panel-heading">
              <div><div className="section-kicker">QUALIFIED PROSPECTS</div><h2>Lead list</h2><p>Showing up to 50 most recently discovered businesses.</p></div>
              <div className="filter-group" aria-label="Filter leads">
                {[
                  ['', 'All'],
                  ['site', 'Has website'],
                  ['no_site', 'No website linked'],
                ].map(([value, label]) => (
                  <button key={value} className={`filter-button${track === value ? ' selected' : ''}`} onClick={() => filter(value)}>{label}</button>
                ))}
              </div>
            </div>
            {loading ? <div className="empty-state"><span className="loading-spinner" /> Loading leads…</div> : !leads.length
              ? <div className="empty-state"><h3>No leads in this view</h3><p>New eligible businesses will appear after a sourcing tick. Only enabled markets are searched.</p></div>
              : (
                <div className="table-scroll">
                  <table className="data-table">
                    <thead><tr><th>Business</th><th>Track</th><th>Contact</th><th>Score</th><th>Status</th><th /></tr></thead>
                    <tbody>
                      {leads.map((lead) => (
                        <tr key={lead.id}>
                          <td><a className="lead-link" href={`/leads/${lead.id}`}>{lead.name || 'Unnamed business'}</a><small>{[lead.city, lead.country].filter(Boolean).join(', ')}{lead.niche ? ` · ${lead.niche}` : ''}</small></td>
                          <td><span className={`track-badge ${lead.track}`}>{lead.track === 'site' ? 'Website' : 'No site'}</span>{lead.socialOnly && <small>Social-only listing</small>}</td>
                          <td>{lead.email ? <a href={`mailto:${lead.email}`}>{lead.email}</a> : lead.phone ? <a href={`tel:${lead.phone}`}>{lead.phone}</a> : <span className="muted-text">Not found</span>}</td>
                          <td><strong>{lead.score ?? '—'}</strong><small>/ 100 opportunity</small></td>
                          <td><span className="status-badge">{(lead.status || 'unknown').replaceAll('_', ' ')}</span></td>
                          <td><a className="table-arrow" href={`/leads/${lead.id}`} aria-label={`Open ${lead.name || 'lead'}`}>↗</a></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </section>
          <footer className="dashboard-footer"><span>EmailAuto</span><span>Research respectfully. Contact only with verified sources.</span></footer>
        </div>
      </main>
    </div>
  );
}
