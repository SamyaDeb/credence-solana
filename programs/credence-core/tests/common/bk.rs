//! Curator book cover (C2) builders: PDAs and one builder per book instruction, on the real-klend snapshot
//! (`kl`): legs on `47wNsqpy…` and on clones of it (same reserves, fresh addresses, any owner and debt).
use super::*;
use anchor_lang::solana_program::instruction::AccountMeta;

pub fn book_pda(payer: &Pubkey, closure_id: u32, book_id: u32) -> Pubkey {
    pda(&[SEED_BOOK, payer.as_ref(), &closure_id.to_le_bytes(), &book_id.to_le_bytes()])
}

pub fn escrow_pda(book: &Pubkey) -> Pubkey {
    pda(&[SEED_BOOK_ESCROW, book.as_ref()])
}

impl Env {
    /// A clone of the loaded snapshot obligation at a fresh address, owned by `owner`, its debt scaled by `num / 100`.
    pub fn clone_obligation(&mut self, owner: &Pubkey, num: u128) -> Pubkey {
        // The snapshot obligation as fetched (not as a test may have scaled it), refreshed state from the loaded one.
        let mut d = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/klend/obligation.bin")).unwrap();
        ob::put(&mut d, ob::OB_OWNER, owner.as_ref());
        ob::scale_debt(&mut d, num, 100);
        let key = Pubkey::new_unique();
        self.put_klend(key, d);
        key
    }

    /// Sets an obligation's USDC borrow to zero (as if repaid): it no longer borrows from the reserve.
    pub fn zero_borrow(&mut self, obligation: &Pubkey) {
        let mut d = self.data(obligation);
        ob::put(&mut d, ob::OB_BORROWS + ob::BOR_BORROWED_AMOUNT_SF, &0u128.to_le_bytes());
        self.put_klend(*obligation, d);
    }

    /// Refresh instructions for several SPYx/USDC obligations (each reserve once).
    pub fn refreshes_for(obligations: &[Pubkey]) -> Vec<Instruction> {
        let mut v = vec![kl::refresh_reserve(RESERVE_SPYX), kl::refresh_reserve(RESERVE_USDC)];
        v.extend(obligations.iter().map(|o| kl::refresh_obligation(*o, &[RESERVE_SPYX, RESERVE_USDC])));
        v
    }

    pub fn ix_open_book(&self, payer: &Pubkey, payer_usdc: Pubkey, closure_id: u32, book_id: u32) -> Instruction {
        let book = book_pda(payer, closure_id, book_id);
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::OpenBook { closure_id, book_id }.data(),
            acc::OpenBook {
                payer: *payer,
                config: config_pda(),
                epoch: epoch_pda(&ticker("SPYx"), closure_id),
                book,
                escrow: escrow_pda(&book),
                usdc_mint: USDC_MINT,
                vault: vault_pda(),
                payer_usdc,
                token_program: TOKEN_PROGRAM,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    /// `add_book_leg` for a SPYx/USDC obligation (the snapshot's reserves).
    pub fn ix_add_book_leg(&self, payer: &Pubkey, payer_usdc: Pubkey, book: Pubkey, obligation: Pubkey, closure_id: u32) -> Instruction {
        let t = ticker("SPYx");
        let epoch = epoch_pda(&t, closure_id);
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::AddBookLeg { ticker: t, closure_id }.data(),
            acc::AddBookLeg {
                payer: *payer,
                config: config_pda(),
                asset: asset_pda(&t),
                scenarios: scen_pda(&t, closure::WEEKEND),
                epoch,
                loss: loss_pda(closure_id),
                vault: vault_pda(),
                vault_usdc: vault_usdc_pda(),
                share_mint: shares_pda(),
                book,
                escrow: escrow_pda(&book),
                payer_usdc,
                obligation,
                deposit_reserve: RESERVE_SPYX,
                borrow_reserve: RESERVE_USDC,
                policy: policy_pda(&epoch, &obligation),
                token_program: TOKEN_PROGRAM,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_seal_book(&self, payer: &Pubkey, payer_usdc: Pubkey, book: Pubkey, max_premium: u64) -> Instruction {
        let b: Book = self.zc(&book);
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::SealBook { max_premium }.data(),
            acc::SealBook {
                payer: *payer,
                config: config_pda(),
                book,
                escrow: escrow_pda(&book),
                payer_usdc,
                loss: loss_pda(b.closure_id),
                vault: vault_pda(),
                vault_usdc: vault_usdc_pda(),
                share_mint: shares_pda(),
                fee_account: self.anchor::<Vault>(&vault_pda()).fee_account,
                token_program: TOKEN_PROGRAM,
            }
            .to_account_metas(None),
        )
    }

    /// `release_book_leg` by `owner` (Kamino: no NFT account).
    pub fn ix_release_book_leg(&self, owner: &Pubkey, policy: Pubkey) -> Instruction {
        let p: Policy = self.anchor(&policy);
        let e: Epoch = self.anchor(&p.epoch);
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::ReleaseBookLeg {}.data(),
            acc::ReleaseBookLeg {
                owner: *owner,
                config: config_pda(),
                epoch: p.epoch,
                policy,
                loss: loss_pda(e.closure_id),
                vault: vault_pda(),
                book: p.book,
                asset: asset_pda(&p.ticker),
                position: p.obligation,
                position_token_account: None,
                rent_payer: p.rent_payer,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_void_book_leg(&self, caller: &Pubkey, policy: Pubkey) -> Instruction {
        let p: Policy = self.anchor(&policy);
        let e: Epoch = self.anchor(&p.epoch);
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::VoidBookLeg {}.data(),
            acc::VoidBookLeg {
                caller: *caller,
                config: config_pda(),
                epoch: p.epoch,
                policy,
                loss: loss_pda(e.closure_id),
                vault: vault_pda(),
                book: p.book,
                asset: asset_pda(&p.ticker),
                rent_payer: p.rent_payer,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_claim_book_refund(&self, caller: &Pubkey, book: Pubkey, with_escrow: bool) -> Instruction {
        let b: Book = self.zc(&book);
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::ClaimBookRefund {}.data(),
            acc::ClaimBookRefund {
                caller: *caller,
                book,
                escrow: with_escrow.then_some(b.escrow),
                payer: b.payer,
                payer_usdc: b.payer_usdc,
                vault: vault_pda(),
                vault_usdc: vault_usdc_pda(),
                token_program: TOKEN_PROGRAM,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_close_book(&self, caller: &Pubkey, book: Pubkey) -> Instruction {
        let b: Book = self.zc(&book);
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::CloseBook {}.data(),
            acc::CloseBook { caller: *caller, book, payer: b.payer }.to_account_metas(None),
        )
    }

    /// `settle_book_leg` with the snapshot obligation's repay accounts (`with_kamino`).
    pub fn ix_settle_book_leg(&self, caller: &Pubkey, policy: Pubkey, with_kamino: bool) -> Instruction {
        let p: Policy = self.anchor(&policy);
        let k = |x: Pubkey| if with_kamino { Some(x) } else { None };
        let mut ix = Instruction::new_with_bytes(
            credence_core::ID,
            &ix::SettleBookLeg {}.data(),
            acc::SettleBookLeg {
                caller: *caller,
                config: config_pda(),
                epoch: p.epoch,
                policy,
                loss: loss_pda(self.anchor::<Epoch>(&p.epoch).closure_id),
                vault: vault_pda(),
                vault_usdc: vault_usdc_pda(),
                usdc_mint: USDC_MINT,
                token_program: TOKEN_PROGRAM,
                obligation: p.obligation,
                book: p.book,
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
        );
        for m in ix.accounts.iter_mut() {
            if with_kamino && (m.pubkey == kl::OB_FARM_USER_STATE || m.pubkey == kl::USDC_DEBT_FARM) {
                m.is_writable = true;
            }
        }
        ix
    }

    /// `shield_book_leg`: `shield_advance`'s accounts plus the book.
    pub fn ix_shield_book_leg(&self, keeper: &Pubkey, policy: Pubkey, price_update: Pubkey) -> Instruction {
        let mut ix = self.ix_shield(keeper, policy, price_update);
        let p: Policy = self.anchor(&policy);
        ix.data = ix::ShieldBookLeg {}.data();
        ix.accounts.push(AccountMeta::new(p.book, false));
        ix
    }

    pub fn ix_close_out_book_leg(&self, caller: &Pubkey, policy: Pubkey) -> Instruction {
        let p: Policy = self.anchor(&policy);
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::CloseOutBookLeg {}.data(),
            acc::CloseOutBookLeg {
                caller: *caller,
                config: config_pda(),
                epoch: p.epoch,
                policy,
                loss: loss_pda(self.anchor::<Epoch>(&p.epoch).closure_id),
                vault: vault_pda(),
                book: p.book,
            }
            .to_account_metas(None),
        )
    }

    pub fn ix_close_book_leg(&self, caller: &Pubkey, policy: Pubkey) -> Instruction {
        let p: Policy = self.anchor(&policy);
        Instruction::new_with_bytes(
            credence_core::ID,
            &ix::CloseBookLeg {}.data(),
            acc::CloseBookLeg {
                caller: *caller,
                epoch: p.epoch,
                policy,
                loss: loss_pda(self.anchor::<Epoch>(&p.epoch).closure_id),
                rent_payer: p.rent_payer,
            }
            .to_account_metas(None),
        )
    }

    /// `add_book_leg_multi` on a Sentora obligation (PYUSD debt) with the given legs (tickers in leg order).
    pub fn ix_add_book_leg_multi(&self, payer: &Pubkey, payer_usdc: Pubkey, book: Pubkey, obligation: Pubkey, legs: &[&str], closure_id: u32) -> Instruction {
        let t0 = ticker(legs[0]);
        let epoch = epoch_pda(&t0, closure_id);
        let mut metas = acc::AddBookLegMulti {
            payer: *payer,
            config: config_pda(),
            epoch,
            loss: loss_pda(closure_id),
            vault: vault_pda(),
            vault_usdc: vault_usdc_pda(),
            share_mint: shares_pda(),
            book,
            escrow: escrow_pda(&book),
            payer_usdc,
            obligation,
            borrow_reserve: sn::RESERVE_PYUSD,
            sleeve: Some(Env::sleeve_key()),
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
        Instruction::new_with_bytes(credence_core::ID, &ix::AddBookLegMulti { closure_id }.data(), metas)
    }

    /// `release_book_leg` for a multi-collateral leg: legs 1.. as [asset, epoch (writable)].
    pub fn ix_release_book_leg_multi(&self, owner: &Pubkey, policy: Pubkey) -> Instruction {
        let mut ix = self.ix_release_book_leg(owner, policy);
        let p: Policy = self.anchor(&policy);
        let e: Epoch = self.anchor(&p.epoch);
        for i in 1..p.n_legs as usize {
            let t = p.leg_ticker(i);
            ix.accounts.push(AccountMeta::new_readonly(asset_pda(&t), false));
            ix.accounts.push(AccountMeta::new(epoch_pda(&t, e.closure_id), false));
        }
        ix
    }

    /// `settle_book_leg` on a Sentora PYUSD leg: from the sleeve into the obligation; legs 1..'s epochs.
    pub fn ix_settle_book_leg_pyusd(&self, caller: &Pubkey, policy: Pubkey) -> Instruction {
        let p: Policy = self.anchor(&policy);
        let mut metas = acc::SettleBookLeg {
            caller: *caller,
            config: config_pda(),
            epoch: p.epoch,
            policy,
            loss: loss_pda(self.anchor::<Epoch>(&p.epoch).closure_id),
            vault: vault_pda(),
            vault_usdc: Env::sleeve_key(),
            usdc_mint: PYUSD_MINT,
            token_program: TOKEN_2022_PROGRAM,
            obligation: p.obligation,
            book: p.book,
            lending_market: Some(sn::MARKET),
            repay_reserve: Some(sn::RESERVE_PYUSD),
            reserve_destination_liquidity: Some(sn::PYUSD_SUPPLY),
            instruction_sysvar: Some(kl::INSTRUCTIONS_SYSVAR),
            obligation_farm_user_state: Some(KLEND),
            reserve_farm_state: Some(KLEND),
            lending_market_authority: Some(sn::lma()),
            farms_program: Some(kl::FARMS),
            klend_program: Some(KLEND),
        }
        .to_account_metas(None);
        metas.extend(self.leg_epochs(&p).into_iter().map(|e| AccountMeta::new_readonly(e, false)));
        Instruction::new_with_bytes(credence_core::ID, &ix::SettleBookLeg {}.data(), metas)
    }
}
