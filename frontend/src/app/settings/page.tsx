'use client';

import Script from 'next/script';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';

type Admin = { id: number; email: string; role: string; activeSessions: number };
type SendPlan = {
  id: string;
  state: string;
  announcedAt: string | null;
  startsAt: string;
  endsAt: string;
  items: Array<{ email: { id: number; subject: string | null; status: string; scheduledFor: string | null; business: { name: string | null; city: string | null; country: string | null; timezone: string | null } | null } }>;
};
type Market = { code: string; name: string; enabled: boolean };
type PortfolioSettings = {
  portfolioUrl: string;
  latestWork: Array<{ title: string; url: string }>;
};

export default function SettingsPage() {
  const [admins, setAdmins] = useState<Admin[]>([]);
  const [plans, setPlans] = useState<SendPlan[]>([]);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [planCountry, setPlanCountry] = useState('');
  const [portfolio, setPortfolio] = useState<PortfolioSettings>({ portfolioUrl: '', latestWork: [] });
  const [email, setEmail] = useState('');
  const [ready, setReady] = useState(false);
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [accountResponse, adminResponse] = await Promise.all([
        fetch('/api/proxy/auth/me'),
        fetch('/api/proxy/admins'),
      ]);
      if (accountResponse.status === 401 || adminResponse.status === 401) {
        location.href = '/login';
        return;
      }
      if (accountResponse.status === 403 || adminResponse.status === 403) {
        setError('Only the workspace owner can manage email access.');
        return;
      }
      if (!accountResponse.ok || !adminResponse.ok) throw new Error('Could not load email access settings.');
      const account = await accountResponse.json() as { role: string };
      if (account.role !== 'owner') {
        setError('Only the workspace owner can manage email access.');
        return;
      }
      setAdmins(await adminResponse.json());
      const [plansResponse, portfolioResponse, marketsResponse] = await Promise.all([
        fetch('/api/proxy/send-plans'),
        fetch('/api/proxy/settings/portfolio'),
        fetch('/api/proxy/markets'),
      ]);
      if (!plansResponse.ok || !portfolioResponse.ok || !marketsResponse.ok) throw new Error('Could not load workspace settings.');
      setPlans(await plansResponse.json());
      const marketData = await marketsResponse.json() as Market[];
      const enabledMarkets = marketData.filter((market) => market.enabled);
      setMarkets(enabledMarkets);
      setPlanCountry((current) => enabledMarkets.some((market) => market.code === current) ? current : enabledMarkets[0]?.code ?? '');
      const portfolioData = await portfolioResponse.json() as { portfolioUrl: string | null; latestWork: PortfolioSettings['latestWork'] };
      setPortfolio({ portfolioUrl: portfolioData.portfolioUrl ?? '', latestWork: portfolioData.latestWork });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const initGoogle = () => {
    const google = (window as any).google?.accounts?.id;
    const button = document.getElementById('settings-reauth');
    if (!google || !button) {
      setError('Google verification could not load. Refresh and try again.');
      return;
    }
    google.initialize({
      client_id: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
      callback: async (result: { credential?: string }) => {
        if (!result.credential) {
          setError('Google could not verify the owner account.');
          return;
        }
        setBusy(true);
        setError('');
        try {
          const response = await fetch('/api/proxy/auth/reauth', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ credential: result.credential }),
          });
          if (!response.ok) throw new Error('Owner verification failed. Sign in with the configured owner Google account.');
          setVerified(true);
          setNotice('Owner verified; protected workspace changes are enabled for five minutes.');
        } catch (verifyError) {
          setError(verifyError instanceof Error ? verifyError.message : 'Owner verification failed.');
        } finally {
          setBusy(false);
        }
      },
    });
    google.renderButton(button, { theme: 'filled_black', size: 'large', shape: 'rectangular', text: 'continue_with', width: 280 });
    setReady(true);
  };

  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/proxy/admins', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!response.ok) throw new Error(response.status === 403
        ? 'Verify the owner Google account before changing email access.'
        : 'Could not grant access. Check that this is a valid email address.');
      setEmail('');
      setNotice('Access granted. This person can now sign in with their Google account or an email code.');
      await load();
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : 'Could not grant access.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (admin: Admin) => {
    if (admin.role === 'owner') return;
    if (!window.confirm(`Remove website access for ${admin.email}? Their active sessions will be revoked.`)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`/api/proxy/admins/${admin.id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(response.status === 403
        ? 'Verify the owner Google account before changing email access.'
        : 'Could not remove access.');
      setNotice(`${admin.email} no longer has website access.`);
      await load();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : 'Could not remove access.');
    } finally {
      setBusy(false);
    }
  };

  const planAction = async (path: string, body: Record<string, unknown> = {}) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`/api/proxy/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(response.status === 403 ? 'Verify the owner Google account before managing send plans.' : `Send plan action failed${result?.error ? `: ${result.error}` : '.'}`);
      }
      setNotice('Send plan updated. Its state and schedule are recorded for audit.');
      const updated = await fetch('/api/proxy/send-plans');
      if (updated.ok) setPlans(await updated.json());
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Send plan action failed.');
    } finally {
      setBusy(false);
    }
  };

  const savePortfolio = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/proxy/settings/portfolio', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          portfolioUrl: portfolio.portfolioUrl.trim(),
          latestWork: portfolio.latestWork.map((work) => ({ title: work.title.trim(), url: work.url.trim() })),
        }),
      });
      const result = await response.json().catch(() => null) as {
        message?: string;
        portfolioUrl?: string | null;
        latestWork?: PortfolioSettings['latestWork'];
      } | null;
      if (!response.ok) {
        throw new Error(response.status === 403
          ? 'Verify the owner Google account before changing portfolio links.'
          : result?.message ?? 'Could not save portfolio links.');
      }
      if (!result || !Array.isArray(result.latestWork)) throw new Error('The server returned invalid portfolio settings.');
      setPortfolio({ portfolioUrl: result.portfolioUrl ?? '', latestWork: result.latestWork });
      setNotice('Portfolio links saved. They will be included in every email sent from now on, including approved and follow-up emails.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save portfolio links.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="admin-page">
      <Script src="https://accounts.google.com/gsi/client" onLoad={initGoogle} onError={() => setError('Google sign-in could not load.')} />
      <div className="admin-content">
        <div className="admin-heading">
          <div><div className="section-kicker">WORKSPACE SETTINGS</div><h1>Settings</h1><p>Manage email access, portfolio links, and sending safeguards.</p></div>
          <span className={`stepup-state${verified ? ' active' : ''}`}>{verified ? 'OWNER VERIFIED' : 'VERIFICATION REQUIRED'}</span>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        {notice && <div className="admin-notice" role="status">{notice}</div>}

        {!error.includes('Only the workspace owner') && (
          <>
            <section className="admin-panel" id="portfolio">
              <div className="admin-panel-heading">
                <div>
                  <div className="section-kicker">EMAIL SIGNATURE</div>
                  <h2>Portfolio and recent work</h2>
                  <p>These HTTPS links are appended to every outgoing email at send time, including existing drafts and follow-ups.</p>
                </div>
              </div>
              <form className="portfolio-settings-form" onSubmit={savePortfolio}>
                <label className="field-label" htmlFor="portfolio-url">Main portfolio link</label>
                <input
                  id="portfolio-url"
                  type="url"
                  inputMode="url"
                  placeholder="https://your-portfolio.example"
                  value={portfolio.portfolioUrl}
                  onChange={(event) => setPortfolio((current) => ({ ...current, portfolioUrl: event.target.value }))}
                />
                <div className="portfolio-work-heading">
                  <div><strong>Latest work</strong><span>Add up to five specific projects or case studies.</span></div>
                  <button
                    className="reject-button"
                    type="button"
                    disabled={busy || portfolio.latestWork.length >= 5}
                    onClick={() => setPortfolio((current) => ({ ...current, latestWork: [...current.latestWork, { title: '', url: '' }] }))}
                  >Add a link</button>
                </div>
                {!portfolio.latestWork.length && <p className="admin-empty">No project links added yet.</p>}
                {portfolio.latestWork.map((work, index) => (
                  <div className="portfolio-work-row" key={index}>
                    <label className="sr-only" htmlFor={`work-title-${index}`}>Project title {index + 1}</label>
                    <input
                      id={`work-title-${index}`}
                      required
                      maxLength={120}
                      placeholder="Project or case study name"
                      value={work.title}
                      onChange={(event) => setPortfolio((current) => ({
                        ...current,
                        latestWork: current.latestWork.map((item, itemIndex) => itemIndex === index ? { ...item, title: event.target.value } : item),
                      }))}
                    />
                    <label className="sr-only" htmlFor={`work-url-${index}`}>Project URL {index + 1}</label>
                    <input
                      id={`work-url-${index}`}
                      required
                      type="url"
                      inputMode="url"
                      placeholder="https://example.com/my-work"
                      value={work.url}
                      onChange={(event) => setPortfolio((current) => ({
                        ...current,
                        latestWork: current.latestWork.map((item, itemIndex) => itemIndex === index ? { ...item, url: event.target.value } : item),
                      }))}
                    />
                    <button
                      className="reject-button"
                      type="button"
                      disabled={busy}
                      aria-label={`Remove project link ${index + 1}`}
                      onClick={() => setPortfolio((current) => ({ ...current, latestWork: current.latestWork.filter((_, itemIndex) => itemIndex !== index) }))}
                    >Remove</button>
                  </div>
                ))}
                <p className="portfolio-form-note">Links must use HTTPS. Emails remain plain text; every configured link is written out in the signature for broad mail-client compatibility.</p>
                <button className="approve-button" type="submit" disabled={busy || !verified}>
                  {busy ? 'Saving…' : 'Save portfolio links'}
                </button>
              </form>
            </section>
            <section className="admin-panel" id="send-plans">
              <div className="admin-panel-heading">
                <div><div className="section-kicker">SEND SAFETY</div><h2>Announced send plans</h2><p>Eligible plans are prepared automatically for enabled markets and announced at least 24 hours before the local send window. You can also create a plan now. Only emails you approve can send.</p></div>
              </div>
              <div className="plan-create-row">
                <label htmlFor="send-plan-country">Market</label>
                <select id="send-plan-country" value={planCountry} disabled={busy || !markets.length} onChange={(event) => setPlanCountry(event.target.value)}>
                  {markets.map((market) => <option key={market.code} value={market.code}>{market.name}</option>)}
                </select>
                <button className="approve-button" disabled={busy || !verified || !planCountry} onClick={() => void planAction('send-plans', { country: planCountry })}>
                  Create plan now
                </button>
              </div>
              <p className="portfolio-form-note">Automatic planning prepares at most one upcoming plan per enabled market when eligible drafts are available. Notifications include the market, first local send time, and review count. Open the plan below to see the businesses; personal contact addresses are not put in notification messages.</p>
              {!markets.length && <p className="admin-empty">Enable at least one market before creating a send plan.</p>}
              {!plans.length ? <p className="admin-empty">No send plans yet. A plan will be announced automatically when eligible emails are available.</p> : (
                <div className="admin-list send-plan-list">{plans.map((plan) => (
                  <article className="send-plan-card" key={plan.id}>
                    <div className="admin-panel-heading">
                      <div>
                        <h3>{plan.items[0]?.email.business?.country ?? 'Market'} · {plan.items.length} business{plan.items.length === 1 ? '' : 'es'} · {plan.state}</h3>
                        <p>First planned send {new Date(plan.startsAt).toLocaleString()} · End {new Date(plan.endsAt).toLocaleString()} · Announced {plan.announcedAt ? new Date(plan.announcedAt).toLocaleString() : '—'}</p>
                        <p>{plan.items.filter(({ email: item }) => item.status === 'drafted').length} still need review/approval</p>
                      </div>
                      <span className={`stepup-state${plan.state === 'announced' ? ' active' : ''}`}>{plan.state.toUpperCase()}</span>
                    </div>
                    <div className="send-plan-emails">{plan.items.map(({ email: item }) => (
                      <span key={item.id}>
                        <strong>{item.business?.name ?? 'Business'}</strong>{item.business?.city ? ` · ${item.business.city}` : ''}
                        {' · '}{item.scheduledFor ? new Date(item.scheduledFor).toLocaleString() : 'Time pending'}
                        {' · '}{item.status}
                        {item.status === 'drafted' && <> · <a href={`/?email=${item.id}#review-queue`}>Review draft</a></>}
                      </span>
                    ))}</div>
                    {['announced', 'frozen'].includes(plan.state) && <div className="gmail-actions">
                      {plan.state === 'announced' && <button className="reject-button" disabled={busy || !verified} onClick={() => void planAction(`send-plans/${plan.id}/freeze`)}>Freeze</button>}
                      <button className="reject-button" disabled={busy || !verified} onClick={() => {
                        if (window.confirm('Veto this plan? No email in it will be sent.')) void planAction(`send-plans/${plan.id}/veto`);
                      }}>Veto plan</button>
                      <button className="reject-button" disabled={busy || !verified} onClick={() => {
                        const startsAt = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString();
                        void planAction(`send-plans/${plan.id}/reschedule`, { startsAt });
                      }}>Reschedule +7h</button>
                    </div>}
                  </article>
                ))}</div>
              )}
            </section>

            <section className="admin-panel">
              <div className="admin-panel-heading">
                <div><div className="section-kicker">SECURITY CHECK</div><h2>Confirm it&apos;s you</h2><p>Google verification is required before changing access, portfolio links, or send plans.</p></div>
              </div>
              <div className="reauth-control"><div id="settings-reauth" /><span>{ready ? 'Verify with the configured owner Google account.' : 'Loading Google verification…'}</span></div>
              <form className="admin-add-form" onSubmit={add}>
                <label htmlFor="access-email">Grant access to an email address</label>
                <div className="otp-input-row">
                  <input id="access-email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="person@example.com" />
                  <button type="submit" disabled={busy || !verified}>{busy ? 'Saving…' : 'Grant access'}</button>
                </div>
                <small>Added users can sign in with Google or request an email sign-in code.</small>
              </form>
            </section>

            <section className="admin-panel">
              <div className="admin-panel-heading">
                <div><div className="section-kicker">ALLOWLIST</div><h2>People with access</h2><p>Removing someone also revokes their active sessions.</p></div>
                <span className="queue-pill">{admins.length} accounts</span>
              </div>
              {loading ? <p className="admin-empty">Loading access list…</p> : !admins.length ? <p className="admin-empty">No accounts found.</p> : (
                <div className="admin-list">{admins.map((admin) => (
                  <div className="admin-row" key={admin.id}>
                    <div className="admin-identity"><strong>{admin.email}</strong><span>{admin.role} · {admin.activeSessions} active session{admin.activeSessions === 1 ? '' : 's'}</span></div>
                    {admin.role === 'owner'
                      ? <span className="owner-badge">OWNER</span>
                      : <button className="reject-button" disabled={busy || !verified} onClick={() => void remove(admin)}>Remove access</button>}
                  </div>
                ))}</div>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}
