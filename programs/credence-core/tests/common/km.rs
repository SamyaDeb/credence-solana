//! A klend market built with real klend instructions on the real mainnet binary (D1): `init_lending_market`, four
//! reserves (SPYx, QQQx, NVDAx collateral; USDC borrow) priced by Kamino's Scope account, Kamino's own reserve values
//! with the collateral limits overridable. Test-only shortcuts: the klend global config account is rewritten so the test
//! admin is the global admin (on mainnet that key is Kamino's), Scope timestamps are re-stamped (`Env::freshen_scope`),
//! token balances are written directly.
#![allow(dead_code)]

use super::*;
use anchor_lang::{
    prelude::Pubkey,
    solana_program::{instruction::{AccountMeta, Instruction}, system_program},
};
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_signer::Signer;

pub const INSTRUCTIONS: Pubkey = kl::INSTRUCTIONS_SYSVAR;
pub const RENT: Pubkey = anchor_lang::pubkey!("SysvarRent111111111111111111111111111111111");
pub const GLOBAL_CONFIG: Pubkey = anchor_lang::pubkey!("BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W");

pub fn disc(name: &str) -> [u8; 8] {
    Sha256::digest(format!("global:{name}"))[..8].try_into().unwrap()
}

pub fn klend_pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &KLEND).0
}

pub fn data(name: &str, args: &[&[u8]]) -> Vec<u8> {
    let mut d = disc(name).to_vec();
    for a in args {
        d.extend_from_slice(a);
    }
    d
}

/// One reserve of the new market.
#[derive(Clone)]
pub struct Rs {
    pub key: Pubkey,
    pub mint: Pubkey,
    pub liq_program: Pubkey,
    pub liq_supply: Pubkey,
    pub fee_vault: Pubkey,
    pub coll_mint: Pubkey,
    pub coll_supply: Pubkey,
}

/// What a reserve is configured with (percent and bps as in klend's `ReserveConfig`).
pub struct Cfg {
    pub ltv: u8,
    pub lt: u8,
    pub borrow_factor: u64,
    pub deposit_limit: u64,
    pub borrow_limit: u64,
    pub chain: [u16; 4],
    pub twap: [u16; 4],
    pub name: &'static str,
    pub heuristic: (u64, u64, u64),
    pub max_age: (u64, u64),
    pub curve: Vec<(u32, u32)>,
}

pub struct Km {
    pub env: Env,
    pub market: Pubkey,
    pub lma: Pubkey,
    pub spy: Rs,
    pub qqq: Rs,
    pub nvda: Rs,
    pub usdc: Rs,
}

pub fn mode_ix(
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

pub fn market_ix(km: &Km, signer: &Pubkey, mode: u64, value: &[u8]) -> Instruction {
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

pub fn token_account_2022(env: &mut Env, owner: &Pubkey, mint: &Pubkey, amount: u64) -> Pubkey {
    let payer = env.admin.insecure_clone();
    let ata = ata_of(owner, mint, &TOKEN_2022_PROGRAM);
    env.send(&[ix_create_ata(&payer.pubkey(), owner, mint, &TOKEN_2022_PROGRAM)], &[&payer]).unwrap();
    let mut a = env.svm.get_account(&ata).unwrap();
    a.data[64..72].copy_from_slice(&amount.to_le_bytes());
    env.svm.set_account(ata, a).unwrap();
    ata
}

pub fn credit(env: &mut Env, key: &Pubkey, amount: u64) {
    let mut a = env.svm.get_account(key).unwrap();
    a.data[64..72].copy_from_slice(&amount.to_le_bytes());
    env.svm.set_account(*key, a).unwrap();
}

pub fn reserve_for(env: &Env, mint: Pubkey) -> Rs {
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

pub fn u64b(v: u64) -> Vec<u8> {
    v.to_le_bytes().to_vec()
}

pub fn chain(c: [u16; 4]) -> Vec<u8> {
    c.iter().flat_map(|x| x.to_le_bytes()).collect()
}

pub fn xstock_cfg(i: usize) -> Cfg {
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

/// Per-collateral (LTV, LT) overrides of Kamino's values: SPYx, QQQx, NVDAx.
pub type Limits = [Option<(u8, u8)>; 3];

impl Env {
    /// klend, farms, Kamino's Scope account (a read-only copy of mainnet) and klend's global config with the test admin
    /// as global admin. Idempotent; leaves the clock alone.
    pub fn load_klend_core(&mut self) {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");
        for (name, id) in [("klend", KLEND), ("farms", kl::FARMS)] {
            if self.svm.get_account(&id).is_some() {
                continue;
            }
            let so = std::fs::read(format!("{dir}/programs/{name}.so")).expect("klend binaries: scripts/test.sh fetches them");
            self.svm.add_program(id, &so).unwrap();
        }
        let snap = kl::snapshot();
        let scope_owner: Pubkey = snap["accounts"]["scope_prices"]["owner"].as_str().unwrap().parse().unwrap();
        let scope = std::fs::read(format!("{dir}/klend/scope_prices.bin")).unwrap();
        let l = self.svm.minimum_balance_for_rent_exemption(scope.len());
        self.svm.set_account(kl::SCOPE, Account { lamports: l, data: scope, owner: scope_owner, executable: false, rent_epoch: 0 }).unwrap();
        let mut gc = std::fs::read(format!("{dir}/klend/global_config.bin")).unwrap();
        gc[8..40].copy_from_slice(self.admin.pubkey().as_ref());
        let l = self.svm.minimum_balance_for_rent_exemption(gc.len());
        self.svm.set_account(GLOBAL_CONFIG, Account { lamports: l, data: gc, owner: KLEND, executable: false, rent_epoch: 0 }).unwrap();
    }
}

/// Standalone market (the D1.0 spike): the clock at the snapshot, a random market address.
pub fn build(coll_ltv: Option<(u8, u8)>) -> Km {
    let mut env = Env::new();
    env.load_klend_core();
    let snap = kl::snapshot();
    let newest = snap["scope"].as_object().unwrap().values().map(|v| v["unixTimestamp"].as_i64().unwrap()).max().unwrap();
    env.svm.warp_to_slot(snap["slot"].as_u64().unwrap() + 1);
    env.set_time(newest + 5);
    env.freshen_scope();
    Km::build_on(env, Pubkey::new_unique(), [coll_ltv; 3])
}

impl Km {
    /// `init_lending_market` at `market` (any address: fork tooling writes the zeroed account) and the four reserves.
    pub fn build_on(mut env: Env, market: Pubkey, limits: Limits) -> Km {
        env.load_klend_core();
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
            km.init_reserve(r, i, limits);
        }
        km
    }
}

impl Km {
    pub fn init_reserve(&mut self, r: &Rs, i: usize, limits: Limits) {
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
            if let Some((ltv, lt)) = limits[i] {
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

    pub fn refresh_reserve(&self, r: &Rs) -> Instruction {
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

    pub fn refresh_obligation(&self, ob: &Pubkey, reserves: &[&Rs]) -> Instruction {
        let mut accounts = vec![AccountMeta::new_readonly(self.market, false), AccountMeta::new(*ob, false)];
        accounts.extend(reserves.iter().map(|r| AccountMeta::new_readonly(r.key, false)));
        Instruction { program_id: KLEND, accounts, data: vec![33, 132, 147, 228, 151, 192, 72, 89] }
    }

    /// Reserve refreshes for `rs` then the obligation refresh, the way klend wants them before an action.
    pub fn refreshes(&self, ob: &Pubkey, deposits: &[&Rs], borrows: &[&Rs]) -> Vec<Instruction> {
        let mut v: Vec<Instruction> = deposits.iter().chain(borrows.iter()).map(|r| self.refresh_reserve(r)).collect();
        let all: Vec<&Rs> = deposits.iter().chain(borrows.iter()).copied().collect();
        v.push(self.refresh_obligation(ob, &all));
        v
    }
}

pub fn farms_none() -> Vec<AccountMeta> {
    // Optional obligation farms accounts absent (Anchor: the program id stands in for None), then the farms program.
    vec![AccountMeta::new_readonly(KLEND, false), AccountMeta::new_readonly(KLEND, false), AccountMeta::new_readonly(kl::FARMS, false)]
}

pub struct User {
    pub kp: Keypair,
    pub meta: Pubkey,
    pub ob: Pubkey,
}

impl Km {
    pub fn open_user(&mut self) -> User {
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

    pub fn deposit(&self, u: &User, r: &Rs, src: &Pubkey, amount: u64, permissioner: Option<&Pubkey>) -> Instruction {
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

    pub fn borrow(&self, u: &User, r: &Rs, dest: &Pubkey, amount: u64, permissioner: Option<&Pubkey>) -> Instruction {
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

    pub fn repay(&self, u: &User, r: &Rs, src: &Pubkey, amount: u64) -> Instruction {
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

    pub fn withdraw(&self, u: &User, r: &Rs, dest: &Pubkey, coll_amount: u64) -> Instruction {
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

    pub fn step(&mut self, label: &str, ixs: &[Instruction], signers: &[&Keypair]) -> Result<u64, String> {
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


pub fn decimals(env: &Env, mint: &Pubkey) -> u8 {
    env.data(mint)[44]
}

impl Km {
    pub fn all(&self) -> [Rs; 4] {
        [self.spy.clone(), self.qqq.clone(), self.nvda.clone(), self.usdc.clone()]
    }

    /// The refreshes klend wants before an action on `ob`: every reserve the obligation holds or `extra`, then the
    /// obligation refresh with its deposit reserves followed by its borrow reserves, in the order it stores them.
    pub fn pre(&self, ob: &Pubkey, extra: &[&Rs]) -> Vec<Instruction> {
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
pub fn seed_usdc_liquidity(km: &mut Km, usdc: u64) -> User {
    let lp = km.open_user();
    let src = km.env.usdc_account(&lp.kp.pubkey(), usdc);
    let r = km.usdc.clone();
    let mut ixs = km.pre(&lp.ob, &[&r]);
    ixs.push(km.deposit(&lp, &r, &src, usdc, None));
    km.step("LP deposits USDC", &ixs, &[&lp.kp]).unwrap();
    lp
}

pub fn spy_account(km: &mut Km, u: &User, tokens: u64) -> Pubkey {
    let amount = tokens * 10u64.pow(decimals(&km.env, &SPYX_MINT) as u32);
    token_account_2022(&mut km.env, &u.kp.pubkey(), &SPYX_MINT, amount)
}

/// `u` deposits `tokens` SPYx; returns (her SPYx account, her empty USDC account).
pub fn deposit_spy(km: &mut Km, u: &User, tokens: u64) -> (Pubkey, Pubkey) {
    let spy_acct = spy_account(km, u, tokens);
    let usdc_acct = km.env.usdc_account(&u.kp.pubkey(), 0);
    let amount = tokens * 10u64.pow(decimals(&km.env, &SPYX_MINT) as u32);
    let spy = km.spy.clone();
    let mut ixs = km.pre(&u.ob, &[&spy]);
    ixs.push(km.deposit(u, &spy, &spy_acct, amount, None));
    km.step("deposit SPYx", &ixs, &[&u.kp]).unwrap();
    (spy_acct, usdc_acct)
}

pub fn borrow_usdc(km: &mut Km, a: &User, dest: &Pubkey, usdc: u64, perm: Option<&Keypair>, label: &str) -> Result<u64, String> {
    let r = km.usdc.clone();
    let mut ixs = km.pre(&a.ob, &[&r]);
    ixs.push(km.borrow(a, &r, dest, usdc * 1_000_000, perm.map(|p| p.pubkey()).as_ref()));
    let mut signers = vec![&a.kp];
    if let Some(p) = perm {
        signers.push(p);
    }
    km.step(label, &ixs, &signers)
}


pub fn liquidate(km: &Km, liq: &Keypair, ob: &Pubkey, usdc_src: &Pubkey, spy_dest: &Pubkey, coll_dest: &Pubkey, amount: u64) -> Instruction {
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

