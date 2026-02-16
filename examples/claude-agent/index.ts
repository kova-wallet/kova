/* eslint-disable no-console */
/**
 * Claude Agent Example
 *
 * Demonstrates how to give Claude access to a crypto wallet via tool use.
 * Uses `wallet.toAnthropicTools()` to get tool definitions and
 * `wallet.handleToolCall()` to dispatch tool invocations.
 *
 * Flow:
 * 1. Create a wallet with a spending-limit policy
 * 2. Convert wallet operations to Anthropic tool definitions
 * 3. Run the tool-use loop: Claude decides which tools to call
 * 4. Print Claude's final text response
 *
 * Prerequisites:
 *   - npm install @anthropic-ai/sdk
 *   - Set ANTHROPIC_API_KEY env var
 *
 * Run: npx tsx examples/claude-agent/index.ts
 */

// Requires: npm install @anthropic-ai/sdk
import Anthropic from "@anthropic-ai/sdk";
import { Connection } from "@solana/web3.js";
import { loadOrCreateKeypair, ensureDevnetSol } from "../utils.js";
import type { PolicyRule } from "../../src/index.js";
import {
  AgentWallet,
  Policy,
  PolicyEngine,
  SpendingLimitRule,
  RateLimitRule,
  AllowlistRule,
  LocalSigner,
  SolanaAdapter,
  MemoryStore,
  // NET-07 fix: Use safeHandleToolCall instead of wallet.handleToolCall directly.
  // safeHandleToolCall integrates validateToolInput() for schema validation and
  // the write rate limit floor (WRITE_RATE_LIMIT_PER_MINUTE = 30).
  safeHandleToolCall,
} from "../../src/index.js";

// ── Configuration ───────────────────────────────────────────────────────────

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const MODEL = "claude-sonnet-4-5-20250929";
const TREASURY = "7Vbmv1jt4vyuqBZcpYPpnVhrqVe5e6ZPb6JxDcffRHnT";

const SYSTEM_PROMPT = `You are an AI assistant with access to a crypto wallet on Solana devnet.

Before sending any transaction, always:
1. Check your policy constraints using wallet_get_policy
2. Check your balance using wallet_get_balance

Be concise in your responses. If a transaction is denied by policy, explain why and suggest alternatives.`;

// ── Wallet Setup ────────────────────────────────────────────────────────────

async function createWallet(): Promise<AgentWallet> {
  const keypair = loadOrCreateKeypair();
  console.log(`Wallet address: ${keypair.publicKey.toBase58()}`);

  // Airdrop devnet SOL so the wallet can transact (skips if already funded)
  const connection = new Connection(RPC_URL, "confirmed");
  await ensureDevnetSol(connection, keypair);

  // Build policy: conservative spending limits with an allowlist
  const policy = Policy.create("claude-agent-demo")
    .spendingLimit({
      perTransaction: { amount: "1.0", token: "SOL" },
      daily: { amount: "5.0", token: "SOL" },
    })
    .allowAddresses([TREASURY])
    .rateLimit({ maxTransactionsPerMinute: 5, maxTransactionsPerHour: 20 })
    .build();

  // Convert Policy to PolicyEngine
  // T1-F10 fix: Pass dangerouslyAllowInProduction to allow MemoryStore usage in examples.
  // Production deployments should use SqliteStore with encryption instead.
  const store = new MemoryStore({ dangerouslyAllowInProduction: true });
  const config = policy.toJSON();
  const rules: PolicyRule[] = [];
  if (config.spendingLimit) rules.push(new SpendingLimitRule(config.spendingLimit));
  if (config.allowAddresses || config.denyAddresses || config.allowPrograms || config.denyPrograms) {
    rules.push(
      new AllowlistRule({
        allowAddresses: config.allowAddresses,
        denyAddresses: config.denyAddresses,
        allowPrograms: config.allowPrograms,
        denyPrograms: config.denyPrograms,
      }),
    );
  }
  if (config.rateLimit) rules.push(new RateLimitRule(config.rateLimit));
  const engine = new PolicyEngine(rules, store);

  return new AgentWallet({
    // T6-F5 fix: Pass dangerouslyAllowInProduction to allow LocalSigner usage in examples.
    // Production deployments should use MpcSigner with a hardware-backed provider instead.
    signer: new LocalSigner(keypair, { dangerouslyAllowInProduction: true }),
    chain: new SolanaAdapter({ rpcUrl: RPC_URL }),
    policy: engine,
    store,
  });
}

// ── Tool-Use Loop ───────────────────────────────────────────────────────────

async function runAgent(wallet: AgentWallet, userMessage: string): Promise<string> {
  const client = new Anthropic();

  // Get wallet tool definitions in Anthropic format
  const tools = wallet.toAnthropicTools();
  console.log(`\nRegistered ${tools.length} wallet tools:`);
  for (const tool of tools) {
    console.log(`  - ${tool.name}`);
  }

  // Build initial conversation
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  console.log(`\nUser: ${userMessage}`);
  console.log("\n--- Running tool-use loop ---\n");

  // Initial request
  let response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools,
    messages,
  });

  // Tool-use loop: keep going as long as Claude wants to call tools
  while (response.stop_reason === "tool_use") {
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type === "tool_use") {
        console.log(`  Tool call: ${block.name}`);
        console.log(`    Input: ${JSON.stringify(block.input)}`);

        // NET-07 fix: Use safeHandleToolCall instead of wallet.handleToolCall directly.
        // safeHandleToolCall wraps handleToolCall with validateToolInput() for schema
        // validation (required fields, type checks, unknown property stripping) and the
        // write rate limit floor (WRITE_RATE_LIMIT_PER_MINUTE = 30).
        const result = await safeHandleToolCall(
          wallet,
          block.name,
          block.input as Record<string, unknown>,
        );

        console.log(`    Result: ${JSON.stringify(result).slice(0, 200)}`);
        console.log("");

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }
    }

    // Feed tool results back to Claude
    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });

    response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });
  }

  // Extract final text response
  const textBlocks = response.content.filter(
    (block): block is Anthropic.TextBlock => block.type === "text",
  );
  return textBlocks.map((b) => b.text).join("\n");
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Check for API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Error: ANTHROPIC_API_KEY environment variable is not set.\n");
    console.error("To run this example:");
    console.error("  1. Get an API key from https://console.anthropic.com/");
    console.error("  2. Export it: export ANTHROPIC_API_KEY=sk-ant-...");
    console.error("  3. Run again: npx tsx examples/claude-agent/index.ts");
    process.exit(1);
  }

  console.log("=== Claude Agent with Wallet Tools ===\n");

  const wallet = await createWallet();

  // Ask Claude to check the wallet and try a transfer
  const reply = await runAgent(
    wallet,
    `Check my wallet policy and balance, then try to send 0.1 SOL to ${TREASURY}. Tell me what happened.`,
  );

  console.log("\n--- Claude's Response ---\n");
  console.log(reply);

  // Show transaction history after the agent run
  console.log("\n--- Transaction History ---\n");
  const history = await wallet.getTransactionHistory(10);
  if (history.length === 0) {
    console.log("  (no transactions)");
  } else {
    for (const tx of history) {
      console.log(`  [${tx.status}] ${tx.summary}`);
    }
  }
}

main().catch(console.error);
