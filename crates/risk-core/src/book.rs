//! Curator book cover (Credence Solana, W5 task C2): one premium for a book of positions a payer covers, priced on the
//! book's own loss distribution instead of leg by leg (plan/02, "Curator book cover").
//!
//! Each leg i brings its standalone pricing components:
//! - `e` and `es`: E[L] and ES_β of its capped payout loss, from the term that sets its standalone premium (a single
//!   asset's 3,000-point set, or for a multi-collateral position the joint or marginal term with the larger base);
//! - `loading`: its Liquidation Shield loading;
//! - its capped payout loss in each of the K joint scenarios (summed over legs into one vector by the caller).
//!
//! The book:
//!
//! ```text
//! E_B  = Σ E_i                                   expected loss is additive (exact)
//! ES_J = ES_β of Σ_i L_ij over n_all closures    (the joint set, as `quote_joint`)
//! ES_B = min(Σ ES_i, max(ES_J, max_i ES_i))      subadditive, never below the riskiest leg's
//! π_B  = max(min_premium, m(u)·[(1 + θ)E_B + c·τ·ES_B]) + Σ loading_i
//! ```
//!
//! A one-leg book is the leg's standalone premium (ES_B = ES_1). Every step rounds UP (against the payer).
//! Refund shares (a superseded or closed leg) round DOWN: [`leg_share`].

use crate::fixed::{ceil_div, mul_div_up, mul_wad_up, MathError, MathResult, WAD};
use alloy_primitives::U256;

/// F-4.3 parameters shared by the book and its legs (WAD ratios, loan units).
#[derive(Clone, Copy, Debug)]
pub struct BookParams {
    /// Closures the K joint scenarios stand for (564).
    pub n_all: u32,
    /// τ × 365 (3 for a weekend).
    pub closure_days: u16,
    /// θ, the loading on the expected loss, WAD.
    pub theta: U256,
    /// c, the cost of capital per year, WAD.
    pub cost_of_cap: U256,
    /// η of m(u) = 1 + η u², WAD.
    pub eta: U256,
    /// β of the expected shortfall, WAD.
    pub beta: U256,
    /// One floor per book, loan units.
    pub min_premium: U256,
}

/// The running sums a book keeps over its legs (the on-chain `Book` stores exactly these).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BookSums {
    /// Σ E_i.
    pub e: u64,
    /// Σ ES_i.
    pub es: u64,
    /// max_i ES_i (may stay above the live legs' max after a leg leaves: conservative, against the payer).
    pub es_max: u64,
    /// Σ loading_i.
    pub loading: u64,
}

/// A book quote, loan units.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BookQuote {
    /// π_B, rounded UP.
    pub premium: U256,
    /// `m(u)·[(1 + θ)E_B + c·τ·ES_B]` before the floor, rounded UP.
    pub base: U256,
    /// ES_J of the summed joint vector.
    pub es_joint: U256,
    /// ES_B used.
    pub es_book: U256,
}

/// One leg as the reference function takes it.
#[derive(Clone, Debug)]
pub struct BookLeg {
    /// E_i.
    pub e: u64,
    /// ES_i.
    pub es: u64,
    /// Shield loading_i.
    pub loading: u64,
    /// Capped payout loss per joint scenario (K values).
    pub losses: alloc::vec::Vec<u64>,
}

/// `(E, ES_β)` of a loss vector over `n_all` closures (the `n_all − K` closures outside it count as 0), each rounded UP:
/// `E = ⌈Σ L / n_all⌉`, `ES = ⌈Σ worst m / m⌉` with `m = ⌈(1 − β) n_all⌉` (at least 1). As `multi::quote_joint`.
pub fn joint_e_es(losses: &[u64], n_all: u32, beta: U256) -> MathResult<(U256, U256)> {
    let n = n_all as usize;
    if n == 0 || losses.len() > n || beta >= WAD {
        return Err(MathError::InvalidInput);
    }
    let mut sorted: alloc::vec::Vec<u64> = losses.to_vec();
    sorted.sort_unstable_by(|a, b| b.cmp(a));
    let total: U256 = sorted.iter().fold(U256::ZERO, |a, x| a + U256::from(*x));
    let e = ceil_div(total, U256::from(n as u64))?;
    let m = mul_div_up(WAD - beta, U256::from(n as u64), WAD)?.max(U256::from(1u8)).to::<usize>();
    let worst: U256 = sorted.iter().take(m).fold(U256::ZERO, |a, x| a + U256::from(*x));
    Ok((e, ceil_div(worst, U256::from(m as u64))?))
}

/// The unscaled base `(1 + θ)·E + c·τ·ES`, rounded UP, exactly as F-4.3 (`premium::finish_quote`) builds it.
pub fn base(e: U256, es: U256, p: &BookParams) -> MathResult<U256> {
    let tau = mul_div_up(U256::from(p.closure_days), WAD, U256::from(365u16))?;
    let loaded = mul_wad_up(WAD.checked_add(p.theta).ok_or(MathError::Overflow)?, e)?;
    let capital = mul_wad_up(mul_wad_up(p.cost_of_cap, tau)?, es)?;
    loaded.checked_add(capital).ok_or(MathError::Overflow)
}

/// m(u) = 1 + η u², rounded UP.
pub fn util_mult(util_after: U256, p: &BookParams) -> MathResult<U256> {
    WAD.checked_add(mul_wad_up(p.eta, mul_wad_up(util_after, util_after)?)?).ok_or(MathError::Overflow)
}

/// π_B from the book's sums and its summed joint loss vector at utilisation `util_after` (WAD).
pub fn book_premium_from_sums(s: &BookSums, joint: &[u64], util_after: U256, p: &BookParams) -> MathResult<BookQuote> {
    let (_, es_joint) = joint_e_es(joint, p.n_all, p.beta)?;
    let es_sum = U256::from(s.es);
    let es_book = es_sum.min(es_joint.max(U256::from(s.es_max)));
    let base = mul_wad_up(util_mult(util_after, p)?, base(U256::from(s.e), es_book, p)?)?;
    let premium = base.max(p.min_premium).checked_add(U256::from(s.loading)).ok_or(MathError::Overflow)?;
    Ok(BookQuote { premium, base, es_joint, es_book })
}

/// The reference: sums the legs (order does not matter) and prices the book.
pub fn book_premium(legs: &[BookLeg], util_after: U256, p: &BookParams) -> MathResult<BookQuote> {
    let k = legs.first().map(|l| l.losses.len()).ok_or(MathError::InvalidInput)?;
    let mut joint = alloc::vec![0u64; k];
    let mut s = BookSums::default();
    for l in legs {
        if l.losses.len() != k {
            return Err(MathError::InvalidInput);
        }
        for (j, x) in joint.iter_mut().zip(&l.losses) {
            *j = j.checked_add(*x).ok_or(MathError::Overflow)?;
        }
        s = add_leg(&s, l.e, l.es, l.loading)?;
    }
    book_premium_from_sums(&s, &joint, util_after, p)
}

/// The sums with one more leg.
pub fn add_leg(s: &BookSums, e: u64, es: u64, loading: u64) -> MathResult<BookSums> {
    let o = MathError::Overflow;
    Ok(BookSums {
        e: s.e.checked_add(e).ok_or(o)?,
        es: s.es.checked_add(es).ok_or(o)?,
        es_max: s.es_max.max(es),
        loading: s.loading.checked_add(loading).ok_or(o)?,
    })
}

/// A leg's standalone premium before the floor: `m(u)·base_i + loading_i`, rounded UP (what the property compares to).
pub fn standalone_unfloored(e: u64, es: u64, loading: u64, util_after: U256, p: &BookParams) -> MathResult<U256> {
    let b = mul_wad_up(util_mult(util_after, p)?, base(U256::from(e), U256::from(es), p)?)?;
    b.checked_add(U256::from(loading)).ok_or(MathError::Overflow)
}

/// A leg's refund weight `w_i = max(1, base_i + loading_i)` (its standalone cost before the floor and m(u)); the 1
/// shares a floor-priced book evenly among riskless legs.
pub fn leg_weight(e: u64, es: u64, loading: u64, p: &BookParams) -> MathResult<u64> {
    let w = base(U256::from(e), U256::from(es), p)?.checked_add(U256::from(loading)).ok_or(MathError::Overflow)?;
    u64::try_from(w.max(U256::from(1u8))).map_err(|_| MathError::Overflow)
}

/// A leg's share of the book's net premium `net`: `⌊net × w / w_total⌋`, rounded DOWN (against the payer), 0 when
/// `w_total` is 0. Σ over any subset of legs ≤ `net`.
pub fn leg_share(net: u64, w: u64, w_total: u64) -> MathResult<u64> {
    if w_total == 0 {
        return Ok(0);
    }
    if w > w_total {
        return Err(MathError::InvalidInput);
    }
    Ok(((net as u128) * (w as u128) / (w_total as u128)) as u64)
}
