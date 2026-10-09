//! W2 Monday Backstop on real klend (task 1.3): `backstop_liquidate` liquidates the snapshot obligation through the
//! vault PDA (klend v2 CPI), books the redeemed SPYx as inventory, marks it for NAV, and resells it in a Dutch auction.
//! INV-8 (never collateral not fully paid for) and INV-13 (never the cash kept for live cover groups and queues), a
//! failure test per instruction, CU.

mod common;

use anchor_lang::{solana_program::instruction::Instruction, InstructionData, ToAccountMetas};
use common::*;
use credence_core::{accounts as acc, instruction as ix, kamino::ReserveView, state::*, BackstopParams, CoreError};
use credence_risk_core::{cost_portion, dutch_price, inventory_mark, lot_cost, paid_for_qty};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_signer::Signer;

const LP: u64 = 2_000_000_000_000; // 2M USDC
const W: u64 = 1_000_000_000_000_000_000;
const SPY_CHAIN: usize = 344;
const ATA_PROGRAM: anchor_lang::prelude::Pubkey = anchor_lang::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SCALE: u128 = 100_000_000_000_000_000_000; // 8-decimal token vs 6-decimal USDC
type Pubkey = anchor_lang::prelude::Pubkey;

fn params() -> BackstopParams {
    BackstopParams {
        max_share_wad: W / 4,          // open inventory ≤ 25% of equity
        haircut_wad: W / 10,           // NAV mark at Scope − 10%
        max_discount_wad: W / 100 * 15, // INV-8: committed price Scope − 15%
        sale_premium_wad: W / 50,      // auction from Scope + 2%
        sale_discount_wad: W / 20,     // ... to Scope − 5%
        sale_secs: 7_200,              // over 2 h
        max_price_age_secs: 300,
    }
}

fn ata(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), token_program.as_ref(), mint.as_ref()], &ATA_PROGRAM).0
}

fn create_ata(payer: &Pubkey, owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Instruction {
    use anchor_lang::solana_program::instruction::AccountMeta;
    Instruction {
        program_id: ATA_PROGRAM,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(ata(owner, mint, token_program), false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(anchor_lang::solana_program::system_program::ID, false),
            AccountMeta::new_readonly(*token_program, false),
        ],
        data: vec![1], // CreateIdempotent
    }
}

fn pool_pda() -> Pubkey {
    pda(&[SEED_BACKSTOP])
}
fn inventory_pda(t: &str) -> Pubkey {
    pda(&[SEED_INVENTORY, &ticker(t)])
}

struct World {
    env: Env,
    keeper: Keypair,
    ctoken_mint: Pubkey,
    spyx_res: ReserveView,
}

/// Real environment, the snapshot obligation's debt scaled by `debt_num/100` (140: D/C′ ≈ 1.06, liquidatable), the
/// backstop pool and the SPYx inventory initialised.
fn world(debt_num: u128) -> World {
    let mut env = Env::real(LP);
    let a = env.admin.pubkey();
    let owner = env.funded();
    env.load_klend_with(&owner.pubkey(), |d| ob::scale_debt(d, debt_num, 100));
    let spyx_res = ReserveView::decode(&env.data(&RESERVE_SPYX)).unwrap();
    let vault = vault_pda();
    let ixs = vec![
        create_ata(&a, &vault, &SPYX_MINT, &TOKEN_2022_PROGRAM),
        create_ata(&a, &vault, &spyx_res.collateral_mint, &TOKEN_PROGRAM),
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::InitBackstop { params: params() }.data(),
            acc::InitBackstop { admin: a, config: config_pda(), pool: pool_pda(), system_program: anchor_lang::solana_program::system_program::ID }
                .to_account_metas(None),
        ),
    ];
    env.send_admin(&ixs).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let ix = ix_init_inventory(&env, &a, "SPYx", RESERVE_SPYX, spyx_res.collateral_mint);
    env.send_admin(&[ix]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let keeper = env.admin.insecure_clone(); // default params: the admin is the keeper
    World { env, keeper, ctoken_mint: spyx_res.collateral_mint, spyx_res }
}

fn ix_init_inventory(_env: &Env, admin: &Pubkey, t: &str, reserve: Pubkey, ctoken_mint: Pubkey) -> Instruction {
    let vault = vault_pda();
    Instruction::new_with_bytes(
        credence_core::ID,
        &ix::InitInventory { ticker: ticker(t) }.data(),
        acc::InitInventory {
            admin: *admin,
            config: config_pda(),
            asset: asset_pda(&ticker(t)),
            vault,
            inventory: inventory_pda(t),
            reserve,
            tokens: ata(&vault, &SPYX_MINT, &TOKEN_2022_PROGRAM),
            ctokens: ata(&vault, &ctoken_mint, &TOKEN_PROGRAM),
            token_program: TOKEN_PROGRAM,
            token_2022_program: TOKEN_2022_PROGRAM,
            system_program: anchor_lang::solana_program::system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn ix_liquidate(w: &World, keeper: &Pubkey, repay: u64) -> Instruction {
    let vault = vault_pda();
    let usdc = ReserveView::decode(&w.env.data(&RESERVE_USDC)).unwrap();
    let mut metas = acc::BackstopLiquidate {
        keeper: *keeper,
        config: config_pda(),
        pool: pool_pda(),
        asset: asset_pda(&ticker("SPYx")),
        inventory: inventory_pda("SPYx"),
        vault,
        vault_usdc: vault_usdc_pda(),
        inv_tokens: ata(&vault, &SPYX_MINT, &TOKEN_2022_PROGRAM),
        inv_ctokens: ata(&vault, &w.ctoken_mint, &TOKEN_PROGRAM),
        scope_prices: kl::SCOPE,
        obligation: OBLIGATION_47WN,
        lending_market: XSTOCKS_MARKET,
        lending_market_authority: kl::lma(),
        repay_reserve: RESERVE_USDC,
        usdc_mint: USDC_MINT,
        repay_reserve_liquidity_supply: usdc.supply_vault,
        withdraw_reserve: RESERVE_SPYX,
        xstock_mint: SPYX_MINT,
        withdraw_reserve_collateral_mint: w.spyx_res.collateral_mint,
        withdraw_reserve_collateral_supply: w.spyx_res.collateral_supply_vault,
        withdraw_reserve_liquidity_supply: w.spyx_res.supply_vault,
        withdraw_reserve_liquidity_fee_receiver: w.spyx_res.fee_vault,
        token_program: TOKEN_PROGRAM,
        token_2022_program: TOKEN_2022_PROGRAM,
        instruction_sysvar: kl::INSTRUCTIONS_SYSVAR,
        collateral_farm_user_state: KLEND, // SPYx has no collateral farm
        collateral_farm_state: KLEND,
        debt_farm_user_state: kl::OB_FARM_USER_STATE,
        debt_farm_state: kl::USDC_DEBT_FARM,
        farms_program: kl::FARMS,
        klend_program: KLEND,
    }
    .to_account_metas(None);
    for m in metas.iter_mut() {
        if m.pubkey == kl::OB_FARM_USER_STATE || m.pubkey == kl::USDC_DEBT_FARM {
            m.is_writable = true;
        }
    }
    Instruction::new_with_bytes(credence_core::ID, &ix::BackstopLiquidate { repay_amount: repay, min_received: 0 }.data(), metas)
}

/// Refreshes + `backstop_liquidate` one slot later with Scope re-stamped (a fresh klend refresh).
fn liquidate(w: &mut World, repay: u64) -> TxResult {
    let k = w.keeper.insecure_clone();
    liquidate_by(w, &k, repay)
}
fn liquidate_by(w: &mut World, signer: &Keypair, repay: u64) -> TxResult {
    w.env.svm.warp_to_slot(w.env.slot() + 1);
    w.env.freshen_scope();
    let mut ixs = kl::refreshes();
    ixs.push(ix_liquidate(w, &signer.pubkey(), repay));
    w.env.send(&ixs, &[signer])
}

fn ix_mark(t: &str) -> Instruction {
    Instruction::new_with_bytes(
        credence_core::ID,
        &ix::MarkInventory {}.data(),
        acc::MarkInventory {
            pool: pool_pda(),
            asset: asset_pda(&ticker(t)),
            inventory: inventory_pda(t),
            vault: vault_pda(),
            xstock_mint: SPYX_MINT,
            scope_prices: kl::SCOPE,
        }
        .to_account_metas(None),
    )
}

fn ix_start(keeper: &Pubkey, lot: u64) -> Instruction {
    Instruction::new_with_bytes(
        credence_core::ID,
        &ix::StartSale { lot }.data(),
        acc::StartSale {
            keeper: *keeper,
            config: config_pda(),
            pool: pool_pda(),
            asset: asset_pda(&ticker("SPYx")),
            inventory: inventory_pda("SPYx"),
            scope_prices: kl::SCOPE,
        }
        .to_account_metas(None),
    )
}

fn ix_buy(buyer: &Pubkey, buyer_usdc: Pubkey, buyer_tokens: Pubkey, qty: u64, max: u128) -> Instruction {
    let vault = vault_pda();
    Instruction::new_with_bytes(
        credence_core::ID,
        &ix::BuyFromSale { qty, max_price_wad: max }.data(),
        acc::BuyFromSale {
            buyer: *buyer,
            config: config_pda(),
            pool: pool_pda(),
            inventory: inventory_pda("SPYx"),
            asset: asset_pda(&ticker("SPYx")),
            scope_prices: kl::SCOPE,
            vault,
            vault_usdc: vault_usdc_pda(),
            inv_tokens: ata(&vault, &SPYX_MINT, &TOKEN_2022_PROGRAM),
            xstock_mint: SPYX_MINT,
            buyer_usdc,
            buyer_tokens,
            token_program: TOKEN_PROGRAM,
            token_2022_program: TOKEN_2022_PROGRAM,
        }
        .to_account_metas(None),
    )
}

fn ix_close(caller: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        credence_core::ID,
        &ix::CloseSale {}.data(),
        acc::CloseSale { caller: *caller, config: config_pda(), inventory: inventory_pda("SPYx") }.to_account_metas(None),
    )
}

fn scope_price(env: &Env) -> u128 {
    credence_core::oracle::scope::decode(&env.data(&kl::SCOPE), SPY_CHAIN as u64).unwrap().price_wad
}

/// The money path: an unhealthy obligation is liquidated by the vault PDA; the vault pays USDC from cash, receives the
/// redeemed SPYx, books it at cost; equity is unchanged; NAV marks it at Scope − 10%.
#[test]
fn backstop_liquidates_through_the_vault_pda() {
    let mut w = world(140);
    w.env.send(&kl::refreshes(), &[&w.keeper]).unwrap();
    let debt0 = kl::debt_sf(&w.env) >> 60;
    let v0: Vault = w.env.anchor(&vault_pda());
    let cash0 = w.env.token_balance(&vault_usdc_pda());
    let m = liquidate(&mut w, 50_000_000_000).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    println!("refreshes + backstop_liquidate: {} CU (transaction)", m.compute_units_consumed);
    assert!(m.compute_units_consumed < 1_400_000);

    let debt1 = kl::debt_sf(&w.env) >> 60;
    let spent = cash0 - w.env.token_balance(&vault_usdc_pda());
    let inv: Inventory = w.env.anchor(&inventory_pda("SPYx"));
    let held = w.env.token_balance(&inv.tokens);
    println!("debt {debt0} → {debt1}; vault paid {spent}, received {held} raw SPYx");
    assert!(spent > 0 && spent <= 50_000_000_000);
    assert!(((debt0 - debt1) as u64).abs_diff(spent) <= 1, "the debt fell by what the vault paid");
    assert_eq!((inv.qty, inv.cost), (held, spent), "only measured units, at cost");
    assert_eq!(w.env.token_balance(&inv.ctokens), 0, "every cToken redeemed");
    // INV-8 at the committed price, and a liquidation bonus was earned (value at Scope above cost).
    let p = scope_price(&w.env);
    assert!(held <= paid_for_qty(spent, p, params().max_discount_wad, SCALE).unwrap(), "INV-8");
    let value = lot_cost(held, p, SCALE).unwrap();
    println!("value at Scope {value} for {spent} paid: bonus {:.2}%", (value as f64 / spent as f64 - 1.0) * 100.0);
    assert!(value > spent, "the vault bought at a discount");

    let v: Vault = w.env.anchor(&vault_pda());
    assert_eq!(v.equity, v0.equity, "a purchase turns cash into inventory at cost");
    assert_eq!(v.inventory_cost().unwrap(), spent);
    let mark = inventory_mark(held, p, params().haircut_wad, SCALE).unwrap();
    assert_eq!(v.inv[0].mark, mark);
    assert_eq!(v.nav(w.env.now()).unwrap(), v.equity - spent + mark, "NAV = equity − cost + mark");
    let pool: BackstopPool = w.env.anchor(&pool_pda());
    assert_eq!((pool.spent, pool.liquidations), (spent, 1));
}

/// INV-8 (EVM Credence bug 2, attack first): with a committed price at Scope itself (κ = 0), klend's liquidation bonus
/// would hand the vault more units than its payment buys there: the program refuses the whole liquidation.
#[test]
fn inv8_refuses_collateral_it_did_not_pay_for() {
    let mut w = world(140);
    let a = w.env.admin.pubkey();
    let ix = Instruction::new_with_bytes(
        credence_core::ID,
        &ix::SetBackstopParams { params: BackstopParams { max_discount_wad: 0, ..params() } }.data(),
        acc::SetBackstopParams { admin: a, config: config_pda(), pool: pool_pda() }.to_account_metas(None),
    );
    w.env.send_admin(&[ix]).unwrap();
    assert_err(liquidate(&mut w, 50_000_000_000), code(CoreError::Inv8));
    let inv: Inventory = w.env.anchor(&inventory_pda("SPYx"));
    assert_eq!((inv.qty, inv.cost), (0, 0), "nothing booked");
}

/// INV-13 (attack first): the backstop never spends the cash kept for live cover groups and queues, nor more than its
/// share of equity. A vault whose cash is mostly reserved for a live group refuses; so does a liquidation above the
/// pool's 25% share.
#[test]
fn inv13_backstop_never_spends_reserved_cash() {
    let mut w = world(140);
    // A live group reserved 1.96M of the vault's 2M cash: at most 40k is free.
    let mut v: Vault = w.env.anchor(&vault_pda());
    v.reserved_total = 1_960_000_000_000;
    put_vault(&mut w.env, &v);
    assert_err(liquidate(&mut w, 50_000_000_000), code(CoreError::BackstopBudget));
    liquidate(&mut w, 39_000_000_000).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    let cash = w.env.token_balance(&vault_usdc_pda());
    let v: Vault = w.env.anchor(&vault_pda());
    assert!(cash >= v.reserved_cash().unwrap(), "INV-13: cash {cash} ≥ reserved {}", v.reserved_cash().unwrap());

    // The pool's share: 25% of 2M equity = 500k at cost.
    let mut w = world(400);
    assert_err(liquidate(&mut w, 600_000_000_000), code(CoreError::BackstopBudget));
}

/// Inventory never backs cover: capacity for new policies is sized on equity less the inventory's cost.
#[test]
fn inv13_inventory_does_not_back_cover() {
    let mut w = world(140);
    liquidate(&mut w, 50_000_000_000).unwrap();
    let v: Vault = w.env.anchor(&vault_pda());
    assert_eq!(v.cover_equity().unwrap(), v.equity - v.inventory_cost().unwrap());
    assert!(v.cover_equity().unwrap() < v.equity);
}

#[test]
fn backstop_liquidate_refuses_what_it_must() {
    let mut w = world(140);
    // Not the keeper.
    let stranger = w.env.funded();
    assert_err(liquidate_by(&mut w, &stranger, 1_000_000_000), code(CoreError::Unauthorized));
    // Paused.
    let a = w.env.admin.pubkey();
    let ix = w.env.ix_set_paused(&a, true);
    w.env.send_admin(&[ix]).unwrap();
    assert_err(liquidate(&mut w, 1_000_000_000), code(CoreError::Paused));
    let ix = w.env.ix_set_paused(&a, false);
    w.env.send_admin(&[ix]).unwrap();
    // Wrong withdraw reserve (the QQQx reserve for an SPYx inventory).
    w.env.svm.warp_to_slot(w.env.slot() + 1);
    w.env.freshen_scope();
    let mut ixs = kl::refreshes();
    let mut x = ix_liquidate(&w, &a, 1_000_000_000);
    x.accounts[16].pubkey = RESERVE_QQQX;
    ixs.push(x);
    assert_err(w.env.send(&ixs, &[&w.keeper.insecure_clone()]), code(CoreError::InvalidParam));
    // The issuer paused the mint.
    let mut m = w.env.svm.get_account(&SPYX_MINT).unwrap();
    let off = find_ext(&m.data, 26).unwrap();
    m.data[off + 32] = 1;
    w.env.svm.set_account(SPYX_MINT, m.clone()).unwrap();
    assert_err(liquidate(&mut w, 1_000_000_000), code(CoreError::MintPaused));
    m.data[off + 32] = 0;
    // A transfer hook was enabled.
    let off = find_ext(&m.data, 14).unwrap();
    m.data[off + 32..off + 64].copy_from_slice(Pubkey::new_unique().as_ref());
    w.env.svm.set_account(SPYX_MINT, m).unwrap();
    assert_err(liquidate(&mut w, 1_000_000_000), code(CoreError::TransferHookEnabled));
}

/// A healthy obligation: klend refuses (it decides who is liquidatable), and the vault spends nothing.
#[test]
fn healthy_obligation_is_not_liquidated() {
    let mut w = world(100); // D/C′ 0.755
    let cash0 = w.env.token_balance(&vault_usdc_pda());
    assert!(liquidate(&mut w, 10_000_000_000).is_err());
    assert_eq!(w.env.token_balance(&vault_usdc_pda()), cash0);
}

/// The Dutch auction: price decays linearly from Scope + 2% to Scope − 5% over 2 h and stays at the floor; partial
/// fills; P&L realised into equity at each fill; close returns the unsold part to inventory; a re-sale sells it.
#[test]
fn dutch_auction_decay_partial_fill_close_and_resale() {
    let mut w = world(140);
    liquidate(&mut w, 50_000_000_000).unwrap();
    let k = w.keeper.insecure_clone();
    let inv: Inventory = w.env.anchor(&inventory_pda("SPYx"));
    let (held, cost) = (inv.qty, inv.cost);
    w.env.freshen_scope();
    let t0 = w.env.now();
    w.env.send(&[ix_start(&k.pubkey(), held)], &[&k]).unwrap();
    let inv: Inventory = w.env.anchor(&inventory_pda("SPYx"));
    let p = scope_price(&w.env);
    assert_eq!(inv.start_price_wad, (p * 102).div_ceil(100));
    assert_eq!(inv.floor_price_wad, (p * 95).div_ceil(100));
    // A second sale while one runs is refused.
    assert_err(w.env.send(&[ix_start(&k.pubkey(), 1)], &[&k]), code(CoreError::SaleState));

    let buyer = w.env.funded();
    let busdc = w.env.usdc_account(&buyer.pubkey(), 100_000_000_000);
    w.env.send(&[create_ata(&buyer.pubkey(), &buyer.pubkey(), &SPYX_MINT, &TOKEN_2022_PROGRAM)], &[&buyer]).unwrap();
    let btok = ata(&buyer.pubkey(), &SPYX_MINT, &TOKEN_2022_PROGRAM);

    // t0 + 1 h: the midpoint. A max price below it is refused; a third of the lot fills at it.
    w.env.set_time(t0 + 3_600);
    w.env.freshen_scope(); // buys read today's Scope (A-38)
    let mid = dutch_price(inv.start_price_wad, inv.floor_price_wad, t0, 7_200, t0 + 3_600).unwrap();
    assert_err(w.env.send(&[ix_buy(&buyer.pubkey(), busdc, btok, held / 3, mid - 1)], &[&buyer]), code(CoreError::PriceAboveMax));
    let v0: Vault = w.env.anchor(&vault_pda());
    let cash0 = w.env.token_balance(&vault_usdc_pda());
    let m = w.env.send(&[ix_buy(&buyer.pubkey(), busdc, btok, held / 3, mid)], &[&buyer]).unwrap();
    println!("buy_from_sale: {} CU", m.compute_units_consumed);
    let paid = lot_cost(held / 3, mid, SCALE).unwrap();
    let basis = cost_portion(cost, held, held / 3).unwrap();
    assert_eq!(w.env.token_balance(&vault_usdc_pda()) - cash0, paid);
    assert_eq!(w.env.token_balance(&btok), held / 3);
    let v: Vault = w.env.anchor(&vault_pda());
    assert_eq!(v.equity as i128 - v0.equity as i128, paid as i128 - basis as i128, "realised P&L = proceeds − basis");
    let inv: Inventory = w.env.anchor(&inventory_pda("SPYx"));
    assert_eq!((inv.qty, inv.cost, inv.lot_left, inv.sale_active), (held - held / 3, cost - basis, held - held / 3, 1));

    // After the decay: the floor, and it stays there.
    w.env.set_time(t0 + 9_000);
    w.env.freshen_scope();
    let floor = inv.floor_price_wad;
    assert_eq!(dutch_price(inv.start_price_wad, floor, t0, 7_200, t0 + 9_000).unwrap(), floor);
    // Close (anyone after the decay): the unsold units stay in inventory; a buy after close is refused.
    let anyone = w.env.funded();
    w.env.send(&[ix_close(&anyone.pubkey())], &[&anyone]).unwrap();
    assert_err(w.env.send(&[ix_buy(&buyer.pubkey(), busdc, btok, 1, u128::MAX)], &[&buyer]), code(CoreError::SaleState));
    let inv: Inventory = w.env.anchor(&inventory_pda("SPYx"));
    assert_eq!((inv.qty, inv.sale_active, inv.lot_left), (held - held / 3, 0, 0));

    // Re-sale of the rest, bought in full at the start price: the inventory and its vault slot are emptied.
    w.env.freshen_scope();
    let rest = inv.qty;
    w.env.send(&[ix_start(&k.pubkey(), rest)], &[&k]).unwrap();
    let inv: Inventory = w.env.anchor(&inventory_pda("SPYx"));
    w.env.send(&[ix_buy(&buyer.pubkey(), busdc, btok, rest, inv.start_price_wad)], &[&buyer]).unwrap();
    let inv: Inventory = w.env.anchor(&inventory_pda("SPYx"));
    assert_eq!((inv.qty, inv.cost, inv.sale_active), (0, 0, 0));
    let v: Vault = w.env.anchor(&vault_pda());
    assert_eq!(v.inventory_cost().unwrap(), 0);
    assert_eq!(v.inv[0], InvSlot::default(), "the slot is freed");
    let pool: BackstopPool = w.env.anchor(&pool_pda());
    assert_eq!(pool.fills, 2);
    println!("realised P&L {} USDC on {} spent", pool.realized_pnl as f64 / 1e6, pool.spent as f64 / 1e6);
    assert!(pool.realized_pnl > 0, "liquidation bonus + sale above cost");
    assert_eq!(v.equity as i128, LP as i128 + pool.realized_pnl as i128);
}

#[test]
fn sale_refuses_what_it_must() {
    let mut w = world(140);
    liquidate(&mut w, 20_000_000_000).unwrap();
    let k = w.keeper.insecure_clone();
    let held = w.env.anchor::<Inventory>(&inventory_pda("SPYx")).qty;
    // Not the keeper; more than held; nothing on sale to buy or close.
    let s = w.env.funded();
    assert_err(w.env.send(&[ix_start(&s.pubkey(), 1)], &[&s]), code(CoreError::Unauthorized));
    assert_err(w.env.send(&[ix_start(&k.pubkey(), held + 1)], &[&k]), code(CoreError::InvalidParam));
    assert_err(w.env.send(&[ix_close(&k.pubkey())], &[&k]), code(CoreError::SaleState));
    // A stranger may not close a running sale before the decay ends.
    w.env.freshen_scope();
    w.env.send(&[ix_start(&k.pubkey(), held)], &[&k]).unwrap();
    assert_err(w.env.send(&[ix_close(&s.pubkey())], &[&s]), code(CoreError::Unauthorized));
    // A paused issuer mint stops buying.
    let buyer = w.env.funded();
    let busdc = w.env.usdc_account(&buyer.pubkey(), 100_000_000_000);
    w.env.send(&[create_ata(&buyer.pubkey(), &buyer.pubkey(), &SPYX_MINT, &TOKEN_2022_PROGRAM)], &[&buyer]).unwrap();
    let btok = ata(&buyer.pubkey(), &SPYX_MINT, &TOKEN_2022_PROGRAM);
    let mut m = w.env.svm.get_account(&SPYX_MINT).unwrap();
    let off = find_ext(&m.data, 26).unwrap();
    m.data[off + 32] = 1;
    w.env.svm.set_account(SPYX_MINT, m).unwrap();
    assert_err(w.env.send(&[ix_buy(&buyer.pubkey(), busdc, btok, 1, u128::MAX)], &[&buyer]), code(CoreError::MintPaused));
    // The keeper may close any time.
    w.env.send(&[ix_close(&k.pubkey())], &[&k]).unwrap();
}

/// NAV with inventory: share prices wait for a fresh mark (deposits and withdrawals refuse a stale one), the mark
/// follows Scope, and a withdrawal at NAV keeps INV-13's cash.
#[test]
fn nav_marks_inventory_and_refuses_stale_marks() {
    let mut w = world(140);
    liquidate(&mut w, 50_000_000_000).unwrap();
    let (lp, u, sh) = w.env.lp(1_000_000_000);
    w.env.set_time(w.env.now() + MARK_MAX_AGE_SECS + 1);
    let ix = w.env.ix_deposit(&lp.pubkey(), u, sh, 1_000_000_000);
    assert_err(w.env.send(&[ix.clone()], &[&lp]), code(CoreError::StaleInventoryMark));
    // Scope −10%: the mark follows it.
    let p0 = scope_price(&w.env) as f64 / 1e18;
    w.env.freshen_scope();
    w.env.put_scope(SPY_CHAIN, p0 * 0.9, w.env.now());
    let anyone = w.env.funded();
    w.env.send(&[ix_mark("SPYx")], &[&anyone]).unwrap();
    let inv: Inventory = w.env.anchor(&inventory_pda("SPYx"));
    let v: Vault = w.env.anchor(&vault_pda());
    let p = scope_price(&w.env);
    assert_eq!(v.inv[0].mark, inventory_mark(inv.qty, p, params().haircut_wad, SCALE).unwrap());
    let nav = v.nav(w.env.now()).unwrap();
    assert!(nav < v.equity, "a mark below cost lowers NAV: {nav} < {}", v.equity);
    // A deposit now prices at the deposit NAV: inventory at its full Scope value (A-36), still below cost here.
    let dnav = v.nav_for_deposit(w.env.now()).unwrap();
    assert!(dnav > nav && dnav < v.equity);
    let supply = w.env.mint_supply(&v.share_mint);
    w.env.send(&[ix], &[&lp]).unwrap();
    let minted = w.env.mint_supply(&v.share_mint) - supply;
    assert_eq!(minted as u128, 1_000_000_000u128 * supply as u128 / dnav as u128);
}

/// The mark refuses a stale Scope price; init_inventory refuses a reserve that is not the asset's.
#[test]
fn mark_and_init_refuse_what_they_must() {
    let mut w = world(140);
    liquidate(&mut w, 10_000_000_000).unwrap();
    w.env.set_time(w.env.now() + 3_600);
    let anyone = w.env.funded();
    assert_err(w.env.send(&[ix_mark("SPYx")], &[&anyone]), code(CoreError::StalePrice));
    let a = w.env.admin.pubkey();
    // A QQQx inventory pointed at the SPYx reserve.
    let vault = vault_pda();
    w.env.send_admin(&[create_ata(&a, &vault, &QQQX_MINT, &TOKEN_2022_PROGRAM)]).unwrap();
    let mut ix = ix_init_inventory(&w.env, &a, "QQQx", RESERVE_SPYX, w.ctoken_mint);
    ix.accounts[6].pubkey = ata(&vault, &QQQX_MINT, &TOKEN_2022_PROGRAM);
    assert_err(w.env.send_admin(&[ix]), code(CoreError::InvalidParam));
}

/// Offset of extension `ty`'s value in a Token-2022 mint.
fn find_ext(d: &[u8], ty: u16) -> Option<usize> {
    let mut o = 166;
    while o + 4 <= d.len() {
        let t = u16::from_le_bytes([d[o], d[o + 1]]);
        let l = u16::from_le_bytes([d[o + 2], d[o + 3]]) as usize;
        if t == ty {
            return Some(o + 4);
        }
        o += 4 + l;
    }
    None
}

fn put_vault(env: &mut Env, v: &Vault) {
    use anchor_lang::{AnchorSerialize, Discriminator};
    let key = vault_pda();
    let old = env.svm.get_account(&key).unwrap();
    let mut data = Vault::DISCRIMINATOR.to_vec();
    v.serialize(&mut data).unwrap();
    data.resize(old.data.len(), 0);
    env.svm.set_account(key, Account { data, ..old }).unwrap();
}

/// Admin instructions: only the admin, and bounded parameters.
#[test]
fn backstop_params_are_admin_only_and_bounded() {
    let mut w = world(140);
    let a = w.env.admin.pubkey();
    let set = |admin: Pubkey, p: BackstopParams| {
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::SetBackstopParams { params: p }.data(),
            acc::SetBackstopParams { admin, config: config_pda(), pool: pool_pda() }.to_account_metas(None),
        )
    };
    let s = w.env.funded();
    assert_err(w.env.send(&[set(s.pubkey(), params())], &[&s]), code(CoreError::Unauthorized));
    for bad in [
        BackstopParams { max_share_wad: W / 2 + 1, ..params() },
        BackstopParams { haircut_wad: W / 2, ..params() },
        BackstopParams { max_discount_wad: W / 2, ..params() },
        BackstopParams { sale_premium_wad: W / 5 + 1, ..params() },
        BackstopParams { sale_discount_wad: W / 2, ..params() },
        BackstopParams { sale_secs: 59, ..params() },
        BackstopParams { max_price_age_secs: 0, ..params() },
    ] {
        assert_err(w.env.send_admin(&[set(a, bad)]), code(CoreError::InvalidParam));
    }
    w.env.send_admin(&[set(a, BackstopParams { haircut_wad: W / 20, ..params() })]).unwrap();
    assert_eq!(w.env.anchor::<BackstopPool>(&pool_pda()).haircut_wad, W / 20);
    // init_inventory twice fails (the PDA exists).
    let ix = ix_init_inventory(&w.env, &a, "SPYx", RESERVE_SPYX, w.ctoken_mint);
    assert!(w.env.send_admin(&[ix]).is_err());
}

/// Audit A-35: an inventory was tied to the cToken ATA of the one reserve given at `init_inventory`, so an obligation
/// in the other xStocks market (another reserve, another cToken mint) could never be liquidated. The cToken account is
/// now the vault PDA's ATA for the withdraw reserve's own cToken mint. Simulated here by an inventory recorded with
/// another market's cToken account.
#[test]
fn a35_ctoken_account_follows_the_withdraw_reserve() {
    use anchor_lang::AccountSerialize;
    let mut w = world(140);
    let key = inventory_pda("SPYx");
    let mut inv: Inventory = w.env.anchor(&key);
    inv.ctokens = Pubkey::new_unique(); // as if initialised from the Sentora market's reserve
    let old = w.env.svm.get_account(&key).unwrap();
    let mut data = vec![];
    inv.try_serialize(&mut data).unwrap();
    data.resize(old.data.len(), 0);
    w.env.svm.set_account(key, Account { data, ..old }).unwrap();
    liquidate(&mut w, 10_000_000_000).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
    // And a cToken account that is not the vault's ATA for the reserve's cToken mint is refused.
    let mut ixs = kl::refreshes();
    let mut x = ix_liquidate(&w, &w.keeper.pubkey(), 1_000_000_000);
    let wrong = w.env.usdc_account(&vault_pda(), 0);
    x.accounts[8].pubkey = wrong;
    ixs.push(x);
    w.env.svm.warp_to_slot(w.env.slot() + 1);
    w.env.freshen_scope();
    assert!(w.env.send(&ixs, &[&w.keeper.insecure_clone()]).is_err());
}

/// Audit A-36: the haircut mark protects the vault when shares are redeemed, but a deposit priced at it buys shares
/// below fair value and takes part of the inventory's value from existing LPs. Deposits price inventory at Scope
/// (no haircut, rounded up); withdrawals keep the haircut.
#[test]
fn a36_deposits_price_inventory_without_the_haircut() {
    let mut w = world(140);
    liquidate(&mut w, 50_000_000_000).unwrap();
    let inv: Inventory = w.env.anchor(&inventory_pda("SPYx"));
    let v: Vault = w.env.anchor(&vault_pda());
    let full = lot_cost(inv.qty, scope_price(&w.env), SCALE).unwrap();
    let fair_nav = v.equity - inv.cost + full;
    let (lp, u, sh) = w.env.lp(10_000_000_000);
    let supply = w.env.mint_supply(&v.share_mint);
    let ix = w.env.ix_deposit(&lp.pubkey(), u, sh, 10_000_000_000);
    w.env.send(&[ix], &[&lp]).unwrap();
    let minted = w.env.mint_supply(&v.share_mint) - supply;
    assert_eq!(minted as u128, 10_000_000_000u128 * supply as u128 / fair_nav as u128, "priced at the haircut mark instead of Scope");
}

/// Audit A-38: the auction's start and floor were fixed off Scope at `start_sale` and a sale can sit at its floor for
/// days, so after a rally a buyer took the lot far below the market. A buy now pays at least Scope now × (1 − d_max).
#[test]
fn a38_auction_floor_follows_the_current_price() {
    let mut w = world(140);
    liquidate(&mut w, 20_000_000_000).unwrap();
    let k = w.keeper.insecure_clone();
    let held = w.env.anchor::<Inventory>(&inventory_pda("SPYx")).qty;
    w.env.freshen_scope();
    let t0 = w.env.now();
    w.env.send(&[ix_start(&k.pubkey(), held)], &[&k]).unwrap();
    let floor = w.env.anchor::<Inventory>(&inventory_pda("SPYx")).floor_price_wad;
    // Two days later the decay is long over and SPYx is up 10%.
    w.env.set_time(t0 + 2 * 86_400);
    w.env.svm.warp_to_slot(w.env.slot() + 10);
    let p0 = scope_price(&w.env) as f64 / 1e18;
    w.env.freshen_scope();
    w.env.put_scope(SPY_CHAIN, p0 * 1.10, w.env.now());
    let buyer = w.env.funded();
    let busdc = w.env.usdc_account(&buyer.pubkey(), 100_000_000_000);
    w.env.send(&[create_ata(&buyer.pubkey(), &buyer.pubkey(), &SPYX_MINT, &TOKEN_2022_PROGRAM)], &[&buyer]).unwrap();
    let btok = ata(&buyer.pubkey(), &SPYX_MINT, &TOKEN_2022_PROGRAM);
    assert_err(w.env.send(&[ix_buy(&buyer.pubkey(), busdc, btok, held, floor)], &[&buyer]), code(CoreError::PriceAboveMax));
    let now_floor = (scope_price(&w.env) * 95).div_ceil(100);
    w.env.send(&[ix_buy(&buyer.pubkey(), busdc, btok, held, now_floor)], &[&buyer]).unwrap_or_else(|e| panic!("{:?}\n{:#?}", e.err, e.meta.logs));
}

/// Audit A-39: `mark_inventory` is permissionless and claimed a `Vault.inv` slot even for an empty inventory, so anyone
/// could fill the four slots and block every other xStock's liquidation (`TooManyInventories`). An empty inventory now
/// claims nothing and frees its slot.
#[test]
fn a39_marking_an_empty_inventory_claims_no_slot() {
    let mut w = world(140);
    let anyone = w.env.funded();
    w.env.freshen_scope();
    w.env.send(&[ix_mark("SPYx")], &[&anyone]).unwrap();
    let v: Vault = w.env.anchor(&vault_pda());
    assert!(v.inv.iter().all(|s| *s == InvSlot::default()), "an empty inventory took a slot");
}
