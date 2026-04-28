"use client";

import { BN } from "@coral-xyz/anchor";
import {
  getClockAccAddress,
  getClusterAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getComputationAccAddress,
  getExecutingPoolAccAddress,
  getFeePoolAccAddress,
  getMempoolAccAddress,
  getMXEAccAddress,
  getMXEPublicKey,
} from "@arcium-hq/client";
import { Connection, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { ARCIUM_CLUSTER_OFFSET } from "./constants";

export type CircuitName = "init_bid_book" | "add_bid" | "compute_clearing";

// Mirror of the helper in tests/cleared.ts and scripts/devnet_smoke.ts. The
// poolAccount + clockAccount are passed explicitly because Anchor's
// accountsPartial resolver doesn't auto-fill them on submit_bid.
export function arciumQueueAccounts(
  programId: PublicKey,
  offset: BN,
  circuit: CircuitName
) {
  return {
    computationAccount: getComputationAccAddress(ARCIUM_CLUSTER_OFFSET, offset),
    clusterAccount: getClusterAccAddress(ARCIUM_CLUSTER_OFFSET),
    mxeAccount: getMXEAccAddress(programId),
    mempoolAccount: getMempoolAccAddress(ARCIUM_CLUSTER_OFFSET),
    executingPool: getExecutingPoolAccAddress(ARCIUM_CLUSTER_OFFSET),
    compDefAccount: getCompDefAccAddress(
      programId,
      Buffer.from(getCompDefAccOffset(circuit)).readUInt32LE()
    ),
    poolAccount: getFeePoolAccAddress(),
    clockAccount: getClockAccAddress(),
  };
}

// MXE x25519 pubkey is needed to encrypt bids client-side. Cached per (rpc,
// program) pair to avoid the multi-second fetch on every bid form mount.
const mxeCache = new Map<string, Uint8Array>();

export async function fetchMxePublicKey(
  connection: Connection,
  programId: PublicKey
): Promise<Uint8Array> {
  const key = `${connection.rpcEndpoint}:${programId.toBase58()}`;
  const cached = mxeCache.get(key);
  if (cached) return cached;
  const provider = new anchor.AnchorProvider(
    connection,
    {
      // sign* functions are unused for getMXEPublicKey but the type requires them.
      publicKey: PublicKey.default,
      signTransaction: async (tx) => tx,
      signAllTransactions: async (txs) => txs,
    } as anchor.Wallet,
    { commitment: "confirmed" }
  );
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const pk = await getMXEPublicKey(provider, programId);
      if (pk) {
        mxeCache.set(key, pk);
        return pk;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error("Could not fetch MXE pubkey after 8 attempts");
}
