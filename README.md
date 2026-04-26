# Cleared

**Fair-launch token auctions on Solana, encrypted end-to-end via Arcium MPC.**

Cleared lets Solana projects launch their tokens via encrypted uniform-price sealed-bid auctions — the same mechanism the U.S. Treasury uses for bond auctions — so issuers get the true market price and bidders can't be sniped or front-run.

> **Status:** Phase 2 devnet proof complete. The Anchor program and Arcium
> circuits run end-to-end on devnet at `MAX_BIDS=8`.

## Devnet Deployment

- **Program ID:** `2b48e7A9c91zVVnZSri15CXvDtgmLHYCqACL6GQYkqn9`
- **Circuit release:** [`v0.1.0`](https://github.com/UgwujaGeorge/cleared/releases/tag/v0.1.0)
- **Canonical settlement tx:** [`5A2dKvXRSy3ecqzQLEBWzoh4uy5MU8aF4Rto1E4hVCSVCjooCDsdfPUdBHDDkdfmTYASMgUpT29TkP9E8n7xK9Pr`](https://solscan.io/tx/5A2dKvXRSy3ecqzQLEBWzoh4uy5MU8aF4Rto1E4hVCSVCjooCDsdfPUdBHDDkdfmTYASMgUpT29TkP9E8n7xK9Pr?cluster=devnet)

Verified devnet scenario:

- Alice bids `500 @ 10`
- Bob bids `300 @ 8`
- Carol bids `400 @ 7`
- Result: clearing price `7`, total sold `1000`, allocations `[500, 300, 200, 0, 0, 0, 0, 0]`

## What this is

A uniform-price sealed-bid auction protocol:

1. Issuer sells N tokens
2. Bidders submit encrypted `(price, quantity)` pairs through Arcium
3. At close, the MPC network sorts bids, finds the clearing price (lowest winning bid), and reveals allocations
4. Every winner pays the same clearing price — not what they bid

No one — not the issuer, not any MPC node individually, not other bidders, not MEV bots — sees any bid until settlement.

## Stack

- **On-chain:** Anchor 0.32.1 + Arcium 0.9.3 on Solana devnet
- **Circuits:** Arcis (Rust) in `encrypted-ixs/`
- **Frontend:** Next.js 14 App Router + TypeScript + Tailwind + shadcn/ui (in `app/`)
- **Client:** `@arcium-hq/client@0.9.3`, `@coral-xyz/anchor@0.32.1`

## Layout

```
cleared/
├── programs/cleared/      Anchor program
├── encrypted-ixs/         Arcis circuits (compute_clearing)
├── tests/                 Anchor integration tests (Mocha)
├── app/                   Next.js frontend
├── migrations/            Anchor deploy scripts
├── Arcium.toml            MPC cluster config
├── Anchor.toml            Anchor workspace config
└── .mcp.json              Arcium docs MCP server
```

## Developing

Build requires Rust 1.89.0 (pinned via `rust-toolchain.toml`), Solana CLI 2.3+, Anchor 0.32.1, and Arcium CLI 0.9.3.

```bash
arcium build       # build circuits + program
yarn test:clean    # integration tests on localnet — safe-default
cd app && yarn dev # frontend dev server
```

`yarn test:clean` runs `arcium clean && arcium test`. Use it instead of bare `arcium test`: the bare command's encrypted-ixs hash check can keep a stale circuit binary in place after source edits, leaving the on-chain comp-def CU count out of sync with what the Arx nodes parse — the MPC then aborts before any callback runs. Cleaning first avoids the trap; cost is one extra rebuild per run.

Dev/demo instructions will be expanded in later phases.

## License

MIT
