// Read the Gap Oracle feeds and say which ones a lender may use right now.
//   RPC_URL=http://127.0.0.1:8899 pnpm tsx examples/read-feed.ts          (a fork running scripts/demo-app.sh)
import { Connection } from '@solana/web3.js';
import { checkProgram, chainNow, feedProblems, program, readFeeds, wadPct } from '@credence/sdk';

const conn = new Connection(process.env.RPC_URL ?? 'http://127.0.0.1:8899', 'confirmed');
console.log('program check:', (await checkProgram(conn)).verified); // refuses a program whose IDL differs from this SDK's
const now = await chainNow(conn); // the chain's clock (a fork moves it), never the machine's
for (const f of await readFeeds(program(conn))) {
  const why = feedProblems(f, now, 3600);
  console.log(
    f.ticker.padEnd(8), f.lender.padEnd(7), `P(gap<-8%)=${wadPct(f.pLt8)}`, `implied gap ${f.closePrice > 0n && f.fairPrice > 0n ? wadPct(f.impliedGapFair) : '—'}`,
    f.flagNames.length ? `[${f.flagNames.join(',')}]` : '', why.length ? `NOT USABLE: ${why.join('; ')}` : 'usable',
  );
}
