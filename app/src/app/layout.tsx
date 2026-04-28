import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { cn } from "@/lib/utils";
import { ClearedWalletProvider } from "@/components/wallet-provider";
import { SiteHeader, SiteFooter } from "@/components/site-header";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "Cleared — Encrypted token launch auctions",
  description:
    "Fair-launch SPL token auctions on Solana, encrypted end-to-end via Arcium MPC.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={cn("dark", geistSans.variable, geistMono.variable)}
      suppressHydrationWarning
    >
      <body className="bg-background font-sans text-foreground antialiased">

        <ClearedWalletProvider>
          <div className="flex min-h-screen flex-col">
            <SiteHeader />
            <main className="flex-1">{children}</main>
            <SiteFooter />
          </div>
        </ClearedWalletProvider>
      </body>
    </html>
  );
}
