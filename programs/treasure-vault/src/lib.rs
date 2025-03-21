use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};
use anchor_spl::token::{self, Token, TokenAccount, Mint, SetAuthority};
use spl_token::instruction::AuthorityType;
use sha2::{Sha256, Digest};

declare_id!("G8RBzoNGqmAWvhLUTpJyVhzMWCtAXk3nrBoC7Q2MEeit");

#[program]
pub mod treasure_vault {
    use super::*;

    pub fn hide_vault(
        ctx: Context<HideVault>,
        password_hash: [u8; 32],
        mint: Pubkey,
        asset_type: u8,
        amount: u64,
    ) -> Result<()> {
        let vault_pda = &mut ctx.accounts.vault_pda;
        let fee_account = &mut ctx.accounts.fee_account;
        let owner = &ctx.accounts.owner;

        let (expected_pda, _bump) = Pubkey::find_program_address(&[b"vault", &password_hash], ctx.program_id);
        require!(expected_pda == vault_pda.key(), ErrorCode::InvalidVaultPda);

        let fee = 5_000_000; // 0.005 SOL
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: owner.to_account_info(),
                    to: fee_account.to_account_info(),
                },
            ),
            fee,
        )?;

        fee_account.total_fees += fee;

        if vault_pda.owner == Pubkey::default() {
            vault_pda.owner = *owner.key;
            vault_pda.password_hash = password_hash;
            vault_pda.is_claimed = false;
            vault_pda.claimer = Pubkey::default();
        }

        require!(vault_pda.password_hash == password_hash, ErrorCode::InvalidPassword);
        require!(!vault_pda.is_claimed, ErrorCode::AlreadyClaimed);

        let cpi_accounts = SetAuthority {
            account_or_mint: ctx.accounts.asset_account.to_account_info(),
            current_authority: owner.to_account_info(),
        };

        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::set_authority(cpi_ctx, AuthorityType::AccountOwner, Some(vault_pda.key()))?;

        vault_pda.assets.push(StoredAsset {
            mint,
            asset_account: ctx.accounts.asset_account.key(),
            asset_type,
            amount,
        });

        Ok(())
    }

    pub fn unlock_vault(ctx: Context<UnlockVault>, password: String) -> Result<()> {
        let vault_pda = &mut ctx.accounts.vault_pda;
        let fee_account = &mut ctx.accounts.fee_account;

        let computed_hash = Sha256::digest(password.as_bytes());
        let computed_hash_array: [u8; 32] = computed_hash.as_slice().try_into().unwrap();

        require!(vault_pda.password_hash == computed_hash_array, ErrorCode::InvalidPassword);
        require!(!vault_pda.is_claimed, ErrorCode::AlreadyClaimed);

        let fee = 7_000_000; // 0.007 SOL
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.claimer.to_account_info(),
                    to: fee_account.to_account_info(),
                },
            ),
            fee,
        )?;

        fee_account.total_fees += fee;
        vault_pda.claimer = *ctx.accounts.claimer.key;

        Ok(())
    }


    pub fn claim_treasure<'info>( ctx: Context<'_, '_, '_, 'info, ClaimTreasure<'info>>, bump: u8) -> Result<()> {
        let vault_pda: &Account<VaultPda> = &ctx.accounts.vault_pda;
        // remaining_accounts를 'info 라이프타임을 갖는 Vec로 수집
        let remaining_accounts: Vec<AccountInfo<'info>> = ctx.remaining_accounts.iter().cloned().collect();
        // token_program도 'info 라이프타임으로 명시
        let token_program: AccountInfo<'info> = ctx.accounts.token_program.to_account_info().clone();

        let expected_pda = Pubkey::create_program_address(
            &[b"vault", &vault_pda.password_hash, &[bump]],
            ctx.program_id,
        )
        .map_err(|_| error!(ErrorCode::InvalidVaultPda))?;

        require!(vault_pda.key() == expected_pda, ErrorCode::InvalidVaultPda);
        require!(!vault_pda.is_claimed, ErrorCode::AlreadyClaimed);
        require!(vault_pda.claimer == ctx.accounts.claimer.key(), ErrorCode::InvalidClaimer);

        let signer_seeds: &[&[u8]] = &[b"vault", &vault_pda.password_hash, &[bump]];
        let signer = &[signer_seeds];

        // vault_pda의 AccountInfo도 별도로 클론
        let vault_info: AccountInfo<'info> = ctx.accounts.vault_pda.to_account_info().clone();

        for asset in vault_pda.assets.iter() {
            let matched_account_info = remaining_accounts
                .iter()
                .find(|acc| acc.key == &asset.asset_account)
                .ok_or(error!(ErrorCode::MissingAccount))?
                .clone();

            let cpi_accounts = SetAuthority {
                account_or_mint: matched_account_info,
                current_authority: vault_info.clone(),
            };

            let cpi_ctx = CpiContext::new_with_signer(
                token_program.clone(),
                cpi_accounts,
                signer,
            );

            token::set_authority(
                cpi_ctx,
                AuthorityType::AccountOwner,
                Some(ctx.accounts.claimer.key()),
            )?;
        }

        // 이후 mutable borrow 문제 없도록 처리
        let vault_pda = &mut ctx.accounts.vault_pda;
        vault_pda.is_claimed = true;
        vault_pda.assets.clear();

        Ok(())
    }




}

#[derive(Accounts)]
pub struct HideVault<'info> {
    #[account(mut)]
    pub vault_pda: Account<'info, VaultPda>,

    #[account(init_if_needed, payer = owner, seeds = [b"fees"], bump, space = 128)]
    pub fee_account: Account<'info, FeeAccount>,

    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut)]
    pub asset_account: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UnlockVault<'info> {
    #[account(mut)]
    pub vault_pda: Account<'info, VaultPda>,

    #[account(init_if_needed, payer = claimer, seeds = [b"fees"], bump, space = 128)]
    pub fee_account: Account<'info, FeeAccount>,

    #[account(mut)]
    pub claimer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimTreasure<'info> {
    #[account(mut)]
    pub vault_pda: Account<'info, VaultPda>,
    #[account(mut)]
    pub claimer: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[account]
pub struct VaultPda {
    pub owner: Pubkey,
    pub assets: Vec<StoredAsset>,
    pub password_hash: [u8; 32],
    pub is_claimed: bool,
    pub claimer: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct StoredAsset {
    pub mint: Pubkey,
    pub asset_account: Pubkey,
    pub asset_type: u8,
    pub amount: u64,
}

#[account]
pub struct FeeAccount {
    pub total_fees: u64,
    pub blacklisted_accounts: Vec<Pubkey>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid password!")]
    InvalidPassword,
    #[msg("Vault has already been claimed!")]
    AlreadyClaimed,
    #[msg("Only the claimer can claim the treasure!")]
    InvalidClaimer,
    #[msg("Missing token account in remaining_accounts")]
    MissingAccount,
    #[msg("Invalid vault PDA address")]
    InvalidVaultPda,
}
