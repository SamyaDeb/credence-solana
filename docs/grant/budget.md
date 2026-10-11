# Budget lines (no price is invented; unknown prices say "quote pending")

| Line | Needed for | Amount | Source |
|---|---|---|---|
| Security review of the money paths | M1 | quote pending | No quote requested yet |
| Full audit | next funding step, not this grant | quote pending | — |
| Program rent | M2 | about 4.33 SOL, plus about twice that for a few minutes while the upload buffer exists | `docs/mainnet-runbook.md` §1 (plan/06 estimate); the current program is 2,828,256 bytes (`target/deploy/credence_core.so`), re-check with `solana rent` before deploying |
| Seed vault (cover equity) | M2 | owner decision | Runbook §6: launch caps limit exposure to u_max 10% of cover equity |
| Keeper SOL | M2 | about 2 SOL, alert below 0.5 | Runbook §8 |
| RPC plan (two providers) | M2, M3, M5 | quote pending | Runbook §8 needs a second provider for the 6-minute settlement window |
| Keeper hosting (always on, two instances) | M2, M3, M5 | quote pending | Runbook §8 |
| Licensed market data | M4 | quote pending | No licence quote requested yet |
| Multisig signers' hardware wallets | M2 | quote pending | Runbook §0 |
| Grant ceiling | all | up to 10k USDG | Superteam Earn listing, read 2026-10-11 |

How the ceiling is split across lines is the owner's decision.
