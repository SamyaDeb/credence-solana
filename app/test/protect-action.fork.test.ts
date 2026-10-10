// FORK E2E (owner's machine; skipped unless FORK_E2E=1): the Protect Action against a running scripts/demo-app.sh.
// For one Kamino and one Jupiter Lend position: GET the Action (live quote), POST for the owner, sign the returned
// transaction with a fresh keypair (the demo burner's role), send it to the fork, and read the Policy back.
//   FORK_PORT=8909 PORT=3001 scripts/demo-app.sh          (terminal 1)
//   cd app && FORK_E2E=1 APP_URL=http://localhost:3001 RPC_URL=http://127.0.0.1:8909 pnpm vitest run test/protect-action.fork.test.ts
// Fork setup it does itself, all cheatcodes on the local fork: fund the keypair (/api/fork/fund), make it the owner of
// a real eligible obligation (/api/fork/take-position), move a real Jupiter Lend position NFT to it (surfnet_setAccount,
// as keeper/src/jl-demo.ts does).
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { JL_POSITION_DISC, JL_VAULTS, decodeJlPosition } from '@/lib/actions/build';
import { EPOCH, ATA_PROGRAM, KLEND, PROGRAM_ID, chainNow, program } from '@/lib/credence';
import { loadEpochs } from '@/lib/cover';

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

/** The Action round trip for `owner` on `position`: GET, POST full, sign, send, confirm; returns the Policy. */
async function protect(owner: Keypair, position: PublicKey, lender: 'kamino' | 'jupiter') {
  const q = `position=${position.toBase58()}&lender=${lender}`;
  const g = await fetch(`${APP}/api/actions/protect?${q}`);
  expect(g.headers.get('X-Blockchain-Ids')).toBe('solana:credence-local-fork');
  const meta = (await g.json()) as { label: string; disabled?: boolean; error?: { message: string }; links?: { actions: { href: string }[] } };
  expect(meta.disabled ?? false, meta.error?.message).toBe(false);
  expect(meta.label).toMatch(/USDC/);
  const p = await post(`/api/actions/protect?${q}&cap=full`, { account: owner.publicKey.toBase58() });
  expect(p.status, String(p.j.message)).toBe(200);
  const tx = Transaction.from(Buffer.from(p.j.transaction as string, 'base64'));
  const programs = tx.instructions.map((i) => i.programId.toBase58());
  expect(programs.includes(KLEND.toBase58())).toBe(lender === 'kamino');
  expect(programs.includes(JL_VAULTS.toBase58())).toBe(false);
  expect(programs.at(-1)).toBe(PROGRAM_ID.toBase58());
  tx.partialSign(owner);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const res = await conn.confirmTransaction(sig, 'confirmed');
  const got = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  expect(res.value.err ?? got?.meta?.err, (got?.meta?.logMessages ?? []).slice(-8).join('\n')).toBeNull();
  const policies = await prog.account.policy.all([{ memcmp: { offset: 8, bytes: owner.publicKey.toBase58() } }]);
  const pol = policies.find((x: { account: { obligation: PublicKey } }) => x.account.obligation.equals(position));
  expect(pol, 'Policy for the position').toBeTruthy();
  return { pol: pol!.account, sig, cu: got?.meta?.computeUnitsConsumed ?? 0 };
}

describe.skipIf(!process.env.FORK_E2E)('Protect Action on the fork (e2e)', () => {
  // The fork's clock is real time, which on a Friday evening or a weekend is outside every sale window ("sales open Mon …").
  // Move it, as the demo does (surfnet_timeTravel), to 10 minutes into the sale window of the earliest open WEEKEND epoch.
  beforeAll(async () => {
    const now = await chainNow(conn);
    const open = (await loadEpochs(prog)).filter((e) => e.state === EPOCH.OPEN && e.closureType === 2 && now < e.bell).sort((a, b) => a.saleOpen - b.saleOpen);
    if (!open[0]) throw new Error('no open WEEKEND epoch on the fork (run scripts/demo-app.sh)');
    if (now < open[0].saleOpen) await rpc('surfnet_timeTravel', [{ absoluteTimestamp: (open[0].saleOpen + 600) * 1000 }]);
  }, 60_000);

  it('Kamino: the Action\'s transaction, signed by the owner, lands a Policy', async () => {
    const owner = Keypair.generate();
    expect((await post('/api/fork/fund', { owner: owner.publicKey.toBase58() })).status).toBe(200);
    const c = (await (await fetch(`${APP}/api/positions/candidates`)).json()) as { rows: { obligation: string }[] };
    let landed = false;
    for (const row of c.rows.slice(0, 5)) {
      const t = await post('/api/fork/take-position', { obligation: row.obligation, owner: owner.publicKey.toBase58() });
      if (t.status !== 200) continue;
      const g = (await (await fetch(`${APP}/api/actions/protect?position=${row.obligation}&lender=kamino`)).json()) as { disabled?: boolean };
      if (g.disabled) continue; // not on sale for its asset, or no longer eligible on the fork: try the next
      const { pol, cu } = await protect(owner, new PublicKey(row.obligation), 'kamino');
      // "Full debt" is the debt the Action simulated when it built the transaction; the loan accrues until the transaction
      // lands (about 1.4 ppm per second here), so the cap is never above the landed debt and short of it by seconds of interest.
      const cap = BigInt(pol.maxPayout.toString()), debt = BigInt(pol.debt.toString());
      expect(cap <= debt && (debt - cap) * 10_000n <= debt, `cap ${cap} vs landed debt ${debt}`).toBe(true);
      console.log(`Kamino policy: premium ${Number(pol.premium) / 1e6} USDC, ${cu} CU`);
      landed = true;
      break;
    }
    expect(landed, 'no candidate position could be protected').toBe(true);
  }, 240_000);

  it('Jupiter Lend: the Action\'s transaction, signed by the NFT holder, lands a Policy', async () => {
    const owner = Keypair.generate();
    expect((await post('/api/fork/fund', { owner: owner.publicKey.toBase58() })).status).toBe(200);
    const vault = Number(process.env.JL_VAULT ?? 78);
    const all = await conn.getProgramAccounts(JL_VAULTS, { filters: [
      { memcmp: { offset: 0, bytes: JL_POSITION_DISC.toString('base64'), encoding: 'base64' } } as never,
      { memcmp: { offset: 8, bytes: Buffer.from([vault & 255, vault >> 8]).toString('base64'), encoding: 'base64' } } as never] });
    const pick = all.filter(({ account: { data: d } }) => d[46] === 0 && d.readInt32LE(47) > -16383 && d.readBigUInt64LE(55) > 0n)
      .sort((a, b) => Number(b.account.data.readBigUInt64LE(55) - a.account.data.readBigUInt64LE(55)))[0];
    expect(pick, `a Jupiter Lend position with debt in vault ${vault}`).toBeTruthy();
    const pos = decodeJlPosition(pick.account.data)!;
    // The NFT moved to the owner's associated token account (cheatcode), the real holder's emptied (as jl-demo.ts).
    const holders = await conn.getTokenLargestAccounts(pos.mint);
    const nftAcc = holders.value.find((h) => h.amount === '1')!.address;
    const info = (await conn.getAccountInfo(nftAcc))!;
    const ata = PublicKey.findProgramAddressSync([owner.publicKey.toBuffer(), info.owner.toBuffer(), pos.mint.toBuffer()], ATA_PROGRAM)[0];
    const d1 = Buffer.from(info.data); owner.publicKey.toBuffer().copy(d1, 32);
    await rpc('surfnet_setAccount', [ata.toBase58(), { lamports: info.lamports, data: d1.toString('hex'), owner: info.owner.toBase58() }]);
    const d0 = Buffer.from(info.data); d0.writeBigUInt64LE(0n, 64);
    await rpc('surfnet_setAccount', [nftAcc.toBase58(), { lamports: info.lamports, data: d0.toString('hex'), owner: info.owner.toBase58() }]);
    const { pol, cu } = await protect(owner, pick.pubkey, 'jupiter');
    console.log(`Jupiter Lend policy: premium ${Number(pol.premium) / 1e6} USDC, ${cu} CU`);
  }, 240_000);
});
