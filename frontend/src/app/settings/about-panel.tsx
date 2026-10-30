'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

const MAX = 450;

export default function AboutPanel() {
  const [bio, setBio] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/api/proxy/settings/profile', { cache: 'no-store' });
        if (!response.ok) throw new Error();
        const data = await response.json() as { bio: string | null };
        setBio(data.bio ?? '');
        setLoaded(true);
      } catch {
        setError('Could not load "About you". Press Refresh at the top of the page to try again.');
      }
    })();
  }, []);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/proxy/settings/profile', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bio: bio.trim() || null }),
      });
      const result = await response.json().catch(() => null) as { bio?: string | null; message?: string } | null;
      if (!response.ok) throw new Error(result?.message ?? 'Could not save "About you".');
      setBio(result?.bio ?? '');
      setNotice(result?.bio ? 'Saved. New drafts, and drafts you press Rewrite on, will include it.' : 'Cleared. Drafts will no longer include a line about you.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save "About you".');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="admin-panel" id="about">
      <div className="admin-panel-heading">
        <div>
          <div className="section-kicker">CREDIBILITY</div>
          <h2>About you</h2>
          <p>Two or three sentences about who you are and what you have delivered. Every pitch includes a line built only from this text, so keep it true and specific.</p>
        </div>
      </div>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {notice && <div className="admin-notice" role="status">{notice}</div>}
      <form className="portfolio-settings-form" onSubmit={save}>
        <label className="field-label" htmlFor="about-bio">About you</label>
        <textarea
          id="about-bio"
          rows={4}
          maxLength={MAX}
          disabled={!loaded}
          value={bio}
          placeholder="e.g. I'm Alex, a full-stack developer. I rebuilt the booking site for a local chauffeur service and built an online store with card payments for a clothing brand."
          onChange={(event) => setBio(event.target.value)}
        />
        <div className="about-meta">
          <span>Tips: say what you build, name real projects and results, and skip links (your portfolio links are added automatically).</span>
          <span className={bio.length > MAX - 40 ? 'warn' : ''}>{bio.length}/{MAX}</span>
        </div>
        <button className="approve-button" type="submit" disabled={busy || !loaded}>{busy ? 'Saving…' : 'Save'}</button>
      </form>
    </section>
  );
}
