import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

export function shortAddr(pk: PublicKey | string): string {
  const s = typeof pk === "string" ? pk : pk.toBase58();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

export function shortAuctionId(id: BN): string {
  const hex = id.toString(16).padStart(16, "0");
  return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

export function formatLamports(amount: BN | bigint | number): string {
  const n = typeof amount === "bigint" ? amount : BigInt(amount.toString());
  // Show small numbers as raw lamports; otherwise abbreviate to SOL with 3
  // decimals. Cleared's MPC math uses raw u64s so amounts are typically tiny in
  // localnet/devnet smokes.
  const oneMillion = BigInt(1_000_000);
  if (n < oneMillion) return `${n.toString()} lamports`;
  const sol = Number(n) / 1_000_000_000;
  return `${sol.toFixed(3)} SOL`;
}

export function statusLabel(status: Record<string, unknown>): string {
  return Object.keys(status)[0] ?? "unknown";
}

export type AuctionStatus =
  | "initializing"
  | "active"
  | "closing"
  | "settled"
  | "failed";

export function statusEnum(status: Record<string, unknown>): AuctionStatus {
  const k = Object.keys(status)[0];
  if (k === "initializing") return "initializing";
  if (k === "active") return "active";
  if (k === "closing") return "closing";
  if (k === "settled") return "settled";
  if (k === "failed") return "failed";
  return "initializing";
}

export function statusBadgeClasses(status: AuctionStatus): string {
  switch (status) {
    case "active":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-400";
    case "closing":
      return "border-amber-500/40 bg-amber-500/10 text-amber-400";
    case "settled":
      return "border-sky-500/40 bg-sky-500/10 text-sky-400";
    case "failed":
      return "border-red-500/40 bg-red-500/10 text-red-400";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

export function solscanAccount(addr: string): string {
  return `https://solscan.io/account/${addr}?cluster=devnet`;
}

export function solscanTx(sig: string): string {
  return `https://solscan.io/tx/${sig}?cluster=devnet`;
}

export function solscanToken(mint: string): string {
  return `https://solscan.io/token/${mint}?cluster=devnet`;
}
