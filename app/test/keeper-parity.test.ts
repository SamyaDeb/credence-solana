// The app mirrors keeper/src/chain.ts (which needs node:fs). Both must derive the same PDAs and use the same constants.
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import * as app from '@/lib/credence';
import * as keeper from '../../keeper/src/chain';

const k = (x: { toBase58(): string }) => x.toBase58();

describe('app ↔ keeper parity', () => {
  it('program id and constants', () => {
    expect(k(app.PROGRAM_ID)).toBe(k(keeper.PROGRAM_ID));
    for (const name of ['TOKEN', 'TOKEN_2022', 'ATA_PROGRAM', 'USDC_MINT', 'KLEND', 'FARMS', 'SCOPE_PRICES', 'PYTH_PUSH_ORACLE'] as const) {
      expect(k(app[name]), name).toBe(k(keeper[name]));
    }
    expect(app.EPOCH).toEqual(keeper.EPOCH);
    expect(app.POLICY).toEqual(keeper.POLICY);
    expect(app.SOURCE).toEqual(keeper.SOURCE);
    expect(app.TICKET).toEqual(keeper.TICKET);
    expect([app.SCOPE_AFTER_CLOSE, app.SCOPE_OPEN_DELAY, app.SETTLE_WINDOW, app.SETTLE_GRACE, app.VOID_AFTER])
      .toEqual([keeper.SCOPE_AFTER_CLOSE, keeper.SCOPE_OPEN_DELAY, keeper.SETTLE_WINDOW, keeper.SETTLE_GRACE, keeper.VOID_AFTER]);
  });

  it('PDAs', () => {
    const owner = Keypair.generate().publicKey;
    const ob = Keypair.generate().publicKey;
    for (const t of ['SPYx', 'QQQx', 'NVDAx']) {
      expect(k(app.pdas.asset(t))).toBe(k(keeper.pdas.asset(t)));
      expect(k(app.pdas.scen(t))).toBe(k(keeper.pdas.scen(t)));
      expect(k(app.pdas.epoch(t, 20261009))).toBe(k(keeper.pdas.epoch(t, 20261009)));
    }
    for (const f of ['config', 'calendar', 'vault', 'vaultUsdc', 'shares', 'shareEscrow'] as const) {
      expect(k(app.pdas[f]()), f).toBe(k(keeper.pdas[f]()));
    }
    expect(k(app.pdas.loss(20261009))).toBe(k(keeper.pdas.loss(20261009)));
    expect(k(app.pdas.joint(1))).toBe(k(keeper.pdas.joint(1)));
    const ep = app.pdas.epoch('SPYx', 20261009);
    expect(k(app.pdas.policy(ep, owner, ob))).toBe(k(keeper.pdas.policy(keeper.pk(k(ep)), keeper.pk(k(owner)), keeper.pk(k(ob)))));
    expect(k(app.pdas.depositTicket(owner, 7))).toBe(k(keeper.pdas.depositTicket(keeper.pk(k(owner)), 7)));
    expect(k(app.pdas.withdrawTicket(owner, 7))).toBe(k(keeper.pdas.withdrawTicket(keeper.pk(k(owner)), 7)));
    expect(k(app.ata(owner, app.USDC_MINT))).toBe(k(keeper.ata(keeper.pk(k(owner)), keeper.USDC_MINT)));
  });

  it('xStocks markets match the program', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../programs/credence-core/src/kamino.rs', import.meta.url), 'utf8');
    const block = src.slice(src.indexOf('pub const XSTOCKS_MARKETS'), src.indexOf('];', src.indexOf('pub const XSTOCKS_MARKETS')));
    const inProgram = [...block.matchAll(/pubkey!\("(\w+)"\)/g)].map((m) => m[1]);
    expect(Object.keys(app.XSTOCKS_MARKETS)).toEqual(inProgram);
  });
});

describe('error redaction', () => {
  it('never shows an RPC key', async () => {
    const { redact } = await import('@/lib/tx');
    const msg = 'Internal error: "Failed to fetch accounts from remote: error sending request for url (https://mainnet.helius-rpc.com/?api-key=abc123-def)"';
    expect(redact(msg)).not.toContain('abc123');
    expect(redact('https://x.example/?apikey=SECRET&x=1')).not.toContain('SECRET');
  });
});
