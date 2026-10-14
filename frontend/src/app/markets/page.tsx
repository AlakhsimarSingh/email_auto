'use client';

import { useCallback, useEffect, useState } from 'react';

type ComponentScores = {
  clientValue: number;
  leadSupply: number;
  emailYield: number;
  response: number;
  communicationFit: number;
  compliancePenalty: number;
};
type Market = {
  code: string;
  name: string;
  enabled: boolean;
  score: number;
  priorScore: number;
  evidenceWeight: number;
  sends: number;
  replies: number;
  responseEvidenceAvailable: boolean;
  leadsLast7Days: number;
  audited: number;
  emailFound: number;
  emailYield: number | null;
  components: ComponentScores;
  gdpPppPerCapita: number | null;
  gdpReferenceYear: number | null;
  gdpUpdatedAt: string | null;
};
type Account = { role: string; email: string };

const COMPONENTS: Array<[keyof ComponentScores, string]> = [
  ['clientValue', 'Client value'],
  ['leadSupply', 'Lead supply'],
  ['emailYield', 'Email yield'],
  ['response', 'Response evidence'],
  ['communicationFit', 'Communication fit'],
];

export default function MarketsPage() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [marketResponse, accountResponse] = await Promise.all([
        fetch('/api/proxy/markets', { cache: 'no-store' }),
        fetch('/api/proxy/auth/me', { cache: 'no-store' }),
      ]);
      if (marketResponse.status === 401 || accountResponse.status === 401) {
        location.href = '/login';
        return;
      }
      if (!marketResponse.ok || !accountResponse.ok) throw new Error('Could not load the market scorecard.');
      const [marketData, accountData] = await Promise.all([marketResponse.json(), accountResponse.json()]);
      setMarkets(marketData);
      setAccount(accountData);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load markets.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function updateMarket(market: Market) {
    setBusy(market.code);
    setNotice('');
    setError('');
    try {
      const response = await fetch(`/api/proxy/markets/${market.code}/enabled`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !market.enabled }),
      });
      if (response.status === 403) throw new Error('Owner verification is required. Verify your Google account on the Admin & security page, then retry.');
      if (!response.ok) throw new Error(`Could not ${market.enabled ? 'disable' : 'enable'} ${market.name}.`);
      setNotice(`${market.name} ${market.enabled ? 'disabled' : 'enabled'} for sourcing.`);
      await load();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Market update failed.');
    } finally {
      setBusy('');
    }
  }

  async function refreshGdp() {
    setBusy('world-bank');
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/proxy/markets/refresh-world-bank', { method: 'POST' });
      if (response.status === 403) throw new Error('Owner verification is required. Verify your Google account on the Admin & security page, then retry.');
      if (!response.ok) throw new Error('Could not refresh purchasing-power data from the World Bank.');
      const result = await response.json();
      setNotice(result.cached ? 'World Bank data is already current.' : `Updated ${result.updated} market records from World Bank data.`);
      await load();
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'World Bank refresh failed.');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="dashboard-shell">
      <aside className="sidebar">
        <a className="brand" href="/"><span className="brand-mark">E</span><span>Email<span className="brand-light">Auto</span></span></a>
        <div className="nav-label">WORKSPACE</div>
        <nav className="side-nav" aria-label="Main navigation">
          <a className="nav-item" href="/">Overview</a>
          <a className="nav-item" href="/leads">Leads</a>
          <a className="nav-item active" href="/markets">Markets</a>
          <a className="nav-item" href="/admin">Admin & security</a>
        </nav>
        <div className="sidebar-bottom"><div className="sidebar-status">Market allowlist</div><p>Lead discovery and sending are restricted to enabled countries.</p></div>
      </aside>
      <main className="main-content">
        <header className="topbar"><div className="breadcrumb"><a href="/">Workspace</a><span className="crumb-divider">/</span><strong>Markets</strong></div><span className="account-email">{account?.email}</span></header>
        <div className="dashboard-content">
          <section className="welcome-row">
            <div><div className="eyebrow">COUNTRY SCORECARD</div><h1>Choose where to focus</h1><p className="page-subtitle">Prior scores blend with your sourcing and send evidence; the system never enables a market automatically.</p></div>
            <button className="refresh-button" onClick={() => void refreshGdp()} disabled={busy !== '' || account?.role !== 'owner'}>Refresh World Bank data</button>
          </section>
          {error && <div className="error-banner" role="alert">{error}</div>}
          {notice && <div className="success-banner" role="status">{notice}</div>}
          {account?.role === 'owner' && <p className="panel-description market-stepup-note">Enabling, disabling, or refreshing market data requires recent owner verification. <a href="/admin">Verify on Admin &amp; security</a>.</p>}
          <section className="market-grid">
            {loading ? <div className="panel empty-state"><span className="loading-spinner" /> Loading scorecards…</div> : markets.map((market) => (
              <article className="panel market-card" key={market.code}>
                <div className="market-card-heading">
                  <div><span className="market-country-code">{market.code}</span><h2>{market.name}</h2></div>
                  <span className={`market-state ${market.enabled ? 'enabled' : ''}`}>{market.enabled ? 'Enabled' : 'Watchlist'}</span>
                </div>
                <div className="market-score"><strong>{market.score}</strong><span>/ 100 score</span><small>{market.sends ? `n = ${market.sends} sends` : 'low evidence · n = 0'}</small></div>
                <div className="score-components">
                  {COMPONENTS.map(([key, label]) => (
                    <div className="score-component" key={key}>
                      <div><span>{label}</span><strong>{market.components[key]}/100</strong></div>
                      <span className="score-track"><i style={{ width: `${market.components[key]}%` }} /></span>
                    </div>
                  ))}
                </div>
                <div className="market-yield">
                  <div><span>Leads sourced / 7d</span><strong>{market.leadsLast7Days}</strong></div>
                  <div><span>Email-found rate</span><strong>{market.emailYield === null ? '—' : `${market.emailYield}%`}</strong></div>
                  <div><span>Response evidence</span><strong>{market.responseEvidenceAvailable ? `${market.replies}/${market.sends}` : 'Not tracked yet'}</strong></div>
                </div>
                <div className="market-data-note">
                  <span>Prior {market.priorScore}/100 · evidence weight {Math.round(market.evidenceWeight * 100)}%</span>
                  <span>{market.gdpPppPerCapita ? `GDP PPP/person $${Math.round(market.gdpPppPerCapita).toLocaleString()}${market.gdpReferenceYear ? ` · ${market.gdpReferenceYear} data` : ''}` : 'Purchasing-power prior; World Bank value not loaded'}</span>
                  <span>Compliance friction −{market.components.compliancePenalty}</span>
                </div>
                {account?.role === 'owner' && (
                  <button className={`market-toggle ${market.enabled ? 'disable' : ''}`} disabled={busy !== ''} onClick={() => void updateMarket(market)}>
                    {busy === market.code ? 'Saving…' : market.enabled ? 'Disable market' : 'Enable market'}
                  </button>
                )}
              </article>
            ))}
          </section>
          <div className="market-disclaimer">Market score is a prioritization aid, not legal advice. Confirm local outreach rules before enabling a country. Response-rate estimates remain prior-only until reply tracking is connected.</div>
          <footer className="dashboard-footer"><span>EmailAuto</span><span>Markets are only enabled by an owner.</span></footer>
        </div>
      </main>
    </div>
  );
}
