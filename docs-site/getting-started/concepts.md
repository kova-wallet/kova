# Core Concepts

This page covers the architecture of `kova` and the key abstractions you will work with.

## Architecture Overview

`kova` follows a layered architecture where each component has a single responsibility:

```
┌──────────────────────────────────────────────────────┐
│                    AI Agent                          │
│            (Claude / OpenAI / LangChain)             │
└──────────────────┬───────────────────────────────────┘
                   │ tool call
                   ▼
┌──────────────────────────────────────────────────────┐
│                 AgentWallet                           │
│         (orchestrates the full pipeline)             │
├──────────────────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │  Signer  │  │  Store   │  │  Chain Adapter     │  │
│  └──────────┘  └──────────┘  └───────────────────┘  │
│  ┌──────────────────────────────────────────────┐    │
│  │            Policy Engine                      │    │
│  │  ┌─────────┐ ┌──────────┐ ┌───────────────┐  │    │
│  │  │ Rules   │ │ Store    │ │ Approval Chan │  │    │
│  │  └─────────┘ └──────────┘ └───────────────┘  │    │
│  └──────────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────────┐    │
│  │          Audit Logger + Circuit Breaker       │    │
│  └──────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────┘
```

## Key Terms

### Transaction Intent

A high-level, declarative description of what an agent wants to accomplish. Agents express _what_ they want (e.g., "transfer 1 SOL to address X"), not _how_ to do it (e.g., "build a Solana transaction with these instructions"). The SDK handles all chain-specific details.

```typescript
const intent: TransactionIntent = {
  type: "transfer",        // what kind of operation
  chain: "solana",         // which blockchain
  params: {                // operation-specific parameters
    to: "9WzDXwBb...",
    amount: "1.5",
    token: "SOL",
  },
  metadata: {              // optional context for audit
    reason: "Payment for task",
    agentId: "bot-01",
  },
};
```

Five intent types are supported: `transfer`, `swap`, `mint`, `stake`, and `custom`.

### Policy Engine

The core enforcement layer. The `PolicyEngine` holds an ordered list of `PolicyRule` instances and evaluates them sequentially against each transaction intent. Evaluation stops at the first `DENY`. If all rules pass, the intent is `ALLOW`ed.

The engine follows a **deny-by-default, fail-closed** design: if any rule throws an exception, the result is `DENY` with an audit trail.

### Policy Rules

Individual constraints that are composed into a policy. Each rule implements the `PolicyRule` interface with a single `evaluate()` method. Built-in rules:

| Rule | Purpose |
|------|---------|
| `SpendingLimitRule` | Per-transaction, daily, weekly, and monthly spending caps |
| `RateLimitRule` | Max transactions per minute and per hour |
| `AllowlistRule` | Restrict target addresses and program IDs |
| `TimeWindowRule` | Restrict when the agent can transact (active hours) |
| `ApprovalGateRule` | Require human approval above a configurable threshold |

### Store

A minimal persistence interface (5 methods: `get`, `set`, `increment`, `append`, `getRecent`) used for spending counters, rate limit counters, idempotency keys, and audit logs. Two implementations ship with the SDK:

- **`MemoryStore`** -- In-memory, for development and testing
- **`SqliteStore`** -- Persistent, using SQLite with WAL mode

### Signer

Responsible for holding keys and signing transactions. The `Signer` interface has three methods: `getAddress()`, `sign()`, and `healthCheck()`. The SDK ships with:

- **`LocalSigner`** -- Holds a Solana `Keypair` in memory (development only)
- **`MPCSigner`** -- Stub for MPC-based signing (Phase 2)

### Chain Adapter

Encapsulates all blockchain-specific logic: building transactions, broadcasting, checking balances, and validating addresses. The `ChainAdapter` interface has 6 methods. Currently, `SolanaAdapter` is the only implementation, supporting SOL transfers, SPL token transfers, and Jupiter swaps.

### Approval Channel

An abstraction over human approval delivery mechanisms. The `ApprovalChannel` interface has a single `requestApproval()` method that sends a request to a human and blocks until a decision (approve, reject, or timeout). The SDK ships with `TelegramApprovalBot`.

### Audit Logger

Records every policy decision and transaction in a **SHA-256 hash chain**. Each audit entry contains the hash of the previous entry, creating a tamper-evident log. The `AuditLogger` includes an internal circuit breaker: after too many consecutive write failures, it blocks all transactions until logging is restored.

### Circuit Breaker

Tracks consecutive policy denials and enters a cooldown period after a configurable threshold. This prevents a runaway agent from hammering the wallet with requests that will be denied. The circuit breaker operates _before_ policy evaluation, so it cannot be bypassed.

## The Execute Pipeline

When you call `wallet.execute(intent)`, the following 10-step pipeline runs:

```
Intent
  │
  ▼
┌─────────────────────┐
│  1. Validate         │  Verify intent structure, types, required fields
└──────────┬──────────┘
           ▼
┌─────────────────────┐
│  2. Normalize        │  Assign ID (UUID), timestamp if not provided
└──────────┬──────────┘
           ▼
┌─────────────────────┐
│  3. Idempotency      │  Check if this intent ID was already processed (24h TTL)
│     Check            │  If cached → return cached result immediately
└──────────┬──────────┘
           ▼
┌─────────────────────┐
│  4. Audit Circuit    │  Is the audit logger healthy?
│     Check            │  If broken → FAIL (refuse all transactions)
└──────────┬──────────┘
           ▼
┌─────────────────────┐
│  5. Transaction      │  Has the agent hit too many consecutive denials?
│     Circuit Breaker  │  If open → DENY with cooldown message
└──────────┬──────────┘
           ▼
┌─────────────────────┐
│  6. Policy           │  Evaluate all rules sequentially
│     Evaluation       │  DENY → return immediately with reason
│                      │  PENDING → return (awaiting approval)
│                      │  ALLOW → continue
└──────────┬──────────┘
           ▼
┌─────────────────────┐
│  7. Build Tx         │  Chain adapter builds unsigned transaction
└──────────┬──────────┘
           ▼
┌─────────────────────┐
│  8. Sign             │  Signer signs the transaction
└──────────┬──────────┘
           ▼
┌─────────────────────┐
│  9. Broadcast        │  Chain adapter sends to network, waits for confirmation
└──────────┬──────────┘
           ▼
┌─────────────────────┐
│ 10. Audit Log        │  Record full audit entry with hash chain integrity
│     + Return Result  │  Cache result for idempotency, return TransactionResult
└─────────────────────┘
```

::: tip
The entire pipeline is serialized via a mutex. Only one `execute()` call runs at a time, preventing time-of-check-time-of-use (TOCTOU) race conditions where concurrent calls could bypass spending limits.
:::

## Policy Builder vs Manual Construction

There are two ways to create a policy:

**Fluent builder** (recommended for configuration):

```typescript
const policy = Policy.create("my-policy")
  .spendingLimit({ daily: { amount: "10", token: "SOL" } })
  .rateLimit({ maxTransactionsPerHour: 20 })
  .build();
```

**Manual rule construction** (required for the `PolicyEngine`):

```typescript
const config = policy.toJSON();
const rules = [
  new RateLimitRule(config.rateLimit!),
  new SpendingLimitRule(config.spendingLimit!),
];
const engine = new PolicyEngine(rules, store);
```

The builder produces a serializable `PolicyConfig` object. You extract the relevant fields and create individual `PolicyRule` instances, then pass them to the `PolicyEngine`. This separation keeps policy _definition_ separate from policy _execution_.

## Next Steps

- [AgentWallet API](/guide/wallet) -- Full reference for the wallet
- [Intent Types](/guide/intents) -- All 5 intent types with interfaces
- [Policy Engine](/guide/policy-engine) -- How rule evaluation works
- [Security Model](/guide/security) -- Threat model and design decisions
