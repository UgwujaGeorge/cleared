"use client";

import Link from "next/link";
import type { AuctionRecord } from "@/lib/queries";
import { Countdown } from "./countdown";
import {
  shortAddr,
  shortAuctionId,
  solscanToken,
  statusBadgeClasses,
  statusEnum,
} from "@/lib/format";

export function AuctionCard({ row }: { row: AuctionRecord }) {
  const { account } = row;
  const status = statusEnum(account.status as unknown as Record<string, unknown>);
  return (
    <Link
      href={`/auctions/${account.auctionId.toString()}`}
      className="group flex flex-col gap-3 rounded-lg border border-border bg-card p-5 transition hover:border-foreground/30"
    >
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs text-muted-foreground">
          #{shortAuctionId(account.auctionId)}
        </span>
        <span
          className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${statusBadgeClasses(status)}`}
        >
          {status}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Token</span>
        <a
          href={solscanToken(account.tokenMint.toBase58())}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="font-mono text-sm hover:underline"
        >
          {shortAddr(account.tokenMint)}
        </a>
      </div>
      <div className="grid grid-cols-2 gap-3 text-xs">
        <div className="flex flex-col">
          <span className="text-muted-foreground">Supply</span>
          <span className="font-mono">{account.totalSupply.toString()}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-muted-foreground">Bids</span>
          <span className="font-mono">{account.bidCount}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-muted-foreground">Closes</span>
          <Countdown targetUnix={Number(account.closesAt.toString())} />
        </div>
        {status === "settled" && (
          <div className="flex flex-col">
            <span className="text-muted-foreground">Cleared @</span>
            <span className="font-mono">
              {account.clearingPrice.toString()}
            </span>
          </div>
        )}
      </div>
    </Link>
  );
}
