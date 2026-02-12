# Sprint 5 — Agent Adapter Layer Documentation

**Project:** kova
**Sprint:** 5 — Agent Adapter Layer
**Date:** 2026-02-12

---

## Overview

Sprint 5 implements the Agent Adapter Layer — the bridge between AI agents and the wallet SDK. After this sprint, Claude, OpenAI, and LangChain agents can use the wallet as a tool through their native tool-use interfaces. The adapter layer converts 8 canonical tool definitions into provider-specific formats and dispatches tool calls to the appropriate wallet methods.

---

## Architecture

### Tool Call Flow

```
AI Agent (Claude / OpenAI / LangChain)
      │
      │  tool_use: wallet_transfer({ to, amount, token, chain })
      │
      ▼
AgentWallet.handleToolCall("wallet_transfer", input)
      │
      ├─ switch dispatch → handleTransfer(input)
      │     │
      │     ├─ Construct TransactionIntent from input
      │     └─ Call this.execute(intent)
      │           │
      │           ├─ validateIntent() — type checking
      │           ├─ PolicyEngine.evaluate() — policy rules
      │           ├─ Chain.buildTransaction() → Signer.sign() → Chain.broadcast()
      │           └─ Return TransactionResult
      │
      └─ transactionResultToToolResult(result)
            │
            └─ ToolCallResult { success, data?, error? }
```

### Adapter Architecture

```
src/adapters/tools.ts          ← Canonical definitions (single source of truth)
      │
      ├── claude.ts            ← parameters → input_schema
      ├── openai.ts            ← wrap in { type: "function", function: {...} }
      └── langchain.ts         ← add call() wrapper, return JSON strings
```

---

## Tool Definitions

8 tools are available, each mapping to a wallet method:

| Tool Name | Description | Required Params | Optional Params |
|-----------|-------------|-----------------|-----------------|
| `wallet_transfer` | Send tokens to an address | `to`, `amount`, `token`, `chain` | `reason` |
| `wallet_swap` | Swap one token for another | `fromToken`, `toToken`, `amount`, `chain` | `maxSlippage`, `reason` |
| `wallet_mint` | Mint an NFT from a collection | `collection`, `metadataUri`, `chain` | `to`, `reason` |
| `wallet_stake` | Stake tokens with a validator | `amount`, `token`, `chain` | `validator`, `reason` |
| `wallet_execute_custom` | Execute a custom program instruction | `programId`, `data`, `accounts`, `chain` | `reason` |
| `wallet_get_balance` | Check token balance | `token` | — |
| `wallet_get_policy` | Get current policy constraints | — | — |
| `wallet_get_transaction_history` | Get recent transaction history | — | `limit` |

### Chain Parameter

All transaction tools require a `chain` parameter with one of: `"solana"`, `"ethereum"`, `"base"`.

### Accounts Format (Custom Intents)

The `accounts` parameter for `wallet_execute_custom` accepts either:
- A JSON string: `'[{"address":"...","isSigner":false,"isWritable":true}]'`
- An array of objects: `[{address:"...",isSigner:false,isWritable:true}]`

Each account must have `{ address: string, isSigner: boolean, isWritable: boolean }`.

---

## Usage

### With Claude (Anthropic)

```typescript
import { AgentWallet } from "kova";

const wallet = new AgentWallet({ signer, chain, policy, store });

// Get tool definitions for Claude
const tools = wallet.toAnthropicTools();
// → [{ name: "wallet_transfer", description: "...", input_schema: {...} }, ...]

// Send to Claude API
const response = await anthropic.messages.create({
  model: "claude-sonnet-4-5-20250929",
  tools,
  messages: [{ role: "user", content: "Send 1 SOL to Alice" }],
});

// Handle tool use
for (const block of response.content) {
  if (block.type === "tool_use") {
    const result = await wallet.handleToolCall(block.name, block.input);
    // result: { success: true, data: { status: "confirmed", txId: "...", ... } }
  }
}
```

### With OpenAI

```typescript
import { AgentWallet } from "kova";

const wallet = new AgentWallet({ signer, chain, policy, store });

// Get tool definitions for OpenAI
const tools = wallet.toOpenAITools();
// → [{ type: "function", function: { name: "wallet_transfer", ... } }, ...]

// Send to OpenAI API
const response = await openai.chat.completions.create({
  model: "gpt-4o",
  tools,
  messages: [{ role: "user", content: "Send 1 SOL to Alice" }],
});

// Handle tool calls
for (const call of response.choices[0].message.tool_calls ?? []) {
  const args = JSON.parse(call.function.arguments);
  const result = await wallet.handleToolCall(call.function.name, args);
}
```

### With LangChain

```typescript
import { AgentWallet, createLangChainTools } from "kova";
import { DynamicStructuredTool } from "@langchain/core/tools";

const wallet = new AgentWallet({ signer, chain, policy, store });

// Create LangChain-compatible tools
const walletTools = createLangChainTools(wallet);
const langchainTools = walletTools.map(t =>
  new DynamicStructuredTool({
    name: t.name,
    description: t.description,
    func: async (input) => t.call(input),
  })
);
// Use with LangChain agent
```

### Policy Introspection

Agents can check policy constraints before attempting transactions:

```typescript
const result = await wallet.handleToolCall("wallet_get_policy", {});
// result.data: {
//   name: "spending-limit+allowlist+rate-limit",
//   spendingLimits: {
//     daily: { amount: "100", token: "SOL", used: "23.5" },
//     perTransaction: { amount: "10", token: "SOL" }
//   },
//   allowlistedAddresses: 5,
//   allowlistedPrograms: 2,
//   rateLimits: {
//     maxPerMinute: 5,
//     maxPerHour: 50,
//     currentMinute: 2,
//     currentHour: 15
//   },
//   activeHours: {
//     timezone: "America/New_York",
//     isCurrentlyActive: true
//   },
//   approvalRequired: {
//     above: { amount: "50", token: "SOL" }
//   }
// }
```

---

## API Reference

### `AgentWallet` Methods

#### `handleToolCall(name: string, input: Record<string, unknown>): Promise<ToolCallResult>`

Dispatches a tool call to the appropriate wallet method.

- **Returns:** `{ success: boolean, data?: unknown, error?: string }`
- `success: true` — transaction confirmed or data retrieved
- `success: false` — policy denied, validation failed, or error occurred
- Unknown tool names return `{ success: false, error: "Unknown tool: ..." }`
- Internal exceptions return `{ success: false, error: "An internal error occurred..." }`

#### `toAnthropicTools(): AnthropicTool[]`

Returns tool definitions in Anthropic format (uses `input_schema` key).

#### `toOpenAITools(): OpenAITool[]`

Returns tool definitions in OpenAI format (wrapped in `{ type: "function", function: {...} }`).

#### `getPolicy(): Promise<PolicySummary>`

Returns a read-only summary of current policy constraints including:
- Spending limits with current usage
- Allowlisted address/program counts
- Rate limits with current counters
- Active hours with current status
- Approval thresholds

### `createLangChainTools(wallet: AgentWallet): LangChainToolDefinition[]`

Creates LangChain-compatible tool definitions. Each tool has a `call(input)` method that returns a JSON string. Does NOT import or depend on LangChain or Zod.

### `WALLET_TOOLS: readonly ToolDefinition[]`

The canonical array of 8 tool definitions. Each tool has `name`, `description`, and `parameters` (JSON Schema).

### `getToolByName(name: string): ToolDefinition | undefined`

Look up a tool by name from the canonical definitions.

### `WALLET_TOOL_NAMES: readonly WalletToolName[]`

The tuple of all 8 tool names as a const array.

---

## Types

```typescript
interface ToolCallResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

interface LangChainToolDefinition {
  name: string;
  description: string;
  schema: ToolDefinition["parameters"];
  call: (input: Record<string, unknown>) => Promise<string>;
}
```

---

## Security Model

### Input Validation

All tool call inputs are validated through the `execute()` pipeline:

1. **Transaction tools** (`wallet_transfer`, `wallet_swap`, etc.) → validated by `validateIntent()` which checks types, non-empty strings, positive amounts, valid chains
2. **`wallet_get_balance`** → validated directly in `handleGetBalance()` (S5-01 fix)
3. **`wallet_execute_custom`** → accounts JSON is parsed and structurally validated per-element (S5-02 fix)

### Error Sanitization

- Internal exceptions in `handleToolCall()` return a generic error message (S5-04 fix)
- LangChain adapter has independent try/catch for `JSON.stringify` failures (S5-10 fix)
- Transaction errors (from chain adapter failures) flow through `execute()` → `TransactionResult.error.message` and ARE included in the tool result (these are operational errors, not internal details)

### Immutability

- `PolicyEngine.getRules()` returns a frozen defensive copy (S5-05 fix)
- Adapter format converters create shallow copies of tool properties and required arrays
- `WALLET_TOOLS` is declared with `as const` and `readonly` (compile-time)

### Information Exposure

- `getPolicy()` exposes current usage counters (by design — helps agents plan within limits)
- Allowlist introspection only exposes counts, not actual addresses/programs
- Time window introspection exposes timezone and current active status
- Transaction history limited to `MAX_HISTORY_LIMIT = 1000` entries

---

## Files

| File | Purpose |
|------|---------|
| `src/adapters/tools.ts` | Canonical tool definitions (single source of truth) |
| `src/adapters/claude.ts` | Anthropic format converter |
| `src/adapters/openai.ts` | OpenAI format converter |
| `src/adapters/langchain.ts` | LangChain adapter with `call()` wrapper |
| `src/adapters/types.ts` | Shared types: `ToolDefinition`, `ToolParameter`, `ToolCallResult` |
| `src/adapters/index.ts` | Barrel exports |
| `src/core/wallet.ts` | `handleToolCall()`, `toAnthropicTools()`, `toOpenAITools()`, `getPolicy()` |
| `src/policy/engine.ts` | `getRules()` method |
| `src/policy/rules/*.ts` | `getConfig()` methods on all 5 rules |
