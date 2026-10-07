//! Appendix A.1 golden vectors G-01…G-22 (Build Guide). Each test states the doc's expected figure and its
//! stated precision. Guide v1.1 states G-06..G-11 and G-17 with full-precision inputs, and with those the doc
//! figures follow exactly (no special-casing).

use alloy_primitives::B256;
use credence_risk_core::fixed::{collateral_value, health_factor_down};
use credence_risk_core::{
    blended_price, clear, cure_amounts, gap_factor_at, kinked_rate, liquidation_lot, preclose_lot,
    quote_cover, safe_ltv, senior_rate, settle_position, utilization, PremiumParams, SliceZ, U256,
    WAD,
};

// ───────────── helpers ─────────────

/// Parse a decimal string into fixed point with `dec` decimals (exact).
fn fx(s: &str, dec: u32) -> U256 {
    let (int, frac) = s.split_once('.').unwrap_or((s, ""));
    assert!(frac.len() as u32 <= dec, "{s} has more than {dec} decimals");
    let int: U256 = int.replace('_', "").parse().unwrap();
    let mut frac_s = frac.to_string();
    while (frac_s.len() as u32) < dec {
        frac_s.push('0');
    }
    let frac_v: U256 = if frac_s.is_empty() {
        U256::ZERO
    } else {
        frac_s.parse().unwrap()
    };
    int * U256::from(10u8).pow(U256::from(dec)) + frac_v
}
fn wad(s: &str) -> U256 {
    fx(s, 18)
}
fn usdc(s: &str) -> U256 {
    fx(s, 6)
}
fn tok(s: &str) -> U256 {
    fx(s, 18)
}
fn assert_close(got: U256, want: U256, tol: U256, what: &str) {
    let diff = if got > want { got - want } else { want - got };
    assert!(
        diff <= tol,
        "{what}: got {got}, want {want} ± {tol} (diff {diff})"
    );
}

const LT: &str = "0.8";
const H_STAR: &str = "1.1";
const LAMBDA: &str = "0.03";
const KAPPA: &str = "0.03";

fn rate_equity(u: U256) -> U256 {
    kinked_rate(u, wad("0.02"), wad("0.06"), wad("0.80"), wad("0.90")).unwrap()
}

// ───────────── G-01 … G-04: rates (F-4.6) ─────────────

#[test]
fn g01_kinked_rate_u85() {
    // 0.02 + 0.06 × 0.85 / 0.90 = 0.07666…  (exact, rounded down)
    assert_eq!(
        rate_equity(wad("0.85")),
        U256::from(76_666_666_666_666_666u128)
    );
}

#[test]
fn g02_kinked_rate_u80() {
    assert_eq!(
        rate_equity(wad("0.80")),
        U256::from(73_333_333_333_333_333u128)
    );
}

#[test]
fn g03_kinked_rate_scenario_b() {
    let u = utilization(usdc("182500"), usdc("230000")).unwrap();
    assert_close(
        rate_equity(u),
        wad("0.0728986"),
        U256::from(1_000_000_000_000u64),
        "G-03",
    );
}

#[test]
fn g04_senior_rate() {
    let r = rate_equity(wad("0.85"));
    let s = senior_rate(r, wad("0.85"), wad("0.10"), wad("0.10")).unwrap();
    assert_close(
        s,
        wad("0.0521333"),
        U256::from(1_000_000_000_000u64),
        "G-04",
    );
}

// ───────────── G-05 … G-08: safe LTV (F-4.2) ─────────────

fn g_safe(sigma: &str) -> U256 {
    safe_ltv(-5897, wad(sigma), U256::ZERO, wad(KAPPA), wad("0.75")).unwrap()
}

#[test]
fn g05_safe_ltv_sigma3_capped() {
    assert_eq!(g_safe("0.03"), wad("0.75"));
    // uncapped g = 0.79839 (±1e14)
    let g = safe_ltv(-5897, wad("0.03"), U256::ZERO, wad(KAPPA), WAD).unwrap();
    assert_close(
        g,
        wad("0.79839"),
        U256::from(100_000_000_000_000u64),
        "G-05 g",
    );
}

// v1.1: G-06..G-08 use the exact t₃ quantile z = −5.897362714633 (full precision, through `gap_factor_at`;
// the engine itself stores z as int16 thousandths, covered by G-05 and the differential suite).
const Z_T3: &str = "5.897362714633";

fn g_safe_exact(sigma: &str) -> U256 {
    let mv = wad(sigma) * wad(Z_T3) / WAD; // σ·|z| is exact in WAD for these inputs
    gap_factor_at(mv, true, U256::ZERO, wad(KAPPA))
        .unwrap()
        .min(wad("0.75"))
}

#[test]
fn g06_safe_ltv_sigma4() {
    assert_close(
        g_safe_exact("0.04"),
        wad("0.741182326672"),
        U256::from(1_000_000_000_000u64),
        "G-06",
    );
    // the int16 engine input z = −5897 stays within 1e14 (what the chain computes)
    assert_close(
        g_safe("0.04"),
        wad("0.741182"),
        U256::from(100_000_000_000_000u64),
        "G-06 int16",
    );
}

#[test]
fn g07_safe_ltv_sigma45() {
    assert_close(
        g_safe_exact("0.045"),
        wad("0.712580117506"),
        U256::from(1_000_000_000_000u64),
        "G-07",
    );
    assert_close(
        g_safe("0.045"),
        wad("0.712580"),
        U256::from(100_000_000_000_000u64),
        "G-07 int16",
    );
}

#[test]
fn g08_safe_ltv_sigma6() {
    assert_close(
        g_safe_exact("0.06"),
        wad("0.626773490008"),
        U256::from(1_000_000_000_000u64),
        "G-08",
    );
    assert_close(
        g_safe("0.06"),
        wad("0.626773"),
        U256::from(100_000_000_000_000u64),
        "G-08 int16",
    );
}

// ───────────── G-09 … G-11: cures (F-4.2), v1.1 full-precision LTV_s ─────────────

fn cures(d: &str, q: &str, v: &str, ltv_s: &str) -> credence_risk_core::Cures {
    cure_amounts(usdc(d), tok(q), wad(v), wad(ltv_s), 18, 6).unwrap()
}

#[test]
fn g09_cures() {
    let c = cures("13500", "100", "180", "0.741182326672");
    // exact: 13,500 − 0.741182326672 × 18,000 = 158.718119904 → rounded up to the micro-dollar
    assert_eq!(c.repay, usdc("158.718120"));
    assert_close(c.repay, usdc("158.72"), usdc("0.005"), "G-09 repay");
    assert_close(c.add_collateral, tok("1.1897"), tok("0.00005"), "G-09 add");
}

#[test]
fn g10_cures() {
    let c = cures("67028.99", "500", "180", "0.712580117506");
    // exact: 67,028.99 − 0.712580117506 × 90,000 = 2,896.77942446 → the doc's 2,896.78
    assert_eq!(c.repay, usdc("2896.779425"));
    assert_close(c.repay, usdc("2896.78"), usdc("0.005"), "G-10 repay");
    assert_close(c.add_collateral, tok("22.584"), tok("0.0005"), "G-10 add");
}

#[test]
fn g11_cures() {
    let c = cures("55535.10", "300", "250", "0.626773490008");
    // exact: 55,535.10 − 0.626773490008 × 75,000 = 8,527.0882494 → the doc's 8,527.09
    assert_eq!(c.repay, usdc("8527.088250"));
    assert_close(c.repay, usdc("8527.09"), usdc("0.005"), "G-11 repay");
    assert_close(c.add_collateral, tok("54.419"), tok("0.0005"), "G-11 add");
}

// ───────────── G-12 … G-16: liquidation lot (F-4.5a) ─────────────

fn lot(d: &str, q: &str, p: &str, r: &str) -> U256 {
    liquidation_lot(
        usdc(d),
        tok(q),
        wad(r),
        wad(p),
        wad(LT),
        wad(H_STAR),
        wad(LAMBDA),
        18,
        6,
    )
    .unwrap()
}

#[test]
fn g12_lot_priya_architecture() {
    assert_close(
        lot("13500", "100", "158.40", "153.648"),
        tok("58.5131"),
        tok("0.0001"),
        "G-12",
    );
}

#[test]
fn g13_lot_ben() {
    assert_close(
        lot("14809.35", "50", "364", "353.08"),
        tok("20.2286"),
        tok("0.0001"),
        "G-13",
    );
}

#[test]
fn g14_lot_priya_scenario_b() {
    assert_close(
        lot("13519.02", "100", "158.40", "153.648"),
        tok("59.0752"),
        tok("0.0001"),
        "G-14",
    );
}

#[test]
fn g15_lot_dev_full_close() {
    // raw x = 128.551 > q → full close
    assert_eq!(lot("22542.59", "100", "225", "218.25"), tok("100"));
    let raw: f64 = (1.1 * 22_542.59 - 100.0 * 225.0 * 0.8) / (1.1 * 218.25 * 0.97 - 225.0 * 0.8);
    assert!((raw - 128.551).abs() < 0.001, "raw lot {raw}");
}

#[test]
fn g16_lot_priya_scenario_a_full_close() {
    assert_eq!(lot("67066.69", "500", "126", "122.22"), tok("500"));
    let raw: f64 = (1.1 * 67_066.69 - 500.0 * 126.0 * 0.8) / (1.1 * 122.22 * 0.97 - 126.0 * 0.8);
    assert!((raw - 789.41).abs() < 0.01, "raw lot {raw}");
}

// ───────────── G-17: pre-close lot (F-4.5b, R-06) ─────────────

#[test]
fn g17_preclose_lot_maya() {
    let d = usdc("55536.02");
    let ltv_s = wad("0.626773490008");
    let x = preclose_lot(
        d,
        tok("300"),
        wad("250"),
        wad("247.50"),
        ltv_s,
        wad("0.01"),
        18,
        6,
    )
    .unwrap();
    // exact: 8,528.0082494 / 88.331627498 = 96.5453540363… → the doc's 96.5454
    assert_close(
        x,
        tok("96.545354036334"),
        tok("0.000000000001"),
        "G-17 exact",
    );
    assert_close(x, tok("96.5454"), tok("0.00005"), "G-17 doc");
    // cleared at R: LTV after = LTV_s (to rounding)
    let proceeds = collateral_value(x, wad("247.50"), 18, 6).unwrap();
    let debt_after = d - proceeds * U256::from(99u8) / U256::from(100u8);
    let coll_after = collateral_value(tok("300") - x, wad("250"), 18, 6).unwrap();
    let ltv = debt_after * WAD / coll_after;
    assert_close(ltv, ltv_s, wad("0.0000001"), "G-17 LTV after");
}

// ───────────── G-18 … G-19: clearing (F-4.5c) ─────────────

#[test]
fn g18_clear_two_bids() {
    let r = clear(
        &[tok("300"), tok("300")],
        &[wad("124.40"), wad("124.11")],
        &[B256::repeat_byte(1), B256::repeat_byte(2)],
        tok("500"),
        wad("122.22"),
    )
    .unwrap();
    assert_eq!(r.p_star, wad("124.11"));
    assert_eq!(r.fills, vec![tok("300"), tok("200")]);
    assert_eq!(r.q_pool, U256::ZERO);
}

#[test]
fn g19_clear_pool_backstop() {
    let r = clear(
        &[tok("60")],
        &[wad("219")],
        &[B256::ZERO],
        tok("100"),
        wad("218.25"),
    )
    .unwrap();
    assert_eq!(r.p_star, wad("219"));
    assert_eq!(r.fills, vec![tok("60")]);
    assert_eq!(r.q_pool, tok("40"));
    assert_eq!(
        blended_price(tok("100"), r.p_star, r.q_pool, wad("218.25")).unwrap(),
        wad("218.70")
    );
}

// ───────────── G-20 … G-21: settlement (F-4.5d) ─────────────

#[test]
fn g20_settle_partial() {
    let s = settle_position(
        tok("58.5131"),
        tok("100"),
        wad("156.024"),
        usdc("13500"),
        wad(LAMBDA),
        18,
        6,
    )
    .unwrap();
    assert!(!s.full_close);
    assert_close(s.proceeds, usdc("9129.45"), usdc("0.01"), "G-20 proceeds");
    assert_close(s.penalty, usdc("273.88"), usdc("0.01"), "G-20 penalty");
    assert_close(s.debt_after, usdc("4644.43"), usdc("0.01"), "G-20 debt");
    // HF at the open print P° = 158.40
    let c = collateral_value(tok("100") - tok("58.5131"), wad("158.40"), 18, 6).unwrap();
    let hf = health_factor_down(c, wad(LT), s.debt_after).unwrap();
    assert_close(hf, wad("1.13"), wad("0.005"), "G-20 HF");
    assert_eq!(s.proceeds, s.penalty + s.repaid + s.refund);
}

#[test]
fn g21_settle_short() {
    // full close of 100 tokens at p̄ = 218.70 → proceeds 21,870.00
    let s = settle_position(
        tok("100"),
        tok("100"),
        wad("218.70"),
        usdc("22542.59"),
        wad(LAMBDA),
        18,
        6,
    )
    .unwrap();
    assert!(s.full_close);
    assert_eq!(s.proceeds, usdc("21870"));
    assert_eq!(s.penalty, U256::ZERO);
    assert_eq!(s.shortfall, usdc("672.59"));
    assert_eq!(s.repaid, usdc("21870"));
}

// ───────────── G-22: premium under the t₃ stand-in (F-4.3) ─────────────

/// CDF of Student's t with 3 degrees of freedom.
fn t3_cdf(t: f64) -> f64 {
    let s3 = 3f64.sqrt();
    0.5 + (t / (s3 * (1.0 + t * t / 3.0)) + (t / s3).atan()) / std::f64::consts::PI
}

/// Inverse CDF of the unit-variance t₃ (T₃ / √3), by bisection.
fn t3_std_quantile(p: f64) -> f64 {
    let (mut lo, mut hi) = (-1e6f64, 1e6f64);
    for _ in 0..200 {
        let mid = 0.5 * (lo + hi);
        if t3_cdf(mid) < p {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    0.5 * (lo + hi) / 3f64.sqrt()
}

/// Independent reference: E[L] of the stated model by numerical integration against the t₃ density
/// (midpoint rule, 2M cells over [−3000σ, z0]). Shares no code with the engine.
fn g22_reference() -> (f64, f64, f64) {
    let s3 = 3f64.sqrt();
    let pdf = |z: f64| 6.0 * s3 / (std::f64::consts::PI * (3.0 + 3.0 * z * z).powi(2)) * s3;
    let (c, d, sigma, kappa) = (18_000.0f64, 13_500.0f64, 0.04f64, 0.03f64);
    let loss = |z: f64| (d - c * (1.0 + sigma * z).max(0.0) * (1.0 - kappa)).max(0.0);
    let z0 = (d / (c * (1.0 - kappa)) - 1.0) / sigma;
    let (a, n) = (-3000.0f64, 2_000_000usize);
    let h = (z0 - a) / n as f64;
    let el: f64 = (0..n)
        .map(|i| {
            let z = a + (i as f64 + 0.5) * h;
            loss(z) * pdf(z)
        })
        .sum::<f64>()
        * h;
    let es = el / 0.025; // every loss sits inside the worst 2.5%
    let premium = 2.0 * el + 0.15 * 3.0 / 365.0 * es;
    (el, es, premium)
}

#[test]
fn g22_premium_t3_closed_form() {
    // Deterministic scenario set: N mid-point quantiles of the unit-variance t₃, in thousandths of σ.
    const N: usize = 1_000_000;
    let set: Vec<i16> = (0..N)
        .map(|k| {
            let z = t3_std_quantile((k as f64 + 0.5) / N as f64) * 1000.0;
            z.round().clamp(i16::MIN as f64, i16::MAX as f64) as i16
        })
        .collect();
    let q = quote_cover(
        &SliceZ(&set),
        &PremiumParams {
            sigma: wad("0.04"),
            dividend: U256::ZERO,
            kappa: wad(KAPPA),
            collateral_value: usdc("18000"),
            debt_projected: usdc("13500"),
            closure_days: 3,
            util_after: U256::ZERO,
            theta: wad("1"),
            cost_of_cap: wad("0.15"),
            eta: wad("4"),
            beta: wad("0.975"),
            min_premium: U256::ZERO,
        },
    )
    .unwrap();
    let (el, es, prem) = g22_reference();
    println!(
        "G-22 engine: E[L] {} ES {} premium {}",
        q.expected_loss, q.expected_shortfall, q.premium
    );
    println!(
        "G-22 closed form: E[L] {el:.4} ES {es:.4} premium {prem:.4}; doc: 2.26 / 90.51 / 4.64"
    );
    let to_usdc = |x: f64| U256::from((x * 1e6).round() as u64);
    // The engine equals the closed form of the stated model to ±$0.01 (Appendix A precision).
    assert_close(q.expected_loss, to_usdc(el), usdc("0.01"), "G-22 E[L]");
    assert_close(q.expected_shortfall, to_usdc(es), usdc("0.01"), "G-22 ES");
    assert_close(q.premium, to_usdc(prem), usdc("0.01"), "G-22 premium");
    // Pinned values of the stated model. The doc's 2.26 / 90.51 / 4.64 do not follow from its inputs
    // (ADR-0102, sprint report "Spec issues").
    assert_close(
        q.expected_loss,
        usdc("2.14"),
        usdc("0.01"),
        "G-22 E[L] pinned",
    );
    assert_close(
        q.expected_shortfall,
        usdc("85.77"),
        usdc("0.01"),
        "G-22 ES pinned",
    );
    assert_close(q.premium, usdc("4.39"), usdc("0.01"), "G-22 premium pinned");
}
