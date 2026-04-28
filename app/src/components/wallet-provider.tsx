"use client";

import {
  ConnectionProvider as RawConnectionProvider,
  WalletProvider as RawWalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider as RawWalletModalProvider } from "@solana/wallet-adapter-react-ui";
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
} from "@solana/wallet-adapter-wallets";
import { ComponentType, useMemo } from "react";
import { RPC_URL } from "@/lib/constants";

import "@solana/wallet-adapter-react-ui/styles.css";

// React 18 / wallet-adapter React typings don't reconcile cleanly because
// adapter FCs predate the ReactNode -> ReactNode | Promise<ReactNode> change.
// Re-cast to ComponentType<any> at the JSX boundary; runtime is unaffected.
const ConnectionProvider = RawConnectionProvider as unknown as ComponentType<{
  endpoint: string;
  children: React.ReactNode;
}>;
const WalletProvider = RawWalletProvider as unknown as ComponentType<{
  wallets: unknown[];
  autoConnect?: boolean;
  children: React.ReactNode;
}>;
const WalletModalProvider = RawWalletModalProvider as unknown as ComponentType<{
  children: React.ReactNode;
}>;

export function ClearedWalletProvider({ children }: { children: React.ReactNode }) {
  // Phantom + Solflare cover ~95% of Solana wallet share. Backpack registers
  // itself via the Wallet Standard so it's auto-detected — no adapter required.
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    []
  );

  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
