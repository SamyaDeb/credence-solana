//! C3.2 the sample consumer: it reads a `GapFeed` by account data and refuses anything that is not the genuine,
//! fresh, unflagged feed of the market's ticker. The feeds here are written directly with the layout `credence_core`
//! defines (the real crank is exercised end to end in credence-core/tests/gap_feed.rs).

use anchor_lang::{prelude::Pubkey, solana_program::instruction::Instruction, Discriminator, InstructionData, ToAccountMetas};
use credence_core::state::{feed_flag as ff, GapFeed, SEED_FEED};
use litesvm::{types::TransactionMetadata, LiteSVM};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

const NOW: i64 = 1_791_700_000;
const SPY: [u8; 8] = *b"SPYx\0\0\0\0";
const QQQ: [u8; 8] = *b"QQQx\0\0\0\0";
const P8: u64 = 1_230_000_000_000_000; // 0.123%

fn code(e: gap_consumer::ConsumerError) -> u32 {
    anchor_lang::error::ERROR_CODE_OFFSET + e as u32
}

fn feed_pda(t: &[u8; 8]) -> Pubkey {
    Pubkey::find_program_address(&[SEED_FEED, t], &credence_core::ID).0
}
fn market_pda(t: &[u8; 8]) -> Pubkey {
    Pubkey::find_program_address(&[gap_consumer::SEED_MARKET, t], &gap_consumer::ID).0
}

fn feed(t: [u8; 8], f: impl FnOnce(&mut GapFeed)) -> Account {
    let mut g: GapFeed = bytemuck::Zeroable::zeroed();
    g.ticker = t;
    g.bump = Pubkey::find_program_address(&[SEED_FEED, &t], &credence_core::ID).1;
    g.updates = 1;
    g.last_update_ts = NOW - 60;
    g.next_open = NOW + 86_400;
    g.p_lt_8_wad = P8;
    f(&mut g);
    let mut data = GapFeed::DISCRIMINATOR.to_vec();
    data.extend_from_slice(bytemuck::bytes_of(&g));
    Account { lamports: 10_000_000, data, owner: credence_core::ID, executable: false, rent_epoch: 0 }
}

struct W {
    svm: LiteSVM,
    payer: Keypair,
}

fn world() -> W {
    let mut svm = LiteSVM::new();
    let so = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/gap_consumer.so"));
    svm.add_program(gap_consumer::ID, so).unwrap();
    let mut c: solana_clock::Clock = svm.get_sysvar();
    c.unix_timestamp = NOW;
    svm.set_sysvar(&c);
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
    let mut w = W { svm, payer };
    w.send(init(&w.payer.pubkey(), SPY, 8_000, 2_000, 5_000, 3_600)).unwrap();
    w
}

impl W {
    fn send(&mut self, ix: Instruction) -> Result<TransactionMetadata, litesvm::types::FailedTransactionMetadata> {
        self.svm.expire_blockhash();
        let msg = Message::new_with_blockhash(&[ix], Some(&self.payer.pubkey()), &self.svm.latest_blockhash());
        self.svm.send_transaction(VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&self.payer]).unwrap())
    }
    fn market(&self, t: &[u8; 8]) -> gap_consumer::Market {
        let d = self.svm.get_account(&market_pda(t)).unwrap().data;
        anchor_lang::AccountDeserialize::try_deserialize(&mut &d[..]).unwrap()
    }
}

fn init(authority: &Pubkey, t: [u8; 8], base: u16, k_x100: u32, floor: u16, max_age: u32) -> Instruction {
    Instruction::new_with_bytes(
        gap_consumer::ID,
        &gap_consumer::instruction::InitMarket { ticker: t, base_ltv_bps: base, k_x100, floor_bps: floor, max_age_secs: max_age }.data(),
        gap_consumer::accounts::InitMarket { authority: *authority, market: market_pda(&t), system_program: anchor_lang::solana_program::system_program::ID }
            .to_account_metas(None),
    )
}

fn refresh(t: [u8; 8], feed_key: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        gap_consumer::ID,
        &gap_consumer::instruction::RefreshLimit { ticker: t }.data(),
        gap_consumer::accounts::RefreshLimit { market: market_pda(&t), feed: feed_key }.to_account_metas(None),
    )
}

fn assert_err(r: Result<TransactionMetadata, litesvm::types::FailedTransactionMetadata>, expected: u32) {
    let e = r.expect_err("expected the transaction to fail");
    let s = format!("{:?}", e.err);
    assert!(s.contains(&format!("Custom({expected})")), "expected Custom({expected}), got {s}\n{:#?}", e.meta.logs);
}

#[test]
fn happy_path_sets_the_weekend_limit() {
    let mut w = world();
    w.svm.set_account(feed_pda(&SPY), feed(SPY, |_| {})).unwrap();
    w.send(refresh(SPY, feed_pda(&SPY))).unwrap();
    let m = w.market(&SPY);
    // 8000 × 20 × 0.00123 = 196.8 → 197 off → 7803 bp; the feed's number is kept next to it.
    assert_eq!((m.ltv_weekend_bps, m.p_lt_8_wad, m.feed_ts, m.set_at_ts), (7_803, P8, NOW - 60, NOW));
    // Informational flags do not block (the lender's price being frozen is the normal weekend state).
    w.svm.set_account(feed_pda(&SPY), feed(SPY, |g| g.flags = ff::LENDER_FROZEN | ff::EARNINGS_ASSET)).unwrap();
    w.send(refresh(SPY, feed_pda(&SPY))).unwrap();
}

#[test]
fn rounding_is_toward_the_lower_ltv() {
    let mut w = world();
    // 1e-18 of probability still takes a basis point off; a certain gap goes to the floor.
    w.svm.set_account(feed_pda(&SPY), feed(SPY, |g| g.p_lt_8_wad = 1)).unwrap();
    w.send(refresh(SPY, feed_pda(&SPY))).unwrap();
    assert_eq!(w.market(&SPY).ltv_weekend_bps, 7_999);
    w.svm.set_account(feed_pda(&SPY), feed(SPY, |g| g.p_lt_8_wad = 1_000_000_000_000_000_000)).unwrap();
    w.send(refresh(SPY, feed_pda(&SPY))).unwrap();
    assert_eq!(w.market(&SPY).ltv_weekend_bps, 5_000);
}

#[test]
fn wrong_owner_is_refused() {
    let mut w = world();
    // Right layout, right address, owned by another program: the spoof.
    let mut a = feed(SPY, |g| g.p_lt_8_wad = 0);
    a.owner = Pubkey::new_unique();
    w.svm.set_account(feed_pda(&SPY), a.clone()).unwrap();
    assert_err(w.send(refresh(SPY, feed_pda(&SPY))), anchor_lang::error::ErrorCode::AccountOwnedByWrongProgram as u32);
    // Right layout at an arbitrary address, owned by anyone (or by credence_core): not the PDA.
    let other = Pubkey::new_unique();
    w.svm.set_account(other, a).unwrap();
    assert!(w.send(refresh(SPY, other)).is_err());
    w.svm.set_account(other, feed(SPY, |_| {})).unwrap();
    assert_err(w.send(refresh(SPY, other)), anchor_lang::error::ErrorCode::ConstraintSeeds as u32);
    assert_eq!(w.market(&SPY).ltv_weekend_bps, 0);
}

#[test]
fn wrong_ticker_pda_is_refused() {
    let mut w = world();
    w.svm.set_account(feed_pda(&QQQ), feed(QQQ, |_| {})).unwrap();
    assert_err(w.send(refresh(SPY, feed_pda(&QQQ))), anchor_lang::error::ErrorCode::ConstraintSeeds as u32);
    // Not a GapFeed at all.
    let junk = Account { lamports: 1, data: vec![7u8; 400], owner: credence_core::ID, executable: false, rent_epoch: 0 };
    w.svm.set_account(feed_pda(&SPY), junk).unwrap();
    assert!(w.send(refresh(SPY, feed_pda(&SPY))).is_err());
}

#[test]
fn stale_or_unupdated_feed_is_refused() {
    let mut w = world();
    w.svm.set_account(feed_pda(&SPY), feed(SPY, |g| g.last_update_ts = NOW - 3_601)).unwrap();
    assert_err(w.send(refresh(SPY, feed_pda(&SPY))), code(gap_consumer::ConsumerError::FeedStale));
    w.svm.set_account(feed_pda(&SPY), feed(SPY, |g| g.last_update_ts = NOW - 3_600)).unwrap();
    w.send(refresh(SPY, feed_pda(&SPY))).unwrap();
    // A feed stamped in the future is not fresh either.
    w.svm.set_account(feed_pda(&SPY), feed(SPY, |g| g.last_update_ts = NOW + 5)).unwrap();
    assert_err(w.send(refresh(SPY, feed_pda(&SPY))), code(gap_consumer::ConsumerError::FeedStale));
    w.svm.set_account(feed_pda(&SPY), feed(SPY, |g| g.updates = 0)).unwrap();
    assert_err(w.send(refresh(SPY, feed_pda(&SPY))), code(gap_consumer::ConsumerError::FeedNeverUpdated));
    // The closure has opened.
    w.svm.set_account(feed_pda(&SPY), feed(SPY, |g| g.next_open = NOW)).unwrap();
    assert_err(w.send(refresh(SPY, feed_pda(&SPY))), code(gap_consumer::ConsumerError::ClosureOver));
}

#[test]
fn every_blocking_flag_is_refused() {
    let mut w = world();
    for bit in [
        ff::MISSING_FAIR, ff::MISSING_LENDER, ff::NO_CLOSE, ff::NO_SCENARIOS, ff::STALE_FAIR, ff::PAUSED, ff::FAIR_UNVERIFIED,
        ff::FAIR_OUTSIDE_CONF, ff::LENDER_SUSPENDED,
    ] {
        w.svm.set_account(feed_pda(&SPY), feed(SPY, |g| g.flags = bit)).unwrap();
        assert_err(w.send(refresh(SPY, feed_pda(&SPY))), code(gap_consumer::ConsumerError::FeedFlagged));
    }
    assert_eq!(w.market(&SPY).ltv_weekend_bps, 0);
}

#[test]
fn init_market_rejects_bad_params() {
    let mut w = world();
    let p = w.payer.pubkey();
    for (base, k, floor, age) in [(0u16, 100u32, 0u16, 3_600u32), (10_001, 100, 0, 3_600), (8_000, 100, 8_001, 3_600), (8_000, 10_001, 5_000, 3_600), (8_000, 100, 5_000, 59), (8_000, 100, 5_000, 86_401)] {
        assert_err(w.send(init(&p, QQQ, base, k, floor, age)), code(gap_consumer::ConsumerError::BadParam));
    }
    // The same market cannot be initialised twice.
    assert!(w.send(init(&p, SPY, 8_000, 2_000, 5_000, 3_600)).is_err());
}
