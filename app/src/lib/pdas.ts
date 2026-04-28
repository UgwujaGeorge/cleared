import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  AUCTION_SEED,
  BID_SEED,
  ESCROW_AUTHORITY_SEED,
  PROGRAM_ID,
  SOL_ESCROW_SEED,
} from "./constants";

function auctionIdLe(auctionId: BN): Buffer {
  return Buffer.from(auctionId.toArrayLike(Buffer, "le", 8));
}

export function deriveAuctionPda(auctionId: BN): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(AUCTION_SEED), auctionIdLe(auctionId)],
    PROGRAM_ID
  );
}

export function deriveBidRecordPda(
  auctionId: BN,
  bidder: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(BID_SEED), auctionIdLe(auctionId), bidder.toBuffer()],
    PROGRAM_ID
  );
}

export function deriveEscrowAuthorityPda(auctionId: BN): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(ESCROW_AUTHORITY_SEED), auctionIdLe(auctionId)],
    PROGRAM_ID
  );
}

export function deriveSolEscrowPda(auctionId: BN): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SOL_ESCROW_SEED), auctionIdLe(auctionId)],
    PROGRAM_ID
  );
}
