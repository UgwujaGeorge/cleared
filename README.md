# Cleared

**Fair-launch token auctions on Solana, encrypted end-to-end via Arcium MPC.**

Cleared lets Solana projects launch their tokens via encrypted uniform-price sealed-bid auctions — the same mechanism the U.S. Treasury uses for bond auctions — so issuers get the true market price and bidders can't be sniped or front-run.

> **Status:** Phase 2.5 devnet upgrade complete. The Anchor program now custodies SPL supply and SOL deposits in per-auction escrow PDAs, and exposes pull-based `claim_winner`, `claim_loser`, `claim_issuer` settlement instructions on top of the encrypted clearing flow.

## Devnet Deployment

- **Program ID:** `2b48e7A9c91zVVnZSri15CXvDtgmLHYCqACL6GQYkqn9`
- **Latest version:** `v0.1.1` (custody layer)
- **v0.1.1 upgrade tx:** [`rDjxVMG38FBvxEmSaCYLXhATsNG33f3pSiivMy1RJGYXU9pwSiCJqAVZ4ec5XPZRG3DTa61pUo5dWPZkSVqCxZG`](https://solscan.io/tx/rDjxVMG38FBvxEmSaCYLXhATsNG33f3pSiivMy1RJGYXU9pwSiCJqAVZ4ec5XPZRG3DTa61pUo5dWPZkSVqCxZG?cluster=devnet)
- **Circuit release:** [`v0.1.0`](https://github.com/UgwujaGeorge/cleared/releases/tag/v0.1.0) — unchanged in v0.1.1; the comp-def hashes still match.
- **Roadmap:** [ROADMAP.md](ROADMAP.md)

## What this is

A uniform-price sealed-bid auction protocol with full on-chain custody:

1. Issuer creates an auction, depositing the full SPL supply into a per-auction escrow ATA.
2. Bidders submit encrypted `(price, quantity)` pairs through Arcium and deposit `max_spend = price × quantity` lamports into a per-auction SOL escrow PDA.
3. At close, the MPC network sorts bids, finds the clearing price (lowest winning bid), and reveals allocations.
4. Winners pull their SPL allocation + SOL refund (`max_spend − clearing_price × allocation`) via `claim_winner`.
5. Losers pull a full SOL refund via `claim_loser`.
6. Issuer pulls `clearing_price × total_sold` proceeds + any unsold tokens via `claim_issuer`.

No one — not the issuer, not any MPC node individually, not other bidders, not MEV bots — sees any bid until settlement.

## Stack

- **On-chain:** Anchor 0.32.1 + Arcium 0.9.3 on Solana devnet
- **SPL custody:** `anchor-spl 0.32.1` (Token + AssociatedToken)
- **Circuits:** Arcis (Rust) in `encrypted-ixs/`
- **Frontend:** Next.js 14 App Router + TypeScript + Tailwind + shadcn/ui (in `app/`)
- **Client:** `@arcium-hq/client@0.9.3`, `@coral-xyz/anchor@0.32.1`, `@solana/spl-token@^0.4`

## Layout

```
cleared/
├── programs/cleared/      Anchor program (clearing + custody + claims)
├── encrypted-ixs/         Arcis circuits (init_bid_book, add_bid, compute_clearing)
├── tests/                 Anchor integration tests (Mocha)
├── scripts/               Devnet helpers (init comp defs, smoke test, comp-def inspect)
├── app/                   Next.js frontend
├── migrations/            Anchor deploy scripts
├── Arcium.toml            MPC cluster config
├── Anchor.toml            Anchor workspace config
├── ROADMAP.md             v0.2 plan
└── .mcp.json              Arcium docs MCP server
```

## v0.1.1 changes

The custody layer is bolted on top of the existing MPC clearing pipeline; circuits are unchanged.

**New on-chain state:**

- `Auction` gains: `token_mint`, `token_escrow` (ATA), `sol_escrow` (PDA), `escrow_authority_bump`, `sol_escrow_bump`, `issuer_claimed`.
- `BidRecord` gains: `sol_deposited`, `won_quantity`, `refund_amount`, `encrypted_price`, `encrypted_quantity`, `bidder_pubkey`, `bidder_nonce`.

**New PDAs (per auction):**

- `["auction_authority", auction_id_le]` — owner of the SPL escrow ATA.
- `["sol_escrow", auction_id_le]` — program-owned PDA holding bidder lamports.

**New instructions:**

- `claim_winner` — bidder pulls SPL allocation + SOL refund.
- `claim_loser` — bidder pulls full SOL refund.
- `claim_issuer` — issuer pulls SOL proceeds + any unsold SPL.

**Modified instructions:**

- `create_auction` now takes `token_mint` + 6 SPL/escrow accounts and CPIs SPL into the escrow ATA.
- `submit_bid` gains a `max_spend: u64` arg and CPIs lamports into the SOL escrow PDA.

**Migration note:** v0.1.0 demo `Auction` and `BidRecord` accounts on devnet are no longer deserializable — the v0.1.1 layout adds trailing fields. Existing demo accounts (e.g., the canonical 3-bid auction settled at tx `5A2dKvXR…xK9Pr`) remain on-chain as legacy data; they are not queried by v0.1.1 clients.

## Developing

Build requires Rust 1.89.0 (pinned via `rust-toolchain.toml`), Solana CLI 2.3+, Anchor 0.32.1, and Arcium CLI 0.9.3.

```bash
arcium build       # build circuits + program
yarn test:clean    # integration tests on localnet — safe-default
cd app && yarn dev # frontend dev server
```

`yarn test:clean` runs `arcium clean && arcium test`. Use it instead of bare `arcium test`: the bare command's encrypted-ixs hash check can keep a stale circuit binary in place after source edits, leaving the on-chain comp-def CU count out of sync with what the Arx nodes parse — the MPC then aborts before any callback runs. Cleaning first avoids the trap; cost is one extra rebuild per run.

The localnet test exercises the full custody flow: a fresh SPL mint is created, 4 bids (3 winners + 1 loser) are submitted, settlement runs, and all 4 claim variants execute against real escrow balances. The conservation invariant `Σ refunds + issuer proceeds == Σ deposits` is asserted at the end.

### Devnet smoke

```bash
ANCHOR_PROVIDER_URL=<helius-devnet-rpc> npx ts-node scripts/devnet_smoke.ts
```

Creates a fresh test mint, runs a 2-bidder Winner/Loser scenario, and asserts SPL/SOL balances on-chain after each claim. All 7 transaction signatures are printed with Solscan links.

## License

MIT
