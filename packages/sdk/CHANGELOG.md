# Changelog

## 0.1.0 (unreleased, not published)

First version, built with Phase C3 on the fork (credence_core is not deployed anywhere else).

- Reads: `GapFeed` (`readFeed`, `readFeeds`, `decodeFeed`, `feedProblems`), policies, epochs, books and legs, the vault (NAV, APY split,
  capacity), Kamino obligations and reserves, Jupiter Lend positions. Events: `parseEvents` for every program event.
- Quotes: `quoteSingle` (simulates `quote_cover`), `quoteMulti` (`quote_cover_multi`), `quoteByBuy` (the buy itself, for
  Jupiter Lend), `bookQuoteHttp` (the app's `/api/book-quote`) and `bookQuoteLocal` (`@credence/sdk/node`, spawns
  `examples/book_quote.rs`).
- Builders (unsigned instructions): `buyCover` for Kamino (down and up), Kamino multi-collateral and Jupiter Lend, with
  `release_book_leg` prepended for a book leg; the book flow (`openBook`, `addBookLegs`, `sealBook`, `voidBookLeg`,
  `claimBookRefund`, `bookLegStatus` to resume); `updateGapFeed`. Jupiter's program never shares a transaction with klend
  (`assertNoJupiterWithKlend`).
- Plumbing: typed errors (`CoreError`, `ProgramError`, `TxError`) with logs decoded; `checkProgram` refuses a program whose
  IDL or `Config` layout differs from the one embedded here; RPC keys are redacted from every message.
- The app's chain library moved here; the app re-exports it.
