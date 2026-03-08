# Building a Payment Agent with Claude

---

## What You'll Build

In this tutorial, you'll build a fully functional AI payment agent -- a Claude-powered assistant that can check wallet balances, review spending policies, send SOL payments, and maintain a complete audit trail. All through natural conversation, in about 25 minutes.

By the end, you will have:
- A multi-turn conversational agent that handles payments via natural language
- An allowlist-restricted wallet that only sends to pre-approved addresses
- Policy denials that Claude explains to the user automatically
- A tamper-evident audit trail with SHA-256 hash chain integrity verification

This tutorial builds on the concepts from [Your First Agent Wallet](/tutorials/first-wallet) and [Giving Claude a Wallet](/tutorials/claude-agent-integration). If you have not completed those yet, you can still follow along -- every concept is explained inline.

---

## Prerequisites

Before you start, make sure you have the following:

| Requirement | Details | Check / Install |
|------------|---------|-----------------|
| **Node.js** | 18.0 or later | `node --version` / [nodejs.org](https://nodejs.org/en/download) |
| **npm** | 9.0 or later | `npm --version` / Included with Node.js |
| **TypeScript** | 5.0 or later | `npx tsc --version` / Installed via `npm install -D typescript` |
| **Anthropic API key** | Starts with `sk-ant-...` | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) |
| **Funded devnet wallet** | A Solana secret key with devnet SOL | See [Your First Agent Wallet](/tutorials/first-wallet) for setup |

Set your environment variables before starting:

```bash
# Your Anthropic API key (required for Claude)
export ANTHROPIC_API_KEY=sk-ant-...

# Your Solana secret key as a JSON byte array (required for signing transactions)
# Generate one using: solana-keygen new --outfile key.json
# Then copy the contents: cat key.json
export SOLANA_SECRET_KEY='[1,2,3,...,64]'
```

**Expected output:** (none -- environment variables are set silently)

::: details Troubleshooting: Environment variable issues
**If you do not have a Solana secret key yet** -- You can generate one for this tutorial by adding a few lines to the beginning of your script that create a fresh keypair (as we did in [Your First Agent Wallet](/tutorials/first-wallet)). However, the wallet will start with 0 SOL and transfers will fail until you airdrop devnet SOL.

**If you see `SyntaxError: Unexpected token` when parsing the secret key** -- Make sure the value is a valid JSON array of numbers, enclosed in single quotes to prevent shell expansion. Example: `export SOLANA_SECRET_KEY='[174,23,99,...,42]'`.

**If you see `Error: Missing API key`** -- Make sure you ran the `export ANTHROPIC_API_KEY=...` command in the same terminal session where you will run the script.
:::

---

This tutorial shows you how to build a Claude-powered AI agent that can check wallet balances, review its spending policy, and make payments -- all through natural language conversation. The kova SDK provides native <Term id="tool-definitions">tool definitions</Term> that plug directly into the Anthropic Messages API.

## Step 1: Install Dependencies

```bash
# Install the three main dependencies for a Claude-powered payment agent:
#   kova              - The agent wallet SDK (policy engine, signers, chain adapters, tool definitions)
#   @anthropic-ai/sdk - Official Anthropic SDK for calling the Claude Messages API
#   @solana/web3.js   - Solana's JavaScript client for Keypair and address utilities
npm install kova @anthropic-ai/sdk @solana/web3.js
```

**Expected output:**

```
added 15 packages in 4s
```

Also install TypeScript tooling if you have not already:

```bash
npm install -D typescript ts-node @types/node
```

::: details Troubleshooting: Installation issues
**If you see `Cannot find module 'kova'`** -- Run `npm install kova` again from your project directory. Verify with `ls node_modules/kova`.

**If you see `Cannot find module '@anthropic-ai/sdk'`** -- Run `npm install @anthropic-ai/sdk`. This is the official Anthropic SDK for calling the Claude Messages API.

**If you see version conflicts** -- Delete `node_modules` and `package-lock.json`, then run `npm install` again: `rm -rf node_modules package-lock.json && npm install`.
:::

## Step 2: Set Up the Wallet with Policy

We create a wallet with a conservative policy: spending limits, an <Term id="allowlist" /> of approved addresses, and rate limiting. This is the server-side setup that Claude will never see directly.

An **allowlist** is a whitelist of wallet addresses that are approved to receive funds. If the agent tries to send to an address not on the list, the policy engine blocks the transaction immediately. This is a powerful security feature -- even if Claude's reasoning is manipulated, it literally cannot send funds to unauthorized addresses.

```typescript
import { Keypair } from "@solana/web3.js";
import {
  AgentWallet,        // Top-level wallet that AI agents interact with
  LocalSigner,        // Signs transactions using an in-memory Solana Keypair
  MemoryStore,        // In-memory state store for dev/testing
  SolanaAdapter,      // Chain adapter for Solana (build tx, broadcast, query balance)
  Policy,             // Fluent builder for policy configuration
  SpendingLimitRule,  // Enforces per-transaction and daily spending caps
  AllowlistRule,      // Restricts which addresses can receive funds
  RateLimitRule,      // Enforces max transactions per time window
  PolicyEngine,       // Evaluates rules sequentially against each intent
  AuditLogger,        // Records all transaction attempts in a tamper-evident hash chain
} from "kova";

// ⚠️ SECURITY WARNING: Environment variables are NOT safe for private keys in production.
// Keys in env vars are exposed via /proc/[pid]/environ, `ps e`, shell history, and logging systems.
// Use MpcSigner with a hardware-backed provider (e.g., Turnkey, Fireblocks) or a secrets manager instead.
// See the MPC Signing tutorial: /tutorials/turnkey-mpc
// This pattern is acceptable ONLY for local development and testing.
const secretKey = Uint8Array.from(JSON.parse(process.env.SOLANA_SECRET_KEY!));
// Reconstruct the Keypair from the secret key bytes.
// This gives us both the public key (wallet address) and private key (for signing).
const keypair = Keypair.fromSecretKey(secretKey);

// Wrap the keypair in a LocalSigner so it implements the Signer interface.
const signer = new LocalSigner(keypair); // Dev-only; throws in production unless KOVA_ALLOW_LOCAL_SIGNER=1
// Create an in-memory store for spending counters, rate limits, and audit logs.
const store = new MemoryStore(); // Dev-only; throws in production unless KOVA_ALLOW_MEMORY_STORE=1
// Connect to Solana devnet. The chain adapter handles all RPC communication.
const chain = new SolanaAdapter({
  rpcUrl: "https://api.devnet.solana.com",  // Devnet RPC endpoint (free, rate-limited)
  commitment: "confirmed",                   // Wait for supermajority confirmation (~400ms)
});

// Build a conservative policy for the payment agent.
// This defines the guardrails that prevent the AI from overspending.
const policy = Policy.create("payment-agent-policy")
  .spendingLimit({
    perTransaction: { amount: "1.0", token: "SOL" },  // No single payment can exceed 1 SOL
    daily: { amount: "10.0", token: "SOL" },           // Total daily spending capped at 10 SOL
  })
  .allowAddresses([
    // Only these three addresses can receive funds from this agent.
    // Transfers to any other address will be denied by the AllowlistRule.
    "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",
    "FxkPQ7oB5E1RW8vwM9BwGhkRwJSmHftCFAi6KhFNiWaP",
    "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH",
  ])
  .rateLimit({
    maxTransactionsPerMinute: 5,  // Prevent rapid-fire payments (max 5 per rolling minute)
  })
  .build();

// Extract the serialized policy config and create concrete rule instances.
const config = policy.toJSON();
const rules = [
  new SpendingLimitRule(config.spendingLimit!),  // Checks per-tx and daily spending caps
  new AllowlistRule(config.allowAddresses!),      // Checks recipient is on the approved list
  new RateLimitRule(config.rateLimit!),            // Checks transaction frequency
];
// Create the policy engine that evaluates all rules for each transaction.
const engine = new PolicyEngine(rules, store);
// Create the audit logger for tamper-evident transaction recording.
const logger = new AuditLogger(store);

// Assemble the AgentWallet -- this is the single object Claude will interact with.
const wallet = new AgentWallet({
  signer,         // Signs transactions before broadcast
  chain,          // Builds and broadcasts Solana transactions
  policy: engine, // Evaluates policy rules before allowing any transaction
  store,          // Shared state for counters, audit log, and idempotency cache
  logger,         // Records all transaction attempts in the hash chain
});
```

::: details What just happened?
We set up the entire payment infrastructure on the server side:
- **Secret key** is loaded from an environment variable (never hardcoded).
- **Policy** has three layers of protection: spending limits (max 1 SOL per tx, 10 SOL daily), an allowlist (only 3 approved recipients), and rate limiting (max 5 tx per minute).
- **PolicyEngine** will check all three rules for every transaction, in order. If any rule says "deny," the transaction is blocked before it ever reaches the signer.
- **AuditLogger** records every attempt (success, denial, or failure) in a tamper-evident SHA-256 hash chain -- like an immutable ledger.

None of this setup is exposed to Claude. The AI agent only sees tool schemas and tool results.
:::

::: details Checkpoint -- Step 2
Before moving on, verify:
1. Your `SOLANA_SECRET_KEY` and `ANTHROPIC_API_KEY` environment variables are set
2. All packages are installed (`ls node_modules/kova node_modules/@anthropic-ai`)
3. The code above compiles without errors in your editor

If you see `Cannot find name 'AllowlistRule'`, update kova: `npm install kova@latest`.

If you see `Error: Cannot read properties of undefined (reading 'fromSecretKey')`, your `SOLANA_SECRET_KEY` environment variable is not set or is not valid JSON.
:::

## Step 3: Define the System Prompt

The <Term id="system-prompt" /> tells Claude what it can do and how to behave responsibly. A good system prompt reduces unnecessary tool calls, prevents the agent from retrying denied transactions, and ensures clear communication with the user.

```typescript
// The system prompt instructs Claude on its role, capabilities, and constraints.
// It explicitly lists the policy rules so Claude can proactively inform users
// about limitations rather than blindly attempting transactions that will be denied.
// A well-crafted system prompt reduces unnecessary tool calls and improves UX.
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

::: details What just happened?
The system prompt is like a job description for Claude. It tells Claude what role it plays (payment agent), what tools it has access to (wallet operations), and what rules it must follow (check balance first, do not retry denials). By listing the policy limits directly in the prompt, Claude can warn users *before* attempting a transaction that would be denied -- for example, if a user asks to send 5 SOL, Claude can say "That exceeds my 1 SOL per-transaction limit" without even calling the wallet.

Important: the system prompt guides behavior but is **not** a security boundary. The policy engine enforces all limits at the code level, regardless of what the system prompt says.
:::

## Step 4: Get Tools from the Wallet

The `toAnthropicTools()` method returns tool definitions in the exact format the Anthropic Messages API expects. These are JSON schemas that describe what operations are available -- Claude reads them and decides which to call.

**Tool definitions** (also called "function definitions" in other frameworks) are JSON objects that describe an operation's name, purpose, and parameters. The AI agent reads these descriptions to understand what it can do. No secrets, private keys, or internal state are included.

```typescript
// toAnthropicTools() generates an array of tool definitions in the exact format
// the Anthropic Messages API expects. Each tool has a name, description, and
// JSON schema for its input parameters. This allows Claude to discover and
// correctly call wallet operations without any additional prompt engineering.
// Available tools include:
//   wallet_get_balance           - Query token balance on-chain
//   wallet_get_address           - Get the wallet's Solana public address
//   wallet_get_policy            - Retrieve the active policy summary
//   wallet_transfer              - Execute a SOL or SPL token transfer
//   wallet_swap                  - Execute a token swap via Jupiter
//   wallet_get_transaction_history - Retrieve recent audit log entries
const tools = wallet.toAnthropicTools();
```

**Expected output:** (if you log the tools)

```typescript
console.log(JSON.stringify(tools[0], null, 2));
```

```json
{
  "name": "wallet_get_balance",
  "description": "Get the balance of a specific token in the wallet.",
  "input_schema": {
    "type": "object",
    "properties": {
      "token": { "type": "string", "description": "Token symbol (e.g., 'SOL')" }
    },
    "required": ["token"]
  }
}
```

::: tip
These tool definitions include full JSON schemas for input parameters and clear descriptions. Claude will know exactly how to call them without any additional prompting.
:::

## Step 5: Write the Tool-Use Loop

This function drives the <Term id="multi-turn" /> conversation. When Claude responds with `tool_use` blocks, we execute them via `wallet.handleToolCall()` and feed the results back. This loop is the heart of every Claude agent integration.

A **multi-turn conversation** means Claude and your server go back and forth multiple times. Claude calls a tool, your server returns the result, Claude decides what to do next. This continues until Claude has gathered enough information to respond to the user with text.

```typescript
// Import the official Anthropic SDK for calling the Claude Messages API.
import Anthropic from "@anthropic-ai/sdk";

// Initialize the Anthropic client. It reads ANTHROPIC_API_KEY from the environment
// automatically (no need to pass the key explicitly).
const anthropic = new Anthropic();

// Type for conversation messages. Content can be a plain string (user text)
// or an array of ContentBlocks (assistant responses with text + tool_use blocks).
interface Message {
  role: "user" | "assistant";
  content: string | Anthropic.ContentBlock[];
}

// chat() drives a multi-turn conversation with Claude. It handles the tool-use
// loop: when Claude responds with tool_use blocks, we execute them via the
// wallet and feed results back until Claude produces a final text response.
async function chat(userMessage: string, messages: Message[]): Promise<string> {
  // Append the user's message to the conversation history.
  messages.push({ role: "user", content: userMessage });

  // Send the conversation to Claude with the system prompt and tool definitions.
  let response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",  // Claude model to use
    max_tokens: 1024,                      // Maximum tokens in Claude's response
    system: SYSTEM_PROMPT,                 // Instructions that define Claude's behavior
    tools,                                 // Wallet tool definitions from toAnthropicTools()
    messages,                              // Full conversation history for context
  });

  // Loop until Claude stops calling tools (stop_reason will be "end_turn" when done).
  // Each iteration: execute the requested tool calls, send results back, get next response.
  while (response.stop_reason === "tool_use") {
    // Save Claude's response (which contains tool_use blocks) to the conversation.
    const assistantContent = response.content;
    messages.push({ role: "assistant", content: assistantContent });

    // Collect results for all tool calls in this response.
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    // Iterate over each content block in Claude's response.
    // A response can contain multiple tool_use blocks (parallel tool calls).
    for (const block of assistantContent) {
      if (block.type === "tool_use") {
        // Log the tool call for debugging (shows tool name and input params).
        console.log(`[Tool Call] ${block.name}(${JSON.stringify(block.input)})`);

        // Execute the tool call via the wallet's handleToolCall() method.
        // This routes to the appropriate wallet method (getBalance, transfer, etc.)
        // and returns a standardized { success, data?, error? } result.
        const result = await wallet.handleToolCall(
          block.name,                              // e.g., "wallet_transfer"
          block.input as Record<string, unknown>   // e.g., { to: "...", amount: "0.5", token: "SOL" }
        );

        // Log the result for debugging.
        console.log(`[Tool Result] success=${result.success}`, result.data ?? result.error);

        // Format the result as a tool_result block for the Anthropic API.
        // The tool_use_id links this result back to the specific tool call.
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,  // Must match the tool_use block's id
          content: JSON.stringify(result.success ? result.data : { error: result.error }),
        });
      }
    }

    // Send tool results back to Claude as a "user" message.
    // The Anthropic API requires tool results to be sent in the user role.
    messages.push({ role: "user", content: toolResults });

    // Get Claude's next response (it may call more tools or produce final text).
    response = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });
  }

  // Claude is done calling tools -- extract the final text response.
  // Filter for TextBlock content blocks (ignore any non-text blocks).
  const textBlocks = response.content.filter(
    (block): block is Anthropic.TextBlock => block.type === "text"
  );
  // Join all text blocks into a single string (usually there is just one).
  const finalText = textBlocks.map((b) => b.text).join("\n");

  // Save Claude's final response to the conversation history for future turns.
  messages.push({ role: "assistant", content: response.content });

  return finalText;
}
```

::: details What just happened?
The `chat()` function implements the complete tool-use loop pattern:

1. **Send** the user's message to Claude along with tool definitions
2. **Check** if Claude wants to call a tool (`stop_reason === "tool_use"`)
3. **Execute** each tool call via `wallet.handleToolCall()` -- this is where policy checks, signing, and broadcasting happen
4. **Return** the results to Claude
5. **Repeat** until Claude responds with text instead of a tool call

The `[Tool Call]` and `[Tool Result]` console logs let you see exactly what is happening under the hood. In production, you might replace these with structured logging.

The conversation `messages` array accumulates the full history, so Claude has context from previous turns. This is how the agent "remembers" earlier balance checks and policy reviews.
:::

::: details Troubleshooting: Tool-use loop issues
**If the loop runs forever** -- Make sure you are checking `response.stop_reason === "tool_use"` (not `!== "end_turn"`). Claude can also stop with `"max_tokens"` if the response is too long.

**If you see `Error: tool_use_id not found`** -- The `tool_use_id` in your tool result does not match any `tool_use` block's `id`. Make sure you are using `block.id` from the original tool call, not generating your own IDs.

**If Claude calls the wrong tool** -- Check your system prompt. If Claude is not checking the balance before sending, add explicit instructions like "Always call wallet_get_balance before wallet_transfer."
:::

::: details Checkpoint -- Steps 3 through 5
At this point, you have the three core pieces:
1. A **system prompt** that tells Claude how to behave (Step 3)
2. **Tool definitions** generated from the wallet (Step 4)
3. A **chat function** that handles the multi-turn tool-use loop (Step 5)

Your file should now have the wallet setup code from Step 2, plus the `SYSTEM_PROMPT`, `tools`, and `chat()` function. If you are unsure, scroll down to the Full Working Code section and compare.
:::

## Step 6: Run a Conversation

Now let us simulate a user asking the agent to check their balance and send a payment. This is where everything comes together.

```typescript
async function main() {
  // Initialize an empty conversation history. This array accumulates all
  // user messages, assistant responses, and tool results across turns.
  // Claude uses the full history for context in each subsequent turn.
  const messages: Message[] = [];

  // Turn 1: User asks to check balance.
  // Claude will use the wallet_get_balance tool to fetch the SOL balance,
  // then return a natural language response with the amount.
  console.log("\n--- User: What is my SOL balance? ---");
  const reply1 = await chat("What is my SOL balance?", messages);
  console.log("Agent:", reply1);
  // Claude calls wallet_get_balance({ token: "SOL" })
  // Agent: Your current SOL balance is 4.5 SOL.

  // Turn 2: User asks about the policy.
  // Claude will use wallet_get_policy to retrieve the active policy summary,
  // then explain the spending limits and allowlist in plain language.
  console.log("\n--- User: What are my spending limits? ---");
  const reply2 = await chat("What are my spending limits?", messages);
  console.log("Agent:", reply2);
  // Claude calls wallet_get_policy()
  // Agent: Your policy allows max 1 SOL per transaction and 10 SOL per day.
  //        Only approved addresses can receive funds.

  // Turn 3: User asks to send a payment to an allowed address.
  // Claude will first check the balance (per the system prompt instructions),
  // then call wallet_transfer. The policy engine evaluates spending limit,
  // allowlist, and rate limit rules before the transaction proceeds.
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

  // Turn 4: User asks to send to an address NOT on the allowlist.
  // The AllowlistRule will deny this intent with ADDRESS_NOT_ALLOWED.
  // Claude will receive the denial and explain it to the user.
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

// Run the conversation and log any unhandled errors.
main().catch(console.error);
```

**Expected terminal output (complete run):**

```
--- User: What is my SOL balance? ---
[Tool Call] wallet_get_balance({"token":"SOL"})
[Tool Result] success=true { token: "SOL", amount: "4.5", decimals: 9 }
Agent: Your current SOL balance is 4.5 SOL.

--- User: What are my spending limits? ---
[Tool Call] wallet_get_policy()
[Tool Result] success=true { spendingLimits: { perTransaction: "1.0 SOL", daily: "10.0 SOL" }, ... }
Agent: Your spending policy allows a maximum of 1 SOL per transaction and 10 SOL per day. Only pre-approved addresses can receive funds, and you are limited to 5 transactions per minute.

--- User: Send 0.5 SOL to 9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde ---
[Tool Call] wallet_get_balance({"token":"SOL"})
[Tool Result] success=true { token: "SOL", amount: "4.5", decimals: 9 }
[Tool Call] wallet_transfer({"to":"9aE476...","amount":"0.5","token":"SOL","chain":"solana"})
[Tool Result] success=true { status: "confirmed", txId: "3xK7m...xyz" }
Agent: Payment sent! I transferred 0.5 SOL to 9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde. Transaction ID: 3xK7m...xyz

--- User: Send 0.1 SOL to unknownAddr123... ---
[Tool Call] wallet_transfer({"to":"unknownAddr123...","amount":"0.1","token":"SOL","chain":"solana"})
[Tool Result] success=true { status: "denied", error: { code: "ADDRESS_NOT_ALLOWED" } }
Agent: I'm unable to send SOL to that address. It is not on the list of approved recipient addresses. I can only send funds to pre-approved addresses per the wallet's security policy.
```

::: details What just happened?
You just ran a four-turn conversation between a user and an AI payment agent:

1. **Balance check** -- Claude called `wallet_get_balance` and reported 4.5 SOL.
2. **Policy review** -- Claude called `wallet_get_policy` and explained the limits in plain English.
3. **Successful payment** -- Claude checked the balance first, then called `wallet_transfer`. The policy engine approved all three rules (spending limit, allowlist, rate limit), and the transaction was confirmed on Solana devnet.
4. **Denied payment** -- Claude tried to send to an unapproved address. The `AllowlistRule` denied it with `ADDRESS_NOT_ALLOWED`. Claude received the denial and explained it to the user without retrying.

Notice how Claude naturally follows the system prompt instructions: it checks the balance before sending, and it explains denials instead of retrying. The policy engine enforces the rules at the code level regardless.
:::

::: details Troubleshooting: Conversation issues
**If Claude does not check the balance before sending** -- Strengthen your system prompt: "You MUST call wallet_get_balance before every wallet_transfer call."

**If the transfer fails with "Insufficient balance"** -- Your wallet needs devnet SOL. Airdrop SOL using `solana airdrop 2 <ADDRESS> --url devnet` or the [web faucet](https://faucet.solana.com).

**If you see `ADDRESS_NOT_ALLOWED` on every transfer** -- Make sure the recipient address in your `chat()` call exactly matches one of the addresses in `.allowAddresses([...])` in Step 2.

**If you see `Error: 429 Too Many Requests`** -- You have hit the Anthropic API rate limit. Wait a few seconds between turns, or check your rate limits at [console.anthropic.com](https://console.anthropic.com).
:::

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

::: details What just happened?
This diagram shows the full round-trip for a single payment. Notice how Claude made two tool calls for one user request (balance check + transfer). This is by design -- the system prompt instructs Claude to always verify funds before sending. Also notice that the policy evaluation (spending limit, allowlist, rate limit) happens entirely on your server, inside `handleToolCall()`. Claude sees only the final result: "confirmed" or "denied."
:::

::: details Checkpoint -- Steps 6 and 7
At this point, you have a fully working payment agent. To verify:
1. Your script runs without errors (`npx ts-node payment-agent.ts`)
2. You see `[Tool Call]` and `[Tool Result]` logs for each step
3. The balance check returns a number (even if it is 0)
4. The policy check returns spending limits and allowlist info
5. The transfer either succeeds (if funded) or fails with "Insufficient balance"

If the agent seems to be making too many or too few tool calls, adjust the system prompt. Claude follows the prompt's instructions closely.
:::

## Step 8: View the Audit Trail

After the conversation, inspect the full audit trail. The **audit trail** is a complete record of every transaction attempt -- confirmed, denied, and failed. It uses a SHA-256 hash chain, where each entry includes the hash of the previous entry, making it tamper-evident (like a blockchain within your wallet).

```typescript
async function viewAuditTrail() {
  // Retrieve the last 20 audit log entries. This includes ALL transaction
  // attempts: confirmed, denied, and failed. Even denied transactions are
  // logged, which is critical for monitoring agent behavior and debugging.
  const history = await wallet.getTransactionHistory(20);

  console.log("\n=== Audit Trail ===");
  // Iterate over each audit entry and display its details.
  for (const entry of history) {
    console.log(`[${entry.timestamp}] ${entry.status.toUpperCase()}`);
    console.log(`  Intent: ${entry.intentId}`);   // UUID for traceability and idempotency
    console.log(`  Summary: ${entry.summary}`);    // Human-readable description
    if (entry.txId) {
      // txId is only present for transactions that were actually submitted to Solana.
      // Denied transactions will not have a txId.
      console.log(`  Tx ID: ${entry.txId}`);
    }
    if (entry.error) {
      // Error is present for denied and failed transactions.
      // For denials: contains the policy violation (e.g., "ADDRESS_NOT_ALLOWED").
      // For failures: contains the on-chain or network error.
      console.log(`  Error: ${entry.error}`);
    }
    console.log();
  }

  // Verify the integrity of the audit log's SHA-256 hash chain.
  // Each entry contains the hash of the previous entry. If any entry
  // has been modified, inserted, or deleted, the chain will be broken.
  // The parameter (20) specifies how many recent entries to verify.
  const integrity = await logger.verifyIntegrity(20);
  console.log("Audit integrity:", integrity.valid ? "VALID" : "BROKEN");
  console.log("Entries checked:", integrity.entriesChecked);
  // If integrity.valid is false, integrity.firstBrokenAt will indicate
  // the index of the first corrupted entry.
}

// Call the audit trail function after the conversation completes.
viewAuditTrail();
```

**Expected output:**

```
=== Audit Trail ===
[2025-01-15T10:30:00.000Z] CONFIRMED
  Intent: a1b2c3d4-e5f6-7890-abcd-ef1234567890
  Summary: Transferred 0.5 SOL to 9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde
  Tx ID: 3xK7m...xyz

[2025-01-15T10:30:05.000Z] DENIED
  Intent: b2c3d4e5-f6a7-8901-bcde-f12345678901
  Summary: Transfer denied: ADDRESS_NOT_ALLOWED
  Error: ADDRESS_NOT_ALLOWED

Audit integrity: VALID
Entries checked: 2
```

Notice that the denied transaction is also recorded. This is by design -- the audit trail captures everything for compliance and debugging. If someone asks "Did the agent try to send money to an unauthorized address?", the audit trail has the answer.

::: warning
The audit trail records every transaction attempt, including denied ones. This is critical for monitoring and debugging agent behavior. Always verify integrity periodically.
:::

::: details What just happened?
Two important things happened here:

1. **Transaction history** -- `getTransactionHistory(20)` retrieved the last 20 audit log entries. Each entry records the timestamp, status (CONFIRMED/DENIED/FAILED), a summary, and optional txId and error fields. Even the denied transfer to the unauthorized address is recorded.

2. **Integrity verification** -- `logger.verifyIntegrity(20)` checked the SHA-256 hash chain of the last 20 entries. Each entry stores the hash of the previous entry. If any entry were modified, deleted, or inserted after the fact, the chain would break and `integrity.valid` would return `false`. This makes the audit trail tamper-evident -- you can prove that the log has not been altered.
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
// ⚠️ SECURITY WARNING: Environment variables are NOT safe for private keys in production.
// Keys in env vars are exposed via /proc/[pid]/environ, `ps e`, shell history, and logging systems.
// Use MpcSigner with a hardware-backed provider (e.g., Turnkey, Fireblocks) or a secrets manager instead.
// This pattern is acceptable ONLY for local development and testing.
const secretKey = Uint8Array.from(JSON.parse(process.env.SOLANA_SECRET_KEY!));
// Reconstruct the Solana Keypair from the secret key.
const keypair = Keypair.fromSecretKey(secretKey);

// Create the signer, store, and chain adapter.
const signer = new LocalSigner(keypair);          // Dev-only; throws in production unless KOVA_ALLOW_LOCAL_SIGNER=1
const store = new MemoryStore();                   // Dev-only; throws in production unless KOVA_ALLOW_MEMORY_STORE=1
const chain = new SolanaAdapter({
  rpcUrl: "https://api.devnet.solana.com",         // Devnet RPC endpoint
  commitment: "confirmed",                          // Wait for supermajority confirmation
});

// Build the payment agent's policy with conservative guardrails.
const policy = Policy.create("payment-agent-policy")
  .spendingLimit({
    perTransaction: { amount: "1.0", token: "SOL" },  // Max 1 SOL per transaction
    daily: { amount: "10.0", token: "SOL" },           // Max 10 SOL per day total
  })
  .allowAddresses([
    // Only these pre-approved addresses can receive funds.
    "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",
    "FxkPQ7oB5E1RW8vwM9BwGhkRwJSmHftCFAi6KhFNiWaP",
    "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH",
  ])
  .rateLimit({
    maxTransactionsPerMinute: 5,  // Prevent rapid-fire spending
  })
  .build();

// Create rule instances from the policy config and assemble the engine.
const config = policy.toJSON();
const rules = [
  new SpendingLimitRule(config.spendingLimit!),  // Checks per-tx and daily caps
  new AllowlistRule(config.allowAddresses!),      // Checks recipient is approved
  new RateLimitRule(config.rateLimit!),            // Checks transaction frequency
];
const engine = new PolicyEngine(rules, store);     // Evaluates rules sequentially
const logger = new AuditLogger(store);             // SHA-256 hash chain audit log

// Assemble the wallet -- this is the object Claude interacts with via tools.
const wallet = new AgentWallet({
  signer,         // Signs transactions
  chain,          // Builds and broadcasts to Solana
  policy: engine, // Enforces policy rules
  store,          // Shared state
  logger,         // Records all transaction attempts
});

// --- Claude Integration ---
// Initialize the Anthropic client (reads ANTHROPIC_API_KEY from env automatically).
const anthropic = new Anthropic();
// Generate tool definitions for the Anthropic Messages API.
const tools = wallet.toAnthropicTools();

// System prompt defines Claude's role and behavioral constraints.
const SYSTEM_PROMPT = `You are a payment agent with access to a Solana wallet.
You can check balances, review your spending policy, send SOL payments, and
view transaction history.

Rules you must follow:
- Always check your balance before making a payment.
- Always confirm the recipient address and amount with the user before sending.
- If a payment is denied by policy, explain why to the user.
- Never attempt to circumvent spending limits or allowlist restrictions.
- Report your transaction results clearly.`;

// Message type for the conversation history.
interface Message {
  role: "user" | "assistant";
  content: string | Anthropic.ContentBlock[];
}

// Multi-turn chat function: sends user message, handles tool calls in a loop,
// and returns Claude's final text response.
async function chat(userMessage: string, messages: Message[]): Promise<string> {
  messages.push({ role: "user", content: userMessage });

  let response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools,
    messages,
  });

  // Tool-use loop: keep executing tools until Claude produces a final text response.
  while (response.stop_reason === "tool_use") {
    const assistantContent = response.content;
    messages.push({ role: "assistant", content: assistantContent });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of assistantContent) {
      if (block.type === "tool_use") {
        console.log(`[Tool Call] ${block.name}(${JSON.stringify(block.input)})`);
        // Execute the tool call via wallet.handleToolCall().
        const result = await wallet.handleToolCall(
          block.name,
          block.input as Record<string, unknown>
        );
        console.log(`[Tool Result] success=${result.success}`, result.data ?? result.error);

        // Format the result for the Anthropic API.
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result.success ? result.data : { error: result.error }),
        });
      }
    }

    // Send tool results back and get Claude's next response.
    messages.push({ role: "user", content: toolResults });
    response = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });
  }

  // Extract final text from Claude's response.
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

  // Turn 1: Check balance
  console.log("\n--- User: What is my SOL balance? ---");
  const reply1 = await chat("What is my SOL balance?", messages);
  console.log("Agent:", reply1);

  // Turn 2: Check spending policy
  console.log("\n--- User: What are my spending limits? ---");
  const reply2 = await chat("What are my spending limits?", messages);
  console.log("Agent:", reply2);

  // Turn 3: Send payment to an allowed address
  console.log("\n--- User: Send 0.5 SOL to 9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde ---");
  const reply3 = await chat(
    "Send 0.5 SOL to 9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",
    messages
  );
  console.log("Agent:", reply3);

  // View the audit trail after the conversation.
  // Every transaction attempt (confirmed, denied, failed) is recorded.
  const history = await wallet.getTransactionHistory(20);
  console.log("\n=== Audit Trail ===");
  for (const entry of history) {
    console.log(`[${entry.timestamp}] ${entry.status.toUpperCase()} - ${entry.summary}`);
  }

  // Verify the SHA-256 hash chain integrity of the audit log.
  const integrity = await logger.verifyIntegrity(20);
  console.log("\nAudit integrity:", integrity.valid ? "VALID" : "BROKEN");
  console.log("Entries checked:", integrity.entriesChecked);
}

main().catch(console.error);
```

To run the complete example:

```bash
npx ts-node payment-agent.ts
```

**Expected output (full run):**

```
--- User: What is my SOL balance? ---
[Tool Call] wallet_get_balance({"token":"SOL"})
[Tool Result] success=true { token: "SOL", amount: "4.5", decimals: 9 }
Agent: Your current SOL balance is 4.5 SOL.

--- User: What are my spending limits? ---
[Tool Call] wallet_get_policy()
[Tool Result] success=true { ... }
Agent: Your wallet has the following spending policy:
- Maximum 1 SOL per transaction
- Maximum 10 SOL per day
- Only pre-approved addresses can receive funds
- Maximum 5 transactions per minute

--- User: Send 0.5 SOL to 9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde ---
[Tool Call] wallet_get_balance({"token":"SOL"})
[Tool Result] success=true { token: "SOL", amount: "4.5", decimals: 9 }
[Tool Call] wallet_transfer({"to":"9aE476...","amount":"0.5","token":"SOL","chain":"solana"})
[Tool Result] success=true { status: "confirmed", txId: "3xK7m...xyz" }
Agent: Payment sent! I transferred 0.5 SOL to 9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde. Transaction ID: 3xK7m...xyz

=== Audit Trail ===
[2025-01-15T10:30:00.000Z] CONFIRMED - Transferred 0.5 SOL to 9aE476...

Audit integrity: VALID
Entries checked: 1
```

::: details Troubleshooting: Full example issues
**If you see `SyntaxError: Cannot use import statement outside a module`** -- Make sure your `tsconfig.json` has `"module": "commonjs"` and `"esModuleInterop": true`.

**If you see `Error: Missing API key`** -- Set your `ANTHROPIC_API_KEY` environment variable: `export ANTHROPIC_API_KEY=sk-ant-...`

**If the secret key parsing fails** -- Make sure `SOLANA_SECRET_KEY` is a valid JSON array: `export SOLANA_SECRET_KEY='[1,2,3,...,64]'` (64 numbers).

**If every transfer is denied** -- Check that the recipient address matches one in your `.allowAddresses([...])` list. Addresses must match exactly (case-sensitive, no extra spaces).

**If you see `Insufficient balance`** -- Airdrop devnet SOL: `solana airdrop 2 <YOUR_ADDRESS> --url devnet` or use [faucet.solana.com](https://faucet.solana.com).
:::

## What to Try Next

Congratulations -- you have a fully functional AI payment agent. Here are three challenges to take it further:

1. **Test the spending limit in conversation.** Ask Claude to "Send 2 SOL to 9aE476..." (above the 1 SOL per-transaction limit). Watch how Claude handles the denial -- it should explain the policy violation to the user in natural language without retrying. Now ask "What about 0.9 SOL?" and see it succeed.

2. **Add a deny-list.** Modify the policy to use `.denyAddresses(["SCAM_ADDRESS_HERE"])` instead of (or in addition to) `.allowAddresses(...)`. Then ask Claude to send to the denied address. This shows how you can block specific known-bad addresses while allowing everything else.

3. **Build an interactive terminal agent.** Replace the hardcoded conversation turns in `main()` with a `readline` loop that reads user input from the terminal. You will have a live, interactive payment agent you can chat with. Here is a starting point:
   ```typescript
   const readline = require('readline');
   const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
   rl.on('line', async (line) => {
     const reply = await chat(line, messages);
     console.log("Agent:", reply);
   });
   ```

## Next Steps

- [Policy Cookbook](/tutorials/policy-cookbook) -- Explore different policy configurations
- [Telegram Approval](/tutorials/telegram-approval) -- Add human oversight for high-value payments
- [API Reference](/api/reference) -- Full reference for all tool definitions
