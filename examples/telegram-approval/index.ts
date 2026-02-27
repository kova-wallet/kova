/* eslint-disable no-console */
/**
 * Telegram Approval Example
 *
 * Full human-in-the-loop approval flow using Telegram:
 * 1. Create a wallet with an approval gate policy
 * 2. Execute a small transfer (below threshold) — auto-approved
 * 3. Execute a large transfer (above threshold) — triggers Telegram approval
 *
 * The TelegramApprovalBot sends a message with Approve/Reject buttons to your
 * Telegram chat. The transaction blocks until a human responds or times out.
 *
 * Prerequisites:
 *   - Create a bot via @BotFather and get the token
 *   - Get your chat ID (send a message to the bot, then check
 *     https://api.telegram.org/bot<token>/getUpdates)
 *   - Set env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 *
 * Run: npx tsx examples/telegram-approval/index.ts
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
  ApprovalGateRule,
  TelegramApprovalBot,
  LocalSigner,
  SolanaAdapter,
  MemoryStore,
} from "../../src/index.js";

// ── Environment Validation ──────────────────────────────────────────────────

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("Missing required environment variables.\n");
  console.error("This example requires a Telegram bot for human-in-the-loop approval.\n");
  console.error("Setup steps:");
  console.error("  1. Open Telegram and message @BotFather");
  console.error("  2. Send /newbot and follow the prompts to create a bot");
  console.error("  3. Copy the bot token (looks like: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz)");
  console.error("  4. Send any message to your new bot in Telegram");
  console.error("  5. Visit: https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates");
  console.error('  6. Find your chat ID in the JSON response under "chat": { "id": ... }');
  console.error("");
  console.error("Then export the values:");
  console.error("  export TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz");
  console.error("  export TELEGRAM_CHAT_ID=987654321");
  console.error("");
  console.error("Run again:");
  console.error("  npx tsx examples/telegram-approval/index.ts");
  process.exit(1);
}

// ── Configuration ───────────────────────────────────────────────────────────

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
// NET-06 fix: Generate a random keypair address instead of using the Solana System Program
// address as default. The System Program address (111...1) is a dangerous default because
// funds sent to it would be permanently lost. Using a random address is safer — the transfer
// will fail with a "recipient not found" error rather than burning funds.
const RECIPIENT = process.env.RECIPIENT_ADDRESS ?? Keypair.generate().publicKey.toBase58();

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Telegram Approval Example ===\n");

  // 1. Create the Telegram approval channel
  const approval = new TelegramApprovalBot({
    token: TELEGRAM_BOT_TOKEN!,
    chatId: TELEGRAM_CHAT_ID!,
    defaultTimeout: 120_000, // 2 minutes
  });
  console.log("Telegram approval bot configured.");

  // 2. Load persistent keypair and airdrop devnet SOL
  const keypair = loadOrCreateKeypair();
  console.log(`Wallet address: ${keypair.publicKey.toBase58()}`);

  const connection = new Connection(RPC_URL, "confirmed");
  await ensureDevnetSol(connection, keypair);

  // 3. Build a policy with an approval gate
  //    - Transactions above 0.3 SOL require Telegram approval
  //    - Transactions at or below 0.3 SOL are auto-approved (within spending limits)
  const policy = Policy.create("telegram-approval-demo")
    .spendingLimit({
      perTransaction: { amount: "1.0", token: "SOL" },
      daily: { amount: "5.0", token: "SOL" },
    })
    .rateLimit({ maxTransactionsPerMinute: 5 })
    .requireApproval({
      above: { amount: "0.3", token: "SOL" },
      channel: "telegram",
      timeout: 120_000,
    })
    .build();

  // 4. Build the PolicyEngine with the approval channel
  // T6-F5 fix: Pass dangerouslyAllowInProduction to allow MemoryStore usage in examples.
  // Production deployments should use SqliteStore with encryption instead.
  const store = new MemoryStore({ dangerouslyAllowInProduction: true });
  const config = policy.toJSON();
  const rules: PolicyRule[] = [];

  if (config.spendingLimit) {
    rules.push(new SpendingLimitRule(config.spendingLimit));
  }
  if (config.rateLimit) {
    rules.push(new RateLimitRule(config.rateLimit));
  }
  if (config.approvalGate) {
    rules.push(new ApprovalGateRule(config.approvalGate));
  }

  // Pass the approval channel to the PolicyEngine so ApprovalGateRule can use it
  const engine = new PolicyEngine(rules, store, approval);

  // 5. Create the wallet
  const wallet = new AgentWallet({
    // T6-F5 fix: Pass dangerouslyAllowInProduction to allow LocalSigner usage in examples.
    // Production deployments should use MpcSigner with a hardware-backed provider instead.
    signer: new LocalSigner(keypair, { dangerouslyAllowInProduction: true }),
    chain: new SolanaAdapter({ rpcUrl: RPC_URL, network: "devnet" }),
    policy: engine,
    store,
    approval,
  });

  // 6. View the policy
  const policySummary = await wallet.getPolicy();
  console.log("\nPolicy summary:");
  console.log(JSON.stringify(policySummary, null, 2));

  // ── Transaction 1: Small transfer (below approval threshold) ──────────

  console.log("\n--- Transaction 1: Small Transfer (0.1 SOL) ---");
  console.log("This is below the 0.3 SOL approval threshold, so it should auto-approve.\n");

  const smallResult = await wallet.execute({
    type: "transfer",
    chain: "solana",
    params: { to: RECIPIENT, amount: "0.1", token: "SOL" },
    metadata: { reason: "Small payment — no approval needed", agentId: "demo-agent" },
  });

  console.log(`  Status: ${smallResult.status}`);
  console.log(`  Summary: ${smallResult.summary}`);
  if (smallResult.txId) console.log(`  Transaction ID: ${smallResult.txId}`);
  if (smallResult.error) console.log(`  Error: ${smallResult.error.message}`);

  // ── Transaction 2: Large transfer (above approval threshold) ──────────

  console.log("\n--- Transaction 2: Large Transfer (0.5 SOL) ---");
  console.log("This exceeds the 0.3 SOL approval threshold.");
  console.log("Check your Telegram — you should see an approval request.");
  console.log("You have 2 minutes to approve or reject.\n");

  const largeResult = await wallet.execute({
    type: "transfer",
    chain: "solana",
    params: { to: RECIPIENT, amount: "0.5", token: "SOL" },
    metadata: { reason: "Large payment — requires human approval", agentId: "demo-agent" },
  });

  console.log(`  Status: ${largeResult.status}`);
  console.log(`  Summary: ${largeResult.summary}`);
  if (largeResult.txId) console.log(`  Transaction ID: ${largeResult.txId}`);
  if (largeResult.error) console.log(`  Error: ${largeResult.error.message}`);

  // ── Transaction History ───────────────────────────────────────────────

  console.log("\n--- Transaction History ---\n");
  const history = await wallet.getTransactionHistory(10);

  if (history.length === 0) {
    console.log("  (no transactions recorded)");
  } else {
    for (const tx of history) {
      console.log(`  [${tx.status}] ${tx.summary}`);
    }
  }

  console.log("\nDone.");
}

main().catch(console.error);
