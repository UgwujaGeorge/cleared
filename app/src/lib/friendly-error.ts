// UI-only helper. Maps raw transaction / simulation errors to a friendlier
// shape for display. This does NOT change how transactions are sent or
// confirmed — it only controls how an error is rendered.

export type ErrorTone = "info" | "warn" | "error";

export type FriendlyError = {
  tone: ErrorTone;
  title: string;
  detail?: string;
  hint?: string;
  // Raw message kept for "show details" expanders so power users can still
  // see the underlying error without it being the primary UX.
  raw: string;
};

// Anchor errors thrown in cleared/programs/cleared/src/lib.rs. Codes match
// the IDL. We only display a softer label here; the underlying behavior is
// unchanged.
const ANCHOR_ERROR_LABELS: Record<string, FriendlyError> = {
  AbortedComputation: {
    tone: "warn",
    title: "MPC clearing was aborted",
    detail: "Arcium devnet sometimes drops a computation under load.",
    hint: "Wait a minute and retry — the auction state is preserved.",
    raw: "AbortedComputation",
  },
  ClusterNotSet: {
    tone: "error",
    title: "Arcium cluster is not configured",
    raw: "ClusterNotSet",
  },
  InvalidSupply: {
    tone: "error",
    title: "Total supply must be greater than zero",
    raw: "InvalidSupply",
  },
  InvalidSchedule: {
    tone: "error",
    title: "End time must be after start time",
    raw: "InvalidSchedule",
  },
  AuctionNotActive: {
    tone: "info",
    title: "Auction is still initializing",
    detail:
      "The encrypted bid book is being set up by the Arcium MPC. This usually takes 30–60 seconds.",
    hint: "Refresh the page in a moment and try again.",
    raw: "AuctionNotActive",
  },
  AuctionNotOpen: {
    tone: "info",
    title: "Auction has not opened yet",
    detail:
      "The bidding window starts at the auction's open time. Your transaction may still land if the simulation is slightly behind the cluster.",
    hint: "Check Profile in a moment to see whether the bid was accepted.",
    raw: "AuctionNotOpen",
  },
  AuctionClosed: {
    tone: "info",
    title: "Auction is already closed",
    raw: "AuctionClosed",
  },
  AuctionStillOpen: {
    tone: "info",
    title: "Auction is still accepting bids",
    detail: "It can only be settled after the close time.",
    raw: "AuctionStillOpen",
  },
  AuctionFull: {
    tone: "warn",
    title: "Auction is full",
    detail: "This auction has reached its bid cap.",
    raw: "AuctionFull",
  },
  ZeroDeposit: {
    tone: "error",
    title: "Bid must deposit more than zero lamports",
    raw: "ZeroDeposit",
  },
  AuctionNotSettled: {
    tone: "info",
    title: "Auction is not settled yet",
    hint: "Wait for the MPC clearing to finalize, then claim.",
    raw: "AuctionNotSettled",
  },
  BidAlreadyClaimed: {
    tone: "info",
    title: "This bid has already been claimed",
    raw: "BidAlreadyClaimed",
  },
  IssuerAlreadyClaimed: {
    tone: "info",
    title: "Proceeds have already been claimed",
    raw: "IssuerAlreadyClaimed",
  },
  WrongIssuer: {
    tone: "error",
    title: "Connected wallet is not the auction issuer",
    raw: "WrongIssuer",
  },
  WrongBidder: {
    tone: "error",
    title: "Connected wallet does not own this bid",
    raw: "WrongBidder",
  },
  InvalidBidderId: {
    tone: "error",
    title: "Bid record is out of range",
    raw: "InvalidBidderId",
  },
  NotWinner: {
    tone: "info",
    title: "This bid did not win an allocation",
    hint: "Use the refund button instead.",
    raw: "NotWinner",
  },
  NotLoser: {
    tone: "info",
    title: "This bid won an allocation",
    hint: "Use the claim-winner button instead.",
    raw: "NotLoser",
  },
  InsufficientDeposit: {
    tone: "error",
    title: "Deposit does not cover the clearing price × allocation",
    raw: "InsufficientDeposit",
  },
  InsufficientEscrow: {
    tone: "error",
    title: "Auction escrow is short of funds",
    raw: "InsufficientEscrow",
  },
  ArithmeticOverflow: {
    tone: "error",
    title: "Arithmetic overflow",
    raw: "ArithmeticOverflow",
  },
  WrongMint: {
    tone: "error",
    title: "Token mint does not match this auction",
    raw: "WrongMint",
  },
  WrongTokenOwner: {
    tone: "error",
    title: "Issuer token account is owned by a different wallet",
    raw: "WrongTokenOwner",
  },
  WrongTokenEscrow: {
    tone: "error",
    title: "Token escrow does not match this auction",
    raw: "WrongTokenEscrow",
  },
  WrongSolEscrow: {
    tone: "error",
    title: "SOL escrow does not match this auction",
    raw: "WrongSolEscrow",
  },
};

const WALLET_REJECTED_PATTERNS = [
  "User rejected",
  "User denied",
  "User cancelled",
  "Transaction cancelled",
  "Approval Denied",
  "rejected the request",
];

const BLOCKHASH_PATTERNS = [
  "Blockhash not found",
  "block height exceeded",
  "TransactionExpired",
];

// Heuristic: tx might still confirm on-chain despite a simulation error. We
// surface a "verify on profile / refresh" nudge in those cases. This is
// strictly UI guidance — we do not change how the tx was sent.
const POSSIBLY_CONFIRMED_NAMES = new Set([
  "AuctionNotOpen",
  "AuctionNotActive",
  "AuctionStillOpen",
  "AuctionClosed",
]);

export function toFriendlyError(input: unknown): FriendlyError {
  const raw =
    input instanceof Error ? input.message : typeof input === "string" ? input : String(input);

  // Wallet popup rejection — never a real failure, just a cancel.
  for (const p of WALLET_REJECTED_PATTERNS) {
    if (raw.includes(p)) {
      return {
        tone: "info",
        title: "Transaction was cancelled in your wallet",
        detail: "No funds were moved. You can retry whenever you're ready.",
        raw,
      };
    }
  }

  // Stale blockhash / network blip — usually harmless, retry works.
  for (const p of BLOCKHASH_PATTERNS) {
    if (raw.includes(p)) {
      return {
        tone: "warn",
        title: "Network was busy and the transaction expired",
        detail: "Devnet RPCs can drop a packet under load.",
        hint: "Retry — your previous attempt did not land.",
        raw,
      };
    }
  }

  // Anchor errors — match by name. The wallet adapter / Anchor stringifies as
  // `AnchorError caused by account: ... Error Code: <Name>. Error Number: <n>...`
  for (const name of Object.keys(ANCHOR_ERROR_LABELS)) {
    if (raw.includes(name)) {
      const base = ANCHOR_ERROR_LABELS[name];
      if (POSSIBLY_CONFIRMED_NAMES.has(name)) {
        return {
          ...base,
          hint:
            base.hint ??
            "Your transaction may still have landed — check Profile in a moment to verify.",
          raw,
        };
      }
      return { ...base, raw };
    }
  }

  // Common Arcium / Solana surface errors that aren't worth showing as a wall
  // of stack-trace text.
  if (/Simulation failed/i.test(raw)) {
    return {
      tone: "warn",
      title: "Transaction simulation failed",
      detail:
        "The cluster rejected this transaction during preflight. This is sometimes a stale-slot artefact on devnet.",
      hint: "Try again in a few seconds. If it persists, refresh the page.",
      raw,
    };
  }
  if (/insufficient funds/i.test(raw)) {
    return {
      tone: "error",
      title: "Wallet has insufficient SOL",
      detail: "Top up your devnet wallet and try again.",
      raw,
    };
  }
  if (/account not found/i.test(raw) || /AccountNotFound/i.test(raw)) {
    return {
      tone: "warn",
      title: "An expected account could not be found",
      detail: "This is often caused by an out-of-sync RPC.",
      hint: "Refresh the page and try again.",
      raw,
    };
  }

  // Fallback: keep the message but tone it down. Strip noisy prefixes.
  const trimmed = raw
    .replace(/^Error: /, "")
    .replace(/^AnchorError(: |\.)/, "")
    .replace(/^WalletSendTransactionError: /, "")
    .trim();

  return {
    tone: "error",
    title: "Something went wrong",
    detail: trimmed.length > 240 ? `${trimmed.slice(0, 240)}…` : trimmed,
    raw,
  };
}

export function toneClasses(tone: ErrorTone): string {
  switch (tone) {
    case "info":
      return "border-sky-500/40 bg-sky-500/10 text-sky-300";
    case "warn":
      return "border-amber-500/40 bg-amber-500/10 text-amber-300";
    case "error":
    default:
      return "border-red-500/40 bg-red-500/10 text-red-300";
  }
}
