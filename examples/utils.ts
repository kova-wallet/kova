/* eslint-disable no-console */
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync, writeFileSync, statSync, chmodSync } from "fs";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..");

// Load .env from project root (values won't override existing env vars)
config({ path: resolve(PROJECT_ROOT, ".env") });

const DEFAULT_KEYPAIR_PATH = resolve(PROJECT_ROOT, ".devnet-keypair.json");
const AIRDROP_AMOUNT = 1 * LAMPORTS_PER_SOL;
const MIN_BALANCE_SOL = 0.1;

/**
 * Loads a persistent devnet keypair from disk, or generates one and saves it.
 * All examples share the same keypair so airdrop SOL is not wasted.
 *
 * WARNING: This function stores the full secret key as a JSON file on disk.
 * It is intended for local development and devnet examples ONLY.
 * DO NOT use this in production. Production deployments should use
 * hardware security modules (HSMs), secure enclaves, or dedicated
 * key management services (KMS) for private key storage.
 */
export function loadOrCreateKeypair(): Keypair {
  const keypairPath = process.env.LOCAL_KEYPAIR_PATH
    ? resolve(PROJECT_ROOT, process.env.LOCAL_KEYPAIR_PATH)
    : DEFAULT_KEYPAIR_PATH;

  if (existsSync(keypairPath)) {
    const stats = statSync(keypairPath);
    const mode = stats.mode & 0o777;
    if (mode & 0o077) {
      console.warn(`WARNING: Keypair file has permissions ${mode.toString(8)} (should be 600).`);
      console.warn("  Fix with: chmod 600 " + keypairPath);
    }
    const secretKey = JSON.parse(readFileSync(keypairPath, "utf-8"));
    const keypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));
    console.log(`Loaded keypair from ${keypairPath}`);
    return keypair;
  }

  const keypair = Keypair.generate();
  writeFileSync(keypairPath, JSON.stringify(Array.from(keypair.secretKey)));
  chmodSync(keypairPath, 0o600);
  console.log(`Generated new keypair and saved to ${keypairPath}`);
  return keypair;
}

/**
 * Ensures the wallet has enough devnet SOL to run examples.
 * Skips airdrop if balance is already sufficient.
 */
export async function ensureDevnetSol(
  connection: Connection,
  keypair: Keypair,
): Promise<void> {
  const balance = await connection.getBalance(keypair.publicKey);
  const balanceSol = balance / LAMPORTS_PER_SOL;

  if (balanceSol >= MIN_BALANCE_SOL) {
    console.log(`Balance: ${balanceSol} SOL`);
    return;
  }

  console.log(`Balance: ${balanceSol} SOL — requesting airdrop (1 SOL)...`);

  try {
    const sig = await connection.requestAirdrop(keypair.publicKey, AIRDROP_AMOUNT);
    const latestBlockhash = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, ...latestBlockhash });
    const newBalance = await connection.getBalance(keypair.publicKey);
    console.log(`Airdrop confirmed. Balance: ${newBalance / LAMPORTS_PER_SOL} SOL`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nAirdrop failed: ${msg}`);
    console.error(
      "\nThe devnet faucet may be rate-limited. Fund your wallet manually:\n" +
      `  solana airdrop 1 ${keypair.publicKey.toBase58()} --url devnet\n` +
      "  or visit https://faucet.solana.com\n",
    );
    process.exit(1);
  }
}
