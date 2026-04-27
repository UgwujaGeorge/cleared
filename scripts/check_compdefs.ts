// @ts-nocheck
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  getArciumProgram,
  getCompDefAccAddress,
  getCompDefAccOffset,
} from "@arcium-hq/client";
import * as fs from "fs";
import * as os from "os";

const PROGRAM_ID = new PublicKey("2b48e7A9c91zVVnZSri15CXvDtgmLHYCqACL6GQYkqn9");
const RPC =
  process.env.ANCHOR_PROVIDER_URL ??
  "https://devnet.helius-rpc.com/?api-key=5d469c0b-25bd-4d73-a8e5-67c69c7318e2";

async function main() {
  const owner = anchor.web3.Keypair.fromSecretKey(
    new Uint8Array(
      JSON.parse(
        fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf8")
      )
    )
  );
  const conn = new anchor.web3.Connection(RPC, "confirmed");
  const provider = new anchor.AnchorProvider(
    conn,
    new anchor.Wallet(owner),
    { commitment: "confirmed" }
  );
  const arciumProgram = getArciumProgram(provider) as any;

  for (const name of ["init_bid_book", "add_bid", "compute_clearing"] as const) {
    const offset = Buffer.from(getCompDefAccOffset(name)).readUInt32LE();
    const pda = getCompDefAccAddress(PROGRAM_ID, offset);
    const cd = await arciumProgram.account.computationDefinitionAccount.fetch(pda);
    const src = cd.circuitSource;
    console.log(`--- ${name} ---`);
    console.log(`  pda: ${pda.toBase58()}`);
    console.log(`  cuAmount: ${cd.cuAmount.toString()}`);
    console.log(`  finalizationAuthority: ${cd.finalizationAuthority?.toBase58?.() ?? "null"}`);
    if (src.offChain) {
      console.log(`  off-chain url: ${src.offChain[0].source}`);
      console.log(`  off-chain hash: ${Buffer.from(src.offChain[0].hash).toString("hex")}`);
      console.log(`  off-chain length: ${src.offChain[0].length}`);
    } else if (src.onChain) {
      console.log(`  on-chain (size ${src.onChain[0].length})`);
    } else {
      console.log(`  source: ${JSON.stringify(src)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
