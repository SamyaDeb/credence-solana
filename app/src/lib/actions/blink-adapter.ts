// The in-app Blink's wallet side (@dialectlabs/blinks `BlinkAdapter`): it supports only the fork's chain id, signs with
// the app's own signer (the demo burner or Phantom) and sends through the app's fork Connection, never to mainnet.
// Before signing it re-checks the transaction the Action returned (lib/actions/shape.ts): only the expected programs,
// one buy, the wallet as the only signer and fee payer. Message signing is not offered. Dialect's proxy is off.
import { type BlinkAdapter, type BlinkExecutionContext, setProxyUrl } from '@dialectlabs/blinks';
import { type Connection, Transaction } from '@solana/web3.js';
import type { AppSigner } from '@/lib/tx';
import { type Lender, shapeProblem } from './shape';
import { FORK_CHAIN_ID } from './spec';

// The Blink client sends every Action GET and POST through https://proxy.dial.to unless the host is exactly localhost
// or 127.0.0.1: on a LAN address or a tunnel the wallet and the position would go to Dialect (and the proxy cannot
// reach a local fork app anyway). Off for this app (audit A-112).
setProxyUrl(null as unknown as string);

export type SentTx = { signature: string; cu: number };

export function forkBlinkAdapter(conn: Connection, signer: AppSigner | null, onSent?: (s: SentTx) => void): BlinkAdapter {
  return {
    metadata: { supportedBlockchainIds: [FORK_CHAIN_ID] },
    connect: async () => signer?.publicKey.toBase58() ?? null,
    signTransaction: async (b64: string, ctx: BlinkExecutionContext) => {
      if (!signer) return { error: 'Connect a wallet first (the demo burner works without Phantom).' };
      const lender = lenderOf(ctx);
      if (!lender) return { error: 'unknown lender in the Action URL' };
      const bad = shapeProblem(b64, lender, signer.publicKey);
      if (bad) return { error: `refused to sign: ${bad}` };
      try {
        const tx = Transaction.from(Buffer.from(b64, 'base64'));
        const signed = await signer.signTransaction(tx);
        const signature = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
        return { signature };
      } catch (e) {
        return { error: (e as Error).message.split('\n')[0] };
      }
    },
    confirmTransaction: async (signature: string) => {
      const r = await conn.confirmTransaction(signature, 'confirmed');
      const got = await conn.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (r.value.err ?? got?.meta?.err) throw new Error(`the transaction failed on the fork: ${JSON.stringify(r.value.err ?? got?.meta?.err)}`);
      onSent?.({ signature, cu: got?.meta?.computeUnitsConsumed ?? 0 });
    },
    signMessage: async () => ({ error: 'message signing is not used by this Action' }),
  };
}

/** The lender of the Action being executed, from the linked action's href (else the Blink's URL). */
export function lenderOf(ctx: Pick<BlinkExecutionContext, 'originalUrl'> & { triggeredLinkedAction?: { href?: string } }): Lender | null {
  for (const u of [ctx.triggeredLinkedAction?.href, ctx.originalUrl]) {
    if (!u) continue;
    try {
      const l = new URL(u, 'http://localhost').searchParams.get('lender');
      if (l === 'kamino' || l === 'jupiter') return l;
    } catch { /* next */ }
  }
  return null;
}
