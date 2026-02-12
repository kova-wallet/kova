# AgentWallet

The `AgentWallet` class is the main entry point for the SDK. It wires together the policy engine, signer, chain adapter, and store, and exposes a high-level API for executing transactions, checking balances, and integrating with AI frameworks.

## Configuration

```typescript
import { AgentWallet } from "kova";
import type { AgentWalletConfig } from "kova";
```

### AgentWalletConfig

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `signer` | `Signer` | Yes | The signer responsible for signing transactions |
| `chain` | `ChainAdapter` | Yes | The chain adapter for blockchain interactions |
| `policy` | `PolicyEngine` | Yes | The policy engine for evaluating transaction intents |
| `store` | `Store` | Yes | The store for persisting spending counters and tx logs |
| `approval` | `ApprovalChannel` | No | Optional approval channel for human-in-the-loop |
| `logger` | `AuditLogger` | No | Optional audit logger. If not provided, one is created using the store |
| `circuitBreaker` | `Partial<CircuitBreakerConfig> \| false` | No | Circuit breaker config. Set to `false` to disable. Default: `{ threshold: 5, cooldownMs: 300000 }` |
| `onAuditFailure` | `AuditFailureCallback` | No | Callback invoked when an audit log write fails |

### Basic Construction

```typescript
import {
  AgentWallet,
  PolicyEngine,
  MemoryStore,
  LocalSigner,
  SolanaAdapter,
  SpendingLimitRule,
} from "kova";
import { Keypair } from "@solana/web3.js";

const store = new MemoryStore();
const signer = new LocalSigner(Keypair.generate());
const chain = new SolanaAdapter({ rpcUrl: "https://api.devnet.solana.com" });
const engine = new PolicyEngine(
  [new SpendingLimitRule({ perTransaction: { amount: "1", token: "SOL" } })],
  store,
);

const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
});
```

### Construction with All Options

```typescript
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

const store = new SqliteStore({ path: "./wallet.db" });
const signer = new LocalSigner(Keypair.fromSecretKey(mySecretKey));
const chain = new SolanaAdapter({
  rpcUrl: "https://api.mainnet-beta.solana.com",
  commitment: "finalized",
});

const approval = new TelegramApprovalBot({
  token: process.env.TELEGRAM_BOT_TOKEN!,
  chatId: process.env.TELEGRAM_CHAT_ID!,
  allowedUserIds: [123456789],
});

const engine = new PolicyEngine(
  [
    new RateLimitRule({ maxTransactionsPerHour: 20 }),
    new SpendingLimitRule({ daily: { amount: "50", token: "SOL" } }),
    new ApprovalGateRule({
      above: { amount: "10", token: "SOL" },
      timeout: 600_000,
    }),
  ],
  store,
  approval,
);

const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  approval,
  circuitBreaker: { threshold: 3, cooldownMs: 600_000 },
  onAuditFailure: (error, count) => {
    console.error(`Audit write failed (${count} consecutive):`, error);
  },
});
```

## The Execute Pipeline

When you call `wallet.execute(intent)`, the following 10-step pipeline runs. The entire pipeline is serialized via a mutex to prevent TOCTOU race conditions.

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

::: warning
Denied and pending results are **not** cached for idempotency. Only confirmed and failed results are cached. This means retrying a denied intent after a rate limit expires will re-evaluate the policy rather than returning the stale denial.
:::

## Methods

### execute(intent)

Execute a transaction intent through the full pipeline.

```typescript
async execute(intent: TransactionIntent): Promise<TransactionResult>
```

```typescript
const result = await wallet.execute({
  type: "transfer",
  chain: "solana",
  params: {
    to: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    amount: "0.5",
    token: "SOL",
  },
  metadata: {
    reason: "Paying for completed task",
    agentId: "agent-01",
  },
});

if (result.status === "confirmed") {
  console.log("Transaction confirmed:", result.txId);
} else if (result.status === "denied") {
  console.log("Denied:", result.error?.message);
} else if (result.status === "pending") {
  console.log("Awaiting approval:", result.summary);
} else {
  console.log("Failed:", result.error?.message);
}
```

### getBalance(token)

Get the wallet's balance for a specific token.

```typescript
async getBalance(token: string): Promise<TokenBalance>
```

```typescript
const balance = await wallet.getBalance("SOL");
console.log(`Balance: ${balance.amount} ${balance.token}`);
console.log(`Decimals: ${balance.decimals}`);
if (balance.usdValue !== undefined) {
  console.log(`USD value: $${balance.usdValue.toFixed(2)}`);
}
```

### getAddress()

Get the wallet's public address.

```typescript
async getAddress(): Promise<string>
```

```typescript
const address = await wallet.getAddress();
console.log("Wallet address:", address);
```

### getPolicy()

Get a read-only summary of the current policy constraints. Agents can use this to plan within their limits.

```typescript
async getPolicy(): Promise<PolicySummary>
```

```typescript
const summary = await wallet.getPolicy();
console.log("Policy name:", summary.name);
console.log("Spending limits:", summary.spendingLimits);
console.log("Allowlisted addresses:", summary.allowlistedAddresses);
console.log("Rate limits:", summary.rateLimits);
console.log("Active hours:", summary.activeHours);
console.log("Approval required:", summary.approvalRequired);
console.log("Circuit breaker:", summary.circuitBreaker);
```

### getTransactionHistory(limit?)

Get recent transaction history from the audit log.

```typescript
async getTransactionHistory(limit?: number): Promise<TransactionResult[]>
```

The `limit` parameter defaults to 10 and is clamped to the range `[1, 1000]`.

```typescript
const history = await wallet.getTransactionHistory(20);
for (const tx of history) {
  console.log(`[${tx.status}] ${tx.summary} (${tx.intentId})`);
}
```

### handleToolCall(name, input)

Handle a tool call from an AI agent. Dispatches to the appropriate wallet method based on the tool name. Errors are sanitized to prevent leaking internal details.

```typescript
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
const result = await wallet.handleToolCall("wallet_transfer", {
  chain: "solana",
  to: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  amount: "0.5",
  token: "SOL",
  reason: "Payment for task",
});

if (result.success) {
  console.log("Transfer succeeded:", result.data);
} else {
  console.log("Transfer failed:", result.error);
}
```

### toAnthropicTools()

Get tool definitions formatted for the Anthropic (Claude) API.

```typescript
toAnthropicTools(): AnthropicTool[]
```

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
const tools = wallet.toAnthropicTools();

const response = await client.messages.create({
  model: "claude-sonnet-4-20250514",
  max_tokens: 1024,
  tools,
  messages: [{ role: "user", content: "Send 0.1 SOL to Alice" }],
});
```

### toOpenAITools()

Get tool definitions formatted for the OpenAI API.

```typescript
toOpenAITools(): OpenAITool[]
```

```typescript
import OpenAI from "openai";

const client = new OpenAI();
const tools = wallet.toOpenAITools();

const response = await client.chat.completions.create({
  model: "gpt-4",
  tools,
  messages: [{ role: "user", content: "Send 0.1 SOL to Alice" }],
});
```

## TransactionResult

Every `execute()` call returns a `TransactionResult`:

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

| Status | Meaning |
|--------|---------|
| `confirmed` | Transaction was broadcast and confirmed on-chain |
| `denied` | Policy engine rejected the transaction |
| `pending` | Transaction requires human approval (approval request sent) |
| `failed` | Transaction was attempted but failed (build, sign, or broadcast error) |

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
