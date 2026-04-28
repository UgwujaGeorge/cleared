// @ts-nocheck
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  getAccount as getTokenAccount,
} from "@solana/spl-token";
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
const ESCROW_AUTHORITY_SEED = Buffer.from("auction_authority");
const SOL_ESCROW_SEED = Buffer.from("sol_escrow");

type CircuitName = "init_bid_book" | "add_bid" | "compute_clearing";

function solscan(label: string, sig: string) {
  console.log(`  ${label}: ${sig}`);
  console.log(`    https://solscan.io/tx/${sig}?cluster=devnet`);
}

async function main() {
  const owner = readKpJson(WALLET_PATH);
  const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(owner), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);
  process.env.ARCIUM_CLUSTER_OFFSET ??= "456";

  const idl = JSON.parse(fs.readFileSync("target/idl/cleared.json", "utf8"));
  const program = new Program<Cleared>(idl, provider);
  const mxePublicKey = await getMXEPublicKeyWithRetry(provider, program.programId);

  console.log(`Program: ${program.programId.toBase58()}`);
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Issuer: ${owner.publicKey.toBase58()}`);

  // === Test mint: 100 tokens, 0 decimals, minted to issuer ===
  const totalSupply = 100n;
  const mint = await createMint(connection, owner, owner.publicKey, null, 0);
  console.log(`\nTest mint: ${mint.toBase58()}`);
  console.log(`  https://solscan.io/token/${mint.toBase58()}?cluster=devnet`);
  const issuerAta = await getOrCreateAssociatedTokenAccount(
    connection,
    owner,
    mint,
    owner.publicKey
  );
  await mintTo(connection, owner, mint, issuerAta.address, owner, Number(totalSupply));

  // === Auction PDAs ===
  const auctionId = new anchor.BN(randomBytes(8), "hex");
  const auctionIdLe = auctionId.toArrayLike(Buffer, "le", 8);
  const [auctionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("auction"), auctionIdLe],
    program.programId
  );
  const [escrowAuthority] = PublicKey.findProgramAddressSync(
    [ESCROW_AUTHORITY_SEED, auctionIdLe],
    program.programId
  );
  const [solEscrow] = PublicKey.findProgramAddressSync(
    [SOL_ESCROW_SEED, auctionIdLe],
    program.programId
  );
  const tokenEscrow = getAssociatedTokenAddressSync(mint, escrowAuthority, true);

  console.log(`\nAuction: ${auctionPda.toBase58()}`);
  console.log(`  https://solscan.io/account/${auctionPda.toBase58()}?cluster=devnet`);

  // === Scenario ===
  // Total supply: 100 tokens. Winner partial-wins; Loser fully loses.
  //   Winner: 200 @ 10 lamports -> wins 100 @ 10. deposit=2000, owed=1000, refund=1000.
  //   Loser:  50  @ 5  lamports -> loses (supply already exhausted by Winner).
  //   Issuer: receives 100 * 10 = 1000 lamports proceeds. Unsold = 0 tokens.
  // Conservation: 1000 (Winner refund) + 250 (Loser refund) + 1000 (proceeds) = 2250 = 2000 + 250 deposits.
  const winner = Keypair.generate();
  const loser = Keypair.generate();
  console.log(`\nWinner kp: ${winner.publicKey.toBase58()}`);
  console.log(`Loser  kp: ${loser.publicKey.toBase58()}`);

  // === create_auction ===
  const slot = await connection.getSlot("confirmed");
  const now = (await connection.getBlockTime(slot))!;
  const opensAt = new anchor.BN(now - 5);
  // Devnet MPC ~30-60s per round-trip; 1 init + 2 add_bid = ~180s; pad to 240s.
  const closesAt = new anchor.BN(now + 240);
  const createOffset = new anchor.BN(randomBytes(8), "hex");

  console.log("\n[1/7] create_auction (queues init_bid_book)");
  const createSig = await program.methods
    .createAuction(
      createOffset,
      auctionId,
      new anchor.BN(totalSupply.toString()),
      new anchor.BN(0),
      new anchor.BN(0),
      opensAt,
      closesAt
    )
    .accountsPartial({
      payer: owner.publicKey,
      issuer: owner.publicKey,
      auction: auctionPda,
      tokenMint: mint,
      issuerTokenAccount: issuerAta.address,
      escrowAuthority,
      tokenEscrow,
      solEscrow,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      ...arciumQueueAccounts(program.programId, createOffset, "init_bid_book"),
    })
    .signers([owner])
    .rpc({ skipPreflight: false, commitment: "confirmed" });
  solscan("create_auction tx", createSig);
  await awaitComputationFinalization(
    provider,
    createOffset,
    program.programId,
    "confirmed",
    600_000
  );
  console.log("  init_bid_book finalized");

  // Sanity: SPL moved into escrow
  const escrowAfterCreate = (await getTokenAccount(connection, tokenEscrow)).amount;
  if (escrowAfterCreate.toString() !== totalSupply.toString()) {
    throw new Error(`escrow expected ${totalSupply}, got ${escrowAfterCreate}`);
  }

  // === submit_bid (Winner, then Loser) ===
  const bids = [
    { kp: winner, label: "Winner", price: 10n, quantity: 200n },
    { kp: loser, label: "Loser", price: 5n, quantity: 50n },
  ];
  const bidRecords: { label: string; pda: PublicKey; kp: Keypair; price: bigint; quantity: bigint; maxSpend: bigint }[] = [];

  for (let i = 0; i < bids.length; i++) {
    const b = bids[i];
    const maxSpend = b.price * b.quantity;
    // Fund bidder from issuer instead of the faucet (1 SOL/day rate limit).
    const fundIx = anchor.web3.SystemProgram.transfer({
      fromPubkey: owner.publicKey,
      toPubkey: b.kp.publicKey,
      lamports: LAMPORTS_PER_SOL / 100,
    });
    const fundTx = new anchor.web3.Transaction().add(fundIx);
    const fundSig = await provider.sendAndConfirm(fundTx, [owner], {
      commitment: "confirmed",
    });
    void fundSig;

    const bidderPriv = x25519.utils.randomSecretKey();
    const bidderPub = x25519.getPublicKey(bidderPriv);
    const sharedSecret = x25519.getSharedSecret(bidderPriv, mxePublicKey);
    const cipher = new RescueCipher(sharedSecret);
    const nonce = randomBytes(16);
    const ct = cipher.encrypt([b.price, b.quantity], nonce);

    const [bidRecordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bid"), auctionIdLe, b.kp.publicKey.toBuffer()],
      program.programId
    );
    const submitOffset = new anchor.BN(randomBytes(8), "hex");

    console.log(
      `\n[${i + 2}/7] submit_bid ${b.label} (${b.quantity} @ ${b.price}, max_spend=${maxSpend})`
    );
    const sig = await program.methods
      .submitBid(
        submitOffset,
        Array.from(ct[0]),
        Array.from(ct[1]),
        Array.from(bidderPub),
        new anchor.BN(deserializeLE(nonce).toString()),
        new anchor.BN(maxSpend.toString())
      )
      .accountsPartial({
        payer: owner.publicKey,
        bidder: b.kp.publicKey,
        auction: auctionPda,
        bidRecord: bidRecordPda,
        solEscrow,
        ...arciumQueueAccounts(program.programId, submitOffset, "add_bid"),
      })
      .signers([owner, b.kp])
      .rpc({ skipPreflight: false, commitment: "confirmed" });
    solscan(`submit_bid ${b.label} tx`, sig);
    await awaitComputationFinalization(
      provider,
      submitOffset,
      program.programId,
      "confirmed",
      300_000
    );
    console.log(`  add_bid finalized for ${b.label}`);
    bidRecords.push({
      label: b.label,
      pda: bidRecordPda,
      kp: b.kp,
      price: b.price,
      quantity: b.quantity,
      maxSpend,
    });
  }

  // === Wait for closes_at (resilient to transient RPC socket drops) ===
  console.log(`\nWaiting for closes_at=${closesAt.toString()}...`);
  while (true) {
    try {
      const s = await connection.getSlot("confirmed");
      const t = await connection.getBlockTime(s);
      if (t !== null && t >= closesAt.toNumber() + 1) break;
    } catch (err) {
      console.log(
        `  poll failed (${(err as Error).message}); retrying in 5s`
      );
    }
    await new Promise((r) => setTimeout(r, 5000));
  }

  // === close_auction ===
  const closeOffset = new anchor.BN(randomBytes(8), "hex");
  console.log("\n[4/7] close_auction (queues compute_clearing)");
  const closeSig = await program.methods
    .closeAuction(closeOffset)
    .accountsPartial({
      payer: owner.publicKey,
      auction: auctionPda,
      ...arciumQueueAccounts(program.programId, closeOffset, "compute_clearing"),
    })
    .signers([owner])
    .rpc({ skipPreflight: false, commitment: "confirmed" });
  solscan("close_auction tx", closeSig);
  await awaitComputationFinalization(
    provider,
    closeOffset,
    program.programId,
    "confirmed",
    900_000
  );
  console.log("  compute_clearing finalized");

  const auction = await program.account.auction.fetch(auctionPda);
  const allocations = auction.allocations.map((a: anchor.BN) => a.toString());
  console.log(`\nSettled:`);
  console.log(`  clearing_price = ${auction.clearingPrice.toString()}`);
  console.log(`  total_sold     = ${auction.totalSold.toString()}`);
  console.log(`  allocations    = [${allocations.join(", ")}]`);
  if (auction.clearingPrice.toString() !== "10") {
    throw new Error(`expected clearing_price=10, got ${auction.clearingPrice}`);
  }
  if (auction.totalSold.toString() !== "100") {
    throw new Error(`expected total_sold=100, got ${auction.totalSold}`);
  }

  // === claim_winner ===
  const winnerCtx = bidRecords[0];
  const winnerAta = getAssociatedTokenAddressSync(mint, winnerCtx.kp.publicKey);
  console.log("\n[5/7] claim_winner");
  const claimWinSig = await program.methods
    .claimWinner()
    .accountsPartial({
      bidder: winnerCtx.kp.publicKey,
      auction: auctionPda,
      bidRecord: winnerCtx.pda,
      escrowAuthority,
      tokenEscrow,
      bidderTokenAccount: winnerAta,
      tokenMint: mint,
      solEscrow,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    })
    .signers([winnerCtx.kp])
    .rpc({ skipPreflight: false, commitment: "confirmed" });
  solscan("claim_winner tx", claimWinSig);
  const winnerTokenBal = (await getTokenAccount(connection, winnerAta)).amount;
  const winnerRecord = await program.account.bidRecord.fetch(winnerCtx.pda);
  console.log(
    `  Winner SPL=${winnerTokenBal} won_qty=${winnerRecord.wonQuantity} refund=${winnerRecord.refundAmount}`
  );
  if (winnerTokenBal.toString() !== "100") {
    throw new Error(`expected Winner SPL=100, got ${winnerTokenBal}`);
  }
  if (winnerRecord.refundAmount.toString() !== "1000") {
    throw new Error(
      `expected Winner refund=1000, got ${winnerRecord.refundAmount}`
    );
  }

  // === claim_loser ===
  const loserCtx = bidRecords[1];
  console.log("\n[6/7] claim_loser");
  const claimLoseSig = await program.methods
    .claimLoser()
    .accountsPartial({
      bidder: loserCtx.kp.publicKey,
      auction: auctionPda,
      bidRecord: loserCtx.pda,
      solEscrow,
    })
    .signers([loserCtx.kp])
    .rpc({ skipPreflight: false, commitment: "confirmed" });
  solscan("claim_loser tx", claimLoseSig);
  const loserRecord = await program.account.bidRecord.fetch(loserCtx.pda);
  console.log(`  Loser refund=${loserRecord.refundAmount}`);
  if (loserRecord.refundAmount.toString() !== "250") {
    throw new Error(
      `expected Loser refund=250, got ${loserRecord.refundAmount}`
    );
  }

  // === claim_issuer ===
  console.log("\n[7/7] claim_issuer");
  const claimIssuerSig = await program.methods
    .claimIssuer()
    .accountsPartial({
      issuer: owner.publicKey,
      auction: auctionPda,
      escrowAuthority,
      tokenEscrow,
      issuerTokenAccount: issuerAta.address,
      tokenMint: mint,
      solEscrow,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    })
    .signers([owner])
    .rpc({ skipPreflight: false, commitment: "confirmed" });
  solscan("claim_issuer tx", claimIssuerSig);
  const auctionAfter = await program.account.auction.fetch(auctionPda);
  if (!auctionAfter.issuerClaimed) {
    throw new Error(`expected issuer_claimed=true`);
  }
  const tokenEscrowFinal = (await getTokenAccount(connection, tokenEscrow)).amount;
  if (tokenEscrowFinal.toString() !== "0") {
    throw new Error(`expected token_escrow drained, got ${tokenEscrowFinal}`);
  }

  console.log("\n=== Devnet smoke complete ===");
  console.log(`Auction: https://solscan.io/account/${auctionPda.toBase58()}?cluster=devnet`);
  console.log(`Winner record: https://solscan.io/account/${winnerCtx.pda.toBase58()}?cluster=devnet`);
  console.log(`Loser record:  https://solscan.io/account/${loserCtx.pda.toBase58()}?cluster=devnet`);
  console.log(`Mint:          https://solscan.io/token/${mint.toBase58()}?cluster=devnet`);
}

function arciumQueueAccounts(programId: PublicKey, offset: anchor.BN, circuit: CircuitName) {
  const arciumEnv = getArciumEnv();
  return {
    computationAccount: getComputationAccAddress(arciumEnv.arciumClusterOffset, offset),
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

async function getMXEPublicKeyWithRetry(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  maxRetries = 40,
  retryDelayMs = 1500
): Promise<Uint8Array> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const pk = await getMXEPublicKey(provider, programId);
      if (pk) return pk;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, retryDelayMs));
  }
  throw new Error("Failed to fetch MXE public key");
}

function readKpJson(path: string): anchor.web3.Keypair {
  const file = fs.readFileSync(path);
  return anchor.web3.Keypair.fromSecretKey(new Uint8Array(JSON.parse(file.toString())));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
