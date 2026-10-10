// The quote is the program's: quote_cover simulated. max_premium is the SDK's withSlippage of that quote.
import type { Connection } from '@solana/web3.js';
import { simulateQuote, withSlippage } from '@credence/sdk';
import type { ProtectState } from './load';

export type WidgetQuote = { premium: bigint; maxPremium: bigint; cu: number; maxPayout: bigint; slippageBps: number };

export async function quoteFor(conn: Connection, s: ProtectState, maxPayout: bigint, slippageBps: number): Promise<WidgetQuote> {
  if (!s.epoch || !s.risk) throw new Error('no weekend epoch is on sale for this position');
  const q = await simulateQuote(conn, s.ctx.prog, s.owner, s.ctx.asset, s.epoch, s.risk.coveredValue, s.risk.debt, maxPayout);
  return { premium: q.premium, maxPremium: withSlippage(q.premium, slippageBps), cu: q.cu, maxPayout, slippageBps };
}
