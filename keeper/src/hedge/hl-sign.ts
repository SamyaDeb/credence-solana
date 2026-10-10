// Hyperliquid request signing (L1 actions): msgpack the action, append the nonce and the vault flag, keccak it, sign the
// "phantom agent" with EIP-712 (domain "Exchange", chain id 1337). `source` is "a" on mainnet and "b" on testnet; this
// keeper only ever uses "b". The key never leaves this module: it is read from HEDGE_TESTNET_KEY by the caller, held in
// a closure, and not logged.
import { encode } from '@msgpack/msgpack';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

const pad32 = (n: bigint) => hexToBytes(n.toString(16).padStart(64, '0'));
const TESTNET = 'b';

export function actionHash(action: unknown, nonce: number, vault?: string): Uint8Array {
  const n = new Uint8Array(8);
  new DataView(n.buffer).setBigUint64(0, BigInt(nonce));
  const v = vault ? concatBytes(Uint8Array.of(1), hexToBytes(vault.replace(/^0x/, ''))) : Uint8Array.of(0);
  return keccak_256(concatBytes(encode(action), n, v));
}

/** The EIP-712 digest of Agent{source, connectionId} under the Exchange domain. */
export function agentDigest(connectionId: Uint8Array, source = TESTNET): Uint8Array {
  const domainType = keccak_256(utf8ToBytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
  const domain = keccak_256(concatBytes(domainType, keccak_256(utf8ToBytes('Exchange')), keccak_256(utf8ToBytes('1')), pad32(1337n), pad32(0n)));
  const agentType = keccak_256(utf8ToBytes('Agent(string source,bytes32 connectionId)'));
  const struct = keccak_256(concatBytes(agentType, keccak_256(utf8ToBytes(source)), connectionId));
  return keccak_256(concatBytes(Uint8Array.of(0x19, 0x01), domain, struct));
}

export type Sig = { r: string; s: string; v: number };

export function signAction(privateKeyHex: string, action: unknown, nonce: number): Sig {
  const key = hexToBytes(privateKeyHex.replace(/^0x/, ''));
  const sig = secp256k1.sign(agentDigest(actionHash(action, nonce)), key, { lowS: true });
  return { r: '0x' + sig.r.toString(16).padStart(64, '0'), s: '0x' + sig.s.toString(16).padStart(64, '0'), v: 27 + sig.recovery };
}

/** The EVM address of a private key. */
export function addressOf(privateKeyHex: string): string {
  const pub = secp256k1.getPublicKey(hexToBytes(privateKeyHex.replace(/^0x/, '')), false).slice(1);
  return '0x' + bytesToHex(keccak_256(pub).slice(-20));
}

/** The address a signature recovers to (what the venue checks the request against). */
export function recoverAddress(action: unknown, nonce: number, sig: Sig): string {
  const s = new secp256k1.Signature(BigInt(sig.r), BigInt(sig.s)).addRecoveryBit(sig.v - 27);
  const pub = s.recoverPublicKey(agentDigest(actionHash(action, nonce))).toRawBytes(false).slice(1);
  return '0x' + bytesToHex(keccak_256(pub).slice(-20));
}
