//! Task 1.2: the deployed program links `risk-core` and agrees with it off-chain.

use {
    anchor_lang::{solana_program::instruction::Instruction, InstructionData, ToAccountMetas},
    credence_risk_core::{gap_factor, U256},
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const WAD: u64 = 1_000_000_000_000_000_000;

fn run(z: i16, sigma: u64, dividend: u64, kappa: u64) -> Result<u128, String> {
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/credence_core.so"));
    svm.add_program(credence_core::id(), bytes).unwrap();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    let ix = Instruction::new_with_bytes(
        credence_core::id(),
        &credence_core::instruction::PingGapFactor { z, sigma, dividend, kappa }.data(),
        credence_core::accounts::Ping {}.to_account_metas(None),
    );
    let msg = Message::new_with_blockhash(&[ix], Some(&payer.pubkey()), &svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&payer]).unwrap();
    let meta = svm.send_transaction(tx).map_err(|e| format!("{:?}", e.err))?;
    Ok(u128::from_le_bytes(meta.return_data.data[..16].try_into().unwrap()))
}

#[test]
fn on_chain_gap_factor_matches_risk_core() {
    // −3σ weekend at σ = 1.2%, no dividend, κ = 0.5%.
    let (z, sigma, d, kappa) = (-3000i16, WAD / 1000 * 12, 0, WAD / 1000 * 5);
    let off = gap_factor(z, U256::from(sigma), U256::from(d), U256::from(kappa)).unwrap();
    assert_eq!(U256::from(run(z, sigma, d, kappa).unwrap()), off);
}

#[test]
fn on_chain_gap_factor_rejects_bad_input() {
    // κ above 100% is invalid in risk-core; the program must surface the error, not wrap or clamp.
    let r = run(-3000, WAD / 100, 0, 2 * WAD);
    assert!(r.is_err(), "expected failure, got {r:?}");
}
