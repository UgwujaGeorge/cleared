# Cleared

**Fair-launch token auctions on Solana, encrypted end-to-end via Arcium MPC.**

Cleared lets Solana projects launch their tokens via encrypted uniform-price sealed-bid auctions — the same mechanism the U.S. Treasury uses for bond auctions — so issuers get the true market price and bidders can't be sniped or front-run.

> **Status:** Phase 0 scaffold. Not yet functional. See build phases in `CLEARED_INSTRUCTIONS.md`.

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
