# Giving Claude a Wallet

---

## What You'll Build

In this tutorial, you'll connect a kova wallet to Claude so that an AI agent can check balances, enforce spending policies, and execute blockchain transactions -- all through natural language. You will build a complete server-side integration in about 20 minutes.

By the end, you will have a working system where:
- Claude can call wallet tools (check balance, send SOL, view policy) via the Anthropic Messages API
- Your private key never leaves your server -- Claude only sees tool schemas and results
- A policy engine enforces spending limits, allowlists, and rate limits on every transaction
- You understand the full security model and can extend it for production use

No prior experience with Claude's tool-use API or blockchain development is required.

---

## Prerequisites

Before you start, make sure you have the following:

| Requirement | Details | Check / Install |
|------------|---------|-----------------|
| **Node.js** | 18.0 or later | `node --version` / [nodejs.org](https://nodejs.org/en/download) |
| **npm** | 9.0 or later | `npm --version` / Included with Node.js |
| **Anthropic API key** | Starts with `sk-ant-...` | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) |
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
  │   Exposes only tool schemas ──────►  Claude API
  │   (JSON descriptions, no secrets)    (LLM decides which tools to call)
  │                                          │
  │   ◄────── Tool call results ────────────┘
  │   wallet.handleToolCall()
  │     → policy check → sign → broadcast
  │     → return success/failure
```

Claude never sees the private key. It only sees tool **schemas** (names + parameter types) and tool **results** (success/failure). Your backend handles everything in between.

::: details What just happened?
This is the core security model of kova. Think of it like a bank teller (your server) and a customer (Claude). The customer can ask "What is my balance?" or "Send $50 to this person," but the teller is the one who actually accesses the vault, checks the rules, and moves the money. The customer never touches the vault. In kova terms: Claude calls tool schemas, your server runs `handleToolCall()`, and the private key, policy engine, and blockchain connection all stay safely on your server.
:::

## Step 0: Set Your API Key

Before we begin coding, export your Anthropic API key as an environment variable. This is how the Anthropic SDK authenticates your requests.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

**Expected output:** (none -- environment variables are set silently)

To verify it worked:

```bash
echo $ANTHROPIC_API_KEY
```

**Expected output:**

```
sk-ant-...   (your key, partially shown)
```

::: details Troubleshooting: API key issues
**If you see `Error: Missing API key`** later when running the code -- Your environment variable is not set. Make sure you ran the `export` command in the same terminal session where you run the script. Environment variables do not persist across terminal sessions unless you add them to your shell profile (`.bashrc`, `.zshrc`, etc.).

**If you see `Error: 401 Unauthorized`** -- Your API key is invalid or expired. Generate a new one at [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys).

**If you are on Windows** -- Use `set ANTHROPIC_API_KEY=sk-ant-...` in Command Prompt, or `$env:ANTHROPIC_API_KEY = "sk-ant-..."` in PowerShell.
:::

## Step 1: Install Dependencies

```bash
npm install @kova/wallet @solana/web3.js @anthropic-ai/sdk
```

**Expected output:**

```
added 15 packages in 4s
```

::: details Troubleshooting: Installation issues
**If you see `Cannot find module '@kova/wallet'`** -- Run `npm install @kova/wallet` again. Make sure you are in the correct project directory.

**If you see `Cannot find module '@anthropic-ai/sdk'`** -- Run `npm install @anthropic-ai/sdk`. This is the official Anthropic SDK for Node.js.
:::

## Step 2: Create the Wallet on Your Server

This is the developer's responsibility. You create the keypair, define the policy, and wire everything together. The agent never sees any of this.

An **allowlist** is a list of approved wallet addresses. When an allowlist is active, the wallet can only send funds to addresses on that list. Any transfer to an address not on the list will be denied immediately by the policy engine.

```typescript
import { Keypair } from "@solana/web3.js";
import Anthropic from "@anthropic-ai/sdk";
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
1. You have `kova`, `@solana/web3.js`, and `@anthropic-ai/sdk` installed (`ls node_modules/@kova/wallet`)
2. Your `ANTHROPIC_API_KEY` environment variable is set (`echo $ANTHROPIC_API_KEY`)
3. The code above compiles without errors (no red squiggly lines in your editor)

If you see `Cannot find name 'AllowlistRule'`, make sure you have the latest version of kova installed: `npm install @kova/wallet@latest`.
:::

## Step 3: Export Tool Schemas for Claude

Call `wallet.toAnthropicTools()` to get an array of JSON tool definitions. These are just descriptions -- parameter names, types, and what each tool does. No keys, no addresses, no internal state.

**Tool schemas** are JSON objects that describe what operations are available, what parameters they accept, and what they return. Claude reads these descriptions and decides which tool to call based on the user's request. This is the same pattern used by OpenAI function calling, LangChain tools, and other agent frameworks.

```typescript
const tools = wallet.toAnthropicTools();
```

Here's what one tool schema looks like:

```json
{
  "name": "wallet_transfer",
  "description": "Transfer tokens to a recipient address. Sends a specified amount of a token (e.g., SOL, USDC) to the given address on the configured chain.",
  "input_schema": {
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

By default, only 2 read-only tools are enabled (`wallet_get_balance` and `wallet_get_transaction_history`). To enable write tools like `wallet_transfer`, you must explicitly opt in via `enabledTools`:

| Tool | What it does | Default |
|------|-------------|---------|
| `wallet_get_balance` | Check token balance | Enabled |
| `wallet_get_transaction_history` | View recent transactions | Enabled |
| `wallet_transfer` | Send tokens to an address | Opt-in |
| `wallet_swap` | Swap one token for another (e.g., SOL to USDC) | Opt-in |
| `wallet_get_policy` | View policy constraints | Opt-in |

To enable write tools, pass `enabledTools` when generating tool schemas:

```typescript
const tools = wallet.toAnthropicTools({
  enabledTools: [
    "wallet_get_balance",
    "wallet_get_transaction_history",
    "wallet_get_policy",
    "wallet_transfer",
  ],
});
```

::: details What just happened?
The `toAnthropicTools()` method generated a set of JSON descriptions that tell Claude: "Here are the things you can do, and here are the parameters each action needs." Claude uses these descriptions to understand what tools are available and how to call them correctly. Critically, these schemas contain zero sensitive information -- no private keys, no RPC URLs, no internal state. They are safe to send to the Claude API.
:::

## Step 4: Pass the Schemas to Claude

Send the tool schemas along with your user message to the Claude API. Claude sees the tool descriptions and decides when to use them.

The **system prompt** is a special message that sets Claude's behavior for the entire conversation. It is not visible to the end user but strongly influences how Claude responds. In this case, we tell Claude to always check the policy and balance before making transactions.

```typescript
const anthropic = new Anthropic();

const messages: Anthropic.MessageParam[] = [
  { role: "user", content: "Check my balance and send 0.5 SOL to 9aE4Uy6gzM..." },
];

let response = await anthropic.messages.create({
  model: "claude-sonnet-4-6-20250827",
  max_tokens: 1024,
  system: `You are a payment assistant with access to a crypto wallet.
Always check wallet_get_policy before your first transaction.
Always check wallet_get_balance before sending funds.
If a transaction is denied, explain why and do not retry.`,
  tools,     // <-- the schemas from Step 2
  messages,
});
```

**Expected output:** (this is the raw API response -- you will see a JSON object)

```json
{
  "stop_reason": "tool_use",
  "content": [
    {
      "type": "tool_use",
      "id": "toolu_01ABC...",
      "name": "wallet_get_balance",
      "input": { "token": "SOL" }
    }
  ]
}
```

Claude chose to check the balance first -- exactly what we asked it to do in the system prompt.

## Step 5: Claude Decides to Call a Tool

Claude analyzes the user's request and decides which tools to call. The response comes back with `stop_reason: "tool_use"` and one or more `tool_use` blocks:

```json
{
  "stop_reason": "tool_use",
  "content": [
    {
      "type": "tool_use",
      "id": "toolu_01ABC...",
      "name": "wallet_get_balance",
      "input": { "token": "SOL" }
    }
  ]
}
```

Claude chose to check the balance first. Notice it only sends the tool name and input parameters -- it has no access to your private key, RPC connection, or policy internals.

::: details What just happened?
When Claude receives tool schemas, it does not blindly call them all. It reads the user's message ("Check my balance and send 0.5 SOL...") and reasons about the best sequence of actions. Because the system prompt says "Always check balance before sending," Claude first calls `wallet_get_balance`. The key insight: Claude only returns a tool *name* and *input parameters*. Your server decides how to execute it.
:::

## Step 6: Route the Tool Call Through Your Wallet

Your backend receives Claude's tool call and routes it through `wallet.handleToolCall()`. This is where the magic happens -- the wallet evaluates the policy, builds the transaction, signs it, and broadcasts it.

The **tool-use loop** is the core pattern for Claude tool calling. It works like a conversation: Claude says "I want to call this tool," your server executes it and returns the result, Claude decides what to do next. This loop repeats until Claude has all the information it needs and responds with text instead of a tool call.

```typescript
while (response.stop_reason === "tool_use") {
  const toolResults: Anthropic.ToolResultBlockParam[] = [];

  for (const block of response.content) {
    if (block.type === "tool_use") {
      // This is where policy check → sign → broadcast happens
      const result = await wallet.handleToolCall(
        block.name,
        block.input as Record<string, unknown>,
      );

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }
  }

  // Feed the results back to Claude for the next turn
  messages.push({ role: "assistant", content: response.content });
  messages.push({ role: "user", content: toolResults });

  response = await anthropic.messages.create({
    model: "claude-sonnet-4-6-20250827",
    max_tokens: 1024,
    system: `You are a payment assistant with access to a crypto wallet.
Always check wallet_get_policy before your first transaction.
Always check wallet_get_balance before sending funds.
If a transaction is denied, explain why and do not retry.`,
    tools,
    messages,
  });
}
```

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

::: details Troubleshooting: Tool-use loop issues
**If the loop never exits** -- Make sure you are checking `response.stop_reason === "tool_use"` (not `response.stop_reason !== "end_turn"`). Claude may return other stop reasons like `"max_tokens"`.

**If you see `Error: Unknown tool name`** -- The tool name from Claude does not match any tool in your wallet. Make sure you are passing the exact `tools` array from `wallet.toAnthropicTools()` and not modifying the tool names.

**If `handleToolCall()` throws an error** -- Check that `block.input` is a valid object. You may need to add error handling around the `handleToolCall()` call.
:::

::: details Checkpoint -- Steps 3 through 6
At this point, you have the complete integration pattern:
1. `wallet.toAnthropicTools()` generates tool schemas (Step 3)
2. You pass schemas to `anthropic.messages.create()` (Step 4)
3. Claude returns `tool_use` blocks (Step 5)
4. You route them through `wallet.handleToolCall()` (Step 6)
5. Results go back to Claude, and the loop repeats

This is the fundamental pattern. Every kova + Claude integration follows these exact steps, regardless of how complex the policy or conversation gets.
:::

## Step 7: Claude Returns the Final Response

Once Claude is done calling tools, `stop_reason` changes to `"end_turn"` and the response contains a text block with Claude's summary:

```typescript
const textBlocks = response.content.filter(
  (block): block is Anthropic.TextBlock => block.type === "text",
);
const reply = textBlocks.map((b) => b.text).join("\n");
console.log(reply);
```

**Expected output:**

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
import Anthropic from "@anthropic-ai/sdk";
import {
  AgentWallet,
  Policy,
  LocalSigner,
  SolanaAdapter,
  MemoryStore,
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

// ── 2. Run the agent loop ──

async function runAgent(wallet: AgentWallet, userMessage: string): Promise<string> {
  const anthropic = new Anthropic();
  const tools = wallet.toAnthropicTools();

  const systemPrompt = `You are a payment assistant with access to a crypto wallet.
Always check wallet_get_policy before your first transaction.
Always check wallet_get_balance before sending funds.
If a transaction is denied, explain why and do not retry.
Include a "reason" in every transfer for the audit trail.`;

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  let response = await anthropic.messages.create({
    model: "claude-sonnet-4-6-20250827",
    max_tokens: 1024,
    system: systemPrompt,
    tools,
    messages,
  });

  // Tool-use loop
  while (response.stop_reason === "tool_use") {
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type === "tool_use") {
        const result = await wallet.handleToolCall(
          block.name,
          block.input as Record<string, unknown>,
        );
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }
    }

    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });

    response = await anthropic.messages.create({
      model: "claude-sonnet-4-6-20250827",
      max_tokens: 1024,
      system: systemPrompt,
      tools,
      messages,
    });
  }

  const textBlocks = response.content.filter(
    (block): block is Anthropic.TextBlock => block.type === "text",
  );
  return textBlocks.map((b) => b.text).join("\n");
}

// ── 3. Run it ──

async function main() {
  const wallet = createWallet();

  const reply = await runAgent(
    wallet,
    `Check my policy and balance, then send 0.5 SOL to ${TREASURY}.`,
  );

  console.log(reply);
}

main().catch(console.error);
```

To run the full example:

```bash
npx ts-node claude-wallet.ts
```

**Expected output:**

```
I checked your policy and balance. Here's a summary:

- **Policy**: Max 1 SOL per transaction, max 5 SOL per day, transfers only to approved addresses.
- **Balance**: 0 SOL

Unfortunately, I cannot send 0.5 SOL because your wallet balance is 0 SOL. You'll need to fund the wallet first.
```

(If the wallet is funded, Claude will report a successful transfer with a transaction ID instead.)

::: details Troubleshooting: Full example issues
**If you see `Error: Missing API key`** -- Set your `ANTHROPIC_API_KEY` environment variable (see Step 0).

**If you see `Error: 429 Too Many Requests`** -- You have hit the Anthropic API rate limit. Wait a few seconds and try again, or check your plan's rate limits at [console.anthropic.com](https://console.anthropic.com).

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

3. **Swap the LLM.** Replace the Anthropic client with the OpenAI SDK (see the [OpenAI Integration guide](/guide/ai-integration/openai)). Since kova tool schemas follow the standard function-calling format, the wallet code stays exactly the same -- only the LLM client changes.

## Next Steps

- [Policy Cookbook](/tutorials/policy-cookbook) -- Advanced policy configurations
- [Approval Gates](/guide/rules/approval-gate) -- Add human-in-the-loop for high-value transactions with CallbackApprovalChannel or WebhookApprovalChannel
- [OpenAI Integration](/guide/ai-integration/openai) -- Same pattern with GPT-4
- [LangChain Integration](/guide/ai-integration/langchain) -- Use kova tools in LangChain agents
