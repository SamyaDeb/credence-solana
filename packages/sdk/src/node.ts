// Node-only helpers (a separate entry, `@credence/sdk/node`, so a browser bundle never sees node:child_process).
import { spawn } from 'node:child_process';
import type { BookQuote } from './quote';

/**
 * (c) Runs `examples/book_quote.rs` (the program's leg pricing + `risk-core::book_premium`) on `request` (C1's position
 * format, `{"positions":[…],"utilWad":"0","targetWad":"…"}`). Needs the repo checked out at `root` and a Rust toolchain;
 * build once with `cargo build -p credence-core --example book_quote`. Server/dev use; browsers use `bookQuoteHttp`.
 */
export function bookQuoteLocal(root: string, request: unknown, opts: { bin?: string } = {}): Promise<BookQuote> {
  const bin = opts.bin ?? `${root}/target/debug/examples/book_quote`;
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ['--root', root], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`book_quote exited ${code}: ${err.split('\n')[0]}`));
      try { resolve(JSON.parse(out) as BookQuote); } catch (e) { reject(e); }
    });
    p.stdin.end(JSON.stringify(request));
  });
}
