import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  getArciumAccountBaseSeed,
  getArciumProgram,
  getArciumProgramId,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getLookupTableAddress,
  getMXEAccAddress,
} from "@arcium-hq/client";
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

async function main() {
  const owner = readKpJson(WALLET_PATH);
  const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(owner),
    { commitment: "confirmed", preflightCommitment: "confirmed" }
  );
  anchor.setProvider(provider);

  const idl = JSON.parse(fs.readFileSync("target/idl/cleared.json", "utf8"));
  const program = new Program<Cleared>(idl, provider);
  const arciumProgram = getArciumProgram(provider);

  console.log(`Program: ${program.programId.toBase58()}`);
  console.log(`RPC: ${RPC_URL}`);
  for (const circuit of CIRCUIT_NAMES) {
    const sig = await initCompDef(program, arciumProgram, owner, circuit);
    console.log(`${circuit}: ${sig}`);
  }
}

async function initCompDef(
  program: Program<Cleared>,
  arciumProgram: ReturnType<typeof getArciumProgram>,
  owner: anchor.web3.Keypair,
  circuit: CircuitName
): Promise<string> {
  const compDefPda = getCompDefPda(program.programId, circuit);
  const existing = await program.provider.connection.getAccountInfo(compDefPda);
  if (existing !== null)
    return `already initialized (${compDefPda.toBase58()})`;

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

  return await (program.methods as any)
    [methodName]()
    .accounts({
      compDefAccount: compDefPda,
      payer: owner.publicKey,
      mxeAccount,
      addressLookupTable: lutAddress,
    })
    .signers([owner])
    .rpc({ skipPreflight: false, commitment: "confirmed" });
}

function getCompDefPda(programId: PublicKey, circuit: CircuitName): PublicKey {
  const baseSeed = getArciumAccountBaseSeed("ComputationDefinitionAccount");
  const offset = getCompDefAccOffset(circuit);
  const sdkPda = getCompDefAccAddress(
    programId,
    Buffer.from(offset).readUInt32LE()
  );
  const manualPda = PublicKey.findProgramAddressSync(
    [baseSeed, programId.toBuffer(), offset],
    getArciumProgramId()
  )[0];
  if (!sdkPda.equals(manualPda)) {
    throw new Error(`Comp def PDA mismatch for ${circuit}`);
  }
  return sdkPda;
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
