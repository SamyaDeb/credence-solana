// The Friday alerts' Telegram bot (C4a.2): polls the bot's updates (getUpdates; no public webhook is needed for a local
// app). "/start" replies with a one-time link code (8 characters, 15 minutes) the user enters with their wallet's signed
// subscription on /app/protect; "/stop" removes every subscription of that chat (the chat's owner can always stop its
// messages). The update offset is kept in data/alerts/telegram-offset.json. Needs TELEGRAM_BOT_TOKEN.
//
//   pnpm -C keeper alerts:telegram            # loop (long polling)
//   pnpm -C keeper alerts:telegram --once
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { alertsDir, consumeCode, newCode, readJson, updateSubscribers, writeCode, writeJsonAtomic } from './alerts-store.js';

type Update = { update_id: number; message?: { chat: { id: number; type: string }; text?: string } };
export type BotApi = { updates(offset: number): Promise<Update[]>; reply(chatId: string, text: string): Promise<void> };

export function botApi(token: string, fetchImpl: typeof fetch = fetch): BotApi {
  const call = async (method: string, body: unknown) => {
    const r = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(40_000) });
    if (!r.ok) throw new Error(`telegram ${method} failed (HTTP ${r.status})`);
    return ((await r.json()) as { result: unknown }).result;
  };
  return {
    updates: async (offset) => (await call('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] })) as Update[],
    reply: async (chatId, text) => { await call('sendMessage', { chat_id: chatId, text }); },
  };
}

/** Handles one batch of updates; returns the next offset. Logs counts only. */
export async function pollOnce(api: BotApi, dir = alertsDir(), log = (l: string) => console.log(`alerts:telegram: ${l}`)) {
  const offsetFile = join(dir, 'telegram-offset.json');
  const { offset } = readJson(offsetFile, { offset: 0 });
  const ups = await api.updates(offset);
  let codes = 0, stops = 0, failed = 0;
  for (const u of ups) {
    const m = u.message;
    if (!m || m.chat.type !== 'private' || !m.text) continue;
    const chatId = String(m.chat.id);
    // A reply that fails (the user blocked the bot, the chat is gone) skips that update only: the offset still moves
    // past it, so one chat cannot stall everyone's /start and /stop (audit A-118).
    try {
      if (/^\/start\b/.test(m.text)) {
        const code = newCode();
        writeCode(dir, code, chatId);
        try {
          await api.reply(chatId, `Your Credence link code: ${code} (valid 15 minutes, once). Enter it on /app/protect and sign with your wallet to get Friday gap alerts. `
            + 'Credence runs on a local mainnet fork; not live; not insurance. Send /stop to stop all alerts to this chat.');
        } catch (e) {
          consumeCode(dir, code, 0); // never delivered: remove it
          throw e;
        }
        codes++;
      } else if (/^\/stop\b/.test(m.text)) {
        await updateSubscribers(dir, (subs) => subs.filter((s) => !(s.channel === 'telegram' && s.channelId === chatId)));
        await api.reply(chatId, 'Done: this chat gets no more Credence alerts.');
        stops++;
      }
    } catch {
      failed++;
    }
  }
  const next = ups.length ? Math.max(...ups.map((u) => u.update_id)) + 1 : offset;
  if (next !== offset) writeJsonAtomic(offsetFile, { offset: next });
  if (ups.length) log(`${ups.length} updates: ${codes} link codes, ${stops} stops, ${failed} replies failed`);
  return next;
}

async function main() {
  const { config } = await import('dotenv');
  config({ path: join(new URL('../../', import.meta.url).pathname, '.env'), quiet: true });
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.log('alerts:telegram: TELEGRAM_BOT_TOKEN is not set; nothing to poll'); return; }
  const api = botApi(token);
  for (;;) {
    try { await pollOnce(api); } catch (e) { console.error(`alerts:telegram: ${(e as Error).message.replace(/bot[^/\s]+/g, 'bot***')}`); await new Promise((r) => setTimeout(r, 5_000)); }
    if (process.argv.includes('--once')) return;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
