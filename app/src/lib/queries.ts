"use client";

import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import type { Cleared } from "./idl/cleared";

// v0.1.1 Auction account size including the 8-byte discriminator.
// Mirrors Auction::SIZE in programs/cleared/src/lib.rs. Used as a dataSize
// filter so v0.1.0 demo accounts (444 bytes) are skipped at the RPC layer
// — they would otherwise fail Borsh deserialization.
export const AUCTION_V011_SIZE = 543;

export type AuctionRecord = {
  publicKey: PublicKey;
  account: Awaited<ReturnType<Program<Cleared>["account"]["auction"]["fetch"]>>;
};

export type BidRecordRow = {
  publicKey: PublicKey;
  account: Awaited<ReturnType<Program<Cleared>["account"]["bidRecord"]["fetch"]>>;
};

export async function fetchAllAuctions(
  program: Program<Cleared>
): Promise<AuctionRecord[]> {
  // Filter to v0.1.1 layout only — skips v0.1.0 demo accounts cleanly.
  const filter = [{ dataSize: AUCTION_V011_SIZE }];
  const rows = await program.account.auction.all(filter);
  // Newest first by closes_at.
  rows.sort(
    (a, b) =>
      new BN(b.account.closesAt as unknown as BN).toNumber() -
      new BN(a.account.closesAt as unknown as BN).toNumber()
  );
  return rows;
}

export async function fetchAuctionsByIssuer(
  program: Program<Cleared>,
  issuer: PublicKey
): Promise<AuctionRecord[]> {
  const all = await fetchAllAuctions(program);
  return all.filter((a) => a.account.issuer.equals(issuer));
}

export async function fetchBidsByBidder(
  program: Program<Cleared>,
  bidder: PublicKey
): Promise<BidRecordRow[]> {
  // bidder pubkey lives at offset 8 (disc) + 8 (auction_id) = 16.
  const filter = [
    {
      memcmp: {
        offset: 16,
        bytes: bidder.toBase58(),
      },
    },
  ];
  return await program.account.bidRecord.all(filter);
}
