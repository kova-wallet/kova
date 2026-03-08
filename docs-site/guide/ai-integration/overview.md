# AI Integration Overview

::: info What you'll learn
- How kova exposes wallet functionality to AI agents through 8 standardized tools (6 safe, 2 dangerous)
- How the `handleToolCall()` dispatch mechanism routes every tool call through a single entry point
- The complete data flow between your server and the AI model (tool schemas, tool calls, tool results)
- The `ToolCallResult` format returned by every tool call
- How errors are sanitized to prevent information leakage to agents
:::

kova exposes **6 safe tools** by default that AI agents can call to interact with the blockchain, plus **2 dangerous tools** (`wallet_execute_custom` and `wallet_get_policy`) that must be explicitly opted into. These tools are framework-agnostic at their core and can be adapted to work with any AI provider -- Anthropic Claude, OpenAI, LangChain, or custom integrations.

::: tip New to AI tool calling?
Modern AI models like Claude and GPT-4 can do more than generate text -- they can also call **tools** (sometimes called "functions"). A tool is a structured action the AI can request, like "check wallet balance" or "send tokens." The AI does not execute the tool itself; instead, it produces a JSON object describing which tool to call and with what parameters, and your server executes it. Think of it like a restaurant: the AI is the customer placing an order (tool call), and your server is the kitchen fulfilling it.
:::

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

::: warning Dangerous Tools
`wallet_execute_custom` and `wallet_get_policy` are classified as **dangerous tools** and are NOT included by default in `toAnthropicTools()` / `toOpenAITools()`. They must be explicitly enabled via the `enabledTools` option. `wallet_execute_custom` allows arbitrary program interactions, and `wallet_get_policy` reveals security constraints that could help an adversarial agent craft bypass attempts.
:::

## The `handleToolCall()` Dispatch Mechanism

Every tool call from an AI agent is routed through a single entry point: `wallet.handleToolCall(name, input)`. This method dispatches to the appropriate internal handler based on the tool name.

::: tip Recommended: Use `safeHandleToolCall()`
For production use, prefer `safeHandleToolCall(wallet, name, input)` over `wallet.handleToolCall(name, input)`. The safe wrapper adds:
- **Input validation** via `validateToolInput()` — checks required fields, types, and strips unknown properties
- **Write rate limiting** — enforces a floor of 30 write operations per minute to prevent runaway agents

```typescript
import { safeHandleToolCall } from "kova";
const result = await safeHandleToolCall(wallet, toolName, toolInput);
```
:::

```typescript
// Import the AgentWallet class, which is the main entry point for AI integrations.
import { AgentWallet } from "kova";

// The agent produces a tool name and input object.
// For example, Claude's tool_use block provides these two pieces of data.
// The tool name tells handleToolCall which handler to invoke.
const toolName = "wallet_transfer";

// The tool input contains the parameters for the operation.
// These vary by tool -- for wallet_transfer, we need: to, amount, token, chain.
const toolInput = {
  to: "9aE4Uy6gzM...",                    // Recipient's Solana address
  amount: "1.5",                            // Amount to send (human-readable, not lamports)
  token: "SOL",                             // Token symbol
  chain: "solana",                          // Target blockchain
  reason: "Payment for services rendered",  // Optional: recorded in the audit log
};

// Dispatch the tool call to the appropriate handler inside the wallet.
// This single method handles all wallet tools. Internally it:
// 1. Validates the input parameters
// 2. Builds a TransactionIntent (for write operations)
// 3. Runs the full policy -> build -> sign -> broadcast pipeline
// 4. Returns a standardized ToolCallResult
const result = await wallet.handleToolCall(toolName, toolInput);

// Check whether the operation succeeded.
if (result.success) {
  console.log("Transaction succeeded:", result.data);
} else {
  console.log("Transaction failed:", result.error);
}
```

The dispatch works as a switch over all tool names. If the agent calls an unknown tool name, `handleToolCall` returns an error listing the available tools:

```typescript
// Calling an unrecognized tool name returns an error with a helpful message.
// This prevents silent failures when the agent hallucinates a tool name.
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
// The standardized response format for all tool calls.
// Every tool -- whether it's a write operation (transfer, swap) or a
// read operation (get_balance, get_policy) -- returns this shape.
interface ToolCallResult {
  /** Whether the operation succeeded */
  // true = the tool call completed successfully (transaction confirmed, or data retrieved).
  // false = the tool call failed (policy denied, validation error, chain error, etc.).
  success: boolean;
  /** The result data (varies by tool) */
  // For write tools: a TransactionResult with status, txId, summary, etc.
  // For read tools: the requested data (balance, policy info, transaction history).
  // Undefined if the call failed with an unexpected internal error.
  data?: unknown;
  /** Error message if success is false */
  // A sanitized, agent-safe error message explaining what went wrong.
  // Internal implementation details are never exposed here.
  error?: string;
}
```

For **write tools** (`wallet_transfer`, `wallet_swap`, `wallet_mint`, `wallet_stake`, `wallet_execute_custom`), the `data` field contains a full `TransactionResult`:

```typescript
// Example: Successful transfer -- the transaction was confirmed on-chain.
{
  success: true,
  data: {
    status: "confirmed",                    // On-chain confirmation status
    txId: "5UBe...txSignature",            // Solana transaction signature (can be used as a Solscan link)
    summary: "Sent 1.5 SOL to 9aE4...gzM", // Human-readable summary for the agent to relay to the user
    intentId: "a1b2c3d4-...",              // Unique intent ID for audit trail correlation
    timestamp: 1700000000000               // When the transaction was processed (Unix ms)
  }
}

// Example: Denied by policy -- the transaction was blocked before reaching the chain.
{
  success: false,
  data: {
    status: "denied",                       // The transaction was denied by the policy engine
    summary: "Denied by policy: Transfer exceeds per-transaction limit of 10 SOL",
    intentId: "e5f6g7h8-...",              // The intent ID is still generated for audit purposes
    timestamp: 1700000000000,
    error: {
      code: "POLICY_DENIED",               // Structured error code for programmatic handling
      message: "Transfer exceeds per-transaction limit of 10 SOL", // Why the policy denied it
      policyRule: "spending-limit"          // Which specific rule caused the denial
    }
  },
  error: "Transfer exceeds per-transaction limit of 10 SOL" // Top-level error for easy access
}
```

For **read tools**, the `data` field contains the requested information:

```typescript
// Example: wallet_get_balance response -- returns the token balance and USD value.
{
  success: true,
  data: {
    token: "SOL",           // The queried token symbol
    amount: "12.5",         // Balance in human-readable units (not lamports)
    decimals: 9,            // Token decimals (9 for SOL, 6 for USDC)
    usdValue: 2500.00       // Current USD value based on Jupiter price data
  }
}

// Example: wallet_get_policy response -- returns the wallet's policy configuration.
{
  success: true,
  data: {
    name: "spending-limit+allowlist+rate-limit", // Concatenated rule names for identification
    spendingLimits: {
      perTransaction: { amount: "10", token: "SOL" }, // Max per-transaction spending cap
      daily: { amount: "50", token: "SOL" }           // Max daily spending cap
    },
    allowlistedAddresses: 5,   // Number of addresses the wallet is allowed to send to
    allowlistedPrograms: 2,    // Number of programs the wallet is allowed to interact with
    rateLimits: { maxPerMinute: 5, maxPerHour: 20 } // Transaction rate limits
  }
}
```

## What the AI Model Sees

To understand the data flow, it helps to see the actual JSON that gets sent to and from the AI model. Here is the complete picture for a transfer operation.

**Step 1: Your server sends tool schemas to the AI model.** This is done once at the start of the conversation. The AI model uses these schemas to understand what tools are available and how to call them.

```json
// This is one of the tool schemas sent to the AI model.
// The model reads the "description" and "properties" to understand
// what the tool does and what parameters it needs.
{
  "name": "wallet_transfer",
  "description": "Transfer tokens to a recipient address...",
  "input_schema": {
    "type": "object",
    "properties": {
      "to": { "type": "string", "description": "Recipient wallet address" },
      "amount": { "type": "string", "description": "Amount to send as a decimal string" },
      "token": { "type": "string", "description": "Token symbol (e.g., SOL, USDC)" },
      "chain": { "type": "string", "description": "Target blockchain", "enum": ["solana"] },
      "reason": { "type": "string", "description": "Why this transfer is being made" }
    },
    "required": ["to", "amount", "token", "chain"]
  }
}
```

**Step 2: The AI model generates a tool call.** Based on the user's request and the tool schemas, the model produces a JSON object requesting a specific tool with specific parameters.

```json
// This is what the AI model sends back when it wants to transfer funds.
// Your server receives this and passes it to wallet.handleToolCall().
{
  "type": "tool_use",
  "id": "toolu_01A09q90qw90lq917835lq9",
  "name": "wallet_transfer",
  "input": {
    "to": "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",
    "amount": "0.5",
    "token": "SOL",
    "chain": "solana",
    "reason": "Payment for services rendered"
  }
}
```

**Step 3: Your server executes the tool call and sends the result back.** The `wallet.handleToolCall()` method processes the request and returns a `ToolCallResult`, which you serialize as JSON and send back to the AI model.

```json
// This is the tool result that your server sends back to the AI model.
// The model reads this to understand what happened and formulate its response.
{
  "success": true,
  "data": {
    "status": "confirmed",
    "txId": "5UBe...txSignature",
    "summary": "Sent 0.5 SOL to 9aE476...cde",
    "intentId": "a1b2c3d4-...",
    "timestamp": 1700000000000
  }
}
```

**Step 4: The AI model generates a human-readable response.** The model reads the tool result and writes a natural-language summary for the user.

```
"I've sent 0.5 SOL to 9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde.
 Transaction ID: 5UBe...txSignature"
```

This four-step cycle repeats for each tool call the model makes. The model may call multiple tools in sequence (e.g., check policy, check balance, then transfer).

## Tool Definition Format

Internally, kova uses a canonical `ToolDefinition` interface that is framework-agnostic:

```typescript
// The canonical tool definition format used internally by kova.
// This is the source of truth for all tool metadata. Each AI provider adapter
// (Anthropic, OpenAI, LangChain) converts this format into the provider's expected shape.
interface ToolDefinition {
  name: string;          // The tool name (e.g., "wallet_transfer")
  description: string;   // A detailed description of what the tool does (sent to the LLM)
  parameters: {
    type: "object";      // Always "object" -- tool inputs are JSON objects
    properties: Record<string, ToolParameter>; // Schema for each input parameter
    required: string[];  // Which parameters are mandatory
  };
}

// Schema for a single tool parameter (e.g., "to", "amount", "token").
interface ToolParameter {
  type: string;          // JSON Schema type (e.g., "string", "number")
  description: string;   // Description shown to the LLM to guide its usage
  enum?: string[];       // Optional: restrict the parameter to specific values
}
```

Each provider adapter converts this canonical format into the shape expected by that provider:

- **Anthropic (Claude):** `{ name, description, input_schema: { type, properties, required } }` -- see [Claude Integration](./claude.md)
- **OpenAI:** `{ type: "function", function: { name, description, parameters: { type, properties, required } } }` -- see [OpenAI Integration](./openai.md)
- **LangChain:** `{ name, description, schema, call(input) }` -- see [LangChain Integration](./langchain.md)

You can access the raw canonical definitions directly:

```typescript
// Import the tool definition constants from kova.
import { WALLET_TOOLS, getToolByName } from "kova";

// WALLET_TOOLS contains all 8 tool definitions (6 safe + 2 dangerous).
// You can use these to build custom integrations with providers not natively supported.
console.log(WALLET_TOOLS.length); // 8

// Look up a single tool by name. Returns undefined if the name doesn't match.
const transferTool = getToolByName("wallet_transfer");
// Check which parameters are required for the transfer tool.
console.log(transferTool?.parameters.required);
// ["to", "amount", "token", "chain"] -- "reason" is optional
```

## Error Sanitization

kova sanitizes errors before returning them to agents. This is a deliberate security measure -- internal stack traces, store connection strings, and signer details are never exposed.

```typescript
// Simplified view of how handleToolCall sanitizes errors internally.
// This ensures that AI agents (and by extension, end users) never see
// sensitive implementation details like database connection strings,
// private key paths, or internal stack traces.
async handleToolCall(name: string, input: Record<string, unknown>): Promise<ToolCallResult> {
  try {
    // Dispatch to the appropriate handler based on tool name.
    switch (name) {
      case "wallet_transfer":
        return await this.handleTransfer(input);
      // ... other tools follow the same pattern
    }
  } catch {
    // If any unexpected exception occurs (store down, signer threw, network error),
    // it is caught here and replaced with a generic, safe error message.
    // The real error is logged server-side for debugging but never returned to the agent.
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

## Common Mistakes

1. **Calling `wallet.execute()` directly in an AI integration.** When building an AI agent, always use `wallet.handleToolCall(name, input)` instead of `wallet.execute()`. The `handleToolCall` method validates inputs, builds the correct `TransactionIntent`, and returns a standardized `ToolCallResult`. If you call `execute()` directly, you skip input validation and have to build the intent yourself.

2. **Not serializing tool results as JSON strings.** Both Anthropic and OpenAI expect tool results as JSON strings (not JavaScript objects). Always use `JSON.stringify(result)` when sending tool results back to the AI model.

3. **Assuming the AI model will follow the system prompt exactly.** The system prompt guides the model's behavior, but it is not a security boundary. The model might try to call tools in unexpected ways or skip steps. The policy engine is what enforces hard limits -- it does not matter what the model tries to do.

## Troubleshooting

### The AI model is not calling any tools

- Make sure you are passing the tool schemas to the AI API call. For Claude, include the `tools` parameter in `anthropic.messages.create()`. For OpenAI, include the `tools` parameter in `openai.chat.completions.create()`.
- Check that the system prompt mentions the available tools. A prompt like "You have access to wallet tools" helps the model understand it should use them.
- Verify the tool schemas are well-formed by logging `wallet.toAnthropicTools()` or `wallet.toOpenAITools()` and inspecting the output.

### The AI model calls a tool with wrong parameters

- This is usually a model behavior issue, not a kova issue. The `handleToolCall` method validates all inputs and returns a clear error if parameters are missing or invalid.
- Improve the system prompt to give the model better guidance on how to use the tools. For example: "Always use the full Solana address (base58 encoded) for the `to` parameter."

### `handleToolCall` returns "Unknown tool"

- The tool name must exactly match one of the supported names (e.g., `wallet_transfer`, not `transfer` or `walletTransfer`). The error message includes the list of valid tool names.

## What to Try Next

- **Build a custom integration** with a provider not covered here (e.g., Cohere, Mistral, or a local LLM). Use `WALLET_TOOLS` to get the canonical tool definitions and convert them to your provider's expected format.
- **Create a read-only AI agent** by filtering the tools to only include `wallet_get_balance`, `wallet_get_policy`, and `wallet_get_transaction_history`. This is useful for monitoring dashboards.
- **Log all tool calls** by wrapping `handleToolCall` in a function that records every call and result to a separate log file for debugging.

## Next Steps

Choose your AI provider to see a complete integration guide:

- [Claude (Anthropic)](./claude.md) -- Tool-use loop with `toAnthropicTools()`
- [OpenAI](./openai.md) -- Function calling with `toOpenAITools()`
- [LangChain](./langchain.md) -- Agent executor with `createLangChainTools()`
