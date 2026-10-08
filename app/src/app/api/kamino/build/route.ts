// POST {action, owner, reserve, amount, obligation?}: builds a Kamino action on the xStocks Market with klend-sdk's own
// builders (v2 instructions, refreshes included), as keeper/src/create-position.ts does, and returns the instructions
// unsigned. The browser's wallet signs them; nothing here holds a key or sends anything. Fork only (it reads the fork).
//   action: deposit (collateral) | withdraw (collateral) | borrow | repay; amount in base units of the reserve's mint.
//   obligation: the wallet's existing obligation (needed when its address is not the owner's vanilla PDA, e.g. a
//   position given to the wallet on the fork); omitted, the owner's vanilla obligation is used (created if needed).
import { AccountRole, address, createNoopSigner, createSolanaRpc, type Instruction } from '@solana/kit';
import { KaminoAction, KaminoMarket, VanillaObligation } from '@kamino-finance/klend-sdk';
import BN from 'bn.js';
import { CLOCK_SYSVAR, KLEND, XSTOCKS_MARKETS } from '@/lib/credence';
import { XSTOCKS_MARKET } from '@/lib/markets';
import { FORK_RPC, assertLocalFork, fail, getAccount, json } from '@/lib/server/fork';

export const dynamic = 'force-dynamic';
const ACTIONS = ['deposit', 'withdraw', 'borrow', 'repay'] as const;
type Action = (typeof ACTIONS)[number];

const out = (ix: Instruction) => ({
  programId: ix.programAddress,
  data: Buffer.from(ix.data ?? new Uint8Array()).toString('base64'),
  keys: (ix.accounts ?? []).map((a) => ({
    pubkey: a.address,
    isSigner: a.role === AccountRole.READONLY_SIGNER || a.role === AccountRole.WRITABLE_SIGNER,
    isWritable: a.role === AccountRole.WRITABLE || a.role === AccountRole.WRITABLE_SIGNER,
  })),
});
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';

export async function POST(req: Request) {
  try {
    assertLocalFork();
    const { action, owner, reserve, amount, obligation } = (await req.json()) as { action: Action; owner: string; reserve: string; amount: string; obligation?: string };
    if (!ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(', ')}`);
    if (!/^\d{1,20}$/.test(amount) || BigInt(amount) === 0n) throw new Error('amount: a positive integer in base units');
    const rpc = createSolanaRpc(FORK_RPC);
    const market = await KaminoMarket.load(rpc as never, address(XSTOCKS_MARKET.toBase58()), 400);
    if (!market) throw new Error('xStocks Market not found on the fork');
    if (!market.getReserveByAddress(address(reserve))) throw new Error('reserve is not in the xStocks Market');
    const clock = await getAccount(CLOCK_SYSVAR.toBase58());
    const slot = await rpc.getSlot({ commitment: 'confirmed' }).send();
    const instant = { slot, blockTime: clock!.data.readBigInt64LE(32) } as never;

    let ob: Awaited<ReturnType<typeof market.getObligationByAddress>> | VanillaObligation = new VanillaObligation(address(KLEND.toBase58()));
    if (obligation) {
      const loaded = await market.getObligationByAddress(address(obligation));
      if (!loaded) throw new Error('obligation not found');
      if (!XSTOCKS_MARKETS[loaded.state.lendingMarket] || loaded.state.owner !== owner) throw new Error('obligation is not this wallet\'s in the xStocks Market');
      ob = loaded;
    }
    const props = {
      kaminoMarket: market, amount: new BN(amount), reserveAddress: address(reserve), owner: createNoopSigner(address(owner)), obligation: ob as never,
      useV2Ixs: true, scopeRefreshConfig: undefined, includeAtaIxs: true, requestElevationGroup: false,
      initUserMetadata: { skipInitialization: false, skipLutCreation: true }, currentLedgerInstant: instant,
    };
    const a = action === 'deposit' ? await KaminoAction.buildDepositTxns(props)
      : action === 'withdraw' ? await KaminoAction.buildWithdrawTxns(props)
      : action === 'borrow' ? await KaminoAction.buildBorrowTxns(props)
      : await KaminoAction.buildRepayTxns(props);
    const act = a as unknown as { setupIxs: Instruction[]; setupIxsLabels: string[]; lendingIxsLabels: string[] };
    // Account creation (user metadata, obligation, farm states, token accounts) goes first, in its own transactions;
    // the refreshes stay with the action in one transaction.
    const isInit = (l: string) => /init|create|ata/i.test(l) && !/refresh/i.test(l);
    const init = new Set(act.setupIxs.filter((_, i) => isInit(act.setupIxsLabels[i])));
    const setup = [...init].map(out);
    const main = KaminoAction.actionToIxs(a).filter((ix) => !init.has(ix) && ix.programAddress !== COMPUTE_BUDGET).map(out);
    return json({ action, setup, main, labels: { setup: act.setupIxsLabels.filter(isInit), lending: act.lendingIxsLabels } });
  } catch (e) {
    return fail(e, 400);
  }
}
