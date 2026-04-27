use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::{CallbackAccount, CircuitSource, OffChainCircuitSource};
use arcium_macros::circuit_hash;

// PDA seed constants for escrow / authority accounts.
pub const ESCROW_AUTHORITY_SEED: &[u8] = b"auction_authority";
pub const SOL_ESCROW_SEED: &[u8] = b"sol_escrow";

const COMP_DEF_OFFSET_INIT_BID_BOOK: u32 = comp_def_offset("init_bid_book");
const COMP_DEF_OFFSET_ADD_BID: u32 = comp_def_offset("add_bid");
const COMP_DEF_OFFSET_COMPUTE_CLEARING: u32 = comp_def_offset("compute_clearing");

declare_id!("2b48e7A9c91zVVnZSri15CXvDtgmLHYCqACL6GQYkqn9");

// Must match `MAX_BIDS` in encrypted-ixs/src/lib.rs.
pub const MAX_BIDS: usize = 8;
// BidBook ciphertext count after Pack<[u64; 3*MAX_BIDS]>: 3 u64s per BLS12-381
// scalar field gives ceil(3*MAX_BIDS / 3) = MAX_BIDS field elements. Count is
// tracked plaintext as auction.bid_count and passed back to the circuit per call.
pub const BID_BOOK_CT_COUNT: usize = MAX_BIDS;

const INIT_BID_BOOK_URL: &str =
    "https://github.com/UgwujaGeorge/cleared/releases/download/v0.1.0/init_bid_book.arcis";
const ADD_BID_URL: &str =
    "https://github.com/UgwujaGeorge/cleared/releases/download/v0.1.0/add_bid.arcis";
const COMPUTE_CLEARING_URL: &str =
    "https://github.com/UgwujaGeorge/cleared/releases/download/v0.1.0/compute_clearing.arcis";

#[arcium_program]
pub mod cleared {
    use super::*;

    // === comp def init (called once per circuit after program deploy) ===
    // Circuit bytes are hosted off-chain in the GitHub release above; Arcium
    // verifies the downloaded bytes against the compile-time circuit_hash.

    pub fn init_init_bid_book_comp_def(ctx: Context<InitInitBidBookCompDef>) -> Result<()> {
        init_comp_def(
            ctx.accounts,
            Some(CircuitSource::OffChain(OffChainCircuitSource {
                source: INIT_BID_BOOK_URL.to_string(),
                hash: circuit_hash!("init_bid_book"),
            })),
            None,
        )?;
        Ok(())
    }

    pub fn init_add_bid_comp_def(ctx: Context<InitAddBidCompDef>) -> Result<()> {
        init_comp_def(
            ctx.accounts,
            Some(CircuitSource::OffChain(OffChainCircuitSource {
                source: ADD_BID_URL.to_string(),
                hash: circuit_hash!("add_bid"),
            })),
            None,
        )?;
        Ok(())
    }

    pub fn init_compute_clearing_comp_def(ctx: Context<InitComputeClearingCompDef>) -> Result<()> {
        init_comp_def(
            ctx.accounts,
            Some(CircuitSource::OffChain(OffChainCircuitSource {
                source: COMPUTE_CLEARING_URL.to_string(),
                hash: circuit_hash!("compute_clearing"),
            })),
            None,
        )?;
        Ok(())
    }

    // === create_auction: creates Auction, queues init_bid_book ===

    pub fn create_auction(
        ctx: Context<CreateAuction>,
        computation_offset: u64,
        auction_id: u64,
        total_supply: u64,
        min_price: u64,
        max_bid_per_wallet: u64,
        opens_at: i64,
        closes_at: i64,
    ) -> Result<()> {
        require!(total_supply > 0, ErrorCode::InvalidSupply);
        require!(closes_at > opens_at, ErrorCode::InvalidSchedule);

        // Move the SPL supply from issuer into the escrow ATA before recording state.
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.issuer_token_account.to_account_info(),
                    to: ctx.accounts.token_escrow.to_account_info(),
                    authority: ctx.accounts.issuer.to_account_info(),
                },
            ),
            total_supply,
        )?;

        let auction = &mut ctx.accounts.auction;
        auction.auction_id = auction_id;
        auction.issuer = ctx.accounts.issuer.key();
        auction.total_supply = total_supply;
        auction.min_price = min_price;
        auction.max_bid_per_wallet = max_bid_per_wallet;
        auction.opens_at = opens_at;
        auction.closes_at = closes_at;
        auction.status = AuctionStatus::Initializing;
        auction.bid_count = 0;
        auction.clearing_price = 0;
        auction.total_sold = 0;
        auction.allocations = [0; MAX_BIDS];
        auction.encrypted_bid_book = [[0u8; 32]; BID_BOOK_CT_COUNT];
        auction.encrypted_bid_book_nonce = [0u8; 16];
        auction.bump = ctx.bumps.auction;
        auction.token_mint = ctx.accounts.token_mint.key();
        auction.token_escrow = ctx.accounts.token_escrow.key();
        auction.sol_escrow = ctx.accounts.sol_escrow.key();
        auction.escrow_authority_bump = ctx.bumps.escrow_authority;
        auction.sol_escrow_bump = ctx.bumps.sol_escrow;
        auction.issuer_claimed = false;

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let args = ArgBuilder::new().build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![InitBidBookCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: ctx.accounts.auction.key(),
                    is_writable: true,
                }],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "init_bid_book")]
    pub fn init_bid_book_callback(
        ctx: Context<InitBidBookCallback>,
        output: SignedComputationOutputs<InitBidBookOutput>,
    ) -> Result<()> {
        let book = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(InitBidBookOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };
        let auction = &mut ctx.accounts.auction;
        auction.encrypted_bid_book_nonce = book.nonce.to_le_bytes();
        auction.encrypted_bid_book = book.ciphertexts;
        auction.status = AuctionStatus::Active;
        Ok(())
    }

    // === submit_bid: records a BidRecord, queues add_bid ===

    pub fn submit_bid(
        ctx: Context<SubmitBid>,
        computation_offset: u64,
        price_ct: [u8; 32],
        quantity_ct: [u8; 32],
        bidder_pubkey: [u8; 32],
        bidder_nonce: u128,
        max_spend: u64,
    ) -> Result<()> {
        // Snapshot + validate (scoped so the mutable borrow releases before queue_computation).
        let (auction_id, bidder_id, auction_key, bid_book_nonce, bid_book) = {
            let auction = &ctx.accounts.auction;
            require!(
                auction.status == AuctionStatus::Active,
                ErrorCode::AuctionNotActive
            );
            let clock = Clock::get()?;
            require!(
                clock.unix_timestamp >= auction.opens_at,
                ErrorCode::AuctionNotOpen
            );
            require!(
                clock.unix_timestamp < auction.closes_at,
                ErrorCode::AuctionClosed
            );
            require!(
                (auction.bid_count as usize) < MAX_BIDS,
                ErrorCode::AuctionFull
            );
            require!(max_spend > 0, ErrorCode::ZeroDeposit);
            (
                auction.auction_id,
                auction.bid_count as u64,
                auction.key(),
                auction.encrypted_bid_book_nonce,
                auction.encrypted_bid_book,
            )
        };

        // Move max_spend lamports from bidder into the per-auction sol escrow PDA.
        // Bidder is system-owned so a CPI transfer is the right primitive here;
        // outbound from sol_escrow uses direct lamport mutation in claim_*.
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.bidder.to_account_info(),
                    to: ctx.accounts.sol_escrow.to_account_info(),
                },
            ),
            max_spend,
        )?;

        {
            let bid_record = &mut ctx.accounts.bid_record;
            bid_record.auction_id = auction_id;
            bid_record.bidder = ctx.accounts.bidder.key();
            bid_record.bidder_id = bidder_id;
            bid_record.status = BidStatus::Pending;
            bid_record.bump = ctx.bumps.bid_record;
            bid_record.sol_deposited = max_spend;
            bid_record.won_quantity = 0;
            bid_record.refund_amount = 0;
            bid_record.encrypted_price = price_ct;
            bid_record.encrypted_quantity = quantity_ct;
            bid_record.bidder_pubkey = bidder_pubkey;
            bid_record.bidder_nonce = bidder_nonce;
        }

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        // Param order must match add_bid signature:
        //   (Enc<Shared, UserBid>, u64 bidder_id, u64 count, Enc<Mxe, BidBook>)
        // bidder_id == count at submission time (sequential 0,1,2...).
        let mut args = ArgBuilder::new()
            .x25519_pubkey(bidder_pubkey)
            .plaintext_u128(bidder_nonce)
            .encrypted_u64(price_ct)
            .encrypted_u64(quantity_ct)
            .plaintext_u64(bidder_id)
            .plaintext_u64(bidder_id)
            .plaintext_u128(u128::from_le_bytes(bid_book_nonce));
        for ciphertext in bid_book {
            args = args.encrypted_u64(ciphertext);
        }
        let args = args.build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![AddBidCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: auction_key,
                    is_writable: true,
                }],
            )?],
            1,
            0,
        )?;

        ctx.accounts.auction.bid_count += 1;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "add_bid")]
    pub fn add_bid_callback(
        ctx: Context<AddBidCallback>,
        output: SignedComputationOutputs<AddBidOutput>,
    ) -> Result<()> {
        let book = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(AddBidOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };
        let auction = &mut ctx.accounts.auction;
        auction.encrypted_bid_book_nonce = book.nonce.to_le_bytes();
        auction.encrypted_bid_book = book.ciphertexts;
        Ok(())
    }

    // === close_auction: queues compute_clearing ===

    pub fn close_auction(ctx: Context<CloseAuction>, computation_offset: u64) -> Result<()> {
        let auction = &mut ctx.accounts.auction;
        require!(
            auction.status == AuctionStatus::Active,
            ErrorCode::AuctionNotActive
        );
        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp >= auction.closes_at,
            ErrorCode::AuctionStillOpen
        );

        auction.status = AuctionStatus::Closing;

        let bid_book_nonce = auction.encrypted_bid_book_nonce;
        let bid_book = auction.encrypted_bid_book;
        let total_supply = auction.total_supply;
        let bid_count = auction.bid_count as u64;

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        // Param order: (Enc<Mxe, BidBook>, u64 count, u64 total_supply)
        let mut args = ArgBuilder::new().plaintext_u128(u128::from_le_bytes(bid_book_nonce));
        for ciphertext in bid_book {
            args = args.encrypted_u64(ciphertext);
        }
        let args = args
            .plaintext_u64(bid_count)
            .plaintext_u64(total_supply)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![ComputeClearingCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: ctx.accounts.auction.key(),
                    is_writable: true,
                }],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "compute_clearing")]
    pub fn compute_clearing_callback(
        ctx: Context<ComputeClearingCallback>,
        output: SignedComputationOutputs<ComputeClearingOutput>,
    ) -> Result<()> {
        let result = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(r) => r,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };
        let inner = result.field_0;
        let auction = &mut ctx.accounts.auction;
        auction.clearing_price = inner.field_0;
        auction.allocations = inner.field_1;
        auction.total_sold = inner.field_2;
        auction.status = AuctionStatus::Settled;

        emit!(AuctionSettled {
            auction_id: auction.auction_id,
            clearing_price: auction.clearing_price,
            total_sold: auction.total_sold,
        });
        Ok(())
    }

    // === claim_winner: bidder pulls their SPL allocation + SOL refund ===

    pub fn claim_winner(ctx: Context<ClaimWinner>) -> Result<()> {
        let auction = &ctx.accounts.auction;
        let bid_record = &ctx.accounts.bid_record;

        require!(
            auction.status == AuctionStatus::Settled,
            ErrorCode::AuctionNotSettled
        );
        require!(
            bid_record.status == BidStatus::Pending,
            ErrorCode::BidAlreadyClaimed
        );

        let bidder_id = bid_record.bidder_id as usize;
        require!(bidder_id < MAX_BIDS, ErrorCode::InvalidBidderId);
        let won_qty = auction.allocations[bidder_id];
        require!(won_qty > 0, ErrorCode::NotWinner);

        let owed_lamports = auction
            .clearing_price
            .checked_mul(won_qty)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        require!(
            bid_record.sol_deposited >= owed_lamports,
            ErrorCode::InsufficientDeposit
        );
        let refund = bid_record
            .sol_deposited
            .checked_sub(owed_lamports)
            .ok_or(ErrorCode::ArithmeticOverflow)?;

        // SPL: token_escrow -> bidder_token_account, signed by escrow_authority PDA.
        let auction_id_bytes = auction.auction_id.to_le_bytes();
        let auth_seeds: &[&[u8]] = &[
            ESCROW_AUTHORITY_SEED,
            auction_id_bytes.as_ref(),
            std::slice::from_ref(&auction.escrow_authority_bump),
        ];
        let auth_signer: &[&[&[u8]]] = &[auth_seeds];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.token_escrow.to_account_info(),
                    to: ctx.accounts.bidder_token_account.to_account_info(),
                    authority: ctx.accounts.escrow_authority.to_account_info(),
                },
                auth_signer,
            ),
            won_qty,
        )?;

        // SOL refund: direct lamport mutation (sol_escrow is owned by this program).
        if refund > 0 {
            transfer_from_pda(
                &ctx.accounts.sol_escrow.to_account_info(),
                &ctx.accounts.bidder.to_account_info(),
                refund,
            )?;
        }

        let bid_record = &mut ctx.accounts.bid_record;
        bid_record.won_quantity = won_qty;
        bid_record.refund_amount = refund;
        bid_record.status = BidStatus::Claimed;
        Ok(())
    }

    // === claim_loser: bidder pulls full SOL refund (no SPL allocation) ===

    pub fn claim_loser(ctx: Context<ClaimLoser>) -> Result<()> {
        let auction = &ctx.accounts.auction;
        let bid_record = &ctx.accounts.bid_record;

        require!(
            auction.status == AuctionStatus::Settled,
            ErrorCode::AuctionNotSettled
        );
        require!(
            bid_record.status == BidStatus::Pending,
            ErrorCode::BidAlreadyClaimed
        );

        let bidder_id = bid_record.bidder_id as usize;
        require!(bidder_id < MAX_BIDS, ErrorCode::InvalidBidderId);
        require!(
            auction.allocations[bidder_id] == 0,
            ErrorCode::NotLoser
        );

        let refund = bid_record.sol_deposited;
        if refund > 0 {
            transfer_from_pda(
                &ctx.accounts.sol_escrow.to_account_info(),
                &ctx.accounts.bidder.to_account_info(),
                refund,
            )?;
        }

        let bid_record = &mut ctx.accounts.bid_record;
        bid_record.refund_amount = refund;
        bid_record.status = BidStatus::Claimed;
        Ok(())
    }

    // === claim_issuer: issuer pulls clearing_price * total_sold proceeds + unsold SPL ===

    pub fn claim_issuer(ctx: Context<ClaimIssuer>) -> Result<()> {
        let auction = &ctx.accounts.auction;

        require!(
            auction.status == AuctionStatus::Settled,
            ErrorCode::AuctionNotSettled
        );
        require!(!auction.issuer_claimed, ErrorCode::IssuerAlreadyClaimed);
        require!(
            auction.issuer == ctx.accounts.issuer.key(),
            ErrorCode::WrongIssuer
        );

        let proceeds = auction
            .clearing_price
            .checked_mul(auction.total_sold)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        let unsold = auction
            .total_supply
            .checked_sub(auction.total_sold)
            .ok_or(ErrorCode::ArithmeticOverflow)?;

        if proceeds > 0 {
            transfer_from_pda(
                &ctx.accounts.sol_escrow.to_account_info(),
                &ctx.accounts.issuer.to_account_info(),
                proceeds,
            )?;
        }

        if unsold > 0 {
            let auction_id_bytes = auction.auction_id.to_le_bytes();
            let auth_seeds: &[&[u8]] = &[
                ESCROW_AUTHORITY_SEED,
                auction_id_bytes.as_ref(),
                std::slice::from_ref(&auction.escrow_authority_bump),
            ];
            let auth_signer: &[&[&[u8]]] = &[auth_seeds];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.token_escrow.to_account_info(),
                        to: ctx.accounts.issuer_token_account.to_account_info(),
                        authority: ctx.accounts.escrow_authority.to_account_info(),
                    },
                    auth_signer,
                ),
                unsold,
            )?;
        }

        let auction = &mut ctx.accounts.auction;
        auction.issuer_claimed = true;
        Ok(())
    }
}

// ========== helpers ==========

// Move lamports from a program-owned PDA to any destination by direct mutation.
// The PDA must be owned by this program; constraints on the Accounts struct
// guarantee that for sol_escrow.
fn transfer_from_pda<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let from_lamports = from.lamports();
    let new_from = from_lamports
        .checked_sub(amount)
        .ok_or(ErrorCode::InsufficientEscrow)?;
    let new_to = to
        .lamports()
        .checked_add(amount)
        .ok_or(ErrorCode::ArithmeticOverflow)?;
    **from.try_borrow_mut_lamports()? = new_from;
    **to.try_borrow_mut_lamports()? = new_to;
    Ok(())
}

// ========== accounts ==========

#[account]
pub struct Auction {
    pub auction_id: u64,
    pub issuer: Pubkey,
    pub total_supply: u64,
    pub min_price: u64,
    pub max_bid_per_wallet: u64,
    pub opens_at: i64,
    pub closes_at: i64,
    pub status: AuctionStatus,
    pub bid_count: u16,
    pub clearing_price: u64,
    pub total_sold: u64,
    pub allocations: [u64; MAX_BIDS],
    pub encrypted_bid_book: [[u8; 32]; BID_BOOK_CT_COUNT],
    pub encrypted_bid_book_nonce: [u8; 16],
    pub bump: u8,
    // v0.1.1 custody fields
    pub token_mint: Pubkey,
    pub token_escrow: Pubkey,
    pub sol_escrow: Pubkey,
    pub escrow_authority_bump: u8,
    pub sol_escrow_bump: u8,
    pub issuer_claimed: bool,
}

impl Auction {
    pub const SIZE: usize = 8                              // discriminator
        + 8 + 32 + 8 * 5 + 1 + 2 + 8 * 2                   // through total_sold
        + 8 * MAX_BIDS + 32 * BID_BOOK_CT_COUNT + 16 + 1   // allocations + book + nonce + bump
        + 32 + 32 + 32 + 1 + 1 + 1;                        // v0.1.1 custody fields
}

#[account]
#[derive(Default)]
pub struct BidRecord {
    pub auction_id: u64,
    pub bidder: Pubkey,
    pub bidder_id: u64,
    pub status: BidStatus,
    pub bump: u8,
    // v0.1.1 custody fields
    pub sol_deposited: u64,
    pub won_quantity: u64,
    pub refund_amount: u64,
    pub encrypted_price: [u8; 32],
    pub encrypted_quantity: [u8; 32],
    pub bidder_pubkey: [u8; 32],
    pub bidder_nonce: u128,
}

impl BidRecord {
    pub const SIZE: usize = 8 + 8 + 32 + 8 + 1 + 1        // through bump
        + 8 + 8 + 8 + 32 + 32 + 32 + 16;                  // v0.1.1 custody fields
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum AuctionStatus {
    Initializing,
    Active,
    Closing,
    Settled,
    Failed,
}

impl Default for AuctionStatus {
    fn default() -> Self {
        AuctionStatus::Initializing
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum BidStatus {
    Pending,
    Won,
    Lost,
    Claimed,
}

impl Default for BidStatus {
    fn default() -> Self {
        BidStatus::Pending
    }
}

// ========== init_comp_def account structs ==========

#[init_computation_definition_accounts("init_bid_book", payer)]
#[derive(Accounts)]
pub struct InitInitBidBookCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("add_bid", payer)]
#[derive(Accounts)]
pub struct InitAddBidCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("compute_clearing", payer)]
#[derive(Accounts)]
pub struct InitComputeClearingCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

// ========== create_auction (queues init_bid_book) ==========

#[queue_computation_accounts("init_bid_book", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64, auction_id: u64)]
pub struct CreateAuction<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub issuer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = Auction::SIZE,
        seeds = [b"auction", auction_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub auction: Box<Account<'info, Auction>>,
    pub token_mint: Box<Account<'info, Mint>>,
    #[account(
        mut,
        constraint = issuer_token_account.mint == token_mint.key()
            @ ErrorCode::WrongMint,
        constraint = issuer_token_account.owner == issuer.key()
            @ ErrorCode::WrongTokenOwner,
    )]
    pub issuer_token_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: PDA used only as the SPL escrow ATA authority. Holds no data.
    #[account(
        seeds = [ESCROW_AUTHORITY_SEED, auction_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub escrow_authority: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        associated_token::mint = token_mint,
        associated_token::authority = escrow_authority,
    )]
    pub token_escrow: Box<Account<'info, TokenAccount>>,
    /// CHECK: SOL-only PDA created here, owned by this program. Lamports
    /// are pulled out via direct mutation in claim_*.
    #[account(
        init,
        payer = payer,
        space = 0,
        seeds = [SOL_ESCROW_SEED, auction_id.to_le_bytes().as_ref()],
        bump,
        owner = crate::ID,
    )]
    pub sol_escrow: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(
        mut,
        address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: mempool_account, checked by arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: executing_pool, checked by arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: computation_account, checked by arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_INIT_BID_BOOK))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(
        mut,
        address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("init_bid_book")]
#[derive(Accounts)]
pub struct InitBidBookCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_INIT_BID_BOOK))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account, checked by arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint.
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub auction: Box<Account<'info, Auction>>,
}

// ========== submit_bid (queues add_bid) ==========

#[queue_computation_accounts("add_bid", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct SubmitBid<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub bidder: Signer<'info>,
    #[account(
        mut,
        seeds = [b"auction", auction.auction_id.to_le_bytes().as_ref()],
        bump = auction.bump,
    )]
    pub auction: Box<Account<'info, Auction>>,
    #[account(
        init,
        payer = payer,
        space = BidRecord::SIZE,
        seeds = [
            b"bid",
            auction.auction_id.to_le_bytes().as_ref(),
            bidder.key().as_ref(),
        ],
        bump,
    )]
    pub bid_record: Box<Account<'info, BidRecord>>,
    /// CHECK: per-auction SOL escrow PDA. Constraint binds it to auction.sol_escrow.
    #[account(
        mut,
        address = auction.sol_escrow @ ErrorCode::WrongSolEscrow,
        seeds = [SOL_ESCROW_SEED, auction.auction_id.to_le_bytes().as_ref()],
        bump = auction.sol_escrow_bump,
    )]
    pub sol_escrow: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(
        mut,
        address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: mempool_account, checked by arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: executing_pool, checked by arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: computation_account, checked by arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_ADD_BID))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(
        mut,
        address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("add_bid")]
#[derive(Accounts)]
pub struct AddBidCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_ADD_BID))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account, checked by arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint.
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub auction: Box<Account<'info, Auction>>,
}

// ========== close_auction (queues compute_clearing) ==========

#[queue_computation_accounts("compute_clearing", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct CloseAuction<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"auction", auction.auction_id.to_le_bytes().as_ref()],
        bump = auction.bump,
    )]
    pub auction: Box<Account<'info, Auction>>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(
        mut,
        address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: mempool_account, checked by arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: executing_pool, checked by arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet)
    )]
    /// CHECK: computation_account, checked by arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_COMPUTE_CLEARING))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(
        mut,
        address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet)
    )]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("compute_clearing")]
#[derive(Accounts)]
pub struct ComputeClearingCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_COMPUTE_CLEARING))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: computation_account, checked by arcium program.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar, checked by the account constraint.
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub auction: Box<Account<'info, Auction>>,
}

// ========== claim instructions (v0.1.1) ==========

#[derive(Accounts)]
pub struct ClaimWinner<'info> {
    #[account(mut)]
    pub bidder: Signer<'info>,
    #[account(
        mut,
        seeds = [b"auction", auction.auction_id.to_le_bytes().as_ref()],
        bump = auction.bump,
    )]
    pub auction: Box<Account<'info, Auction>>,
    #[account(
        mut,
        seeds = [
            b"bid",
            auction.auction_id.to_le_bytes().as_ref(),
            bidder.key().as_ref(),
        ],
        bump = bid_record.bump,
        constraint = bid_record.bidder == bidder.key() @ ErrorCode::WrongBidder,
    )]
    pub bid_record: Box<Account<'info, BidRecord>>,
    /// CHECK: PDA authority for the SPL escrow ATA. Address is bound by seeds + bump.
    #[account(
        seeds = [ESCROW_AUTHORITY_SEED, auction.auction_id.to_le_bytes().as_ref()],
        bump = auction.escrow_authority_bump,
    )]
    pub escrow_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        address = auction.token_escrow @ ErrorCode::WrongTokenEscrow,
    )]
    pub token_escrow: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = bidder,
        associated_token::mint = token_mint,
        associated_token::authority = bidder,
    )]
    pub bidder_token_account: Box<Account<'info, TokenAccount>>,
    #[account(address = auction.token_mint @ ErrorCode::WrongMint)]
    pub token_mint: Box<Account<'info, Mint>>,
    /// CHECK: SOL escrow PDA, address pinned to auction.sol_escrow.
    #[account(
        mut,
        address = auction.sol_escrow @ ErrorCode::WrongSolEscrow,
        seeds = [SOL_ESCROW_SEED, auction.auction_id.to_le_bytes().as_ref()],
        bump = auction.sol_escrow_bump,
    )]
    pub sol_escrow: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimLoser<'info> {
    #[account(mut)]
    pub bidder: Signer<'info>,
    #[account(
        seeds = [b"auction", auction.auction_id.to_le_bytes().as_ref()],
        bump = auction.bump,
    )]
    pub auction: Box<Account<'info, Auction>>,
    #[account(
        mut,
        seeds = [
            b"bid",
            auction.auction_id.to_le_bytes().as_ref(),
            bidder.key().as_ref(),
        ],
        bump = bid_record.bump,
        constraint = bid_record.bidder == bidder.key() @ ErrorCode::WrongBidder,
    )]
    pub bid_record: Box<Account<'info, BidRecord>>,
    /// CHECK: SOL escrow PDA, address pinned to auction.sol_escrow.
    #[account(
        mut,
        address = auction.sol_escrow @ ErrorCode::WrongSolEscrow,
        seeds = [SOL_ESCROW_SEED, auction.auction_id.to_le_bytes().as_ref()],
        bump = auction.sol_escrow_bump,
    )]
    pub sol_escrow: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimIssuer<'info> {
    #[account(mut)]
    pub issuer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"auction", auction.auction_id.to_le_bytes().as_ref()],
        bump = auction.bump,
    )]
    pub auction: Box<Account<'info, Auction>>,
    /// CHECK: PDA authority for the SPL escrow ATA. Address bound by seeds + bump.
    #[account(
        seeds = [ESCROW_AUTHORITY_SEED, auction.auction_id.to_le_bytes().as_ref()],
        bump = auction.escrow_authority_bump,
    )]
    pub escrow_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        address = auction.token_escrow @ ErrorCode::WrongTokenEscrow,
    )]
    pub token_escrow: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = issuer,
        associated_token::mint = token_mint,
        associated_token::authority = issuer,
    )]
    pub issuer_token_account: Box<Account<'info, TokenAccount>>,
    #[account(address = auction.token_mint @ ErrorCode::WrongMint)]
    pub token_mint: Box<Account<'info, Mint>>,
    /// CHECK: SOL escrow PDA, address pinned to auction.sol_escrow.
    #[account(
        mut,
        address = auction.sol_escrow @ ErrorCode::WrongSolEscrow,
        seeds = [SOL_ESCROW_SEED, auction.auction_id.to_le_bytes().as_ref()],
        bump = auction.sol_escrow_bump,
    )]
    pub sol_escrow: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// ========== events ==========

#[event]
pub struct AuctionSettled {
    pub auction_id: u64,
    pub clearing_price: u64,
    pub total_sold: u64,
}

// ========== errors ==========

#[error_code]
pub enum ErrorCode {
    #[msg("The computation was aborted")]
    AbortedComputation,
    #[msg("Cluster not set")]
    ClusterNotSet,
    #[msg("Invalid total supply")]
    InvalidSupply,
    #[msg("Invalid schedule (opens_at >= closes_at)")]
    InvalidSchedule,
    #[msg("Auction is not active")]
    AuctionNotActive,
    #[msg("Auction has not opened yet")]
    AuctionNotOpen,
    #[msg("Auction is already closed")]
    AuctionClosed,
    #[msg("Auction has not reached close time")]
    AuctionStillOpen,
    #[msg("Auction is full")]
    AuctionFull,
    #[msg("Bid deposit must be > 0")]
    ZeroDeposit,
    #[msg("Auction is not settled yet")]
    AuctionNotSettled,
    #[msg("Bid has already been claimed")]
    BidAlreadyClaimed,
    #[msg("Issuer has already claimed proceeds")]
    IssuerAlreadyClaimed,
    #[msg("Caller is not the auction issuer")]
    WrongIssuer,
    #[msg("Caller is not the bid record owner")]
    WrongBidder,
    #[msg("Bid record's bidder_id is out of range")]
    InvalidBidderId,
    #[msg("Bid did not win an allocation")]
    NotWinner,
    #[msg("Bid won an allocation; use claim_winner")]
    NotLoser,
    #[msg("Deposited SOL is below clearing_price * won_quantity")]
    InsufficientDeposit,
    #[msg("SOL escrow has insufficient balance")]
    InsufficientEscrow,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Token mint does not match auction.token_mint")]
    WrongMint,
    #[msg("Issuer token account is owned by the wrong wallet")]
    WrongTokenOwner,
    #[msg("Token escrow does not match auction.token_escrow")]
    WrongTokenEscrow,
    #[msg("SOL escrow does not match auction.sol_escrow")]
    WrongSolEscrow,
}
