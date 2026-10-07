// Writes a solana-test-validator `--account` JSON for an SPL Token account with a chosen owner and balance.
// Fork-only: this is how the demo vault gets USDC without a mint authority.
// Usage: tsx make-token-account.ts <out.json> <tokenAccount> <mint> <owner> <amount> [tokenProgram]
import { writeFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';

const [out, acct, mint, owner, amount, tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'] = process.argv.slice(2);
const data = Buffer.alloc(165);
new PublicKey(mint).toBuffer().copy(data, 0);
new PublicKey(owner).toBuffer().copy(data, 32);
data.writeBigUInt64LE(BigInt(amount), 64);
data[108] = 1; // AccountState::Initialized; delegate, is_native, close_authority stay None
writeFileSync(out, JSON.stringify({
  pubkey: acct,
  account: { lamports: 2039280, data: [data.toString('base64'), 'base64'], owner: tokenProgram, executable: false, rentEpoch: 0, space: 165 },
}));
