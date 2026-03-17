# Giving Claude a Wallet

---

## What You'll Build

In this tutorial, you'll connect a kova wallet to Claude so that an AI agent can check balances, enforce spending policies, and execute blockchain transactions -- all through natural language. You will build a complete server-side integration in about 20 minutes.

By the end, you will have a working system where:
- Claude can call wallet tools (check balance, send SOL, view policy) via MCP (Model Context Protocol)
- Your private key never leaves your server -- Claude only sees tool schemas and results
- A policy engine enforces spending limits, allowlists, and rate limits on every transaction
- You understand the full security model and can extend it for production use

No prior experience with MCP or blockchain development is required.

---

## Prerequisites

Before you start, make sure you have the following:

| Requirement | Details | Check / Install |
|------------|---------|-----------------|
| **Node.js** | 18.0 or later | `node --version` / [nodejs.org](https://nodejs.org/en/download) |
| **npm** | 9.0 or later | `npm --version` / Included with Node.js |
| **Claude Desktop** | For connecting to the MCP server | [claude.ai/download](https://claude.ai/download) |
| **kova basics** | Completed the first wallet tutorial | [Your First Agent Wallet](/tutorials/first-wallet) (recommended but not required) |

You do **not** need the Solana CLI or any blockchain tools installed locally.

---

## The Big Picture

Before we write any code, let's understand the architecture. This diagram shows what lives where:

```
Your Server (Node.js backend)
  ├── Private key lives here (LocalSigner)
  ├── Policy rules live here (PolicyEngine)
  ├── Wallet orchestrates everything (AgentWallet)
  │
  │   MCP Server exposes tools ──────►  Claude (via MCP)
  │   (JSON descriptions, no secrets)    (LLM discovers and calls tools)
  │                                          │
  │   ◄────── Tool call results ────────────┘
  │   wallet.handleToolCall()
  │     → policy check → sign → broadcast
  │     → return success/failure
```

Claude never sees the private key. It only sees tool **schemas** (names + parameter types) and tool **results** (success/failure). Your MCP server handles everything in between.

::: details What just happened?
This is the core security model of kova. Think of it like a bank teller (your server) and a customer (Claude). The customer can ask "What is my balance?" or "Send $50 to this person," but the teller is the one who actually accesses the vault, checks the rules, and moves the money. The customer never touches the vault. In kova terms: Claude connects to your MCP server, discovers tool schemas, calls them, and your server runs `handleToolCall()` internally. The private key, policy engine, and blockchain connection all stay safely on your server.
:::

## Step 0: Prerequisites Check

Before we begin coding, make sure Node.js and npm are installed (see Prerequisites table above). No API key is needed on the server side -- the MCP server exposes wallet tools over a transport (stdio), and Claude connects to it as an MCP client.

## Step 1: Install Dependencies

```bash
npm install @kova/wallet @solana/web3.js @modelcontextprotocol/sdk
```

**Expected output:**

```
added 15 packages in 4s
```

::: details Troubleshooting: Installation issues
**If you see `Cannot find module '@kova/wallet'`** -- Run `npm install @kova/wallet` again. Make sure you are in the correct project directory.

**If you see `Cannot find module '@modelcontextprotocol/sdk'`** -- Run `npm install @modelcontextprotocol/sdk`. This is the official MCP SDK for Node.js.
:::

## Step 2: Create the Wallet on Your Server

This is the developer's responsibility. You create the keypair, define the policy, and wire everything together. The agent never sees any of this.

An **allowlist** is a list of approved wallet addresses. When an allowlist is active, the wallet can only send funds to addresses on that list. Any transfer to an address not on the list will be denied immediately by the policy engine.

```typescript
import { Keypair } from "@solana/web3.js";
import {
  AgentWallet,
  Policy,
  LocalSigner,
  SolanaAdapter,
  MemoryStore,
} from "@kova/wallet";

// The private key stays on your server
const keypair = Keypair.generate();
const signer = new LocalSigner(keypair, { network: "devnet" });

// Define what the agent is allowed to do
const policy = Policy.create("claude-agent")
  .spendingLimit({
    perTransaction: { amount: "1.0", token: "SOL" },
    daily: { amount: "5.0", token: "SOL" },
  })
  .allowAddresses(["9aE4Uy6gzM...", "7bF5Vz8hkN..."]) // only these recipients
  .rateLimit({ maxTransactionsPerMinute: 5 })
  .build();

const store = new MemoryStore({ dangerouslyAllowInProduction: true });

// Create the wallet — this is the single object that ties everything together
const wallet = new AgentWallet({
  signer,
  chain: new SolanaAdapter({ rpcUrl: "https://api.devnet.solana.com" }),
  policy,
  store,
  dangerouslyDisableAuth: true,
});
```

At this point, the wallet exists only on your server. The agent knows nothing about it yet.

::: details What just happened?
We created the entire wallet infrastructure on the server side. Let's break it down:
- **Keypair** -- A fresh cryptographic identity for the wallet (public address + private key for signing).
- **Policy** -- Three guardrails: max 1 SOL per transaction, max 5 SOL per day, and only approved addresses can receive funds.
- **PolicyEngine** -- The enforcer that checks every transaction against those three rules.
- **AgentWallet** -- The single object that ties signer, chain adapter, policy engine, and store together.

None of this is exposed to Claude. The agent will only interact through tool schemas (coming next).
:::

::: details Checkpoint -- Step 2
Before moving on, verify that:
1. You have `@kova/wallet`, `@solana/web3.js`, and `@modelcontextprotocol/sdk` installed (`ls node_modules/@kova/wallet`)
2. The code above compiles without errors (no red squiggly lines in your editor)

If you see `Cannot find name 'AllowlistRule'`, make sure you have the latest version of kova installed: `npm install @kova/wallet@latest`.
:::

## Step 3: Create the MCP Server

Call `createMcpServer(wallet)` to create an MCP server with all wallet tools registered. The MCP server exposes tool schemas -- parameter names, types, and what each tool does. No keys, no addresses, no internal state.

**MCP (Model Context Protocol)** is an open standard for connecting AI agents to tools. Claude has first-class MCP support -- when Claude connects to your MCP server, it automatically discovers available tools and their schemas. This is the same protocol used across AI frameworks (Claude Desktop, OpenAI, LangChain, and custom agents).

```typescript
import { createMcpServer } from "@kova/wallet";

const server = createMcpServer(wallet);
```

When Claude discovers the tools, here is what one tool schema looks like:

```json
{
  "name": "wallet_transfer",
  "description": "Transfer tokens to a recipient address. Sends a specified amount of a token (e.g., SOL, USDC) to the given address on the configured chain.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "to":     { "type": "string", "description": "Recipient wallet address" },
      "amount": { "type": "string", "description": "Amount to send as a decimal string (e.g., \"1.5\")" },
      "token":  { "type": "string", "description": "Token symbol (e.g., \"SOL\", \"USDC\") or mint address" },
      "chain":  { "type": "string", "description": "Target blockchain", "enum": ["solana", "ethereum", "base"] },
      "reason": { "type": "string", "description": "Why this transfer is being made (for audit trail)" }
    },
    "required": ["to", "amount", "token", "chain"]
  }
}
```

The MCP server exposes the following wallet tools:

| Tool | What it does |
|------|-------------|
| `wallet_get_balance` | Check token balance |
| `wallet_get_transaction_history` | View recent transactions |
| `wallet_transfer` | Send tokens to an address |
| `wallet_swap` | Swap one token for another (e.g., SOL to USDC) |
| `wallet_get_policy` | View policy constraints |

To exclude specific tools, pass options when creating the server:

```typescript
const server = createMcpServer(wallet, {
  exclude: ["wallet_swap"],  // exclude tools you don't want the agent to use
});
```

::: details What just happened?
The `createMcpServer()` function created an MCP server with all wallet tools registered. When Claude connects, it discovers these tools automatically -- "Here are the things you can do, and here are the parameters each action needs." Claude uses these descriptions to understand what tools are available and how to call them correctly. Critically, these schemas contain zero sensitive information -- no private keys, no RPC URLs, no internal state. They are safe to expose via MCP.
:::

## Step 4: Connect the MCP Server to a Transport

Connect the MCP server to a transport so Claude can communicate with it. The most common transport is **stdio** -- Claude Desktop and the Claude CLI both support it natively.

```typescript
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Connect the MCP server to stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
// The server is now running -- Claude can discover and call wallet tools
```

Or use the convenience function that does both steps in one call:

```typescript
import { createMcpStdioServer } from "@kova/wallet";

const server = await createMcpStdioServer(wallet);
// Server is running on stdio, ready for Claude to connect
```

To use this with Claude Desktop, add the server to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "kova-wallet": {
      "command": "node",
      "args": ["path/to/your/mcp-server.js"]
    }
  }
}
```

Once connected, Claude automatically discovers the wallet tools and can call them based on user requests. When a user says "Check my balance and send 0.5 SOL to 9aE4Uy6gzM...", Claude will call `wallet_get_balance` first, then `wallet_transfer` -- all routed through the MCP server to your wallet's `handleToolCall()` method.

## Step 5: Claude Discovers and Calls Tools

When Claude connects to your MCP server, it discovers the available wallet tools automatically. Claude analyzes the user's request and decides which tools to call. For example, if the user says "Check my balance and send 0.5 SOL," Claude will call `wallet_get_balance` first.

Claude only sends the tool name and input parameters via MCP -- it has no access to your private key, RPC connection, or policy internals.

::: details What just happened?
When Claude discovers tools via MCP, it does not blindly call them all. It reads the user's message ("Check my balance and send 0.5 SOL...") and reasons about the best sequence of actions. Claude first calls `wallet_get_balance`, then proceeds to `wallet_transfer`. The key insight: Claude only sends a tool *name* and *input parameters* over MCP. Your server decides how to execute it.
:::

## Step 6: How the MCP Server Routes Tool Calls

When Claude calls a tool via MCP, the MCP server automatically routes it through `wallet.handleToolCall()`. This is where the magic happens -- the wallet evaluates the policy, builds the transaction, signs it, and broadcasts it. You do not need to write any tool-routing code yourself; the MCP server handles the entire loop.

The **MCP tool-call flow** works like a conversation: Claude says "I want to call this tool," the MCP server executes it via the wallet and returns the result, Claude decides what to do next. This loop repeats until Claude has all the information it needs and responds with text instead of a tool call.

What happens inside `handleToolCall()` for a transfer:

```
1. Parse tool input → TransactionIntent
2. PolicyEngine.evaluate(intent)
   ├── SpendingLimitRule: is 0.5 SOL under the per-tx limit?  ✓
   ├── AllowlistRule: is the recipient in the allowlist?       ✓
   └── RateLimitRule: under 5 tx/min?                         ✓
3. SolanaAdapter.buildTransaction(intent)
4. LocalSigner.sign(unsignedTx)     ← private key used here, agent never sees it
5. SolanaAdapter.broadcast(signedTx)
6. Return { success: true, data: { status: "confirmed", txId: "5Uj7..." } }
```

If the policy denies the transaction, the result looks like:

```json
{ "success": true, "data": { "status": "denied", "error": { "code": "SPENDING_LIMIT_EXCEEDED" } } }
```

Claude receives this result and can explain the denial to the user.

::: details Troubleshooting: Tool call issues
**If you see `Error: Unknown tool name`** -- The tool name from Claude does not match any registered tool. Make sure you have not excluded required tools via the `exclude` option in `createMcpServer()`.

**If `handleToolCall()` throws an error** -- The MCP server returns a generic error response to Claude. Check your server logs for details.

**If Claude is not discovering tools** -- Verify the MCP server is running and connected. In Claude Desktop, check that your `claude_desktop_config.json` points to the correct script path.
:::

::: details Checkpoint -- Steps 3 through 6
At this point, you have the complete integration pattern:
1. `createMcpServer(wallet)` creates an MCP server with wallet tools (Step 3)
2. You connect the server to a transport (Step 4)
3. Claude discovers and calls tools via MCP (Step 5)
4. The MCP server routes calls through `wallet.handleToolCall()` (Step 6)
5. Results go back to Claude, and the loop repeats

This is the fundamental pattern. Every kova + Claude integration follows these exact steps, regardless of how complex the policy or conversation gets.
:::

## Step 7: Claude Returns the Final Response

Once Claude is done calling tools, it produces a natural language summary for the user. With MCP, this happens automatically -- Claude Desktop displays the response directly to the user.

**Example response from Claude:**

> I checked your balance (4.2 SOL) and sent 0.5 SOL to 9aE4Uy6gzM... The transaction was confirmed with ID `5Uj7...abc`. Your remaining balance is approximately 3.7 SOL.

That is Claude speaking in natural language, summarizing the tool calls it just made. The user never needs to know about tool schemas, policy engines, or blockchain details -- they just see a helpful assistant.

## A Typical Multi-Turn Flow

Here's what a real conversation looks like under the hood:

```
Turn 1: User says "Send 0.5 SOL to 9aE4..."
         Claude calls → wallet_get_policy
         Result: { perTransaction: "1.0 SOL", daily: "5.0 SOL", allowlist: [...] }

Turn 2: Claude calls → wallet_get_balance({ token: "SOL" })
         Result: { amount: "4.2", token: "SOL" }

Turn 3: Claude calls → wallet_transfer({ to: "9aE4...", amount: "0.5", token: "SOL", chain: "solana" })
         Result: { status: "confirmed", txId: "5Uj7..." }

Turn 4: Claude responds with text:
         "Done! I sent 0.5 SOL to 9aE4... Transaction ID: 5Uj7..."
```

Each turn, your backend:
1. Receives Claude's tool call (just a name + JSON input)
2. Routes it through `wallet.handleToolCall()`
3. Returns the result (just a JSON response)

The private key, RPC connection, and policy rules never leave your server.

::: details What just happened?
Notice how Claude made *three* tool calls before responding to the user. It checked the policy first (to know what it is allowed to do), then checked the balance (to make sure there are enough funds), and finally executed the transfer. This multi-step reasoning is exactly why you want an LLM as the agent -- it handles the decision-making, while kova handles the security and execution.
:::

## Full Working Example

```typescript
import { Keypair } from "@solana/web3.js";
import {
  AgentWallet,
  Policy,
  LocalSigner,
  SolanaAdapter,
  MemoryStore,
  createMcpStdioServer,
} from "@kova/wallet";

const TREASURY = "9aE4Uy6gzM..."; // your recipient address

// ── 1. Create the wallet (server-side, agent never sees this) ──

function createWallet(): AgentWallet {
  const keypair = Keypair.generate();
  const store = new MemoryStore({ dangerouslyAllowInProduction: true });

  const policy = Policy.create("claude-agent")
    .spendingLimit({
      perTransaction: { amount: "1.0", token: "SOL" },
      daily: { amount: "5.0", token: "SOL" },
    })
    .allowAddresses([TREASURY])
    .rateLimit({ maxTransactionsPerMinute: 5 })
    .build();

  return new AgentWallet({
    signer: new LocalSigner(keypair, { network: "devnet" }),
    chain: new SolanaAdapter({ rpcUrl: "https://api.devnet.solana.com" }),
    policy,
    store,
    dangerouslyDisableAuth: true,
  });
}

// ── 2. Start the MCP server ──

async function main() {
  const wallet = createWallet();

  // Start the MCP server on stdio -- Claude connects and discovers wallet tools
  const server = await createMcpStdioServer(wallet);
  console.log("kova MCP server running on stdio. Connect Claude to use wallet tools.");
}

main().catch(console.error);
```

To run the full example:

```bash
npx ts-node claude-wallet.ts
```

Then configure Claude Desktop to connect to this server by adding it to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "kova-wallet": {
      "command": "npx",
      "args": ["ts-node", "claude-wallet.ts"]
    }
  }
}
```

Once connected, Claude can check balances, review the policy, and send transactions -- all through natural language. If the wallet has no funds, Claude will report the balance and explain it cannot send.

::: details Troubleshooting: Full example issues
**If Claude cannot find the wallet tools** -- Make sure the MCP server script is running. Check the path in `claude_desktop_config.json`.

**If the transaction is denied with `ADDRESS_NOT_ALLOWED`** -- The recipient address is not in the allowlist. Update the `TREASURY` variable and the `.allowAddresses([...])` array to match.

**If you see `Insufficient balance`** -- Your wallet has no devnet SOL. Airdrop SOL to the wallet's address using `solana airdrop 2 <ADDRESS> --url devnet` or the [web faucet](https://faucet.solana.com).
:::

## Security Summary

| Layer | What it does | Who controls it |
|-------|-------------|----------------|
| **Private key** | Signs transactions | Your server (LocalSigner) |
| **Policy engine** | Enforces spending limits, allowlists, rate limits | Your server (PolicyEngine) |
| **Tool schemas** | Describes available operations | Passed to Claude (JSON only) |
| **Tool calls** | Agent decides what to do | Claude (LLM) |
| **handleToolCall()** | Validates, signs, broadcasts | Your server |
| **System prompt** | Guides agent behavior | Your server (but not a security boundary) |

The system prompt helps Claude behave well, but the policy engine is what actually enforces limits. Even if Claude tried to send 100 SOL, the `SpendingLimitRule` would deny it before it ever reached the signer.

::: warning
The system prompt is **not** a security boundary. An adversarial user could potentially manipulate Claude through prompt injection to ignore system prompt instructions. That is why kova enforces all limits at the policy engine level -- a layer Claude cannot bypass. Never rely solely on the system prompt for security-critical constraints.
:::

## What to Try Next

You now have a working Claude + kova integration. Here are three challenges to go deeper:

1. **Test the allowlist.** Change the transfer recipient to an address that is NOT in the allowlist and observe the `ADDRESS_NOT_ALLOWED` denial. Then have Claude explain the denial to the user -- notice how it provides a natural language explanation automatically.

2. **Add a multi-step conversation.** Instead of a single `runAgent()` call, build a loop that reads user input from `process.stdin` and passes each message to `chat()`. This creates an interactive terminal agent that remembers context across turns.

3. **Connect a different AI client.** Since kova uses MCP as its sole agent interface, any MCP-compatible AI client can connect to the same server -- Claude Desktop, OpenAI, LangChain, or custom agents. See the [OpenAI Integration guide](/guide/ai-integration/openai) for details.

## Next Steps

- [Policy Cookbook](/tutorials/policy-cookbook) -- Advanced policy configurations
- [Approval Gates](/guide/rules/approval-gate) -- Add human-in-the-loop for high-value transactions with CallbackApprovalChannel or WebhookApprovalChannel
- [OpenAI Integration](/guide/ai-integration/openai) -- Same pattern with GPT-4
- [LangChain Integration](/guide/ai-integration/langchain) -- Use kova tools in LangChain agents
