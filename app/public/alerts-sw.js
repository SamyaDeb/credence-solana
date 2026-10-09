// Credence Friday alerts (C4a.2): shows a web push alert and opens its /app/protect link. Registered only when a user
// opts in on /app/protect. The alerts run on the local mainnet fork demo; not live.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Credence (fork, not live)', { body: d.body || '', data: { url: d.url || '/app/protect' } }));
});
// The link is rebuilt on this worker's origin (the keeper's ALERTS_APP_URL may name another host or port than the one
// the user subscribed from), and only /app/protect is ever opened (audit A-123).
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  let url;
  try { url = new URL(e.notification.data && e.notification.data.url ? e.notification.data.url : '/app/protect', self.location.origin); } catch { url = null; }
  const path = url && url.pathname === '/app/protect' ? url.pathname + url.search : '/app/protect';
  e.waitUntil(self.clients.openWindow(new URL(path, self.location.origin).href));
});
