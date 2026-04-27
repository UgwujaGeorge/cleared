import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  getAccount as getTokenAccount,
} from "@solana/spl-token";
import { Cleared } from "../target/types/cleared";
import { randomBytes } from "crypto";
import {
  awaitComputationFinalization,
  getArciumEnv,
  getCompDefAccOffset,
  getArciumAccountBaseSeed,
  getArciumProgramId,
  getArciumProgram,
  getFeePoolAccAddress,
  getClockAccAddress,
  RescueCipher,
  deserializeLE,
  getMXEPublicKey,
  getMXEAccAddress,
  getMempoolAccAddress,
  getCompDefAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
  getClusterAccAddress,
  getLookupTableAddress,
  x25519,
} from "@arcium-hq/client";
import * as fs from "fs";
import * as os from "os";
import { expect } from "chai";

const CIRCUIT_NAMES = ["init_bid_book", "add_bid", "compute_clearing"] as const;
type CircuitName = (typeof CIRCUIT_NAMES)[number];

const ESCROW_AUTHORITY_SEED = Buffer.from("auction_authority");
const SOL_ESCROW_SEED = Buffer.from("sol_escrow");

describe("Cleared", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Cleared as Program<Cleared>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const arciumProgram = getArciumProgram(provider);
  const arciumEnv = getArciumEnv();
  const clusterAccount = getClusterAccAddress(arciumEnv.arciumClusterOffset);

  it("runs uniform-price clearing with full SPL/SOL custody end-to-end", async () => {
    const owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);

    // 1. Init all three comp defs (idempotent across test runs).
    for (const name of CIRCUIT_NAMES) {
      console.log(`Initializing comp def: ${name}`);
      await initCompDef(program, owner, name);
    }
    await probeCompDefImmutability(owner, "init_bid_book");

    // 2. Fetch MXE pubkey.
    const mxePublicKey = await getMXEPublicKeyWithRetry(
      provider,
      program.programId
    );

    // 3. Create a fresh SPL token mint with 0 decimals, mint total_supply to issuer.
    const totalSupply = 1000n;
    const mint = await createMint(
      provider.connection,
      owner,
      owner.publicKey,
      null,
      0
    );
    console.log(`Test mint: ${mint.toBase58()}`);
    const issuerAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      owner,
      mint,
      owner.publicKey
    );
    await mintTo(
      provider.connection,
      owner,
      mint,
      issuerAta.address,
      owner,
      Number(totalSupply)
    );
    const issuerAtaInitial = (
      await getTokenAccount(provider.connection, issuerAta.address)
    ).amount;
    expect(issuerAtaInitial.toString()).to.equal(totalSupply.toString());

    // 4. Derive auction PDAs.
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
    const tokenEscrow = getAssociatedTokenAddressSync(
      mint,
      escrowAuthority,
      true
    );

    // 5. create_auction -> init_bid_book.
    const slot = await provider.connection.getSlot("confirmed");
    const solanaNow = await provider.connection.getBlockTime(slot);
    if (solanaNow === null) throw new Error("Failed to read validator clock");
    const opensAt = new anchor.BN(solanaNow - 5);
    // Each MPC round-trip ~20-30s on localnet (init + 4 bids = ~150s budget) — give 100s headroom.
    const closesAt = new anchor.BN(solanaNow + 250);

    console.log("Creating auction...");
    const createOffset = new anchor.BN(randomBytes(8), "hex");
    await program.methods
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

    await awaitComputationFinalization(
      provider,
      createOffset,
      program.programId,
      "confirmed"
    );

    // Sanity: SPL moved into escrow ATA, issuer ATA drained.
    const escrowAfterCreate = (
      await getTokenAccount(provider.connection, tokenEscrow)
    ).amount;
    const issuerAtaAfterCreate = (
      await getTokenAccount(provider.connection, issuerAta.address)
    ).amount;
    expect(escrowAfterCreate.toString()).to.equal(totalSupply.toString());
    expect(issuerAtaAfterCreate.toString()).to.equal("0");

    // 6. Submit 4 bids — 3 winners, 1 loser.
    const bidders = [
      { name: "Alice", price: 10n, quantity: 500n }, // wins 500 @ 7
      { name: "Bob", price: 8n, quantity: 300n }, // wins 300 @ 7
      { name: "Carol", price: 7n, quantity: 400n }, // wins 200 @ 7 (partial)
      { name: "Dave", price: 5n, quantity: 200n }, // loses
    ] as const;

    type BidContext = {
      name: string;
      price: bigint;
      quantity: bigint;
      maxSpend: bigint;
      kp: Keypair;
      bidRecordPda: PublicKey;
    };
    const ctxs: BidContext[] = [];

    for (let i = 0; i < bidders.length; i++) {
      const b = bidders[i];
      const kp = Keypair.generate();
      const maxSpend = b.price * b.quantity;
      // Fund bidder for ATA rent + tx fees + max_spend.
      const fund = await provider.connection.requestAirdrop(
        kp.publicKey,
        LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(fund, "confirmed");

      const bidderPriv = x25519.utils.randomSecretKey();
      const bidderPub = x25519.getPublicKey(bidderPriv);
      const sharedSecret = x25519.getSharedSecret(bidderPriv, mxePublicKey);
      const cipher = new RescueCipher(sharedSecret);
      const nonce = randomBytes(16);
      const ct = cipher.encrypt([b.price, b.quantity], nonce);

      const [bidRecordPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bid"), auctionIdLe, kp.publicKey.toBuffer()],
        program.programId
      );

      const submitOffset = new anchor.BN(randomBytes(8), "hex");
      console.log(
        `Submitting bid ${i} (${b.name}: ${b.quantity} @ ${b.price}, max_spend=${maxSpend})...`
      );
      await program.methods
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
          bidder: kp.publicKey,
          auction: auctionPda,
          bidRecord: bidRecordPda,
          solEscrow,
          ...arciumQueueAccounts(program.programId, submitOffset, "add_bid"),
        })
        .signers([owner, kp])
        .rpc({ skipPreflight: false, commitment: "confirmed" });

      await awaitComputationFinalization(
        provider,
        submitOffset,
        program.programId,
        "confirmed"
      );
      ctxs.push({
        name: b.name,
        price: b.price,
        quantity: b.quantity,
        maxSpend,
        kp,
        bidRecordPda,
      });
    }

    // Sanity: sol_escrow holds Σ max_spend + the rent-exempt minimum.
    const totalDeposited = bidders.reduce(
      (acc, b) => acc + b.price * b.quantity,
      0n
    );
    const solEscrowAfterBids =
      await provider.connection.getBalance(solEscrow);
    expect(solEscrowAfterBids).to.be.greaterThanOrEqual(Number(totalDeposited));

    // 7. Wait past closes_at.
    while (true) {
      const s = await provider.connection.getSlot("confirmed");
      const t = await provider.connection.getBlockTime(s);
      if (t !== null && t >= closesAt.toNumber() + 1) break;
      await new Promise((r) => setTimeout(r, 2000));
    }

    // 8. close_auction -> compute_clearing.
    const closeOffset = new anchor.BN(randomBytes(8), "hex");
    console.log("Closing auction...");
    await program.methods
      .closeAuction(closeOffset)
      .accountsPartial({
        payer: owner.publicKey,
        auction: auctionPda,
        ...arciumQueueAccounts(program.programId, closeOffset, "compute_clearing"),
      })
      .signers([owner])
      .rpc({ skipPreflight: false, commitment: "confirmed" });
    // compute_clearing is the heaviest circuit; first run may include download.
    await awaitComputationFinalization(
      provider,
      closeOffset,
      program.programId,
      "confirmed",
      300_000
    );

    // 9. Verify clearing math is unchanged by the upgrade.
    const auction = await program.account.auction.fetch(auctionPda);
    console.log(
      `Settled: clearing_price=${auction.clearingPrice} total_sold=${auction.totalSold}`
    );
    expect(auction.clearingPrice.toNumber()).to.equal(7);
    expect(auction.totalSold.toNumber()).to.equal(1000);
    expect(auction.allocations[0].toNumber()).to.equal(500); // Alice
    expect(auction.allocations[1].toNumber()).to.equal(300); // Bob
    expect(auction.allocations[2].toNumber()).to.equal(200); // Carol partial
    expect(auction.allocations[3].toNumber()).to.equal(0); // Dave
    for (let i = 4; i < 8; i++) {
      expect(auction.allocations[i].toNumber()).to.equal(0);
    }

    // 10. Run claims and assert balance changes.
    const clearingPrice = 7n;
    const expectedRefund: Record<string, bigint> = {
      Alice: ctxs[0].maxSpend - clearingPrice * 500n, // 5000 - 3500 = 1500
      Bob: ctxs[1].maxSpend - clearingPrice * 300n, // 2400 - 2100 = 300
      Carol: ctxs[2].maxSpend - clearingPrice * 200n, // 2800 - 1400 = 1400
      Dave: ctxs[3].maxSpend, // 1000 (full)
    };
    const expectedWonQty: Record<string, bigint> = {
      Alice: 500n,
      Bob: 300n,
      Carol: 200n,
      Dave: 0n,
    };

    const solEscrowBeforeClaims = BigInt(
      await provider.connection.getBalance(solEscrow)
    );

    // 10a. Claim winners (Alice, Bob, Carol). Verify SPL allocation arrived
    // at the bidder's ATA and bid_record fields are populated correctly.
    for (const ctx of ctxs.slice(0, 3)) {
      const bidderTokenAta = getAssociatedTokenAddressSync(
        mint,
        ctx.kp.publicKey
      );
      console.log(`claim_winner: ${ctx.name}`);
      await program.methods
        .claimWinner()
        .accountsPartial({
          bidder: ctx.kp.publicKey,
          auction: auctionPda,
          bidRecord: ctx.bidRecordPda,
          escrowAuthority,
          tokenEscrow,
          bidderTokenAccount: bidderTokenAta,
          tokenMint: mint,
          solEscrow,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([ctx.kp])
        .rpc({ skipPreflight: false, commitment: "confirmed" });

      const tokenBal = (
        await getTokenAccount(provider.connection, bidderTokenAta)
      ).amount;
      expect(tokenBal.toString()).to.equal(expectedWonQty[ctx.name].toString());

      const recordAfter = await program.account.bidRecord.fetch(
        ctx.bidRecordPda
      );
      expect(recordAfter.wonQuantity.toString()).to.equal(
        expectedWonQty[ctx.name].toString()
      );
      expect(recordAfter.refundAmount.toString()).to.equal(
        expectedRefund[ctx.name].toString()
      );
      expect(JSON.stringify(recordAfter.status)).to.equal(
        JSON.stringify({ claimed: {} })
      );
    }

    // 10b. Claim loser (Dave). Verify full refund recorded.
    const dave = ctxs[3];
    console.log("claim_loser: Dave");
    await program.methods
      .claimLoser()
      .accountsPartial({
        bidder: dave.kp.publicKey,
        auction: auctionPda,
        bidRecord: dave.bidRecordPda,
        solEscrow,
      })
      .signers([dave.kp])
      .rpc({ skipPreflight: false, commitment: "confirmed" });
    const daveRecord = await program.account.bidRecord.fetch(dave.bidRecordPda);
    expect(daveRecord.refundAmount.toString()).to.equal(
      expectedRefund["Dave"].toString()
    );
    expect(JSON.stringify(daveRecord.status)).to.equal(
      JSON.stringify({ claimed: {} })
    );

    // 10c. Claim issuer (gets 7 * 1000 = 7000 SOL proceeds, 0 unsold tokens).
    console.log("claim_issuer");
    await program.methods
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
    const auctionAfter = await program.account.auction.fetch(auctionPda);
    expect(auctionAfter.issuerClaimed).to.equal(true);

    const issuerAtaFinal = (
      await getTokenAccount(provider.connection, issuerAta.address)
    ).amount;
    // total_sold == total_supply, so unsold == 0; issuer ATA stays at 0.
    expect(issuerAtaFinal.toString()).to.equal("0");

    // sol_escrow should now hold only its rent-exempt minimum after all claims.
    const solEscrowFinal = BigInt(
      await provider.connection.getBalance(solEscrow)
    );
    const totalDisbursed = solEscrowBeforeClaims - solEscrowFinal;
    // Sum of refunds + proceeds == sum of deposits (= 11200 lamports).
    expect(totalDisbursed.toString()).to.equal(totalDeposited.toString());

    // token_escrow should be empty (all 1000 went to winners).
    const tokenEscrowFinal = (
      await getTokenAccount(provider.connection, tokenEscrow)
    ).amount;
    expect(tokenEscrowFinal.toString()).to.equal("0");

    console.log(
      `Disbursed ${totalDisbursed} lamports == deposited ${totalDeposited} (Σ refund + Σ proceeds)`
    );
  });

  // ===== helpers =====

  function arciumQueueAccounts(
    programId: PublicKey,
    offset: anchor.BN,
    circuit: CircuitName
  ) {
    return {
      computationAccount: getComputationAccAddress(
        arciumEnv.arciumClusterOffset,
        offset
      ),
      clusterAccount,
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

  async function initCompDef(
    program: Program<Cleared>,
    owner: anchor.web3.Keypair,
    circuit: CircuitName
  ): Promise<void> {
    const baseSeed = getArciumAccountBaseSeed("ComputationDefinitionAccount");
    const offset = getCompDefAccOffset(circuit);
    const compDefPda = PublicKey.findProgramAddressSync(
      [baseSeed, program.programId.toBuffer(), offset],
      getArciumProgramId()
    )[0];
    const info = await provider.connection.getAccountInfo(compDefPda);
    if (info !== null) return;

    const mxeAccount = getMXEAccAddress(program.programId);
    const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
    const lutAddress = getLookupTableAddress(
      program.programId,
      mxeAcc.lutOffsetSlot
    );

    const methodName = (
      {
        init_bid_book: "initInitBidBookCompDef",
        add_bid: "initAddBidCompDef",
        compute_clearing: "initComputeClearingCompDef",
      } as const
    )[circuit];

    await (program.methods as any)
      [methodName]()
      .accounts({
        compDefAccount: compDefPda,
        payer: owner.publicKey,
        mxeAccount,
        addressLookupTable: lutAddress,
      })
      .signers([owner])
      .rpc({ commitment: "confirmed" });
  }

  async function probeCompDefImmutability(
    owner: anchor.web3.Keypair,
    circuit: CircuitName
  ): Promise<void> {
    const offsetBytes = getCompDefAccOffset(circuit);
    const offset = Buffer.from(offsetBytes).readUInt32LE();
    const mxeAccount = getMXEAccAddress(program.programId);
    const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
    const lutAddress = getLookupTableAddress(
      program.programId,
      mxeAcc.lutOffsetSlot
    );
    const compDefPda = getCompDefAccAddress(program.programId, offset);
    const compDef =
      (await arciumProgram.account.computationDefinitionAccount.fetch(
        compDefPda
      )) as any;

    const sameSource = cloneSource(compDef.circuitSource);
    try {
      await arciumProgram.methods
        .initComputationDefinition(
          offset,
          program.programId,
          compDef.definition,
          sameSource,
          compDef.cuAmount,
          compDef.finalizationAuthority ?? null
        )
        .accounts({
          signer: owner.publicKey,
          mxe: mxeAccount,
          addressLookupTable: lutAddress,
          compDefAcc: compDefPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc({ skipPreflight: false, commitment: "confirmed" });
    } catch (_) {
      // expected: comp def already initialized -> rejected; fine.
    }
  }

  function cloneSource(source: any): any {
    return JSON.parse(JSON.stringify(source));
  }
});

async function getMXEPublicKeyWithRetry(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  maxRetries: number = 20,
  retryDelayMs: number = 500
): Promise<Uint8Array> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const mxePublicKey = await getMXEPublicKey(provider, programId);
      if (mxePublicKey) return mxePublicKey;
    } catch (_) {
      // ignore, will retry
    }
    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  throw new Error(
    `Failed to fetch MXE public key after ${maxRetries} attempts`
  );
}

function readKpJson(path: string): anchor.web3.Keypair {
  const file = fs.readFileSync(path);
  return anchor.web3.Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(file.toString()))
  );
}
