// The Friday alerts' signed message (C4a.2), Sign-In-With-Solana style: the wallet signs exactly this text, the server
// parses it strictly and verifies the ed25519 signature against the address in it. Shared by the browser (builds it)
// and the server (parses it); nothing here verifies.
//
//   localhost:3000 wants you to sign a message with your account:
//   <wallet>
//
//   Credence Friday alerts: subscribe. Gap protection on the local mainnet fork; not live.
//
//   Channel: telegram:<link code> | webpush:<sha-256 of the push endpoint>    (unsubscribe: telegram | webpush | all)
//   Threshold: <USD>                                                           (subscribe only)
//   Nonce: <server nonce>
//   Issued At: <ISO-8601>
//   Expiration Time: <ISO-8601>

export type AlertAction = 'subscribe' | 'unsubscribe';
export type AlertMessage = {
  domain: string;
  wallet: string;
  action: AlertAction;
  channel: string;
  threshold?: number;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
};

export const STATEMENT: Record<AlertAction, string> = {
  subscribe: 'Credence Friday alerts: subscribe. Gap protection on the local mainnet fork; not live.',
  unsubscribe: 'Credence Friday alerts: unsubscribe.',
};
export const MAX_MESSAGE = 1024;
/** How long a signed message is valid after the server issued its nonce. */
export const MESSAGE_TTL_SECS = 600;
export const MAX_THRESHOLD = 10_000_000;

const B58 = '[1-9A-HJ-NP-Za-km-z]{32,44}';
const ISO = '\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z';
export const CHANNEL_RE: Record<AlertAction, RegExp> = {
  subscribe: /^(telegram:[A-Z2-7]{8}|webpush:[0-9a-f]{64})$/,
  unsubscribe: /^(telegram|webpush|all)$/,
};
export const NONCE_RE = /^[A-Za-z0-9]{24}$/;

export function alertMessageText(m: AlertMessage): string {
  const lines = [`${m.domain} wants you to sign a message with your account:`, m.wallet, '', STATEMENT[m.action], '', `Channel: ${m.channel}`];
  if (m.action === 'subscribe') lines.push(`Threshold: ${m.threshold} USD`);
  lines.push(`Nonce: ${m.nonce}`, `Issued At: ${m.issuedAt}`, `Expiration Time: ${m.expiresAt}`);
  return lines.join('\n');
}

const MESSAGE = new RegExp(
  `^(?<domain>[a-z0-9.-]{1,253}(?::\\d{1,5})?) wants you to sign a message with your account:\\n(?<wallet>${B58})\\n\\n(?<statement>[^\\n]+)\\n\\n`
  + `Channel: (?<channel>[a-z0-9:A-Z]{1,80})\\n(?:Threshold: (?<threshold>\\d{1,8}) USD\\n)?Nonce: (?<nonce>[A-Za-z0-9]{24})\\n`
  + `Issued At: (?<issuedAt>${ISO})\\nExpiration Time: (?<expiresAt>${ISO})$`,
);

/** The message, or null unless it is exactly in the format above (one statement, a valid channel for its action). */
export function parseAlertMessage(text: string): AlertMessage | null {
  if (typeof text !== 'string' || text.length > MAX_MESSAGE) return null;
  const g = MESSAGE.exec(text)?.groups;
  if (!g) return null;
  const action = (Object.keys(STATEMENT) as AlertAction[]).find((a) => STATEMENT[a] === g.statement);
  if (!action || !CHANNEL_RE[action].test(g.channel)) return null;
  if ((action === 'subscribe') !== (g.threshold !== undefined)) return null;
  const threshold = g.threshold !== undefined ? Number(g.threshold) : undefined;
  if (threshold !== undefined && (threshold < 1 || threshold > MAX_THRESHOLD)) return null;
  const m: AlertMessage = { domain: g.domain, wallet: g.wallet, action, channel: g.channel, threshold, nonce: g.nonce, issuedAt: g.issuedAt, expiresAt: g.expiresAt };
  return alertMessageText(m) === text ? m : null;
}

/** sha-256 of a push endpoint, hex (Web Crypto: browser and Node). */
export async function endpointHash(endpoint: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
