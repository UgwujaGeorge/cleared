# Cleared — Roadmap

Tracks features and fixes deferred from the v0.1.x line. Items are grouped by what unblocks them.

## v0.2 — capacity & defenses

### Heap-backed bid book for `MAX_BIDS > 16`

**Why:** v0.1.x is hard-capped at `MAX_BIDS = 8` because the encrypted bid book is a `Pack<[u64; 3*MAX_BIDS]>` stored inline on the `Auction` account, and the `compute_clearing` callback's `ClearingResult` (containing `[u64; MAX_BIDS]` allocations) must fit in the ~1232-byte Solana callback limit. Doubling `MAX_BIDS` blows the callback size; quadrupling also blows the on-account inline storage budget for the bid book ciphertext.

**Plan:**

1. Move the bid book ciphertext off the `Auction` account into a dedicated `BidBookSegment` account chain — one segment per N ciphertexts, linked by index. The `Auction` keeps a head segment pubkey + segment count.
2. Have the MPC callback emit per-bidder allocations into a `WinnerListSegment` chain rather than a fixed `[u64; MAX_BIDS]`. `compute_clearing_callback` walks the chain across multiple finalization txs (one segment per tx if needed).
3. Re-target `MAX_BIDS = 32` then `64` in subsequent point releases as comfort with the segment chain pattern grows.

**Risks:** the MPC needs to scan the segment chain via remaining_accounts; ArgBuilder/queue_computation account list grows. May require the `pack_arg` pattern from the Arcium agent skill to keep tx size in check.

### Bidder under-deposit defense — partial fills + commit-reveal

**Why:** v0.1.1 trusts the bidder's plaintext `max_spend` matches their encrypted `(price, quantity)`. A malicious bidder can lie: encrypt a winning `(high_price, large_quantity)` while only depositing a tiny `max_spend`. They "win" the allocation in the MPC but `claim_winner` errors with `InsufficientDeposit` and they forfeit. The auction loses that allocation — the issuer receives less SOL than they should, and other losing bidders don't get a second chance to fill the gap.

**Plan:**

1. **Commit-reveal in the bid:** at `submit_bid` time, store a Pedersen commitment to `(price, quantity, bidder_secret)` alongside the encrypted ciphertexts. After settlement, run a second MPC pass that compares the encrypted bid to the commitment using the deposited `max_spend` as the cap. Bids that fail the commitment check are zeroed before the clearing computation, not after.
2. **Partial fills:** if a winner under-deposits, fill them up to `floor(max_spend / clearing_price)` instead of forfeiting their full allocation. Distribute the shortfall to the next-highest unfilled bidder.

**Risks:** adds a second MPC round-trip per auction; commitment scheme adds ~64 bytes per `BidRecord`.

### Alternative: gate `submit_bid` with a price ceiling

A simpler v0.1.x-compatible mitigation: require `max_spend ≥ MIN_PRICE × MAX_QUANTITY_PER_WALLET`. Bounds the worst-case under-deposit at the cost of forcing larger up-front deposits than strictly necessary. Keep in mind for v0.1.2 if the full commit-reveal path is too expensive.

## Out of v0.2 scope (queued for later)

- **Mainnet deployment.** Devnet only for the RTG submission. Mainnet requires a security review pass (claim ix authorization, escrow PDA seed collisions, IDL upgrade authority handover).
- **Multiple auctions per issuer.** Already supported by the current design (auction PDAs are seeded by `auction_id`, no per-issuer registry), but a `/profile` UX that aggregates them isn't built out yet.
- **Token-2022.** v0.1.x is hard-pinned to classic SPL Token (`spl-token 8.x`). Adding 2022 means optionally branching the `token_program` account and supporting transfer hooks — out of scope until there's RTG demand.
- **Auction cancellation by issuer pre-bid.** Currently the issuer cannot reclaim escrowed SPL before any bids land. Acceptable for v0.1.x because auctions are intended as commitments, but worth a `cancel_pre_bid` ix with a strict `bid_count == 0` guard.
- **Bidder-side bid update / withdraw.** Each bid is one-shot; can't change your mind once `submit_bid` lands. v0.1.x design tradeoff.

## Future layout-migration plan

If v0.2 changes the `Auction` or `BidRecord` field set again, **do not** rely on Anchor's silent deserialization to handle old accounts. Two options when that day comes:

1. **Versioned accounts.** Add a `version: u8` as the first non-discriminator field; branch deserialization in client code based on it. Cheapest if the layout is small.
2. **Migration ix.** Provide a `migrate_auction_v01_to_v02` ix that reads the old account, reallocates, and writes the new layout. Idempotent. Costs rent for the new bytes.

v0.1.0 → v0.1.1 took the simpler path of accepting that v0.1.0 demo accounts become unreadable. That is no longer acceptable once mainnet user data is at stake.
