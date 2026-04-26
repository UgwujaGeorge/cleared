// @ts-nocheck
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import {
  awaitComputationFinalization,
  deserializeLE,
  getArciumEnv,
  getClockAccAddress,
  getComputationAccAddress,
  getClusterAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getExecutingPoolAccAddress,
  getFeePoolAccAddress,
  getMempoolAccAddress,
  getMXEAccAddress,
  getMXEPublicKey,
  RescueCipher,
  x25519,
} from "@arcium-hq/client";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import { Cleared } from "../target/types/cleared";

const RPC_URL =
  process.env.ANCHOR_PROVIDER_URL ??
  "https://devnet.helius-rpc.com/?api-key=5d469c0b-25bd-4d73-a8e5-67c69c7318e2";
const WALLET_PATH =
  process.env.ANCHOR_WALLET ?? `${os.homedir()}/.config/solana/id.json`;
const CIRCUIT_NAMES = ["init_bid_book", "add_bid", "compute_clearing"] as const;
type CircuitName = (typeof CIRCUIT_NAMES)[number];
type Bid = { name: string; price: bigint; quantity: bigint };

async function main() {
  const owner = readKpJson(WALLET_PATH);
  const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(owner),
    { commitment: "confirmed", preflightCommitment: "confirmed" }
  );
  anchor.setProvider(provider);
  process.env.ARCIUM_CLUSTER_OFFSET ??= "456";

  const idl = JSON.parse(fs.readFileSync("target/idl/cleared.json", "utf8"));
  const program = new Program<Cleared>(idl, provider);
  const mxePublicKey = await getMXEPublicKeyWithRetry(
    provider,
    program.programId
  );

  console.log(`Program: ${program.programId.toBase58()}`);
  console.log(`RPC: ${RPC_URL}`);

  const single = await runAuction(provider, program, owner, mxePublicKey, {
    label: "single-bid",
    totalSupply: 100n,
    bids: [{ name: "Solo", price: 10n, quantity: 100n }],
    expected: {
      clearingPrice: 10,
      totalSold: 100,
      allocations: [100, 0, 0],
    },
  });
  console.log(`single-bid settlement: ${single}`);

  const canonical = await runAuction(provider, program, owner, mxePublicKey, {
    label: "canonical-3-bid",
    totalSupply: 1000n,
    bids: [
      { name: "Alice", price: 10n, quantity: 500n },
      { name: "Bob", price: 8n, quantity: 300n },
      { name: "Carol", price: 7n, quantity: 400n },
    ],
    expected: {
      clearingPrice: 7,
      totalSold: 1000,
      allocations: [500, 300, 200],
    },
  });
  console.log(`canonical settlement: ${canonical}`);
  console.log(
    `canonical Solscan: https://solscan.io/tx/${canonical}?cluster=devnet`
  );
}

async function runAuction(
  provider: anchor.AnchorProvider,
  program: Program<Cleared>,
  owner: anchor.web3.Keypair,
  mxePublicKey: Uint8Array,
  scenario: {
    label: string;
    totalSupply: bigint;
    bids: Bid[];
    expected: {
      clearingPrice: number;
      totalSold: number;
      allocations: number[];
    };
  }
): Promise<string> {
  const auctionId = new anchor.BN(randomBytes(8), "hex");
  const [auctionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("auction"), auctionId.toArrayLike(Buffer, "le", 8)],
    program.programId
  );
  const now = await validatorNow(provider);
  const opensAt = new anchor.BN(now - 5);
  const closesAt = new anchor.BN(now + 75);
  const createOffset = new anchor.BN(randomBytes(8), "hex");

  console.log(`[${scenario.label}] create auction ${auctionPda.toBase58()}`);
  await program.methods
    .createAuction(
      createOffset,
      auctionId,
      new anchor.BN(scenario.totalSupply.toString()),
      new anchor.BN(0),
      new anchor.BN(0),
      opensAt,
      closesAt
    )
    .accountsPartial({
      payer: owner.publicKey,
      issuer: owner.publicKey,
      auction: auctionPda,
      ...arciumQueueAccounts(program.programId, createOffset, "init_bid_book"),
    })
    .signers([owner])
    .rpc({ skipPreflight: false, commitment: "confirmed" });
  await awaitComputationFinalization(
    provider,
    createOffset,
    program.programId,
    "confirmed"
  );

  for (let i = 0; i < scenario.bids.length; i++) {
    const bid = scenario.bids[i];
    const bidder = Keypair.generate();
    const bidderPriv = x25519.utils.randomSecretKey();
    const bidderPub = x25519.getPublicKey(bidderPriv);
    const sharedSecret = x25519.getSharedSecret(bidderPriv, mxePublicKey);
    const cipher = new RescueCipher(sharedSecret);
    const nonce = randomBytes(16);
    const ct = cipher.encrypt([bid.price, bid.quantity], nonce);
    const [bidRecordPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("bid"),
        auctionId.toArrayLike(Buffer, "le", 8),
        bidder.publicKey.toBuffer(),
      ],
      program.programId
    );
    const submitOffset = new anchor.BN(randomBytes(8), "hex");
    console.log(`[${scenario.label}] submit ${bid.name}`);
    await program.methods
      .submitBid(
        submitOffset,
        Array.from(ct[0]),
        Array.from(ct[1]),
        Array.from(bidderPub),
        new anchor.BN(deserializeLE(nonce).toString())
      )
      .accountsPartial({
        payer: owner.publicKey,
        bidder: bidder.publicKey,
        auction: auctionPda,
        bidRecord: bidRecordPda,
        ...arciumQueueAccounts(program.programId, submitOffset, "add_bid"),
      })
      .signers([owner, bidder])
      .rpc({ skipPreflight: false, commitment: "confirmed" });
    await awaitComputationFinalization(
      provider,
      submitOffset,
      program.programId,
      "confirmed"
    );
  }

  while ((await validatorNow(provider)) < closesAt.toNumber() + 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  const closeOffset = new anchor.BN(randomBytes(8), "hex");
  console.log(`[${scenario.label}] close auction`);
  await program.methods
    .closeAuction(closeOffset)
    .accountsPartial({
      payer: owner.publicKey,
      auction: auctionPda,
      ...arciumQueueAccounts(
        program.programId,
        closeOffset,
        "compute_clearing"
      ),
    })
    .signers([owner])
    .rpc({ skipPreflight: false, commitment: "confirmed" });
  const settlementSig = (await awaitComputationFinalization(
    provider,
    closeOffset,
    program.programId,
    "confirmed"
  )) as string;

  const auction = await program.account.auction.fetch(auctionPda);
  const allocations = auction.allocations.map((value) => value.toNumber());
  console.log(
    `[${
      scenario.label
    }] settled price=${auction.clearingPrice.toString()} sold=${auction.totalSold.toString()} allocations=[${allocations.join(
      ", "
    )}]`
  );
  assertEq(auction.clearingPrice.toNumber(), scenario.expected.clearingPrice);
  assertEq(auction.totalSold.toNumber(), scenario.expected.totalSold);
  for (let i = 0; i < scenario.expected.allocations.length; i++) {
    assertEq(allocations[i], scenario.expected.allocations[i]);
  }
  return settlementSig;
}

function arciumQueueAccounts(
  programId: PublicKey,
  offset: anchor.BN,
  circuit: CircuitName
) {
  const arciumEnv = getArciumEnv();
  return {
    computationAccount: getComputationAccAddress(
      arciumEnv.arciumClusterOffset,
      offset
    ),
    clusterAccount: getClusterAccAddress(arciumEnv.arciumClusterOffset),
    mxeAccount: getMXEAccAddress(programId),
    mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
    executingPool: getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
    compDefAccount: getCompDefAccAddress(
      programId,
      Buffer.from(getCompDefAccOffset(circuit)).readUInt32LE()
    ),
    poolAccount: getFeePoolAccAddress(),
    clockAccount: getClockAccAddress(),
  };
}

async function validatorNow(provider: anchor.AnchorProvider): Promise<number> {
  const slot = await provider.connection.getSlot("confirmed");
  const time = await provider.connection.getBlockTime(slot);
  if (time === null) throw new Error("Failed to read validator clock");
  return time;
}

async function getMXEPublicKeyWithRetry(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  maxRetries = 40,
  retryDelayMs = 1500
): Promise<Uint8Array> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const mxePublicKey = await getMXEPublicKey(provider, programId);
      if (mxePublicKey) return mxePublicKey;
    } catch (_) {
      // retry
    }
    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  throw new Error("Failed to fetch MXE public key");
}

function assertEq(actual: number, expected: number) {
  if (actual !== expected) {
    throw new Error(`Assertion failed: expected ${expected}, got ${actual}`);
  }
}

function readKpJson(path: string): anchor.web3.Keypair {
  const file = fs.readFileSync(path);
  return anchor.web3.Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(file.toString()))
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
