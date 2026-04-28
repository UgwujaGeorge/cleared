"use client";

import { useState } from "react";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { useProgram } from "@/lib/anchor";
import { arciumQueueAccounts } from "@/lib/arcium";
import { PROGRAM_ID } from "@/lib/constants";
import { solscanTx } from "@/lib/format";
import { FriendlyErrorBox } from "./friendly-error-box";

function randomBytes(len: number): Uint8Array {
  const out = new Uint8Array(len);
  crypto.getRandomValues(out);
  return out;
}

type State =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "done"; sig: string }
  | { kind: "error"; msg: string };

export function CloseAuctionButton({
  auctionPda,
  onClosed,
}: {
  auctionPda: PublicKey;
  onClosed?: () => void;
}) {
  const program = useProgram();
  const wallet = useWallet();
  const [state, setState] = useState<State>({ kind: "idle" });

  const click = async () => {
    if (!program || !wallet.publicKey) {
      setState({ kind: "error", msg: "Connect a wallet first." });
      return;
    }
    setState({ kind: "submitting" });
    try {
      const computationOffset = new BN(randomBytes(8), "hex");
      const sig = await program.methods
        .closeAuction(computationOffset)
        .accountsPartial({
          payer: wallet.publicKey,
          auction: auctionPda,
          ...arciumQueueAccounts(
            PROGRAM_ID,
            computationOffset,
            "compute_clearing"
          ),
        })
        .rpc({ skipPreflight: false, commitment: "confirmed" });
      setState({ kind: "done", sig });
      onClosed?.();
    } catch (err) {
      setState({
        kind: "error",
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <h3 className="font-mono text-sm font-semibold">Settle auction</h3>
        <span className="font-mono text-[10px] uppercase tracking-wider text-amber-400">
          PAST CLOSE
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        The bidding window has ended. Anyone can trigger the encrypted
        clearing computation. The MPC sorts bids and reveals the clearing
        price; on-chain settlement follows automatically.
      </p>
      <button
        onClick={click}
        disabled={
          !wallet.publicKey ||
          state.kind === "submitting" ||
          state.kind === "done"
        }
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {!wallet.publicKey
          ? "Connect a wallet"
          : state.kind === "submitting"
          ? "Queueing MPC…"
          : state.kind === "done"
          ? "Queued — awaiting clearing"
          : "Trigger MPC clearing"}
      </button>
      {state.kind === "done" && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs">
          <div className="flex items-center gap-2">
            <span className="inline-block size-1.5 rounded-full bg-emerald-400" />
            <p className="text-emerald-300">
              Clearing computation queued. Awaiting MPC callback…
            </p>
          </div>
          <a
            href={solscanTx(state.sig)}
            target="_blank"
            rel="noreferrer"
            className="mt-2 block font-mono text-[10px] text-emerald-300/90 underline"
          >
            View on Solscan: {state.sig.slice(0, 24)}…
          </a>
        </div>
      )}
      {state.kind === "error" && <FriendlyErrorBox error={state.msg} />}
    </div>
  );
}
