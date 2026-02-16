# AgentWallet

::: info What you'll learn
- How the `AgentWallet` orchestrates the entire transaction lifecycle
- How to construct a wallet with all required and optional components
- The 10-step execute pipeline that every transaction passes through
- How to handle the four possible transaction outcomes (confirmed, denied, pending, failed)
- How to integrate with AI frameworks (Claude, OpenAI) via built-in tool definitions
:::

## Overview

The `AgentWallet` is the central hub of the Kova SDK -- think of it as **a bank account with built-in spending rules and a full audit trail**. Just like a corporate bank account has daily transfer limits, requires manager approval for large payments, and keeps a ledger of every transaction, the `AgentWallet` enforces policies, requests human approval when needed, and logs every action your AI agent takes.

You give your AI agent an `AgentWallet` instead of raw access to a blockchain. The wallet makes sure the agent can only do what you have explicitly allowed.

The `AgentWallet` class is the main entry point for the SDK. It wires together the policy engine, signer, chain adapter, and store, and exposes a high-level API for executing transactions, checking balances, and integrating with AI frameworks.

### When would I use this?

- **You are building an AI agent** that needs to send payments, swap tokens, or interact with a blockchain on its own -- but you want guardrails so it cannot drain your funds.
- **You want plug-and-play integration** with Claude (Anthropic) or GPT-4 (OpenAI) tool calling, so the AI model can invoke wallet operations safely.
- **You need a full audit trail** of every transaction attempt (approved or denied) for compliance or debugging.

## Configuration

```typescript
// Import the main AgentWallet class from the kova SDK.
// AgentWallet is the top-level object that orchestrates transaction execution,
// policy enforcement, signing, and chain interaction.
import { AgentWallet } from "kova";

// Import the TypeScript type for the wallet configuration object.
// This type defines the shape of the options you pass when constructing an AgentWallet.
import type { AgentWalletConfig } from "kova";
```

### AgentWalletConfig

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `signer` | `Signer` | Yes | The signer responsible for signing transactions (like the private key that authorizes payments from your bank account) |
| `chain` | `ChainAdapter` | Yes | The chain adapter for blockchain interactions (the connection to the blockchain network -- similar to an API client for your bank) |
| `policy` | `PolicyEngine` | Yes | The policy engine for evaluating transaction intents (your spending rules and approval workflows) |
| `store` | `Store` | Yes | The store for persisting spending counters and tx logs (the database that remembers how much has been spent today) |
| `approval` | `ApprovalChannel` | No | Optional approval channel for human-in-the-loop (e.g., a Telegram bot that messages a human for approval) |
| `logger` | `AuditLogger` | No | Optional audit logger. If not provided, one is created using the store |
| `circuitBreaker` | `Partial<CircuitBreakerConfig> \| false` | No | Circuit breaker config. Set to `false` to disable. Default: `{ threshold: 5, cooldownMs: 300000 }` |
| `onAuditFailure` | `AuditFailureCallback` | No | Callback invoked when an audit log write fails |

::: tip What is a circuit breaker?
A circuit breaker is a safety mechanism borrowed from electrical engineering. If too many transactions are denied in a row (suggesting a bug or runaway loop), the circuit breaker "trips" and blocks ALL transactions for a cooldown period. This prevents a misbehaving agent from hammering the system with doomed requests.
:::

### Basic Construction

```typescript
// Import all the core components needed to assemble a minimal AgentWallet.
// AgentWallet: the main class that ties everything together.
// PolicyEngine: evaluates rules against each transaction intent before allowing execution.
// MemoryStore: an in-memory implementation of the Store interface (good for development/testing; data is lost on restart).
// LocalSigner: signs transactions using a local Solana keypair (NOT recommended for production with real funds).
// SolanaAdapter: the chain adapter that knows how to build, send, and confirm Solana transactions.
// SpendingLimitRule: a policy rule that enforces spending caps (per-transaction, daily, weekly, monthly).
import {
  AgentWallet,
  PolicyEngine,
  MemoryStore,
  LocalSigner,
  SolanaAdapter,
  SpendingLimitRule,
} from "kova";

// Import the Keypair class from the Solana web3.js library.
// Keypair represents a Solana public/private key pair used for signing transactions.
import { Keypair } from "@solana/web3.js";

// Create an in-memory store instance.
// The store is used by the policy engine to persist spending counters, rate-limit counters,
// and by the audit logger to save transaction history. MemoryStore is ephemeral — all data
// is lost when the process exits.
const store = new MemoryStore();

// Create a local signer from a randomly generated Solana keypair.
// The signer is responsible for cryptographically signing transactions before they are broadcast.
// Keypair.generate() creates a brand-new random keypair (useful for testing on devnet).
const signer = new LocalSigner(Keypair.generate());

// Create a Solana chain adapter pointing at the Solana devnet RPC endpoint.
// The chain adapter handles chain-specific operations: building transactions from intents,
// broadcasting signed transactions, confirming them on-chain, and fetching balances.
const chain = new SolanaAdapter({ rpcUrl: "https://api.devnet.solana.com" });

// Create a PolicyEngine with a single SpendingLimitRule.
// The policy engine holds an ordered list of rules and evaluates them sequentially
// for every transaction intent. Here we set a per-transaction cap of 1 SOL.
// The store is passed so the rule can persist and read spending counters.
const engine = new PolicyEngine(
  [new SpendingLimitRule({ perTransaction: { amount: "1", token: "SOL" } })],
  store,
);

// Construct the AgentWallet by wiring together all the components.
// - signer: signs transactions
// - chain: builds and broadcasts transactions on Solana
// - policy: the engine that enforces spending/rate/allowlist rules
// - store: shared persistence layer for counters and audit logs
const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
});
```

::: tip Key terms in the code above
- **Signer**: The component that holds your private key and "signs" (cryptographically authorizes) transactions -- like entering your PIN to approve a bank transfer.
- **RPC endpoint**: A URL that lets your code talk to the blockchain network. "RPC" stands for Remote Procedure Call -- think of it as the API base URL for the blockchain.
- **Devnet**: A test version of the Solana blockchain where tokens have no real value. Use it for development and testing.
- **SOL**: The native currency of the Solana blockchain, like ETH on Ethereum or USD in traditional finance.
- **Lamports**: The smallest unit of SOL. 1 SOL = 1,000,000,000 lamports. Similar to how 1 dollar = 100 cents, but with more decimal places.
:::

### Construction with All Options

```typescript
// Import all components needed for a fully-featured production wallet setup.
// SqliteStore: a persistent store backed by SQLite (survives process restarts).
// RateLimitRule: limits how many transactions can execute per minute/hour.
// ApprovalGateRule: requires human approval for transactions above a dollar threshold.
// TelegramApprovalBot: sends approval requests to a Telegram chat and waits for human response.
// AuditLogger: records every transaction attempt (allowed or denied) in a tamper-evident hash chain.
import {
  AgentWallet,
  PolicyEngine,
  SqliteStore,
  LocalSigner,
  SolanaAdapter,
  SpendingLimitRule,
  RateLimitRule,
  ApprovalGateRule,
  TelegramApprovalBot,
  AuditLogger,
} from "kova";
import { Keypair } from "@solana/web3.js";

// Create a persistent SQLite-backed store.
// Unlike MemoryStore, SqliteStore writes data to disk so spending counters, rate-limit counters,
// and audit logs survive process restarts. The path specifies where the database file is created.
const store = new SqliteStore({ path: "./wallet.db" });

// Create a signer from an existing secret key (e.g., loaded from a secure vault or env variable).
// In production, you should NEVER hard-code secret keys. Use HSMs, MPC, or secure enclaves instead.
const signer = new LocalSigner(Keypair.fromSecretKey(mySecretKey));

// Create a Solana chain adapter pointing at mainnet-beta with "finalized" commitment.
// "finalized" means the SDK waits until the transaction is confirmed by a supermajority of validators,
// providing the strongest guarantee that the transaction will not be rolled back.
const chain = new SolanaAdapter({
  rpcUrl: "https://api.mainnet-beta.solana.com",
  commitment: "finalized",
});

// Set up a Telegram approval bot as the human-in-the-loop approval channel.
// - token: the Telegram Bot API token (keep this secret; loaded from an environment variable).
// - chatId: the Telegram chat where approval requests are sent.
// - allowedUserIds: only these Telegram user IDs can approve/reject transactions.
//   This prevents unauthorized users in the chat from approving transactions.
const approval = new TelegramApprovalBot({
  token: process.env.TELEGRAM_BOT_TOKEN!,
  chatId: process.env.TELEGRAM_CHAT_ID!,
  allowedUserIds: [123456789],
});

// Build the PolicyEngine with multiple rules, ordered from cheapest to most expensive.
// Rule evaluation stops at the first DENY, so placing cheap rules first avoids unnecessary work.
const engine = new PolicyEngine(
  [
    // Rule 1: Rate limit — at most 20 transactions per hour.
    // This is the cheapest rule (simple counter lookup), so it runs first.
    new RateLimitRule({ maxTransactionsPerHour: 20 }),

    // Rule 2: Spending limit — at most 50 SOL per rolling 24-hour period.
    // This reads and updates spending counters in the store.
    new SpendingLimitRule({ daily: { amount: "50", token: "SOL" } }),

    // Rule 3: Approval gate — transactions above 10 SOL require human approval via Telegram.
    // The timeout of 600,000ms (10 minutes) means the approval request expires after 10 minutes
    // if the human does not respond, resulting in an automatic DENY.
    new ApprovalGateRule({
      above: { amount: "10", token: "SOL" },
      timeout: 600_000,
    }),
  ],
  store,
  approval, // Pass the approval channel so the ApprovalGateRule can send requests
);

// Construct the wallet with all options configured.
const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  approval, // Also pass approval to the wallet for policy introspection

  // Circuit breaker: after 3 consecutive policy denials, block ALL transactions for 10 minutes.
  // This protects against runaway agents that keep retrying denied transactions in a tight loop.
  circuitBreaker: { threshold: 3, cooldownMs: 600_000 },

  // Callback invoked whenever an audit log write fails.
  // Use this to alert your operations team. After too many consecutive failures,
  // the audit circuit breaker opens and ALL transactions are blocked.
  onAuditFailure: (error, count) => {
    console.error(`Audit write failed (${count} consecutive):`, error);
  },
});
```

::: warning Production checklist
Before deploying with real funds, make sure you:
1. Use `SqliteStore` (or a custom persistent store) instead of `MemoryStore` -- otherwise spending limits reset every time your process restarts.
2. **Never** hard-code private keys. Load them from environment variables, a secrets manager, or an HSM.
3. Use `"finalized"` commitment on mainnet to avoid acting on transactions that get rolled back.
4. Set up the `onAuditFailure` callback to alert your team if the audit trail breaks.
:::

## The Execute Pipeline

When you call `wallet.execute(intent)`, the following 10-step pipeline runs. Think of it like an HTTP request passing through a chain of middleware -- each step can approve the request, reject it, or transform it before passing it to the next step.

The entire pipeline is serialized via a mutex (a lock that ensures only one transaction runs at a time) to prevent TOCTOU race conditions. **TOCTOU** (Time-Of-Check-to-Time-Of-Use) is a class of bug where two transactions check the same limit simultaneously and both slip through -- for example, two concurrent $8 transfers could each see a $10 limit as not exceeded, resulting in $16 total spending. The mutex prevents this by processing transactions one at a time.

| Step | Name | Description |
|------|------|-------------|
| 1 | **Validate** | Verify intent structure: type, chain, params, ID format |
| 2 | **Normalize** | Assign UUID and timestamp if not provided |
| 3 | **Idempotency Check** | Look up intent ID in store (24h TTL). Return cached result if found |
| 4 | **Audit Circuit Check** | If audit logger is broken (circuit open), refuse all transactions |
| 5 | **Transaction Circuit Breaker** | If too many consecutive denials, refuse with cooldown |
| 6 | **Policy Evaluation** | Run all rules sequentially. DENY stops immediately. PENDING waits for approval |
| 7 | **Build Transaction** | Chain adapter builds the unsigned transaction |
| 8 | **Sign** | Signer signs the transaction |
| 9 | **Broadcast** | Chain adapter sends to network and waits for confirmation |
| 10 | **Audit Log + Cache** | Record audit entry with hash chain, cache result for idempotency |

::: tip What is idempotency?
Idempotency means "doing the same thing twice produces the same result." If your agent retries a transaction with the same intent ID (for example, after a network timeout), the SDK returns the cached result from the first attempt instead of sending a duplicate payment. This is the same concept used in payment APIs like Stripe.
:::

::: warning
Denied and pending results are **not** cached for idempotency. Only confirmed and failed results are cached. This means retrying a denied intent after a rate limit expires will re-evaluate the policy rather than returning the stale denial.
:::

## Methods

### execute(intent)

Execute a transaction intent through the full pipeline. This is the primary method you will use.

A **transaction intent** is a high-level description of what you want to do (e.g., "send 0.5 SOL to this address") -- like a purchase order that describes what you want to buy, not how the payment is processed. See the [Transaction Intents](./intents.md) guide for details.

```typescript
// Method signature: takes a TransactionIntent and returns a Promise that resolves
// to a TransactionResult. The entire 10-step pipeline runs inside this call.
async execute(intent: TransactionIntent): Promise<TransactionResult>
```

```typescript
// Execute a transfer intent: send 0.5 SOL to a specific Solana address.
// The intent is a declarative description — the SDK handles building, signing,
// and broadcasting the actual Solana transaction.
const result = await wallet.execute({
  type: "transfer",       // The operation type — "transfer" means sending tokens
  chain: "solana",        // Target blockchain — tells the SDK which chain adapter to use
  params: {
    to: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", // Recipient's Solana wallet address
    amount: "0.5",        // Human-readable amount (the SDK converts to lamports internally)
    token: "SOL",         // Token symbol — "SOL" is the native Solana token
  },
  metadata: {
    reason: "Paying for completed task",  // Human-readable justification (shown in audit logs and approval requests)
    agentId: "agent-01",                  // Identifies which AI agent initiated this transaction
  },
});

// Check the result status and handle each possible outcome.
// The four possible statuses represent the full lifecycle of a transaction attempt.
if (result.status === "confirmed") {
  // Transaction was successfully broadcast and confirmed on the Solana blockchain.
  // result.txId contains the on-chain transaction signature.
  console.log("Transaction confirmed:", result.txId);
} else if (result.status === "denied") {
  // The policy engine rejected this transaction (e.g., spending limit exceeded, rate limit hit).
  // result.error.message explains which rule denied it and why.
  console.log("Denied:", result.error?.message);
} else if (result.status === "pending") {
  // The transaction requires human approval (e.g., ApprovalGateRule triggered).
  // An approval request has been sent (e.g., via Telegram) and is awaiting a human decision.
  console.log("Awaiting approval:", result.summary);
} else {
  // The transaction was attempted but failed during build, sign, or broadcast.
  // This means the policy allowed it, but something went wrong on-chain.
  console.log("Failed:", result.error?.message);
}
```

### getBalance(token)

Get the wallet's balance for a specific token. A **token** is any digital currency on the blockchain -- SOL is the native token of Solana, and **SPL tokens** (like USDC) are additional currencies built on top of Solana (similar to how ERC-20 tokens work on Ethereum).

```typescript
// Method signature: takes a token symbol (e.g., "SOL", "USDC") and returns
// a Promise resolving to a TokenBalance object with the amount and metadata.
async getBalance(token: string): Promise<TokenBalance>
```

```typescript
// Query the wallet's SOL balance via the chain adapter.
// The chain adapter fetches the balance from the Solana RPC endpoint.
const balance = await wallet.getBalance("SOL");

// Display the balance amount and token symbol (e.g., "Balance: 5.23 SOL").
console.log(`Balance: ${balance.amount} ${balance.token}`);

// Display the number of decimal places for this token.
// SOL has 9 decimals (1 SOL = 1,000,000,000 lamports).
console.log(`Decimals: ${balance.decimals}`);

// If a USD value is available (provided by a price feed), display it.
// This field is optional and depends on the chain adapter's price feed configuration.
if (balance.usdValue !== undefined) {
  console.log(`USD value: $${balance.usdValue.toFixed(2)}`);
}
```

### getAddress()

Get the wallet's public address. A **public address** is like a bank account number -- it is safe to share and is what other people use to send you funds.

```typescript
// Method signature: returns a Promise resolving to the wallet's public address string.
// This is derived from the signer's public key.
async getAddress(): Promise<string>
```

```typescript
// Retrieve the wallet's public address (the Solana base58-encoded public key).
// This is the address others use to send tokens to this wallet.
const address = await wallet.getAddress();
console.log("Wallet address:", address);
```

### getPolicy()

Get a read-only summary of the current policy constraints. Agents can use this to plan within their limits -- for example, an agent can check its remaining daily budget before deciding whether to attempt a transaction.

```typescript
// Method signature: returns a Promise resolving to a PolicySummary object.
// The summary contains a human-readable overview of all configured policy constraints.
async getPolicy(): Promise<PolicySummary>
```

```typescript
// Fetch the current policy summary so the agent can understand its operational limits.
// This is useful for AI agents that want to check their remaining budget or rate limits
// before attempting a transaction.
const summary = await wallet.getPolicy();

// Display each aspect of the policy configuration.
console.log("Policy name:", summary.name);                       // The human-readable policy name
console.log("Spending limits:", summary.spendingLimits);         // Per-tx, daily, weekly, monthly caps
console.log("Allowlisted addresses:", summary.allowlistedAddresses); // Addresses the agent can send to
console.log("Rate limits:", summary.rateLimits);                 // Max transactions per minute/hour
console.log("Active hours:", summary.activeHours);               // Time windows when transactions are allowed
console.log("Approval required:", summary.approvalRequired);     // Threshold above which human approval is needed
console.log("Circuit breaker:", summary.circuitBreaker);         // Circuit breaker status and configuration
```

### getTransactionHistory(limit?)

Get recent transaction history from the audit log. Useful for dashboards, debugging, or letting your agent review what it has already done.

```typescript
// Method signature: takes an optional limit (default 10, max 1000) and returns
// a Promise resolving to an array of past TransactionResult objects from the audit log.
async getTransactionHistory(limit?: number): Promise<TransactionResult[]>
```

The `limit` parameter defaults to 10 and is clamped to the range `[1, 1000]`.

```typescript
// Fetch the 20 most recent transactions from the audit log.
// This includes both successful and denied transactions.
const history = await wallet.getTransactionHistory(20);

// Iterate over the transaction history and display a summary line for each.
// Each entry includes the status (confirmed/denied/failed), a human-readable summary,
// and the intent ID for cross-referencing.
for (const tx of history) {
  console.log(`[${tx.status}] ${tx.summary} (${tx.intentId})`);
}
```

### handleToolCall(name, input)

Handle a tool call from an AI agent. This is the bridge between AI model tool calling and the wallet. When an AI model (like Claude or GPT-4) decides it wants to perform a wallet operation, it outputs a tool name and parameters. You pass those directly to `handleToolCall()`, and it dispatches to the appropriate wallet method. Errors are sanitized to prevent leaking internal details to the AI model.

```typescript
// Method signature: takes a tool name string and an input object (key-value pairs from the AI model),
// and returns a ToolCallResult indicating success or failure.
// This is the bridge between AI agent tool calls and the wallet's internal methods.
async handleToolCall(
  name: string,
  input: Record<string, unknown>
): Promise<ToolCallResult>
```

Supported tool names:

| Tool Name | Maps To |
|-----------|---------|
| `wallet_transfer` | `execute({ type: "transfer", ... })` |
| `wallet_swap` | `execute({ type: "swap", ... })` |
| `wallet_mint` | `execute({ type: "mint", ... })` |
| `wallet_stake` | `execute({ type: "stake", ... })` |
| `wallet_execute_custom` | `execute({ type: "custom", ... })` |
| `wallet_get_balance` | `getBalance(token)` |
| `wallet_get_policy` | `getPolicy()` |
| `wallet_get_transaction_history` | `getTransactionHistory(limit)` |

```typescript
// Handle a tool call from an AI agent that wants to transfer SOL.
// The AI model outputs a tool name ("wallet_transfer") and parameters as a flat object.
// handleToolCall maps this to wallet.execute() with the correct intent structure.
const result = await wallet.handleToolCall("wallet_transfer", {
  chain: "solana",                                          // Target chain
  to: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",    // Recipient address
  amount: "0.5",                                            // Amount to send
  token: "SOL",                                             // Token symbol
  reason: "Payment for task",                               // Metadata reason for audit trail
});

// Check whether the tool call succeeded.
// Errors are sanitized — the AI agent only sees a generic message, not internal details.
if (result.success) {
  console.log("Transfer succeeded:", result.data);  // Contains the TransactionResult
} else {
  console.log("Transfer failed:", result.error);    // Sanitized error message
}
```

### toAnthropicTools()

Get tool definitions formatted for the Anthropic (Claude) API. These definitions tell Claude what wallet operations are available and how to call them.

```typescript
// Method signature: returns an array of tool definitions in the format expected
// by the Anthropic Messages API. These define the wallet operations the AI can invoke.
toAnthropicTools(): AnthropicTool[]
```

```typescript
// Import the Anthropic SDK for interacting with the Claude API.
import Anthropic from "@anthropic-ai/sdk";

// Create an Anthropic client (uses the ANTHROPIC_API_KEY environment variable by default).
const client = new Anthropic();

// Get wallet tool definitions formatted for the Anthropic API.
// These tell Claude what wallet operations are available (transfer, swap, get_balance, etc.),
// including parameter schemas so Claude knows how to structure its tool calls.
const tools = wallet.toAnthropicTools();

// Send a message to Claude with the wallet tools attached.
// Claude can now decide to call wallet tools (e.g., wallet_transfer) based on the user's request.
// When Claude returns a tool_use block, you pass it to wallet.handleToolCall() to execute.
const response = await client.messages.create({
  model: "claude-sonnet-4-5-20250929",  // The Claude model to use
  max_tokens: 1024,                   // Maximum response length
  tools,                              // Attach the wallet tool definitions
  messages: [{ role: "user", content: "Send 0.1 SOL to Alice" }],
});
```

### toOpenAITools()

Get tool definitions formatted for the OpenAI API. Same concept as `toAnthropicTools()`, but formatted for OpenAI's function calling interface.

```typescript
// Method signature: returns an array of tool definitions in the format expected
// by the OpenAI Chat Completions API (function calling).
toOpenAITools(): OpenAITool[]
```

```typescript
// Import the OpenAI SDK for interacting with the OpenAI API.
import OpenAI from "openai";

// Create an OpenAI client (uses the OPENAI_API_KEY environment variable by default).
const client = new OpenAI();

// Get wallet tool definitions formatted for the OpenAI API.
// The format differs from Anthropic's but contains the same information:
// available operations, parameter schemas, and descriptions.
const tools = wallet.toOpenAITools();

// Send a chat completion request with the wallet tools attached.
// GPT-4 can now decide to call wallet functions based on the user's message.
// When GPT-4 returns a function_call, you pass the name and arguments to wallet.handleToolCall().
const response = await client.chat.completions.create({
  model: "gpt-4",   // The OpenAI model to use
  tools,             // Attach the wallet tool definitions
  messages: [{ role: "user", content: "Send 0.1 SOL to Alice" }],
});
```

## TransactionResult

Every `execute()` call returns a `TransactionResult`. This object tells you exactly what happened -- whether the transaction succeeded, was blocked by policy, is waiting for approval, or failed for a technical reason.

```typescript
interface TransactionResult {
  /** "confirmed" | "denied" | "pending" | "failed" */
  status: TransactionStatus;
  /** Transaction ID / signature on the blockchain (if submitted) */
  txId?: string;
  /** Human-readable summary of what happened */
  summary: string;
  /** The intent ID this result corresponds to */
  intentId: string;
  /** Timestamp when the result was produced */
  timestamp: number;
  /** Error details if status is "failed" or "denied" */
  error?: TransactionError;
  /** Chain-specific details */
  chainData?: Record<string, unknown>;
}
```

### Status Values

| Status | Meaning | What to do |
|--------|---------|------------|
| `confirmed` | Transaction was broadcast and confirmed on-chain | Success -- the funds have moved. Store `txId` for your records. |
| `denied` | Policy engine rejected the transaction | Check `error.message` to understand which rule blocked it and why. |
| `pending` | Transaction requires human approval (approval request sent) | Wait for the human to approve or reject via the approval channel. |
| `failed` | Transaction was attempted but failed (build, sign, or broadcast error) | Check `error.message`. The policy allowed it, but something went wrong technically. |

## Error Codes

The `error.code` field in `TransactionResult` uses one of the following `TransactionErrorCode` values:

| Code | Description |
|------|-------------|
| `VALIDATION_FAILED` | Intent structure is invalid (missing fields, bad types, invalid amount) |
| `POLICY_DENIED` | A policy rule denied the transaction |
| `SPENDING_LIMIT_EXCEEDED` | Transaction exceeds a spending limit |
| `ADDRESS_NOT_ALLOWED` | Target address is not in the allowlist or is denylisted |
| `PROGRAM_NOT_ALLOWED` | Program ID is not in the allowlist or is denylisted |
| `RATE_LIMIT_EXCEEDED` | Too many transactions in the time window |
| `OUTSIDE_TIME_WINDOW` | Transaction attempted outside active hours |
| `APPROVAL_REJECTED` | Human approver rejected the transaction |
| `APPROVAL_TIMEOUT` | Approval request timed out |
| `INSUFFICIENT_BALANCE` | Wallet does not have enough funds |
| `TRANSACTION_FAILED` | On-chain transaction failed (e.g., simulation error) |
| `SIGNER_ERROR` | Signer failed to sign the transaction |
| `CHAIN_ERROR` | Chain adapter encountered an error |
| `STORE_ERROR` | Store operation failed (e.g., audit logging is broken) |
| `CIRCUIT_BREAKER_OPEN` | Circuit breaker is blocking transactions after consecutive denials |
| `UNKNOWN_ERROR` | Unexpected error |

::: danger
When `STORE_ERROR` is returned with "audit logging circuit breaker is open", **all transactions are blocked** until audit logging is restored. This is a safety feature -- the SDK refuses to process transactions without a functioning audit trail.
:::

## Common Mistakes

**1. Using `MemoryStore` in production.**
`MemoryStore` loses all data when your process restarts. This means spending limits reset to zero, rate-limit counters disappear, and your audit trail is gone. Always use `SqliteStore` or a custom persistent `Store` implementation in production.

**2. Not handling all four result statuses.**
Many developers only check for `confirmed` and ignore the rest. Always handle `denied`, `pending`, and `failed` -- your agent needs to know when a transaction was blocked so it can adjust its behavior, not just retry blindly.

**3. Retrying denied transactions in a tight loop.**
If a transaction is denied (e.g., spending limit exceeded), retrying immediately will hit the same limit and trigger the circuit breaker. Check the denial reason and wait for the limit to reset, or reduce the amount.

**4. Sharing a wallet across multiple agents without `PrefixedStore`.**
If multiple agents share the same `AgentWallet` instance and store, their spending counters and rate limits will be combined. Use `PrefixedStore` to isolate each agent's state, or create separate wallet instances for each agent.

## Quick Reference

| Method | Returns | Description |
|--------|---------|-------------|
| `execute(intent)` | `Promise<TransactionResult>` | Run an intent through the full 10-step pipeline (validate, policy check, build, sign, broadcast) |
| `getBalance(token)` | `Promise<TokenBalance>` | Check the wallet's balance for a specific token (e.g., "SOL", "USDC") |
| `getAddress()` | `Promise<string>` | Get the wallet's public address (the address others send funds to) |
| `getPolicy()` | `Promise<PolicySummary>` | Get a read-only summary of all policy constraints (limits, allowlists, rate limits) |
| `getTransactionHistory(limit?)` | `Promise<TransactionResult[]>` | Fetch recent transactions from the audit log (default: 10, max: 1000) |
| `handleToolCall(name, input)` | `Promise<ToolCallResult>` | Dispatch an AI model's tool call to the appropriate wallet method |
| `toAnthropicTools()` | `AnthropicTool[]` | Get tool definitions formatted for the Claude (Anthropic) API |
| `toOpenAITools()` | `OpenAITool[]` | Get tool definitions formatted for the OpenAI API |
