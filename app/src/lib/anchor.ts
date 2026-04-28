"use client";

import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { useConnection, useAnchorWallet } from "@solana/wallet-adapter-react";
import { useMemo } from "react";
import idl from "./idl/cleared.json";
import type { Cleared } from "./idl/cleared";

// AnchorProvider that talks via the wallet adapter. Returns null until a wallet
// is connected — guard call sites accordingly.
export function useAnchorProvider(): AnchorProvider | null {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  return useMemo(() => {
    if (!wallet) return null;
    return new AnchorProvider(connection, wallet, {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });
  }, [connection, wallet]);
}

export function useProgram(): Program<Cleared> | null {
  const provider = useAnchorProvider();
  return useMemo(() => {
    if (!provider) return null;
    return new Program<Cleared>(idl as Cleared, provider);
  }, [provider]);
}

// Read-only program for pages that don't require a connected wallet (e.g. /auctions).
import { Connection, PublicKey } from "@solana/web3.js";
import type { Wallet as AnchorWallet } from "@coral-xyz/anchor";

export function readonlyProgram(connection: Connection): Program<Cleared> {
  // Wallet shim that can never sign — safe because read-only call sites never
  // call .rpc(). Avoids importing Anchor's NodeWallet (Node-only) or Wallet
  // (export shape varies across 0.32 builds).
  const wallet: AnchorWallet = {
    publicKey: PublicKey.default,
    signTransaction: async <T>(tx: T) => tx,
    signAllTransactions: async <T>(txs: T[]) => txs,
    payer: undefined as unknown as never,
  };
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  return new Program<Cleared>(idl as Cleared, provider);
}
