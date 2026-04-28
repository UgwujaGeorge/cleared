"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { BN } from "@coral-xyz/anchor";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useProgram, readonlyProgram } from "@/lib/anchor";
import {
  deriveAuctionPda,
  deriveBidRecordPda,
  deriveSolEscrowPda,
} from "@/lib/pdas";
import {
  shortAddr,
  shortAuctionId,
  solscanAccount,
  solscanToken,
  statusBadgeClasses,
  statusEnum,
} from "@/lib/format";
import { Countdown } from "@/components/countdown";
import { BidForm } from "@/components/bid-form";
import { CloseAuctionButton } from "@/components/close-auction-button";
import { FriendlyErrorBox } from "@/components/friendly-error-box";
import type { AuctionRecord } from "@/lib/queries";

export default function AuctionDetailPage() {
  const params = useParams<{ id: string }>();
  const { connection } = useConnection();
  const wallet = useWallet();
  const walletProgram = useProgram();
  const program = walletProgram ?? readonlyProgram(connection);

  let auctionId: BN | null = null;
  try {
    auctionId = new BN(params.id);
  } catch {
    auctionId = null;
  }

  const [row, setRow] = useState<AuctionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [myBidQty, setMyBidQty] = useState<number | null>(null);
  const [myBidIdx, setMyBidIdx] = useState<number | null>(null);
  const [waitingSince, setWaitingSince] = useState<number | null>(null);

  useEffect(() => {
    if (!auctionId) {
      setError("Invalid auction id in URL.");
      return;
    }
    let cancelled = false;
    const [pda] = deriveAuctionPda(auctionId);
    program.account.auction
      .fetch(pda)
      .then(async (account) => {
        if (cancelled) return;
        setRow({ publicKey: pda, account });
        if (wallet.publicKey) {
          const [bidPda] = deriveBidRecordPda(auctionId!, wallet.publicKey);
          try {
            const br = await program.account.bidRecord.fetch(bidPda);
            const idx = Number(br.bidderId.toString());
            setMyBidIdx(idx);
            const won = (account.allocations[idx] as BN | undefined)?.toNumber() ?? 0;
            setMyBidQty(won);
          } catch {
            setMyBidIdx(null);
            setMyBidQty(null);
          }
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message ?? String(e));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id, wallet.publicKey?.toBase58(), reloadTick, connection.rpcEndpoint]);

  // While the on-chain status is "initializing" or "closing", silently re-fetch
  // the auction account every ~5s so the UI flips to "active"/"settled" the
  // moment the Arcium MPC callback lands. UI-only — does not touch any tx
  // logic.
  useEffect(() => {
    if (!row) return;
    const status = statusEnum(
      row.account.status as unknown as Record<string, unknown>
    );
    if (status !== "initializing" && status !== "closing") {
      setWaitingSince(null);
      return;
    }
    if (waitingSince === null) setWaitingSince(Date.now());
    const interval = setInterval(() => {
      setReloadTick((t) => t + 1);
    }, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row?.account.status]);

  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-12">
        <FriendlyErrorBox error={error} />
      </div>
    );
  }
  if (!row || !auctionId) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-12">
        <div className="h-64 animate-pulse rounded-lg border border-border bg-card/40" />
      </div>
    );
  }

  const a = row.account;
  const status = statusEnum(a.status as unknown as Record<string, unknown>);
  const [solEscrow] = deriveSolEscrowPda(auctionId);
  const closesAtUnix = Number(a.closesAt.toString());
  const pastClose = Date.now() / 1000 >= closesAtUnix;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-muted-foreground">
            #{shortAuctionId(a.auctionId)}
          </span>
          <span
            className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${statusBadgeClasses(status)}`}
          >
            {status}
          </span>
        </div>
        <h1 className="font-mono text-3xl font-bold tracking-tight">
          Token{" "}
          <a
            href={solscanToken(a.tokenMint.toBase58())}
            target="_blank"
            rel="noreferrer"
            className="hover:underline"
          >
            {shortAddr(a.tokenMint)}
          </a>
        </h1>
        <p className="text-sm text-muted-foreground">
          Issued by{" "}
          <a
            href={solscanAccount(a.issuer.toBase58())}
            target="_blank"
            rel="noreferrer"
            className="font-mono hover:underline"
          >
            {shortAddr(a.issuer)}
          </a>
        </p>
      </header>

      <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Supply" value={a.totalSupply.toString()} />
        <Stat label="Bids" value={a.bidCount.toString()} />
        <Stat label="Min price" value={a.minPrice.toString()} />
        <Stat
          label="Closes"
          value={
            <Countdown targetUnix={Number(a.closesAt.toString())} />
          }
        />
      </section>

      {status === "settled" && (
        <section className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5">
          <h3 className="font-mono text-sm font-semibold">Settlement</h3>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                Clearing price
              </span>
              <span className="font-mono text-2xl">
                {a.clearingPrice.toString()}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Total sold</span>
              <span className="font-mono text-2xl">
                {a.totalSold.toString()}
              </span>
            </div>
          </div>
          {wallet.publicKey && myBidIdx !== null && (
            <div className="rounded-md border border-border bg-muted/30 p-3 text-xs">
              <p className="text-muted-foreground">Your allocation</p>
              <p className="mt-1 font-mono text-base">
                {myBidQty} / {(myBidIdx ?? 0) >= 0 ? "" : ""}
                {a.allocations[myBidIdx ?? 0]?.toString() ?? 0} tokens
              </p>
              <p className="mt-2 text-muted-foreground">
                Visit{" "}
                <a href="/profile" className="text-foreground underline">
                  /profile
                </a>{" "}
                to claim.
              </p>
            </div>
          )}
        </section>
      )}

      {status === "initializing" && (
        <InitializingPanel
          waitingSince={waitingSince}
          onRefresh={() => setReloadTick((t) => t + 1)}
        />
      )}

      {status === "active" && !pastClose && (
        <BidForm
          auctionId={auctionId}
          auctionPda={row.publicKey}
          solEscrow={solEscrow}
          onSubmitted={() => setReloadTick((t) => t + 1)}
        />
      )}

      {status === "active" && pastClose && (
        <CloseAuctionButton
          auctionPda={row.publicKey}
          onClosed={() => setReloadTick((t) => t + 1)}
        />
      )}

      {status === "closing" && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-5 text-xs text-amber-300">
          <span className="mt-0.5 inline-block size-1.5 animate-pulse rounded-full bg-amber-300" />
          <div>
            <p className="font-medium">MPC clearing in progress</p>
            <p className="mt-1 opacity-80">
              The compute_clearing computation runs on the Arcium cluster and
              posts the clearing price + winner allocations back via callback
              (~30–90s on devnet). This page will update automatically.
            </p>
          </div>
        </div>
      )}

      {status === "active" && !pastClose && wallet.publicKey && myBidIdx !== null && (
        <div className="rounded-md border border-border bg-muted/30 p-3 text-xs">
          You already submitted a bid (id #{myBidIdx}). One bid per wallet per
          auction; the MPC will reveal allocations after close.
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-card p-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-base">{value}</span>
    </div>
  );
}

function InitializingPanel({
  waitingSince,
  onRefresh,
}: {
  waitingSince: number | null;
  onRefresh: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsedSec = waitingSince
    ? Math.max(0, Math.floor((now - waitingSince) / 1000))
    : 0;
  const longWait = elapsedSec > 90;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-violet-500/40 bg-violet-500/10 p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="inline-block size-1.5 animate-pulse rounded-full bg-violet-300" />
          <h3 className="font-mono text-sm font-semibold text-violet-200">
            MPC initializing the encrypted bid book
          </h3>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-wider text-violet-300/80">
          {elapsedSec}s elapsed
        </span>
      </div>
      <p className="text-xs text-violet-200/80">
        Your auction was created on-chain. The Arcium cluster is now seeding
        an encrypted bid book via the <code className="font-mono">init_bid_book</code> computation
        (~30–90s on devnet). The bidding form will appear automatically once
        the MPC callback lands.
      </p>
      <div className="flex items-center gap-2">
        <button
          onClick={onRefresh}
          className="rounded-md border border-violet-400/40 bg-violet-500/20 px-3 py-1.5 text-xs font-medium text-violet-100 hover:bg-violet-500/30"
        >
          Refresh now
        </button>
        {longWait && (
          <span className="text-[11px] text-amber-300">
            Devnet may be slow — keep this tab open and the page will update on its own.
          </span>
        )}
      </div>
    </div>
  );
}
