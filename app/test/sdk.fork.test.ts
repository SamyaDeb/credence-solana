// FORK INTEGRATION of @credence/sdk (skipped unless FORK_E2E=1): the SDK's feed crank, quote, owner buy and curator book
// against a running scripts/demo-app.sh, signed by fresh keypairs.
//   FORK_PORT=8909 PORT=3001 scripts/demo-app.sh                              (terminal 1)
//   cd app && FORK_E2E=1 APP_URL=http://localhost:3001 RPC_URL=http://127.0.0.1:8909 pnpm vitest run test/sdk.fork.test.ts
// Fork setup, all cheatcodes on the local fork through the app's routes: fund a keypair (/api/fork/fund), make it the owner of
// a real eligible obligation (/api/fork/take-position), move Kamino's Scope refresh times to the fork clock (/api/fork/scope-fresh).
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, type TransactionInstruction } from '@solana/web3.js';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CoreError, EPOCH, PROGRAM_ID, addBookLegs, bookAddresses, bookLegStatus, buyCover, chainNow, checkProgram, currentEpoch, decodeObligation, defaultSealMax, deposits, borrows,
  eventsNamed, feedClosure, loadAssets, loadEpochs, loadReserves, loadSessions, openBook, pdas, program, quoteSingle, readBook, readBookLeg, readFeed, readFeeds,
  reserveToAsset, scopeChains, sealBook, simulateRefreshed, snapshot, toError, updateGapFeed, withSlippage, type BookLegSpec, type ReserveState,
} from '@credence/sdk';

const APP = process.env.APP_URL ?? 'http://localhost:3000';
const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const conn = new Connection(RPC, 'confirmed');
const prog = program(conn);

async function rpc(method: string, params: unknown[]) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = (await r.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const post = async (path: string, body: unknown) => {
  const r = await fetch(`${APP}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, j: (await r.json()) as Record<string, unknown> };
};
const fund = async (k: Keypair) => expect((await post('/api/fork/fund', { owner: k.publicKey.toBase58() })).status).toBe(200);

/** Signs and sends `ixs` (legacy transaction, 1.4M CU); marks the accounts it creates as local-only on the fork first. Returns the logs. */
async function send(ixs: TransactionInstruction[], signer: Keypair): Promise<string[]> {
  const keys = [...new Set(ixs.flatMap((i) => [i.programId, ...i.keys.map((k) => k.pubkey)]).map((k) => k.toBase58()))];
  expect((await post('/api/fork/offline', { keys })).status).toBe(200);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: signer.publicKey, blockhash, lastValidBlockHeight }).add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...ixs);
  tx.sign(signer);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  const got = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  const logs = got?.meta?.logMessages ?? [];
  if (got?.meta?.err) throw toError(got.meta.err, logs, tx.instructions.map((i) => i.programId), 'send');
  return logs;
}

async function candidates(): Promise<string[]> {
  const c = (await (await fetch(`${APP}/api/positions/candidates`)).json()) as { rows: { obligation: string }[] };
  return c.rows.map((r) => r.obligation);
}

/** A real Kamino obligation made `owner`'s, decoded with its reserves and the epoch on sale for its asset; null if it cannot be covered. */
async function take(obligation: string, owner: Keypair, allowCovered = false) {
  if ((await post('/api/fork/take-position', { obligation, owner: owner.publicKey.toBase58() })).status !== 200) return null;
  const key = new PublicKey(obligation);
  const o = decodeObligation((await conn.getAccountInfo(key))!.data);
  if (deposits(o).length !== 1 || borrows(o).length !== 1) return null;
  const reserves = await loadReserves(conn, [...deposits(o), ...borrows(o)]);
  const assets = await loadAssets(prog);
  const asset = reserveToAsset(assets).get(deposits(o)[0].toBase58());
  const epoch = asset && currentEpoch(await loadEpochs(prog), asset.ticker, await chainNow(conn));
  if (!asset || !epoch || epoch.closureType !== 2) return null;
  // Not one an earlier test (or the demo) already covered: its Policy PDA would exist.
  if (!allowCovered && (await prog.account.policy.fetchNullable(pdas.policy(epoch.key, key)))) return null;
  return { key, o, reserves, asset, epoch };
}
const freshen = async (reserves: Map<string, ReserveState>) =>
  expect((await post('/api/fork/scope-fresh', { pairs: scopeChains([...reserves.values()]) })).status).toBe(200);

describe.skipIf(!process.env.FORK_E2E)('@credence/sdk on the fork (integration)', () => {
  beforeAll(async () => {
    const now = await chainNow(conn);
    const open = (await loadEpochs(prog)).filter((e) => e.state === EPOCH.OPEN && e.closureType === 2 && now < e.bell).sort((a, b) => a.saleOpen - b.saleOpen);
    if (!open[0]) throw new Error('no open WEEKEND epoch on the fork (run scripts/demo-app.sh)');
    if (now < open[0].saleOpen) await rpc('surfnet_timeTravel', [{ absoluteTimestamp: (open[0].saleOpen + 600) * 1000 }]);
  }, 60_000);

  it('feed: checkProgram passes; updateGapFeed lands, emits GapFeedUpdated and the feed reads back; a wrong account is a typed CoreError', async () => {
    expect((await checkProgram(conn)).verified).toBeTruthy();
    const payer = Keypair.generate();
    await fund(payer);
    const before = (await readFeed(conn, 'SPYx'))!;
    expect(before.updates).toBeGreaterThan(0); // the keeper's setup pass created and cranked it
    expect((await readFeeds(prog)).map((f) => f.ticker)).toEqual(expect.arrayContaining(['SPYx', 'QQQx', 'NVDAx', 'TSLAx', 'GOOGLx', 'AAPLx', 'MSTRx', 'HOODx']));
    // The rate limit: wait min_update_slots since the last update.
    for (let i = 0; i < 120 && (await conn.getSlot('confirmed')) - before.lastUpdateSlot < before.minUpdateSlots + 2; i++) await new Promise((r) => setTimeout(r, 2_000));
    const asset = await prog.account.assetConfig.fetch(pdas.asset('SPYx'));
    const closure = feedClosure(await loadSessions(prog), await chainNow(conn))!;
    const ix = await updateGapFeed(prog, { ticker: 'SPYx', asset: pdas.asset('SPYx'), feedXstock: asset.feedXstock as number[], lender: 'kamino' }, closure);
    const logs = await send([ix], payer);
    expect(eventsNamed(logs, 'GapFeedUpdated')).toHaveLength(1);
    const after = (await readFeed(conn, 'SPYx'))!;
    expect(after.updates).toBe(before.updates + 1);
    expect(after.closureId).toBe(closure.id);
    expect(after.closureType).toBe(closure.type);
    expect(after.pLt5 >= after.pLt8 && after.pLt8 >= after.pLt12).toBe(true);
    // A price account at another address: the program refuses it, the SDK names the error (after the rate limit has passed:
    // the program checks the limit first).
    for (let i = 0; i < 120 && (await conn.getSlot('confirmed')) - after.lastUpdateSlot < after.minUpdateSlots + 2; i++) await new Promise((r) => setTimeout(r, 2_000));
    const bad = await updateGapFeed(prog, { ticker: 'SPYx', asset: pdas.asset('SPYx'), feedXstock: (await prog.account.assetConfig.fetch(pdas.asset('QQQx'))).feedXstock as number[], lender: 'kamino' }, closure);
    const { blockhash } = await conn.getLatestBlockhash('confirmed');
    const t = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash }).add(bad);
    const sim = await conn.simulateTransaction(t);
    const err = toError(sim.value.err, sim.value.logs, [PROGRAM_ID]);
    expect(err).toBeInstanceOf(CoreError);
    expect((err as CoreError).errorName).toBe('NotPushAccount');
  }, 300_000);

  it('quote and buy: the SDK quote is the Policy premium the buy lands', async () => {
    const owner = Keypair.generate();
    await fund(owner);
    let done = false;
    for (const ob of (await candidates()).slice(0, 6)) {
      const t = await take(ob, owner);
      if (!t) continue;
      await freshen(t.reserves);
      const refreshed = await simulateRefreshed(conn, owner.publicKey, t.key, t.o, t.reserves);
      const { coveredValue, debt } = snapshot(refreshed.state);
      const quote = await quoteSingle(conn, prog, owner.publicKey, t.asset, t.epoch, coveredValue, debt, debt);
      expect(quote.premium).toBeGreaterThan(0n);
      const vault = await prog.account.vault.fetch(pdas.vault());
      expect(await readBookLeg(prog, t.epoch.key, t.key)).toBeNull();
      const { ixs, policy } = await buyCover(prog, { kind: 'kamino', buyer: owner.publicKey, feeAccount: vault.feeAccount, maxPayout: debt, maxPremium: withSlippage(quote.premium, 200),
        asset: t.asset, epoch: t.epoch, obligation: t.key, o: t.o, reserves: t.reserves });
      await freshen(t.reserves);
      const logs = await send(ixs, owner);
      const pol = await prog.account.policy.fetch(policy);
      const premium = BigInt(pol.premium.toString());
      expect(premium <= withSlippage(quote.premium, 200)).toBe(true);
      expect(Number(premium > quote.premium ? premium - quote.premium : quote.premium - premium)).toBeLessThanOrEqual(Number(quote.premium) / 50 + 1);
      expect(eventsNamed(logs, 'CoverBought')).toHaveLength(1);
      done = true;
      break;
    }
    expect(done, 'no candidate position could be covered').toBe(true);
  }, 300_000);

  it('book: open, add legs (resumable), seal; an owner then buys its own cover with release_book_leg first', async () => {
    const payer = Keypair.generate();
    await fund(payer);
    const legs: { leg: BookLegSpec; take: NonNullable<Awaited<ReturnType<typeof take>>> }[] = [];
    for (const ob of (await candidates()).slice(0, 12)) {
      if (legs.length === 2) break;
      const t = await take(ob, Keypair.generate()); // someone else owns them: the payer covers positions it does not own
      if (t && (!legs.length || legs[0].take.epoch.closureId === t.epoch.closureId)) legs.push({ take: t, leg: { kind: 'kamino', ticker: t.asset.ticker, obligation: t.key, o: t.o, reserves: t.reserves } });
    }
    expect(legs.length, 'two coverable positions of one weekend').toBe(2);
    const closureId = legs[0].take.epoch.closureId;
    const { book } = bookAddresses(payer.publicKey, closureId, 77);
    const open = await openBook(prog, { payer: payer.publicKey, closureId, bookId: 77, epoch: legs[0].take.epoch.key });
    await send([open.ix], payer);
    expect((await readBook(prog, book))?.state).toBe(0);

    // Resumable: add the first leg, "close the tab", ask the chain what is left, add the rest.
    for (const [i, l] of legs.entries()) {
      await freshen(l.take.reserves);
      const status = await bookLegStatus(prog, { book, closureId, legs: legs.map((x) => x.leg) });
      const pending = status.filter((s) => s.status === 'pending').map((s) => s.leg);
      expect(pending.length).toBe(legs.length - i);
      const [tx] = await addBookLegs(prog, { payer: payer.publicKey, book, closureId, legs: [pending[0]], kaminoPerTx: 1 });
      await send(tx, payer);
    }
    expect((await bookLegStatus(prog, { book, closureId, legs: legs.map((x) => x.leg) })).map((s) => s.status)).toEqual(['in-this-book', 'in-this-book']);
    const vault = await prog.account.vault.fetch(pdas.vault());
    const b0 = (await readBook(prog, book))!;
    expect(b0.legsAdded).toBe(2);
    const logs = await send([await sealBook(prog, { payer: payer.publicKey, book, closureId, maxPremium: defaultSealMax(b0.escrowed), feeAccount: vault.feeAccount })], payer);
    expect(eventsNamed(logs, 'BookSealed')).toHaveLength(1);
    const sealed = (await readBook(prog, book))!;
    expect(sealed.state).toBe(1);
    expect(sealed.premium).toBeGreaterThan(0n);

    // Owner precedence: the first position's owner buys its own cover; the SDK prepends release_book_leg.
    const owner = Keypair.generate();
    await fund(owner);
    const t = (await take(legs[0].take.key.toBase58(), owner, true))!; // already a book leg: its Policy exists
    const leg = await readBookLeg(prog, t.epoch.key, t.key);
    expect(leg?.book.equals(book)).toBe(true);
    await freshen(t.reserves);
    const snap = snapshot((await simulateRefreshed(conn, owner.publicKey, t.key, t.o, t.reserves)).state);
    const { ixs } = await buyCover(prog, { kind: 'kamino', buyer: owner.publicKey, feeAccount: vault.feeAccount, maxPayout: snap.debt, maxPremium: 2n ** 40n, asset: t.asset, epoch: t.epoch,
      obligation: t.key, o: t.o, reserves: t.reserves, release: { ...leg!, releaseAsset: t.asset.key, releaseEpoch: t.epoch.key, closureId, positionTokenAccount: null } });
    expect(ixs[0].programId.equals(PROGRAM_ID)).toBe(true); // release_book_leg first
    await freshen(t.reserves);
    const buyLogs = await send(ixs, owner);
    expect(eventsNamed(buyLogs, 'BookLegRemoved').length).toBeGreaterThan(0);
    const pol = await prog.account.policy.fetch(pdas.policy(t.epoch.key, t.key));
    expect((pol.owner as PublicKey).equals(owner.publicKey)).toBe(true);
    expect(((pol.book ?? PublicKey.default) as PublicKey).equals(PublicKey.default)).toBe(true);
  }, 600_000);
});
