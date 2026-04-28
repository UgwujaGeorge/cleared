"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useProgram } from "@/lib/anchor";
import {
  fetchAllAuctions,
  fetchBidsByBidder,
  type AuctionRecord,
  type BidRecordRow,
} from "@/lib/queries";
import {
  deriveEscrowAuthorityPda,
  deriveSolEscrowPda,
} from "@/lib/pdas";
import {
  shortAddr,
  shortAuctionId,
  solscanTx,
  statusBadgeClasses,
  statusEnum,
  type AuctionStatus,
} from "@/lib/format";
import { FriendlyErrorBox } from "@/components/friendly-error-box";

type Loaded = {
  issued: AuctionRecord[];
  bids: Array<{ bid: BidRecordRow; auction: AuctionRecord | null }>;
};

export default function ProfilePage() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const program = useProgram();
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!program || !wallet.publicKey) return;
    let cancelled = false;
    (async () => {
      try {
        const [allAuctions, bids] = await Promise.all([
          fetchAllAuctions(program),
          fetchBidsByBidder(program, wallet.publicKey!),
        ]);
        const auctionsById = new Map(
          allAuctions.map((a) => [a.account.auctionId.toString(), a])
        );
        const issued = allAuctions.filter((a) =>
          a.account.issuer.equals(wallet.publicKey!)
        );
        const bidsWithAuction = bids.map((bid) => ({
          bid,
          auction: auctionsById.get(bid.account.auctionId.toString()) ?? null,
        }));
        if (!cancelled) setData({ issued, bids: bidsWithAuction });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.publicKey?.toBase58(), connection.rpcEndpoint, reloadTick]);

  if (!wallet.publicKey) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-24 text-center">
        <h1 className="font-mono text-3xl font-bold tracking-tight">Profile</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Connect a wallet to view your auctions and bids.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-10 px-6 py-12">
      <header className="flex flex-col gap-2">
        <h1 className="font-mono text-3xl font-bold tracking-tight">Profile</h1>
        <p className="font-mono text-xs text-muted-foreground">
          {wallet.publicKey.toBase58()}
        </p>
      </header>

      {error && <FriendlyErrorBox error={error} />}

      <Section title="Auctions you issued">
        {!data ? (
          <Skeleton />
        ) : data.issued.length === 0 ? (
          <Empty msg="You haven't created any auctions yet." />
        ) : (
          data.issued.map((a) => (
            <IssuerRow
              key={a.publicKey.toBase58()}
              row={a}
              onClaimed={() => setReloadTick((t) => t + 1)}
            />
          ))
        )}
      </Section>

      <Section title="Bids you submitted">
        {!data ? (
          <Skeleton />
        ) : data.bids.length === 0 ? (
          <Empty msg="No bids yet." />
        ) : (
          data.bids.map((entry) => (
            <BidderRow
              key={entry.bid.publicKey.toBase58()}
              entry={entry}
              onClaimed={() => setReloadTick((t) => t + 1)}
            />
          ))
        )}
      </Section>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-mono text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

function Skeleton() {
  return (
    <div className="h-20 animate-pulse rounded-lg border border-border bg-card/40" />
  );
}

function Empty({ msg }: { msg: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
      {msg}
    </div>
  );
}

function IssuerRow({
  row,
  onClaimed,
}: {
  row: AuctionRecord;
  onClaimed: () => void;
}) {
  const a = row.account;
  const status = statusEnum(a.status as unknown as Record<string, unknown>);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-1">
        <Link
          href={`/auctions/${a.auctionId.toString()}`}
          className="font-mono text-sm hover:underline"
        >
          #{shortAuctionId(a.auctionId)}
        </Link>
        <span className="font-mono text-xs text-muted-foreground">
          mint {shortAddr(a.tokenMint)} • supply {a.totalSupply.toString()}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <Badge status={status} />
        {status === "settled" && (
          <ClaimIssuerButton row={row} onClaimed={onClaimed} />
        )}
      </div>
    </div>
  );
}

function BidderRow({
  entry,
  onClaimed,
}: {
  entry: { bid: BidRecordRow; auction: AuctionRecord | null };
  onClaimed: () => void;
}) {
  const { bid, auction } = entry;
  const auctionStatus = auction
    ? statusEnum(auction.account.status as unknown as Record<string, unknown>)
    : "initializing";
  const bidderId = Number(bid.account.bidderId.toString());
  const allocation =
    auction && bidderId < auction.account.allocations.length
      ? (auction.account.allocations[bidderId] as BN).toNumber()
      : 0;
  const bidStatusKey = Object.keys(
    bid.account.status as unknown as Record<string, unknown>
  )[0];
  const isClaimed = bidStatusKey === "claimed";

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-1">
        <Link
          href={`/auctions/${bid.account.auctionId.toString()}`}
          className="font-mono text-sm hover:underline"
        >
          #{shortAuctionId(bid.account.auctionId)}
        </Link>
        <span className="font-mono text-xs text-muted-foreground">
          deposited {bid.account.solDeposited.toString()} lamports • bid id{" "}
          {bidderId}
        </span>
        {auctionStatus === "settled" && (
          <span className="font-mono text-xs">
            {allocation > 0
              ? `won ${allocation} tokens @ clearing ${auction!.account.clearingPrice.toString()}`
              : "no allocation"}
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        <Badge status={auctionStatus} />
        {auctionStatus === "settled" && !isClaimed && auction && (
          allocation > 0 ? (
            <ClaimWinnerButton
              auction={auction}
              bidPda={bid.publicKey}
              onClaimed={onClaimed}
            />
          ) : (
            <ClaimLoserButton
              auction={auction}
              bidPda={bid.publicKey}
              onClaimed={onClaimed}
            />
          )
        )}
        {isClaimed && (
          <span className="font-mono text-xs text-muted-foreground">
            claimed
          </span>
        )}
      </div>
    </div>
  );
}

function Badge({ status }: { status: AuctionStatus }) {
  return (
    <span
      className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${statusBadgeClasses(status)}`}
    >
      {status}
    </span>
  );
}

type ClaimState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "done"; sig: string }
  | { kind: "error"; msg: string };

function ClaimWinnerButton({
  auction,
  bidPda,
  onClaimed,
}: {
  auction: AuctionRecord;
  bidPda: PublicKey;
  onClaimed: () => void;
}) {
  const program = useProgram();
  const wallet = useWallet();
  const [state, setState] = useState<ClaimState>({ kind: "idle" });

  const click = async () => {
    if (!program || !wallet.publicKey) return;
    setState({ kind: "submitting" });
    try {
      const auctionId = auction.account.auctionId;
      const [escrowAuthority] = deriveEscrowAuthorityPda(auctionId);
      const [solEscrow] = deriveSolEscrowPda(auctionId);
      const bidderTokenAccount = getAssociatedTokenAddressSync(
        auction.account.tokenMint,
        wallet.publicKey
      );
      const sig = await program.methods
        .claimWinner()
        .accountsPartial({
          bidder: wallet.publicKey,
          auction: auction.publicKey,
          bidRecord: bidPda,
          escrowAuthority,
          tokenEscrow: auction.account.tokenEscrow,
          bidderTokenAccount,
          tokenMint: auction.account.tokenMint,
          solEscrow,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .rpc({ commitment: "confirmed" });
      setState({ kind: "done", sig });
      onClaimed();
    } catch (e) {
      setState({ kind: "error", msg: e instanceof Error ? e.message : String(e) });
    }
  };

  return <ClaimButton label="Claim winner" state={state} onClick={click} />;
}

function ClaimLoserButton({
  auction,
  bidPda,
  onClaimed,
}: {
  auction: AuctionRecord;
  bidPda: PublicKey;
  onClaimed: () => void;
}) {
  const program = useProgram();
  const wallet = useWallet();
  const [state, setState] = useState<ClaimState>({ kind: "idle" });

  const click = async () => {
    if (!program || !wallet.publicKey) return;
    setState({ kind: "submitting" });
    try {
      const [solEscrow] = deriveSolEscrowPda(auction.account.auctionId);
      const sig = await program.methods
        .claimLoser()
        .accountsPartial({
          bidder: wallet.publicKey,
          auction: auction.publicKey,
          bidRecord: bidPda,
          solEscrow,
        })
        .rpc({ commitment: "confirmed" });
      setState({ kind: "done", sig });
      onClaimed();
    } catch (e) {
      setState({ kind: "error", msg: e instanceof Error ? e.message : String(e) });
    }
  };

  return <ClaimButton label="Claim refund" state={state} onClick={click} />;
}

function ClaimIssuerButton({
  row,
  onClaimed,
}: {
  row: AuctionRecord;
  onClaimed: () => void;
}) {
  const program = useProgram();
  const wallet = useWallet();
  const [state, setState] = useState<ClaimState>({ kind: "idle" });
  const a = row.account;

  if (a.issuerClaimed) {
    return (
      <span className="font-mono text-xs text-muted-foreground">claimed</span>
    );
  }

  const click = async () => {
    if (!program || !wallet.publicKey) return;
    setState({ kind: "submitting" });
    try {
      const [escrowAuthority] = deriveEscrowAuthorityPda(a.auctionId);
      const [solEscrow] = deriveSolEscrowPda(a.auctionId);
      const issuerTokenAccount = getAssociatedTokenAddressSync(
        a.tokenMint,
        wallet.publicKey
      );
      const sig = await program.methods
        .claimIssuer()
        .accountsPartial({
          issuer: wallet.publicKey,
          auction: row.publicKey,
          escrowAuthority,
          tokenEscrow: a.tokenEscrow,
          issuerTokenAccount,
          tokenMint: a.tokenMint,
          solEscrow,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .rpc({ commitment: "confirmed" });
      setState({ kind: "done", sig });
      onClaimed();
    } catch (e) {
      setState({ kind: "error", msg: e instanceof Error ? e.message : String(e) });
    }
  };

  return <ClaimButton label="Claim proceeds" state={state} onClick={click} />;
}

function ClaimButton({
  label,
  state,
  onClick,
}: {
  label: string;
  state: ClaimState;
  onClick: () => void;
}) {
  return (
    <div className="flex max-w-xs flex-col items-end gap-1.5">
      <button
        onClick={onClick}
        disabled={state.kind === "submitting" || state.kind === "done"}
        className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {state.kind === "submitting"
          ? "Submitting…"
          : state.kind === "done"
          ? "Claimed"
          : label}
      </button>
      {state.kind === "done" && (
        <a
          href={solscanTx(state.sig)}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-[10px] text-emerald-400 underline"
        >
          View on Solscan: {state.sig.slice(0, 12)}…
        </a>
      )}
      {state.kind === "error" && (
        <div className="w-full">
          <FriendlyErrorBox error={state.msg} compact />
        </div>
      )}
    </div>
  );
}

// PublicKey import isn't used in this file but keeps tree-shaking honest if
// extracted. Suppress the unused-import lint.
void PublicKey;
