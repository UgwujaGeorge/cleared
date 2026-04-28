import {
  clusterApiUrl,
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddress,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";

const RECIPIENT = new PublicKey("He5SFX4NhH1aA6Dw2STa6X9DAuYydoJ8CfNcVgsfCVN3");
const DECIMALS = 0;
const SUPPLY = BigInt("1000000000");
const WALLET_PATH =
  process.env.ANCHOR_WALLET ?? `${os.homedir()}/.config/solana/id.json`;

function loadPayer(): Keypair {
  if (!fs.existsSync(WALLET_PATH)) {
    console.warn(`Wallet not found at ${WALLET_PATH}; generating a new payer.`);
    console.warn("Fund this payer with devnet SOL before running successfully.");
    return Keypair.generate();
  }

  const secret = JSON.parse(fs.readFileSync(WALLET_PATH, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function main() {
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const payer = loadPayer();
  const mint = Keypair.generate();

  console.log("PAYER:", payer.publicKey.toBase58());
  console.log("RECIPIENT:", RECIPIENT.toBase58());

  const rentLamports = await connection.getMinimumBalanceForRentExemption(
    MINT_SIZE
  );

  const createMintTx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      space: MINT_SIZE,
      lamports: rentLamports,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMint2Instruction(
      mint.publicKey,
      DECIMALS,
      payer.publicKey,
      null,
      TOKEN_PROGRAM_ID
    )
  );

  const createMintSig = await sendAndConfirmTransaction(
    connection,
    createMintTx,
    [payer, mint],
    { commitment: "confirmed" }
  );
  console.log("CREATE MINT TX:", createMintSig);

  const ata = await getAssociatedTokenAddress(mint.publicKey, RECIPIENT);
  const ataAccount = await connection.getAccountInfo(ata, "confirmed");

  if (!ataAccount) {
    const createAtaTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        ata,
        RECIPIENT,
        mint.publicKey
      )
    );

    const createAtaSig = await sendAndConfirmTransaction(
      connection,
      createAtaTx,
      [payer],
      { commitment: "confirmed" }
    );
    console.log("CREATE ATA TX:", createAtaSig);
  } else {
    console.log("RECIPIENT ATA ALREADY EXISTS:", ata.toBase58());
  }

  const mintToTx = new Transaction().add(
    createMintToInstruction(
      mint.publicKey,
      ata,
      payer.publicKey,
      SUPPLY,
      [],
      TOKEN_PROGRAM_ID
    )
  );

  const mintToSig = await sendAndConfirmTransaction(
    connection,
    mintToTx,
    [payer],
    { commitment: "confirmed" }
  );
  console.log("MINT TO TX:", mintToSig);

  console.log("MINT:", mint.publicKey.toBase58());
  console.log("RECIPIENT ATA:", ata.toBase58());
}

main().catch((err) => {
  console.error("Failed to create and mint devnet SPL token:", err);
  process.exit(1);
});
