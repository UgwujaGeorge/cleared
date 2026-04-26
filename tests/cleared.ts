import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
} from "@solana/web3.js";
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

describe("Cleared", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Cleared as Program<Cleared>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const arciumProgram = getArciumProgram(provider);
  const arciumEnv = getArciumEnv();
  const clusterAccount = getClusterAccAddress(arciumEnv.arciumClusterOffset);

  it("runs a uniform-price clearing end-to-end", async () => {
    const owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);

    // 1. Init all three comp defs (idempotent across test runs).
    for (const name of CIRCUIT_NAMES) {
      console.log(`Initializing comp def: ${name}`);
      await initCompDef(program, owner, name);
      console.log(`  comp def ready: ${name}`);
    }
    await probeCompDefImmutability(owner, "init_bid_book");

    // 2. Fetch MXE pubkey with retry (arx nodes may take time to initialize).
    const mxePublicKey = await getMXEPublicKeyWithRetry(
      provider,
      program.programId
    );
    console.log("MXE x25519 pubkey fetched");

    // 3. Pick an auction id; compute Auction PDA.
    const auctionId = new anchor.BN(randomBytes(8), "hex");
    const [auctionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("auction"), auctionId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // 4. create_auction -> init_bid_book.
    // Localnet clock is independent of wall clock — fetch it from the validator.
    const slot = await provider.connection.getSlot("confirmed");
    const solanaNow = await provider.connection.getBlockTime(slot);
    if (solanaNow === null) throw new Error("Failed to read validator clock");
    const now = solanaNow;
    const opensAt = new anchor.BN(now - 5); // already open
    // Each MPC round-trip takes ~20-30s on localnet (init + 3 bids).
    const closesAt = new anchor.BN(now + 90);
    const totalSupply = new anchor.BN(1000);

    console.log("Creating auction...");
    const createOffset = new anchor.BN(randomBytes(8), "hex");
    await program.methods
      .createAuction(
        createOffset,
        auctionId,
        totalSupply,
        new anchor.BN(0), // min_price
        new anchor.BN(0), // max_bid_per_wallet (0 = no cap)
        opensAt,
        closesAt
      )
      .accountsPartial({
        payer: owner.publicKey,
        issuer: owner.publicKey,
        auction: auctionPda,
        ...arciumQueueAccounts(
          program.programId,
          createOffset,
          "init_bid_book"
        ),
      })
      .signers([owner])
      .rpc({ skipPreflight: false, commitment: "confirmed" });

    console.log("Awaiting init_bid_book finalization...");
    const finalizeRet = await awaitComputationFinalization(
      provider,
      createOffset,
      program.programId,
      "confirmed"
    );
    console.log(
      `  finalize ret = ${JSON.stringify(finalizeRet) ?? "undefined"}`
    );

    const a0 = await program.account.auction.fetch(auctionPda);
    const nonceHex = Buffer.from(a0.encryptedBidBookNonce).toString("hex");
    const bookAllZero = a0.encryptedBidBook.every((ct) =>
      ct.every((b: number) => b === 0)
    );
    console.log(`  status         = ${JSON.stringify(a0.status)}`);
    console.log(`  bid_count      = ${a0.bidCount}`);
    console.log(`  bid_book_nonce = ${nonceHex}`);
    console.log(
      `  bid_book[0..8] = ${Buffer.from(a0.encryptedBidBook[0])
        .slice(0, 8)
        .toString("hex")}`
    );
    console.log(`  bid_book all-zero? ${bookAllZero}`);

    console.log(`  fetching finalize tx ${finalizeRet}`);
    const finalizeTx = await provider.connection.getTransaction(
      finalizeRet as string,
      {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      }
    );
    console.log(`    err = ${JSON.stringify(finalizeTx?.meta?.err ?? null)}`);
    if (finalizeTx?.meta?.logMessages) {
      for (const line of finalizeTx.meta.logMessages)
        console.log(`      ${line}`);
    }

    // 5. Submit 3 bids with distinct bidders.
    // Scenario (per CLEARED_INSTRUCTIONS.md example):
    //   Alice: 500 @ 10  -> wins 500 @ 7
    //   Bob:   300 @ 8   -> wins 300 @ 7
    //   Carol: 400 @ 7   -> wins 200 @ 7 (partial; only 200 left)
    //   Expected clearing_price = 7, total_sold = 1000
    const bidders = [
      { name: "Alice", price: 10n, quantity: 500n },
      { name: "Bob", price: 8n, quantity: 300n },
      { name: "Carol", price: 7n, quantity: 400n },
    ];

    for (let i = 0; i < bidders.length; i++) {
      const b = bidders[i];
      const kp = Keypair.generate();
      // Fund bidder so they can pay account creation rent.
      const fundTx = await provider.connection.requestAirdrop(
        kp.publicKey,
        LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(fundTx, "confirmed");

      // Encrypt bid with per-bidder shared secret.
      const bidderPriv = x25519.utils.randomSecretKey();
      const bidderPub = x25519.getPublicKey(bidderPriv);
      const sharedSecret = x25519.getSharedSecret(bidderPriv, mxePublicKey);
      const cipher = new RescueCipher(sharedSecret);

      const nonce = randomBytes(16);
      const ct = cipher.encrypt([b.price, b.quantity], nonce);

      const [bidRecordPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("bid"),
          auctionId.toArrayLike(Buffer, "le", 8),
          kp.publicKey.toBuffer(),
        ],
        program.programId
      );

      const submitOffset = new anchor.BN(randomBytes(8), "hex");
      console.log(
        `Submitting bid ${i} (${b.name}: ${b.quantity} @ ${b.price})...`
      );
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
          bidder: kp.publicKey,
          auction: auctionPda,
          bidRecord: bidRecordPda,
          ...arciumQueueAccounts(program.programId, submitOffset, "add_bid"),
        })
        .signers([owner, kp])
        .rpc({ skipPreflight: false, commitment: "confirmed" });

      console.log(`  Awaiting add_bid finalization for ${b.name}...`);
      await awaitComputationFinalization(
        provider,
        submitOffset,
        program.programId,
        "confirmed"
      );
      console.log(`  Bid ${i} accepted`);
    }

    // 6. Wait for closes_at — poll the validator clock (not wall clock).
    console.log(`Waiting for validator clock to pass closes_at=${closesAt}...`);
    while (true) {
      const s = await provider.connection.getSlot("confirmed");
      const t = await provider.connection.getBlockTime(s);
      if (t !== null && t >= closesAt.toNumber() + 1) break;
      await new Promise((r) => setTimeout(r, 2000));
    }

    // 7. close_auction -> compute_clearing.
    const closeOffset = new anchor.BN(randomBytes(8), "hex");
    console.log("Closing auction...");
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

    console.log("Awaiting compute_clearing finalization...");
    await awaitComputationFinalization(
      provider,
      closeOffset,
      program.programId,
      "confirmed"
    );

    // 8. Verify clearing result.
    const auction = await program.account.auction.fetch(auctionPda);
    console.log("Auction settled:");
    console.log(`  status         = ${JSON.stringify(auction.status)}`);
    console.log(`  bid_count      = ${auction.bidCount}`);
    console.log(`  clearing_price = ${auction.clearingPrice.toString()}`);
    console.log(
      `  allocations    = [${auction.allocations
        .map((a) => a.toString())
        .join(", ")}]`
    );
    console.log(`  total_sold     = ${auction.totalSold.toString()}`);

    expect(auction.clearingPrice.toNumber()).to.equal(7);
    expect(auction.totalSold.toNumber()).to.equal(1000);
    expect(auction.allocations[0].toNumber()).to.equal(500); // Alice
    expect(auction.allocations[1].toNumber()).to.equal(300); // Bob
    expect(auction.allocations[2].toNumber()).to.equal(200); // Carol (partial)
    expect(auction.allocations[3].toNumber()).to.equal(0); // slot unused
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
      // Explicit: Anchor's accountsPartial resolver auto-fills these from the
      // IDL `address` constants on most ixs but not `submit_bid` (likely an
      // ordering / init-account interaction). Passing them explicitly works
      // for all three ixs and avoids the surprise.
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

    // Idempotency: skip if already initialized.
    const info = await provider.connection.getAccountInfo(compDefPda);
    if (info !== null) {
      console.log(`  (already initialized: ${circuit})`);
      return;
    }

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

    console.log(`  using off-chain circuit source for ${circuit}`);
  }

  async function probeCompDefImmutability(
    owner: anchor.web3.Keypair,
    circuit: CircuitName
  ): Promise<void> {
    console.log(`Probing comp-def immutability: ${circuit}`);
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
    const wrongHash = cloneSource(compDef.circuitSource);
    wrongHash.offChain[0].hash[0] = wrongHash.offChain[0].hash[0] ^ 1;
    const differentUrl = cloneSource(compDef.circuitSource);
    differentUrl.offChain[0].source = `${differentUrl.offChain[0].source}?immutability_probe=1`;

    const scenarios = [
      ["same hash + same URL", sameSource],
      ["different hash + same URL", wrongHash],
      ["same hash + different URL", differentUrl],
    ] as const;

    for (const [label, source] of scenarios) {
      const result = await tryInitComputationDefinition(
        owner,
        offset,
        mxeAccount,
        lutAddress,
        compDefPda,
        compDef,
        source
      );
      console.log(`  ${label}: ${result}`);
    }
  }

  async function tryInitComputationDefinition(
    owner: anchor.web3.Keypair,
    offset: number,
    mxeAccount: PublicKey,
    lutAddress: PublicKey,
    compDefPda: PublicKey,
    compDef: any,
    source: any
  ): Promise<string> {
    try {
      const sig = await arciumProgram.methods
        .initComputationDefinition(
          offset,
          program.programId,
          compDef.definition,
          source,
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
      return `accepted (${sig})`;
    } catch (e: any) {
      const message = e.message ?? String(e);
      const usefulLog = [...(e.logs ?? [])]
        .reverse()
        .find(
          (line: string) =>
            !line.includes("Instruction: InitComputationDefinition") &&
            !line.includes("invoke") &&
            !line.includes("consumed")
        );
      return `rejected (${usefulLog ?? message})`;
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
    } catch (e) {
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
