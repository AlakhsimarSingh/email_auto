'use client';

import { useCallback, useEffect, useState } from 'react';

type Device = {
  id: string;
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
  lastSeenAt: string;
  createdAt: string;
  lastTestAt: string | null;
};

type QuietHours = { quietStart: string; quietEnd: string };
type PushConfig = { configured: boolean; publicKey: string | null };

function applicationServerKey(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)).buffer as ArrayBuffer;
}

async function responseError(response: Response, fallback: string) {
  const result = await response.json().catch(() => null) as { error?: string } | null;
  if (response.status === 401) {
    location.href = '/login';
    return 'Your session has expired.';
  }
  if (response.status === 429) return 'Please wait a minute before testing this device again.';
  if (result?.error === 'push_not_configured') return 'Web Push keys are not configured on the backend yet.';
  if (result?.error === 'invalid_push_subscription') return 'This browser returned an unsupported push subscription.';
  return fallback;
}

export default function DevicesPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [quietHours, setQuietHours] = useState<Record<string, QuietHours>>({});
  const [config, setConfig] = useState<PushConfig>({ configured: false, publicKey: null });
  const [label, setLabel] = useState('This device');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const supported = typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [devicesResponse, configResponse] = await Promise.all([
        fetch('/api/proxy/devices'),
        fetch('/api/proxy/push/config'),
      ]);
      if (devicesResponse.status === 401 || configResponse.status === 401) {
        location.href = '/login';
        return;
      }
      if (configResponse.status === 503) {
        throw new Error('Backend Web Push settings are incomplete. Configure all three VAPID values and restart the backend.');
      }
      if (!devicesResponse.ok || !configResponse.ok) throw new Error('Could not load push device settings.');
      const deviceData = await devicesResponse.json() as Device[];
      setDevices(deviceData);
      setQuietHours(Object.fromEntries(deviceData.map((device) => [device.id, {
        quietStart: device.quietStart ?? '',
        quietEnd: device.quietEnd ?? '',
      }])));
      setConfig(await configResponse.json() as PushConfig);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load push device settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const register = async () => {
    if (!supported) {
      setError('Push notifications require an installed, up-to-date browser that supports Web Push.');
      return;
    }
    if (!config.configured || !config.publicKey) {
      setError('Web Push keys are not configured on the backend yet.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Allow notifications in your browser to register this device.');
      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey(config.publicKey),
        });
      }
      const response = await fetch('/api/proxy/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          label: label.trim(),
          subscription: subscription.toJSON(),
        }),
      });
      if (!response.ok) throw new Error(await responseError(response, 'Could not register this device for push notifications.'));
      setNotice('This device is registered. New human replies can now trigger a notification.');
      await load();
    } catch (registerError) {
      setError(registerError instanceof Error ? registerError.message : 'Could not register this device.');
    } finally {
      setBusy(false);
    }
  };

  const test = async (id: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`/api/proxy/devices/${id}/test`, { method: 'POST' });
      if (!response.ok) throw new Error(await responseError(response, 'Push test delivery failed.'));
      setNotice('Test notification sent. Check this device’s notification tray.');
      await load();
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : 'Push test delivery failed.');
    } finally {
      setBusy(false);
    }
  };

  const patchDevice = async (device: Device, values: Partial<Device>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`/api/proxy/devices/${device.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values),
      });
      if (!response.ok) throw new Error('Could not save device notification preferences.');
      setDevices((current) => current.map((item) => ({
        ...item,
        ...(values.isPrimary ? { isPrimary: item.id === device.id } : {}),
        ...(item.id === device.id ? values : {}),
      })));
      setNotice('Device notification preferences saved.');
    } catch (patchError) {
      setError(patchError instanceof Error ? patchError.message : 'Could not save device notification preferences.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`/api/proxy/devices/${id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(await responseError(response, 'Could not remove this device.'));
      setNotice('Push notifications have been disconnected from this signed-in device.');
      await load();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : 'Could not remove this device.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="devices-page">
      <header className="admin-header">
        <a className="brand" href="/"><span className="brand-mark">E</span><span>Email<span className="brand-light">Auto</span></span></a>
        <a className="admin-back" href="/">← Back to workspace</a>
      </header>
      <div className="devices-content">
        <div className="section-kicker">PERSONAL NOTIFICATIONS</div>
        <h1>Devices</h1>
        <p className="devices-intro">Register this browser for private reply, send-plan, and digest notifications. Devices belong to this signed-in session and are removed when you sign out. <a href="/notifications">Configure Telegram and ntfy channels →</a></p>
        {error && <div className="error-banner" role="alert">{error}</div>}
        {notice && <div className="admin-notice" role="status">{notice}</div>}

        <section className="admin-panel">
          <div className="admin-panel-heading">
            <div>
              <div className="section-kicker">WEB PUSH</div>
              <h2>Register this device</h2>
              <p>Notifications use short, non-sensitive text. Reply content and recipient details are never included.</p>
            </div>
            <span className={`stepup-state${config.configured ? ' active' : ''}`}>{config.configured ? 'PUSH READY' : 'SETUP REQUIRED'}</span>
          </div>
          {!supported && <p className="devices-warning">This browser does not currently support Web Push. Try installing the app in a current version of Chrome, Firefox, or Safari.</p>}
          {!config.configured && <p className="devices-warning">Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT on the backend, then restart it before registering devices.</p>}
          <div className="devices-register-form">
            <label htmlFor="device-label">Device label</label>
            <div className="devices-register-row">
              <input id="device-label" maxLength={80} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Pixel · personal" />
              <button className="approve-button" type="button" disabled={busy || loading || !supported || !config.configured || !label.trim()} onClick={() => void register()}>
                {busy ? 'Working…' : 'Enable notifications'}
              </button>
            </div>
          </div>
        </section>

        <section className="admin-panel">
          <div className="admin-panel-heading">
            <div><div className="section-kicker">REGISTERED HERE</div><h2>This session’s devices</h2></div>
            <span className="queue-pill">{devices.length} device{devices.length === 1 ? '' : 's'}</span>
          </div>
          {loading ? <p className="admin-empty">Loading registered devices…</p> : !devices.length ? <p className="admin-empty">No push devices registered for this session.</p> : (
            <div className="admin-list">
              {devices.map((device) => (
                <article className="device-row" key={device.id}>
                  <div className="admin-identity">
                    <strong>{device.label}</strong>
                    <span>{device.enabled ? 'Notifications enabled' : 'Notifications paused'} · {device.isPrimary ? 'Primary notification device' : 'Secondary device'} · Last active {new Date(device.lastSeenAt).toLocaleString()}</span>
                  </div>
                  <div className="notification-preferences">
                    <label><input type="checkbox" checked={device.isPrimary} disabled={busy} onChange={(event) => void patchDevice(device, { isPrimary: event.target.checked })} /> Primary device</label>
                    <label><input type="checkbox" checked={device.muted} disabled={busy} onChange={(event) => void patchDevice(device, { muted: event.target.checked })} /> Mute device</label>
                    <label><input type="checkbox" checked={device.notifyReplies} disabled={busy} onChange={(event) => void patchDevice(device, { notifyReplies: event.target.checked })} /> Reply and SLA alerts</label>
                    <label><input type="checkbox" checked={device.notifyPlans} disabled={busy} onChange={(event) => void patchDevice(device, { notifyPlans: event.target.checked })} /> Send plan alerts</label>
                    <label><input type="checkbox" checked={device.notifyDigest} disabled={busy} onChange={(event) => void patchDevice(device, { notifyDigest: event.target.checked })} /> Digests</label>
                    <label className="digest-frequency">Digest frequency
                      <select value={device.digestFrequency} disabled={busy} onChange={(event) => void patchDevice(device, { digestFrequency: event.target.value as Device['digestFrequency'] })}>
                        <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="off">Off</option>
                      </select>
                    </label>
                    <label>Quiet from <input type="time" value={(quietHours[device.id] ?? { quietStart: '', quietEnd: '' }).quietStart} disabled={busy} onChange={(event) => setQuietHours((current) => ({ ...current, [device.id]: { ...(current[device.id] ?? { quietStart: '', quietEnd: '' }), quietStart: event.target.value } }))} /></label>
                    <label>Quiet until <input type="time" value={(quietHours[device.id] ?? { quietStart: '', quietEnd: '' }).quietEnd} disabled={busy} onChange={(event) => setQuietHours((current) => ({ ...current, [device.id]: { ...(current[device.id] ?? { quietStart: '', quietEnd: '' }), quietEnd: event.target.value } }))} /></label>
                    <button className="reject-button save-quiet-hours" disabled={busy || Boolean(quietHours[device.id]?.quietStart) !== Boolean(quietHours[device.id]?.quietEnd)} onClick={() => void patchDevice(device, {
                      quietStart: quietHours[device.id]?.quietStart || null,
                      quietEnd: quietHours[device.id]?.quietEnd || null,
                    })}>Save quiet hours</button>
                  </div>
                  <div className="device-actions">
                    <button className="reject-button" disabled={busy || !config.configured} onClick={() => void test(device.id)}>Send test</button>
                    <button className="reject-button" disabled={busy} onClick={() => void remove(device.id)}>Remove</button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
