# Mainnet runbook (W6): deploy, hand over, cap, operate, respond

Nothing in this repository is deployed to mainnet. The contracts are unaudited, and the owner decided that no
contract goes to mainnet before an audit (plan/10 §2). This runbook is what a capped, audited launch would follow. Every
step was dry-run on a fresh mainnet fork with `scripts/runbook-dryrun.sh`; its result is in `data/runbook/`.

| | Step | Who | Proven in the dry run |
|---|---|---|---|
| 0 | Audit and the verifiable build | owner | the build hash is in the README (needs Docker; see §0) |
| 1 | Deploy | deployer | step 1 (fork: bytes by cheatcode, see "What the dry run substitutes") |
| 2 | Check the on-chain hash | anyone | step 2 |
| 3 | Multisig takes the upgrade authority | deployer | step 3 (Squads v4, 2-of-3) |
| 4 | Load data and check its hashes | deployer | step 4 |
| 5 | Hand the program's admin to the multisig | deployer, then the multisig | step 5 |
| 6 | Launch caps, guardian and keeper keys | multisig | step 6 |
| 7 | Guardian pause drill | guardian, multisig | step 7 |
| 8 | Keeper | keeper host | step 8 |
| 9 | Monitoring | ops | steps 7 and 9 |
| 10 | Upgrades | multisig | step 10 |

## 0. Before anything: audit, build, keys

- **Audit.** An external review of the money paths first: shield, settlement, backstop and vault (grant milestone
  M1). Every finding gets a failing test, then a fix, as in `docs/audit/phase1-audit.md`.
- **Verifiable build.** Run `solana-verify build --library-name credence_core` (Docker; Agave 4.3 image). Then
  `solana-verify get-executable-hash target/deploy/credence_core.so` must equal the hash in the README. Deploy only that
  binary. The dry run's step 2 checks the deployed executable against the local build byte for byte.
- **Keys.** There are four roles, each held by different people on hardware wallets:

  | Role | Key | What it can do |
  |---|---|---|
  | Deployer | Temporary. Gives up both of its powers (steps 3 and 5) | Deploy, load data |
  | Multisig | Squads v4, 2-of-3 or more, members on separate devices | Upgrade authority, program admin: parameters, assets, unpause |
  | Guardian | One key, on call | Pause only (risk-reducing) |
  | Keeper | Hot key on the keeper host, holds only SOL for fees | Close, settlement, shield, backstop, rebalance. It cannot move vault funds anywhere except into obligations and the program's own accounts |

## 1. Deploy

```bash
solana program deploy target/deploy/credence_core.so --program-id <credence_core-keypair.json> \
  --upgrade-authority <deployer.json> -u mainnet-beta --with-compute-unit-price <µlamports>
```

Program rent is about 4.33 SOL (plan/06), and the buffer needs about twice that for a few minutes.

## 2. Check what is on chain

```bash
solana-verify get-program-hash -u mainnet-beta xJfKukbf9dCS98Sb1cuvFkRbjN4gC1f1SqMs3FhF14q   # = the README hash
solana-verify verify-from-repo -u mainnet-beta --program-id xJfKukbf9dCS98Sb1cuvFkRbjN4gC1f1SqMs3FhF14q <repo> --library-name credence_core
```

## 3. Upgrade authority to the multisig

Create the Squads v4 multisig: 2-of-3 at least, no time lock for the first weeks, then 24 h. Then hand it the upgrade
authority:

```bash
solana program set-upgrade-authority xJfKukbf9dCS98Sb1cuvFkRbjN4gC1f1SqMs3FhF14q \
  --new-upgrade-authority <multisig vault> --skip-new-upgrade-authority-signer-check
solana program show xJfKukbf9dCS98Sb1cuvFkRbjN4gC1f1SqMs3FhF14q    # Authority: <multisig vault>
```

## 4. Load data

`scripts/src/load-onchain.ts` sets up, in order:
- config, the three assets, the calendar and the vault;
- the backstop pool and one inventory per asset;
- the yield reserve.

For each scenario set and the joint set, it uploads the values, computes the gap factors on-chain and checks the
SHA-256 against `data/onchain`. A mismatch stops the launch. It is idempotent.

## 5. Program admin to the multisig

The deployer proposes the multisig vault as admin (`propose_admin`). The multisig accepts in a vault transaction
(`accept_admin`, two approvals). From then on, the deployer's key has no power. A typo in the proposal cannot brick the
program, because only the proposed key can accept.

## 6. Launch caps (multisig)

| Parameter | Launch value | Instruction |
|---|---|---|
| `u_max` | 10% of cover equity (Phase 1 ran 50% on the fork) | `set_params` |
| `max_asset_share` | 25% | `set_params` |
| Protocol fee | 0 | `set_params` |
| Backstop share of equity | 5% (fork: 25%) | `set_backstop_params` |
| Enabled assets | SPYx only at first; QQQx stays off until its settlement source is reliable (plan/06) | `update_asset` |
| Vault size | a deposit cap by policy: the multisig LP seeds it; outside LPs come later (grant M3) | (operations) |
| Guardian, keeper | their own keys | `set_params` |

## 7. Guardian pause

The guardian pauses with `set_paused(true)` and needs no other signer. While paused:
- these are refused: cover sales, shield advances, backstop liquidations, auction buys, deposits, and new lending in
  `rebalance`;
- these still work: settlement into positions, refunds of voided epochs, withdrawal processing, redemptions from the
  lending reserve and `close_sale`.

Only the multisig unpauses. The dry run showed that the old admin could not.

## 8. Keeper

- **Host.** Railway, or any always-on host, running `pnpm -C keeper keeper` (every 30 s; `KEEPER_WALLET`,
  `RPC_URL`), plus `BACKSTOP_WATCH` or the scan's liquidatable set.
- **Two RPC providers.** The keeper must reach the chain in the 6-minute settlement window after Monday's open, so run
  a second instance on another provider. The jobs are idempotent, and the program refuses duplicates.
- **Funding.** The keeper key holds about 2 SOL. Alert below 0.5.
- **Every pass:**
  - epochs for the next four weekends
  - the Friday close, inside its window
  - the shield in its window (Sunday 20:00 ET to 07:00 ET)
  - settlement after the open
  - `rebalance`
  - the queues
  - the backstop

## 9. Monitoring

`pnpm -C scripts tsx src/monitor.ts` runs every minute and exits 2 on an alert. It checks:

| Check | Level |
|---|---|
| Protocol paused | alert |
| INV-2 utilisation (> 80%) | warn |
| INV-2 breached | alert |
| INV-13 cash below what live groups, advances and queues need | alert |
| Inventory marks or the lending valuation older than 15 minutes | warn |
| Live weekends | info |

Add the keeper's own `failed` count, its SOL balance and its last pass time. Page the guardian on any alert. Watch the
program's events (`PolicySettled.shortfall`, `BackstopLiquidated`, `Rebalanced.illiquid`) through an indexer.

## 10. Upgrades

1. Build verifiably and publish the new hash.
2. Write a buffer: `solana program write-buffer`, then `set-buffer-authority` to the multisig vault.
3. The multisig approves a vault transaction with the loader's `Upgrade` instruction.
4. Check the program hash.

Two warnings:
- **Account layouts:** never upgrade over live groups when a layout changes (audit A-19). Pause, let the groups settle,
  then upgrade.
- **Time lock:** keep the multisig's time lock on for upgrades.

## Incidents

| Sign | First action | Then |
|---|---|---|
| Oracle wrong or Scope frozen at the open | Guardian pauses | Settlement waits: `halt_epoch` moves the open; if the close never came, `void_epoch` refunds |
| A klend market paused (`emergency_mode`) | Nothing to pause on our side | `settle_policy_to_wallet` pays owners after `SETTLE_GRACE` (1 h) |
| USDC reserve 100% utilised | Nothing: payouts are cash | `rebalance` keeps booking and skips the redemption; new cover waits for cash (`CashBelowReservation`) |
| Weekend beyond every stress scenario | None in-protocol | Policies are paid what equity and the group's premiums cover (A-05, A-14), and the shortfall is emitted. Communicate |
| Issuer pauses an xStock or sets a transfer hook | None | Backstop sales stop by themselves (Token-2022 checks); cover settles in USDC unaffected |
| Keeper key compromised | Guardian pauses; multisig sets a new keeper (`set_params`) | The keeper can't move funds out of the vault; check `ShieldAdvanced` and `BackstopLiquidated` |
| Bug found | Guardian pauses | Fix, audit the diff, verifiable build, multisig upgrade (§10), unpause |

## What the dry run substitutes

All of these are listed in its output:
- **Program and buffer bytes.** They were written with surfpool cheatcodes. `solana program deploy` and `write-buffer`
  send about 2,400 write transactions, which surfpool drops ("Blockhash not found"). The authority changes, the
  multisig's vault transactions and the upgrade instruction itself are real.
- **Keys.** The multisig members, the guardian and the keeper are fresh keypairs, not hardware wallets.
- **Clock and SOL.** These are the fork's.
