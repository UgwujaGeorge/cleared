// @ts-nocheck
// Create a fresh SPL mint on devnet, mint a fixed supply, send to a recipient.
import {
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";

const RPC =
  process.env.ANCHOR_PROVIDER_URL ??
  "https://devnet.helius-rpc.com/?api-key=5d469c0b-25bd-4d73-a8e5-67c69c7318e2";
const WALLET =
  process.env.ANCHOR_WALLET ?? `${os.homedir()}/.config/solana/id.json`;
const RECIPIENT = new PublicKey(
  process.env.RECIPIENT ?? "He5SFX4NhH1aA6Dw2STa6X9DAuYydoJ8CfNcVgsfCVN3"
);
const AMOUNT = BigInt(process.env.AMOUNT ?? "10000000000");
const DECIMALS = Number(process.env.DECIMALS ?? "0");

async function main() {
  const owner = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(WALLET, "utf8")))
  );
  const connection = new Connection(RPC, "confirmed");
  console.log(`payer: ${owner.publicKey.toBase58()}`);
  console.log(`recipient: ${RECIPIENT.toBase58()}`);
  console.log(`supply: ${AMOUNT} (decimals=${DECIMALS})`);

  const mint = await createMint(
    connection,
    owner,
    owner.publicKey,
    null,
    DECIMALS
  );
  console.log(`mint: ${mint.toBase58()}`);

  const recipientAta = await getOrCreateAssociatedTokenAccount(
    connection,
    owner,
    mint,
    RECIPIENT
  );
  console.log(`recipient ATA: ${recipientAta.address.toBase58()}`);

  const sig = await mintTo(
    connection,
    owner,
    mint,
    recipientAta.address,
    owner,
    AMOUNT
  );
  console.log(`mint_to tx: ${sig}`);

  console.log(`\n=== DONE ===`);
  console.log(`MINT: ${mint.toBase58()}`);
  console.log(`solscan: https://solscan.io/token/${mint.toBase58()}?cluster=devnet`);
  console.log(`recipient ATA solscan: https://solscan.io/account/${recipientAta.address.toBase58()}?cluster=devnet`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
