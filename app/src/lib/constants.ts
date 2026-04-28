import { PublicKey } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey(
  "2b48e7A9c91zVVnZSri15CXvDtgmLHYCqACL6GQYkqn9"
);

// Cluster offset for the Arcium MPC cluster the program is wired to.
// Must match Arcium.toml [clusters.devnet] offset.
export const ARCIUM_CLUSTER_OFFSET = 456;

// Mirror of programs/cleared/src/lib.rs:13 — must stay in sync.
export const MAX_BIDS = 8;

// PDA seeds — string literals here, encoded in pdas.ts.
export const AUCTION_SEED = "auction";
export const BID_SEED = "bid";
export const ESCROW_AUTHORITY_SEED = "auction_authority";
export const SOL_ESCROW_SEED = "sol_escrow";

// RPC: prefer NEXT_PUBLIC_RPC_URL; fall back to public devnet RPC. The fallback
// will rate-limit aggressively — judges should plug in their own Helius/Triton
// URL via env var.
export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";

export const NETWORK_LABEL = "DEVNET";
