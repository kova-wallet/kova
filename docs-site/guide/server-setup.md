# Server Setup

> **What you'll learn:** Why you need a server between your AI agent and the blockchain, how to build a minimal Express server that exposes kova as an HTTP API, how to test it with curl, and how to adapt the pattern for your preferred HTTP framework.

kova is an SDK, not a hosted service. You need to run your own server that sits between the AI agent and the blockchain. This page explains why, and gives you a working server you can deploy.

::: tip New to this architecture?
If you are coming from a traditional web development background, think of it this way: the AI model (Claude, GPT-4) is like a frontend client -- it can only make "API calls" (tool calls). Your server is the backend that actually does things (holds the private key, checks policy, signs transactions). The AI never directly touches the blockchain, just like a browser never directly touches your database.
:::

## Why You Need a Server

The AI agent (Claude, GPT-4, etc.) cannot interact with the blockchain directly. It can only call tools. Your server is responsible for:

1. **Holding the private key** — the agent never sees it
2. **Running the policy engine** — evaluating every request against your rules
3. **Signing and broadcasting** — building Solana transactions and submitting them
4. **Returning results** — sending success/failure back to the agent

```
┌──────────┐     tool call      ┌──────────────┐     signed tx     ┌──────────┐
│  Claude   │ ────────────────► │  Your Server  │ ────────────────► │  Solana  │
│  (Agent)  │ ◄──────────────── │  (kova SDK)   │ ◄──────────────── │  Network │
└──────────┘     tool result    └──────────────┘     confirmation   └──────────┘
```

Without a server, there is nowhere to run the SDK. The agent only receives JSON tool schemas and sends back JSON tool calls — it never executes TypeScript code.

## Prerequisites

- **Node.js 18 or later** ([download here](https://nodejs.org/))
- **An Anthropic API key** -- get one at [console.anthropic.com](https://console.anthropic.com/)
- **A Solana keypair** -- generate one with `solana-keygen new --outfile wallet-keypair.json` (install the [Solana CLI](https://docs.solanalabs.com/cli/install) first)
- **Basic familiarity with Express** (or any HTTP framework) -- if you have built a REST API before, you are ready
- **About 15 minutes** to get the server running

## Minimal Express Server

Here is a complete, working server that exposes kova as an HTTP API. It handles Claude tool calls and returns results.

### Install Dependencies

```bash
# Create a new project and install all dependencies.
# express         - HTTP server framework
# @anthropic-ai/sdk - Claude API client for tool-use conversations
# kova            - The wallet SDK
# @solana/web3.js - Solana client library for Keypair loading
npm init -y
npm install express @anthropic-ai/sdk kova @solana/web3.js
npm install -D typescript ts-node @types/express @types/node
```

### Environment Variables

```bash
# .env (do NOT commit this file)
#
# Your Anthropic API key — get one at https://console.anthropic.com/
ANTHROPIC_API_KEY=sk-ant-...
# Path to the Solana keypair JSON file (array of 64 bytes).
# Generate one with: solana-keygen new --outfile wallet-keypair.json
WALLET_KEYPAIR_PATH=./wallet-keypair.json
# Solana RPC endpoint. Use devnet for testing, mainnet-beta for production.
SOLANA_RPC_URL=https://api.devnet.solana.com
```

### Server Code

Create `server.ts`:

```typescript
// Import the HTTP framework. Express handles routing, JSON parsing, and
// request/response management so you can focus on the wallet logic.
import express from "express";
// Import the Anthropic SDK for communicating with Claude.
import Anthropic from "@anthropic-ai/sdk";
// Import Solana's Keypair class for loading the wallet's private key.
import { Keypair } from "@solana/web3.js";
// Import the kova SDK components needed to build the wallet.
import {
  AgentWallet,        // The main wallet object that handles tool calls
  LocalSigner,        // Signs transactions using a local Solana keypair
  MemoryStore,        // In-memory state store (use SqliteStore in production)
  SolanaAdapter,      // Builds and broadcasts Solana transactions
  Policy,             // Fluent builder for defining policy rules
  PolicyEngine,       // Evaluates rules against each transaction intent
  SpendingLimitRule,  // Caps per-transaction and daily spending
  RateLimitRule,      // Limits transactions per time window
} from "kova";
// Import Node.js fs for reading the keypair file from disk.
import { readFileSync } from "fs";

// --- 1. Load the Solana keypair from disk ---
// The keypair file is a JSON array of 64 bytes (32-byte secret key + 32-byte public key).
// In production, load from a secrets manager (AWS Secrets Manager, Vault, etc.)
// instead of a local file.
const keypairData = JSON.parse(
  readFileSync(process.env.WALLET_KEYPAIR_PATH!, "utf-8")
);
const keypair = Keypair.fromSecretKey(Uint8Array.from(keypairData));

// --- 2. Set up the kova wallet ---
// Create the shared state store. MemoryStore loses data on restart.
// For production, use SqliteStore for persistence.
const store = new MemoryStore();

// Define the policy: what the agent is allowed to do.
// These rules are enforced server-side — the agent cannot bypass them.
const policy = Policy.create("server-agent")
  .spendingLimit({
    perTransaction: { amount: "1", token: "SOL" },  // Max 1 SOL per transaction
    daily: { amount: "10", token: "SOL" },           // Max 10 SOL per day
  })
  .rateLimit({
    maxTransactionsPerMinute: 5,   // Max 5 transactions per minute
    maxTransactionsPerHour: 30,    // Max 30 transactions per hour
  })
  .build();

// Create rule instances from the policy config.
const config = policy.toJSON();
const engine = new PolicyEngine([
  new RateLimitRule(config.rateLimit!),          // Cheapest check first
  new SpendingLimitRule(config.spendingLimit!),  // More expensive check second
], store);

// Assemble the wallet with all components.
const wallet = new AgentWallet({
  signer: new LocalSigner(keypair),
  chain: new SolanaAdapter({ rpcUrl: process.env.SOLANA_RPC_URL! }),
  policy: engine,
  store,
});

// --- 3. Set up the Anthropic client ---
// The SDK reads ANTHROPIC_API_KEY from the environment automatically.
const anthropic = new Anthropic();
// Convert kova's 8 wallet tools into Anthropic's expected format.
// These schemas tell Claude what tools are available and how to call them.
const tools = wallet.toAnthropicTools();

// System prompt that guides Claude's behavior.
// This is NOT a security boundary — the policy engine is.
// But it helps Claude behave responsibly within those limits.
const SYSTEM_PROMPT = `You are a helpful payment assistant with access to a crypto wallet.

RULES:
- Always call wallet_get_policy before your first transaction to understand your constraints.
- Always call wallet_get_balance before sending funds to verify sufficient balance.
- If a transaction is denied, explain the reason to the user. Do NOT retry the same request.
- Include a "reason" field in all transfers explaining why the payment is being made.
- Never reveal internal wallet addresses, private keys, or RPC endpoints.`;

// --- 4. Create the Express server ---
const app = express();
// Parse incoming JSON request bodies (Claude tool calls come as JSON).
app.use(express.json());

// POST /chat — The main endpoint. Accepts a user message, runs the Claude
// tool-use loop, and returns Claude's final text response.
app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing 'message' field in request body" });
    }

    // Initialize the conversation with the user's message.
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: message },
    ];

    // Send the first request to Claude with the wallet tools.
    let response = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    // Tool-use loop: keep going until Claude produces a final text response.
    // Each iteration processes Claude's tool calls and feeds results back.
    while (response.stop_reason === "tool_use") {
      const assistantContent = response.content;
      messages.push({ role: "assistant", content: assistantContent });

      // Execute each tool call through the kova wallet.
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of assistantContent) {
        if (block.type === "tool_use") {
          console.log(`[Tool] ${block.name}`, block.input);

          // This is the key line: the wallet handles the tool call,
          // runs it through the policy engine, signs if approved,
          // and returns a standardized result.
          const result = await wallet.handleToolCall(
            block.name,
            block.input as Record<string, unknown>,
          );

          console.log(`[Result] success=${result.success}`);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        }
      }

      // Send tool results back to Claude.
      messages.push({ role: "user", content: toolResults });
      response = await anthropic.messages.create({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });
    }

    // Extract Claude's final text response.
    const textBlock = response.content.find((b) => b.type === "text");
    const reply = textBlock?.text ?? "No response generated.";

    res.json({ reply });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /health — Simple health check endpoint.
// Returns the wallet address and policy name to verify the server is running.
app.get("/health", async (_req, res) => {
  const address = await wallet.getAddress();
  res.json({
    status: "ok",
    walletAddress: address,
    policy: policy.getName(),
  });
});

// Start the server on port 3000 (or PORT from environment).
const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`kova server running on http://localhost:${PORT}`);
  console.log(`Wallet: ${keypair.publicKey.toBase58()}`);
  console.log(`Policy: ${policy.getName()}`);
});
```

### Run It

```bash
# Start the server using ts-node (runs TypeScript directly without compiling).
npx ts-node server.ts
```

### Test It

```bash
# Send a chat message to the server.
# Claude will use the wallet tools to check balance and execute the request.
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What is my SOL balance?"}'

# Check server health and wallet info.
curl http://localhost:3000/health
```

## Testing with curl

Here are the exact curl commands you can use to test your server, along with the expected responses. Run these from a second terminal window while the server is running.

### Health check

```bash
curl http://localhost:3000/health
```

**Expected response:**

```json
{
  "status": "ok",
  "walletAddress": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  "policy": "server-agent"
}
```

If you see this, the server is running, the wallet keypair loaded correctly, and the policy engine is initialized.

### Check balance

```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What is my SOL balance?"}'
```

**Expected response:**

```json
{
  "reply": "Your current SOL balance is 2.5 SOL."
}
```

Behind the scenes, Claude called the `wallet_get_balance` tool, received the balance data, and formatted a human-readable response. Your exact balance will differ.

### Check policy

```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What are my spending limits?"}'
```

**Expected response:**

```json
{
  "reply": "Your wallet policy has the following constraints:\n- Per-transaction limit: 1 SOL\n- Daily limit: 10 SOL\n- Rate limit: 5 transactions per minute, 30 per hour"
}
```

### Send a transfer

```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Send 0.1 SOL to 9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde"}'
```

**Expected response (if approved by policy):**

```json
{
  "reply": "I've sent 0.1 SOL to 9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde. Transaction ID: 5Uj7kE..."
}
```

**Expected response (if denied by policy):**

```json
{
  "reply": "I'm sorry, but the transfer was denied by the wallet policy. The reason was: Transfer exceeds per-transaction limit of 1 SOL."
}
```

### Trigger a policy denial

```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Send 5 SOL to 9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde"}'
```

**Expected response:**

```json
{
  "reply": "I'm unable to send 5 SOL because it exceeds the per-transaction spending limit of 1 SOL. If you need to send a larger amount, you may want to adjust the wallet policy."
}
```

### Missing message field

```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Expected response:**

```json
{
  "error": "Missing 'message' field in request body"
}
```

::: details What just happened?
When you sent a curl request to `POST /chat`, the server:

1. Received your JSON message and validated the `message` field.
2. Sent the message to Claude's API along with the 8 wallet tool schemas.
3. Claude decided which tools to call (e.g., `wallet_get_balance`, then `wallet_transfer`).
4. For each tool call, the server invoked `wallet.handleToolCall()`, which ran the request through the policy engine, built the transaction, signed it, and broadcast it.
5. The server sent the tool results back to Claude.
6. Claude generated a human-readable summary and the server returned it as the `reply` field.

The entire Claude tool-use loop (steps 2-6) can involve multiple round trips. For a transfer, Claude typically makes 2-3 tool calls: check policy, check balance, then transfer.
:::

## What This Server Does

When a request hits `POST /chat`:

```
1. Your frontend/client sends: { "message": "Send 0.5 SOL to Alice" }
                │
                ▼
2. Server sends message to Claude API with wallet tool schemas
                │
                ▼
3. Claude responds with tool_use blocks:
   wallet_get_balance({ token: "SOL" })
                │
                ▼
4. Server calls wallet.handleToolCall("wallet_get_balance", { token: "SOL" })
   → Policy engine: N/A (read-only)
   → Returns: { success: true, data: { amount: "4.5", token: "SOL" } }
                │
                ▼
5. Server sends result back to Claude
                │
                ▼
6. Claude responds with another tool_use:
   wallet_transfer({ to: "Alice...", amount: "0.5", token: "SOL", chain: "solana" })
                │
                ▼
7. Server calls wallet.handleToolCall("wallet_transfer", {...})
   → Policy engine: SpendingLimitRule ✓, RateLimitRule ✓ → ALLOW
   → Build transaction → Sign → Broadcast → Confirmed
   → Returns: { success: true, data: { status: "confirmed", txId: "5Uj7..." } }
                │
                ▼
8. Server sends result back to Claude
                │
                ▼
9. Claude generates final text: "Sent 0.5 SOL to Alice. Tx: 5Uj7..."
                │
                ▼
10. Server returns: { "reply": "Sent 0.5 SOL to Alice. Tx: 5Uj7..." }
```

The key point: **your server is the only thing that touches the private key and the blockchain**. Claude just sees tool schemas and results. The policy engine enforces your rules regardless of what Claude tries to do.

## Adapting for Your Stack

This example uses Express, but the pattern works with any HTTP framework:

| Framework | Adaptation |
|-----------|-----------|
| **Next.js** | Put the handler in `app/api/chat/route.ts` as a Route Handler |
| **Fastify** | Replace `app.post` with `fastify.post`, same logic inside |
| **Hono** | Replace `app.post` with `app.post`, runs on Cloudflare Workers |
| **No framework** | Use `wallet.handleToolCall()` directly in any async context |

The only requirement is that your server can:
1. Receive a user message
2. Call the Anthropic API (or OpenAI, etc.)
3. Call `wallet.handleToolCall()` for each tool call
4. Return the result

## Production Considerations

For a production deployment, you should also:

- **Use `SqliteStore`** instead of `MemoryStore` for persistent policy state
- **Load keys from a secrets manager** (AWS Secrets Manager, GCP Secret Manager, Vault)
- **Add authentication** to the `/chat` endpoint (API keys, JWT, etc.)
- **Add rate limiting** at the HTTP layer (in addition to kova's policy rate limits)
- **Deploy behind HTTPS** with a reverse proxy (nginx, Caddy, or a cloud load balancer)
- **Monitor the audit log** for suspicious patterns

See the [Production Deployment](/tutorials/production) tutorial for a complete guide.

## Common Mistakes

1. **Forgetting to set environment variables before starting the server.** If you see an error like `Cannot read properties of undefined`, it usually means `WALLET_KEYPAIR_PATH` or `SOLANA_RPC_URL` is not set. Make sure you export all three variables in the same terminal session where you run `npx ts-node server.ts`.

2. **Sending requests with the wrong Content-Type.** The server expects `Content-Type: application/json`. If you omit the `-H "Content-Type: application/json"` header in your curl command, Express will not parse the body and `req.body.message` will be `undefined`.

3. **Not generating a Solana keypair.** The server needs a keypair file to create the wallet. If you do not have one, run `solana-keygen new --outfile wallet-keypair.json` to generate one. For devnet testing, you can then fund it with `solana airdrop 2 --keypair wallet-keypair.json --url devnet`.

## Troubleshooting

### Server not starting

- **`EADDRINUSE` error:** Another process is using port 3000. Either change the port with `PORT=3001 npx ts-node server.ts` or find and stop the conflicting process.
- **`ENOENT` error for keypair file:** The file path in `WALLET_KEYPAIR_PATH` does not exist. Check the path and make sure the file is present.
- **`Cannot find module 'express'`:** Run `npm install` to install dependencies first.

### Claude not calling tools

- **Check the system prompt:** If Claude responds with text instead of calling tools, the system prompt may not be guiding it to use the wallet tools. Make sure the system prompt mentions calling `wallet_get_policy` and `wallet_get_balance`.
- **Check tool schemas:** Call `wallet.toAnthropicTools()` and `console.log` the result to verify the tool schemas are well-formed. If any schema is malformed, Claude will ignore the tools.
- **Model version:** Make sure you are using a model that supports tool use (e.g., `claude-sonnet-4-5-20250929`, not an older model).

### Requests hang or time out

- **Anthropic API key invalid:** If the API key is wrong, the `anthropic.messages.create()` call will hang or throw an error. Verify your key at [console.anthropic.com](https://console.anthropic.com/).
- **Solana RPC endpoint unreachable:** If the RPC URL is wrong or the endpoint is down, tool calls that query the blockchain will time out. Try `curl https://api.devnet.solana.com -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'` to verify connectivity.

## What to Try Next

- **Add authentication.** Protect your `/chat` endpoint with an API key check (a simple `x-api-key` header) so only authorized clients can interact with the wallet.
- **Add request logging middleware.** Log every incoming request with its timestamp, method, and path. This helps with debugging and provides an audit trail at the HTTP layer.
- **Switch to a different HTTP framework.** Try porting the handler to Next.js API routes, Fastify, or Hono to see how the pattern adapts.

## Next Steps

- [Claude Integration](/guide/ai-integration/claude) — Deep dive into the Claude tool-use format
- [OpenAI Integration](/guide/ai-integration/openai) — Same pattern with OpenAI function calling
- [Security Model](/guide/security) — Threat model and design decisions
