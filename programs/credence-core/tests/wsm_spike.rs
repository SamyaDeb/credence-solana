//! D1.0 spike (weekend-safe market): what the real mainnet klend binary lets a new market do. Creates a market with
//! `init_lending_market`, four reserves (SPYx, QQQx, NVDAx collateral; USDC borrow) priced by Kamino's existing Scope
//! account, then probes permissioning, borrow limits and the exit paths. Findings are in plan/09 (D1.0).
//! Test-only shortcuts: the klend global config account is rewritten so the test admin is the global admin (on mainnet
//! that key is Kamino's), Scope timestamps are re-stamped (`Env::freshen_scope`), token balances are written directly.

mod common;

use anchor_lang::{
    prelude::Pubkey,
    solana_program::{instruction::{AccountMeta, Instruction}, system_program},
};
use common::*;
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_signer::Signer;

const INSTRUCTIONS: Pubkey = kl::INSTRUCTIONS_SYSVAR;
const RENT: Pubkey = anchor_lang::pubkey!("SysvarRent111111111111111111111111111111111");
const GLOBAL_CONFIG: Pubkey = anchor_lang::pubkey!("BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W");

fn disc(name: &str) -> [u8; 8] {
    Sha256::digest(format!("global:{name}"))[..8].try_into().unwrap()
}

fn klend_pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &KLEND).0
}

fn data(name: &str, args: &[&[u8]]) -> Vec<u8> {
    let mut d = disc(name).to_vec();
    for a in args {
        d.extend_from_slice(a);
    }
    d
}

/// One reserve of the new market.
#[derive(Clone)]
struct Rs {
    key: Pubkey,
    mint: Pubkey,
    liq_program: Pubkey,
    liq_supply: Pubkey,
    fee_vault: Pubkey,
    coll_mint: Pubkey,
    coll_supply: Pubkey,
}

/// What a reserve is configured with (percent and bps as in klend's `ReserveConfig`).
struct Cfg {
    ltv: u8,
    lt: u8,
    borrow_factor: u64,
    deposit_limit: u64,
    borrow_limit: u64,
    chain: [u16; 4],
    twap: [u16; 4],
    name: &'static str,
    heuristic: (u64, u64, u64),
    max_age: (u64, u64),
    curve: Vec<(u32, u32)>,
}

struct Km {
    env: Env,
    market: Pubkey,
    lma: Pubkey,
    spy: Rs,
    qqq: Rs,
    nvda: Rs,
    usdc: Rs,
}

fn mode_ix(
    km: &Km,
    reserve: &Rs,
    mode: u8,
    value: Vec<u8>,
) -> Instruction {
    let admin = km.env.admin.pubkey();
    let mut d = disc("update_reserve_config").to_vec();
    d.push(mode - 1); // borsh writes the enum's variant index: UpdateConfigMode discriminants start at 1
    d.extend_from_slice(&(value.len() as u32).to_le_bytes());
    d.extend_from_slice(&value);
    // Fields are set one at a time with validation skipped, which klend allows only while the reserve is blocked
    // (both limits 0); the two limit updates come last, validated against the whole config.
    d.push(if mode == 9 || mode == 10 { 0 } else { 1 });
    Instruction {
        program_id: KLEND,
        accounts: vec![
            AccountMeta::new_readonly(admin, true),
            AccountMeta::new_readonly(GLOBAL_CONFIG, false),
            AccountMeta::new_readonly(km.market, false),
            AccountMeta::new(reserve.key, false),
            AccountMeta::new_readonly(INSTRUCTIONS, false),
        ],
        data: d,
    }
}

fn market_ix(km: &Km, signer: &Pubkey, mode: u64, value: &[u8]) -> Instruction {
    let mut v = [0u8; 72];
    v[..value.len()].copy_from_slice(value);
    Instruction {
        program_id: KLEND,
        accounts: vec![
            AccountMeta::new_readonly(*signer, true),
            AccountMeta::new(km.market, false),
            AccountMeta::new_readonly(INSTRUCTIONS, false),
        ],
        data: data("update_lending_market", &[&mode.to_le_bytes(), &v]),
    }
}

fn token_account_2022(env: &mut Env, owner: &Pubkey, mint: &Pubkey, amount: u64) -> Pubkey {
    let payer = env.admin.insecure_clone();
    let ata = ata_of(owner, mint, &TOKEN_2022_PROGRAM);
    env.send(&[ix_create_ata(&payer.pubkey(), owner, mint, &TOKEN_2022_PROGRAM)], &[&payer]).unwrap();
    let mut a = env.svm.get_account(&ata).unwrap();
    a.data[64..72].copy_from_slice(&amount.to_le_bytes());
    env.svm.set_account(ata, a).unwrap();
    ata
}

fn credit(env: &mut Env, key: &Pubkey, amount: u64) {
    let mut a = env.svm.get_account(key).unwrap();
    a.data[64..72].copy_from_slice(&amount.to_le_bytes());
    env.svm.set_account(*key, a).unwrap();
}

fn reserve_for(env: &Env, mint: Pubkey) -> Rs {
    let key = Pubkey::new_unique();
    let owner = env.svm.get_account(&mint).unwrap().owner;
    Rs {
        key,
        mint,
        liq_program: owner,
        liq_supply: klend_pda(&[b"reserve_liq_supply", key.as_ref()]),
        fee_vault: klend_pda(&[b"fee_receiver", key.as_ref()]),
        coll_mint: klend_pda(&[b"reserve_coll_mint", key.as_ref()]),
        coll_supply: klend_pda(&[b"reserve_coll_supply", key.as_ref()]),
    }
}

fn u64b(v: u64) -> Vec<u8> {
    v.to_le_bytes().to_vec()
}

fn chain(c: [u16; 4]) -> Vec<u8> {
    c.iter().flat_map(|x| x.to_le_bytes()).collect()
}

fn xstock_cfg(i: usize) -> Cfg {
    // Kamino's own xStocks-market values (tests/fixtures/reserve_*.bin), so the spike starts from what is live today.
    let curve = |pts: &[(u32, u32)]| {
        let mut v = pts.to_vec();
        let last = *v.last().unwrap();
        while v.len() < 11 {
            v.push(last);
        }
        v
    };
    match i {
        0 => Cfg { ltv: 73, lt: 75, borrow_factor: 166, deposit_limit: 2_000_000_000_000, borrow_limit: 500_000_000_000, chain: [344, 65535, 65535, 65535], twap: [279, 65535, 65535, 65535], name: "SPYx", heuristic: (5150, 8580, 1), max_age: (300, 300), curve: curve(&[(0, 429), (8000, 615), (8500, 1366), (9000, 3074), (9500, 5000), (10000, 11250)]) },
        1 => Cfg { ltv: 70, lt: 72, borrow_factor: 166, deposit_limit: 1_600_000_000_000, borrow_limit: 100_000_000_000, chain: [347, 65535, 65535, 65535], twap: [281, 65535, 65535, 65535], name: "QQQx", heuristic: (4000, 9000, 1), max_age: (300, 300), curve: curve(&[(0, 300), (8000, 450), (8500, 1000), (9000, 2250), (9500, 5000), (10000, 11250)]) },
        2 => Cfg { ltv: 55, lt: 65, borrow_factor: 225, deposit_limit: 1_800_000_000_000, borrow_limit: 50_000_000_000, chain: [332, 65535, 65535, 65535], twap: [269, 65535, 65535, 65535], name: "NVDAx", heuristic: (1000, 2500, 1), max_age: (300, 300), curve: curve(&[(0, 300), (8000, 450), (8500, 1000), (9000, 2250), (9500, 5000), (10000, 11250)]) },
        _ => Cfg { ltv: 80, lt: 90, borrow_factor: 100, deposit_limit: 20_000_000_000_000, borrow_limit: 16_000_000_000_000, chain: [13, 65535, 65535, 65535], twap: [456, 65535, 65535, 65535], name: "USDC", heuristic: (98, 105, 2), max_age: (180, 240), curve: curve(&[(0, 0), (9000, 514), (9500, 957), (10000, 1792)]) },
    }
}

/// Builds the market: init, four reserves, Kamino's xStocks values with `ltv`/`lt` overrides for the collateral.
fn build(coll_ltv: Option<(u8, u8)>) -> Km {
    let mut env = Env::new();
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");
    for (name, id) in [("klend", KLEND), ("farms", kl::FARMS)] {
        let so = std::fs::read(format!("{dir}/programs/{name}.so")).expect("klend binaries: scripts/test.sh fetches them");
        env.svm.add_program(id, &so).unwrap();
    }
    // Kamino's Scope account (read-only copy of mainnet) and klend's global config with the test admin as global admin.
    let snap = kl::snapshot();
    let scope_owner: Pubkey = snap["accounts"]["scope_prices"]["owner"].as_str().unwrap().parse().unwrap();
    let scope = std::fs::read(format!("{dir}/klend/scope_prices.bin")).unwrap();
    let l = env.svm.minimum_balance_for_rent_exemption(scope.len());
    env.svm.set_account(kl::SCOPE, Account { lamports: l, data: scope, owner: scope_owner, executable: false, rent_epoch: 0 }).unwrap();
    let newest = snap["scope"].as_object().unwrap().values().map(|v| v["unixTimestamp"].as_i64().unwrap()).max().unwrap();
    env.svm.warp_to_slot(snap["slot"].as_u64().unwrap() + 1);
    env.set_time(newest + 5);
    env.freshen_scope();
    let mut gc = std::fs::read(format!("{dir}/klend/global_config.bin")).unwrap();
    gc[8..40].copy_from_slice(env.admin.pubkey().as_ref());
    let l = env.svm.minimum_balance_for_rent_exemption(gc.len());
    env.svm.set_account(GLOBAL_CONFIG, Account { lamports: l, data: gc, owner: KLEND, executable: false, rent_epoch: 0 }).unwrap();

    let market = Pubkey::new_unique();
    let l = env.svm.minimum_balance_for_rent_exemption(8 + 4656);
    env.svm.set_account(market, Account { lamports: l, data: vec![0; 8 + 4656], owner: KLEND, executable: false, rent_epoch: 0 }).unwrap();
    let lma = klend_pda(&[b"lma", market.as_ref()]);
    let admin = env.admin.pubkey();
    let mut quote = [0u8; 32];
    quote[..3].copy_from_slice(b"USD");
    let init = Instruction {
        program_id: KLEND,
        accounts: vec![
            AccountMeta::new(admin, true),
            AccountMeta::new(market, false),
            AccountMeta::new_readonly(lma, false),
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(RENT, false),
            AccountMeta::new_readonly(INSTRUCTIONS, false),
        ],
        data: data("init_lending_market", &[&quote]),
    };
    env.send_admin(&[init]).unwrap_or_else(|e| panic!("init_lending_market: {:?}\n{:#?}", e.err, e.meta.logs));

    let (spy, qqq, nvda, usdc) =
        (reserve_for(&env, SPYX_MINT), reserve_for(&env, QQQX_MINT), reserve_for(&env, NVDAX_MINT), reserve_for(&env, USDC_MINT));
    let mut km = Km { env, market, lma, spy, qqq, nvda, usdc };
    for (i, r) in [km.spy.clone(), km.qqq.clone(), km.nvda.clone(), km.usdc.clone()].iter().enumerate() {
        km.init_reserve(r, i, coll_ltv);
    }
    km
}

impl Km {
    fn init_reserve(&mut self, r: &Rs, i: usize, coll_ltv: Option<(u8, u8)>) {
        let admin = self.env.admin.pubkey();
        let l = self.env.svm.minimum_balance_for_rent_exemption(8 + 8616);
        self.env.svm.set_account(r.key, Account { lamports: l, data: vec![0; 8 + 8616], owner: KLEND, executable: false, rent_epoch: 0 }).unwrap();
        // The seed deposit klend takes at init (market.min_initial_deposit_amount = 100_000 base units).
        let src = if r.liq_program == TOKEN_PROGRAM {
            self.env.usdc_account(&admin, 1_000_000)
        } else {
            token_account_2022(&mut self.env, &admin, &r.mint, 1_000_000)
        };
        let init = Instruction {
            program_id: KLEND,
            accounts: vec![
                AccountMeta::new(admin, true),
                AccountMeta::new_readonly(self.market, false),
                AccountMeta::new_readonly(self.lma, false),
                AccountMeta::new(r.key, false),
                AccountMeta::new_readonly(r.mint, false),
                AccountMeta::new(r.liq_supply, false),
                AccountMeta::new(r.fee_vault, false),
                AccountMeta::new(r.coll_mint, false),
                AccountMeta::new(r.coll_supply, false),
                AccountMeta::new(src, false),
                AccountMeta::new_readonly(RENT, false),
                AccountMeta::new_readonly(r.liq_program, false),
                AccountMeta::new_readonly(TOKEN_PROGRAM, false),
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new_readonly(INSTRUCTIONS, false),
            ],
            data: disc("init_reserve").to_vec(),
        };
        self.env.send_admin(&[init]).unwrap_or_else(|e| panic!("init_reserve {i}: {:?}\n{:#?}", e.err, e.meta.logs));
        let mut c = xstock_cfg(i);
        if i < 3 {
            if let Some((ltv, lt)) = coll_ltv {
                c.ltv = ltv;
                c.lt = lt;
            }
        }
        let curve: Vec<u8> = c.curve.iter().flat_map(|(u, b)| [u.to_le_bytes(), b.to_le_bytes()].concat()).collect();
        let mut name = [0u8; 32];
        name[..c.name.len()].copy_from_slice(c.name.as_bytes());
        let mut feed = kl::SCOPE.to_bytes().to_vec();
        feed.truncate(32);
        // (mode, value), modes from klend's UpdateConfigMode.
        let mut steps: Vec<(u8, Vec<u8>)> = vec![
            (1, vec![c.ltv]),
            (3, vec![c.lt]),
            (2, 1000u16.to_le_bytes().to_vec()),  // max liquidation bonus
            (31, 500u16.to_le_bytes().to_vec()),  // min liquidation bonus
            (30, 99u16.to_le_bytes().to_vec()),   // bad-debt liquidation bonus
            (4, vec![50]),                        // protocol liquidation fee pct
            (5, vec![if i == 2 { 0 } else { 10 }]), // protocol take rate pct
            (11, u64b(c.heuristic.0)),
            (12, u64b(c.heuristic.1)),
            (13, u64b(c.heuristic.2)),
            (14, u64b(if i == 3 { 300 } else { 500 })),
            (20, feed),
            (16, chain(c.chain)),
            (15, chain(c.twap)),
            (17, name.to_vec()),
            (18, u64b(c.max_age.0)),
            (19, u64b(c.max_age.1)),
            (24, curve),
            (33, u64b(c.borrow_factor)),
            (26, {
                // debt withdrawal cap: capacity, interval seconds
                let mut v = Vec::new();
                v.extend_from_slice(&(c.borrow_limit as i64).to_le_bytes());
                v.extend_from_slice(&86_400u64.to_le_bytes());
                v
            }),
            (27, {
                let mut v = Vec::new();
                v.extend_from_slice(&(c.deposit_limit as i64).to_le_bytes());
                v.extend_from_slice(&86_400u64.to_le_bytes());
                v
            }),
            (36, u64b(7200)), // deleveraging threshold decrease bps / day
            (32, u64b(604_800)),
        ];
        steps.push((39, vec![0])); // status = Active
        steps.push((45, u64b(u64::MAX))); // borrow limit outside an elevation group: unlimited, as on Kamino's reserves
        steps.push((9, u64b(c.deposit_limit)));
        steps.push((10, u64b(c.borrow_limit)));
        for (mode, value) in steps {
            let ix = mode_ix(self, r, mode, value.clone());
            self.env.send_admin(&[ix]).unwrap_or_else(|e| panic!("reserve {i} mode {mode}: {:?}\n{:#?}", e.err, e.meta.logs));
        }
    }

    fn refresh_reserve(&self, r: &Rs) -> Instruction {
        Instruction {
            program_id: KLEND,
            accounts: vec![
                AccountMeta::new(r.key, false),
                AccountMeta::new_readonly(self.market, false),
                AccountMeta::new_readonly(KLEND, false),
                AccountMeta::new_readonly(KLEND, false),
                AccountMeta::new_readonly(KLEND, false),
                AccountMeta::new_readonly(kl::SCOPE, false),
            ],
            data: vec![2, 218, 138, 235, 79, 201, 25, 102],
        }
    }

    fn refresh_obligation(&self, ob: &Pubkey, reserves: &[&Rs]) -> Instruction {
        let mut accounts = vec![AccountMeta::new_readonly(self.market, false), AccountMeta::new(*ob, false)];
        accounts.extend(reserves.iter().map(|r| AccountMeta::new_readonly(r.key, false)));
        Instruction { program_id: KLEND, accounts, data: vec![33, 132, 147, 228, 151, 192, 72, 89] }
    }

    /// Reserve refreshes for `rs` then the obligation refresh, the way klend wants them before an action.
    fn refreshes(&self, ob: &Pubkey, deposits: &[&Rs], borrows: &[&Rs]) -> Vec<Instruction> {
        let mut v: Vec<Instruction> = deposits.iter().chain(borrows.iter()).map(|r| self.refresh_reserve(r)).collect();
        let all: Vec<&Rs> = deposits.iter().chain(borrows.iter()).copied().collect();
        v.push(self.refresh_obligation(ob, &all));
        v
    }
}

fn farms_none() -> Vec<AccountMeta> {
    // Optional obligation farms accounts absent (Anchor: the program id stands in for None), then the farms program.
    vec![AccountMeta::new_readonly(KLEND, false), AccountMeta::new_readonly(KLEND, false), AccountMeta::new_readonly(kl::FARMS, false)]
}

struct User {
    kp: Keypair,
    meta: Pubkey,
    ob: Pubkey,
}

impl Km {
    fn open_user(&mut self) -> User {
        let kp = self.env.funded();
        let meta = klend_pda(&[b"user_meta", kp.pubkey().as_ref()]);
        let ob = klend_pda(&[&[0u8], &[0u8], kp.pubkey().as_ref(), self.market.as_ref(), Pubkey::default().as_ref(), Pubkey::default().as_ref()]);
        let init_meta = Instruction {
            program_id: KLEND,
            accounts: vec![
                AccountMeta::new_readonly(kp.pubkey(), true),
                AccountMeta::new(kp.pubkey(), true),
                AccountMeta::new(meta, false),
                AccountMeta::new_readonly(KLEND, false), // referrer: none
                AccountMeta::new_readonly(RENT, false),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
            data: data("init_user_metadata", &[&[0u8; 32]]),
        };
        let init_ob = Instruction {
            program_id: KLEND,
            accounts: vec![
                AccountMeta::new_readonly(kp.pubkey(), true),
                AccountMeta::new(kp.pubkey(), true),
                AccountMeta::new(ob, false),
                AccountMeta::new_readonly(self.market, false),
                AccountMeta::new_readonly(Pubkey::default(), false),
                AccountMeta::new_readonly(Pubkey::default(), false),
                AccountMeta::new_readonly(meta, false),
                AccountMeta::new_readonly(RENT, false),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
            data: data("init_obligation", &[&[0u8, 0u8]]),
        };
        self.env.send(&[init_meta, init_ob], &[&kp]).unwrap_or_else(|e| panic!("open_user: {:?}\n{:#?}", e.err, e.meta.logs));
        User { kp, meta, ob }
    }

    fn deposit(&self, u: &User, r: &Rs, src: &Pubkey, amount: u64, permissioner: Option<&Pubkey>) -> Instruction {
        let mut accounts = vec![
            AccountMeta::new(u.kp.pubkey(), true),
            AccountMeta::new(u.ob, false),
            AccountMeta::new_readonly(self.market, false),
            AccountMeta::new_readonly(self.lma, false),
            AccountMeta::new(r.key, false),
            AccountMeta::new_readonly(r.mint, false),
            AccountMeta::new(r.liq_supply, false),
            AccountMeta::new(r.coll_mint, false),
            AccountMeta::new(r.coll_supply, false),
            AccountMeta::new(*src, false),
            AccountMeta::new_readonly(KLEND, false), // placeholder user destination collateral: none
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
            AccountMeta::new_readonly(r.liq_program, false),
            AccountMeta::new_readonly(INSTRUCTIONS, false),
        ];
        accounts.extend(farms_none());
        if let Some(p) = permissioner {
            accounts.push(AccountMeta::new_readonly(*p, true));
        }
        Instruction {
            program_id: KLEND,
            accounts,
            data: data("deposit_reserve_liquidity_and_obligation_collateral_v2", &[&amount.to_le_bytes()]),
        }
    }

    fn borrow(&self, u: &User, r: &Rs, dest: &Pubkey, amount: u64, permissioner: Option<&Pubkey>) -> Instruction {
        let mut accounts = vec![
            AccountMeta::new_readonly(u.kp.pubkey(), true),
            AccountMeta::new(u.ob, false),
            AccountMeta::new_readonly(self.market, false),
            AccountMeta::new_readonly(self.lma, false),
            AccountMeta::new(r.key, false),
            AccountMeta::new_readonly(r.mint, false),
            AccountMeta::new(r.liq_supply, false),
            AccountMeta::new(r.fee_vault, false),
            AccountMeta::new(*dest, false),
            AccountMeta::new_readonly(KLEND, false), // referrer token state: none
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
            AccountMeta::new_readonly(INSTRUCTIONS, false),
        ];
        accounts.extend(farms_none());
        if let Some(p) = permissioner {
            accounts.push(AccountMeta::new_readonly(*p, true));
        }
        Instruction { program_id: KLEND, accounts, data: data("borrow_obligation_liquidity_v2", &[&amount.to_le_bytes()]) }
    }

    fn repay(&self, u: &User, r: &Rs, src: &Pubkey, amount: u64) -> Instruction {
        let mut accounts = vec![
            AccountMeta::new_readonly(u.kp.pubkey(), true),
            AccountMeta::new(u.ob, false),
            AccountMeta::new_readonly(self.market, false),
            AccountMeta::new(r.key, false),
            AccountMeta::new_readonly(r.mint, false),
            AccountMeta::new(r.liq_supply, false),
            AccountMeta::new(*src, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
            AccountMeta::new_readonly(INSTRUCTIONS, false),
        ];
        // Repay's farms accounts: obligation farm user state, reserve farm state (both none), the market authority, farms.
        accounts.extend([
            AccountMeta::new_readonly(KLEND, false),
            AccountMeta::new_readonly(KLEND, false),
            AccountMeta::new_readonly(self.lma, false),
            AccountMeta::new_readonly(kl::FARMS, false),
        ]);
        Instruction { program_id: KLEND, accounts, data: data("repay_obligation_liquidity_v2", &[&amount.to_le_bytes()]) }
    }

    fn withdraw(&self, u: &User, r: &Rs, dest: &Pubkey, coll_amount: u64) -> Instruction {
        let mut accounts = vec![
            AccountMeta::new(u.kp.pubkey(), true),
            AccountMeta::new(u.ob, false),
            AccountMeta::new_readonly(self.market, false),
            AccountMeta::new_readonly(self.lma, false),
            AccountMeta::new(r.key, false),
            AccountMeta::new_readonly(r.mint, false),
            AccountMeta::new(r.coll_supply, false),
            AccountMeta::new(r.coll_mint, false),
            AccountMeta::new(r.liq_supply, false),
            AccountMeta::new(*dest, false),
            AccountMeta::new_readonly(KLEND, false), // placeholder user destination collateral: none
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
            AccountMeta::new_readonly(r.liq_program, false),
            AccountMeta::new_readonly(INSTRUCTIONS, false),
        ];
        accounts.extend(farms_none());
        Instruction {
            program_id: KLEND,
            accounts,
            data: data("withdraw_obligation_collateral_and_redeem_reserve_collateral_v2", &[&coll_amount.to_le_bytes()]),
        }
    }

    fn step(&mut self, label: &str, ixs: &[Instruction], signers: &[&Keypair]) -> Result<u64, String> {
        self.env.svm.warp_to_slot(self.env.slot() + 1);
        self.env.freshen_scope();
        match self.env.send(ixs, signers) {
            Ok(m) => {
                println!("  {label}: ok, {} CU", m.compute_units_consumed);
                Ok(m.compute_units_consumed)
            }
            Err(e) => {
                let last = e.meta.logs.iter().filter(|l| l.contains("Error") || l.contains("log:")).rev().take(3).cloned().collect::<Vec<_>>().join(" || ");
                println!("  {label}: FAILED {:?} | {last}", e.err);
                Err(format!("{:?} {last}", e.err))
            }
        }
    }
}

/// D1.0 question 1: a market with SPYx, QQQx, NVDAx as collateral and USDC as the borrow asset, priced by Scope.
#[test]
fn spike_1_market_with_scope_prices() {
    let mut km = build(None);
    for r in [km.spy.clone(), km.qqq.clone(), km.nvda.clone(), km.usdc.clone()] {
        let ix = km.refresh_reserve(&r);
        km.step(&format!("refresh_reserve {}", r.key), &[ix], &[&km.env.admin.insecure_clone()]).unwrap();
        let d = km.env.data(&r.key);
        let px = u128::from_le_bytes(d[RS_PRICE..RS_PRICE + 16].try_into().unwrap()) as f64 / 2f64.powi(60);
        println!("    market price per base unit x 2^-60 = {px:.12e}");
    }
}

const RS_PRICE: usize = 248;

fn decimals(env: &Env, mint: &Pubkey) -> u8 {
    env.data(mint)[44]
}

impl Km {
    fn all(&self) -> [Rs; 4] {
        [self.spy.clone(), self.qqq.clone(), self.nvda.clone(), self.usdc.clone()]
    }

    /// The refreshes klend wants before an action on `ob`: every reserve the obligation holds or `extra`, then the
    /// obligation refresh with its deposit reserves followed by its borrow reserves, in the order it stores them.
    fn pre(&self, ob: &Pubkey, extra: &[&Rs]) -> Vec<Instruction> {
        let d = self.env.data(ob);
        let key_at = |o: usize| Pubkey::new_from_array(d[o..o + 32].try_into().unwrap());
        let mut deposits = vec![];
        for i in 0..8 {
            let k = key_at(96 + 136 * i);
            if k != Pubkey::default() {
                deposits.push(k);
            }
        }
        let mut borrows = vec![];
        for i in 0..5 {
            let k = key_at(1208 + 200 * i);
            if k != Pubkey::default() {
                borrows.push(k);
            }
        }
        let all = self.all();
        let by_key = |k: &Pubkey| all.iter().find(|r| &r.key == k).unwrap().clone();
        let mut order: Vec<Pubkey> = deposits.iter().chain(borrows.iter()).copied().collect();
        for e in extra {
            if !order.contains(&e.key) {
                order.push(e.key);
            }
        }
        let mut v: Vec<Instruction> = order.iter().map(|k| self.refresh_reserve(&by_key(k))).collect();
        let mut ob_ix = vec![AccountMeta::new_readonly(self.market, false), AccountMeta::new(*ob, false)];
        ob_ix.extend(deposits.iter().chain(borrows.iter()).map(|k| AccountMeta::new_readonly(*k, false)));
        v.push(Instruction { program_id: KLEND, accounts: ob_ix, data: vec![33, 132, 147, 228, 151, 192, 72, 89] });
        v
    }
}

/// The USDC reserve funded by an LP (an obligation deposit); returns the LP.
fn seed_usdc_liquidity(km: &mut Km, usdc: u64) -> User {
    let lp = km.open_user();
    let src = km.env.usdc_account(&lp.kp.pubkey(), usdc);
    let r = km.usdc.clone();
    let mut ixs = km.pre(&lp.ob, &[&r]);
    ixs.push(km.deposit(&lp, &r, &src, usdc, None));
    km.step("LP deposits USDC", &ixs, &[&lp.kp]).unwrap();
    lp
}

fn spy_account(km: &mut Km, u: &User, tokens: u64) -> Pubkey {
    let amount = tokens * 10u64.pow(decimals(&km.env, &SPYX_MINT) as u32);
    token_account_2022(&mut km.env, &u.kp.pubkey(), &SPYX_MINT, amount)
}

/// `u` deposits `tokens` SPYx; returns (her SPYx account, her empty USDC account).
fn deposit_spy(km: &mut Km, u: &User, tokens: u64) -> (Pubkey, Pubkey) {
    let spy_acct = spy_account(km, u, tokens);
    let usdc_acct = km.env.usdc_account(&u.kp.pubkey(), 0);
    let amount = tokens * 10u64.pow(decimals(&km.env, &SPYX_MINT) as u32);
    let spy = km.spy.clone();
    let mut ixs = km.pre(&u.ob, &[&spy]);
    ixs.push(km.deposit(u, &spy, &spy_acct, amount, None));
    km.step("deposit SPYx", &ixs, &[&u.kp]).unwrap();
    (spy_acct, usdc_acct)
}

fn borrow_usdc(km: &mut Km, a: &User, dest: &Pubkey, usdc: u64, perm: Option<&Keypair>, label: &str) -> Result<u64, String> {
    let r = km.usdc.clone();
    let mut ixs = km.pre(&a.ob, &[&r]);
    ixs.push(km.borrow(a, &r, dest, usdc * 1_000_000, perm.map(|p| p.pubkey()).as_ref()));
    let mut signers = vec![&a.kp];
    if let Some(p) = perm {
        signers.push(p);
    }
    km.step(label, &ixs, &signers)
}

/// D1.0 question 2: what klend lets a permissioner gate (borrow, deposit, liquidate) and what stays with the owner.
#[test]
fn spike_2_permissioned_borrow_only() {
    let mut km = build(None);
    let _lp = seed_usdc_liquidity(&mut km, 1_000_000 * 1_000_000);
    let alice = km.open_user();
    let (spy_acct, usdc_acct) = deposit_spy(&mut km, &alice, 10); // 10 SPYx ~ $7.8k

    println!("-- before any permissioning");
    borrow_usdc(&mut km, &alice, &usdc_acct, 1_000, None, "open market: Alice borrows 1,000 USDC").unwrap();

    println!("-- permissioning authority = P, permissioned ops = BORROW");
    let p = Keypair::new();
    let owner = km.env.admin.pubkey();
    let ix1 = market_ix(&km, &owner, 42, p.pubkey().as_ref());
    let ix2 = market_ix(&km, &owner, 43, &2u64.to_le_bytes());
    let admin = km.env.admin.insecure_clone();
    km.step("owner sets authority and ops", &[ix1, ix2], &[&admin]).unwrap();

    assert!(borrow_usdc(&mut km, &alice, &usdc_acct, 100, None, "Alice borrows without P").is_err());
    let bob = km.open_user();
    let _ = deposit_spy(&mut km, &bob, 10);
    let bob_usdc = km.env.usdc_account(&bob.kp.pubkey(), 0);
    assert!(borrow_usdc(&mut km, &bob, &bob_usdc, 100, None, "Bob borrows without P").is_err());
    borrow_usdc(&mut km, &alice, &usdc_acct, 100, Some(&p), "Alice borrows with P co-signing").unwrap();

    println!("-- the exits stay with the obligation owner, no permissioner");
    let (spy, usdc_r) = (km.spy.clone(), km.usdc.clone());
    credit(&mut km.env, &usdc_acct, 5_000 * 1_000_000);
    let mut ixs = km.pre(&alice.ob, &[]);
    ixs.push(km.repay(&alice, &usdc_r, &usdc_acct, u64::MAX));
    km.step("Alice repays everything (no P)", &ixs, &[&alice.kp]).unwrap();
    let mut ixs = km.pre(&alice.ob, &[]);
    ixs.push(km.withdraw(&alice, &spy, &spy_acct, u64::MAX));
    km.step("Alice withdraws all collateral (no P)", &ixs, &[&alice.kp]).unwrap();
    let after = km.env.token_balance(&spy_acct);
    println!("  Alice's SPYx back in her wallet: {after}");
    assert!(after > 0);
}

fn liquidate(km: &Km, liq: &Keypair, ob: &Pubkey, usdc_src: &Pubkey, spy_dest: &Pubkey, coll_dest: &Pubkey, amount: u64) -> Instruction {
    let (spy, usdc) = (&km.spy, &km.usdc);
    let accounts = vec![
        AccountMeta::new_readonly(liq.pubkey(), true),
        AccountMeta::new(*ob, false),
        AccountMeta::new_readonly(km.market, false),
        AccountMeta::new_readonly(km.lma, false),
        AccountMeta::new(usdc.key, false),
        AccountMeta::new_readonly(usdc.mint, false),
        AccountMeta::new(usdc.liq_supply, false),
        AccountMeta::new(spy.key, false),
        AccountMeta::new_readonly(spy.mint, false),
        AccountMeta::new(spy.coll_mint, false),
        AccountMeta::new(spy.coll_supply, false),
        AccountMeta::new(spy.liq_supply, false),
        AccountMeta::new(spy.fee_vault, false),
        AccountMeta::new(*usdc_src, false),
        AccountMeta::new(*coll_dest, false),
        AccountMeta::new(*spy_dest, false),
        AccountMeta::new_readonly(TOKEN_PROGRAM, false),
        AccountMeta::new_readonly(TOKEN_PROGRAM, false),
        AccountMeta::new_readonly(TOKEN_2022_PROGRAM, false),
        AccountMeta::new_readonly(INSTRUCTIONS, false),
        AccountMeta::new_readonly(KLEND, false),
        AccountMeta::new_readonly(KLEND, false),
        AccountMeta::new_readonly(KLEND, false),
        AccountMeta::new_readonly(KLEND, false),
        AccountMeta::new_readonly(kl::FARMS, false),
    ];
    let mut d = credence_core::kamino::LIQUIDATE_V2_DISC.to_vec();
    d.extend_from_slice(&amount.to_le_bytes());
    d.extend_from_slice(&0u64.to_le_bytes());
    d.extend_from_slice(&0u64.to_le_bytes());
    Instruction { program_id: KLEND, accounts, data: d }
}

/// D1.0 questions 2 and 4: with a higher limit, what the owner can still do alone (withdraw up to the LTV), and that
/// klend's own liquidators are not gated by a BORROW-only permissioner.
#[test]
fn spike_3_higher_limit_withdraw_and_liquidation() {
    let mut km = build(Some((85, 90)));
    let _lp = seed_usdc_liquidity(&mut km, 1_000_000 * 1_000_000);
    let p = Keypair::new();
    let owner = km.env.admin.pubkey();
    let ix1 = market_ix(&km, &owner, 42, p.pubkey().as_ref());
    let ix2 = market_ix(&km, &owner, 43, &2u64.to_le_bytes());
    let admin = km.env.admin.insecure_clone();
    km.step("owner: permissioner P, ops = BORROW", &[ix1, ix2], &[&admin]).unwrap();

    let alice = km.open_user();
    let (spy_acct, usdc_acct) = deposit_spy(&mut km, &alice, 10); // $7,817
    println!("-- limits: LTV 85 / LT 90 on SPYx");
    borrow_usdc(&mut km, &alice, &usdc_acct, 6_200, Some(&p), "borrow 6,200 USDC (79.3% LTV) with P").unwrap();
    assert!(borrow_usdc(&mut km, &alice, &usdc_acct, 600, Some(&p), "borrow 600 more (87% LTV), P co-signs").is_err());
    borrow_usdc(&mut km, &alice, &usdc_acct, 400, Some(&p), "borrow 400 more (84.4% LTV), P co-signs").unwrap();

    println!("-- the owner alone can push to the LTV by withdrawing (no permissioner on withdraw)");
    let spy = km.spy.clone();
    let before = km.env.token_balance(&spy_acct);
    let mut ixs = km.pre(&alice.ob, &[]);
    ixs.push(km.withdraw(&alice, &spy, &spy_acct, 0_000_000_001)); // 1 base unit of cToken: dust, passes
    km.step("withdraw dust", &ixs, &[&alice.kp]).unwrap();
    let mut ixs = km.pre(&alice.ob, &[]);
    ixs.push(km.withdraw(&alice, &spy, &spy_acct, 5_000_000)); // 0.05 SPYx (~$39) fits under the LTV (klend allows ~$54)
    km.step("withdraw 0.05 SPYx (~$39, inside the LTV), owner alone", &ixs, &[&alice.kp]).unwrap();
    let mut ixs = km.pre(&alice.ob, &[]);
    ixs.push(km.withdraw(&alice, &spy, &spy_acct, 100_000_000)); // 0.1 SPYx: LTV 85.5%
    let r = km.step("withdraw 0.1 SPYx (LTV would be ~85.5%)", &ixs, &[&alice.kp]);
    assert!(r.is_err(), "klend refuses a withdrawal that takes the obligation above its LTV");
    let after = km.env.token_balance(&spy_acct);
    println!("  wallet SPYx before/after: {before} -> {after}");

    println!("-- price falls 8% (Scope SPYx chain 344) then 12%: not liquidatable at LT 90 until LTV crosses 90%");
    let now = km.env.now();
    let liq = km.env.funded();
    let liq_usdc = km.env.usdc_account(&liq.pubkey(), 100_000 * 1_000_000);
    let liq_spy = token_account_2022(&mut km.env, &liq.pubkey(), &SPYX_MINT, 0);
    // a cToken account for the liquidator (classic token program), for klend's collateral destination slot
    let coll_dest = Pubkey::new_unique();
    let mut cd = token_account_data(&km.spy.coll_mint, &liq.pubkey(), 0);
    cd.truncate(165);
    let l = km.env.svm.minimum_balance_for_rent_exemption(165);
    km.env.svm.set_account(coll_dest, Account { lamports: l, data: cd, owner: TOKEN_PROGRAM, executable: false, rent_epoch: 0 }).unwrap();
    let px = 781.74;
    km.env.put_scope(344, px * 0.92, now);
    let spy_r = km.spy.clone();
    let usdc_r = km.usdc.clone();
    let mut ixs = km.pre(&alice.ob, &[]);
    ixs.push(liquidate(&km, &liq, &alice.ob, &liq_usdc, &liq_spy, &coll_dest, 1_000 * 1_000_000));
    let r = km.step("liquidator at -8% (LTV ~91.7% of the new value)", &ixs, &[&liq]);
    assert!(r.is_ok(), "a stranger liquidates through a BORROW-only permissioned market: {r:?}");
    let _ = (spy_r, usdc_r);
    assert!(km.env.token_balance(&liq_spy) > 0, "the liquidator received SPYx");
}
