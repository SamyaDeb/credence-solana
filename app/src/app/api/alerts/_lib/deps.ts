// The alert routes' configuration: the store under data/alerts (ALERTS_DIR overrides), the hosts a signed message may
// name (ALERTS_DOMAINS, default this app on localhost / 127.0.0.1 and PORT), the Telegram bot's public name and the VAPID
// public key. The bot token and the VAPID private key are the keeper's; the app never reads them.
import 'server-only';
import { alertsDir } from '../../../../../../keeper/src/alerts-store';
import { RateLimiter } from '@/lib/actions/guard';
import { NETWORK } from '@/lib/network';
import { ROOT } from '@/lib/server/fork';
import type { AlertsDeps } from './alerts';

const port = process.env.PORT ?? '3000';

export const alertsDeps: AlertsDeps = {
  dir: alertsDir(ROOT),
  // Per client: 12 (a subscribe is two requests), then one every 5 s; everyone together: 30, then one a second. Without
  // TRUST_PROXY=1 every request counts as one local client (A-110).
  limiter: new RateLimiter({ burst: 12, perSecond: 0.2, globalBurst: 30, globalPerSecond: 1 }),
  domains: (process.env.ALERTS_DOMAINS ?? `localhost:${port},127.0.0.1:${port}`).split(',').map((d) => d.trim()).filter(Boolean),
  telegramBot: process.env.TELEGRAM_BOT_USERNAME ?? null,
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? null,
  network: NETWORK,
};
