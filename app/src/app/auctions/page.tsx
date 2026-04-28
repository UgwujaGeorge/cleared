"use client";

import { useEffect, useMemo, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { useProgram } from "@/lib/anchor";
import { readonlyProgram } from "@/lib/anchor";
import { fetchAllAuctions, type AuctionRecord } from "@/lib/queries";
import { AuctionCard } from "@/components/auction-card";
import { FriendlyErrorBox } from "@/components/friendly-error-box";
import { statusEnum, type AuctionStatus } from "@/lib/format";

const FILTERS: Array<{ label: string; value: "all" | AuctionStatus }> = [
  { label: "All", value: "all" },
  { label: "Active", value: "active" },
  { label: "Closing", value: "closing" },
  { label: "Settled", value: "settled" },
];

export default function AuctionsPage() {
  const { connection } = useConnection();
  const walletProgram = useProgram();
  const program = walletProgram ?? readonlyProgram(connection);
  const [filter, setFilter] = useState<"all" | AuctionStatus>("all");
  const [rows, setRows] = useState<AuctionRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAllAuctions(program)
      .then((rs) => {
        if (!cancelled) setRows(rs);
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message ?? String(e));
      });
    return () => {
      cancelled = true;
    };
    // Re-fetch when the underlying connection (RPC) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.rpcEndpoint]);

  const filtered = useMemo(() => {
    if (!rows) return null;
    if (filter === "all") return rows;
    return rows.filter(
      (r) =>
        statusEnum(r.account.status as unknown as Record<string, unknown>) ===
        filter
    );
  }, [rows, filter]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      <div className="mb-8 flex items-end justify-between">
        <div className="flex flex-col gap-2">
          <h1 className="font-mono text-3xl font-bold tracking-tight">
            Auctions
          </h1>
          <p className="text-sm text-muted-foreground">
            All v0.1.1 auctions on the deployed program. Encrypted bids — only
            settled auctions reveal a clearing price.
          </p>
        </div>
        <div className="flex gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                filter === f.value
                  ? "border-foreground bg-foreground text-background"
                  : "border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {error && <FriendlyErrorBox error={error} />}
      {!error && filtered === null && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-44 animate-pulse rounded-lg border border-border bg-card/40"
            />
          ))}
        </div>
      )}
      {!error && filtered && filtered.length === 0 && (
        <div className="rounded-lg border border-dashed border-border p-12 text-center">
          <p className="font-mono text-sm text-muted-foreground">
            No auctions yet — be the first to{" "}
            <a href="/launch" className="text-foreground underline">
              launch one
            </a>
            .
          </p>
        </div>
      )}
      {!error && filtered && filtered.length > 0 && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((row) => (
            <AuctionCard key={row.publicKey.toBase58()} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}
