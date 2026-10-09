// Credence Friday alerts (C4a.2): shows a web push alert and opens its /app/protect link. Registered only when a user
// opts in on /app/protect. The alerts run on the local mainnet fork demo; not live.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Credence (fork, not live)', { body: d.body || '', data: { url: d.url || '/app/protect' } }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data && e.notification.data.url ? e.notification.data.url : '/app/protect', self.location.origin);
  if (url.origin !== self.location.origin) return;
  e.waitUntil(self.clients.openWindow(url.href));
});
