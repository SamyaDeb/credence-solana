// Signing probe (no funds, no key needed): signs a request with a throwaway key and sends it to the TESTNET. The venue
// recovers the signer from the signature and, for an unknown account, names it in the rejection ("User or API Wallet 0x…
// does not exist"). If that address is the throwaway key's, our msgpack + EIP-712 signing is what the venue expects.
import { randomBytes } from 'node:crypto';
import { HyperliquidTestnet } from './hyperliquid.js';

const key = '0x' + randomBytes(32).toString('hex');
const v = new HyperliquidTestnet({ key });
console.log('throwaway address', v.address);
try {
  await v.openHedge([{ ticker: 'NVDAx', instrument: 'xyz:NVDA', notional: 10_000_000n }]);
  console.log('unexpected: accepted');
} catch (e) {
  const msg = String((e as Error).message);
  console.log(msg);
  const named = /0x[0-9a-fA-F]{40}/.exec(msg)?.[0]?.toLowerCase();
  console.log(named === v.address.toLowerCase() ? 'SIGNING OK: the venue recovered our address' : `MISMATCH: venue recovered ${named}`);
}
