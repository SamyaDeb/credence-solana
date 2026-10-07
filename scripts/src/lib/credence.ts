// Shared client setup for scripts: provider, program, PDAs, ticker encoding.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import anchor from '@anchor-lang/core';
const { AnchorProvider, Program, Wallet, web3 } = anchor;

export const ROOT = new URL('../../../', import.meta.url).pathname;
export const IDL = JSON.parse(readFileSync(join(ROOT, 'target/idl/credence_core.json'), 'utf8'));
export const PROGRAM_ID = new web3.PublicKey(IDL.address);

export function keypair(path: string) {
  return web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
}

export function connect(url = process.env.RPC_URL ?? 'http://127.0.0.1:8899', walletPath = `${homedir()}/.config/solana/id.json`) {
  const conn = new web3.Connection(url, 'confirmed');
  const wallet = new Wallet(keypair(walletPath));
  const provider = new AnchorProvider(conn, wallet, { commitment: 'confirmed', skipPreflight: false });
  const program = new Program(IDL, provider);
  return { conn, wallet, provider, program };
}

export const ticker8 = (t: string): number[] => {
  const b = Buffer.alloc(8);
  b.write(t, 'ascii');
  return [...b];
};

const pda = (seeds: (Buffer | Uint8Array)[]) => web3.PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
export const pdas = {
  config: () => pda([Buffer.from('config')]),
  asset: (t: string) => pda([Buffer.from('asset'), Buffer.from(ticker8(t))]),
  scen: (t: string, closureType: number) => pda([Buffer.from('scen'), Buffer.from(ticker8(t)), Buffer.from([closureType])]),
  joint: (version: number) => pda([Buffer.from('joint'), u32le(version)]),
  epoch: (t: string, closureId: number) => pda([Buffer.from('epoch'), Buffer.from(ticker8(t)), u32le(closureId)]),
  vault: () => pda([Buffer.from('vault')]),
  vaultUsdc: () => pda([Buffer.from('vault_usdc')]),
  shares: () => pda([Buffer.from('shares')]),
  shareEscrow: () => pda([Buffer.from('share_escrow')]),
  calendar: () => pda([Buffer.from('calendar'), Buffer.from('XNYS\0\0\0\0')]),
  loss: (group: number) => pda([Buffer.from('loss'), u32le(group)]),
};

export const cuLimit = (units = 1_400_000) => web3.ComputeBudgetProgram.setComputeUnitLimit({ units });
