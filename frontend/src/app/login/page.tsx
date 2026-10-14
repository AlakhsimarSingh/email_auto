'use client';
import Script from 'next/script';
import { startAuthentication } from '@simplewebauthn/browser';
import { useState } from 'react';
import type { FormEvent } from 'react';

export default function Login() {
  const [msg, setMsg] = useState('');
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const requestCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setMsg('');
    try {
      const response = await fetch('/api/otp/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!response.ok) throw new Error('Could not request a code. Please try again.');
      setCodeSent(true);
      setMsg('If this email is allowed, a sign-in code was sent. Check your inbox.');
    } catch (error) {
      setMsg(error instanceof Error ? error.message : 'Could not request a code.');
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setMsg('');
    try {
      const response = await fetch('/api/otp/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, code }),
      });
      if (response.ok) {
        location.href = '/';
        return;
      }
      setMsg(response.status === 401
        ? 'That code is invalid or expired. Check it and try again.'
        : 'Sign-in could not be completed. Please try again.');
    } catch {
      setMsg('Could not reach the sign-in service. Check that the app is running and try again.');
    } finally {
      setBusy(false);
    }
  };

  const signInWithPasskey = async () => {
    if (!email.trim()) {
      setMsg('Enter the owner email address first.');
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      const optionsResponse = await fetch('/api/passkeys/options', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!optionsResponse.ok) throw new Error('No passkey is available for that account.');
      const { options, challengeId } = await optionsResponse.json();
      const credential = await startAuthentication({ optionsJSON: options });
      const verifyResponse = await fetch('/api/passkeys/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ challengeId, credential }),
      });
      if (!verifyResponse.ok) throw new Error('Passkey could not be verified. Please try again.');
      location.href = '/';
    } catch (error) {
      setMsg(error instanceof Error ? error.message : 'Passkey sign-in could not be completed.');
    } finally {
      setBusy(false);
    }
  };

  const init = () => {
    try {
      const button = document.getElementById('gbtn');
      if (!button || !(window as any).google?.accounts?.id) {
        setMsg('Google sign-in could not load. Check your connection and refresh.');
        return;
      }
      const google = (window as any).google.accounts.id;
      google.initialize({
        client_id: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
        callback: async (res: { credential?: string }) => {
          if (!res.credential) {
            setMsg('Google did not return a sign-in credential. Please try again.');
            return;
          }
          setMsg('');
          try {
            const response = await fetch('/api/login', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ credential: res.credential }),
            });
            if (response.ok) {
              location.href = '/';
              return;
            }
            setMsg(response.status === 403
              ? 'This Google account is not on the workspace allowlist.'
              : 'Sign-in could not be completed. Please try again.');
          } catch {
            setMsg('Could not reach the sign-in service. Check that the app is running and try again.');
          }
        },
      });
      google.renderButton(button, {
        theme: 'filled_black',
        size: 'large',
        shape: 'rectangular',
        text: 'continue_with',
        width: 320,
      });
      setReady(true);
    } catch {
      setMsg('Google sign-in could not initialize. Check the client ID and allowed origin.');
    }
  };

  return (
    <main className="login-page">
      <div className="login-orb login-orb-one" />
      <div className="login-orb login-orb-two" />
      <header className="login-topbar">
        <a className="brand login-brand" href="/" aria-label="Email Auto home">
          <span className="brand-mark">E</span>
          <span>Email<span className="brand-light">Auto</span></span>
        </a>
        <span className="login-private"><span className="secure-dot" /> PRIVATE WORKSPACE</span>
      </header>

      <section className="login-layout">
        <div className="login-story">
          <div className="login-kicker"><span className="kicker-line" /> THE OUTREACH DESK</div>
          <h1>Good conversations<br /><span>start with care.</span></h1>
          <p className="login-intro">A thoughtful workspace for finding the right businesses, writing with context, and keeping every send in your hands.</p>

          <div className="login-preview" aria-label="Outreach workflow preview">
            <div className="preview-header">
              <div><span className="preview-overline">TODAY&apos;S WORKFLOW</span><strong>Your outreach, at a glance</strong></div>
              <span className="preview-live"><i /> LIVE</span>
            </div>
            <div className="preview-stats">
              <div className="preview-stat"><span>To review</span><strong>03</strong><small>Needs your eyes</small></div>
              <div className="preview-stat"><span>Queued</span><strong>08</strong><small>Ready when you are</small></div>
              <div className="preview-stat"><span>Sent today</span><strong>02</strong><small>At a human pace</small></div>
            </div>
            <div className="preview-activity">
              <span className="activity-mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="m5 12 4 4L19 6" /></svg></span>
              <span><strong>Every draft is yours to review</strong><small>No email goes out without your approval.</small></span>
              <span className="activity-arrow">↗</span>
            </div>
          </div>

          <div className="login-values">
            <span><i /> Review before sending</span>
            <span><i /> Your account, your control</span>
          </div>
        </div>

        <div className="login-card-wrap">
          <div className="login-card">
            <div className="login-card-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></svg></div>
            <div className="login-card-eyebrow">WELCOME BACK</div>
            <h2>Sign in to your<br />workspace</h2>
            <p className="login-card-copy">Owners use Google. Workspace admins can request a one-time email code.</p>

            <div className={`google-button-wrap${ready ? ' is-ready' : ''}`}>
              <div id="gbtn" />
              {!ready && <div className="google-loading"><span className="loading-spinner" /> Loading secure sign-in…</div>}
            </div>

            <div className="login-divider"><span /> <small>OR ADMIN EMAIL CODE</small> <span /></div>
            {!codeSent ? (
              <form className="otp-form" onSubmit={requestCode}>
                <label htmlFor="login-email">Allowlisted email</label>
                <div className="otp-input-row">
                  <input id="login-email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" />
                  <button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send code'}</button>
                </div>
              </form>
            ) : (
              <form className="otp-form" onSubmit={verifyCode}>
                <label htmlFor="login-code">6-digit sign-in code</label>
                <div className="otp-input-row">
                  <input id="login-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="000000" />
                  <button type="submit" disabled={busy || code.length !== 6}>{busy ? 'Checking…' : 'Verify'}</button>
                </div>
                <button className="otp-resend" type="button" disabled={busy} onClick={() => { setCodeSent(false); setCode(''); setMsg(''); }}>Use a different email</button>
              </form>
            )}
            {!codeSent && <button className="passkey-login-button" type="button" onClick={() => void signInWithPasskey()} disabled={busy}>Sign in with passkey</button>}
            {msg && <p className="login-error" role="status">{msg}</p>}
            <p className="login-assurance"><span className="secure-dot" /> Protected with Google sign-in or a short-lived code</p>
          </div>
          <p className="login-help">Having trouble? Make sure you&apos;re signing in with the owner or an approved admin account.</p>
        </div>
      </section>

      <footer className="login-footer"><span>EMAILAUTO</span><span>Private by design · Thoughtful by default</span></footer>
      <Script src="https://accounts.google.com/gsi/client" onLoad={init} onError={() => setMsg('Google sign-in could not load. Check your connection and refresh.')} />
    </main>
  );
}
