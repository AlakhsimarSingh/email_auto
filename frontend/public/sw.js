const CACHE_NAME = 'outreach-offline-v3';
const OFFLINE_URL = '/offline';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.add(OFFLINE_URL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.mode !== 'navigate') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(request).catch(async () => {
      const offlinePage = await caches.match(OFFLINE_URL);
      if (offlinePage) return offlinePage;
      return new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }),
  );
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = typeof payload.title === 'string' ? payload.title.slice(0, 80) : 'Outreach Agent';
  const body = typeof payload.body === 'string' ? payload.body.slice(0, 160) : 'You have a workspace update.';
  const tag = typeof payload.tag === 'string' ? payload.tag.slice(0, 100) : 'workspace-update';
  if (payload.close === true && typeof payload.notificationId === 'string') {
    event.waitUntil(
      self.registration.getNotifications({ tag }).then((notifications) => {
        notifications.forEach((notification) => notification.close());
      }),
    );
    return;
  }
  const url = ['/inbox', '/#review-queue', '/notifications', '/settings#send-plans'].includes(payload.url) ? payload.url : '/';
  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag,
    icon: '/icon.svg',
    badge: '/icon.svg',
    data: { url, notificationId: payload.notificationId },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = event.notification.data?.url;
  const url = ['/inbox', '/#review-queue', '/notifications', '/settings#send-plans'].includes(path) ? new URL(path, self.location.origin).href : self.location.origin;
  const notificationId = event.notification.data?.notificationId;
  event.waitUntil(
    Promise.all([
      typeof notificationId === 'string'
        ? fetch(`/api/proxy/notifications/${encodeURIComponent(notificationId)}/ack`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
        }).catch(() => undefined)
        : Promise.resolve(),
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }),
    ]).then(async ([, clients]) => {
      const matchingClient = clients.find((client) => new URL(client.url).origin === self.location.origin);
      if (matchingClient) {
        await matchingClient.navigate(url);
        return matchingClient.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
