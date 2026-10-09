// Solana Actions spec v2.4 conformance of the Protect my position Action: GET metadata, linked actions, POST
// transaction response, errors, actions.json, and the wording rules (fork, not live, not insurance).
import type { ActionGetResponse, ActionPostResponse, ActionsJson, LinkedAction } from '@solana/actions-spec';
import { VersionedTransaction } from '@solana/web3.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { RateLimiter } from '@/lib/actions/guard';
import { type ProtectDeps, Refusal, handleProtect } from '@/lib/actions/protect';
import { DISCLOSURE } from '@/lib/actions/spec';
import { GET as actionsJson, OPTIONS as actionsJsonOptions } from '@/app/actions.json/route';
import { QUOTE, fixture } from './fixtures/action-chain';

let f: ReturnType<typeof fixture>;
let deps: ProtectDeps;
beforeEach(() => {
  f = fixture();
  deps = { chain: () => f.chain, limiter: new RateLimiter({ burst: 100, perSecond: 100, globalBurst: 100, globalPerSecond: 100 }), timeoutMs: 1000, network: 'fork' };
});
const base = 'http://localhost:3000/api/actions/protect';
const get = (p: { key: { toBase58(): string }; lender: string }) => handleProtect(new Request(`${base}?position=${p.key.toBase58()}&lender=${p.lender}`), deps);

describe('GET: ActionGetResponse', () => {
  it('has the required fields, an absolute icon and the disclosure', async () => {
    const r = await get(f.kamino);
    expect(r.status).toBe(200);
    const j = (await r.json()) as ActionGetResponse;
    expect(j.type).toBe('action');
    expect(new URL(j.icon).protocol).toMatch(/^https?:$/);
    for (const k of ['title', 'description', 'label'] as const) expect(typeof j[k]).toBe('string');
    expect(j.title).toMatch(/fork/i);
    expect(j.description).toContain(DISCLOSURE);
    expect(j.disabled ?? false).toBe(false);
  });
  it('the label carries the live quote (the chain\'s simulated premium) and the description the chance it pays anything', async () => {
    const j = (await (await get(f.kamino)).json()) as ActionGetResponse;
    expect(j.label).toContain('8.61 USDC');
    expect(j.description).toMatch(/chance it pays anything this weekend: 0\.63%/i);
    expect(j.description).toMatch(/19 of 3,000/);
    expect(QUOTE).toBe(8_612_345n);
  });
  it('linked actions: full, −8% need, −12% need, each a transaction to this route with its cap', async () => {
    const j = (await (await get(f.kamino)).json()) as ActionGetResponse;
    const links = j.links!.actions as LinkedAction[];
    expect(links.map((l) => new URL(l.href, base).searchParams.get('cap'))).toEqual(['full', 'need8', 'need12']);
    for (const l of links) {
      expect(l.type).toBe('transaction');
      expect(l.href.startsWith('/api/actions/protect?')).toBe(true);
      const u = new URL(l.href, base);
      expect(u.searchParams.get('position')).toBe(f.kamino.key.toBase58());
      expect(u.searchParams.get('lender')).toBe('kamino');
      expect(l.label).toMatch(/cap \$[\d,]+\.\d\d/);
      expect(l.parameters).toBeUndefined();
    }
    expect(links[0].label).toMatch(/^Full debt/);
    expect(links[1].label).toMatch(/^−8% need/);
    expect(links[2].label).toMatch(/^−12% need/);
  });
  it('a −8% need of zero drops that link (a far-from-threshold position)', async () => {
    f.kamino.snap = { coveredValue: 100_000_000_000n, debt: 50_000_000_000n };
    const j = (await (await get(f.kamino)).json()) as ActionGetResponse;
    expect(j.links!.actions.map((l) => new URL(l.href, base).searchParams.get('cap'))).toEqual(['full']);
  });
  it('Jupiter Lend and multi-collateral positions are described by lender', async () => {
    const jl = (await (await get(f.jupiter)).json()) as ActionGetResponse;
    expect(jl.title).toMatch(/Jupiter Lend/);
    const m = (await (await get(f.multi)).json()) as ActionGetResponse;
    expect(m.title).toMatch(/SPYx \+ QQQx/);
    expect(m.description).toMatch(/multi-collateral/i);
  });
  it('multi-collateral: the full-debt cap only (POST with a need cap is refused)', async () => {
    const m = (await (await get(f.multi)).json()) as ActionGetResponse;
    expect(m.links!.actions.map((l) => new URL(l.href, base).searchParams.get('cap'))).toEqual(['full']);
    const r = await handleProtect(new Request(`${base}?position=${f.multi.key.toBase58()}&lender=kamino&cap=need8`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: f.owner.publicKey.toBase58() }) }), deps);
    expect(r.status).toBe(422);
  });
  it('a quote that cannot be simulated keeps the Action usable and says so', async () => {
    f.kamino.snap = null;
    f.kamino.snapNote = 'the holder needs USDC for the simulation';
    const j = (await (await get(f.kamino)).json()) as ActionGetResponse;
    expect(j.label).toMatch(/quote at signing/i);
    expect(j.links!.actions.map((l) => new URL(l.href, base).searchParams.get('cap'))).toEqual(['full']);
  });
});

describe('POST: TransactionResponse', () => {
  it('returns {type: "transaction", transaction, message}; the transaction deserializes and is unsigned', async () => {
    const r = await handleProtect(new Request(`${base}?position=${f.kamino.key.toBase58()}&lender=kamino&cap=need8`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: f.owner.publicKey.toBase58(), type: 'transaction' }) }), deps);
    expect(r.status).toBe(200);
    const j = (await r.json()) as ActionPostResponse & { transaction: string };
    expect(j.type).toBe('transaction');
    expect(j.message).toMatch(/fork/);
    const tx = VersionedTransaction.deserialize(Buffer.from(j.transaction, 'base64'));
    expect(tx.signatures).toHaveLength(1);
    expect(tx.signatures[0].every((b) => b === 0)).toBe(true);
  });
  it('max_premium = quote + slippage, and the cap is the chosen need', async () => {
    let seen: { maxPayout: bigint; maxPremium: bigint } | null = null;
    const build = f.chain.build;
    f.chain.build = async (p, a, maxPayout, maxPremium) => { seen = { maxPayout, maxPremium }; return build(p, a, maxPayout, maxPremium); };
    for (const cap of ['full', 'need8', 'need12']) {
      await handleProtect(new Request(`${base}?position=${f.kamino.key.toBase58()}&lender=kamino&cap=${cap}`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: f.owner.publicKey.toBase58() }) }), deps);
      expect(seen!.maxPremium).toBe(QUOTE + 172_246n); // 2% of the quote (more than 0.05 USDC)
      if (cap === 'full') expect(seen!.maxPayout).toBe(50_000_000_000n);
      else expect(seen!.maxPayout).toBeLessThan(50_000_000_000n);
    }
  });
  it('a cap whose need is zero is refused rather than sending max_payout 0', async () => {
    f.kamino.snap = { coveredValue: 100_000_000_000n, debt: 50_000_000_000n };
    const r = await handleProtect(new Request(`${base}?position=${f.kamino.key.toBase58()}&lender=kamino&cap=need8`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: f.owner.publicKey.toBase58() }) }), deps);
    expect(r.status).toBe(422);
    expect(f.calls.build).toBe(0);
  });
});

describe('wording and the public read-only mode', () => {
  it('never says insurance except "not insurance"; says gap protection and fork', async () => {
    for (const p of [f.kamino, f.jupiter, f.multi]) {
      const text = JSON.stringify(await (await get(p)).json());
      expect(text.replace(/not insurance/g, '')).not.toMatch(/insur/i);
      expect(text).toMatch(/gap protection/);
      expect(text).toMatch(/fork/);
    }
  });
  it('mainnet mode: GET is disabled with the fork note, POST refuses (403), no chain call', async () => {
    deps.network = 'mainnet';
    const g = (await (await get(f.kamino)).json()) as ActionGetResponse;
    expect(g.disabled).toBe(true);
    expect(g.error!.message).toMatch(/fork/);
    const r = await handleProtect(new Request(`${base}?position=${f.kamino.key.toBase58()}&lender=kamino&cap=full`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: f.owner.publicKey.toBase58() }) }), deps);
    expect(r.status).toBe(403);
    expect(f.calls.load).toBe(0);
  });
});

describe('actions.json', () => {
  it('maps the in-app page and the API path, with the Action headers', async () => {
    const r = await actionsJson();
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const j = (await r.json()) as ActionsJson;
    expect(j.rules).toEqual(expect.arrayContaining([
      { pathPattern: '/app/protect', apiPath: '/api/actions/protect' },
      { pathPattern: '/api/actions/**', apiPath: '/api/actions/**' },
    ]));
    expect((await actionsJsonOptions()).headers.get('Access-Control-Allow-Methods')).toContain('OPTIONS');
  });
});

describe('A-116: one refused cap does not disable the others', () => {
  it('the full-debt cap over capacity: the −8% and −12% caps are still offered', async () => {
    const quote = f.chain.quote;
    f.chain.quote = async (p, cap) => { if (cap === 50_000_000_000n) throw new Refusal('CoreError::CapacityExceeded (6005): capacity exceeded'); return quote(p, cap); };
    const j = (await (await get(f.kamino)).json()) as ActionGetResponse;
    expect(j.disabled ?? false).toBe(false);
    expect(j.links!.actions.map((l) => new URL(l.href, base).searchParams.get('cap'))).toEqual(['need8', 'need12']);
    expect(j.label).toMatch(/^Gap protection: 8\.61 USDC for a \$2,083\.33 cap/);
  });
  it('every cap refused: disabled with the program\'s reason', async () => {
    f.chain.quote = async () => { throw new Refusal('CoreError::CapacityExceeded (6005): capacity exceeded'); };
    const j = (await (await get(f.kamino)).json()) as ActionGetResponse;
    expect(j.disabled).toBe(true);
    expect(j.error!.message).toMatch(/CapacityExceeded/);
  });
});
