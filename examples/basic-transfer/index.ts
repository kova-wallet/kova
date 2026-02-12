/* eslint-disable no-console */
/**
 * Basic Transfer Example
 *
 * The simplest kova usage:
 * 1. Create a wallet with a spending limit policy
 * 2. Check balance
 * 3. Send SOL on Solana devnet
 *
 * Prerequisites:
 *   - A funded Solana devnet keypair (run: solana airdrop 2)
 *
 * Run: npx tsx examples/basic-transfer/index.ts
 */

import { Keypair } from "@solana/web3.js";
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
const RECIPIENT = process.env.RECIPIENT_ADDRESS ?? "11111111111111111111111111111111";

async function main() {
  // 1. Create a keypair (generates fresh one for safety if no env var)
  const keypair = Keypair.generate();
  console.log(`Wallet address: ${keypair.publicKey.toBase58()}`);

  // 2. Build a policy with spending limits
  const policy = Policy.create("basic-demo")
    .spendingLimit({
      perTransaction: { amount: "0.5", token: "SOL" },
      daily: { amount: "2", token: "SOL" },
    })
    .rateLimit({ maxTransactionsPerMinute: 5 })
    .build();

  // 3. Convert the Policy into a PolicyEngine (required by AgentWallet)
  const store = new MemoryStore();
  const config = policy.toJSON();
  const rules = [];
  if (config.spendingLimit) rules.push(new SpendingLimitRule(config.spendingLimit));
  if (config.rateLimit) rules.push(new RateLimitRule(config.rateLimit));
  const engine = new PolicyEngine(rules, store);

  // 4. Create the wallet
  const wallet = new AgentWallet({
    signer: new LocalSigner(keypair),
    chain: new SolanaAdapter({ rpcUrl: RPC_URL }),
    policy: engine,
    store,
  });

  // 5. Check balance
  const balance = await wallet.getBalance("SOL");
  console.log(`Balance: ${balance.amount} SOL`);

  // 6. View policy constraints
  const policySummary = await wallet.getPolicy();
  console.log("Policy:", JSON.stringify(policySummary, null, 2));

  // 7. Execute a transfer
  console.log(`\nSending 0.01 SOL to ${RECIPIENT}...`);
  const result = await wallet.execute({
    type: "transfer",
    chain: "solana",
    params: { to: RECIPIENT, amount: "0.01", token: "SOL" },
    metadata: { reason: "Basic transfer example" },
  });
  console.log(`Result: [${result.status}] ${result.summary}`);
  if (result.txId) console.log(`Transaction: ${result.txId}`);

  // 8. Check transaction history
  const history = await wallet.getTransactionHistory(5);
  console.log(`\nTransaction history: ${history.length} entries`);
  for (const tx of history) {
    console.log(`  [${tx.status}] ${tx.summary}`);
  }
}

main().catch(console.error);
