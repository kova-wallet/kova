# Building a Payment Agent with Claude

This tutorial shows you how to build a Claude-powered AI agent that can check wallet balances, review its spending policy, and make payments -- all through natural language conversation. The kova SDK provides native <Term id="tool-definitions">tool definitions</Term> that plug directly into the Anthropic Messages API.

## Prerequisites

- Node.js 18 or later
- An Anthropic API key (set as `ANTHROPIC_API_KEY`)
- A funded Solana devnet wallet (see [Your First Agent Wallet](/tutorials/first-wallet) for setup)

## Step 1: Install Dependencies

```bash
npm install kova @anthropic-ai/sdk @solana/web3.js
```

## Step 2: Set Up the Wallet with Policy

We create a wallet with a conservative policy: spending limits, an <Term id="allowlist" /> of approved addresses, and rate limiting.

```typescript
import { Keypair } from "@solana/web3.js";
import {
  AgentWallet,
  LocalSigner,
  MemoryStore,
  SolanaAdapter,
  Policy,
  SpendingLimitRule,
  AllowlistRule,
  RateLimitRule,
  PolicyEngine,
  AuditLogger,
} from "kova";

// Load keypair from environment (never hardcode!)
const secretKey = Uint8Array.from(JSON.parse(process.env.SOLANA_SECRET_KEY!));
const keypair = Keypair.fromSecretKey(secretKey);

const signer = new LocalSigner(keypair);
const store = new MemoryStore();
const chain = new SolanaAdapter({
  rpcUrl: "https://api.devnet.solana.com",
  commitment: "confirmed",
});

const policy = Policy.create("payment-agent-policy")
  .spendingLimit({
    perTransaction: { amount: "1.0", token: "SOL" },
    daily: { amount: "10.0", token: "SOL" },
  })
  .allowAddresses([
    "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",
    "FxkPQ7oB5E1RW8vwM9BwGhkRwJSmHftCFAi6KhFNiWaP",
    "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH",
  ])
  .rateLimit({
    maxTransactionsPerMinute: 5,
  })
  .build();

const config = policy.toJSON();
const rules = [
  new SpendingLimitRule(config.spendingLimit!),
  new AllowlistRule(config.allowAddresses!),
  new RateLimitRule(config.rateLimit!),
];
const engine = new PolicyEngine(rules, store);
const logger = new AuditLogger(store);

const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  logger,
});
```

## Step 3: Define the System Prompt

The <Term id="system-prompt" /> tells Claude what it can do and how to behave responsibly.

```typescript
const SYSTEM_PROMPT = `You are a payment agent with access to a Solana wallet.
You can check balances, review your spending policy, send SOL payments, and
view transaction history.

Rules you must follow:
- Always check your balance before making a payment.
- Always confirm the recipient address and amount with the user before sending.
- If a payment is denied by policy, explain why to the user.
- Never attempt to circumvent spending limits or allowlist restrictions.
- Report your transaction results clearly.

Your wallet is on Solana devnet and has the following policy:
- Max 1 SOL per transaction
- Max 10 SOL per day
- Only approved addresses can receive funds
- Max 5 transactions per minute`;
```

## Step 4: Get Tools from the Wallet

The `toAnthropicTools()` method returns tool definitions in the exact format the Anthropic Messages API expects.

```typescript
const tools = wallet.toAnthropicTools();
// Returns AnthropicTool[] with tools like:
//   wallet_get_balance, wallet_get_address, wallet_get_policy,
//   wallet_transfer, wallet_swap, wallet_get_transaction_history
```

::: tip
These tool definitions include full JSON schemas for input parameters and clear descriptions. Claude will know exactly how to call them without any additional prompting.
:::

## Step 5: Write the Tool-Use Loop

This function drives the <Term id="multi-turn" /> conversation. When Claude responds with `tool_use` blocks, we execute them via `wallet.handleToolCall()` and feed the results back.

```typescript
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic();

interface Message {
  role: "user" | "assistant";
  content: string | Anthropic.ContentBlock[];
}

async function chat(userMessage: string, messages: Message[]): Promise<string> {
  messages.push({ role: "user", content: userMessage });

  let response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools,
    messages,
  });

  // Loop until Claude stops calling tools
  while (response.stop_reason === "tool_use") {
    const assistantContent = response.content;
    messages.push({ role: "assistant", content: assistantContent });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of assistantContent) {
      if (block.type === "tool_use") {
        console.log(`[Tool Call] ${block.name}(${JSON.stringify(block.input)})`);

        const result = await wallet.handleToolCall(
          block.name,
          block.input as Record<string, unknown>
        );

        console.log(`[Tool Result] success=${result.success}`, result.data ?? result.error);

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result.success ? result.data : { error: result.error }),
        });
      }
    }

    messages.push({ role: "user", content: toolResults });

    response = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });
  }

  // Extract final text response
  const textBlocks = response.content.filter(
    (block): block is Anthropic.TextBlock => block.type === "text"
  );
  const finalText = textBlocks.map((b) => b.text).join("\n");

  messages.push({ role: "assistant", content: response.content });

  return finalText;
}
```

## Step 6: Run a Conversation

Now let us simulate a user asking the agent to check their balance and send a payment.

```typescript
async function main() {
  const messages: Message[] = [];

  // Turn 1: User asks to check balance
  console.log("\n--- User: What is my SOL balance? ---");
  const reply1 = await chat("What is my SOL balance?", messages);
  console.log("Agent:", reply1);
  // Claude calls wallet_get_balance({ token: "SOL" })
  // Agent: Your current SOL balance is 4.5 SOL.

  // Turn 2: User asks to check spending policy
  console.log("\n--- User: What are my spending limits? ---");
  const reply2 = await chat("What are my spending limits?", messages);
  console.log("Agent:", reply2);
  // Claude calls wallet_get_policy()
  // Agent: Your policy allows max 1 SOL per transaction and 10 SOL per day.
  //        Only approved addresses can receive funds.

  // Turn 3: User asks to send a payment
  console.log("\n--- User: Send 0.5 SOL to 9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde ---");
  const reply3 = await chat(
    "Send 0.5 SOL to 9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",
    messages
  );
  console.log("Agent:", reply3);
  // Claude calls wallet_get_balance({ token: "SOL" }) to verify funds
  // Claude calls wallet_transfer({ to: "9aE476...", amount: "0.5", token: "SOL" })
  // Agent: Payment sent! 0.5 SOL transferred to 9aE476...
  //        Transaction ID: 3xK7m...xyz

  // Turn 4: User asks to send to an unknown address (will be denied)
  console.log("\n--- User: Send 0.1 SOL to unknownAddr123... ---");
  const reply4 = await chat(
    "Send 0.1 SOL to unknownAddr123456789012345678901234567890",
    messages
  );
  console.log("Agent:", reply4);
  // Claude calls wallet_transfer(...)
  // Policy denies: ADDRESS_NOT_ALLOWED
  // Agent: I cannot send to that address. It is not on the approved allowlist.
}

main().catch(console.error);
```

## Step 7: Multi-Turn Flow Diagram

Here is the flow for the payment request in Turn 3:

```
User: "Send 0.5 SOL to 9aE476..."
  |
  v
Claude: tool_use(wallet_get_balance, { token: "SOL" })
  |
  v
wallet.handleToolCall("wallet_get_balance", { token: "SOL" })
  -> { success: true, data: { token: "SOL", amount: "4.5", decimals: 9 } }
  |
  v
Claude: tool_use(wallet_transfer, { to: "9aE476...", amount: "0.5", token: "SOL" })
  |
  v
wallet.handleToolCall("wallet_transfer", { to: "9aE476...", amount: "0.5", token: "SOL" })
  -> PolicyEngine evaluates: spending limit OK, allowlist OK, rate limit OK
  -> Transaction signed and submitted
  -> { success: true, data: { status: "confirmed", txId: "3xK7m...", summary: "..." } }
  |
  v
Claude: "Payment sent! 0.5 SOL transferred. Transaction ID: 3xK7m..."
```

## Step 8: View the Audit Trail

After the conversation, inspect the full audit trail.

```typescript
async function viewAuditTrail() {
  const history = await wallet.getTransactionHistory(20);

  console.log("\n=== Audit Trail ===");
  for (const entry of history) {
    console.log(`[${entry.timestamp}] ${entry.status.toUpperCase()}`);
    console.log(`  Intent: ${entry.intentId}`);
    console.log(`  Summary: ${entry.summary}`);
    if (entry.txId) {
      console.log(`  Tx ID: ${entry.txId}`);
    }
    if (entry.error) {
      console.log(`  Error: ${entry.error}`);
    }
    console.log();
  }

  // Verify audit log integrity
  const integrity = await logger.verifyIntegrity(20);
  console.log("Audit integrity:", integrity.valid ? "VALID" : "BROKEN");
  console.log("Entries checked:", integrity.entriesChecked);
}

viewAuditTrail();
```

::: warning
The audit trail records every transaction attempt, including denied ones. This is critical for monitoring and debugging agent behavior. Always verify integrity periodically.
:::

## Full Working Code

```typescript
import { Keypair } from "@solana/web3.js";
import Anthropic from "@anthropic-ai/sdk";
import {
  AgentWallet,
  LocalSigner,
  MemoryStore,
  SolanaAdapter,
  Policy,
  SpendingLimitRule,
  AllowlistRule,
  RateLimitRule,
  PolicyEngine,
  AuditLogger,
} from "kova";

// --- Wallet Setup ---
const secretKey = Uint8Array.from(JSON.parse(process.env.SOLANA_SECRET_KEY!));
const keypair = Keypair.fromSecretKey(secretKey);

const signer = new LocalSigner(keypair);
const store = new MemoryStore();
const chain = new SolanaAdapter({
  rpcUrl: "https://api.devnet.solana.com",
  commitment: "confirmed",
});

const policy = Policy.create("payment-agent-policy")
  .spendingLimit({
    perTransaction: { amount: "1.0", token: "SOL" },
    daily: { amount: "10.0", token: "SOL" },
  })
  .allowAddresses([
    "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",
    "FxkPQ7oB5E1RW8vwM9BwGhkRwJSmHftCFAi6KhFNiWaP",
    "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH",
  ])
  .rateLimit({
    maxTransactionsPerMinute: 5,
  })
  .build();

const config = policy.toJSON();
const rules = [
  new SpendingLimitRule(config.spendingLimit!),
  new AllowlistRule(config.allowAddresses!),
  new RateLimitRule(config.rateLimit!),
];
const engine = new PolicyEngine(rules, store);
const logger = new AuditLogger(store);

const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  logger,
});

// --- Claude Integration ---
const anthropic = new Anthropic();
const tools = wallet.toAnthropicTools();

const SYSTEM_PROMPT = `You are a payment agent with access to a Solana wallet.
You can check balances, review your spending policy, send SOL payments, and
view transaction history.

Rules you must follow:
- Always check your balance before making a payment.
- Always confirm the recipient address and amount with the user before sending.
- If a payment is denied by policy, explain why to the user.
- Never attempt to circumvent spending limits or allowlist restrictions.
- Report your transaction results clearly.`;

interface Message {
  role: "user" | "assistant";
  content: string | Anthropic.ContentBlock[];
}

async function chat(userMessage: string, messages: Message[]): Promise<string> {
  messages.push({ role: "user", content: userMessage });

  let response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools,
    messages,
  });

  while (response.stop_reason === "tool_use") {
    const assistantContent = response.content;
    messages.push({ role: "assistant", content: assistantContent });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of assistantContent) {
      if (block.type === "tool_use") {
        console.log(`[Tool Call] ${block.name}(${JSON.stringify(block.input)})`);
        const result = await wallet.handleToolCall(
          block.name,
          block.input as Record<string, unknown>
        );
        console.log(`[Tool Result] success=${result.success}`, result.data ?? result.error);

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result.success ? result.data : { error: result.error }),
        });
      }
    }

    messages.push({ role: "user", content: toolResults });

    response = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });
  }

  const textBlocks = response.content.filter(
    (block): block is Anthropic.TextBlock => block.type === "text"
  );
  const finalText = textBlocks.map((b) => b.text).join("\n");
  messages.push({ role: "assistant", content: response.content });

  return finalText;
}

// --- Run the Conversation ---
async function main() {
  const messages: Message[] = [];

  console.log("\n--- User: What is my SOL balance? ---");
  const reply1 = await chat("What is my SOL balance?", messages);
  console.log("Agent:", reply1);

  console.log("\n--- User: What are my spending limits? ---");
  const reply2 = await chat("What are my spending limits?", messages);
  console.log("Agent:", reply2);

  console.log("\n--- User: Send 0.5 SOL to 9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde ---");
  const reply3 = await chat(
    "Send 0.5 SOL to 9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",
    messages
  );
  console.log("Agent:", reply3);

  // View audit trail
  const history = await wallet.getTransactionHistory(20);
  console.log("\n=== Audit Trail ===");
  for (const entry of history) {
    console.log(`[${entry.timestamp}] ${entry.status.toUpperCase()} - ${entry.summary}`);
  }

  const integrity = await logger.verifyIntegrity(20);
  console.log("\nAudit integrity:", integrity.valid ? "VALID" : "BROKEN");
  console.log("Entries checked:", integrity.entriesChecked);
}

main().catch(console.error);
```

## Next Steps

- [Policy Cookbook](/tutorials/policy-cookbook) -- Explore different policy configurations
- [Telegram Approval](/tutorials/telegram-approval) -- Add human oversight for high-value payments
- [API Reference](/api/reference) -- Full reference for all tool definitions
