"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BN } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MintLayout,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useProgram } from "@/lib/anchor";
import { arciumQueueAccounts } from "@/lib/arcium";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  deriveAuctionPda,
  deriveEscrowAuthorityPda,
  deriveSolEscrowPda,
} from "@/lib/pdas";
import { PROGRAM_ID } from "@/lib/constants";
import { solscanTx } from "@/lib/format";
import { CalendarIcon, Clock } from "lucide-react";
import { FriendlyErrorBox } from "@/components/friendly-error-box";

function randomBytes(len: number): Uint8Array {
  const out = new Uint8Array(len);
  crypto.getRandomValues(out);
  return out;
}

type Step = 1 | 2 | 3 | 4;

type Status =
  | { kind: "idle" }
  | { kind: "validating" }
  | { kind: "submitting" }
  | { kind: "done"; sig: string; auctionId: string }
  | { kind: "error"; msg: string };

export default function LaunchPage() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const program = useProgram();
  const router = useRouter();

  const [step, setStep] = useState<Step>(1);
  const [mint, setMint] = useState("");
  const [supply, setSupply] = useState("");
  const [minPrice, setMinPrice] = useState("0");
  const [maxBidPerWallet, setMaxBidPerWallet] = useState("0");
  const [opensAt, setOpensAt] = useState<Date | null>(null);
  const [closesAt, setClosesAt] = useState<Date | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const validateSchedule = (): string | null => {
    if (!opensAt) return "Choose an auction start time.";
    if (!closesAt) return "Choose an auction end time.";

    const opensAtMs = opensAt.getTime();
    const closesAtMs = closesAt.getTime();

    if (Number.isNaN(opensAtMs)) return "Choose a valid auction start time.";
    if (Number.isNaN(closesAtMs)) return "Choose a valid auction end time.";
    if (opensAtMs < Date.now()) return "Auction start time must be now or later.";
    if (closesAtMs <= opensAtMs) {
      return "Auction end time must be after the start time.";
    }

    return null;
  };

  const submit = async () => {
    if (!program || !wallet.publicKey) {
      setStatus({ kind: "error", msg: "Connect a wallet first." });
      return;
    }
    let mintPk: PublicKey;
    try {
      mintPk = new PublicKey(mint.trim());
    } catch {
      setStatus({ kind: "error", msg: "Invalid mint address." });
      return;
    }

    setStatus({ kind: "validating" });
    try {
      const mintConnection = process.env.NEXT_PUBLIC_RPC_URL
        ? new Connection(process.env.NEXT_PUBLIC_RPC_URL, "confirmed")
        : connection;
      const mintAccount = await mintConnection.getAccountInfo(mintPk);

      if (!mintAccount) {
        throw new Error("Mint account not found on devnet.");
      }
      if (!mintAccount.owner.equals(TOKEN_PROGRAM_ID)) {
        throw new Error("Account is not owned by the SPL Token program.");
      }
      if (mintAccount.data.length !== MintLayout.span) {
        throw new Error("Account data is not a valid SPL token mint.");
      }

      MintLayout.decode(mintAccount.data);
    } catch (err) {
      console.error("Mint lookup error:", err);
      setStatus({
        kind: "error",
        msg: `Mint lookup failed: ${(err as Error).message}`,
      });
      return;
    }

    const issuerAta = getAssociatedTokenAddressSync(mintPk, wallet.publicKey);

    let supplyBN: BN;
    let minPriceBN: BN;
    let maxBidBN: BN;
    let opensAtUnix: number;
    let closesAtUnix: number;
    try {
      supplyBN = new BN(supply.trim());
      minPriceBN = new BN(minPrice.trim() || "0");
      maxBidBN = new BN(maxBidPerWallet.trim() || "0");
      if (supplyBN.lten(0)) throw new Error("supply must be > 0");
      const scheduleError = validateSchedule();
      if (scheduleError) throw new Error(scheduleError);
      if (!opensAt || !closesAt) throw new Error("Choose auction times.");
      opensAtUnix = Math.floor(opensAt.getTime() / 1000);
      closesAtUnix = Math.floor(closesAt.getTime() / 1000);
    } catch (err) {
      setStatus({
        kind: "error",
        msg: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    setStatus({ kind: "submitting" });
    try {
      const auctionId = new BN(randomBytes(8), "hex");
      const [auctionPda] = deriveAuctionPda(auctionId);
      const [escrowAuthority] = deriveEscrowAuthorityPda(auctionId);
      const [solEscrow] = deriveSolEscrowPda(auctionId);
      const tokenEscrow = getAssociatedTokenAddressSync(
        mintPk,
        escrowAuthority,
        true
      );
      const computationOffset = new BN(randomBytes(8), "hex");

      const sig = await program.methods
        .createAuction(
          computationOffset,
          auctionId,
          supplyBN,
          minPriceBN,
          maxBidBN,
          new BN(opensAtUnix),
          new BN(closesAtUnix)
        )
        .accountsPartial({
          payer: wallet.publicKey,
          issuer: wallet.publicKey,
          auction: auctionPda,
          tokenMint: mintPk,
          issuerTokenAccount: issuerAta,
          escrowAuthority,
          tokenEscrow,
          solEscrow,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          ...arciumQueueAccounts(PROGRAM_ID, computationOffset, "init_bid_book"),
        })
        .rpc({ skipPreflight: false, commitment: "confirmed" });

      setStatus({ kind: "done", sig, auctionId: auctionId.toString() });
      // Auto-jump to detail page after a beat so users see the success state.
      setTimeout(() => router.push(`/auctions/${auctionId.toString()}`), 1500);
    } catch (err) {
      setStatus({
        kind: "error",
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-6 py-12">
      <header className="mb-6 flex flex-col gap-2">
        <h1 className="font-mono text-3xl font-bold tracking-tight">Launch</h1>
        <p className="text-sm text-muted-foreground">
          Create a uniform-price sealed-bid auction. Your SPL supply transfers
          into a per-auction escrow on submit.
        </p>
      </header>

      <Stepper step={step} />

      <div className="mt-6 rounded-lg border border-border bg-card p-6">
        {step === 1 && (
          <StepBlock
            title="1 / 4 — Token mint"
            body="Paste the SPL mint address you want to auction. Your wallet must hold the supply."
          >
            <Field
              label="Token mint address"
              value={mint}
              onChange={setMint}
              placeholder="e.g. EPjFWdd…HJUR (USDC) or your test mint"
            />
            <NavRow
              onNext={() => mint.length > 30 && setStep(2)}
              nextDisabled={mint.length < 30}
            />
          </StepBlock>
        )}
        {step === 2 && (
          <StepBlock
            title="2 / 4 — Sale parameters"
            body="Total supply transferred into escrow. Min price floors the clearing price; max bid per wallet caps individual demand."
          >
            <Field
              label="Total supply (tokens)"
              value={supply}
              onChange={setSupply}
              placeholder="e.g. 1000"
            />
            <Field
              label="Min price (lamports per token)"
              value={minPrice}
              onChange={setMinPrice}
              placeholder="0 = no floor"
            />
            <Field
              label="Max bid per wallet (tokens)"
              value={maxBidPerWallet}
              onChange={setMaxBidPerWallet}
              placeholder="0 = no cap"
            />
            <NavRow
              onPrev={() => setStep(1)}
              onNext={() => supply.trim() !== "" && setStep(3)}
              nextDisabled={supply.trim() === ""}
            />
          </StepBlock>
        )}
        {step === 3 && (
          <StepBlock
            title="3 / 4 — Schedule"
            body="Times are interpreted in your local timezone. Bidders can submit between opens_at and closes_at."
          >
            <DateField label="Opens at" value={opensAt} onChange={setOpensAt} />
            <DateField
              label="Closes at"
              value={closesAt}
              onChange={setClosesAt}
            />
            {validateSchedule() && (
              <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-400">
                {validateSchedule()}
              </div>
            )}
            <NavRow
              onPrev={() => setStep(2)}
              onNext={() => !validateSchedule() && setStep(4)}
              nextDisabled={Boolean(validateSchedule())}
            />
          </StepBlock>
        )}
        {step === 4 && (
          <StepBlock
            title="4 / 4 — Review and submit"
            body="Submitting transfers the SPL supply into escrow. The init_bid_book MPC kicks off automatically."
          >
            <Review label="Mint" value={mint} mono />
            <Review label="Supply" value={supply} mono />
            <Review label="Min price" value={`${minPrice} lamports`} mono />
            <Review
              label="Max bid per wallet"
              value={maxBidPerWallet === "0" ? "no cap" : maxBidPerWallet}
              mono
            />
            <Review label="Opens at" value={formatDateTime(opensAt)} />
            <Review label="Closes at" value={formatDateTime(closesAt)} />
            <button
              onClick={submit}
              disabled={
                !wallet.publicKey ||
                status.kind === "submitting" ||
                status.kind === "validating"
              }
              className="mt-2 w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {!wallet.publicKey
                ? "Connect a wallet to launch"
                : status.kind === "validating"
                ? "Validating mint…"
                : status.kind === "submitting"
                ? "Submitting…"
                : "Create auction"}
            </button>
            {status.kind === "done" && (
              <div className="mt-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs">
                <div className="flex items-center gap-2">
                  <span className="inline-block size-1.5 rounded-full bg-emerald-400" />
                  <p className="text-emerald-300">
                    Auction created. Redirecting to detail page…
                  </p>
                </div>
                <a
                  href={solscanTx(status.sig)}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 block font-mono text-[10px] text-emerald-300/90 underline"
                >
                  View on Solscan: {status.sig.slice(0, 24)}…
                </a>
              </div>
            )}
            {status.kind === "error" && (
              <div className="mt-2">
                <FriendlyErrorBox error={status.msg} />
              </div>
            )}
            <button
              onClick={() => setStep(3)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              ← Back
            </button>
          </StepBlock>
        )}
      </div>
    </div>
  );
}

function Stepper({ step }: { step: Step }) {
  return (
    <div className="flex items-center gap-2">
      {[1, 2, 3, 4].map((n) => (
        <div
          key={n}
          className={`h-1 flex-1 rounded-full ${
            n <= step ? "bg-foreground" : "bg-border"
          }`}
        />
      ))}
    </div>
  );
}

function StepBlock({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="font-mono text-sm font-semibold">{title}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{body}</p>
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-muted-foreground">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="rounded-md border border-input bg-background px-3 py-2 font-mono text-sm focus:border-foreground/40 focus:outline-none"
      />
    </div>
  );
}

function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Date | null;
  onChange: (v: Date) => void;
}) {
  const selectedTime = value
    ? formatTimeValue(value)
    : formatTimeValue(roundToNearestFiveMinutes(new Date()));

  const setDate = (date: Date) => {
    const timeSource = value ?? roundToNearestFiveMinutes(new Date());
    const next = new Date(date);
    next.setHours(timeSource.getHours(), timeSource.getMinutes(), 0, 0);
    onChange(next);
  };

  const setTime = (time: string) => {
    const [hours, minutes] = time.split(":").map(Number);
    if (Number.isNaN(hours) || Number.isNaN(minutes)) return;

    const next = new Date(value ?? roundToNearestFiveMinutes(new Date()));
    next.setHours(hours, minutes, 0, 0);
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-muted-foreground">{label}</label>
      <Popover>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="outline"
              className="h-10 w-full justify-start gap-2 px-3 font-mono"
            />
          }
        >
          <CalendarIcon className="size-4" />
          <span className={value ? "" : "text-muted-foreground"}>
            {value ? formatDateTime(value) : "Pick date & time"}
          </span>
        </PopoverTrigger>
        <PopoverContent className="w-auto">
          <Calendar
            selected={value}
            onSelect={setDate}
            disabled={(date) => date < startOfToday()}
          />
          <div className="mt-4 flex items-center gap-2 border-t border-border pt-4">
            <Clock className="size-4 text-muted-foreground" />
            <Input
              type="time"
              step={300}
              value={selectedTime}
              onChange={(e) => setTime(e.target.value)}
              className="font-mono"
            />
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function Review({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/40 py-2 last:border-b-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={`text-sm ${mono ? "font-mono" : ""} truncate text-right`}
        title={value}
      >
        {value || "—"}
      </span>
    </div>
  );
}

function roundToNearestFiveMinutes(date: Date) {
  const fiveMinutesMs = 5 * 60 * 1000;
  return new Date(Math.ceil(date.getTime() / fiveMinutesMs) * fiveMinutesMs);
}

function startOfToday() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

function formatTimeValue(date: Date) {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDateTime(date: Date | null) {
  if (!date) return "";

  return `${date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })} — ${formatTimeValue(date)}`;
}

function NavRow({
  onPrev,
  onNext,
  nextDisabled,
}: {
  onPrev?: () => void;
  onNext: () => void;
  nextDisabled?: boolean;
}) {
  return (
    <div className="mt-2 flex items-center justify-between">
      {onPrev ? (
        <button
          onClick={onPrev}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          ← Back
        </button>
      ) : (
        <span />
      )}
      <button
        onClick={onNext}
        disabled={nextDisabled}
        className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Next →
      </button>
    </div>
  );
}
