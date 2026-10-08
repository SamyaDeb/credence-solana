# Phase 1 audit (Oct 8–12, 2026)

Internal audit of `programs/credence-core`, `keeper/` and `app/` before the Phase 1 submission. Each finding has a
failing test written first, then the fix. A finding that is not fixed has its reason here and is listed in the
README's Known limits.

Severity: **critical** (funds lost or stuck with no exit), **high** (vault overpays or a user loses funds under a
plausible action), **medium** (wrong result or blocked flow under an unusual condition), **low** (hardening, no loss
path found), **info** (documented behaviour).

| ID | Severity | Where | What | How found | Fix | Test | Status |
|---|---|---|---|---|---|---|---|
| A-01 | high | `buy_cover` (Policy PDA) | Seeds were `["policy", epoch, owner, obligation]`. klend lets an obligation change owner (`approve/accept_obligation_ownership`), so after a transfer before the bell the new owner could buy a second policy on the same obligation for the same weekend, and each pays the full repay-needed amount: the position is over-repaid and the vault overpays. Reproduced on the fork (four policies on one obligation, all paid). | Day 4 fork run (owner rewrites), confirmed in LiteSVM | Seeds are now `["policy", epoch, obligation]`; the owner check stays. Keeper and app derive the same PDA | `cover.rs::one_policy_per_obligation_across_owners` | fixed |
| A-02 | medium | `snapshot_close` | Anyone could store the Friday close, and every source accepts a window (SCOPE: up to 15 min after the bell). QQQx's Scope price moves after hours, so a QQQx policy holder could wait for the highest price in the window and store it as the close: a larger gap, a larger payout. | Review of the oracle windows against the S7 recorder data (48 QQQx Scope value changes in 75 min after the Oct 7 close) | `snapshot_close` requires the keeper, like `post_settlement` and `halt_epoch`; a missed close still ends in `void_epoch` and refunds | `scope.rs::only_the_keeper_stores_the_close` | fixed |
