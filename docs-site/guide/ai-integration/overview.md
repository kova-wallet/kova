# AI Integration Overview

::: info What you'll learn
- How kova exposes wallet functionality to AI agents through an MCP (Model Context Protocol) server
- The 15 standardized wallet tools (14 safe, 1 dangerous) available to agents
- How to create and configure an MCP server from your wallet
- The complete data flow between your MCP server and AI agents
- How errors are sanitized to prevent information leakage
:::

kova exposes **14 safe tools** by default that AI agents can call to interact with the blockchain, plus **1 dangerous tool** (`wallet_execute_custom`) that must be explicitly opted into. Agents interact with these tools exclusively through an **MCP (Model Context Protocol) server** -- the sole agent-facing interface. Any AI framework that supports MCP (Claude, OpenAI, LangChain, custom agents) can connect.

::: tip New to MCP?
The [Model Context Protocol](https://modelcontextprotocol.io/) is an open standard for connecting AI models to external tools and data sources. An MCP server exposes tools that any MCP-compatible client can discover and call. kova's MCP server exposes wallet operations as tools, with policy enforcement happening automatically on every call.
:::

## Available Tools

### Write Operations

These go through the full policy engine pipeline (validate, policy evaluation, build, sign, broadcast, audit log):

| Tool Name | Description |
|---|---|
| `wallet_transfer` | Send tokens (SOL, USDC, USDT) to an address on the configured chain |
| `wallet_swap` | Swap between tokens (requires a pre-built swap transaction via custom intent) |
| `wallet_mint` | Mint an NFT from a collection |
| `wallet_stake` | Stake tokens with a validator or staking pool |

### Read Operations

These return data without modifying on-chain state:

| Tool Name | Description |
|---|---|
| `wallet_get_balance` | Check the wallet's balance for a specific token |
| `wallet_get_all_balances` | Get balances for all supported tokens (SOL, USDC, USDT) in one call |
| `wallet_get_policy` | View the current policy constraints (limits, allowlists, hours) |
| `wallet_get_spending_remaining` | Get remaining budget for each spending limit window |
| `wallet_get_supported_tokens` | List supported tokens with their mint addresses and network |
| `wallet_get_address` | Get the wallet's public address |
| `wallet_get_token_price` | Get the current USD price of a token from the price oracle |
| `wallet_estimate_fee` | Estimate the network fee for a transfer before executing |
| `wallet_get_transaction_history` | View recent transactions from the audit log |
| `wallet_get_transaction_status` | Check the confirmation status of a submitted transaction |

::: warning Dangerous Tool
`wallet_execute_custom` is the only **dangerous tool** and is NOT included by default. It must be explicitly enabled via the `includeDangerous` option when creating the MCP server. It allows arbitrary on-chain program interactions -- always pair it with an `allowPrograms` policy rule and/or an `ApprovalGateRule`.
:::

## Creating an MCP Server

The MCP server is created from a configured wallet instance using `createMcpServer()` or the convenience helper `createMcpStdioServer()`:

```typescript
import {
  AgentWallet, Policy, LocalSigner, MemoryStore, SolanaAdapter,
  createMcpServer,
} from "@kova-sdk/wallet";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// 1. Set up the wallet (signer, chain, policy, store)
const wallet = new AgentWallet({ signer, chain, policy, store });

// 2. Create the MCP server from the wallet
const server = createMcpServer(wallet);

// 3. Connect to a transport (stdio is the most common for CLI agents)
const transport = new StdioServerTransport();
await server.connect(transport);
```

Or use the convenience helper that combines steps 2 and 3:

```typescript
import { createMcpStdioServer } from "@kova-sdk/wallet";

const server = await createMcpStdioServer(wallet);
// Server is now running and accepting tool calls via stdio
```

### MCP Server Options

```typescript
import { createMcpServer } from "@kova-sdk/wallet";

const server = createMcpServer(wallet, {
  // Include dangerous tools (wallet_execute_custom)
  includeDangerous: true,

  // Exclude specific tools by name
  exclude: ["wallet_swap", "wallet_mint"],

  // Static auth token forwarded to every tool call
  authToken: "my-secret-token",

  // Or use a dynamic auth token provider (for token rotation)
  authTokenProvider: () => getCurrentToken(),

  // Override the MCP server name and version
  serverInfo: { name: "my-payment-agent", version: "2.0.0" },
});
```

## What the Agent Sees

When an MCP client connects, it discovers the available tools via the `listTools` protocol method. Each tool has a name, description, and JSON schema for its input parameters:

```json
{
  "name": "wallet_transfer",
  "description": "Transfer tokens to a recipient address...",
  "inputSchema": {
    "type": "object",
    "properties": {
      "to": { "type": "string", "description": "Recipient wallet address" },
      "amount": { "type": "string", "description": "Amount to send as a decimal string" },
      "token": { "type": "string", "description": "Token symbol (e.g., SOL, USDC)" },
      "chain": { "type": "string", "description": "Target blockchain", "enum": ["solana", "ethereum", "base"] },
      "reason": { "type": "string", "description": "Why this transfer is being made" }
    },
    "required": ["to", "amount", "token", "chain"]
  }
}
```

When the agent calls a tool, the MCP server:
1. Validates the input parameters
2. Dispatches to the wallet's internal handler
3. Runs the full policy -> build -> sign -> broadcast pipeline (for write operations)
4. Returns a sanitized result

## Tool Call Results

Tool calls return results via the MCP protocol. For **write tools**, the result contains a full transaction result:

```json
// Successful transfer
{
  "success": true,
  "data": {
    "status": "confirmed",
    "txId": "5UBe...txSignature",
    "summary": "Sent 1.5 SOL to 9aE4...gzM",
    "intentId": "a1b2c3d4-...",
    "timestamp": 1700000000000
  }
}

// Denied by policy
{
  "success": false,
  "data": {
    "status": "denied",
    "summary": "Denied by policy: Transfer exceeds per-transaction limit of 10 SOL",
    "intentId": "e5f6g7h8-...",
    "timestamp": 1700000000000,
    "error": {
      "code": "POLICY_DENIED",
      "message": "Transfer exceeds per-transaction limit of 10 SOL",
      "policyRule": "spending-limit"
    }
  },
  "error": "Transfer exceeds per-transaction limit of 10 SOL"
}
```

For **read tools**, the result contains the requested data:

```json
// wallet_get_balance
{
  "success": true,
  "data": {
    "token": "SOL",
    "amount": "12.5",
    "decimals": 9,
    "usdValue": 2500.00
  }
}
```

## Security

### Error Sanitization

kova sanitizes all tool responses before returning them to agents. Internal stack traces, store connection strings, and signer details are never exposed. If an unexpected exception occurs, the agent only sees:

```json
{
  "success": false,
  "error": "An internal error occurred while processing the tool call."
}
```

Your monitoring should watch server-side logs for the root cause.

### Prompt Injection Protection

Tool responses are wrapped in structured delimiters that mark them as data, not instructions. Long string values from on-chain data are truncated, and characters commonly used in injection attempts are stripped.

### Rate Limiting

The MCP server enforces rate limits:
- **Write operations**: Floor of 30 per minute (configurable via policy)
- **Read operations**: Floor of 120 per minute
- **Concurrency**: Maximum 10 concurrent tool calls per MCP server instance

### Timeouts

Each tool call has a 120-second timeout. If a call exceeds this, it is aborted and a generic error is returned.

## Common Mistakes

1. **Calling `wallet.execute()` directly instead of using MCP.** The MCP server handles input validation, rate limiting, response sanitization, and timeouts. Bypassing it removes these protections.

2. **Assuming the system prompt is a security boundary.** The system prompt guides the model's behavior, but it is not enforceable. The policy engine is what enforces hard limits -- it does not matter what the model tries to do.

3. **Enabling dangerous tools without guardrails.** `wallet_execute_custom` allows arbitrary program interactions. Always pair it with an `allowPrograms` policy rule and/or an `ApprovalGateRule`.

## Troubleshooting

### The AI model is not calling any tools

- Make sure your MCP client is properly connected to the server transport
- Check that the MCP server is listing tools correctly (use `listTools` to verify)
- Ensure your AI framework's MCP integration is configured correctly

### Tool calls return "Unknown tool"

- The tool name must exactly match one of the supported names (e.g., `wallet_transfer`, not `transfer`)
- Check if the tool was excluded via the `exclude` option or not included via `includeDangerous`

### Tool calls timeout

- The default timeout is 120 seconds. Long-running transactions on congested networks may exceed this
- Check your chain adapter's RPC endpoint health
