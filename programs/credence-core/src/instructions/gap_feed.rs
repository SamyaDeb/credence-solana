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

/// The lender's price counts as "unmoved since the close" while its time is within this of the close.
pub const FROZEN_AFTER_CLOSE_SECS: i64 = 900;
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
    let mut flags = 0u32;
    if cfg.paused {
        flags |= feed_flag::PAUSED;
    }
    if a.earnings == 1 {
        flags |= feed_flag::EARNINGS_ASSET;
    }

    // The closure, from the calendar: its type, close and next open.
    let times = {
        let cal = ctx.accounts.calendar.load()?;
        require!(cal.finalized == 1, CoreError::NotFinalized);
        let s = &cal.sessions[..cal.n as usize];
        let id = feed_closure(s, now).ok_or(CoreError::InvalidParam)?;
        (id, epoch_times(s, id).ok_or(CoreError::InvalidParam)?)
    };
    let (closure_id, t) = times;

    // Scenario set of the closure type: σ and P(gap < −x). Missing or unfinalised: flagged, no numbers.
    let scen_key = Pubkey::find_program_address(&[SEED_SCENARIOS, ticker.as_ref(), &[t.closure_type]], &crate::ID).0;
    require_keys_eq!(ctx.accounts.scenario.key(), scen_key, CoreError::NotThisScenarioSet);
    let (mut sigma, mut probs, mut n_scen) = (0u64, [0u64; 3], 0u16);
    let scen_info: &AccountInfo = ctx.accounts.scenario.as_ref();
    if scen_info.owner == &crate::ID && !scen_info.data_is_empty() {
        // Zero-copy read of the verified-owner account: discriminator and length first.
        let d = scen_info.try_borrow_data()?;
        require!(d.len() == ScenarioSet::SIZE && d[..8] == *ScenarioSet::DISCRIMINATOR, CoreError::NotThisScenarioSet);
        let s: &ScenarioSet = bytemuck::from_bytes(&d[8..]);
        if s.finalized == 1 && s.n > 0 && (s.n as usize) <= N_SCEN {
            sigma = if t.closure_type == closure::WEEKEND { a.sigma_wad } else { s.sigma_wad };
            n_scen = s.n;
            let z = credence_risk_core::SliceZ(&s.z[..s.n as usize]);
            for (p, x) in probs.iter_mut().zip(THRESHOLDS_WAD) {
                *p = gap_prob_wad(&z, sigma, x).map_err(|_| error!(CoreError::Math))?;
            }
        }
    }
    if n_scen == 0 || sigma == 0 {
        flags |= feed_flag::NO_SCENARIOS;
        sigma = 0;
        probs = [0; 3];
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
        let stored = matches!(e.state, epoch_state::CLOSED | epoch_state::SETTLED | epoch_state::HALTED);
        if stored && e.close_price_wad > 0 {
            close = e.close_price_wad;
            close_source = e.close_source;
        }
    }
    if close == 0 {
        flags |= feed_flag::NO_CLOSE;
    }

    // Fair value: Pyth's push account for the asset's feed id.
    let (mut fair, mut fair_ts, mut fair_conf, mut fair_ver) = (0u128, 0i64, 0u32, 0u8);
    require_keys_eq!(ctx.accounts.fair.key(), push_account(&a.feed_xstock), CoreError::NotPushAccount);
    let fair_info: &AccountInfo = ctx.accounts.fair.as_ref();
    if is_empty(fair_info) {
        flags |= feed_flag::MISSING_FAIR;
    } else {
        require_keys_eq!(*fair_info.owner, <PriceUpdateV2 as Owner>::owner(), CoreError::NotPushAccount);
        let u = PriceUpdateV2::try_deserialize(&mut &fair_info.try_borrow_data()?[..])?;
        let m = &u.price_message;
        require!(m.feed_id == a.feed_xstock, CoreError::WrongFeed);
        fair_ts = m.publish_time;
        fair_ver = if u.verification_level == VerificationLevel::Full { 1 } else { 0 };
        let p = price_wad(m.price, m.exponent);
        fair_conf = match (p, m.price) {
            (Some(_), px) if px > 0 => u32::try_from(((m.conf as u128) * 10_000).div_ceil(px as u128)).unwrap_or(u32::MAX),
            _ => u32::MAX,
        };
        let age = now.checked_sub(fair_ts).ok_or(CoreError::Math)?;
        let mut ok = true;
        if fair_ver == 0 {
            flags |= feed_flag::FAIR_UNVERIFIED;
            ok = false;
        }
        if age > cfg.shield_max_age_secs as i64 || age < -FUTURE_TOLERANCE_SECS {
            flags |= feed_flag::STALE_FAIR;
            ok = false;
        }
        if fair_conf > cfg.max_conf_bps as u32 {
            flags |= feed_flag::FAIR_OUTSIDE_CONF;
            ok = false;
        }
        match p {
            Some(p) if ok => fair = p,
            Some(_) => {}
            None => {
                flags |= feed_flag::FAIR_UNVERIFIED;
            }
        }
    }

    // The lender's own price.
    let (mut lender_px, mut lender_ts) = (0u128, 0i64);
    let li = ctx.accounts.lender.to_account_info();
    if a.lender == lender::JUPITER as u64 {
        require_keys_eq!(li.key(), a.lender_oracle, CoreError::NotLenderOracle);
        if is_empty(&li) {
            flags |= feed_flag::MISSING_LENDER;
        } else {
            let c = jupiter::read_cache(&li, &a.lender_oracle)?;
            if c.suspended {
                flags |= feed_flag::LENDER_SUSPENDED;
            } else {
                lender_px = c.price_wad;
            }
            lender_ts = c.unix_timestamp;
        }
    } else {
        require_keys_eq!(li.key(), scope::SCOPE_PRICES, CoreError::NotScopePrices);
        if is_empty(&li) {
            flags |= feed_flag::MISSING_LENDER;
        } else {
            require_keys_eq!(*li.owner, scope::SCOPE_PROGRAM_ID, CoreError::NotScopePrices);
            let d = li.try_borrow_data()?;
            require!(d.len() == scope::ACCOUNT_LEN && d[..8] == scope::ORACLE_PRICES_DISC, CoreError::NotScopePrices);
            match scope::decode(&d, a.scope_chain) {
                Ok(p) => (lender_px, lender_ts) = (p.price_wad, p.unix_timestamp),
                Err(_) => flags |= feed_flag::MISSING_LENDER,
            }
        }
    }
    if lender_px > 0 {
        if now.saturating_sub(lender_ts) > f.max_input_age_secs as i64 {
            flags |= feed_flag::LENDER_STALE;
        }
        if close > 0 && now > t.close && lender_ts <= t.close.saturating_add(FROZEN_AFTER_CLOSE_SECS) {
            flags |= feed_flag::LENDER_FROZEN;
        }
    }

    // Implied gaps against the stored close (only from inputs that passed).
    let gap_fair = if close > 0 && fair > 0 { implied_gap(fair, close)? } else { 0 };
    let gap_lender = if close > 0 && lender_px > 0 { implied_gap(lender_px, close)? } else { 0 };

    f.flags = flags;
    f.closure_id = closure_id;
    f.closure_type = t.closure_type;
    f.close_source = close_source;
    f.epoch_state = epoch_st;
    f.close_ts = t.close;
    f.next_open = t.open;
    f.close_price = close.to_le_bytes();
    f.fair_price = fair.to_le_bytes();
    f.fair_publish_ts = fair_ts;
    f.fair_conf_bps = fair_conf;
    f.fair_verification = fair_ver;
    f.lender_price = lender_px.to_le_bytes();
    f.lender_ts = lender_ts;
    f.implied_gap_fair = gap_fair.to_le_bytes();
    f.implied_gap_lender = gap_lender.to_le_bytes();
    f.sigma_wad = sigma;
    f.n_scen = n_scen;
    [f.p_lt_5_wad, f.p_lt_8_wad, f.p_lt_12_wad] = probs;
    f.last_update_slot = clock.slot;
    f.last_update_ts = now;
    f.updates = f.updates.checked_add(1).ok_or(CoreError::Math)?;
    emit!(GapFeedUpdated { ticker, closure_id, flags, slot: clock.slot, ts: now });
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
