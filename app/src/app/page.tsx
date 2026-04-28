import Link from "next/link";

export default function HomePage() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-24 px-6 py-20">
      <section className="flex flex-col gap-6">
        <span className="font-mono text-xs tracking-widest text-emerald-400">
          UNIFORM-PRICE SEALED-BID — DEVNET
        </span>
        <h1 className="font-mono text-5xl font-bold tracking-tight md:text-6xl">
          Fair-launch token auctions,
          <br />
          encrypted end-to-end.
        </h1>
        <p className="max-w-2xl text-lg text-muted-foreground">
          Cleared lets Solana projects launch their tokens through encrypted
          uniform-price sealed-bid auctions. Bids stay private through Arcium
          MPC; every winner pays the same clearing price.
        </p>
        <div className="mt-2 flex flex-wrap gap-3">
          <Link
            href="/launch"
            className="rounded-md bg-primary px-5 py-2.5 font-medium text-primary-foreground transition hover:opacity-90"
          >
            Launch a token
          </Link>
          <Link
            href="/auctions"
            className="rounded-md border border-border px-5 py-2.5 font-medium hover:bg-accent"
          >
            Browse auctions
          </Link>
        </div>
      </section>

      <section className="flex flex-col gap-8">
        <h2 className="font-mono text-2xl font-semibold tracking-tight">
          How it works
        </h2>
        <div className="grid gap-6 md:grid-cols-3">
          <Step
            n="01"
            title="Issuer creates an auction"
            body="Deposit the SPL supply into a per-auction escrow. Set min price, max bid per wallet, and a closing time."
          />
          <Step
            n="02"
            title="Bidders submit encrypted bids"
            body="Each (price, quantity) is encrypted client-side via x25519 + RescueCipher, then accumulated by Arcium MPC. No one sees a bid until settlement."
          />
          <Step
            n="03"
            title="MPC settles a uniform price"
            body="At close, the MPC sorts bids and reveals the clearing price. Winners pull tokens + SOL refund; losers pull a full refund; the issuer pulls proceeds."
          />
        </div>
      </section>

      <section className="flex flex-col gap-4 rounded-lg border border-border bg-card p-6">
        <h2 className="font-mono text-lg font-semibold">Why uniform-price?</h2>
        <p className="text-sm text-muted-foreground">
          The same mechanism the U.S. Treasury uses for bond auctions. Bidders
          can&apos;t be sniped or front-run, and the issuer captures the true
          market clearing price — not what the most aggressive bidder paid.
        </p>
      </section>
    </div>
  );
}

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-5">
      <span className="font-mono text-xs text-muted-foreground">{n}</span>
      <h3 className="font-semibold">{title}</h3>
      <p className="text-sm text-muted-foreground">{body}</p>
    </div>
  );
}
