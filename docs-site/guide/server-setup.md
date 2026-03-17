# Server Setup

::: info What you'll learn
- Why you need a server between your AI agent and the blockchain
- How to build a minimal Express server with an MCP-based wallet interface
- How MCP (Model Context Protocol) exposes wallet tools to any compatible AI agent
- How to test your server with curl and interpret the responses
- How to adapt the pattern for Next.js, Fastify, Hono, or any HTTP framework
:::

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
- **A Solana keypair** -- generate one with `solana-keygen new --outfile wallet-keypair.json` (install the [Solana CLI](https://docs.solanalabs.com/cli/install) first)
- **Basic familiarity with Express** (or any HTTP framework) -- if you have built a REST API before, you are ready
- **About 15 minutes** to get the server running

## Minimal Express Server

Here is a complete, working server that exposes kova as an HTTP API. It uses MCP (Model Context Protocol) to expose wallet tools to any compatible AI agent.

### Install Dependencies

```bash
# Create a new project and install all dependencies.
# express                      - HTTP server framework
# @kova/wallet                 - The wallet SDK
# @solana/web3.js              - Solana client library for Keypair loading
# @modelcontextprotocol/sdk    - MCP server support
npm init -y
npm install express @kova/wallet @solana/web3.js @modelcontextprotocol/sdk
npm install -D typescript ts-node @types/express @types/node
```

### Environment Variables

```bash
# .env (do NOT commit this file)
#
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
} from "@kova/wallet";
// Import the MCP server factory to expose wallet tools via Model Context Protocol.
import { createMcpServer } from "@kova/wallet";
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
const store = new MemoryStore({ dangerouslyAllowInProduction: true });

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

// --- 3. Create the MCP server ---
// The MCP server exposes all wallet tools to any MCP-compatible AI agent.
// Policy enforcement happens automatically on every tool call.
const mcpServer = createMcpServer(wallet);

// --- 4. Create the Express server ---
const app = express();
// Parse incoming JSON request bodies (MCP requests come as JSON).
app.use(express.json());

// POST /mcp — MCP transport endpoint.
// Any MCP-compatible AI agent (Claude, GPT-4, etc.) connects here.
// The MCP server handles tool discovery, tool calls, policy enforcement,
// signing, and broadcasting automatically — no manual tool-use loop needed.
app.post("/mcp", async (req, res) => {
  try {
    const result = await mcpServer.handleRequest(req.body);
    res.json(result);
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
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
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
# Check server health and wallet info.
curl http://localhost:3000/health

# The MCP endpoint at /mcp is designed for MCP-compatible AI agents.
# Point your MCP client (e.g., Claude Desktop, an MCP SDK client) at:
#   http://localhost:3000/mcp
```

## Testing with curl

Here are the curl commands you can use to test your server. Run these from a second terminal window while the server is running.

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

### Call a tool directly via MCP

You can invoke individual wallet tools through the MCP endpoint. This is what an MCP-compatible AI agent does automatically behind the scenes.

```bash
# List available tools
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"method": "tools/list"}'

# Call wallet_get_balance
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"method": "tools/call", "params": {"name": "wallet_get_balance", "arguments": {"token": "SOL"}}}'
```

**Expected response (tools/call):**

```json
{
  "result": {
    "content": [{ "type": "text", "text": "{\"success\":true,\"data\":{\"amount\":\"2.5\",\"token\":\"SOL\"}}" }]
  }
}
```

Your exact balance will differ. The MCP server automatically routes the tool call through the policy engine, signs the transaction if needed, and returns a standardized result.

### Test a policy denial via MCP

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"method": "tools/call", "params": {"name": "wallet_transfer", "arguments": {"to": "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde", "amount": "5", "token": "SOL"}}}'
```

**Expected response:**

```json
{
  "result": {
    "content": [{ "type": "text", "text": "{\"success\":false,\"error\":\"Transfer exceeds per-transaction limit of 1 SOL\"}" }]
  }
}
```

The policy engine denied the request because 5 SOL exceeds the per-transaction limit of 1 SOL.

::: details What just happened?
When you sent an MCP request to `POST /mcp`, the server:

1. Received the MCP JSON-RPC request.
2. The MCP server matched the tool name (`wallet_get_balance`, `wallet_transfer`, etc.) to the wallet's registered tools.
3. The wallet ran the request through the policy engine, built the transaction if approved, signed it, and broadcast it.
4. The MCP server returned the result in MCP format.

With MCP, there is no manual tool-use loop. The AI agent (Claude, GPT-4, etc.) connects as an MCP client and handles the conversation flow itself. Your server only needs to expose the MCP endpoint.
:::

## What This Server Does

When an MCP-compatible AI agent connects to `POST /mcp`:

```
1. AI agent discovers available tools via MCP:
   → tools/list → returns wallet_get_balance, wallet_transfer, etc.
                │
                ▼
2. Agent calls: tools/call wallet_get_balance({ token: "SOL" })
                │
                ▼
3. MCP server routes to wallet.handleToolCall("wallet_get_balance", ...)
   → Policy engine: N/A (read-only)
   → Returns: { success: true, data: { amount: "4.5", token: "SOL" } }
                │
                ▼
4. Agent calls: tools/call wallet_transfer({ to: "Alice...", amount: "0.5", ... })
                │
                ▼
5. MCP server routes to wallet.handleToolCall("wallet_transfer", {...})
   → Policy engine: SpendingLimitRule ✓, RateLimitRule ✓ → ALLOW
   → Build transaction → Sign → Broadcast → Confirmed
   → Returns: { success: true, data: { status: "confirmed", txId: "5Uj7..." } }
                │
                ▼
6. Agent generates final text: "Sent 0.5 SOL to Alice. Tx: 5Uj7..."
```

The key point: **your server is the only thing that touches the private key and the blockchain**. The AI agent only sees MCP tool schemas and results. The policy engine enforces your rules regardless of what the agent tries to do.

## Adapting for Your Stack

This example uses Express, but the pattern works with any HTTP framework:

| Framework | Adaptation |
|-----------|-----------|
| **Next.js** | Put the MCP handler in `app/api/mcp/route.ts` as a Route Handler |
| **Fastify** | Replace `app.post` with `fastify.post`, same MCP handler inside |
| **Hono** | Replace `app.post` with `app.post`, runs on Cloudflare Workers |
| **No framework** | Use `createMcpServer(wallet)` and handle requests directly in any async context |

The only requirement is that your server can:
1. Create an MCP server from the wallet with `createMcpServer(wallet)`
2. Expose an HTTP endpoint that forwards requests to `mcpServer.handleRequest()`
3. Return the MCP response to the client

## Production Considerations

For a production deployment, you should also:

- **Use `SqliteStore`** instead of `MemoryStore` for persistent policy state
- **Load keys from a secrets manager** (AWS Secrets Manager, GCP Secret Manager, Vault)
- **Add authentication** to the `/mcp` endpoint (API keys, JWT, etc.)
- **Add rate limiting** at the HTTP layer (in addition to kova's policy rate limits)
- **Deploy behind HTTPS** with a reverse proxy (nginx, Caddy, or a cloud load balancer)
- **Monitor the audit log** for suspicious patterns

See the [Production Deployment](/tutorials/production) tutorial for a complete guide.

## Common Mistakes

1. **Forgetting to set environment variables before starting the server.** If you see an error like `Cannot read properties of undefined`, it usually means `WALLET_KEYPAIR_PATH` or `SOLANA_RPC_URL` is not set. Make sure you export both variables in the same terminal session where you run `npx ts-node server.ts`.

2. **Sending requests with the wrong Content-Type.** The server expects `Content-Type: application/json`. If you omit the `-H "Content-Type: application/json"` header in your curl command, Express will not parse the body and the MCP request will fail.

3. **Not generating a Solana keypair.** The server needs a keypair file to create the wallet. If you do not have one, run `solana-keygen new --outfile wallet-keypair.json` to generate one. For devnet testing, you can then fund it with `solana airdrop 2 --keypair wallet-keypair.json --url devnet`.

## Troubleshooting

### Server not starting

- **`EADDRINUSE` error:** Another process is using port 3000. Either change the port with `PORT=3001 npx ts-node server.ts` or find and stop the conflicting process.
- **`ENOENT` error for keypair file:** The file path in `WALLET_KEYPAIR_PATH` does not exist. Check the path and make sure the file is present.
- **`Cannot find module 'express'`:** Run `npm install` to install dependencies first.

### Agent not discovering tools

- **Check MCP endpoint:** Make sure your MCP client is pointed at the correct URL (e.g., `http://localhost:3000/mcp`). Send a `tools/list` request to verify the server returns wallet tool schemas.
- **Check tool schemas:** The MCP server automatically registers all wallet tools. If a tool is missing, verify that the wallet was created with the correct components.

### Requests hang or time out

- **Solana RPC endpoint unreachable:** If the RPC URL is wrong or the endpoint is down, tool calls that query the blockchain will time out. Try `curl https://api.devnet.solana.com -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'` to verify connectivity.

## What to Try Next

- **Add authentication.** Protect your `/mcp` endpoint with an API key check (a simple `x-api-key` header) so only authorized clients can interact with the wallet.
- **Add request logging middleware.** Log every incoming request with its timestamp, method, and path. This helps with debugging and provides an audit trail at the HTTP layer.
- **Switch to a different HTTP framework.** Try porting the handler to Next.js API routes, Fastify, or Hono to see how the pattern adapts.

## Next Steps

- [MCP Integration](/guide/ai-integration/overview) — Deep dive into the MCP server and tool registration
- [Security Model](/guide/security) — Threat model and design decisions
