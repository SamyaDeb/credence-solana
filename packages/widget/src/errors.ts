// Typed errors the widget raises; every message is written for the person reading the widget, and none carries an RPC URL or key.
export class InputError extends Error {
  constructor(message: string) { super(message); this.name = 'InputError'; }
}
/** A host that bundles a second copy of @solana/web3.js (or anchor): its PublicKey is not ours, so `instanceof` and map keys silently fail. */
export class SingleCopyError extends Error {
  constructor(what: string) {
    super(`${what} comes from a different copy of @solana/web3.js than the one @credence/widget uses: two copies of @solana/web3.js, @anchor-lang/core or bn.js are loaded. Alias each to one copy in your bundler (see the widget README, "One copy of three libraries").`);
    this.name = 'SingleCopyError';
  }
}
export class UnsupportedClusterError extends Error {
  constructor() {
    super('This connection is Solana mainnet. Credence is not deployed there: the widget works against the local mainnet fork only, so it builds nothing here.');
    this.name = 'UnsupportedClusterError';
  }
}
export class ProgramMismatchError extends Error {
  constructor(detail: string) { super(`This cluster's Credence program is not the one this widget was built for: ${detail}`); this.name = 'ProgramMismatchError'; }
}
/** The position cannot be protected (or not by this widget version); the reason is the program's or the widget's scope. */
export class UnsupportedPositionError extends Error {
  constructor(message: string) { super(message); this.name = 'UnsupportedPositionError'; }
}
