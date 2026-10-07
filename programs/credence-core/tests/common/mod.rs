//! LiteSVM test harness for `credence-core`. Program binary: `anchor build --arch v0` output in `target/deploy`.
#![allow(dead_code)]

use anchor_lang::{
    prelude::Pubkey,
    solana_program::{instruction::Instruction, system_program},
    AccountDeserialize, InstructionData, ToAccountMetas,
};
use credence_core::{accounts as acc, instruction as ix, state::*, ConfigParams, CoreError};
use litesvm::{
    types::{FailedTransactionMetadata, TransactionMetadata},
    LiteSVM,
};
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

pub const WAD: u64 = 1_000_000_000_000_000_000;
pub const TOKEN_PROGRAM: Pubkey = anchor_lang::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022_PROGRAM: Pubkey = anchor_lang::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const USDC_MINT: Pubkey = anchor_lang::pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
pub const SPYX_MINT: Pubkey = anchor_lang::pubkey!("XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W");
pub const QQQX_MINT: Pubkey = anchor_lang::pubkey!("Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ");
pub const NVDAX_MINT: Pubkey = anchor_lang::pubkey!("Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh");

pub type TxResult = Result<TransactionMetadata, FailedTransactionMetadata>;

pub fn ticker(s: &str) -> Ticker {
    let mut t = [0u8; 8];
    t[..s.len()].copy_from_slice(s.as_bytes());
    t
}

pub fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &credence_core::ID).0
}
pub fn config_pda() -> Pubkey {
    pda(&[SEED_CONFIG])
}
pub fn asset_pda(t: &Ticker) -> Pubkey {
    pda(&[SEED_ASSET, t])
}
pub fn scen_pda(t: &Ticker, closure_type: u8) -> Pubkey {
    pda(&[SEED_SCENARIOS, t, &[closure_type]])
}
pub fn joint_pda(version: u32) -> Pubkey {
    pda(&[SEED_JOINT, &version.to_le_bytes()])
}
pub fn vault_pda() -> Pubkey {
    pda(&[SEED_VAULT])
}
pub fn vault_usdc_pda() -> Pubkey {
    pda(&[SEED_VAULT_USDC])
}
pub fn shares_pda() -> Pubkey {
    pda(&[SEED_SHARES])
}

/// Packed SPL Token account (165 bytes, state Initialized).
pub fn token_account_data(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Vec<u8> {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1; // AccountState::Initialized
    d
}

/// SHA-256 over little-endian i16 values, computed independently of the program.
pub fn sha256_i16(chunks: &[&[i16]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for c in chunks {
        for v in *c {
            h.update(v.to_le_bytes());
        }
    }
    h.finalize().into()
}

pub fn default_params(guardian: Pubkey, keeper: Pubkey) -> ConfigParams {
    ConfigParams {
        guardian,
        keeper,
        u_max_wad: WAD / 2,          // 50%
        max_asset_share_wad: WAD / 2, // 50%
        theta_wad: WAD / 5,           // 20% loading
        cost_of_cap_wad: WAD / 10,    // 10% per year
        eta_wad: WAD,                 // m(u) = 1 + u²
        beta_wad: WAD / 1000 * 975,   // ES at 97.5%
        kappa_wad: 0,                 // Gap Payout: no liquidation cost (plan/02 §2)
        min_premium: 1_000_000,       // 1 USDC
        fee_bps: 0,
    }
}

pub fn asset_params(sigma_wad: u64, joint_column: u8) -> credence_core::AssetParams {
    credence_core::AssetParams {
        feed_equity: [1; 32],
        feed_xstock: [2; 32],
        feed_redemption: [3; 32],
        kamino_reserves: [Pubkey::default(); 2],
        sigma_wad,
        dividend_wad: 0,
        joint_column,
        enabled: true,
    }
}

/// Custom program error code for a `CoreError`.
pub fn code(e: CoreError) -> u32 {
    u32::from(e)
}

pub struct Env {
    pub svm: LiteSVM,
    pub admin: Keypair,
}

impl Env {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/credence_core.so"));
        svm.add_program(credence_core::ID, bytes).unwrap();
        let fixtures = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");
        for (name, key, owner) in [
            ("USDC", USDC_MINT, TOKEN_PROGRAM),
            ("SPYx", SPYX_MINT, TOKEN_2022_PROGRAM),
            ("QQQx", QQQX_MINT, TOKEN_2022_PROGRAM),
            ("NVDAx", NVDAX_MINT, TOKEN_2022_PROGRAM),
        ] {
            let data = std::fs::read(format!("{fixtures}/mint_{name}.bin")).unwrap();
            let lamports = svm.minimum_balance_for_rent_exemption(data.len());
            svm.set_account(key, Account { lamports, data, owner, executable: false, rent_epoch: 0 }).unwrap();
        }
        let admin = Keypair::new();
        svm.airdrop(&admin.pubkey(), 100_000_000_000).unwrap();
        Env { svm, admin }
    }

    /// Writes an SPL Token account (classic Token program) holding `amount`.
    pub fn put_token_account(&mut self, key: Pubkey, mint: &Pubkey, owner: &Pubkey, amount: u64) {
        let data = token_account_data(mint, owner, amount);
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm.set_account(key, Account { lamports, data, owner: TOKEN_PROGRAM, executable: false, rent_epoch: 0 }).unwrap();
    }

    /// New USDC account for `owner` holding `amount`.
    pub fn usdc_account(&mut self, owner: &Pubkey, amount: u64) -> Pubkey {
        let k = Pubkey::new_unique();
        self.put_token_account(k, &USDC_MINT, owner, amount);
        k
    }

    pub fn token_balance(&self, key: &Pubkey) -> u64 {
        u64::from_le_bytes(self.data(key)[64..72].try_into().unwrap())
    }

    /// SPL mint supply.
    pub fn mint_supply(&self, mint: &Pubkey) -> u64 {
        u64::from_le_bytes(self.data(mint)[36..44].try_into().unwrap())
    }

    pub fn funded(&mut self) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
        k
    }

    /// Sends `ixs` with a 1.4M compute-unit limit; the first signer pays.
    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TxResult {
        let mut all = vec![ComputeBudgetInstruction::set_compute_unit_limit(1_400_000)];
        all.extend_from_slice(ixs);
        self.svm.expire_blockhash();
        let msg = Message::new_with_blockhash(&all, Some(&signers[0].pubkey()), &self.svm.latest_blockhash());
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
        self.svm.send_transaction(tx)
    }

    pub fn send_admin(&mut self, ixs: &[Instruction]) -> TxResult {
        let admin = self.admin.insecure_clone();
        self.send(ixs, &[&admin])
    }

    pub fn data(&self, key: &Pubkey) -> Vec<u8> {
        self.svm.get_account(key).expect("account exists").data
    }

    pub fn anchor<T: AccountDeserialize>(&self, key: &Pubkey) -> T {
        T::try_deserialize(&mut self.data(key).as_slice()).unwrap()
    }

    /// Zero-copy accounts: skip the 8-byte discriminator and cast.
    pub fn zc<T: bytemuck::Pod>(&self, key: &Pubkey) -> T {
        let d = self.data(key);
        *bytemuck::from_bytes::<T>(&d[8..8 + core::mem::size_of::<T>()])
    }

    // -----------------------------------------------------------------------------------------------------------
    // Instruction builders
    // -----------------------------------------------------------------------------------------------------------

    pub fn ix_init_config(&self, admin: &Pubkey, params: ConfigParams) -> Instruction {
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::InitConfig { params }.data(),
            acc::InitConfig {
                admin: *admin,
                config: config_pda(),
                usdc_mint: USDC_MINT,
                token_program: TOKEN_PROGRAM,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_set_params(&self, admin: &Pubkey, params: ConfigParams) -> Instruction {
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::SetParams { params }.data(),
            acc::SetParams { admin: *admin, config: config_pda() }.to_account_metas(None),
        )
    }

    pub fn ix_add_asset(&self, admin: &Pubkey, t: Ticker, mint: Pubkey, params: credence_core::AssetParams) -> Instruction {
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::AddAsset { ticker: t, params }.data(),
            acc::AddAsset {
                admin: *admin,
                config: config_pda(),
                asset: asset_pda(&t),
                mint,
                token_program: TOKEN_2022_PROGRAM,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_update_asset(&self, admin: &Pubkey, t: Ticker, params: credence_core::AssetParams) -> Instruction {
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::UpdateAsset { ticker: t, params }.data(),
            acc::UpdateAsset { admin: *admin, config: config_pda(), asset: asset_pda(&t) }.to_account_metas(None),
        )
    }

    pub fn ix_init_scen(&self, admin: &Pubkey, t: Ticker, closure_type: u8, n: u16) -> Instruction {
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::InitScenarioSet { ticker: t, closure_type, n }.data(),
            acc::InitScenarioSet {
                admin: *admin,
                config: config_pda(),
                set: scen_pda(&t, closure_type),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_write_scen(&self, admin: &Pubkey, set: Pubkey, offset: u16, values: Vec<i16>) -> Instruction {
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::WriteScenarios { offset, values }.data(),
            acc::WriteScenarios { admin: *admin, config: config_pda(), set }.to_account_metas(None),
        )
    }

    pub fn ix_finalize_scen(&self, admin: &Pubkey, set: Pubkey, asset: Pubkey, hash: [u8; 32]) -> Instruction {
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::FinalizeScenarioSet { expected_hash: hash }.data(),
            acc::FinalizeScenarioSet { admin: *admin, config: config_pda(), set, asset }.to_account_metas(None),
        )
    }

    pub fn ix_init_joint(&self, admin: &Pubkey, version: u32, tickers: Vec<Ticker>) -> Instruction {
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::InitJointSet { version, tickers }.data(),
            acc::InitJointSet {
                admin: *admin,
                config: config_pda(),
                set: joint_pda(version),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_write_joint(&self, admin: &Pubkey, set: Pubkey, column: u8, offset: u16, values: Vec<i16>) -> Instruction {
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::WriteJoint { column, offset, values }.data(),
            acc::WriteJoint { admin: *admin, config: config_pda(), set }.to_account_metas(None),
        )
    }

    pub fn ix_finalize_joint(&self, admin: &Pubkey, set: Pubkey, hash: [u8; 32]) -> Instruction {
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::FinalizeJointSet { expected_hash: hash }.data(),
            acc::FinalizeJointSet { admin: *admin, config: config_pda(), set }.to_account_metas(None),
        )
    }

    pub fn ix_compute_gf(&self, admin: &Pubkey, asset: Pubkey, joint: Pubkey, start: u16, count: u16) -> Instruction {
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::ComputeGapFactors { start, count }.data(),
            acc::ComputeGapFactors { admin: *admin, config: config_pda(), asset, joint }.to_account_metas(None),
        )
    }

    pub fn ix_init_vault(&self, admin: &Pubkey, fee_account: Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::InitVault {}.data(),
            acc::InitVault {
                admin: *admin,
                config: config_pda(),
                vault: vault_pda(),
                vault_usdc: vault_usdc_pda(),
                share_mint: shares_pda(),
                usdc_mint: USDC_MINT,
                fee_account,
                token_program: TOKEN_PROGRAM,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_deposit(&self, depositor: &Pubkey, depositor_usdc: Pubkey, depositor_shares: Pubkey, amount: u64) -> Instruction {
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::Deposit { amount }.data(),
            acc::Deposit {
                depositor: *depositor,
                config: config_pda(),
                vault: vault_pda(),
                vault_usdc: vault_usdc_pda(),
                share_mint: shares_pda(),
                depositor_usdc,
                depositor_shares,
                token_program: TOKEN_PROGRAM,
            }
            .to_account_metas(None),
        )
    }

    // -----------------------------------------------------------------------------------------------------------
    // Flows
    // -----------------------------------------------------------------------------------------------------------

    /// Creates the vault with a fresh fee account; returns the fee account.
    pub fn init_vault(&mut self) -> Pubkey {
        let a = self.admin.pubkey();
        let fee = self.usdc_account(&a, 0);
        let ix = self.ix_init_vault(&a, fee);
        self.send_admin(&[ix]).unwrap();
        fee
    }

    /// An LP with `usdc` USDC and an empty share account: (keypair, usdc account, share account).
    pub fn lp(&mut self, usdc: u64) -> (Keypair, Pubkey, Pubkey) {
        let k = self.funded();
        let u = self.usdc_account(&k.pubkey(), usdc);
        let s = Pubkey::new_unique();
        self.put_token_account(s, &shares_pda(), &k.pubkey(), 0);
        (k, u, s)
    }

    /// Rewrites fields of the Vault account in place (tests only: e.g. simulate released premiums).
    pub fn edit_vault(&mut self, f: impl FnOnce(&mut Vault)) {
        let key = vault_pda();
        let mut acc = self.svm.get_account(&key).unwrap();
        let mut v = Vault::try_deserialize(&mut acc.data.as_slice()).unwrap();
        f(&mut v);
        let mut data = Vec::with_capacity(acc.data.len());
        anchor_lang::AccountSerialize::try_serialize(&v, &mut data).unwrap();
        data.resize(acc.data.len(), 0);
        acc.data = data;
        self.svm.set_account(key, acc).unwrap();
    }

    pub fn init_config(&mut self) {
        let a = self.admin.pubkey();
        let ix = self.ix_init_config(&a, default_params(a, a));
        self.send_admin(&[ix]).unwrap();
    }

    pub fn add_asset(&mut self, t: &str, mint: Pubkey, sigma_wad: u64, joint_column: u8) {
        let a = self.admin.pubkey();
        let ix = self.ix_add_asset(&a, ticker(t), mint, asset_params(sigma_wad, joint_column));
        self.send_admin(&[ix]).unwrap();
    }

    /// Uploads a scenario set in chunks of `chunk` values and finalises it.
    pub fn upload_scenarios(&mut self, t: &str, z: &[i16], chunk: usize) -> TxResult {
        let (a, tk) = (self.admin.pubkey(), ticker(t));
        let set = scen_pda(&tk, closure::WEEKEND);
        let ix = self.ix_init_scen(&a, tk, closure::WEEKEND, z.len() as u16);
        self.send_admin(&[ix])?;
        for (i, c) in z.chunks(chunk).enumerate() {
            let ix = self.ix_write_scen(&a, set, (i * chunk) as u16, c.to_vec());
            self.send_admin(&[ix])?;
        }
        let ix = self.ix_finalize_scen(&a, set, asset_pda(&tk), sha256_i16(&[z]));
        self.send_admin(&[ix])
    }

    /// Uploads a joint set (`columns[a]` for `tickers[a]`) and finalises it.
    pub fn upload_joint(&mut self, version: u32, tickers: &[&str], columns: &[Vec<i16>], chunk: usize) -> TxResult {
        let a = self.admin.pubkey();
        let set = joint_pda(version);
        let ix = self.ix_init_joint(&a, version, tickers.iter().map(|t| ticker(t)).collect());
        self.send_admin(&[ix])?;
        for (c, col) in columns.iter().enumerate() {
            for (i, part) in col.chunks(chunk).enumerate() {
                let ix = self.ix_write_joint(&a, set, c as u8, (i * chunk) as u16, part.to_vec());
                self.send_admin(&[ix])?;
            }
        }
        let refs: Vec<&[i16]> = columns.iter().map(|c| c.as_slice()).collect();
        let ix = self.ix_finalize_joint(&a, set, sha256_i16(&refs));
        self.send_admin(&[ix])
    }

    /// Computes all K gap factors in chunks; returns the compute units of each chunk.
    pub fn compute_gap_factors(&mut self, t: &str, version: u32, chunk: u16) -> Result<Vec<u64>, FailedTransactionMetadata> {
        let a = self.admin.pubkey();
        let mut cus = vec![];
        let mut start = 0u16;
        while (start as usize) < K {
            let n = chunk.min(K as u16 - start);
            let ix = self.ix_compute_gf(&a, asset_pda(&ticker(t)), joint_pda(version), start, n);
            cus.push(self.send_admin(&[ix])?.compute_units_consumed);
            start += n;
        }
        Ok(cus)
    }
}

/// Asserts the transaction failed with the given custom error code.
pub fn assert_err(r: TxResult, expected: u32) {
    match r {
        Ok(_) => panic!("expected error {expected}, transaction succeeded"),
        Err(e) => {
            let s = format!("{:?}", e.err);
            assert!(s.contains(&format!("Custom({expected})")), "expected Custom({expected}), got {s}\n{:#?}", e.meta.logs);
        }
    }
}

/// Asserts the transaction failed (any reason).
pub fn assert_fails(r: TxResult) {
    assert!(r.is_err(), "expected failure, transaction succeeded");
}
