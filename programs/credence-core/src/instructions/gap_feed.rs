//! The Gap Oracle feed (C3): `init_gap_feed`, `set_gap_feed_params` (admin) and the permissionless `update_gap_feed`.
//!
//! `update_gap_feed` moves no funds and takes no signer. Every input is an account whose address the program derives or
//! checks itself: the asset, the calendar and the feed by seeds, the epoch from the calendar's closure, the scenario set
//! from the closure type, Pyth's push account from the asset's feed id, Scope's `OraclePrices` (or the asset's Jupiter
//! cache) from the asset config. So no caller can supply a price. An input that is empty is recorded as missing; one at
//! a wrong address or with a wrong owner fails the instruction. A number is written only when its input passed every
//! check, otherwise it is 0 and its flag is set (`state::feed_flag`).
//!
//! It does not refuse when `config.paused`: it sets `PAUSED`, so a consumer sees the reason instead of a feed that stops.

use anchor_lang::prelude::*;
use credence_risk_core::{gap_prob_wad, U256};
use pyth_solana_receiver_sdk::price_update::{PriceUpdateV2, VerificationLevel};

use crate::calendar::{epoch_times, feed_closure};
use crate::instructions::epoch::VENUE_XNYS;
use crate::jupiter;
use crate::math::WAD;
use crate::oracle::{price_wad, push_account, scope};
use crate::state::*;
use crate::CoreError;

/// After the close, the lender's price is "frozen" once it has not changed for this long, as the cranks saw it. (Scope's
/// refresh time is no signal: it advances every ~40 s while the value stays put.)
pub const FROZEN_AFTER_SECS: i64 = 1_800;
/// A fair value published this far in the future is not believed.
pub const FUTURE_TOLERANCE_SECS: i64 = 60;
pub const MAX_MIN_UPDATE_SLOTS: u32 = 10_000;
pub const MIN_INPUT_AGE_SECS: u32 = 60;
pub const MAX_INPUT_AGE_SECS: u32 = 86_400;
/// The thresholds of P(gap < −x), WAD.
pub const THRESHOLDS_WAD: [u64; 3] = [50_000_000_000_000_000, 80_000_000_000_000_000, 120_000_000_000_000_000];

fn check_params(min_update_slots: u32, max_input_age_secs: u32) -> Result<()> {
    require!(min_update_slots <= MAX_MIN_UPDATE_SLOTS, CoreError::InvalidParam);
    require!((MIN_INPUT_AGE_SECS..=MAX_INPUT_AGE_SECS).contains(&max_input_age_secs), CoreError::InvalidParam);
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(ticker: Ticker)]
pub struct InitGapFeed<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [SEED_ASSET, ticker.as_ref()], bump = asset.load()?.bump)]
    pub asset: AccountLoader<'info, AssetConfig>,
    #[account(init, payer = admin, space = GapFeed::SIZE, seeds = [SEED_FEED, ticker.as_ref()], bump)]
    pub feed: AccountLoader<'info, GapFeed>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_gap_feed(ctx: Context<InitGapFeed>, ticker: Ticker, min_update_slots: u32, max_input_age_secs: u32) -> Result<()> {
    check_params(min_update_slots, max_input_age_secs)?;
    let a = ctx.accounts.asset.load()?;
    let mut f = ctx.accounts.feed.load_init()?;
    f.ticker = ticker;
    f.bump = ctx.bumps.feed;
    f.lender = u8::try_from(a.lender).map_err(|_| error!(CoreError::InvalidParam))?;
    f.min_update_slots = min_update_slots;
    f.max_input_age_secs = max_input_age_secs;
    Ok(())
}

#[derive(Accounts)]
#[instruction(ticker: Ticker)]
pub struct SetGapFeedParams<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ CoreError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_FEED, ticker.as_ref()], bump = feed.load()?.bump)]
    pub feed: AccountLoader<'info, GapFeed>,
}

pub fn handle_set_gap_feed_params(ctx: Context<SetGapFeedParams>, _ticker: Ticker, min_update_slots: u32, max_input_age_secs: u32) -> Result<()> {
    check_params(min_update_slots, max_input_age_secs)?;
    let mut f = ctx.accounts.feed.load_mut()?;
    f.min_update_slots = min_update_slots;
    f.max_input_age_secs = max_input_age_secs;
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// The crank
// ---------------------------------------------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(ticker: Ticker)]
pub struct UpdateGapFeed<'info> {
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [SEED_ASSET, ticker.as_ref()], bump = asset.load()?.bump)]
    pub asset: AccountLoader<'info, AssetConfig>,
    #[account(seeds = [SEED_CALENDAR, VENUE_XNYS.as_ref()], bump = calendar.load()?.bump)]
    pub calendar: AccountLoader<'info, Calendar>,
    #[account(mut, seeds = [SEED_FEED, ticker.as_ref()], bump = feed.load()?.bump)]
    pub feed: AccountLoader<'info, GapFeed>,
    /// CHECK: the ScenarioSet PDA of (ticker, closure type), checked against the derived address in the handler.
    pub scenario: UncheckedAccount<'info>,
    /// CHECK: the Epoch PDA of (ticker, closure id), checked against the derived address in the handler.
    pub epoch: UncheckedAccount<'info>,
    /// CHECK: Pyth's push account for the asset's `Crypto.<T>X/USD` feed id, checked against the derived address.
    pub fair: UncheckedAccount<'info>,
    /// CHECK: Kamino's Scope `OraclePrices` (Kamino assets) or the asset's Jupiter cache (aliases), checked in the handler.
    pub lender: UncheckedAccount<'info>,
}

fn is_empty(info: &AccountInfo) -> bool {
    info.data_is_empty() && info.owner == &anchor_lang::solana_program::system_program::ID
}

/// fair / close − 1, signed WAD, rounded down.
fn implied_gap(price: u128, close: u128) -> Result<i128> {
    require!(close > 0, CoreError::Math);
    let r = U256::from(price) * U256::from(WAD) / U256::from(close);
    let r = i128::try_from(u128::try_from(r).map_err(|_| error!(CoreError::Math))?).map_err(|_| error!(CoreError::Math))?;
    r.checked_sub(WAD as i128).ok_or_else(|| error!(CoreError::Math))
}

/// The fair value as read from Pyth's push account (already matched to the asset's feed id).
#[derive(Clone, Copy, Debug)]
pub struct FairIn {
    /// `None` when the price is not positive or its exponent is outside Pyth's range.
    pub price_wad: Option<u128>,
    pub publish_ts: i64,
    pub conf_bps: u32,
    pub full: bool,
}

/// The lender's price: Scope's entry (Kamino) or Jupiter's cache.
#[derive(Clone, Copy, Debug)]
pub struct LenderIn {
    pub price_wad: u128,
    pub ts: i64,
    pub suspended: bool,
}

/// Everything `update_gap_feed` reads, as plain values. `None` means the input account was empty (missing).
#[derive(Clone, Copy, Debug)]
pub struct FeedIn<'a> {
    pub now: i64,
    pub closure_type: u8,
    pub close_ts: i64,
    /// The epoch's stored Friday close (0 when the epoch is absent or has none yet).
    pub close_price_wad: u128,
    pub fair: Option<FairIn>,
    pub lender: Option<LenderIn>,
    /// The lender price and the time it last changed, as the previous update stored them (`None` on the first update).
    pub prev_lender: Option<(u128, i64)>,
    /// The closure type's σ and finalised scenario set (`None`: no set).
    pub scenarios: Option<(u64, &'a [i16])>,
    pub paused: bool,
    pub earnings: bool,
    pub max_conf_bps: u32,
    pub shield_max_age_secs: i64,
    pub max_input_age_secs: i64,
}

/// What the feed stores. A number is 0 when its flag says its input did not pass.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FeedOut {
    pub flags: u32,
    pub sigma_wad: u64,
    pub probs_wad: [u64; 3],
    pub n_scen: u16,
    pub close_price_wad: u128,
    pub fair_price_wad: u128,
    pub fair_publish_ts: i64,
    pub fair_conf_bps: u32,
    pub fair_verified: u8,
    pub lender_price_wad: u128,
    pub lender_ts: i64,
    pub lender_since_ts: i64,
    pub implied_gap_fair_wad: i128,
    pub implied_gap_lender_wad: i128,
}

/// The feed's arithmetic and flag rules: pure, so the instruction and the off-chain helper (`examples/gap_feed.rs`, which
/// serves the public mainnet mode of the Oracle page) run the same code.
pub fn compute(i: &FeedIn) -> Result<FeedOut> {
    let mut o = FeedOut::default();
    if i.paused {
        o.flags |= feed_flag::PAUSED;
    }
    if i.earnings {
        o.flags |= feed_flag::EARNINGS_ASSET;
    }
    match i.scenarios {
        Some((sigma, z)) if sigma > 0 && !z.is_empty() && z.len() <= N_SCEN => {
            let set = credence_risk_core::SliceZ(z);
            for (p, x) in o.probs_wad.iter_mut().zip(THRESHOLDS_WAD) {
                *p = gap_prob_wad(&set, sigma, x).map_err(|_| error!(CoreError::Math))?;
            }
            o.sigma_wad = sigma;
            o.n_scen = z.len() as u16;
        }
        _ => o.flags |= feed_flag::NO_SCENARIOS,
    }
    if i.close_price_wad == 0 {
        o.flags |= feed_flag::NO_CLOSE;
    } else {
        o.close_price_wad = i.close_price_wad;
    }
    match i.fair {
        None => o.flags |= feed_flag::MISSING_FAIR,
        Some(f) => {
            o.fair_publish_ts = f.publish_ts;
            o.fair_conf_bps = f.conf_bps;
            o.fair_verified = f.full as u8;
            let mut ok = true;
            if !f.full {
                o.flags |= feed_flag::FAIR_UNVERIFIED;
                ok = false;
            }
            let age = i.now.checked_sub(f.publish_ts).ok_or(CoreError::Math)?;
            if age > i.shield_max_age_secs || age < -FUTURE_TOLERANCE_SECS {
                o.flags |= feed_flag::STALE_FAIR;
                ok = false;
            }
            if f.conf_bps > i.max_conf_bps {
                o.flags |= feed_flag::FAIR_OUTSIDE_CONF;
                ok = false;
            }
            match f.price_wad {
                Some(p) if ok => o.fair_price_wad = p,
                Some(_) => {}
                None => o.flags |= feed_flag::FAIR_UNVERIFIED,
            }
        }
    }
    match i.lender {
        None => o.flags |= feed_flag::MISSING_LENDER,
        Some(l) => {
            o.lender_ts = l.ts;
            if l.suspended {
                o.flags |= feed_flag::LENDER_SUSPENDED;
            } else {
                o.lender_price_wad = l.price_wad;
            }
            if l.price_wad > 0 && !l.suspended {
                // Unchanged since the previous sighting keeps its time; a new price (or a first sighting) starts now.
                o.lender_since_ts = match i.prev_lender {
                    Some((p, since)) if p == l.price_wad => since,
                    _ => i.now,
                };
                if i.now.saturating_sub(l.ts) > i.max_input_age_secs {
                    o.flags |= feed_flag::LENDER_STALE;
                }
                if o.close_price_wad > 0 && i.now > i.close_ts && i.now.saturating_sub(o.lender_since_ts) >= FROZEN_AFTER_SECS {
                    o.flags |= feed_flag::LENDER_FROZEN;
                }
            }
        }
    }
    if o.close_price_wad > 0 && o.fair_price_wad > 0 {
        o.implied_gap_fair_wad = implied_gap(o.fair_price_wad, o.close_price_wad)?;
    }
    if o.close_price_wad > 0 && o.lender_price_wad > 0 {
        o.implied_gap_lender_wad = implied_gap(o.lender_price_wad, o.close_price_wad)?;
    }
    Ok(o)
}

pub fn handle_update_gap_feed(ctx: Context<UpdateGapFeed>, ticker: Ticker) -> Result<()> {
    let a = ctx.accounts.asset.load()?;
    let cfg = &ctx.accounts.config;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let mut f = ctx.accounts.feed.load_mut()?;
    if f.updates > 0 {
        let next = f.last_update_slot.checked_add(f.min_update_slots as u64).ok_or(CoreError::Math)?;
        require!(clock.slot >= next, CoreError::FeedTooSoon);
    }

    // The closure, from the calendar: its type, close and next open.
    let (closure_id, t) = {
        let cal = ctx.accounts.calendar.load()?;
        require!(cal.finalized == 1, CoreError::NotFinalized);
        let s = &cal.sessions[..cal.n as usize];
        let id = feed_closure(s, now).ok_or(CoreError::InvalidParam)?;
        (id, epoch_times(s, id).ok_or(CoreError::InvalidParam)?)
    };

    // Scenario set of the closure type (PDA from the ticker and type).
    let scen_key = Pubkey::find_program_address(&[SEED_SCENARIOS, ticker.as_ref(), &[t.closure_type]], &crate::ID).0;
    require_keys_eq!(ctx.accounts.scenario.key(), scen_key, CoreError::NotThisScenarioSet);
    let scen_info: &AccountInfo = ctx.accounts.scenario.as_ref();
    let scen_data = scen_info.try_borrow_data()?;
    let mut scenarios: Option<(u64, &[i16])> = None;
    if scen_info.owner == &crate::ID && !scen_data.is_empty() {
        // Zero-copy read of the verified-owner account: discriminator and length first.
        require!(scen_data.len() == ScenarioSet::SIZE && scen_data[..8] == *ScenarioSet::DISCRIMINATOR, CoreError::NotThisScenarioSet);
        let s: &ScenarioSet = bytemuck::from_bytes(&scen_data[8..]);
        if s.finalized == 1 && s.n > 0 && (s.n as usize) <= N_SCEN {
            let sigma = if t.closure_type == closure::WEEKEND { a.sigma_wad } else { s.sigma_wad };
            scenarios = Some((sigma, &s.z[..s.n as usize]));
        }
    }

    // The epoch: its PDA from (ticker, closure id). Absent or still OPEN: no close.
    let epoch_key = Pubkey::find_program_address(&[SEED_EPOCH, ticker.as_ref(), &closure_id.to_le_bytes()], &crate::ID).0;
    require_keys_eq!(ctx.accounts.epoch.key(), epoch_key, CoreError::NotThisEpoch);
    let (mut close, mut close_source, mut epoch_st) = (0u128, 0u8, 0u8);
    let ep_info: &AccountInfo = ctx.accounts.epoch.as_ref();
    if ep_info.owner == &crate::ID && !ep_info.data_is_empty() {
        let e = Epoch::try_deserialize(&mut &ep_info.try_borrow_data()?[..])?;
        require!(e.ticker == ticker && e.closure_id == closure_id, CoreError::NotThisEpoch);
        epoch_st = e.state;
        if matches!(e.state, epoch_state::CLOSED | epoch_state::SETTLED | epoch_state::HALTED) && e.close_price_wad > 0 {
            close = e.close_price_wad;
            close_source = e.close_source;
        }
    }

    // Fair value: Pyth's push account for the asset's feed id.
    require_keys_eq!(ctx.accounts.fair.key(), push_account(&a.feed_xstock), CoreError::NotPushAccount);
    let fair_info: &AccountInfo = ctx.accounts.fair.as_ref();
    let fair = if is_empty(fair_info) {
        None
    } else {
        require_keys_eq!(*fair_info.owner, <PriceUpdateV2 as Owner>::owner(), CoreError::NotPushAccount);
        let u = PriceUpdateV2::try_deserialize(&mut &fair_info.try_borrow_data()?[..])?;
        let m = &u.price_message;
        require!(m.feed_id == a.feed_xstock, CoreError::WrongFeed);
        let p = price_wad(m.price, m.exponent);
        let conf_bps = match (p, m.price) {
            (Some(_), px) if px > 0 => u32::try_from(((m.conf as u128) * 10_000).div_ceil(px as u128)).unwrap_or(u32::MAX),
            _ => u32::MAX,
        };
        Some(FairIn { price_wad: p, publish_ts: m.publish_time, conf_bps, full: u.verification_level == VerificationLevel::Full })
    };

    // The lender's own price.
    let li: &AccountInfo = ctx.accounts.lender.as_ref();
    let lender_in = if a.lender == lender::JUPITER as u64 {
        require_keys_eq!(li.key(), a.lender_oracle, CoreError::NotLenderOracle);
        if is_empty(li) {
            None
        } else {
            let c = jupiter::read_cache(li, &a.lender_oracle)?;
            Some(LenderIn { price_wad: c.price_wad, ts: c.unix_timestamp, suspended: c.suspended })
        }
    } else {
        require_keys_eq!(li.key(), scope::SCOPE_PRICES, CoreError::NotScopePrices);
        if is_empty(li) {
            None
        } else {
            require_keys_eq!(*li.owner, scope::SCOPE_PROGRAM_ID, CoreError::NotScopePrices);
            let d = li.try_borrow_data()?;
            require!(d.len() == scope::ACCOUNT_LEN && d[..8] == scope::ORACLE_PRICES_DISC, CoreError::NotScopePrices);
            // An unset chain entry reads as missing, not as a price.
            scope::decode(&d, a.scope_chain).ok().map(|p| LenderIn { price_wad: p.price_wad, ts: p.unix_timestamp, suspended: false })
        }
    };

    let o = compute(&FeedIn {
        now,
        closure_type: t.closure_type,
        close_ts: t.close,
        close_price_wad: close,
        fair,
        lender: lender_in,
        prev_lender: if f.updates > 0 { Some((f.lender_price_wad(), f.lender_since_ts)) } else { None },
        scenarios,
        paused: cfg.paused,
        earnings: a.earnings == 1,
        max_conf_bps: cfg.max_conf_bps as u32,
        shield_max_age_secs: cfg.shield_max_age_secs as i64,
        max_input_age_secs: f.max_input_age_secs as i64,
    })?;

    f.flags = o.flags;
    f.closure_id = closure_id;
    f.closure_type = t.closure_type;
    f.close_source = if o.close_price_wad > 0 { close_source } else { 0 };
    f.epoch_state = epoch_st;
    f.close_ts = t.close;
    f.next_open = t.open;
    f.close_price = o.close_price_wad.to_le_bytes();
    f.fair_price = o.fair_price_wad.to_le_bytes();
    f.fair_publish_ts = o.fair_publish_ts;
    f.fair_conf_bps = o.fair_conf_bps;
    f.fair_verification = o.fair_verified;
    f.lender_price = o.lender_price_wad.to_le_bytes();
    f.lender_ts = o.lender_ts;
    f.lender_since_ts = o.lender_since_ts;
    f.implied_gap_fair = o.implied_gap_fair_wad.to_le_bytes();
    f.implied_gap_lender = o.implied_gap_lender_wad.to_le_bytes();
    f.sigma_wad = o.sigma_wad;
    f.n_scen = o.n_scen;
    [f.p_lt_5_wad, f.p_lt_8_wad, f.p_lt_12_wad] = o.probs_wad;
    f.last_update_slot = clock.slot;
    f.last_update_ts = now;
    f.updates = f.updates.checked_add(1).ok_or(CoreError::Math)?;
    emit!(GapFeedUpdated { ticker, closure_id, flags: o.flags, slot: clock.slot, ts: now });
    Ok(())
}

#[event]
pub struct GapFeedUpdated {
    pub ticker: Ticker,
    pub closure_id: u32,
    pub flags: u32,
    pub slot: u64,
    pub ts: i64,
}
