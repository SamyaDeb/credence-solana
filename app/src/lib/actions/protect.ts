// "Protect my position": a Solana Action (spec v2.4) that sells this weekend's gap protection on a Kamino or Jupiter
// Lend position, on the local mainnet fork.
//   GET  ?position=<pubkey>&lender=kamino|jupiter          the Action: the live quote (a simulated program instruction),
//                                                          the chance it pays anything, linked actions per max payout
//   POST ?position=…&lender=…&cap=full|need8|need12 {account}  an unsigned transaction: the lender's refreshes + buy
// The chain is behind `ProtectChain` (lib/actions/fork-chain.ts on the fork; a fake in the tests), so every check
// here is tested without a fork. Nothing is signed on the server.
import type { ActionGetResponse, ActionPostResponse, LinkedAction } from '@solana/actions-spec';
import type { PublicKey } from '@solana/web3.js';
import { et, usdc } from '@/lib/format';
import { oddsPct } from '@/lib/odds';
import { payoutAtGap } from '@/lib/payout';
import { InputError, type RateLimiter, TimeoutError, checkUrl, clientIp, oneOf, param, parsePubkey, readJson, withTimeout } from './guard';
import { type Lender, shapeProblem } from './shape';
import { DISCLOSURE, actionError, actionJson, preflight, scrub } from './spec';

export type { Lender };
export const LENDERS: readonly Lender[] = ['kamino', 'jupiter'];
export type Cap = 'full' | 'need8' | 'need12';
export const CAPS: readonly Cap[] = ['full', 'need8', 'need12'];

export type Position = {
  lender: Lender;
  kind: 'kamino' | 'kamino-multi' | 'jupiter';
  key: PublicKey;
  /** Kamino: the obligation's owner. Jupiter Lend: the holder of the position NFT (null when none holds it). */
  owner: PublicKey | null;
  /** The covered xStock(s), e.g. "SPYx" or "SPYx + QQQx". */
  ticker: string;
  /** Why credence_core would refuse this position (the program's rules, mirrored from the app's checks), or null. */
  why: string | null;
  /** The epoch on sale now for this position, or null with `saleNote` saying why. */
  sale: { epoch: string; closureId: number; closureType: number; bell: number } | null;
  saleNote: string | null;
  /** Chain clock (the fork's, after any time travel). */
  now: number;
  /** C′ and D in USDC base units, as buy_cover will snapshot them; null when they could not be simulated (snapNote). */
  snap: { coveredValue: bigint; debt: bigint } | null;
  snapNote: string | null;
  /** Share of the asset's WEEKEND scenario set that pays anything (lib/odds `modelPays`); null for multi-collateral. */
  odds: { count: number; n: number; p: number } | null;
};

export type QuoteResult = { premium: bigint; cu: number };

export interface ProtectChain {
  load(lender: Lender, position: PublicKey): Promise<Position | null>;
  /** The premium the program charges for `maxPayout`: quote_cover (Kamino, one xStock) or the buy itself (multi,
   * Jupiter), simulated on the fork. Throws `Refusal` with the decoded CoreError when the program refuses. */
  quote(p: Position, maxPayout: bigint): Promise<QuoteResult>;
  /** The unsigned transaction (base64), simulated first: a failing simulation throws `Refusal` (decoded CoreError). */
  build(p: Position, account: PublicKey, maxPayout: bigint, maxPremium: bigint): Promise<{ transaction: string; cu: number }>;
}

/** A refusal the user should read: spec-shaped `{ message }` with this status. */
export class Refusal extends Error {
  constructor(message: string, readonly status = 422) { super(message); }
}

export type ProtectDeps = {
  chain: () => ProtectChain;
  limiter: RateLimiter;
  timeoutMs: number;
  network: 'fork' | 'mainnet';
  /** Absolute origin for the icon (ACTION_BASE_URL, else the request's). */
  baseUrl?: string;
};

const LENDER_NAME: Record<Lender, string> = { kamino: 'Kamino', jupiter: 'Jupiter Lend' };
const CAP_LABEL: Record<Cap, string> = { full: 'Full debt', need8: '−8% need', need12: '−12% need' };
const CAP_GAP: Record<Exclude<Cap, 'full'>, number> = { need8: -800, need12: -1200 };
export const MAX_BODY = 1024;
const API = '/api/actions/protect';
const MAINNET_NOTE = 'This public site is read-only: the Action builds transactions for the local mainnet fork only (scripts/demo-app.sh).';

/** The max payout of each choice: the full debt, or what a −8% / −12% open would need repaid (the program's payout
 * rule, `realized_payout`, golden-tested in lib/payout.ts), never more than the debt. 0 = that choice pays nothing. */
export function capFor(cap: Cap, snap: { coveredValue: bigint; debt: bigint }): bigint {
  if (cap === 'full') return snap.debt;
  return payoutAtGap(snap.coveredValue, snap.debt, snap.debt, CAP_GAP[cap]);
}

/** max_premium = the simulated quote + 2% (at least 0.05 USDC): room for the vault's utilisation to move between the
 * quote and the signature, never more. */
export const withSlippage = (premium: bigint) => premium + (premium / 50n > 50_000n ? premium / 50n : 50_000n);

/** The caps offered. Multi-collateral: the full debt only (its −8% need is the program's per-leg multi rule, which the
 * app does not mirror in JS). */
const choices = (p: Position): readonly Cap[] => (p.kind === 'kamino-multi' ? ['full'] : CAPS);

const usd = (base: bigint) => `$${usdc(base)}`;
const owns = (p: Position) => (p.lender === 'kamino' ? 'the obligation\'s owner' : 'the holder of the position NFT');

export async function handleProtect(req: Request, deps: ProtectDeps): Promise<Response> {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'GET' && req.method !== 'POST') return actionError('method not allowed', 405, { Allow: 'GET, POST, OPTIONS' });
  const wait = deps.limiter.take(clientIp(req));
  if (wait !== null) return actionError('too many requests; try again shortly', 429, { 'Retry-After': String(wait) });
  try {
    const url = checkUrl(req);
    const position = parsePubkey(param(url, 'position'), 'position');
    const lender = oneOf(param(url, 'lender'), LENDERS, 'lender');
    if (req.method === 'GET') {
      if (deps.network === 'mainnet') return actionJson(disabled(deps, req, `Protect my position (${LENDER_NAME[lender]}, fork)`, MAINNET_NOTE));
      return await withTimeout(getAction(req, deps, position, lender), deps.timeoutMs, 'the fork');
    }
    const cap = oneOf(param(url, 'cap') ?? 'full', CAPS, 'cap');
    const body = await readJson(req, MAX_BODY);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('body: {"account": "<base58 public key>"}');
    const account = parsePubkey((body as Record<string, unknown>).account, 'account');
    if (deps.network === 'mainnet') throw new Refusal(MAINNET_NOTE, 403);
    return await withTimeout(postAction(deps, position, lender, cap, account), deps.timeoutMs, 'the fork');
  } catch (e) {
    if (e instanceof InputError || e instanceof Refusal) return actionError(e.message, e.status);
    if (e instanceof TimeoutError) return actionError('the fork did not answer in time; try again', 504);
    console.error('[actions/protect]', scrub((e as Error)?.message ?? String(e)));
    return actionError('the fork RPC failed; try again', 502);
  }
}

async function load(deps: ProtectDeps, lender: Lender, position: PublicKey): Promise<Position> {
  const p = await deps.chain().load(lender, position);
  if (!p) throw new Refusal(lender === 'kamino' ? 'no Kamino xStocks obligation at this address on the fork' : 'no Jupiter Lend position at this address on the fork', 404);
  return p;
}

/** Why sales are closed for this position now, or null (INV-3: no policy at or after the bell). */
function closed(p: Position): string | null {
  if (!p.sale) return p.saleNote ?? 'no gap protection on sale for this position now';
  if (p.now >= p.sale.bell) return `sales closed at the bell (${et(p.sale.bell)})`;
  return null;
}

function disabled(deps: ProtectDeps, req: Request, title: string, why: string): ActionGetResponse {
  return { type: 'action', icon: icon(deps, req), title, description: `${why} ${DISCLOSURE}`, label: 'Not available', disabled: true, error: { message: why } };
}

function icon(deps: ProtectDeps, req: Request) {
  return `${deps.baseUrl ?? new URL(req.url).origin}/landing/webclip.png`;
}

async function getAction(req: Request, deps: ProtectDeps, position: PublicKey, lender: Lender): Promise<Response> {
  const p = await load(deps, lender, position);
  const title = `Protect my position: ${p.ticker.replace(/\.J$/, '')} on ${LENDER_NAME[lender]} (fork)`;
  const no = p.why ? `Not eligible: ${p.why}.` : closed(p);
  if (no) return actionJson(disabled(deps, req, title, no));

  const href = (cap: Cap) => `${API}?${new URLSearchParams({ position: position.toBase58(), lender, cap })}`;
  const parts: string[] = [];
  if (p.snap) {
    const ratio = Number(p.snap.debt) / Number(p.snap.coveredValue);
    parts.push(`Debt ${usd(p.snap.debt)} against C′ ${usd(p.snap.coveredValue)} (D/C′ ${ratio.toFixed(4)}).`);
  }
  parts.push(`If Monday opens with a gap that leaves the position below its liquidation threshold, gap protection repays what it needs into the position after the open, up to the cap you choose.${p.kind === 'kamino-multi' ? ' Multi-collateral: every covered xStock leg is priced together.' : ''}`);
  if (p.odds) parts.push(`Chance it pays anything this weekend: ${oddsPct(p.odds.p)} (model: ${p.odds.count} of ${p.odds.n.toLocaleString('en-US')} weekend scenarios).`);
  parts.push(`Sales close at the bell, ${et(p.sale!.bell)}. Quotes are the program's own, simulated on the fork.`);
  parts.push(DISCLOSURE);

  let label: string;
  let actions: LinkedAction[];
  if (!p.snap) {
    label = `Gap protection: quote at signing (${p.snapNote ?? 'not simulated'})`;
    actions = [{ type: 'transaction', href: href('full'), label: `${CAP_LABEL.full}: quote at signing` }];
  } else {
    const snap = p.snap;
    const caps = choices(p).map((c) => ({ c, cap: capFor(c, snap) })).filter((x) => x.cap > 0n);
    const quotes = await Promise.allSettled(caps.map((x) => deps.chain().quote(p, x.cap)));
    actions = caps.map((x, i) => {
      const qr = quotes[i];
      const prem = qr.status === 'fulfilled' ? `${usdc(qr.value.premium)} USDC` : 'quote at signing';
      return { type: 'transaction', href: href(x.c), label: `${CAP_LABEL[x.c]}: cap ${usd(x.cap)} · ${prem}` };
    });
    const first = quotes[0];
    if (first?.status === 'rejected' && first.reason instanceof Refusal) return actionJson(disabled(deps, req, title, first.reason.message));
    label = first?.status === 'fulfilled' ? `Gap protection: ${usdc(first.value.premium)} USDC for a ${usd(caps[0].cap)} cap (fork)` : 'Gap protection: quote at signing (fork)';
  }
  const body: ActionGetResponse = { type: 'action', icon: icon(deps, req), title, description: parts.join(' '), label, links: { actions } };
  return actionJson(body);
}

async function postAction(deps: ProtectDeps, position: PublicKey, lender: Lender, cap: Cap, account: PublicKey): Promise<Response> {
  const p = await load(deps, lender, position);
  if (!p.owner || !p.owner.equals(account)) throw new Refusal(`this wallet is not ${owns(p)}: only the owner can buy gap protection on a position${lender === 'jupiter' ? ' (Jupiter Lend: the position NFT holder)' : ''}`, 403);
  if (p.why) throw new Refusal(`not eligible: ${p.why}`, 422);
  const shut = closed(p);
  if (shut) throw new Refusal(shut, 409);
  const chain = deps.chain();
  // The snapshot is re-read at signing time; for multi-collateral and Jupiter it comes from simulating the buy itself.
  if (!p.snap) throw new Refusal(`no quote: ${p.snapNote ?? 'the position could not be simulated'}`, 422);
  if (!choices(p).includes(cap)) throw new Refusal('multi-collateral positions are offered the full-debt cap only', 422);
  const maxPayout = capFor(cap, p.snap);
  if (maxPayout <= 0n) throw new Refusal(`a ${CAP_LABEL[cap]} cap pays nothing for this position (it would need no repayment); choose the full debt`, 422);
  const q = await chain.quote(p, maxPayout);
  const maxPremium = withSlippage(q.premium);
  const built = await chain.build(p, account, maxPayout, maxPremium);
  const bad = shapeProblem(built.transaction, lender, account);
  if (bad) {
    console.error('[actions/protect] refused to return a transaction:', bad);
    return actionError('the transaction failed its safety check; nothing was returned', 500);
  }
  const body: ActionPostResponse = {
    type: 'transaction',
    transaction: built.transaction,
    message: `Gap protection on the fork (not live): ${p.ticker.replace(/\.J$/, '')} on ${LENDER_NAME[lender]}, cap ${usd(maxPayout)}, premium ${usdc(q.premium)} USDC (at most ${usdc(maxPremium)}), ${built.cu.toLocaleString('en-US')} CU simulated. Not insurance.`,
  };
  return actionJson(body);
}
