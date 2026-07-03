/**
 * Service worker — push + notificationclick ONLY (blueprint 04 §4).
 *
 * Deliberately no fetch handler and no caching: offline is out of scope
 * (SPEC §3), and a cache here could serve stale money data. Install prompts
 * do not require offline support (Next PWA guide §2). Registered with
 * updateViaCache: 'none' and served with Cache-Control: no-cache
 * (next.config.ts), so updates land on the next visit.
 */

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let data = {};
  try {
    data = event.data.json();
  } catch {
    data = { title: 'Private Coop', body: event.data.text() };
  }
  const title = data.title || 'Private Coop';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/ledger' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/ledger';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      // Deep-link an existing window if one is open, else open a new one.
      for (const client of windows) {
        if ('focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
