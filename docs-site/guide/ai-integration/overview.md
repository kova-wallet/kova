# AI Integration Overview

kova exposes **8 tools** that AI agents can call to interact with the blockchain. These tools are framework-agnostic at their core and can be adapted to work with any AI provider -- Anthropic Claude, OpenAI, LangChain, or custom integrations.

## Available Tools

| Tool Name | Description |
|---|---|
| `wallet_transfer` | Send tokens to an address on the configured chain |
| `wallet_swap` | Swap between tokens via Jupiter (Solana) or other DEX routers |
| `wallet_mint` | Mint an NFT from a collection |
| `wallet_stake` | Stake tokens with a validator or staking pool |
| `wallet_execute_custom` | Execute a custom on-chain program instruction |
| `wallet_get_balance` | Check the wallet's balance for a specific token |
| `wallet_get_policy` | View the current policy constraints (limits, allowlists, hours) |
| `wallet_get_transaction_history` | View recent transactions from the audit log |

The first five tools are **write operations** that go through the full policy engine pipeline (validate, policy evaluation, build, sign, broadcast, audit log). The last three are **read operations** that return data without modifying on-chain state.

## The `handleToolCall()` Dispatch Mechanism

Every tool call from an AI agent is routed through a single entry point: `wallet.handleToolCall(name, input)`. This method dispatches to the appropriate internal handler based on the tool name.

```typescript
import { AgentWallet } from "kova";

// The agent produces a tool name and input (e.g., from Claude's tool_use block)
const toolName = "wallet_transfer";
const toolInput = {
  to: "9aE4Uy6gzM...",
  amount: "1.5",
  token: "SOL",
  chain: "solana",
  reason: "Payment for services rendered",
};

const result = await wallet.handleToolCall(toolName, toolInput);

if (result.success) {
  console.log("Transaction succeeded:", result.data);
} else {
  console.log("Transaction failed:", result.error);
}
```

The dispatch works as a switch over all 8 tool names. If the agent calls an unknown tool name, `handleToolCall` returns an error listing the available tools:

```typescript
// Unknown tool name
const result = await wallet.handleToolCall("wallet_unknown", {});
// result.success === false
// result.error === "Unknown tool: wallet_unknown. Available tools: wallet_transfer, wallet_swap, ..."
```

::: tip
`handleToolCall` is the **only** method an AI integration needs to call. You never need to invoke `wallet.execute()` directly when building an agent -- `handleToolCall` builds the correct `TransactionIntent` internally.
:::

## ToolCallResult Format

Every call to `handleToolCall` returns a `ToolCallResult`:

```typescript
interface ToolCallResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** The result data (varies by tool) */
  data?: unknown;
  /** Error message if success is false */
  error?: string;
}
```

For **write tools** (`wallet_transfer`, `wallet_swap`, `wallet_mint`, `wallet_stake`, `wallet_execute_custom`), the `data` field contains a full `TransactionResult`:

```typescript
// Successful transfer
{
  success: true,
  data: {
    status: "confirmed",
    txId: "5UBe...txSignature",
    summary: "Sent 1.5 SOL to 9aE4...gzM",
    intentId: "a1b2c3d4-...",
    timestamp: 1700000000000
  }
}

// Denied by policy
{
  success: false,
  data: {
    status: "denied",
    summary: "Denied by policy: Transfer exceeds per-transaction limit of 10 SOL",
    intentId: "e5f6g7h8-...",
    timestamp: 1700000000000,
    error: {
      code: "POLICY_DENIED",
      message: "Transfer exceeds per-transaction limit of 10 SOL",
      policyRule: "spending-limit"
    }
  },
  error: "Transfer exceeds per-transaction limit of 10 SOL"
}
```

For **read tools**, the `data` field contains the requested information:

```typescript
// wallet_get_balance
{
  success: true,
  data: {
    token: "SOL",
    amount: "12.5",
    decimals: 9,
    usdValue: 2500.00
  }
}

// wallet_get_policy
{
  success: true,
  data: {
    name: "spending-limit+allowlist+rate-limit",
    spendingLimits: {
      perTransaction: { amount: "10", token: "SOL" },
      daily: { amount: "50", token: "SOL" }
    },
    allowlistedAddresses: 5,
    allowlistedPrograms: 2,
    rateLimits: { maxPerMinute: 5, maxPerHour: 20 }
  }
}
```

## Tool Definition Format

Internally, kova uses a canonical `ToolDefinition` interface that is framework-agnostic:

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, ToolParameter>;
    required: string[];
  };
}

interface ToolParameter {
  type: string;
  description: string;
  enum?: string[];
}
```

Each provider adapter converts this canonical format into the shape expected by that provider:

- **Anthropic (Claude):** `{ name, description, input_schema: { type, properties, required } }` -- see [Claude Integration](./claude.md)
- **OpenAI:** `{ type: "function", function: { name, description, parameters: { type, properties, required } } }` -- see [OpenAI Integration](./openai.md)
- **LangChain:** `{ name, description, schema, call(input) }` -- see [LangChain Integration](./langchain.md)

You can access the raw canonical definitions directly:

```typescript
import { WALLET_TOOLS, getToolByName } from "kova";

// All 8 tool definitions
console.log(WALLET_TOOLS.length); // 8

// Look up a single tool
const transferTool = getToolByName("wallet_transfer");
console.log(transferTool?.parameters.required);
// ["to", "amount", "token", "chain"]
```

## Error Sanitization

kova sanitizes errors before returning them to agents. This is a deliberate security measure -- internal stack traces, store connection strings, and signer details are never exposed.

```typescript
async handleToolCall(name: string, input: Record<string, unknown>): Promise<ToolCallResult> {
  try {
    switch (name) {
      case "wallet_transfer":
        return await this.handleTransfer(input);
      // ... other tools
    }
  } catch {
    // Internal errors are replaced with a generic message
    return {
      success: false,
      error: "An internal error occurred while processing the tool call.",
    };
  }
}
```

::: warning
If an unexpected exception occurs inside any handler (e.g., the store is down, the signer throws), the agent only sees `"An internal error occurred while processing the tool call."` This prevents information leakage but means your monitoring should watch server-side logs for the root cause.
:::

There are two categories of errors an agent can receive:

1. **Structured errors** -- Policy denials, validation failures, and known transaction errors. These include specific codes and messages that help the agent understand what went wrong (e.g., `"Transfer exceeds per-transaction limit of 10 SOL"`).

2. **Sanitized errors** -- Unexpected internal failures. These always produce the generic message above. The real error is logged server-side but never returned to the agent.

This design ensures agents get enough information to retry or adjust their behavior without receiving sensitive infrastructure details.

## Next Steps

Choose your AI provider to see a complete integration guide:

- [Claude (Anthropic)](./claude.md) -- Tool-use loop with `toAnthropicTools()`
- [OpenAI](./openai.md) -- Function calling with `toOpenAITools()`
- [LangChain](./langchain.md) -- Agent executor with `createLangChainTools()`
