// POST {ids, target?, utilWad?}: the curator book quote for C1's scanned positions `ids` (data/unlock rows): each leg's
// standalone premium (what buy_cover* charges) and the book's one premium, from the program's own pricing
// (`examples/book_quote.rs`: pricing::leg_quote_* + risk-core::book_premium). With `target` ("0.85" / "0.9") every
// position is priced at the debt it would carry at that D/C′ (the extra credit cover would allow, as C1). Nothing here
// prices: the route only selects rows and runs the helper. Read-only; no RPC and no key.
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { IS_MAINNET } from '@/lib/network';
import { ForbiddenError, ROOT, fail, json, latest, readJson } from '@/lib/server/fork';

export const dynamic = 'force-dynamic';
const MAX_LEGS = 3000;
let cache: { key: string; doc: any } | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any

function helper(): string {
  for (const p of [process.env.BOOK_QUOTE_BIN, 'target/release/examples/book_quote', 'target/debug/examples/book_quote']) {
    if (p && existsSync(join(/* turbopackIgnore: true */ ROOT, p))) return join(/* turbopackIgnore: true */ ROOT, p);
  }
  throw new Error('book_quote helper not built: cargo build -p credence-core --example book_quote');
}

function run(bin: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['--root', ROOT], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' } as unknown as NodeJS.ProcessEnv });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error((() => { try { return JSON.parse(out).error; } catch { return err || `exit ${code}`; } })()))));
    child.stdin.end(input);
  });
}

export async function POST(req: Request) {
  try {
    // The curator's book quote spawns the pricing helper: a fork-demo feature, never run on the public host.
    if (IS_MAINNET) throw new ForbiddenError('book quotes run on the fork demo; this public site is read-only');
    const { ids, target, utilWad } = (await req.json()) as { ids: string[]; target?: string | null; utilWad?: string };
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_LEGS || ids.some((x) => typeof x !== 'string')) throw new Error(`ids: 1–${MAX_LEGS} position ids`);
    if (target != null && !['0.85', '0.9', '0.95'].includes(target)) throw new Error('target: "0.85", "0.9" or "0.95"');
    if (utilWad != null && !/^\d{1,19}$/.test(utilWad)) throw new Error('utilWad: a WAD integer');
    const f = latest('data/unlock', /^unlock-\d{8}\.json$/);
    if (!f) return json({ error: 'no unlock analysis yet (scripts/src/unlock.ts)' }, 404);
    const key = `${f}:${statSync(join(/* turbopackIgnore: true */ ROOT, f)).mtimeMs}`;
    if (cache?.key !== key) cache = { key, doc: readJson(f) };
    const byId = new Map<string, any>((cache.doc.positions ?? []).map((p: any) => [p.id, p])); // eslint-disable-line @typescript-eslint/no-explicit-any
    const rows = ids.map((id) => byId.get(id)).filter(Boolean);
    const positions = rows.map((p) => ({ id: p.id, legs: p.legs, stable: p.stable, debt: p.debt, multi: p.path === 'multi' }));
    const targetWad = target ? (BigInt(Math.round(Number(target) * 1e6)) * 10n ** 12n).toString() : undefined;
    const out = JSON.parse(await run(helper(), JSON.stringify({ positions, basisWad: cache.doc.parameters.basisWad, utilWad: utilWad ?? '0', targetWad })));
    return json({ file: f, target: target ?? null, missing: ids.length - rows.length, caveat: cache.doc.caveat, ...out });
  } catch (e) {
    return fail(e, 400);
  }
}
