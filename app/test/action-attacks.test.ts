// Attack tests for the Protect my position Action (C4a.1), written before the handler. Each one is an attack on the
// public endpoint; the chain is a fake (test/fixtures/action-chain.ts), the transactions are built by the real builders.
import { ACTIONS_CORS_HEADERS } from '@solana/actions';
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KLEND, PROGRAM_ID } from '@/lib/credence';
import { JL_VAULTS, assembleTx, encodeTx } from '@/lib/actions/build';
import { RateLimiter } from '@/lib/actions/guard';
import { type ProtectDeps, Refusal, handleProtect } from '@/lib/actions/protect';
import { shapeProblem, txShape } from '@/lib/actions/shape';
import { FORK_CHAIN_ID, PUBLIC_CLUSTERS } from '@/lib/actions/spec';
import { fixture } from './fixtures/action-chain';

const SECRET_RPC = 'https://mainnet.helius-rpc.com/?api-key=SEKRET-0123456789';
const PATH_RPC = 'https://solana-mainnet.g.alchemy.com/v2/PATHKEY987654321';
let f: ReturnType<typeof fixture>;
let deps: ProtectDeps;
const limiter = () => new RateLimiter({ burst: 1000, perSecond: 1000, globalBurst: 1000, globalPerSecond: 1000 });

beforeEach(() => {
  f = fixture();
  deps = { chain: () => f.chain, limiter: limiter(), timeoutMs: 300, network: 'fork' };
  process.env.MAINNET_RPC = SECRET_RPC;
});
afterEach(() => { vi.restoreAllMocks(); delete process.env.MAINNET_RPC; });

const url = (q: Record<string, string>) => `http://localhost:3000/api/actions/protect?${new URLSearchParams(q)}`;
const get = (q: Record<string, string>, ip = '10.0.0.1') => handleProtect(new Request(url(q), { headers: { 'x-forwarded-for': ip } }), deps);
const post = (q: Record<string, string>, body: unknown, ip = '10.0.0.1', headers: Record<string, string> = {}) =>
  handleProtect(new Request(url(q), { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body) }), deps);
const q = (p: { key: PublicKey; lender: string }, cap = 'full') => ({ position: p.key.toBase58(), lender: p.lender, cap });
const message = async (r: Response) => { const j = await r.json(); expect(Object.keys(j)).toEqual(['message']); expect(typeof j.message).toBe('string'); return j.message as string; };

describe('a_action_non_owner: POST for someone else\'s position', () => {
  it('refuses a wallet that is not the Kamino obligation owner, before building anything', async () => {
    const r = await post(q(f.kamino), { account: f.stranger.publicKey.toBase58() });
    expect(r.status).toBe(403);
    expect(await message(r)).toMatch(/owner/i);
    expect(f.calls.build).toBe(0);
  });
  it('refuses a wallet that does not hold the Jupiter Lend position NFT', async () => {
    const r = await post(q(f.jupiter), { account: f.stranger.publicKey.toBase58() });
    expect(r.status).toBe(403);
    expect(await message(r)).toMatch(/NFT/);
    expect(f.calls.build).toBe(0);
  });
  it('refuses when nobody holds the position NFT', async () => {
    const r = await post(q(f.noHolder), { account: f.owner.publicKey.toBase58() });
    expect(r.status).toBe(403);
    expect(f.calls.build).toBe(0);
  });
  it('the owner gets a transaction whose only signer is the owner', async () => {
    const r = await post(q(f.kamino), { account: f.owner.publicKey.toBase58() });
    expect(r.status).toBe(200);
    const s = txShape((await r.json()).transaction);
    expect(s.payer).toBe(f.owner.publicKey.toBase58());
    expect(s.signers).toBe(1);
  });
});

describe('a_action_ineligible: a position Credence cannot cover', () => {
  it('POST refuses with the reason, nothing built', async () => {
    const r = await post(q(f.ineligible), { account: f.owner.publicKey.toBase58() });
    expect(r.status).toBe(422);
    expect(await message(r)).toMatch(/2 borrows/);
    expect(f.calls.build).toBe(0);
  });
  it('GET shows the Action disabled with the reason and no buy links', async () => {
    const r = await get(q(f.ineligible));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.disabled).toBe(true);
    expect(j.error.message).toMatch(/2 borrows/);
    expect(j.links).toBeUndefined();
  });
  it('a program refusal at simulation comes back as the decoded CoreError, status 422', async () => {
    f.chain.build = async () => { throw new Refusal('CoreError::AlreadyLiquidatable (6020): the position is already liquidatable'); };
    const r = await post(q(f.kamino), { account: f.owner.publicKey.toBase58() });
    expect(r.status).toBe(422);
    expect(await message(r)).toBe('CoreError::AlreadyLiquidatable (6020): the position is already liquidatable');
  });
  it('an unknown position is a 404, not a crash', async () => {
    const r = await post({ position: Keypair.generate().publicKey.toBase58(), lender: 'kamino' }, { account: f.owner.publicKey.toBase58() });
    expect(r.status).toBe(404);
    await message(r);
  });
});

describe('a_action_after_bell: buying after the bell', () => {
  it('POST refuses when no epoch is on sale (the bell has passed)', async () => {
    const r = await post(q(f.afterBell), { account: f.owner.publicKey.toBase58() });
    expect(r.status).toBe(409);
    expect(await message(r)).toMatch(/bell/);
    expect(f.calls.build + f.calls.quote).toBe(0);
  });
  it('POST refuses when the chain clock has reached the epoch\'s bell, even if the epoch is still listed', async () => {
    const r = await post(q(f.bellStale), { account: f.owner.publicKey.toBase58() });
    expect(r.status).toBe(409);
    expect(f.calls.build).toBe(0);
  });
  it('GET is disabled after the bell', async () => {
    const j = await (await get(q(f.afterBell))).json();
    expect(j.disabled).toBe(true);
    expect(j.error.message).toMatch(/bell/);
  });
});

describe('a_action_malformed: bad base58, oversized body, unknown lender', () => {
  const owner = () => ({ account: f.owner.publicKey.toBase58() });
  it.each([
    ['bad base58 (0, O, I, l are not base58)', { position: '0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl', lender: 'kamino' }],
    ['too short', { position: 'abc', lender: 'kamino' }],
    ['too long', { position: '1'.repeat(45), lender: 'kamino' }],
    ['a non-canonical encoding (leading 1s)', { position: '1111111111111111111111111111111111111111111', lender: 'kamino' }],
    ['unknown lender', { position: Keypair.generate().publicKey.toBase58(), lender: 'aave' }],
    ['missing lender', { position: Keypair.generate().publicKey.toBase58() }],
    ['missing position', { lender: 'kamino' }],
    ['script in the lender', { position: Keypair.generate().publicKey.toBase58(), lender: '<script>alert(1)</script>' }],
  ])('GET and POST refuse %s with 400 and never touch the chain', async (_n, query) => {
    for (const r of [await get(query as Record<string, string>), await post({ ...(query as Record<string, string>), cap: 'full' }, owner())]) {
      expect(r.status).toBe(400);
      await message(r);
    }
    expect(f.calls.load).toBe(0);
  });
  it('refuses an unknown max payout choice', async () => {
    const r = await post(q(f.kamino, 'all'), owner());
    expect(r.status).toBe(400);
    expect(f.calls.load).toBe(0);
  });
  it('refuses a repeated parameter', async () => {
    const u = `${url(q(f.kamino))}&lender=jupiter`;
    const r = await handleProtect(new Request(u, { headers: { 'x-forwarded-for': '10.0.0.1' } }), deps);
    expect(r.status).toBe(400);
  });
  it('refuses an oversized body by its declared length (413)', async () => {
    const r = await post(q(f.kamino), { account: f.owner.publicKey.toBase58(), pad: 'x'.repeat(10_000) });
    expect(r.status).toBe(413);
    expect(f.calls.load).toBe(0);
  });
  it('refuses an oversized body streamed without a length (413)', async () => {
    const big = new TextEncoder().encode(JSON.stringify({ account: f.owner.publicKey.toBase58(), pad: 'x'.repeat(100_000) }));
    const body = new ReadableStream({ start(c) { for (let i = 0; i < big.length; i += 1000) c.enqueue(big.subarray(i, i + 1000)); c.close(); } });
    const r = await handleProtect(new Request(url(q(f.kamino)), { method: 'POST', body, duplex: 'half', headers: { 'x-forwarded-for': '10.0.0.1' } } as RequestInit), deps);
    expect(r.status).toBe(413);
  });
  it('refuses a body that is not JSON, not an object, or has a bad account', async () => {
    for (const body of ['{not json', '[]', '"x"', JSON.stringify({}), JSON.stringify({ account: 'not-a-key' }), JSON.stringify({ account: 12 })]) {
      const r = await post(q(f.kamino), body);
      expect(r.status, body).toBe(400);
    }
    expect(f.calls.load).toBe(0);
  });
  it('refuses a body that is not application/json (415)', async () => {
    const r = await post(q(f.kamino), owner(), '10.0.0.1', { 'content-type': 'text/plain' });
    expect(r.status).toBe(415);
  });
  it('refuses an oversized URL (414)', async () => {
    const r = await get({ position: f.kamino.key.toBase58(), lender: 'kamino', x: 'y'.repeat(600) });
    expect(r.status).toBe(414);
  });
});

describe('a_action_no_secrets: an RPC error never leaks the URL, the key or a stack', () => {
  const leaks = (s: string) => {
    for (const bad of ['SEKRET', 'PATHKEY', 'helius', 'alchemy', 'http', 'api-key', 'node_modules', '    at ', '.ts:']) expect(s, bad).not.toContain(bad);
  };
  it('an RPC failure while loading (502)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    f.chain.failWith = new Error(`failed to get info about account: TypeError: fetch failed ${SECRET_RPC}\n    at Connection._rpcRequest (/app/node_modules/@solana/web3.js/lib/index.cjs.js:1:1)\n    at load (/app/src/lib/actions/fork-chain.ts:10:3)`);
    for (const r of [await get(q(f.kamino)), await post(q(f.kamino), { account: f.owner.publicKey.toBase58() })]) {
      expect(r.status).toBe(502);
      leaks(await r.text());
    }
    leaks(err.mock.calls.flat().map(String).join('\n'));
  });
  it('a refusal that quotes surfpool\'s datasource URL (path key) is scrubbed', async () => {
    f.chain.build = async () => { throw new Refusal(`Failed to fetch accounts from remote: error sending request for url (${PATH_RPC})`); };
    const r = await post(q(f.kamino), { account: f.owner.publicKey.toBase58() });
    expect(r.status).toBe(422);
    leaks(await r.text());
  });
  it('a hung fork times out (504) without detail', async () => {
    f.chain.hang = true;
    const t0 = Date.now();
    const r = await get(q(f.kamino));
    expect(r.status).toBe(504);
    expect(Date.now() - t0).toBeLessThan(2_000);
    leaks(await r.text());
  });
  it('the response never carries the MAINNET_RPC value, even on success (the icon is the only URL, on this host)', async () => {
    for (const r of [await get(q(f.kamino)), await post(q(f.kamino), { account: f.owner.publicKey.toBase58() })]) {
      const t = await r.text();
      for (const bad of ['SEKRET', 'helius', 'api-key']) expect(t).not.toContain(bad);
      expect([...t.matchAll(/https?:\/\/[^"/]+/g)].map((m) => m[0])).toEqual(r.status === 200 && t.includes('"icon"') ? ['http://localhost:3000'] : []);
    }
  });
});

describe('a_action_tx_shape: only the expected programs', () => {
  const allowed = { kamino: [ComputeBudgetProgram.programId, PROGRAM_ID, KLEND], jupiter: [ComputeBudgetProgram.programId, PROGRAM_ID, JL_VAULTS] };
  it.each(['kamino', 'multi', 'jupiter'] as const)('%s: compute budget first, one credence_core buy last, nothing else but the lender', async (k) => {
    const p = f[k];
    const r = await post(q(p), { account: f.owner.publicKey.toBase58() });
    expect(r.status).toBe(200);
    const s = txShape((await r.json()).transaction);
    const ok = allowed[p.lender].map((x) => x.toBase58());
    expect(s.programs.every((x) => ok.includes(x))).toBe(true);
    expect(s.programs.slice(0, 2)).toEqual([ComputeBudgetProgram.programId.toBase58(), ComputeBudgetProgram.programId.toBase58()]);
    expect(s.programs.at(-1)).toBe(PROGRAM_ID.toBase58());
    expect(s.buys).toBe(1);
    expect(s.programs.includes(KLEND.toBase58()) && s.programs.includes(JL_VAULTS.toBase58())).toBe(false);
    if (p.lender === 'kamino') expect(s.programs).toContain(KLEND.toBase58());
    else expect(s.programs).not.toContain(KLEND.toBase58());
  });
  it('a builder that slips Jupiter\'s program in with klend is caught before the response (500, no transaction)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    f.chain.mutate = async (tx) => {
      const t = VersionedTransaction.deserialize(Buffer.from(tx, 'base64'));
      const keys = t.message.staticAccountKeys;
      const ixs = t.message.compiledInstructions.map((ix) => new TransactionInstruction({ programId: keys[ix.programIdIndex], data: Buffer.from(ix.data),
        keys: ix.accountKeyIndexes.map((i) => ({ pubkey: keys[i], isSigner: t.message.isAccountSigner(i), isWritable: t.message.isAccountWritable(i) })) }));
      const extra = new TransactionInstruction({ programId: JL_VAULTS, keys: [], data: Buffer.alloc(8) });
      return encodeTx(assembleTx(f.owner.publicKey, t.message.recentBlockhash, [extra, ...ixs.slice(2)], 200_000));
    };
    const r = await post(q(f.kamino), { account: f.owner.publicKey.toBase58() });
    expect(r.status).toBe(500);
    const body = await r.text();
    expect(body).not.toContain('transaction"');
    expect(err).toHaveBeenCalled();
  });
  it('shapeProblem: an extra signer, a foreign program, a missing compute budget', async () => {
    const r = await post(q(f.kamino), { account: f.owner.publicKey.toBase58() });
    const tx = (await r.json()).transaction as string;
    expect(shapeProblem(tx, 'kamino', f.owner.publicKey)).toBeNull();
    expect(shapeProblem(tx, 'jupiter', f.owner.publicKey)).toMatch(/unexpected program/);
    expect(shapeProblem(tx, 'kamino', f.stranger.publicKey)).toMatch(/signer/);
    const t = VersionedTransaction.deserialize(Buffer.from(tx, 'base64'));
    const noBudget = encodeTx(assembleTx(f.owner.publicKey, t.message.recentBlockhash, [], 1));
    expect(shapeProblem(noBudget, 'kamino', f.owner.publicKey)).toMatch(/buy/);
  });
});

describe('a_action_cors_headers: exact headers on GET, POST, OPTIONS and errors', () => {
  const expectHeaders = (r: Response) => {
    for (const [k, v] of Object.entries(ACTIONS_CORS_HEADERS)) expect(r.headers.get(k), k).toBe(v);
    expect(r.headers.get('X-Action-Version')).toBe('2.4');
    expect(r.headers.get('X-Blockchain-Ids')).toBe(FORK_CHAIN_ID);
    expect(PUBLIC_CLUSTERS).not.toContain(r.headers.get('X-Blockchain-Ids'));
    expect(r.headers.get('X-Blockchain-Ids')).not.toMatch(/5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/);
  };
  it('GET', async () => { const r = await get(q(f.kamino)); expect(r.status).toBe(200); expectHeaders(r); });
  it('POST', async () => { const r = await post(q(f.kamino), { account: f.owner.publicKey.toBase58() }); expect(r.status).toBe(200); expectHeaders(r); });
  it('OPTIONS (preflight), no body', async () => {
    const r = await handleProtect(new Request(url(q(f.kamino)), { method: 'OPTIONS', headers: { origin: 'https://dial.to', 'access-control-request-method': 'POST' } }), deps);
    expect([200, 204]).toContain(r.status);
    expectHeaders(r);
    expect(await r.text()).toBe('');
  });
  it('errors (400, 403, 404, 429, 502) carry the same headers', async () => {
    expectHeaders(await get({ lender: 'kamino' }));
    expectHeaders(await post(q(f.kamino), { account: f.stranger.publicKey.toBase58() }));
    expectHeaders(await get({ position: Keypair.generate().publicKey.toBase58(), lender: 'kamino' }));
    deps.limiter = new RateLimiter({ burst: 1, perSecond: 0.001, globalBurst: 100, globalPerSecond: 1 });
    await get(q(f.kamino), '9.9.9.9');
    expectHeaders(await get(q(f.kamino), '9.9.9.9'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    f.chain.failWith = new Error('boom');
    expectHeaders(await get(q(f.kamino), '8.8.8.8'));
  });
  it('other methods are refused (405) with the headers', async () => {
    const r = await handleProtect(new Request(url(q(f.kamino)), { method: 'DELETE' }), deps);
    expect(r.status).toBe(405);
    expectHeaders(r);
  });
});

describe('a_action_rate_limit: burst requests are throttled', () => {
  // Per-address buckets need an address a client cannot choose: behind a proxy that sets X-Forwarded-For (TRUST_PROXY=1).
  beforeEach(() => { deps.limiter = new RateLimiter({ burst: 5, perSecond: 0.5, globalBurst: 12, globalPerSecond: 2 }); process.env.TRUST_PROXY = '1'; });
  afterEach(() => { delete process.env.TRUST_PROXY; });
  it('a burst from one address gets 429 with Retry-After after its allowance, before any chain call', async () => {
    const rs = [];
    for (let i = 0; i < 10; i++) rs.push(await get(q(f.kamino), '1.1.1.1'));
    expect(rs.slice(0, 5).every((r) => r.status === 200)).toBe(true);
    const limited = rs.slice(5);
    expect(limited.every((r) => r.status === 429)).toBe(true);
    expect(Number(limited[0].headers.get('Retry-After'))).toBeGreaterThan(0);
    await message(limited[0]);
    expect(f.calls.load).toBe(5);
  });
  it('another address is not throttled by the first one\'s burst', async () => {
    for (let i = 0; i < 6; i++) await get(q(f.kamino), '1.1.1.1');
    expect((await get(q(f.kamino), '2.2.2.2')).status).toBe(200);
  });
  it('rotating addresses is bounded by the global bucket', async () => {
    const rs = [];
    for (let i = 0; i < 20; i++) rs.push(await get(q(f.kamino), `3.3.3.${i}`));
    expect(rs.filter((r) => r.status === 200).length).toBe(12);
    expect(rs.filter((r) => r.status === 429).length).toBe(8);
  });
  it('A-110: without a trusted proxy, X-Forwarded-For is the client\'s own text: rotating it does not give fresh buckets', async () => {
    delete process.env.TRUST_PROXY;
    const rs = [];
    for (let i = 0; i < 8; i++) rs.push(await get(q(f.kamino), `6.6.6.${i}`));
    expect(rs.filter((r) => r.status === 429).length).toBe(3);
    // … and so one client rotating addresses cannot drain the global bucket for everyone else either.
    expect(f.calls.load).toBe(5);
  });
  it('POST is throttled too', async () => {
    const rs = [];
    for (let i = 0; i < 7; i++) rs.push(await post(q(f.kamino), { account: f.owner.publicKey.toBase58() }, '5.5.5.5'));
    expect(rs.filter((r) => r.status === 429).length).toBe(2);
  });
});
