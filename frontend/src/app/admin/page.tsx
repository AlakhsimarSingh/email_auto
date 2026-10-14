'use client';

import Script from 'next/script';
import { startRegistration } from '@simplewebauthn/browser';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';

type Admin = { id: number; email: string; role: string; createdAt: string; activeSessions: number };
type Session = {
  id: string;
  deviceLabel: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  adminUser: { email: string; role: string };
};
type AuditEntry = { id: number; actorEmail: string; action: string; target: string | null; createdAt: string };
type Passkey = { id: string; label: string; deviceType: string; backedUp: boolean; createdAt: string; lastUsedAt: string | null };
type GmailStatus = { connected: boolean; email?: string; source: string; error?: boolean };

export default function AdminPage() {
  const [admins, setAdmins] = useState<Admin[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [gmail, setGmail] = useState<GmailStatus | null>(null);
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [stepUp, setStepUp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [googleReady, setGoogleReady] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const responses = await Promise.all([
        fetch('/api/proxy/admins'),
        fetch('/api/proxy/sessions'),
        fetch('/api/proxy/audit-log'),
        fetch('/api/proxy/auth/passkeys'),
        fetch('/api/proxy/auth/gmail/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
      ]);
      if (responses.some((response) => response.status === 401)) {
        location.href = '/login';
        return;
      }
      if (responses.some((response) => response.status === 403)) {
        setError('This area is restricted to the workspace owner.');
        return;
      }
      if (responses.slice(0, 4).some((response) => !response.ok)) throw new Error('Could not load admin and security data.');
      const [adminData, sessionData, auditData, passkeyData] = await Promise.all(responses.slice(0, 4).map((response) => response.json()));
      setAdmins(adminData);
      setSessions(sessionData);
      setAudit(auditData);
      setPasskeys(passkeyData);
      if (responses[4].ok) setGmail(await responses[4].json());
      else setGmail({ connected: false, source: 'unknown', error: true });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load admin data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const result = new URLSearchParams(location.search).get('gmail');
    if (result === 'connected') setNotice('The owner Gmail mailbox is connected and verified.');
    else if (result) setError(({
      denied: 'Gmail authorization was cancelled.',
      scope: 'Gmail access was not granted. Connect again and tick the "Read, compose, and send emails" checkbox (or Select all) on the Google screen.',
      'api-disabled': 'The Gmail API is disabled in your Google Cloud project. Enable it under APIs & Services → Library → Gmail API, wait a minute, then connect again.',
      'wrong-account': 'That Google account is not the owner mailbox. Connect again and choose the OWNER_EMAIL account.',
    } as Record<string, string>)[result] ?? 'Gmail could not be connected. Re-verify the owner account and try again.');
    if (result) history.replaceState(null, '', '/admin');
  }, []);

  const initGoogle = () => {
    try {
      const google = (window as any).google?.accounts?.id;
      const button = document.getElementById('reauth-button');
      if (!google || !button) {
        setError('Google sign-in could not load. Check your connection and refresh.');
        return;
      }
      google.initialize({
        client_id: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
        callback: async (result: { credential?: string }) => {
          if (!result.credential) {
            setError('Google did not verify your identity. Please try again.');
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
            setStepUp(true);
            setNotice('Owner verified. Admin changes are enabled for five minutes.');
          } catch (reauthError) {
            setError(reauthError instanceof Error ? reauthError.message : 'Owner verification failed.');
          } finally {
            setBusy(false);
          }
        },
      });
      google.renderButton(button, { theme: 'filled_black', size: 'large', shape: 'rectangular', text: 'continue_with', width: 280 });
      setGoogleReady(true);
    } catch {
      setError('Google sign-in could not initialize. Check the client ID and allowed origin.');
    }
  };

  const addAdmin = async (event: FormEvent<HTMLFormElement>) => {
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
      if (!response.ok) throw new Error(response.status === 403 ? 'Verify your Google identity before changing admins.' : 'Could not add this admin.');
      setEmail('');
      setNotice('Admin access granted. They can sign in with a one-time email code.');
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Could not add admin.');
    } finally {
      setBusy(false);
    }
  };

  const removeAdmin = async (admin: Admin) => {
    if (!window.confirm(`Remove admin access for ${admin.email}? Their active sessions will be deleted.`)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`/api/proxy/admins/${admin.id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Could not remove this admin.');
      setNotice(`${admin.email} no longer has access.`);
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Could not remove admin.');
    } finally {
      setBusy(false);
    }
  };

  const revokeSession = async (session: Session) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`/api/proxy/sessions/${session.id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Could not revoke this session.');
      setNotice(`Session revoked for ${session.adminUser.email}.`);
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Could not revoke session.');
    } finally {
      setBusy(false);
    }
  };

  const registerPasskey = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const optionsResponse = await fetch('/api/proxy/auth/passkeys/register/options', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!optionsResponse.ok) throw new Error('Could not start passkey registration.');
      const { options, challengeId } = await optionsResponse.json();
      const credential = await startRegistration({ optionsJSON: options });
      const verifyResponse = await fetch('/api/proxy/auth/passkeys/register/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ challengeId, credential, label: navigator.platform || 'This device' }),
      });
      if (!verifyResponse.ok) throw new Error(verifyResponse.status === 403 ? 'Verify your Google identity before registering a passkey.' : 'Passkey registration could not be verified.');
      setStepUp(false);
      setNotice('Passkey registered. You can use it to sign in on this device.');
      await load();
    } catch (passkeyError) {
      setError(passkeyError instanceof Error ? passkeyError.message : 'Passkey registration failed.');
    } finally {
      setBusy(false);
    }
  };

  const removePasskey = async (passkey: Passkey) => {
    if (!window.confirm(`Remove the "${passkey.label}" passkey?`)) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/proxy/auth/passkeys/${encodeURIComponent(passkey.id)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(response.status === 403 ? 'Verify your Google identity before removing a passkey.' : 'Could not remove this passkey.');
      setStepUp(false);
      setNotice('Passkey removed.');
      await load();
    } catch (passkeyError) {
      setError(passkeyError instanceof Error ? passkeyError.message : 'Could not remove passkey.');
    } finally {
      setBusy(false);
    }
  };

  const connectGmail = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/gmail/connect', { method: 'POST' });
      const body = await response.json();
      if (!response.ok || typeof body.url !== 'string') throw new Error(response.status === 403 ? 'Verify your Google identity before connecting Gmail.' : 'Could not start Gmail authorization.');
      location.href = body.url;
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : 'Could not connect Gmail.');
      setBusy(false);
    }
  };

  const disconnectGmail = async () => {
    if (!window.confirm('Disconnect the Gmail refresh token used for sends and admin sign-in codes?')) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/proxy/auth/gmail/disconnect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) throw new Error(response.status === 403 ? 'Verify your Google identity before disconnecting Gmail.' : 'Could not disconnect Gmail.');
      setStepUp(false);
      setNotice('Gmail disconnected. OTP email delivery and campaign sends are paused.');
      await load();
    } catch (disconnectError) {
      setError(disconnectError instanceof Error ? disconnectError.message : 'Could not disconnect Gmail.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="admin-page">
      <Script src="https://accounts.google.com/gsi/client" onLoad={initGoogle} onError={() => setError('Google sign-in could not load.')} />
      <div className="admin-content">
        <div className="admin-heading">
          <div><div className="section-kicker">WORKSPACE OWNER</div><h1>Admin &amp; security</h1><p>Manage who can access this workspace and review active sessions.</p></div>
          <button className="refresh-button" onClick={() => void load()} disabled={loading}>Refresh</button>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        {notice && <div className="admin-notice" role="status">{notice}</div>}

        <section className="admin-panel">
          <div className="admin-panel-heading"><div><div className="section-kicker">OWNER VERIFICATION</div><h2>Confirm it&apos;s you</h2><p>Admin changes require fresh Google verification and expire after five minutes.</p></div><span className={`stepup-state${stepUp ? ' active' : ''}`}>{stepUp ? 'VERIFIED' : 'REQUIRED'}</span></div>
          <div className="reauth-control"><div id="reauth-button" /><span>{googleReady ? 'Verify with the owner Google account to manage access.' : 'Loading Google verification…'}</span></div>
          <form className="admin-add-form" onSubmit={addAdmin}>
            <label htmlFor="new-admin">Add workspace admin</label>
            <div className="otp-input-row"><input id="new-admin" type="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="admin@company.com" /><button type="submit" disabled={busy || !stepUp}>{busy ? 'Saving…' : 'Add admin'}</button></div>
          </form>
        </section>

        <section className="admin-panel">
          <div className="admin-panel-heading"><div><div className="section-kicker">OWNER MAILBOX</div><h2>Gmail connection</h2><p>Only the configured owner mailbox may be connected. This account sends campaign emails and admin sign-in codes.</p></div><span className={`stepup-state${gmail?.connected ? ' active' : ''}`}>{gmail?.error ? 'CHECK NEEDED' : gmail?.connected ? 'CONNECTED' : 'DISCONNECTED'}</span></div>
          <div className="gmail-status-line">
            {gmail?.error ? 'Could not verify the configured mailbox. Reconnect with the gmail.modify scope.' : gmail?.connected ? `${gmail.email} · ${gmail.source === 'database' ? 'encrypted app connection' : 'server environment token'}` : 'No active Gmail refresh token.'}
          </div>
          <div className="gmail-actions">
            <button className="approve-button" disabled={busy || !stepUp} onClick={() => void connectGmail()}>{gmail?.connected ? 'Reconnect Gmail' : 'Connect Gmail'}</button>
            {(gmail?.connected || gmail?.error) && <button className="reject-button" disabled={busy || !stepUp} onClick={() => void disconnectGmail()}>Disconnect</button>}
          </div>
        </section>

        <section className="admin-panel">
          <div className="admin-panel-heading"><div><div className="section-kicker">TRUSTED DEVICE</div><h2>Passkeys</h2><p>Register a device passkey for owner sign-in without another Google prompt.</p></div><button className="approve-button" disabled={busy || !stepUp} onClick={() => void registerPasskey()}>Register passkey</button></div>
          {loading ? <p className="admin-empty">Loading passkeys…</p> : !passkeys.length ? <p className="admin-empty">No passkeys registered yet.</p> : (
            <div className="admin-list">{passkeys.map((passkey) => <div className="admin-row" key={passkey.id}>
              <div className="admin-identity"><strong>{passkey.label}</strong><span>{passkey.deviceType}{passkey.backedUp ? ' · Synced' : ''} · Last used {passkey.lastUsedAt ? new Date(passkey.lastUsedAt).toLocaleString() : 'Never'}</span></div>
              <button className="reject-button" disabled={busy || !stepUp} onClick={() => void removePasskey(passkey)}>Remove</button>
            </div>)}</div>
          )}
        </section>

        <section className="admin-panel">
          <div className="admin-panel-heading"><div><div className="section-kicker">ACCESS LIST</div><h2>Workspace admins</h2><p>Admins can review drafts and receive email sign-in codes.</p></div><span className="queue-pill">{admins.length} accounts</span></div>
          {loading ? <p className="admin-empty">Loading accounts…</p> : !admins.length ? <p className="admin-empty">No admin accounts found.</p> : (
            <div className="admin-list">{admins.map((admin) => <div className="admin-row" key={admin.id}>
              <div className="admin-identity"><strong>{admin.email}</strong><span>{admin.role} · {admin.activeSessions} active session{admin.activeSessions === 1 ? '' : 's'}</span></div>
              {admin.role === 'owner' ? <span className="owner-badge">OWNER</span> : <button className="reject-button" disabled={busy || !stepUp} onClick={() => void removeAdmin(admin)}>Remove</button>}
            </div>)}</div>
          )}
        </section>

        <section className="admin-panel">
          <div className="admin-panel-heading"><div><div className="section-kicker">LIVE ACCESS</div><h2>Active sessions</h2><p>Revoking a session immediately blocks its next request.</p></div><span className="queue-pill">{sessions.length} active</span></div>
          {loading ? <p className="admin-empty">Loading sessions…</p> : !sessions.length ? <p className="admin-empty">No active sessions.</p> : (
            <div className="admin-list">{sessions.map((session) => <div className="admin-row" key={session.id}>
              <div className="admin-identity"><strong>{session.adminUser.email}</strong><span>{session.deviceLabel} · Last active {new Date(session.lastSeenAt).toLocaleString()}</span></div>
              <button className="reject-button" disabled={busy} onClick={() => void revokeSession(session)}>Revoke</button>
            </div>)}</div>
          )}
        </section>

        <section className="admin-panel">
          <div className="admin-panel-heading"><div><div className="section-kicker">AUDIT TRAIL</div><h2>Recent security activity</h2><p>Latest sign-ins, access changes, and session revocations.</p></div></div>
          {loading ? <p className="admin-empty">Loading audit activity…</p> : !audit.length ? <p className="admin-empty">No activity recorded yet.</p> : (
            <div className="audit-list">{audit.map((entry) => <div className="audit-row" key={entry.id}><span><strong>{entry.action.replaceAll('.', ' ')}</strong><small>{entry.actorEmail}{entry.target ? ` · ${entry.target}` : ''}</small></span><time>{new Date(entry.createdAt).toLocaleString()}</time></div>)}</div>
          )}
        </section>
      </div>
    </main>
  );
}
