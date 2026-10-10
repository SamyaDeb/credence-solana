// Where the Friday alerts go (C4a.2): Telegram (the bot's sendMessage), web push (VAPID, `web-push`), or a mocked
// transport for tests and runs without credentials. Errors never carry the bot token, the chat id or the push endpoint:
// a failure is reported as the transport and an HTTP status only.
import webpush from 'web-push';

export type Transport = { name: string; send(channelId: string, text: string, url: string): Promise<void> };

export class TransportError extends Error {
  constructor(readonly transport: string, readonly status: number | null, readonly permanent = false) {
    super(`${transport} failed${status ? ` (HTTP ${status})` : ''}`);
  }
}

/** TELEGRAM_BOT_TOKEN's bot. The token sits in the request path; it is never logged or put in an error. */
export function telegramTransport(token: string, fetchImpl: typeof fetch = fetch): Transport {
  return {
    name: 'telegram',
    async send(chatId, text) {
      let r: Response;
      try {
        r = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new TransportError('telegram', null);
      }
      // 400/403: the chat is gone or blocked the bot; retrying will not help.
      if (!r.ok) throw new TransportError('telegram', r.status, r.status === 400 || r.status === 403);
    },
  };
}

/** Web push with VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY. `channelId` is the browser's PushSubscription JSON. */
export function webPushTransport(vapid: { publicKey: string; privateKey: string; subject: string }, send = webpush.sendNotification): Transport {
  return {
    name: 'webpush',
    async send(sub, text, url) {
      try {
        await send(JSON.parse(sub) as webpush.PushSubscription, JSON.stringify({ title: 'Credence (fork, not live)', body: text, url }),
          { vapidDetails: vapid, TTL: 6 * 3600, timeout: 10_000 });
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode ?? null;
        throw new TransportError('webpush', status, status === 404 || status === 410);
      }
    },
  };
}

/** Records what would be sent (tests; runs without TELEGRAM_BOT_TOKEN or VAPID keys). */
export function memoryTransport(name = 'memory', fail: (n: number) => boolean = () => false) {
  const sent: { channelId: string; text: string; url: string }[] = [];
  let calls = 0;
  const t: Transport & { sent: typeof sent; calls: () => number } = {
    name, sent, calls: () => calls,
    async send(channelId, text, url) {
      calls++;
      if (fail(calls)) throw new TransportError(name, 502);
      sent.push({ channelId, text, url });
    },
  };
  return t;
}
