// POST {step, gap?, owner?}: FORK ONLY. Runs one demo-mode step of the keeper (keeper/src/app-step.ts: setup, close,
// open, settle, status) or creates the bigger demo position (keeper/src/create-position.ts), and streams its output
// line by line: the keeper's own transaction lines ("ok <what> (<CU> CU)") and a final "@@result <json>". One step at a
// time. The child gets only the fork's RPC URL; no key reaches it from here.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { FORK_RPC, ROOT, assertLocalFork, fail } from '@/lib/server/fork';

export const dynamic = 'force-dynamic';
let running: string | null = null;

const redact = (s: string) => s.replace(/(api[-_]?key|apikey)=[^&\s"')]+/gi, '$1=***');

export async function POST(req: Request) {
  try {
    assertLocalFork();
    const { step, gap, owner, debt } = (await req.json()) as { step: string; gap?: number; owner?: string; debt?: number };
    let args: string[];
    if (['setup', 'close', 'settle', 'status'].includes(step)) args = ['src/app-step.ts', step];
    else if (step === 'open') {
      if (typeof gap !== 'number' || !(gap >= -0.3 && gap <= 0.1)) throw new Error('gap must be between −30% and +10%');
      args = ['src/app-step.ts', 'open', '--gap', String(gap)];
    } else if (step === 'create') {
      const o = new PublicKey(owner ?? '').toBase58();
      const d = debt ?? 50_000;
      if (!(d >= 1_000 && d <= 250_000)) throw new Error('debt must be 1,000–250,000 USDC');
      args = ['src/create-position.ts', '--owner', o, '--debt', String(d)];
    } else throw new Error(`unknown step ${step}`);
    if (running) return Response.json({ error: `"${running}" is still running` }, { status: 409 });
    running = step;

    const child = spawn('pnpm', ['-s', 'tsx', ...args], {
      cwd: join(/* turbopackIgnore: true */ ROOT, 'keeper'),
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', RPC_URL: FORK_RPC, ...(process.env.KEEPER_WALLET ? { KEEPER_WALLET: process.env.KEEPER_WALLET } : {}) } as unknown as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(ctrl) {
        let buf = '';
        const push = (chunk: Buffer) => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const l of lines) if (l.trim() && !l.includes('bigint: Failed to load bindings')) ctrl.enqueue(enc.encode(redact(l) + '\n'));
        };
        child.stdout.on('data', push);
        child.stderr.on('data', push);
        child.on('close', (code: number | null) => {
          if (buf.trim()) ctrl.enqueue(enc.encode(redact(buf) + '\n'));
          ctrl.enqueue(enc.encode(`@@exit ${code}\n`));
          running = null;
          ctrl.close();
        });
        child.on('error', (e: Error) => { ctrl.enqueue(enc.encode(`@@error ${e.message}\n@@exit 1\n`)); running = null; ctrl.close(); });
      },
      cancel() { child.kill(); running = null; },
    });
    return new Response(stream, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
  } catch (e) {
    running = null;
    return fail(e, 400);
  }
}
