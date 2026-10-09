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
pub const PYUSD_MINT: Pubkey = anchor_lang::pubkey!("2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo");
pub const SPYX_MINT: Pubkey = anchor_lang::pubkey!("XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W");
pub const QQQX_MINT: Pubkey = anchor_lang::pubkey!("Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ");
pub const NVDAX_MINT: Pubkey = anchor_lang::pubkey!("Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh");

pub const KLEND: Pubkey = anchor_lang::pubkey!("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
pub const XSTOCKS_MARKET: Pubkey = anchor_lang::pubkey!("5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua");
pub const OBLIGATION_47WN: Pubkey = anchor_lang::pubkey!("47wNsqpypn5t1nhXW992P3QGRwMDZFbmsvNaMm6vT58N");
pub const RESERVE_SPYX: Pubkey = anchor_lang::pubkey!("UvXjBuC7YZYaGB9Rn1PpBD1GySmjzunXgE8Zev9ua8d");
pub const RESERVE_QQQX: Pubkey = anchor_lang::pubkey!("2jerdAXR8r2B6z3P7P6VgSiePQX7wqcpbEqdDbm8mgeB");
pub const RESERVE_NVDAX: Pubkey = anchor_lang::pubkey!("7B66Az3tJhAo4bLkX8PzTixQ9ZGyHkkjxfVLhF26sP5q");
pub const SCOPE_PRICES: Pubkey = credence_core::oracle::scope::SCOPE_PRICES;
pub const RESERVE_USDC: Pubkey = anchor_lang::pubkey!("97zoywd8mPZsGTg8q1wdD2Wgkdrs2tqusp1Qqcxbyj7E");
/// Real-data tests start at Thu Oct 8, 2026, 12:00 ET, before the Oct 9 bell.
pub const OCT8_NOON_ET: i64 = 1_791_475_200;
pub const GROUP_OCT9: u32 = 20261009;
pub const REAL_TICKERS: [&str; 3] = ["SPYx", "QQQx", "NVDAx"];
pub const REAL_MINTS: [Pubkey; 3] = [SPYX_MINT, QQQX_MINT, NVDAX_MINT];

pub type TxResult = Result<TransactionMetadata, FailedTransactionMetadata>;

pub fn load_json(path: &str) -> serde_json::Value {
    let p = format!("{}/../../{path}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{p}: {e}"))).unwrap()
}
pub fn json_i16(v: &serde_json::Value) -> Vec<i16> {
    v.as_array().unwrap().iter().map(|x| x.as_i64().unwrap() as i16).collect()
}
pub fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!("{}/tests/fixtures/{name}.bin", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

/// klend obligation layout offsets used to edit the real fixture (see `credence_core::kamino::layout`).
pub mod ob {
    pub use credence_core::kamino::layout::*;
    pub fn put(d: &mut [u8], o: usize, b: &[u8]) {
        d[o..o + b.len()].copy_from_slice(b);
    }
    pub fn get_u128(d: &[u8], o: usize) -> u128 {
        u128::from_le_bytes(d[o..o + 16].try_into().unwrap())
    }
    /// Scales every debt field (amount, market values) by `num / den`, as if the owner had borrowed more.
    pub fn scale_debt(d: &mut [u8], num: u128, den: u128) {
        for o in [
            OB_BORROWS + BOR_BORROWED_AMOUNT_SF,
            OB_BORROWS + BOR_MARKET_VALUE_SF,
            OB_BORROWS + BOR_MARKET_VALUE_SF + 16, // borrow-factor-adjusted market value
            OB_BF_ADJUSTED_DEBT_VALUE_SF,
            OB_BORROWED_ASSETS_MARKET_VALUE_SF,
        ] {
            let v = get_u128(d, o) * num / den;
            put(d, o, &v.to_le_bytes());
        }
    }
}

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
pub fn calendar_pda() -> Pubkey {
    pda(&[SEED_CALENDAR, b"XNYS\0\0\0\0"])
}
pub fn loss_pda(group: u32) -> Pubkey {
    pda(&[SEED_LOSS, &group.to_le_bytes()])
}
pub fn epoch_pda(t: &Ticker, closure_id: u32) -> Pubkey {
    pda(&[SEED_EPOCH, t, &closure_id.to_le_bytes()])
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
pub fn share_escrow_pda() -> Pubkey {
    pda(&[SEED_SHARE_ESCROW])
}
pub fn deposit_ticket_pda(owner: &Pubkey, wait_group: u32) -> Pubkey {
    pda(&[SEED_DEPOSIT_TICKET, owner.as_ref(), &wait_group.to_le_bytes()])
}
pub fn withdraw_ticket_pda(owner: &Pubkey, wait_group: u32) -> Pubkey {
    pda(&[SEED_WITHDRAW_TICKET, owner.as_ref(), &wait_group.to_le_bytes()])
}

/// `Vault::newest_live` on a host copy.
pub fn live_newest(v: &Vault) -> u32 {
    v.newest_live()
}

pub fn policy_pda(epoch: &Pubkey, obligation: &Pubkey) -> Pubkey {
    pda(&[SEED_POLICY, epoch.as_ref(), obligation.as_ref()])
}

/// A synthetic Pyth update (price × 10^expo).
#[derive(Clone, Copy)]
pub struct Px {
    pub feed: [u8; 32],
    pub price: i64,
    pub conf: u64,
    pub expo: i32,
    pub publish_time: i64,
    pub full: bool,
    pub owner: Option<Pubkey>,
}
impl Px {
    /// `price_usd` with 8 decimals and a 0.01% confidence interval, fully verified.
    pub fn new(feed: [u8; 32], price_usd: f64, publish_time: i64) -> Self {
        let price = (price_usd * 1e8).round() as i64;
        Px { feed, price, conf: (price / 10_000) as u64, expo: -8, publish_time, full: true, owner: None }
    }
}

/// Arguments and accounts of one `buy_cover`.
pub struct BuyArgs {
    pub buyer: Pubkey,
    pub buyer_usdc: Pubkey,
    pub obligation: Pubkey,
    pub deposit_reserve: Pubkey,
    pub ticker: Ticker,
    pub closure_id: u32,
    pub max_payout: u64,
    pub max_premium: u64,
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
        kappa_wad: 0,                 // Gap Payout: no liquidation cost
        min_premium: 1_000_000,       // 1 USDC
        fee_bps: 0,
        max_conf_bps: 50,         // conf ≤ 0.5% of price
        xcheck_bps: 200,          // equity × multiplier within 2% of the xStock price
        close_window_secs: 60,
        xstock_settle_window_secs: 3600, // XSTOCK: push accounts update about every 14.5 min
        // Shield off (α = 0: no advances, no loading); tests/shield.rs turns it on with `shield_params`.
        shield_alpha_wad: 0,
        shield_buffer_wad: WAD / 50,
        shield_health_wad: 0,
        shield_lambda_wad: 2 * WAD,
        shield_max_age_secs: 36 * 3600,
        shield_start_before_open_secs: 48_600, // Sunday 20:00 ET before a 09:30 ET open
        shield_deadline_before_open_secs: 9_000, // Monday 07:00 ET
        shield_reserve_k_wad: 2 * WAD,           // reserve the advance at a fair value 2 σ_b below each scenario
        debt_growth_cap_wad: WAD / 200,          // interest counted up to 0.5% of the snapshot debt
        debt_growth_est_wad: WAD / 1000,         // premiums price 0.1% (a week at 5.5%)
        pyusd_mint: PYUSD_MINT,                  // W4: Sentora's debt
        sleeve_slippage_bps: 30,                 // fund_sleeve pays at most PYUSD price + 0.3%
    }
}

/// `default_params` with the W1 defaults: α 50%, b 2%, h 0, λ 2 (= 1 + θ at the deployed θ 1.0).
pub fn shield_params(guardian: Pubkey, keeper: Pubkey) -> ConfigParams {
    ConfigParams { shield_alpha_wad: WAD / 2, ..default_params(guardian, keeper) }
}

/// Real asset parameters from `data/onchain/assets.json` (feeds, Kamino reserves, σ).
pub fn real_asset_params(i: usize) -> credence_core::AssetParams {
    let a = &load_json("data/onchain/assets.json")[i];
    let pk = |v: &serde_json::Value| v.as_str().unwrap().parse::<Pubkey>().unwrap();
    credence_core::AssetParams {
        feed_equity: hex32(a["feeds"]["equity"].as_str().unwrap()),
        feed_xstock: hex32(a["feeds"]["xstock"].as_str().unwrap()),
        feed_redemption: hex32(a["feeds"]["redemption"].as_str().unwrap()),
        kamino_reserves: [pk(&a["kaminoReserves"][0]), pk(&a["kaminoReserves"][1])],
        sigma_wad: a["sigmaWad"].as_str().unwrap().parse().unwrap(),
        dividend_wad: 0,
        joint_column: a["jointColumn"].as_u64().unwrap() as u8,
        enabled: true,
        settle_source: 0,
        scope_chain: a["scopeChain"].as_u64().unwrap() as u16,
        basis_sigma_wad: 0,
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
        settle_source: 0,
        scope_chain: 0,
        basis_sigma_wad: 0,
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

    /// Writes an initialised SPL Token mint (no freeze authority).
    pub fn put_mint(&mut self, key: Pubkey, authority: &Pubkey, supply: u64, decimals: u8) {
        let mut d = vec![0u8; 82];
        d[0] = 1; // COption::Some(mint authority)
        d[4..36].copy_from_slice(authority.as_ref());
        d[36..44].copy_from_slice(&supply.to_le_bytes());
        d[44] = decimals;
        d[45] = 1; // initialised
        let lamports = self.svm.minimum_balance_for_rent_exemption(d.len());
        self.svm.set_account(key, Account { lamports, data: d, owner: TOKEN_PROGRAM, executable: false, rent_epoch: 0 }).unwrap();
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
                share_escrow: share_escrow_pda(),
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
                share_escrow: share_escrow_pda(),
                token_program: TOKEN_PROGRAM,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_request_deposit(&self, depositor: &Pubkey, depositor_usdc: Pubkey, amount: u64) -> Instruction {
        let wait = live_newest(&self.anchor::<Vault>(&vault_pda()));
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::RequestDeposit { amount }.data(),
            acc::RequestDeposit {
                depositor: *depositor,
                config: config_pda(),
                vault: vault_pda(),
                vault_usdc: vault_usdc_pda(),
                depositor_usdc,
                ticket: deposit_ticket_pda(depositor, wait),
                token_program: TOKEN_PROGRAM,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_request_withdraw(&self, owner: &Pubkey, owner_shares: Pubkey, shares: u64) -> Instruction {
        let wait = live_newest(&self.anchor::<Vault>(&vault_pda()));
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::RequestWithdraw { shares }.data(),
            acc::RequestWithdraw {
                owner: *owner,
                vault: vault_pda(),
                share_mint: shares_pda(),
                share_escrow: share_escrow_pda(),
                owner_shares,
                ticket: withdraw_ticket_pda(owner, wait),
                token_program: TOKEN_PROGRAM,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_process_deposit(&self, caller: &Pubkey, ticket: Pubkey, owner_shares: Pubkey, owner_usdc: Pubkey) -> Instruction {
        let t: QueueTicket = self.anchor(&ticket);
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::ProcessDeposit {}.data(),
            acc::ProcessDeposit {
                caller: *caller,
                config: config_pda(),
                vault: vault_pda(),
                vault_usdc: vault_usdc_pda(),
                share_mint: shares_pda(),
                ticket,
                owner: t.owner,
                owner_shares,
                share_escrow: share_escrow_pda(),
                owner_usdc,
                token_program: TOKEN_PROGRAM,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_process_withdrawal(&self, caller: &Pubkey, ticket: Pubkey, owner_usdc: Pubkey) -> Instruction {
        let t: QueueTicket = self.anchor(&ticket);
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::ProcessWithdrawal {}.data(),
            acc::ProcessWithdrawal {
                caller: *caller,
                config: config_pda(),
                vault: vault_pda(),
                vault_usdc: vault_usdc_pda(),
                share_mint: shares_pda(),
                share_escrow: share_escrow_pda(),
                ticket,
                owner: t.owner,
                owner_usdc,
                token_program: TOKEN_PROGRAM,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_set_paused(&self, authority: &Pubkey, paused: bool) -> Instruction {
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::SetPaused { paused }.data(),
            acc::SetPaused { authority: *authority, config: config_pda() }.to_account_metas(None),
        )
    }

    pub fn ix_init_calendar(&self, admin: &Pubkey, n: u16) -> Instruction {
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::InitCalendar { venue: *b"XNYS\0\0\0\0", n }.data(),
            acc::InitCalendar { admin: *admin, config: config_pda(), calendar: calendar_pda(), system_program: system_program::ID }
                .to_account_metas(None),
        )
    }

    pub fn ix_write_calendar(&self, admin: &Pubkey, offset: u16, sessions: Vec<SessionArg>) -> Instruction {
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::WriteCalendar { offset, sessions }.data(),
            acc::WriteCalendar { admin: *admin, config: config_pda(), calendar: calendar_pda() }.to_account_metas(None),
        )
    }

    pub fn ix_finalize_calendar(&self, admin: &Pubkey, hash: [u8; 32]) -> Instruction {
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::FinalizeCalendar { expected_hash: hash }.data(),
            acc::FinalizeCalendar { admin: *admin, config: config_pda(), calendar: calendar_pda() }.to_account_metas(None),
        )
    }

    pub fn ix_open_group(&self, payer: &Pubkey, group: u32) -> Instruction {
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::OpenGroup { group }.data(),
            acc::OpenGroup { payer: *payer, config: config_pda(), loss: loss_pda(group), system_program: system_program::ID }
                .to_account_metas(None),
        )
    }

    pub fn ix_open_epoch(&self, payer: &Pubkey, t: Ticker, closure_id: u32) -> Instruction {
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::OpenEpoch { ticker: t, closure_id }.data(),
            acc::OpenEpoch {
                payer: *payer,
                config: config_pda(),
                asset: asset_pda(&t),
                calendar: calendar_pda(),
                loss: loss_pda(closure_id),
                epoch: epoch_pda(&t, closure_id),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    // -----------------------------------------------------------------------------------------------------------
    // Flows
    // -----------------------------------------------------------------------------------------------------------

    pub fn ix_buy_cover(&self, b: &BuyArgs) -> Instruction {
        let epoch = epoch_pda(&b.ticker, b.closure_id);
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::BuyCover { ticker: b.ticker, closure_id: b.closure_id, max_payout: b.max_payout, max_premium: b.max_premium }
                .data(),
            acc::BuyCover {
                buyer: b.buyer,
                config: config_pda(),
                asset: asset_pda(&b.ticker),
                scenarios: scen_pda(&b.ticker, closure::WEEKEND),
                epoch,
                loss: loss_pda(b.closure_id),
                vault: vault_pda(),
                vault_usdc: vault_usdc_pda(),
                share_mint: shares_pda(),
                fee_account: self.anchor::<Vault>(&vault_pda()).fee_account,
                buyer_usdc: b.buyer_usdc,
                obligation: b.obligation,
                deposit_reserve: b.deposit_reserve,
                borrow_reserve: RESERVE_USDC,
                policy: policy_pda(&epoch, &b.obligation),
                token_program: TOKEN_PROGRAM,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    /// Writes a Pyth `PriceUpdateV2` owned by the pro-compatible receiver at a fresh address; returns it.
    pub fn put_price(&mut self, p: &Px) -> Pubkey {
        self.put_price_at(Pubkey::new_unique(), p)
    }

    /// Writes `p` into Pyth's push account for its feed (XSTOCK source), replacing what it held; returns the address.
    pub fn put_push(&mut self, p: &Px) -> Pubkey {
        self.put_price_at(credence_core::oracle::push_account(&p.feed), p)
    }

    pub fn put_price_at(&mut self, key: Pubkey, p: &Px) -> Pubkey {
        use pyth_solana_receiver_sdk::price_update::{PriceFeedMessage, PriceUpdateV2, VerificationLevel};
        let u = PriceUpdateV2 {
            write_authority: Pubkey::new_unique(),
            verification_level: if p.full { VerificationLevel::Full } else { VerificationLevel::Partial { num_signatures: 5 } },
            price_message: PriceFeedMessage {
                feed_id: p.feed,
                price: p.price,
                conf: p.conf,
                exponent: p.expo,
                publish_time: p.publish_time,
                prev_publish_time: p.publish_time - 1,
                ema_price: p.price,
                ema_conf: p.conf,
            },
            posted_slot: 1,
        };
        let mut data = Vec::new();
        anchor_lang::AccountSerialize::try_serialize(&u, &mut data).unwrap();
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        let owner = p.owner.unwrap_or(pyth_solana_receiver_sdk::ID);
        self.svm.set_account(key, Account { lamports, data, owner, executable: false, rent_epoch: 0 }).unwrap();
        key
    }

    /// `settle_policy` for `policy`; `with_kamino` passes the repay CPI accounts of the snapshot obligation.
    pub fn ix_settle(&self, caller: &Pubkey, policy: Pubkey, owner_usdc: Pubkey, with_kamino: bool) -> Instruction {
        let mut ix = self.ix_settle_raw(caller, policy, owner_usdc, with_kamino);
        for m in ix.accounts.iter_mut() {
            if with_kamino && (m.pubkey == kl::OB_FARM_USER_STATE || m.pubkey == kl::USDC_DEBT_FARM) {
                m.is_writable = true; // real farms writable; the program does not demand it (A-21)
            }
        }
        ix
    }

    fn ix_settle_raw(&self, caller: &Pubkey, policy: Pubkey, owner_usdc: Pubkey, with_kamino: bool) -> Instruction {
        let p: Policy = self.anchor(&policy);
        let k = |x: Pubkey| if with_kamino { Some(x) } else { None };
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::SettlePolicy {}.data(),
            acc::SettlePolicy {
                caller: *caller,
                config: config_pda(),
                epoch: p.epoch,
                policy,
                loss: loss_pda(self.anchor::<Epoch>(&p.epoch).closure_id),
                vault: vault_pda(),
                vault_usdc: vault_usdc_pda(),
                owner_usdc,
                usdc_mint: USDC_MINT,
                token_program: TOKEN_PROGRAM,
                obligation: p.obligation,
                lending_market: k(XSTOCKS_MARKET),
                repay_reserve: k(RESERVE_USDC),
                reserve_destination_liquidity: k(kl::USDC_SUPPLY_VAULT),
                instruction_sysvar: k(kl::INSTRUCTIONS_SYSVAR),
                obligation_farm_user_state: k(kl::OB_FARM_USER_STATE),
                reserve_farm_state: k(kl::USDC_DEBT_FARM),
                lending_market_authority: k(kl::lma()),
                farms_program: k(kl::FARMS),
                klend_program: k(KLEND),
            }
            .to_account_metas(None),
        )
    }

    /// `shield_advance` for `policy` with the snapshot obligation's repay accounts and `price_update` as the fair value.
    pub fn ix_shield(&self, keeper: &Pubkey, policy: Pubkey, price_update: Pubkey) -> Instruction {
        self.ix_shield_farms(keeper, policy, price_update, Some((kl::OB_FARM_USER_STATE, kl::USDC_DEBT_FARM)))
    }

    /// As [`Env::ix_shield`] with the debt-farm slots given (`None`: the reserve has no debt farm, klend's id in both).
    /// A real farm is passed writable, a placeholder read-only (the runtime demotes the klend program id anyway).
    pub fn ix_shield_farms(&self, keeper: &Pubkey, policy: Pubkey, price_update: Pubkey, farms: Option<(Pubkey, Pubkey)>) -> Instruction {
        let (fu, fs) = farms.unwrap_or((KLEND, KLEND));
        let mut ix = self.ix_shield_raw(keeper, policy, price_update, fu, fs);
        for m in ix.accounts.iter_mut() {
            if farms.is_some() && (m.pubkey == fu || m.pubkey == fs) {
                m.is_writable = true;
            }
        }
        ix
    }

    fn ix_shield_raw(&self, keeper: &Pubkey, policy: Pubkey, price_update: Pubkey, farm_user: Pubkey, farm_state: Pubkey) -> Instruction {
        let p: Policy = self.anchor(&policy);
        let e: Epoch = self.anchor(&p.epoch);
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::ShieldAdvance {}.data(),
            acc::ShieldAdvance {
                keeper: *keeper,
                config: config_pda(),
                asset: asset_pda(&e.ticker),
                epoch: p.epoch,
                policy,
                loss: loss_pda(e.closure_id),
                vault: vault_pda(),
                vault_usdc: vault_usdc_pda(),
                usdc_mint: USDC_MINT,
                token_program: TOKEN_PROGRAM,
                price_update,
                obligation: p.obligation,
                lending_market: XSTOCKS_MARKET,
                repay_reserve: RESERVE_USDC,
                reserve_destination_liquidity: kl::USDC_SUPPLY_VAULT,
                instruction_sysvar: kl::INSTRUCTIONS_SYSVAR,
                obligation_farm_user_state: farm_user,
                reserve_farm_state: farm_state,
                lending_market_authority: kl::lma(),
                farms_program: kl::FARMS,
                klend_program: KLEND,
            }
            .to_account_metas(None),
        )
    }

    /// `settle_policy_to_wallet` for `policy` (no klend accounts).
    pub fn ix_settle_to_wallet(&self, caller: &Pubkey, policy: Pubkey, owner_usdc: Pubkey) -> Instruction {
        let p: Policy = self.anchor(&policy);
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::SettlePolicyToWallet {}.data(),
            acc::SettlePolicyToWallet {
                caller: *caller,
                config: config_pda(),
                epoch: p.epoch,
                policy,
                loss: loss_pda(self.anchor::<Epoch>(&p.epoch).closure_id),
                vault: vault_pda(),
                vault_usdc: vault_usdc_pda(),
                owner_usdc,
                usdc_mint: USDC_MINT,
                token_program: TOKEN_PROGRAM,
                cash: None,
                owner_cash: None,
                cash_mint: None,
                cash_token_program: None,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_void_epoch(&self, caller: &Pubkey, t: Ticker, closure_id: u32) -> Instruction {
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::VoidEpoch { ticker: t, closure_id }.data(),
            acc::VoidEpoch { caller: *caller, epoch: epoch_pda(&t, closure_id) }.to_account_metas(None),
        )
    }

    pub fn ix_refund(&self, caller: &Pubkey, policy: Pubkey, owner_usdc: Pubkey) -> Instruction {
        let p: Policy = self.anchor(&policy);
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::RefundPolicy {}.data(),
            acc::RefundPolicy {
                caller: *caller,
                config: config_pda(),
                epoch: p.epoch,
                policy,
                loss: loss_pda(self.anchor::<Epoch>(&p.epoch).closure_id),
                vault: vault_pda(),
                vault_usdc: vault_usdc_pda(),
                owner_usdc,
                token_program: TOKEN_PROGRAM,
            }
            .to_account_metas(None),
        )
    }

    /// `snapshot_close` for `t` in group `closure_id` with one update (and an optional cross-check update).
    pub fn ix_snapshot(&self, caller: &Pubkey, t: &str, closure_id: u32, price: Pubkey, xcheck: Option<Pubkey>) -> Instruction {
        let tk = ticker(t);
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::SnapshotClose { ticker: tk, closure_id }.data(),
            acc::SnapshotClose {
                caller: *caller,
                config: config_pda(),
                asset: asset_pda(&tk),
                epoch: epoch_pda(&tk, closure_id),
                mint: REAL_MINTS[REAL_TICKERS.iter().position(|x| *x == t).unwrap()],
                price,
                xcheck,
            }
            .to_account_metas(None),
        )
    }

    /// `post_settlement` for `t` in group `closure_id` with `updates` as remaining accounts.
    pub fn ix_post(&self, keeper: &Pubkey, t: &str, closure_id: u32, updates: &[Pubkey], xcheck: Option<Pubkey>) -> Instruction {
        use anchor_lang::solana_program::instruction::AccountMeta;
        let tk = ticker(t);
        let mut metas = acc::PostSettlement {
            keeper: *keeper,
            config: config_pda(),
            asset: asset_pda(&tk),
            epoch: epoch_pda(&tk, closure_id),
            mint: REAL_MINTS[REAL_TICKERS.iter().position(|x| *x == t).unwrap()],
            xcheck,
        }
        .to_account_metas(None);
        metas.extend(updates.iter().map(|k| AccountMeta::new_readonly(*k, false)));
        Instruction::new_with_bytes(credence_core::ID, &ix::PostSettlement { ticker: tk, closure_id }.data(), metas)
    }

    pub fn ix_halt(&self, keeper: &Pubkey, t: &str, closure_id: u32) -> Instruction {
        let tk = ticker(t);
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::HaltEpoch { ticker: tk, closure_id }.data(),
            acc::HaltEpoch {
                keeper: *keeper,
                config: config_pda(),
                asset: asset_pda(&tk),
                epoch: epoch_pda(&tk, closure_id),
                calendar: calendar_pda(),
            }
            .to_account_metas(None),
        )
    }

    /// Writes chain `chain` of Kamino's Scope `OraclePrices` (`price_usd` with 8 decimals, refreshed at `unix`, current
    /// slot), creating an empty Scope account first if the test has none.
    pub fn put_scope(&mut self, chain: usize, price_usd: f64, unix: i64) {
        use credence_core::oracle::scope::*;
        let mut a = self.svm.get_account(&SCOPE_PRICES).unwrap_or_else(|| {
            let mut data = vec![0u8; ACCOUNT_LEN];
            data[..8].copy_from_slice(&ORACLE_PRICES_DISC);
            Account { lamports: 1_000_000_000, data, owner: SCOPE_PROGRAM_ID, executable: false, rent_epoch: 0 }
        });
        let o = PRICES_OFFSET + chain * ENTRY_LEN;
        let slot = self.slot();
        a.data[o..o + 8].copy_from_slice(&((price_usd * 1e8).round() as u64).to_le_bytes());
        a.data[o + 8..o + 16].copy_from_slice(&8u64.to_le_bytes());
        a.data[o + 16..o + 24].copy_from_slice(&slot.to_le_bytes());
        a.data[o + 24..o + 32].copy_from_slice(&(unix as u64).to_le_bytes());
        self.svm.set_account(SCOPE_PRICES, a).unwrap();
    }

    /// Writes a klend-owned account.
    pub fn put_klend(&mut self, key: Pubkey, data: Vec<u8>) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm.set_account(key, Account { lamports, data, owner: KLEND, executable: false, rent_epoch: 0 }).unwrap();
    }

    pub fn slot(&self) -> u64 {
        self.svm.get_sysvar::<solana_clock::Clock>().slot
    }

    /// The real obligation `47wNsqpy…` re-owned by `owner`, as `refresh_obligation` leaves it in the current slot;
    /// `edit` can change it further. Stored at a fresh address, which is returned.
    pub fn put_obligation(&mut self, owner: &Pubkey, edit: impl FnOnce(&mut Vec<u8>)) -> Pubkey {
        let mut d = fixture("obligation_47wN");
        let slot = self.slot();
        ob::put(&mut d, ob::OB_LAST_UPDATE_SLOT, &slot.to_le_bytes());
        d[ob::OB_LAST_UPDATE_STALE] = 0;
        d[ob::OB_LAST_UPDATE_PRICE_STATUS] = 0b0011_1111;
        ob::put(&mut d, ob::OB_OWNER, owner.as_ref());
        edit(&mut d);
        let key = Pubkey::new_unique();
        self.put_klend(key, d);
        key
    }

    /// Full Phase 1 setup on real data: config (κ = 0), SPYx/QQQx/NVDAx with real feeds, reserves, σ, the calibrated
    /// scenario sets and joint set v1 with gap factors, the XNYS calendar, the vault with `lp_usdc` deposited, the
    /// klend reserve fixtures, the clock at Oct 8 noon ET, and the Oct 9 group with an epoch per asset.
    pub fn real(lp_usdc: u64) -> Env {
        let mut env = Env::new();
        env.init_config();
        let a = env.admin.pubkey();
        let joint = load_json("data/onchain/joint-v1.json");
        let cols: Vec<Vec<i16>> = joint["columns"].as_array().unwrap().iter().map(json_i16).collect();
        for (i, t) in REAL_TICKERS.iter().enumerate() {
            let ix = env.ix_add_asset(&a, ticker(t), REAL_MINTS[i], real_asset_params(i));
            env.send_admin(&[ix]).unwrap();
            let z = json_i16(&load_json(&format!("data/onchain/{t}-WEEKEND.json"))["z"]);
            env.upload_scenarios(t, &z, 400).unwrap();
        }
        env.upload_joint(1, &REAL_TICKERS, &cols, 256).unwrap();
        for t in REAL_TICKERS {
            env.compute_gap_factors(t, 1, 128).unwrap();
        }
        env.upload_calendar();
        env.init_vault();
        for (name, key) in [
            ("reserve_SPYx", RESERVE_SPYX),
            ("reserve_QQQx", RESERVE_QQQX),
            ("reserve_NVDAx", RESERVE_NVDAX),
            ("reserve_USDC", RESERVE_USDC),
        ] {
            env.put_klend(key, fixture(name));
        }
        if lp_usdc > 0 {
            let (lp, u, sh) = env.lp(lp_usdc);
            let ix = env.ix_deposit(&lp.pubkey(), u, sh, lp_usdc);
            env.send(&[ix], &[&lp]).unwrap();
        }
        env.svm.warp_to_slot(1_000);
        env.set_time(OCT8_NOON_ET);
        let ix = env.ix_open_group(&a, GROUP_OCT9);
        env.send_admin(&[ix]).unwrap();
        for t in REAL_TICKERS {
            let ix = env.ix_open_epoch(&a, ticker(t), GROUP_OCT9);
            env.send_admin(&[ix]).unwrap();
        }
        env
    }

    /// Sets the Clock sysvar's Unix time (slot unchanged).
    pub fn set_time(&mut self, unix: i64) {
        let mut c: solana_clock::Clock = self.svm.get_sysvar();
        c.unix_timestamp = unix;
        self.svm.set_sysvar(&c);
    }

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<solana_clock::Clock>().unix_timestamp
    }

    /// Uploads and finalises the generated calendar (`data/onchain/calendar-XNYS.json`); returns its sessions.
    pub fn upload_calendar(&mut self) -> Vec<SessionArg> {
        let p = format!("{}/../../data/onchain/calendar-XNYS.json", env!("CARGO_MANIFEST_DIR"));
        let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
        let sessions: Vec<SessionArg> = f["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| SessionArg {
                date: s["date"].as_u64().unwrap() as u32,
                open: s["open"].as_i64().unwrap(),
                close: s["close"].as_i64().unwrap(),
            })
            .collect();
        let hash: [u8; 32] = hex32(f["sha256"].as_str().unwrap());
        let a = self.admin.pubkey();
        let ix = self.ix_init_calendar(&a, sessions.len() as u16);
        self.send_admin(&[ix]).unwrap();
        for (i, c) in sessions.chunks(40).enumerate() {
            let ix = self.ix_write_calendar(&a, (i * 40) as u16, c.to_vec());
            self.send_admin(&[ix]).unwrap();
        }
        let ix = self.ix_finalize_calendar(&a, hash);
        self.send_admin(&[ix]).unwrap();
        sessions
    }

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

pub fn hex32(s: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
    }
    out
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

/// Real klend in LiteSVM: the mainnet klend and farms binaries (`scripts/src/fetch-klend-snapshot.ts`, git-ignored)
/// and a one-slot snapshot of the xStocks Market (market, Scope prices, SPYx and USDC reserves, the USDC supply vault
/// and debt farm, the obligation `47wNsqpy…` and its farm user state). The clock is set just after the snapshot's
/// Scope timestamps, so refreshes pass the 300 s / 180 s price-age checks exactly as on mainnet.
pub mod kl {
    use super::*;
    use anchor_lang::solana_program::instruction::AccountMeta;

    pub const FARMS: Pubkey = anchor_lang::pubkey!("FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr");
    pub const SCOPE: Pubkey = anchor_lang::pubkey!("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH");
    pub const USDC_SUPPLY_VAULT: Pubkey = anchor_lang::pubkey!("72Gz8BM8vDr5zdeHmFB5A2ptNZYfVgDuw5LDkNwGDdTA");
    pub const USDC_DEBT_FARM: Pubkey = anchor_lang::pubkey!("82eHAjSXZEyA3UpBxTjVYXF4QJmAEtLR6kvWXQca7mqd");
    pub const OB_FARM_USER_STATE: Pubkey = anchor_lang::pubkey!("EGKWCcqy46v9mMnardw4MJZ3vdCNmPEuLwH2yRNw3vff");
    pub const INSTRUCTIONS_SYSVAR: Pubkey = anchor_lang::pubkey!("Sysvar1nstructions1111111111111111111111111");
    const REFRESH_RESERVE: [u8; 8] = [2, 218, 138, 235, 79, 201, 25, 102];
    const REFRESH_OBLIGATION: [u8; 8] = [33, 132, 147, 228, 151, 192, 72, 89];

    pub fn lma() -> Pubkey {
        Pubkey::find_program_address(&[b"lma", XSTOCKS_MARKET.as_ref()], &KLEND).0
    }

    pub fn refresh_reserve(reserve: Pubkey) -> Instruction {
        Instruction {
            program_id: KLEND,
            accounts: vec![
                AccountMeta::new(reserve, false),
                AccountMeta::new_readonly(XSTOCKS_MARKET, false),
                AccountMeta::new_readonly(KLEND, false), // pyth: none
                AccountMeta::new_readonly(KLEND, false), // switchboard price: none
                AccountMeta::new_readonly(KLEND, false), // switchboard twap: none
                AccountMeta::new_readonly(SCOPE, false),
            ],
            data: REFRESH_RESERVE.to_vec(),
        }
    }

    /// Deposit reserves, then borrow reserves, as klend expects.
    pub fn refresh_obligation(obligation: Pubkey, reserves: &[Pubkey]) -> Instruction {
        let mut accounts = vec![AccountMeta::new_readonly(XSTOCKS_MARKET, false), AccountMeta::new(obligation, false)];
        accounts.extend(reserves.iter().map(|r| AccountMeta::new_readonly(*r, false)));
        Instruction { program_id: KLEND, accounts, data: REFRESH_OBLIGATION.to_vec() }
    }

    /// The three refreshes for the snapshot obligation (SPYx deposit, USDC borrow).
    pub fn refreshes() -> Vec<Instruction> {
        vec![
            refresh_reserve(RESERVE_SPYX),
            refresh_reserve(RESERVE_USDC),
            refresh_obligation(OBLIGATION_47WN, &[RESERVE_SPYX, RESERVE_USDC]),
        ]
    }

    /// `repay_obligation_liquidity_v2` signed directly by `payer` from `source` (USDC).
    pub fn repay_v2(payer: Pubkey, source: Pubkey, amount: u64) -> Instruction {
        let mut data = credence_core::kamino::REPAY_OBLIGATION_LIQUIDITY_V2_DISC.to_vec();
        data.extend_from_slice(&amount.to_le_bytes());
        Instruction {
            program_id: KLEND,
            accounts: vec![
                AccountMeta::new_readonly(payer, true),
                AccountMeta::new(OBLIGATION_47WN, false),
                AccountMeta::new_readonly(XSTOCKS_MARKET, false),
                AccountMeta::new(RESERVE_USDC, false),
                AccountMeta::new_readonly(USDC_MINT, false),
                AccountMeta::new(USDC_SUPPLY_VAULT, false),
                AccountMeta::new(source, false),
                AccountMeta::new_readonly(TOKEN_PROGRAM, false),
                AccountMeta::new_readonly(INSTRUCTIONS_SYSVAR, false),
                AccountMeta::new(OB_FARM_USER_STATE, false),
                AccountMeta::new(USDC_DEBT_FARM, false),
                AccountMeta::new_readonly(lma(), false),
                AccountMeta::new_readonly(FARMS, false),
            ],
            data,
        }
    }

    /// The obligation's USDC debt in base units × 2^60 (klend `borrowed_amount_sf`).
    pub fn debt_sf(env: &Env) -> u128 {
        ob::get_u128(&env.data(&OBLIGATION_47WN), ob::OB_BORROWS + ob::BOR_BORROWED_AMOUNT_SF)
    }

    pub fn snapshot() -> serde_json::Value {
        let p = format!("{}/tests/fixtures/klend/snapshot.json", env!("CARGO_MANIFEST_DIR"));
        serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
    }
}

impl Env {
    /// Loads klend, farms and the snapshot (see [`kl`]); the obligation's owner field is set to `owner`. Sets the clock
    /// to the snapshot slot and just after its newest Scope price. Panics with instructions if the binaries are missing.
    pub fn load_klend(&mut self, owner: &Pubkey) {
        self.load_klend_with(owner, |_| {})
    }

    /// Test-only: re-stamps every Scope price with the current slot and time, so klend refreshes pass its price-age
    /// checks after the test clock moves days past the snapshot (prices themselves unchanged). Never used on-chain.
    pub fn freshen_scope(&mut self) {
        let mut a = self.svm.get_account(&kl::SCOPE).unwrap();
        let (slot, now) = (self.slot(), self.now() as u64);
        for i in 0..512 {
            let o = 8 + 32 + i * 56;
            if u64::from_le_bytes(a.data[o + 24..o + 32].try_into().unwrap()) != 0 {
                a.data[o + 16..o + 24].copy_from_slice(&slot.to_le_bytes());
                a.data[o + 24..o + 32].copy_from_slice(&now.to_le_bytes());
            }
        }
        self.svm.set_account(kl::SCOPE, a).unwrap();
    }

    /// As [`Env::load_klend`], with `edit` applied to the obligation's data (e.g. scale its debt).
    pub fn load_klend_with(&mut self, owner: &Pubkey, edit: impl FnOnce(&mut Vec<u8>)) {
        let mut edit = Some(edit);
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");
        for (name, id) in [("klend", KLEND), ("farms", kl::FARMS)] {
            let path = format!("{dir}/programs/{name}.so");
            let so = std::fs::read(&path).unwrap_or_else(|_| {
                panic!("{path} missing: run `cd scripts && pnpm tsx src/fetch-klend-snapshot.ts --programs-only` (needs MAINNET_RPC)")
            });
            self.svm.add_program(id, &so).unwrap();
        }
        let snap = kl::snapshot();
        for (name, meta) in snap["accounts"].as_object().unwrap() {
            let mut data = std::fs::read(format!("{dir}/klend/{name}.bin")).unwrap();
            if name == "obligation" {
                ob::put(&mut data, ob::OB_OWNER, owner.as_ref());
                if let Some(f) = edit.take() {
                    f(&mut data);
                }
            }
            let key: Pubkey = meta["address"].as_str().unwrap().parse().unwrap();
            let owner_prog: Pubkey = meta["owner"].as_str().unwrap().parse().unwrap();
            let lamports = meta["lamports"].as_u64().unwrap();
            self.svm.set_account(key, Account { lamports, data, owner: owner_prog, executable: false, rent_epoch: 0 }).unwrap();
        }
        let newest = snap["scope"].as_object().unwrap().values().map(|v| v["unixTimestamp"].as_i64().unwrap()).max().unwrap();
        self.svm.warp_to_slot(snap["slot"].as_u64().unwrap() + 1);
        self.set_time(newest + 5);
    }
}

/// The policy's snapshot debt with klend's interest since purchase, from its borrow reserve's index as the reserve
/// holds it now (task 1.2): what `shield_advance` and `settle_policy` (into the obligation) size on, once the
/// transaction that refreshed the reserve has run.
pub fn accrued_debt_now(env: &Env, p: &Policy) -> u64 {
    let r = credence_core::kamino::ReserveView::decode(&env.data(&p.borrow_reserve)).unwrap();
    credence_core::pricing::accrued_debt(p, r.cumulative_borrow_rate_bsf).unwrap()
}

/// `realized_payout` on [`accrued_debt_now`]: what `settle_policy` pays into an obligation (task 1.2).
pub fn payout_into_obligation(env: &Env, policy: &Pubkey) -> u64 {
    let p: Policy = env.anchor(policy);
    let e: Epoch = env.anchor(&p.epoch);
    credence_core::pricing::realized_payout(p.covered_value, accrued_debt_now(env, &p), p.max_payout, e.close_price_wad, e.settle_price_wad)
        .unwrap()
}

/// The xStocks Market USDC reserve's cToken mint (kUSDC), in the klend fixtures (`fetch-klend-liquidation.ts`).
pub const USDC_CTOKEN_MINT: Pubkey = anchor_lang::pubkey!("69nwLK2t639e2c2ZWmZAbs2HWKZwG4pXVPzBTiEtNmwf");
pub const ATA_PROGRAM_ID: Pubkey = anchor_lang::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

pub fn ata_of(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), token_program.as_ref(), mint.as_ref()], &ATA_PROGRAM_ID).0
}

/// `CreateIdempotent` of the associated token program.
pub fn ix_create_ata(payer: &Pubkey, owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Instruction {
    use anchor_lang::solana_program::instruction::AccountMeta;
    Instruction {
        program_id: ATA_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(ata_of(owner, mint, token_program), false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(anchor_lang::solana_program::system_program::ID, false),
            AccountMeta::new_readonly(*token_program, false),
        ],
        data: vec![1],
    }
}

/// W3 yield vault helpers (real klend snapshot loaded).
impl Env {
    /// The vault's kUSDC ATA and `set_yield_reserve` on the xStocks Market USDC reserve; a backstop pool with a 0% share
    /// if there is none (`rebalance` requires it, audit A-41).
    pub fn setup_yield(&mut self, cash_headroom_wad: u64) {
        let a = self.admin.pubkey();
        if self.svm.get_account(&pda(&[SEED_BACKSTOP])).is_none() {
            let w = 1_000_000_000_000_000_000u64;
            let p = credence_core::BackstopParams { max_share_wad: 0, haircut_wad: w / 10, max_discount_wad: w / 100 * 15,
                sale_premium_wad: w / 50, sale_discount_wad: w / 20, sale_secs: 7_200, max_price_age_secs: 300 };
            let init = Instruction::new_with_bytes(
                credence_core::ID,
                &ix::InitBackstop { params: p }.data(),
                acc::InitBackstop { admin: a, config: config_pda(), pool: pda(&[SEED_BACKSTOP]), system_program: anchor_lang::solana_program::system_program::ID }
                    .to_account_metas(None),
            );
            self.send_admin(&[init]).unwrap();
        }
        let vault = vault_pda();
        let ix = Instruction::new_with_bytes(
            credence_core::ID,
            &ix::SetYieldReserve { cash_headroom_wad }.data(),
            acc::SetYieldReserve {
                admin: a,
                config: config_pda(),
                vault,
                reserve: RESERVE_USDC,
                kusdc: ata_of(&vault, &USDC_CTOKEN_MINT, &TOKEN_PROGRAM),
                token_program: TOKEN_PROGRAM,
            }
            .to_account_metas(None),
        );
        let create = ix_create_ata(&a, &vault, &USDC_CTOKEN_MINT, &TOKEN_PROGRAM);
        self.send_admin(&[create, ix]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    }

    pub fn ix_rebalance(&self, keeper: &Pubkey) -> Instruction {
        let vault = vault_pda();
        let v: Vault = self.anchor(&vault);
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::Rebalance {}.data(),
            acc::Rebalance {
                keeper: *keeper,
                config: config_pda(),
                vault,
                vault_usdc: vault_usdc_pda(),
                share_mint: v.share_mint,
                pool: pda(&[SEED_BACKSTOP]),
                kusdc: v.kusdc,
                reserve: RESERVE_USDC,
                lending_market: XSTOCKS_MARKET,
                lending_market_authority: kl::lma(),
                usdc_mint: USDC_MINT,
                reserve_liquidity_supply: kl::USDC_SUPPLY_VAULT,
                reserve_collateral_mint: USDC_CTOKEN_MINT,
                token_program: TOKEN_PROGRAM,
                instruction_sysvar: kl::INSTRUCTIONS_SYSVAR,
                klend_program: KLEND,
            }
            .to_account_metas(None),
        )
    }

    /// One slot later, Scope re-stamped: [`refresh_reserve`(USDC) if `refresh`] + `rebalance` by the admin (= keeper).
    pub fn rebalance(&mut self, refresh: bool) -> TxResult {
        self.svm.warp_to_slot(self.slot() + 1);
        self.freshen_scope();
        let a = self.admin.pubkey();
        let mut ixs = if refresh { vec![kl::refresh_reserve(RESERVE_USDC)] } else { vec![] };
        ixs.push(self.ix_rebalance(&a));
        self.send_admin(&ixs)
    }

    /// Test-only: the USDC reserve at 100% utilisation. Its available liquidity becomes borrowed (total supply, and so
    /// the cToken exchange rate, unchanged) and its supply vault is emptied, so nothing can be redeemed or borrowed.
    pub fn make_usdc_reserve_illiquid(&mut self) {
        use credence_core::kamino::layout::*;
        let mut r = self.svm.get_account(&RESERVE_USDC).unwrap();
        let avail = u64::from_le_bytes(r.data[RS_LIQUIDITY_AVAILABLE_AMOUNT..RS_LIQUIDITY_AVAILABLE_AMOUNT + 8].try_into().unwrap());
        let b = RS_LIQUIDITY_BORROWED_AMOUNT_SF;
        let borrowed = u128::from_le_bytes(r.data[b..b + 16].try_into().unwrap()) + ((avail as u128) << 60);
        r.data[b..b + 16].copy_from_slice(&borrowed.to_le_bytes());
        r.data[RS_LIQUIDITY_AVAILABLE_AMOUNT..RS_LIQUIDITY_AVAILABLE_AMOUNT + 8].copy_from_slice(&0u64.to_le_bytes());
        self.svm.set_account(RESERVE_USDC, r).unwrap();
        let mut v = self.svm.get_account(&kl::USDC_SUPPLY_VAULT).unwrap();
        v.data[64..72].copy_from_slice(&0u64.to_le_bytes());
        self.svm.set_account(kl::USDC_SUPPLY_VAULT, v).unwrap();
    }
}

/// Kamino's Sentora xStocks Market in LiteSVM (W4): its SPYx, NVDAx, QQQx and PYUSD reserves, the PYUSD mint
/// (Token-2022) and supply vault, and two real obligations (`scripts/src/fetch-sentora-snapshot.ts`): `3cwtNSst…`
/// (SPYx / PYUSD) and `xkHzu8RC…` (SPYx + NVDAx / PYUSD). Prices come from the shared Scope account of [`kl`].
pub mod sn {
    use super::*;
    use anchor_lang::solana_program::instruction::AccountMeta;

    pub const MARKET: Pubkey = anchor_lang::pubkey!("8BNUWRSibVasaAmhYpBCFpGgMisGKfVAf9ho3Cmf6vjr");
    pub const RESERVE_SPYX: Pubkey = anchor_lang::pubkey!("7Yh74hEtP75acqhQ5f2FqoHQny5TYiYBPVxkwN35rCSi");
    pub const RESERVE_NVDAX: Pubkey = anchor_lang::pubkey!("4WqQtjQbewk7ptnXsX3E3Tf3M4pa9YiBsgAqjsJDkspH");
    pub const RESERVE_QQQX: Pubkey = anchor_lang::pubkey!("w6diwHyXhRzmhRWwnz3jQPqTt35qFbBDcQP7T2VdgSm");
    pub const RESERVE_PYUSD: Pubkey = anchor_lang::pubkey!("6bR98MJTH68s7eV8ssyBgfuuH5oR2bEt58P9rZPLpBrC");
    pub const PYUSD_SUPPLY: Pubkey = anchor_lang::pubkey!("J9btqprqRAp871qt6HVAbkyV8ft2aStFMxLFzmAsbZL2");
    pub const OB_SINGLE: Pubkey = anchor_lang::pubkey!("3cwtNSstL1ks6c8LGHYp8j6ueess35ykC96kFbejEFBE");
    pub const OB_MULTI: Pubkey = anchor_lang::pubkey!("xkHzu8RCP7giAaBq6AwRu7MreJc2RTLthqLe3yoyiBu");

    pub fn lma() -> Pubkey {
        Pubkey::find_program_address(&[b"lma", MARKET.as_ref()], &KLEND).0
    }

    pub fn refresh_reserve(reserve: Pubkey) -> Instruction {
        let mut ix = kl::refresh_reserve(reserve);
        ix.accounts[1] = AccountMeta::new_readonly(MARKET, false);
        ix
    }

    pub fn refresh_obligation(obligation: Pubkey, reserves: &[Pubkey]) -> Instruction {
        let mut ix = kl::refresh_obligation(obligation, reserves);
        ix.accounts[0] = AccountMeta::new_readonly(MARKET, false);
        ix
    }

    /// The deposit reserves of an obligation fixture, in its order.
    pub fn deposits(obligation: &Pubkey) -> Vec<Pubkey> {
        if *obligation == OB_MULTI { vec![RESERVE_SPYX, RESERVE_NVDAX] } else { vec![RESERVE_SPYX] }
    }

    /// Refresh every reserve of `obligation`, then the obligation (deposits, then the PYUSD borrow).
    pub fn refreshes(obligation: Pubkey) -> Vec<Instruction> {
        let deps = deposits(&obligation);
        let mut ixs: Vec<Instruction> = deps.iter().map(|r| refresh_reserve(*r)).collect();
        ixs.push(refresh_reserve(RESERVE_PYUSD));
        let mut all = deps.clone();
        all.push(RESERVE_PYUSD);
        ixs.push(refresh_obligation(obligation, &all));
        ixs
    }
}

/// Multi-collateral and PYUSD helpers (W4).
impl Env {
    /// [`Env::load_klend`] (programs, the xStocks Market, Scope), then the Sentora snapshot with the two obligations
    /// re-owned by `single` and `multi`; `edit` applies to both obligations (e.g. scale the debt). Scope re-stamped.
    pub fn load_sentora(&mut self, single: &Pubkey, multi: &Pubkey, edit: impl Fn(&mut Vec<u8>)) {
        let dummy = Pubkey::new_unique();
        self.load_klend(&dummy);
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/sentora");
        let snap: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(format!("{dir}/snapshot.json")).unwrap()).unwrap();
        for (name, meta) in snap["accounts"].as_object().unwrap() {
            let mut data = std::fs::read(format!("{dir}/{name}.bin")).unwrap();
            if name.starts_with("obligation_") {
                let owner = if name == "obligation_multi" { multi } else { single };
                ob::put(&mut data, ob::OB_OWNER, owner.as_ref());
                edit(&mut data);
            }
            let key: Pubkey = meta["address"].as_str().unwrap().parse().unwrap();
            let owner_prog: Pubkey = meta["owner"].as_str().unwrap().parse().unwrap();
            let lamports = meta["lamports"].as_u64().unwrap();
            self.svm.set_account(key, Account { lamports, data, owner: owner_prog, executable: false, rent_epoch: 0 }).unwrap();
        }
        self.freshen_scope();
    }

    /// Test-only: sets a Token or Token-2022 account's balance (base layout: amount at 64).
    pub fn set_token_amount(&mut self, key: &Pubkey, amount: u64) {
        let mut a = self.svm.get_account(key).unwrap();
        a.data[64..72].copy_from_slice(&amount.to_le_bytes());
        self.svm.set_account(*key, a).unwrap();
    }

    /// `owner`'s PYUSD ATA (Token-2022, created by the ATA program) holding `amount` (balance written: test setup).
    pub fn pyusd_account(&mut self, owner: &Pubkey, amount: u64) -> Pubkey {
        let a = self.admin.pubkey();
        let ix = ix_create_ata(&a, owner, &PYUSD_MINT, &TOKEN_2022_PROGRAM);
        self.send_admin(&[ix]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
        let k = ata_of(owner, &PYUSD_MINT, &TOKEN_2022_PROGRAM);
        self.set_token_amount(&k, amount);
        k
    }

    pub fn sleeve_key() -> Pubkey {
        ata_of(&vault_pda(), &PYUSD_MINT, &TOKEN_2022_PROGRAM)
    }

    pub fn ix_set_pyusd_sleeve(&self, admin: &Pubkey, sleeve: Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::SetPyusdSleeve {}.data(),
            acc::SetPyusdSleeve { admin: *admin, config: config_pda(), vault: vault_pda(), sleeve, token_2022_program: TOKEN_2022_PROGRAM }
                .to_account_metas(None),
        )
    }

    /// The vault PDA's PYUSD ATA set as the sleeve, holding `amount` (balance written: test setup).
    pub fn setup_sleeve(&mut self, amount: u64) -> Pubkey {
        let k = self.pyusd_account(&vault_pda(), amount);
        let a = self.admin.pubkey();
        let ix = self.ix_set_pyusd_sleeve(&a, k);
        self.send_admin(&[ix]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
        k
    }

    #[allow(clippy::too_many_arguments)]
    pub fn ix_fund_sleeve(&self, keeper: &Pubkey, keeper_pyusd: Pubkey, keeper_usdc: Pubkey, pyusd_in: u64, usdc_out: u64) -> Instruction {
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::FundSleeve { pyusd_in, usdc_out }.data(),
            acc::FundSleeve {
                keeper: *keeper,
                config: config_pda(),
                vault: vault_pda(),
                vault_usdc: vault_usdc_pda(),
                sleeve: Env::sleeve_key(),
                pyusd_mint: PYUSD_MINT,
                keeper_pyusd,
                keeper_usdc,
                pyusd_reserve: sn::RESERVE_PYUSD,
                token_program: TOKEN_PROGRAM,
                token_2022_program: TOKEN_2022_PROGRAM,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_drain_sleeve(&self, keeper: &Pubkey, keeper_pyusd: Pubkey, keeper_usdc: Pubkey, pyusd_out: u64, usdc_in: u64) -> Instruction {
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::DrainSleeve { pyusd_out, usdc_in }.data(),
            acc::DrainSleeve {
                keeper: *keeper,
                config: config_pda(),
                vault: vault_pda(),
                vault_usdc: vault_usdc_pda(),
                sleeve: Env::sleeve_key(),
                pyusd_mint: PYUSD_MINT,
                keeper_pyusd,
                keeper_usdc,
                pyusd_reserve: sn::RESERVE_PYUSD,
                token_program: TOKEN_PROGRAM,
                token_2022_program: TOKEN_2022_PROGRAM,
            }
            .to_account_metas(None),
        )
    }

    /// `buy_cover_multi` on a Sentora obligation (PYUSD debt) with the given legs (tickers in leg order); the sleeve
    /// account when `sleeve`.
    #[allow(clippy::too_many_arguments)]
    pub fn ix_buy_cover_multi(
        &self,
        buyer: &Pubkey,
        buyer_usdc: Pubkey,
        obligation: Pubkey,
        legs: &[&str],
        closure_id: u32,
        max_payout: u64,
        max_premium: u64,
        sleeve: bool,
    ) -> Instruction {
        use anchor_lang::solana_program::instruction::AccountMeta;
        let t0 = ticker(legs[0]);
        let epoch = epoch_pda(&t0, closure_id);
        let mut metas = acc::BuyCoverMulti {
            buyer: *buyer,
            config: config_pda(),
            epoch,
            loss: loss_pda(closure_id),
            vault: vault_pda(),
            vault_usdc: vault_usdc_pda(),
            share_mint: shares_pda(),
            fee_account: self.anchor::<Vault>(&vault_pda()).fee_account,
            buyer_usdc,
            obligation,
            borrow_reserve: sn::RESERVE_PYUSD,
            sleeve: if sleeve { Some(Env::sleeve_key()) } else { None },
            policy: policy_pda(&epoch, &obligation),
            token_program: TOKEN_PROGRAM,
            system_program: system_program::ID,
        }
        .to_account_metas(None);
        metas.extend(sn::deposits(&obligation).into_iter().map(|r| AccountMeta::new_readonly(r, false)));
        for t in legs {
            let t = ticker(t);
            metas.push(AccountMeta::new_readonly(asset_pda(&t), false));
            metas.push(AccountMeta::new_readonly(scen_pda(&t, closure::WEEKEND), false));
            metas.push(AccountMeta::new(epoch_pda(&t, closure_id), false));
        }
        Instruction::new_with_bytes(credence_core::ID, &ix::BuyCoverMulti { closure_id, max_payout, max_premium }.data(), metas)
    }

    /// `quote_cover_multi` (read-only) for the given legs.
    pub fn ix_quote_cover_multi(&self, legs: &[&str], covered: Vec<u64>, stable: u64, debt: u64, max_payout: u64) -> Instruction {
        use anchor_lang::solana_program::instruction::AccountMeta;
        let mut metas = acc::QuoteCoverMulti { config: config_pda() }.to_account_metas(None);
        for t in legs {
            let t = ticker(t);
            metas.push(AccountMeta::new_readonly(asset_pda(&t), false));
            metas.push(AccountMeta::new_readonly(scen_pda(&t, closure::WEEKEND), false));
        }
        Instruction::new_with_bytes(credence_core::ID, &ix::QuoteCoverMulti { legs: covered, stable, debt, max_payout }.data(), metas)
    }

    /// `settle_policy` of a Sentora PYUSD policy: paid from the sleeve, into the obligation (`with_kamino`) or the
    /// owner's PYUSD account; the other legs' epochs as remaining accounts.
    pub fn ix_settle_pyusd(&self, caller: &Pubkey, policy: Pubkey, owner_pyusd: Pubkey, with_kamino: bool) -> Instruction {
        use anchor_lang::solana_program::instruction::AccountMeta;
        let p: Policy = self.anchor(&policy);
        let k = |x: Pubkey| if with_kamino { Some(x) } else { None };
        let mut metas = acc::SettlePolicy {
            caller: *caller,
            config: config_pda(),
            epoch: p.epoch,
            policy,
            loss: loss_pda(self.anchor::<Epoch>(&p.epoch).closure_id),
            vault: vault_pda(),
            vault_usdc: Env::sleeve_key(),
            owner_usdc: owner_pyusd,
            usdc_mint: PYUSD_MINT,
            token_program: TOKEN_2022_PROGRAM,
            obligation: p.obligation,
            lending_market: k(sn::MARKET),
            repay_reserve: k(sn::RESERVE_PYUSD),
            reserve_destination_liquidity: k(sn::PYUSD_SUPPLY),
            instruction_sysvar: k(kl::INSTRUCTIONS_SYSVAR),
            obligation_farm_user_state: k(KLEND),
            reserve_farm_state: k(KLEND),
            lending_market_authority: k(sn::lma()),
            farms_program: k(kl::FARMS),
            klend_program: k(KLEND),
        }
        .to_account_metas(None);
        metas.extend(self.leg_epochs(&p).into_iter().map(|e| AccountMeta::new_readonly(e, false)));
        Instruction::new_with_bytes(credence_core::ID, &ix::SettlePolicy {}.data(), metas)
    }

    /// The epochs of a multi-leg policy's legs 1.. (settlement's remaining accounts).
    pub fn leg_epochs(&self, p: &Policy) -> Vec<Pubkey> {
        let e: Epoch = self.anchor(&p.epoch);
        (1..p.n_legs as usize).map(|i| epoch_pda(&p.leg_ticker(i), e.closure_id)).collect()
    }

    /// `shield_advance` on a Sentora PYUSD policy: leg 0's push account named, legs 1.. as [asset, epoch, push].
    pub fn ix_shield_pyusd(&self, keeper: &Pubkey, policy: Pubkey, pushes: &[Pubkey]) -> Instruction {
        use anchor_lang::solana_program::instruction::AccountMeta;
        let p: Policy = self.anchor(&policy);
        let e: Epoch = self.anchor(&p.epoch);
        let mut metas = acc::ShieldAdvance {
            keeper: *keeper,
            config: config_pda(),
            asset: asset_pda(&e.ticker),
            epoch: p.epoch,
            policy,
            loss: loss_pda(e.closure_id),
            vault: vault_pda(),
            vault_usdc: Env::sleeve_key(),
            usdc_mint: PYUSD_MINT,
            token_program: TOKEN_2022_PROGRAM,
            price_update: pushes[0],
            obligation: p.obligation,
            lending_market: sn::MARKET,
            repay_reserve: sn::RESERVE_PYUSD,
            reserve_destination_liquidity: sn::PYUSD_SUPPLY,
            instruction_sysvar: kl::INSTRUCTIONS_SYSVAR,
            obligation_farm_user_state: KLEND,
            reserve_farm_state: KLEND,
            lending_market_authority: sn::lma(),
            farms_program: kl::FARMS,
            klend_program: KLEND,
        }
        .to_account_metas(None);
        for i in 1..p.n_legs as usize {
            let t = p.leg_ticker(i);
            metas.push(AccountMeta::new_readonly(asset_pda(&t), false));
            metas.push(AccountMeta::new_readonly(epoch_pda(&t, e.closure_id), false));
            metas.push(AccountMeta::new_readonly(pushes[i], false));
        }
        Instruction::new_with_bytes(credence_core::ID, &ix::ShieldAdvance {}.data(), metas)
    }
}
