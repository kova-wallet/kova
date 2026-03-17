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
| **Claude Desktop** | For connecting to the MCP server | [claude.ai/download](https://claude.ai/download) |
| **Funded devnet wallet** | A Solana secret key with devnet SOL | See [Your First Agent Wallet](/tutorials/first-wallet) for setup |

Set your environment variable before starting:

```bash
# Your Solana secret key as a JSON byte array (required for signing transactions)
# Generate one using: solana-keygen new --outfile key.json
# Then copy the contents: cat key.json
export SOLANA_SECRET_KEY='[1,2,3,...,64]'
```

**Expected output:** (none -- environment variables are set silently)

::: details Troubleshooting: Environment variable issues
**If you do not have a Solana secret key yet** -- You can generate one for this tutorial by adding a few lines to the beginning of your script that create a fresh keypair (as we did in [Your First Agent Wallet](/tutorials/first-wallet)). However, the wallet will start with 0 SOL and transfers will fail until you airdrop devnet SOL.

**If you see `SyntaxError: Unexpected token` when parsing the secret key** -- Make sure the value is a valid JSON array of numbers, enclosed in single quotes to prevent shell expansion. Example: `export SOLANA_SECRET_KEY='[174,23,99,...,42]'`.
:::

---

This tutorial shows you how to build a Claude-powered AI agent that can check wallet balances, review its spending policy, and make payments -- all through natural language conversation. The kova SDK provides an MCP server that Claude connects to, automatically discovering all wallet tools.

## Step 1: Install Dependencies

```bash
# Install the three main dependencies for a Claude-powered payment agent:
#   @kova-sdk/wallet                 - The agent wallet SDK (policy engine, signers, chain adapters, MCP server)
#   @modelcontextprotocol/sdk    - MCP SDK for the stdio transport
#   @solana/web3.js              - Solana's JavaScript client for Keypair and address utilities
npm install @kova-sdk/wallet @modelcontextprotocol/sdk @solana/web3.js
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
**If you see `Cannot find module 'kova'`** -- Run `npm install @kova-sdk/wallet` again from your project directory. Verify with `ls node_modules/@kova-sdk/wallet`.

**If you see `Cannot find module '@modelcontextprotocol/sdk'`** -- Run `npm install @modelcontextprotocol/sdk`. This is the MCP SDK needed for the stdio transport.

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
} from "@kova-sdk/wallet";

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
const signer = new LocalSigner(keypair, { network: "devnet" });
// Create an in-memory store for spending counters, rate limits, and audit logs.
const store = new MemoryStore({ dangerouslyAllowInProduction: true });
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

// Assemble the AgentWallet -- this is the single object Claude will interact with.
// The Policy object handles rule evaluation internally.
const wallet = new AgentWallet({
  signer,                        // Signs transactions before broadcast
  chain,                         // Builds and broadcasts Solana transactions
  policy,                        // Evaluates policy rules before allowing any transaction
  store,                         // Shared state for counters, audit log, and idempotency cache
  dangerouslyDisableAuth: true,  // Skip auth for tutorial use
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
1. Your `SOLANA_SECRET_KEY` environment variable is set
2. All packages are installed (`ls node_modules/@kova node_modules/@modelcontextprotocol`)
3. The code above compiles without errors in your editor

If you see `Cannot find name 'AllowlistRule'`, update kova: `npm install @kova-sdk/wallet@latest`.

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

## Step 4: Create the MCP Server

The `createMcpServer()` function creates an MCP server with all wallet tools registered. When Claude connects via MCP, it automatically discovers the available tools -- their names, descriptions, and input schemas.

**MCP (Model Context Protocol)** is an open standard for connecting AI agents to tools. Claude has first-class MCP support. The MCP server exposes tool definitions that describe each operation's name, purpose, and parameters. No secrets, private keys, or internal state are included.

```typescript
import { createMcpServer } from "@kova-sdk/wallet";

// createMcpServer() registers all wallet tools on an MCP server.
// When Claude connects, it discovers these tools automatically:
//   wallet_get_balance           - Query token balance on-chain
//   wallet_get_policy            - Retrieve the active policy summary
//   wallet_transfer              - Execute a SOL or SPL token transfer
//   wallet_swap                  - Execute a token swap via Jupiter
//   wallet_get_transaction_history - Retrieve recent audit log entries
const server = createMcpServer(wallet);
```

Each tool has a name, description, and JSON schema for its input parameters. For example, `wallet_get_balance` looks like:

```json
{
  "name": "wallet_get_balance",
  "description": "Get the balance of a specific token in the wallet.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "token": { "type": "string", "description": "Token symbol (e.g., 'SOL')" }
    },
    "required": ["token"]
  }
}
```

::: tip
Claude discovers these tool definitions automatically via MCP. No additional prompt engineering is needed for Claude to know how to call them.
:::

## Step 5: Start the MCP Server

Connect the MCP server to a transport so Claude can communicate with it. The most common transport is **stdio** -- Claude Desktop and the Claude CLI both support it natively. The MCP server handles the entire <Term id="multi-turn" /> tool-call loop automatically: when Claude calls a tool, the server routes it through `wallet.handleToolCall()` and returns the result.

A **multi-turn conversation** means Claude and your server go back and forth multiple times. Claude calls a tool, the MCP server executes it via the wallet and returns the result, Claude decides what to do next. This continues until Claude has gathered enough information to respond to the user with text.

```typescript
import { createMcpStdioServer } from "@kova-sdk/wallet";

// Start the MCP server on stdio transport.
// Claude Desktop connects to this server and discovers wallet tools automatically.
// The server handles the full tool-call lifecycle:
//   1. Claude discovers available tools (wallet_get_balance, wallet_transfer, etc.)
//   2. Claude calls a tool with input parameters
//   3. The MCP server routes the call through wallet.handleToolCall()
//   4. Policy engine evaluates the request (spending limit, allowlist, rate limit)
//   5. If approved: sign, broadcast, return result
//   6. If denied: return denial with error code
//   7. Claude receives the result and decides what to do next
async function startServer() {
  const server = await createMcpStdioServer(wallet);
  console.error("kova MCP server running on stdio. Connect Claude Desktop to use wallet tools.");
}

startServer().catch(console.error);
```

To connect Claude Desktop to this server, add it to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "payment-agent": {
      "command": "npx",
      "args": ["ts-node", "payment-agent.ts"]
    }
  }
}
```

Once connected, Claude can call wallet tools in natural language conversation. The MCP server handles all tool routing, policy enforcement, and response formatting automatically.

::: details What just happened?
The `createMcpStdioServer()` function does two things in one call:

1. **Creates** an MCP server with all wallet tools registered (same as `createMcpServer(wallet)`)
2. **Connects** it to a stdio transport so Claude can communicate with it

When Claude calls a tool (e.g., `wallet_transfer`), the MCP server routes it through `wallet.handleToolCall()` -- this is where policy checks, signing, and broadcasting happen. The result is returned to Claude via MCP, and Claude decides what to do next.

You do not need to write any tool-routing code, manage conversation history, or implement a loop. The MCP protocol handles all of this.
:::

::: details Troubleshooting: MCP server issues
**If Claude cannot find the tools** -- Make sure the MCP server script is running. Check the `command` and `args` in your `claude_desktop_config.json`. The path must point to your script.

**If you see `Error: ENOENT` when starting** -- The `ts-node` command is not found. Install it with `npm install -D ts-node typescript`.

**If Claude calls the wrong tool** -- You can guide Claude's behavior with the system prompt in Claude Desktop settings. Add instructions like "Always call wallet_get_balance before wallet_transfer."
:::

::: details Checkpoint -- Steps 3 through 5
At this point, you have the three core pieces:
1. A **system prompt** recommendation for Claude (Step 3)
2. An **MCP server** created from the wallet (Step 4)
3. The server **connected to stdio** and ready for Claude (Step 5)

Your file should now have the wallet setup code from Step 2, plus the `createMcpStdioServer()` call. If you are unsure, scroll down to the Full Working Code section and compare.
:::

## Step 6: Test the Conversation

With the MCP server running and Claude Desktop connected, you can test the payment agent through natural conversation. Here is what a typical session looks like when you chat with Claude in Claude Desktop.

**Example conversation in Claude Desktop:**

```
User: What is my SOL balance?
Claude: [calls wallet_get_balance] Your current SOL balance is 4.5 SOL.

User: What are my spending limits?
Claude: [calls wallet_get_policy] Your spending policy allows a maximum of 1 SOL
        per transaction and 10 SOL per day. Only pre-approved addresses can receive
        funds, and you are limited to 5 transactions per minute.

User: Send 0.5 SOL to 9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde
Claude: [calls wallet_get_balance, then wallet_transfer]
        Payment sent! I transferred 0.5 SOL to 9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde.
        Transaction ID: 3xK7m...xyz

User: Send 0.1 SOL to unknownAddr123456789012345678901234567890
Claude: [calls wallet_transfer -- denied by policy]
        I'm unable to send SOL to that address. It is not on the list of approved
        recipient addresses. I can only send funds to pre-approved addresses per
        the wallet's security policy.
```

::: details What just happened?
This four-turn conversation demonstrates the payment agent in action:

1. **Balance check** -- Claude called `wallet_get_balance` via MCP and reported 4.5 SOL.
2. **Policy review** -- Claude called `wallet_get_policy` via MCP and explained the limits in plain English.
3. **Successful payment** -- Claude checked the balance first, then called `wallet_transfer`. The policy engine approved all three rules (spending limit, allowlist, rate limit), and the transaction was confirmed on Solana devnet.
4. **Denied payment** -- Claude tried to send to an unapproved address. The `AllowlistRule` denied it with `ADDRESS_NOT_ALLOWED`. Claude received the denial via MCP and explained it to the user without retrying.

All tool calls are routed through the MCP server to `wallet.handleToolCall()`. The policy engine enforces the rules at the code level regardless of what Claude is instructed to do.
:::

::: details Troubleshooting: Conversation issues
**If Claude does not check the balance before sending** -- Add instructions to Claude's system prompt in Claude Desktop settings: "You MUST call wallet_get_balance before every wallet_transfer call."

**If the transfer fails with "Insufficient balance"** -- Your wallet needs devnet SOL. Airdrop SOL using `solana airdrop 2 <ADDRESS> --url devnet` or the [web faucet](https://faucet.solana.com).

**If you see `ADDRESS_NOT_ALLOWED` on every transfer** -- Make sure the recipient address exactly matches one of the addresses in `.allowAddresses([...])` in Step 2.

**If Claude cannot find the wallet tools** -- Verify the MCP server is running. Check the `command` and `args` in your `claude_desktop_config.json`.
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
      // Error is a TransactionError object with .code and .message properties.
      // For denials: code contains the policy violation (e.g., "ADDRESS_NOT_ALLOWED").
      // For failures: contains the on-chain or network error.
      console.log(`  Error: ${entry.error.code} - ${entry.error.message}`);
    }
    console.log();
  }

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
import {
  AgentWallet,
  LocalSigner,
  MemoryStore,
  SolanaAdapter,
  Policy,
  createMcpStdioServer,
} from "@kova-sdk/wallet";

// --- Wallet Setup ---
// SECURITY WARNING: Environment variables are NOT safe for private keys in production.
// Keys in env vars are exposed via /proc/[pid]/environ, `ps e`, shell history, and logging systems.
// Use MpcSigner with a hardware-backed provider (e.g., Turnkey, Fireblocks) or a secrets manager instead.
// This pattern is acceptable ONLY for local development and testing.
const secretKey = Uint8Array.from(JSON.parse(process.env.SOLANA_SECRET_KEY!));
// Reconstruct the Solana Keypair from the secret key.
const keypair = Keypair.fromSecretKey(secretKey);

// Create the signer, store, and chain adapter.
const signer = new LocalSigner(keypair, { network: "devnet" });
const store = new MemoryStore({ dangerouslyAllowInProduction: true });
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

// Assemble the wallet -- this is the object the MCP server exposes to Claude.
// The Policy object handles rule evaluation internally.
const wallet = new AgentWallet({
  signer,                        // Signs transactions
  chain,                         // Builds and broadcasts to Solana
  policy,                        // Enforces policy rules
  store,                         // Shared state
  dangerouslyDisableAuth: true,  // Skip auth for tutorial use
});

// --- Start the MCP Server ---
// createMcpStdioServer() creates an MCP server with all wallet tools registered
// and connects it to stdio transport. Claude Desktop connects to this server
// and can discover and call wallet tools automatically.
async function main() {
  const server = await createMcpStdioServer(wallet);
  console.error("kova payment agent MCP server running on stdio.");
  console.error("Connect Claude Desktop to use wallet tools.");
}

main().catch(console.error);
```

To run the MCP server:

```bash
npx ts-node payment-agent.ts
```

Then add it to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "payment-agent": {
      "command": "npx",
      "args": ["ts-node", "payment-agent.ts"],
      "env": {
        "SOLANA_SECRET_KEY": "[1,2,3,...,64]"
      }
    }
  }
}
```

Once connected, open Claude Desktop and try these messages:
- "What is my SOL balance?"
- "What are my spending limits?"
- "Send 0.5 SOL to 9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde"

Claude will discover the wallet tools via MCP and handle the conversation automatically.

::: details Troubleshooting: Full example issues
**If you see `SyntaxError: Cannot use import statement outside a module`** -- Make sure your `tsconfig.json` has `"module": "commonjs"` and `"esModuleInterop": true`.

**If Claude cannot find the wallet tools** -- Verify the MCP server is running. Check the path in `claude_desktop_config.json` and restart Claude Desktop.

**If the secret key parsing fails** -- Make sure `SOLANA_SECRET_KEY` is a valid JSON array: `'[1,2,3,...,64]'` (64 numbers).

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
- [Approval Gates](/guide/rules/approval-gate) -- Add human oversight for high-value payments with CallbackApprovalChannel or WebhookApprovalChannel
- [API Reference](/api/reference) -- Full reference for all tool definitions
