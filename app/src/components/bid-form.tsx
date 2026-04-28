"use client";

import { useState } from "react";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { RescueCipher, deserializeLE, x25519 } from "@arcium-hq/client";
import { useProgram } from "@/lib/anchor";
import {
  arciumQueueAccounts,
  fetchMxePublicKey,
} from "@/lib/arcium";
import { deriveBidRecordPda } from "@/lib/pdas";
import { PROGRAM_ID } from "@/lib/constants";
import { solscanTx } from "@/lib/format";
import { FriendlyErrorBox } from "./friendly-error-box";

function randomBytes(len: number): Uint8Array {
  const out = new Uint8Array(len);
  crypto.getRandomValues(out);
  return out;
}

type Status =
  | { kind: "idle" }
  | { kind: "encrypting" }
  | { kind: "submitting" }
  | { kind: "finalizing" }
  | { kind: "done"; sig: string }
  | { kind: "error"; msg: string };

export function BidForm({
  auctionId,
  auctionPda,
  solEscrow,
  onSubmitted,
}: {
  auctionId: BN;
  auctionPda: PublicKey;
  solEscrow: PublicKey;
  onSubmitted?: () => void;
}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const program = useProgram();
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!program || !wallet.publicKey) {
      setStatus({ kind: "error", msg: "Connect a wallet first." });
      return;
    }
    let priceBN: BN;
    let quantityBN: BN;
    try {
      priceBN = new BN(price.trim());
      quantityBN = new BN(quantity.trim());
      if (priceBN.lten(0) || quantityBN.lten(0)) {
        throw new Error("price and quantity must be > 0");
      }
    } catch (err) {
      setStatus({
        kind: "error",
        msg: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const maxSpend = priceBN.mul(quantityBN);

    try {
      setStatus({ kind: "encrypting" });
      const mxePk = await fetchMxePublicKey(connection, PROGRAM_ID);
      const bidderPriv = x25519.utils.randomSecretKey();
      const bidderPub = x25519.getPublicKey(bidderPriv);
      const sharedSecret = x25519.getSharedSecret(bidderPriv, mxePk);
      const cipher = new RescueCipher(sharedSecret);
      const nonce = randomBytes(16);
      const ct = cipher.encrypt(
        [BigInt(priceBN.toString()), BigInt(quantityBN.toString())],
        nonce
      );

      setStatus({ kind: "submitting" });
      const computationOffset = new BN(randomBytes(8), "hex");
      const [bidRecordPda] = deriveBidRecordPda(auctionId, wallet.publicKey);

      const sig = await program.methods
        .submitBid(
          computationOffset,
          Array.from(ct[0]),
          Array.from(ct[1]),
          Array.from(bidderPub),
          new BN(deserializeLE(nonce).toString()),
          maxSpend
        )
        .accountsPartial({
          payer: wallet.publicKey,
          bidder: wallet.publicKey,
          auction: auctionPda,
          bidRecord: bidRecordPda,
          solEscrow,
          ...arciumQueueAccounts(PROGRAM_ID, computationOffset, "add_bid"),
        })
        .rpc({ skipPreflight: false, commitment: "confirmed" });

      // Don't block the UI on Arcium MPC finalization — the bid is accepted at
      // submit_bid; add_bid writes the new book ciphertext back via callback
      // within ~30-60s on devnet.
      setStatus({ kind: "done", sig });
      onSubmitted?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus({ kind: "error", msg });
    }
  };

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5"
    >
      <div className="flex items-center justify-between">
        <h3 className="font-mono text-sm font-semibold">Place an encrypted bid</h3>
        <span className="font-mono text-[10px] uppercase tracking-wider text-emerald-400">
          SEALED
        </span>
      </div>
      <div className="flex flex-col gap-2">
        <label className="text-xs text-muted-foreground">
          Price per token (lamports)
        </label>
        <input
          type="text"
          inputMode="numeric"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder="e.g. 10"
          className="rounded-md border border-input bg-background px-3 py-2 font-mono text-sm focus:border-foreground/40 focus:outline-none"
          required
        />
      </div>
      <div className="flex flex-col gap-2">
        <label className="text-xs text-muted-foreground">Quantity (tokens)</label>
        <input
          type="text"
          inputMode="numeric"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          placeholder="e.g. 100"
          className="rounded-md border border-input bg-background px-3 py-2 font-mono text-sm focus:border-foreground/40 focus:outline-none"
          required
        />
      </div>
      {price && quantity && (
        <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
          <span className="text-muted-foreground">Will deposit</span>
          <span className="font-mono">
            {(() => {
              try {
                return `${new BN(price).mul(new BN(quantity)).toString()} lamports`;
              } catch {
                return "—";
              }
            })()}
          </span>
        </div>
      )}
      <button
        type="submit"
        disabled={
          !wallet.publicKey ||
          status.kind === "encrypting" ||
          status.kind === "submitting" ||
          status.kind === "finalizing"
        }
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {!wallet.publicKey
          ? "Connect a wallet"
          : status.kind === "encrypting"
          ? "Encrypting…"
          : status.kind === "submitting"
          ? "Submitting…"
          : status.kind === "finalizing"
          ? "Awaiting MPC…"
          : "Submit encrypted bid"}
      </button>
      {status.kind === "done" && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs">
          <div className="flex items-center gap-2">
            <span className="inline-block size-1.5 rounded-full bg-emerald-400" />
            <p className="text-emerald-300">
              Bid sealed and submitted on-chain.
            </p>
          </div>
          <p className="mt-1 text-[11px] text-emerald-300/80">
            The Arcium MPC will fold it into the encrypted bid book in the
            next 30–60s.
          </p>
          <a
            href={solscanTx(status.sig)}
            target="_blank"
            rel="noreferrer"
            className="mt-2 block font-mono text-[10px] text-emerald-300/90 underline"
          >
            View on Solscan: {status.sig.slice(0, 24)}…
          </a>
        </div>
      )}
      {status.kind === "error" && <FriendlyErrorBox error={status.msg} />}
    </form>
  );
}
