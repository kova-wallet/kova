/* eslint-disable no-console */
/**
 * Basic Transfer Example
 *
 * The simplest kova usage:
 * 1. Create a wallet with a spending limit policy
 * 2. Airdrop devnet SOL
 * 3. Check balance
 * 4. Send SOL on Solana devnet
 *
 * Prerequisites:
 *   - npm install
 *
 * Run: npx tsx examples/basic-transfer/index.ts
 */

import { Connection, Keypair } from "@solana/web3.js";
import { loadOrCreateKeypair, ensureDevnetSol } from "../utils.js";
import type { PolicyRule } from "../../src/index.js";
import {
  AgentWallet,
  Policy,
  PolicyEngine,
  SpendingLimitRule,
  RateLimitRule,
  LocalSigner,
  SolanaAdapter,
  MemoryStore,
} from "../../src/index.js";

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

async function main() {
  // 1. Load persistent keypair (or generate and save on first run)
  const keypair = loadOrCreateKeypair();
  console.log(`Wallet address: ${keypair.publicKey.toBase58()}`);

  // 2. Airdrop devnet SOL to the wallet (skips if already funded)
  const connection = new Connection(RPC_URL, "confirmed");
  await ensureDevnetSol(connection, keypair);

  // Load recipient from env, or generate a fresh address
  const RECIPIENT = process.env.RECIPIENT_ADDRESS ?? Keypair.generate().publicKey.toBase58();
  console.log(`Recipient: ${RECIPIENT}`);

  // 3. Build a policy with spending limits
  const policy = Policy.create("basic-demo")
    .spendingLimit({
      perTransaction: { amount: "0.5", token: "SOL" },
      daily: { amount: "2", token: "SOL" },
    })
    .rateLimit({ maxTransactionsPerMinute: 5 })
    .build();

  // 4. Convert the Policy into a PolicyEngine (required by AgentWallet)
  // T1-F10 fix: Pass dangerouslyAllowInProduction to allow MemoryStore usage in examples.
  // Production deployments should use SqliteStore with encryption instead.
  const store = new MemoryStore({ dangerouslyAllowInProduction: true });
  const config = policy.toJSON();
  const rules: PolicyRule[] = [];
  if (config.spendingLimit) rules.push(new SpendingLimitRule(config.spendingLimit));
  if (config.rateLimit) rules.push(new RateLimitRule(config.rateLimit));
  const engine = new PolicyEngine(rules, store);

  // 5. Create the wallet
  const wallet = new AgentWallet({
    // T6-F5 fix: Pass dangerouslyAllowInProduction to allow LocalSigner usage in examples.
    // Production deployments should use MpcSigner with a hardware-backed provider instead.
    signer: new LocalSigner(keypair, { dangerouslyAllowInProduction: true }),
    chain: new SolanaAdapter({ rpcUrl: RPC_URL, network: "devnet" }),
    policy: engine,
    store,
  });

  // 6. Check balance
  const balance = await wallet.getBalance("SOL");
  console.log(`Balance: ${balance.amount} SOL`);

  // 7. View policy constraints
  const policySummary = await wallet.getPolicy();
  console.log("Policy:", JSON.stringify(policySummary, null, 2));

  // 8. Execute a transfer
  console.log(`\nSending 0.01 SOL to ${RECIPIENT}...`);
  const result = await wallet.execute({
    type: "transfer",
    chain: "solana",
    params: { to: RECIPIENT, amount: "0.01", token: "SOL" },
    metadata: { reason: "Basic transfer example" },
  });
  console.log(`Result: [${result.status}] ${result.summary}`);
  if (result.txId) console.log(`Transaction: ${result.txId}`);

  // 9. Check transaction history
  const history = await wallet.getTransactionHistory(5);
  console.log(`\nTransaction history: ${history.length} entries`);
  for (const tx of history) {
    console.log(`  [${tx.status}] ${tx.summary}`);
  }
}

main().catch(console.error);
