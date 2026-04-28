"use client";

import dynamic from "next/dynamic";

// WalletMultiButton injects styles + uses window APIs — load it client-only to
// dodge Next's SSR hydration mismatch warnings.
export const WalletButton = dynamic(
  async () =>
    (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false }
);
