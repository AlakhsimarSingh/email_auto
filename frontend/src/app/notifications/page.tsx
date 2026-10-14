'use client';

import { useCallback, useEffect, useState } from 'react';

type Channel = {
  id: string;
  type: 'telegram' | 'ntfy';
  label: string;
  enabled: boolean;
  isPrimary: boolean;
  muted: boolean;
  quietStart: string | null;
  quietEnd: string | null;
  notifyReplies: boolean;
  notifyPlans: boolean;
  notifyDigest: boolean;
  digestFrequency: 'daily' | 'weekly' | 'off';
};

type Notification = {
  id: string;
  eventType: string;
  priority: number;
  title: string;
  body: string;
  url: string;
  createdAt: string;
  acknowledgedAt: string | null;
  escalatedAt: string | null;
};

type QuietHours = { quietStart: string; quietEnd: string };

export default function NotificationsPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [quietHours, setQuietHours] = useState<Record<string, QuietHours>>({});
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [ntfyUrl, setNtfyUrl] = useState('');
  const [ntfyToken, setNtfyToken] = useState('');
  const [telegramLink, setTelegramLink] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [channelsResponse, notificationsResponse] = await Promise.all([
        fetch('/api/proxy/notifications/channels'),
        fetch('/api/proxy/notifications'),
      ]);
      if (channelsResponse.status === 401 || notificationsResponse.status === 401) {
        location.href = '/login';
        return;
      }
      if (!channelsResponse.ok || !notificationsResponse.ok) throw new Error('Could not load notification settings.');
      const channelData = await channelsResponse.json() as Channel[];
      setChannels(channelData);
      setQuietHours(Object.fromEntries(channelData.map((channel) => [channel.id, {
        quietStart: channel.quietStart ?? '',
        quietEnd: channel.quietEnd ?? '',
      }])));
      setNotifications(await notificationsResponse.json() as Notification[]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load notification settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const telegram = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/proxy/notifications/telegram/link', { method: 'POST' });
      const result = await response.json() as { url?: string; message?: string; error?: string };
      if (!response.ok || !result.url) throw new Error(result.message ?? 'Telegram linking is not configured on the backend.');
      setTelegramLink(result.url);
      setNotice('Open the one-time link in Telegram and press Start within ten minutes.');
    } catch (linkError) {
      setError(linkError instanceof Error ? linkError.message : 'Could not create a Telegram link.');
    } finally {
      setBusy(false);
    }
  };

  const addNtfy = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/proxy/notifications/channels/ntfy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: ntfyUrl.trim(), token: ntfyToken.trim() }),
      });
      const result = await response.json() as { error?: string; message?: string };
      if (!response.ok) throw new Error(result.message ?? `Could not verify ntfy topic${result.error ? ` (${result.error})` : ''}.`);
      setNtfyUrl('');
      setNtfyToken('');
      setNotice('ntfy is connected. The topic and access token are encrypted at rest.');
      await load();
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : 'Could not connect ntfy.');
    } finally {
      setBusy(false);
    }
  };

  const patchChannel = async (channel: Channel, values: Partial<Channel>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`/api/proxy/notifications/channels/${channel.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values),
      });
      if (!response.ok) throw new Error('Could not save notification preferences.');
      setChannels((current) => current.map((item) => ({
        ...item,
        ...(values.isPrimary ? { isPrimary: item.id === channel.id } : {}),
        ...(item.id === channel.id ? values : {}),
      })));
      setNotice('Notification preferences saved.');
    } catch (patchError) {
      setError(patchError instanceof Error ? patchError.message : 'Could not save notification preferences.');
    } finally {
      setBusy(false);
    }
  };

  const channelAction = async (channel: Channel, action: 'test' | 'remove') => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`/api/proxy/notifications/channels/${channel.id}${action === 'test' ? '/test' : ''}`, {
        method: action === 'test' ? 'POST' : 'DELETE',
      });
      if (!response.ok) throw new Error(action === 'test' ? 'Test notification delivery failed.' : 'Could not remove notification channel.');
      setNotice(action === 'test' ? 'Test notification sent.' : `${channel.label} was removed.`);
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Notification channel action failed.');
    } finally {
      setBusy(false);
    }
  };

  const acknowledge = async (item: Notification) => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/proxy/notifications/${item.id}/ack`, { method: 'POST' });
      if (!response.ok && response.status !== 409) throw new Error('Could not acknowledge this notification.');
      setNotifications((current) => current.map((entry) =>
        entry.id === item.id ? { ...entry, acknowledgedAt: new Date().toISOString() } : entry,
      ));
    } catch (ackError) {
      setError(ackError instanceof Error ? ackError.message : 'Could not acknowledge this notification.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="admin-page">
      <header className="admin-header">
        <a className="brand" href="/"><span className="brand-mark">E</span><span>Email<span className="brand-light">Auto</span></span></a>
        <a className="admin-back" href="/">← Back to workspace</a>
      </header>
      <div className="admin-content">
        <div className="admin-heading">
          <div><div className="section-kicker">ALERTS & DELIVERY</div><h1>Notifications</h1><p>Connect private channels, choose a primary digest destination, and acknowledge alerts across signed-in devices.</p></div>
          <a className="reject-button" href="/devices">Manage push devices</a>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        {notice && <div className="admin-notice" role="status">{notice}</div>}

        <section className="admin-panel">
          <div className="admin-panel-heading">
            <div><div className="section-kicker">TELEGRAM</div><h2>Link a private chat</h2><p>The bot uses a one-time, ten-minute link. It sends generic alerts and supports one-tap acknowledgement.</p></div>
          </div>
          <button className="approve-button" disabled={busy} onClick={() => void telegram()}>Create Telegram link</button>
          {telegramLink && <p className="notification-link"><a href={telegramLink} target="_blank" rel="noreferrer">Open Telegram to connect</a><button className="reject-button" onClick={() => void navigator.clipboard.writeText(telegramLink)}>Copy link</button></p>}
        </section>

        <section className="admin-panel">
          <div className="admin-panel-heading">
            <div><div className="section-kicker">NTFY</div><h2>Connect a private topic</h2><p>Use a long random ntfy.sh topic name. Optional bearer tokens are encrypted and never returned to the browser.</p></div>
          </div>
          <form className="notification-channel-form" onSubmit={addNtfy}>
            <label htmlFor="ntfy-url">Private topic URL</label>
            <input id="ntfy-url" type="url" required value={ntfyUrl} onChange={(event) => setNtfyUrl(event.target.value)} placeholder="https://ntfy.sh/a-long-random-private-topic" />
            <label htmlFor="ntfy-token">Bearer token (optional)</label>
            <input id="ntfy-token" type="password" autoComplete="new-password" value={ntfyToken} onChange={(event) => setNtfyToken(event.target.value)} placeholder="ntfy access token" />
            <button className="approve-button" type="submit" disabled={busy}>Verify and connect ntfy</button>
          </form>
        </section>

        <section className="admin-panel">
          <div className="admin-panel-heading">
            <div><div className="section-kicker">CONNECTED CHANNELS</div><h2>Routing and quiet hours</h2></div>
            <span className="queue-pill">{channels.length} channel{channels.length === 1 ? '' : 's'}</span>
          </div>
          {loading ? <p className="admin-empty">Loading channels…</p> : !channels.length ? <p className="admin-empty">No Telegram or ntfy channel linked yet. Web Push devices are managed separately.</p> : (
            <div className="notification-channel-list">
              {channels.map((channel) => (
                <article className="notification-channel-card" key={channel.id}>
                  <div className="admin-panel-heading">
                    <div><h3>{channel.label}</h3><p>{channel.type.toUpperCase()} · {channel.enabled ? 'Connected' : 'Paused'}</p></div>
                    {channel.isPrimary && <span className="stepup-state active">PRIMARY DIGEST</span>}
                  </div>
                  <div className="notification-preferences">
                    <label><input type="checkbox" checked={channel.isPrimary} disabled={busy} onChange={(event) => void patchChannel(channel, { isPrimary: event.target.checked })} /> Primary device/channel</label>
                    <label><input type="checkbox" checked={channel.muted} disabled={busy} onChange={(event) => void patchChannel(channel, { muted: event.target.checked })} /> Mute channel</label>
                    <label><input type="checkbox" checked={channel.notifyReplies} disabled={busy} onChange={(event) => void patchChannel(channel, { notifyReplies: event.target.checked })} /> Reply and SLA alerts</label>
                    <label><input type="checkbox" checked={channel.notifyPlans} disabled={busy} onChange={(event) => void patchChannel(channel, { notifyPlans: event.target.checked })} /> Send plan alerts</label>
                    <label><input type="checkbox" checked={channel.notifyDigest} disabled={busy} onChange={(event) => void patchChannel(channel, { notifyDigest: event.target.checked })} /> Digests</label>
                    <label className="digest-frequency">Digest frequency
                      <select value={channel.digestFrequency} disabled={busy} onChange={(event) => void patchChannel(channel, { digestFrequency: event.target.value as Channel['digestFrequency'] })}>
                        <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="off">Off</option>
                      </select>
                    </label>
                    <label>Quiet from <input type="time" value={(quietHours[channel.id] ?? { quietStart: '', quietEnd: '' }).quietStart} disabled={busy} onChange={(event) => setQuietHours((current) => ({ ...current, [channel.id]: { ...(current[channel.id] ?? { quietStart: '', quietEnd: '' }), quietStart: event.target.value } }))} /></label>
                    <label>Quiet until <input type="time" value={(quietHours[channel.id] ?? { quietStart: '', quietEnd: '' }).quietEnd} disabled={busy} onChange={(event) => setQuietHours((current) => ({ ...current, [channel.id]: { ...(current[channel.id] ?? { quietStart: '', quietEnd: '' }), quietEnd: event.target.value } }))} /></label>
                    <button className="reject-button save-quiet-hours" disabled={busy || Boolean(quietHours[channel.id]?.quietStart) !== Boolean(quietHours[channel.id]?.quietEnd)} onClick={() => void patchChannel(channel, {
                      quietStart: quietHours[channel.id]?.quietStart || null,
                      quietEnd: quietHours[channel.id]?.quietEnd || null,
                    })}>Save quiet hours</button>
                  </div>
                  <div className="device-actions">
                    <button className="reject-button" disabled={busy} onClick={() => void channelAction(channel, 'test')}>Send test</button>
                    <button className="reject-button" disabled={busy} onClick={() => void channelAction(channel, 'remove')}>Remove channel</button>
                  </div>
                </article>
              ))}
            </div>
          )}
          <p className="analytics-footnote">P0 send-plan and reply-SLA alerts bypass quiet hours unless muted. Daily digests use the configured timezone and local time. Weekly digests arrive Mondays.</p>
        </section>

        <section className="admin-panel">
          <div className="admin-panel-heading">
            <div><div className="section-kicker">RECENT ACTIVITY</div><h2>Notifications and acknowledgements</h2></div>
          </div>
          {loading ? <p className="admin-empty">Loading notifications…</p> : !notifications.length ? <p className="admin-empty">No notifications recorded.</p> : (
            <div className="admin-list">
              {notifications.map((item) => (
                <article className="notification-history-row" key={item.id}>
                  <div className="admin-identity">
                    <strong>{item.title}</strong>
                    <span>{item.body} · {new Date(item.createdAt).toLocaleString()}</span>
                    {item.escalatedAt && <small>Escalated {new Date(item.escalatedAt).toLocaleString()}</small>}
                  </div>
                  {item.acknowledgedAt
                    ? <span className="owner-badge">ACKNOWLEDGED</span>
                    : <button className="reject-button" disabled={busy} onClick={() => void acknowledge(item)}>Acknowledge</button>}
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
