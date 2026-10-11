// Shadow results CLI (W6): reads a COPY of the shadow folder, writes results.json and results.md next to it.
// Read-only toward mainnet: no RPC, no signer; the only child process is the program's pricing helper (`shadow_quote`).
// Usage: cp -R ~/Downloads/credence-shadow/data/shadow/20261009 data/shadow/ && pnpm -C scripts tsx src/shadow-results.ts 20261009
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { type CapFn, markdown, results } from './lib/shadow-results-model.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const closure = process.argv[2] ?? '20261009';
const dir = join(ROOT, 'data/shadow', closure);
const jsonl = (f: string) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const json = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8'));

/** The program's pricing helper, one request at a time. */
export function quoteCap(bin = process.env.SHADOW_QUOTE ?? join(ROOT, 'target/release/examples/shadow_quote')): CapFn {
  return async (items) => {
    const proc = spawn(bin, ['--root', ROOT], { stdio: ['pipe', 'pipe', 'inherit'] });
    const failed = new Promise<never>((_, rej) => {
      proc.on('error', (e) => rej(new Error(`shadow_quote could not start (${(e as Error).message}); build it: cargo build -p credence-core --example shadow_quote --release`)));
      proc.on('exit', (code) => rej(new Error(`shadow_quote exited ${code} before replying`)));
    });
    failed.catch(() => {}); // the race below reports it
    const lines = createInterface({ input: proc.stdout })[Symbol.asyncIterator]();
    const next = async () => (await Promise.race([lines.next(), failed])).value as string;
    try {
      const ready = JSON.parse(await next());
      if (!ready.ready) throw new Error('shadow_quote: no ready line');
      const w = '500000000000000000';
      proc.stdin.write(JSON.stringify({ op: 'shield_capped', alphaWad: w, bufferWad: '20000000000000000', healthWad: '0', items }) + '\n');
      const r = JSON.parse(await next());
      if (r.error) throw new Error(`shield_capped: ${r.error}`);
      return r.items;
    } finally {
      proc.removeAllListeners('exit');
      proc.kill();
    }
  };
}

if (process.argv[1]?.endsWith('shadow-results.ts')) {
  const r = await results({ meta: json('meta.json'), summary: json('summary.json'), state: json('state.json'), events: jsonl('events.jsonl'), prices: jsonl('prices.jsonl'), book: jsonl('book.jsonl') }, quoteCap());
  writeFileSync(join(dir, 'results.json'), JSON.stringify(r, null, 2) + '\n');
  writeFileSync(join(dir, 'results.md'), markdown(r));
  console.log(r.headline);
}
