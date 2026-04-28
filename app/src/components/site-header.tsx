import Link from "next/link";
import { WalletButton } from "./wallet-button";
import { NETWORK_LABEL } from "@/lib/constants";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-border/60 bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
        <div className="flex items-center gap-6">
          <Link
            href="/"
            className="font-mono text-sm font-semibold tracking-tight"
          >
            CLEARED
          </Link>
          <nav className="hidden gap-5 text-sm text-muted-foreground sm:flex">
            <Link href="/auctions" className="hover:text-foreground">
              Auctions
            </Link>
            <Link href="/launch" className="hover:text-foreground">
              Launch
            </Link>
            <Link href="/profile" className="hover:text-foreground">
              Profile
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wider text-emerald-400">
            {NETWORK_LABEL}
          </span>
          <WalletButton />
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-border/60 py-6">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-6 text-xs text-muted-foreground sm:flex-row">
        <span className="font-mono">POWERED BY ARCIUM + SOLANA</span>
        <div className="flex gap-5">
          <a
            href="https://github.com/UgwujaGeorge/cleared"
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground"
          >
            GitHub
          </a>
          <a
            href="https://docs.arcium.com"
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground"
          >
            Arcium
          </a>
          <a
            href="https://solana.com"
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground"
          >
            Solana
          </a>
        </div>
      </div>
    </footer>
  );
}
