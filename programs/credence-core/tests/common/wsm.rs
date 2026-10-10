//! Weekend-safe market (D1) test world: Credence's side (`Env::real`) plus a klend market built at the program's
//! `WSM_MARKET` address, permissioned for BORROW to `["wsm_auth"]`, with Kamino's reserve values and the proposed
//! limits (SPYx 80/85, QQQx 77/82, NVDAx 60/70), an external LP, and `init_wsm_market` run.
#![allow(dead_code)]

use super::km::*;
use super::*;
use anchor_lang::solana_program::instruction::AccountMeta;
use credence_core::instructions::wsm::{WsmAssetInit, WsmParams};
use credence_core::kamino::WSM_MARKET;
use solana_keypair::Keypair;
use solana_signer::Signer;

pub const PCT: u64 = 10_000_000_000_000_000; // 1% in WAD
pub const WSM_LIMITS: Limits = [Some((80, 85)), Some((77, 82)), Some((60, 70))];
/// Kamino's own max LTV today, the market's "normal limit" for the withdraw guard.
pub const NORMAL_LTV: [u64; 3] = [73 * PCT, 70 * PCT, 55 * PCT];

pub fn wsm_market_pda() -> Pubkey {
    pda(&[b"wsm_market"])
}
pub fn wsm_auth_pda() -> Pubkey {
    pda(&[b"wsm_auth"])
}
pub fn wsm_pda(user: &Pubkey) -> Pubkey {
    pda(&[b"wsm", user.as_ref()])
}
pub fn wsm_usdc_pda(user: &Pubkey) -> Pubkey {
    pda(&[b"wsm_usdc", user.as_ref()])
}
pub fn wsm_coll_pda(user: &Pubkey) -> Pubkey {
    pda(&[b"wsm_coll", user.as_ref()])
}

pub fn wsm_params() -> WsmParams {
    WsmParams {
        max_dcp_wad: 945 * PCT / 10, // 0.945
        freeze_secs: 4 * 3600,
        market_debt_cap: 5_000_000 * 1_000_000,
        worst_loss_ratio_wad: 15 * PCT, // 15% of the debt: above NVDAx's 12% at 0.85
    }
}

/// A user of the market: wallet, token accounts, and the addresses of their klend obligation.
pub struct Wu {
    pub kp: Keypair,
    pub usdc: Pubkey,
    pub coll: Pubkey,
    pub account: Pubkey,
    pub obligation: Pubkey,
}

pub struct W {
    pub km: Km,
    pub lp: User,
}

impl W {
    pub fn env(&mut self) -> &mut Env {
        &mut self.km.env
    }

    /// The world at Thursday Oct 8 noon ET (outside every freeze), one external LP with `lp_market_usdc` in the market.
    pub fn new(vault_usdc: u64, lp_market_usdc: u64) -> W {
        let mut env = Env::real(vault_usdc);
        env.load_klend_core();
        let mut km = Km::build_on(env, WSM_MARKET, WSM_LIMITS);
        let owner = km.env.admin.pubkey();
        let admin = km.env.admin.insecure_clone();
        // The market is permissioned for BORROW to the program's PDA only: LPs supply freely, nobody else can borrow.
        let ix1 = market_ix(&km, &owner, 42, wsm_auth_pda().as_ref());
        let ix2 = market_ix(&km, &owner, 43, &2u64.to_le_bytes());
        km.step("market: permissioning authority = wsm_auth, ops = BORROW", &[ix1, ix2], &[&admin]).unwrap();
        // init_wsm_market
        let ix = Self::ix_init_wsm_market(&km, wsm_params());
        km.step("init_wsm_market", &[ix], &[&admin]).unwrap_or_else(|e| panic!("{e}"));
        let lp = seed_usdc_liquidity(&mut km, lp_market_usdc);
        W { km, lp }
    }

    pub fn ix_init_wsm_market(km: &Km, params: WsmParams) -> Instruction {
        let admin = km.env.admin.pubkey();
        let mut accounts = acc::InitWsmMarket {
            admin,
            config: config_pda(),
            wsm_market: wsm_market_pda(),
            usdc_reserve: km.usdc.key,
            system_program: anchor_lang::solana_program::system_program::ID,
        }
        .to_account_metas(None);
        for (i, r) in [&km.spy, &km.qqq, &km.nvda].iter().enumerate() {
            accounts.push(AccountMeta::new_readonly(asset_pda(&ticker(REAL_TICKERS[i])), false));
            accounts.push(AccountMeta::new_readonly(r.key, false));
        }
        let assets = (0..3).map(|i| WsmAssetInit { ticker: ticker(REAL_TICKERS[i]), normal_ltv_wad: NORMAL_LTV[i] }).collect();
        Instruction::new_with_bytes(credence_core::ID, &ix::InitWsmMarket { params, assets }.data(), accounts)
    }

    /// A funded user with `spyx` SPYx (whole tokens) and `usdc` USDC in their wallet.
    pub fn user(&mut self, spyx: u64, usdc: u64) -> Wu {
        let kp = self.km.env.funded();
        let coll = token_account_2022(&mut self.km.env, &kp.pubkey(), &SPYX_MINT, spyx * 100_000_000);
        let usdc = self.km.env.usdc_account(&kp.pubkey(), usdc);
        let account = wsm_pda(&kp.pubkey());
        let obligation = credence_core::wsm_klend::obligation_address(&account);
        Wu { kp, usdc, coll, account, obligation }
    }

    fn klend_accts(&self) -> acc::WsmKlend {
        acc::WsmKlend {
            klend_market: WSM_MARKET,
            klend_lma: self.km.lma,
            klend_program: KLEND,
            farms_program: kl::FARMS,
            instruction_sysvar: kl::INSTRUCTIONS_SYSVAR,
        }
    }

    pub fn ix_open(&self, u: &Wu) -> Instruction {
        let user = u.kp.pubkey();
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::WsmOpen { ticker: ticker("SPYx") }.data(),
            acc::WsmOpen {
                user,
                config: config_pda(),
                wsm_market: wsm_market_pda(),
                asset: asset_pda(&ticker("SPYx")),
                wsm_account: u.account,
                wsm_usdc: wsm_usdc_pda(&user),
                wsm_coll: wsm_coll_pda(&user),
                usdc_mint: USDC_MINT,
                coll_mint: SPYX_MINT,
                klend_market: WSM_MARKET,
                klend_lma: self.km.lma,
                user_metadata: credence_core::wsm_klend::user_metadata_address(&u.account),
                obligation: u.obligation,
                klend_program: KLEND,
                farms_program: kl::FARMS,
                instruction_sysvar: kl::INSTRUCTIONS_SYSVAR,
                rent: RENT,
                token_program: TOKEN_PROGRAM,
                token_2022_program: TOKEN_2022_PROGRAM,
                system_program: anchor_lang::solana_program::system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_deposit(&self, u: &Wu, amount: u64) -> Instruction {
        let user = u.kp.pubkey();
        let r = &self.km.spy;
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::WsmDeposit { amount }.data(),
            acc::WsmDeposit {
                user,
                wsm_account: u.account,
                wsm_market: wsm_market_pda(),
                wsm_coll: wsm_coll_pda(&user),
                user_coll: u.coll,
                coll_mint: SPYX_MINT,
                obligation: u.obligation,
                reserve: r.key,
                reserve_liquidity_supply: r.liq_supply,
                reserve_collateral_mint: r.coll_mint,
                reserve_collateral_supply: r.coll_supply,
                klend: self.klend_accts(),
                collateral_token_program: TOKEN_PROGRAM,
                token_2022_program: TOKEN_2022_PROGRAM,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_borrow(&self, u: &Wu, amount: u64) -> Instruction {
        let user = u.kp.pubkey();
        let r = &self.km.usdc;
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::WsmBorrow { amount }.data(),
            acc::WsmBorrow {
                user,
                config: config_pda(),
                wsm_market: wsm_market_pda(),
                wsm_account: u.account,
                calendar: calendar_pda(),
                vault: vault_pda(),
                share_mint: shares_pda(),
                wsm_usdc: wsm_usdc_pda(&user),
                user_usdc: u.usdc,
                usdc_mint: USDC_MINT,
                obligation: u.obligation,
                usdc_reserve: r.key,
                reserve_liquidity_supply: r.liq_supply,
                reserve_fee_vault: r.fee_vault,
                wsm_auth: wsm_auth_pda(),
                klend: self.klend_accts(),
                token_program: TOKEN_PROGRAM,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_repay(&self, u: &Wu, amount: u64) -> Instruction {
        let user = u.kp.pubkey();
        let r = &self.km.usdc;
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::WsmRepay { amount }.data(),
            acc::WsmRepay {
                user,
                wsm_account: u.account,
                wsm_usdc: wsm_usdc_pda(&user),
                user_usdc: u.usdc,
                usdc_mint: USDC_MINT,
                obligation: u.obligation,
                usdc_reserve: r.key,
                reserve_liquidity_supply: r.liq_supply,
                klend: self.klend_accts(),
                token_program: TOKEN_PROGRAM,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_withdraw(&self, u: &Wu, collateral: u64) -> Instruction {
        let user = u.kp.pubkey();
        let r = &self.km.spy;
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::WsmWithdraw { collateral }.data(),
            acc::WsmWithdraw {
                user,
                wsm_account: u.account,
                wsm_market: wsm_market_pda(),
                calendar: calendar_pda(),
                wsm_coll: wsm_coll_pda(&user),
                user_coll: u.coll,
                coll_mint: SPYX_MINT,
                obligation: u.obligation,
                reserve: r.key,
                reserve_liquidity_supply: r.liq_supply,
                reserve_collateral_mint: r.coll_mint,
                reserve_collateral_supply: r.coll_supply,
                klend: self.klend_accts(),
                collateral_token_program: TOKEN_PROGRAM,
                token_2022_program: TOKEN_2022_PROGRAM,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_claim(&self, u: &Wu) -> Instruction {
        let user = u.kp.pubkey();
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::WsmClaim {}.data(),
            acc::WsmClaim {
                user,
                wsm_account: u.account,
                wsm_usdc: wsm_usdc_pda(&user),
                user_usdc: u.usdc,
                usdc_mint: USDC_MINT,
                token_program: TOKEN_PROGRAM,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_auto_cover(&self, payer: &Pubkey, u: &Wu, closure_id: u32) -> Instruction {
        let user = u.kp.pubkey();
        let tk = ticker("SPYx");
        let vault: Vault = self.km.env.anchor(&vault_pda());
        let r = &self.km.usdc;
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::WsmAutoCover { ticker: tk, closure_id }.data(),
            acc::WsmAutoCover {
                payer: *payer,
                config: config_pda(),
                wsm_market: wsm_market_pda(),
                wsm_account: u.account,
                wsm_usdc: wsm_usdc_pda(&user),
                asset: asset_pda(&tk),
                scenarios: scen_pda(&tk, closure::WEEKEND),
                epoch: epoch_pda(&tk, closure_id),
                earnings: earnings_pda(&tk),
                loss: loss_pda(closure_id),
                vault: vault_pda(),
                vault_usdc: vault.usdc,
                share_mint: vault.share_mint,
                fee_account: vault.fee_account,
                usdc_mint: USDC_MINT,
                obligation: u.obligation,
                deposit_reserve: self.km.spy.key,
                usdc_reserve: r.key,
                reserve_liquidity_supply: r.liq_supply,
                reserve_fee_vault: r.fee_vault,
                wsm_auth: wsm_auth_pda(),
                policy: policy_pda(&epoch_pda(&tk, closure_id), &u.obligation),
                klend: self.klend_accts(),
                token_program: TOKEN_PROGRAM,
                system_program: anchor_lang::solana_program::system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    /// Reserve refreshes and the obligation refresh klend wants before an action on `u`'s obligation.
    pub fn pre(&self, u: &Wu) -> Vec<Instruction> {
        let spy = self.km.spy.clone();
        let usdc = self.km.usdc.clone();
        // Both reserves always (the deposit and the borrow one), so the same list serves every action.
        let mut v = vec![self.km.refresh_reserve(&spy), self.km.refresh_reserve(&usdc)];
        let d = self.km.env.data(&u.obligation);
        let has_borrow = d[1208..1208 + 32] != [0u8; 32];
        let has_dep = d[96..96 + 32] != [0u8; 32];
        let mut ob = vec![AccountMeta::new_readonly(WSM_MARKET, false), AccountMeta::new(u.obligation, false)];
        if has_dep {
            ob.push(AccountMeta::new_readonly(spy.key, false));
        }
        if has_borrow {
            ob.push(AccountMeta::new_readonly(usdc.key, false));
        }
        v.push(Instruction { program_id: KLEND, accounts: ob, data: vec![33, 132, 147, 228, 151, 192, 72, 89] });
        v
    }

    /// Sends `pre + action` in one transaction signed by `signers`, advancing the slot and re-stamping Scope first.
    pub fn go(&mut self, label: &str, u: &Wu, action: Vec<Instruction>, signers: &[&Keypair]) -> Result<u64, String> {
        let mut ixs = self.pre(u);
        ixs.extend(action);
        self.km.step(label, &ixs, signers)
    }

    pub fn debt_usdc(&self, u: &Wu) -> f64 {
        let d = self.km.env.data(&u.obligation);
        let sf = u128::from_le_bytes(d[1208 + 88..1208 + 104].try_into().unwrap());
        (sf >> 40) as f64 / (1u128 << 20) as f64 / 1e6
    }
}
