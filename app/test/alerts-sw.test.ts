// The web push service worker (public/alerts-sw.js), run in a sandbox: it shows the alert and opens its link, always on
// this app's origin (A-123).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function worker(origin: string) {
  const handlers: Record<string, (e: unknown) => void> = {};
  const self = {
    location: { origin },
    addEventListener: (k: string, f: (e: unknown) => void) => { handlers[k] = f; },
    registration: { showNotification: vi.fn(async () => {}) },
    clients: { openWindow: vi.fn(async () => {}) },
  };
  runInNewContext(readFileSync(join(__dirname, '../public/alerts-sw.js'), 'utf8'), { self, URL });
  return { self, handlers };
}
const click = (url: string) => ({ notification: { close: vi.fn(), data: { url } }, waitUntil: (p: Promise<unknown>) => p });

describe('alerts service worker', () => {
  it('shows the push with its text', async () => {
    const { self, handlers } = worker('http://localhost:3000');
    handlers.push({ data: { json: () => ({ title: 'T', body: 'B', url: 'http://localhost:3000/app/protect?position=x' }) }, waitUntil: (p: Promise<unknown>) => p });
    expect(self.registration.showNotification).toHaveBeenCalledWith('T', { body: 'B', data: { url: 'http://localhost:3000/app/protect?position=x' } });
  });
  it('A-123: a link built for another origin (ALERTS_APP_URL vs where the user subscribed) opens the same path here', () => {
    const { self, handlers } = worker('http://127.0.0.1:3001');
    handlers.notificationclick(click('http://localhost:3000/app/protect?position=x&lender=kamino'));
    expect(self.clients.openWindow).toHaveBeenCalledWith('http://127.0.0.1:3001/app/protect?position=x&lender=kamino');
  });
  it('never opens another site: only /app/protect on this origin', () => {
    const { self, handlers } = worker('http://localhost:3000');
    handlers.notificationclick(click('https://evil.example/phish'));
    expect(self.clients.openWindow).toHaveBeenCalledWith('http://localhost:3000/app/protect');
  });
});
