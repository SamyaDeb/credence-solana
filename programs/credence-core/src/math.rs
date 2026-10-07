//! Unit conversions between `risk-core` (WAD, U256) and on-chain storage. No risk math lives here: premiums, losses
//! and gap factors come from `credence-risk-core` (plan/03). Every function documents its rounding direction.

use credence_risk_core::U256;

/// 1e18.
pub const WAD: u128 = 1_000_000_000_000_000_000;

/// WAD → Q64.64, rounded DOWN: `floor(x × 2^64 / 1e18)`.
///
/// Used for gap factors: a smaller factor means a smaller covered value and a larger loss, which is conservative for
/// the vault (plan/02 §3). Returns `None` if the result does not fit in 128 bits (x ≥ 2^64 WAD); gap factors are
/// below 2 WAD.
pub fn wad_to_q64_down(x: U256) -> Option<u128> {
    if x.bit_len() > 128 {
        return None; // `<< 64` would wrap in U256
    }
    let q = (x << 64) / U256::from(WAD);
    u128::try_from(q).ok()
}

/// Q64.64 → WAD, rounded DOWN. Test and display helper.
pub fn q64_to_wad_down(q: u128) -> U256 {
    (U256::from(q) * U256::from(WAD)) >> 64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn q64_round_trip_never_rounds_up() {
        for x in [0u128, 1, WAD / 3, WAD / 2, WAD - 1, WAD, WAD + 7, 2 * WAD - 1] {
            let q = wad_to_q64_down(U256::from(x)).unwrap();
            let back = q64_to_wad_down(q);
            assert!(back <= U256::from(x), "x={x}");
            // Q64.64 resolution is 2^-64 ≈ 5.4e-20, finer than WAD's 1e-18: the loss is at most 1 WAD unit.
            assert!(U256::from(x) - back <= U256::from(1u8), "x={x}");
        }
        assert_eq!(wad_to_q64_down(U256::from(WAD)).unwrap(), 1u128 << 64);
    }
}
