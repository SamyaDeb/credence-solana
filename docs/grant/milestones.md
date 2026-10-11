# Milestones (bullets and numbers; the owner writes the application)

Scheme (Superteam Earn listing "Solana Foundation India Grants", read 2026-10-11, see `evidence.md`): up to 10k USDG,
self-described milestones, weekly community updates, India-only, KYC on Earn, review up to 30 days. The 25% upfront share
is **not stated on the current listing** (it appears only in an older Notion snippet the check could not open).
The listing shows "Open" and also "Applications Paused": confirm with the contact before relying on it.

| | Deliverable | Proof | Acceptance check | Budget line | Date |
|---|---|---|---|---|---|
| M1 | Security review of the money paths, scoped to what the grant buys: shield, settlement, backstop, vault. Name the full audit as the next funding step | Written findings; each with a failing test, then a fix, in `docs/audit/phase1-audit.md` | No open high or medium finding; `scripts/test.sh` green | Security review (quote pending) | TBD with the reviewer |
| M2 | Capped mainnet launch: Gap Cover, vault and Gap Oracle, behind a Squads multisig, from a verifiable build | Program hash from `solana-verify`; `solana-verify get-program-hash` on chain equals it; multisig is the upgrade authority and admin | Runbook steps 1–9 on mainnet; launch caps from runbook §6 (u_max 10%, asset share 25%, backstop 5%) | Program rent (~4.33 SOL, runbook §1), RPC, keeper host, seed vault | After M1 |
| M3 | First real weekend with outside users | Transactions of real policies; a weekend report from the shadow/results tooling on real sales | One full weekend closed, settled and reported with every number tied to a file or transaction | RPC, keeper host | After M2 |
| M4 | Licensed data | Signed licence; the Oracle reads it | Gap Oracle numbers reproducible from the licensed feed | Data licence (quote pending) | After M2 |
| M5 | One curator pilot | A curator book on real positions (`docs/handoff.md` C2) | One book sealed, shielded and settled on mainnet within caps | RPC, keeper host | After M3 |

Not a milestone: the full audit. It is the next funding step after M1 and is not paid for by this grant.
