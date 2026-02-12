# Core Concepts

::: info What you'll learn
- The layered architecture of kova and how components fit together
- What each key abstraction does (intents, policy engine, signers, stores, and more)
- The full 10-step execute pipeline that every transaction goes through
- The two ways to define policies: fluent builder vs manual construction
:::

This page covers the architecture of `kova` and the key abstractions you will work with. Each concept is explained with analogies to common software patterns, so you don't need blockchain experience to follow along.

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

::: tip How to read this diagram
Think of `AgentWallet` as the "controller" in an MVC application. It receives requests (tool calls from the AI agent), coordinates several services (signer, policy engine, chain adapter), and returns a result. No component talks directly to the AI agent except through the wallet.
:::

## Key Terms

### Transaction Intent

A high-level, declarative description of what an agent wants to accomplish. Agents express _what_ they want (e.g., "transfer 1 SOL to address X"), not _how_ to do it (e.g., "build a Solana transaction with these instructions"). The SDK handles all chain-specific details.

**Real-world analogy:** A transaction intent is like filling out a bank transfer form. You write down the recipient, the amount, and the reason -- the bank handles the wire protocol, routing, and settlement. The AI agent fills out the "form" and kova does the rest.

```typescript
// A TransactionIntent is the high-level, declarative description of what an
// agent wants to do. The agent never builds raw Solana transactions directly --
// it just describes "what" and the SDK handles "how."
const intent: TransactionIntent = {
  type: "transfer",        // The operation type. One of: "transfer", "swap", "mint", "stake", "custom".
                           // Each type has its own params shape (TransferParams, SwapParams, etc.).
  chain: "solana",         // Target blockchain identifier. Currently only "solana" is supported.
                           // This tells the SDK which ChainAdapter to use for building the transaction.
  params: {                // Operation-specific parameters -- shape depends on `type`.
    to: "9WzDXwBb...",    // Recipient's Solana address (base58-encoded public key).
    amount: "1.5",         // Human-readable amount (not lamports). The SDK converts internally.
    token: "SOL",          // Token to transfer. Use "SOL" for native SOL or a mint address for SPL tokens.
  },
  metadata: {              // Optional key-value context. Not used for policy evaluation,
                           // but stored in the audit log for debugging and compliance.
    reason: "Payment for task",  // Why the agent is making this payment (human-readable).
    agentId: "bot-01",           // Identifies which agent instance initiated the intent.
  },
};
```

Five intent types are supported: `transfer`, `swap`, `mint`, `stake`, and `custom`.

::: info What are SPL tokens?
SPL tokens (Solana Program Library tokens) are custom tokens built on Solana, similar to ERC-20 tokens on Ethereum. Examples include USDC, USDT, and other digital assets. When transferring SPL tokens, you use the token's mint address (a unique identifier) instead of `"SOL"` in the `token` field. You don't need to understand SPL token internals to use kova -- just provide the mint address.
:::

### Policy Engine

The core enforcement layer. The `PolicyEngine` holds an ordered list of `PolicyRule` instances and evaluates them sequentially against each transaction intent. Evaluation stops at the first `DENY`. If all rules pass, the intent is `ALLOW`ed.

The engine follows a **deny-by-default, fail-closed** design: if any rule throws an exception, the result is `DENY` with an audit trail.

**Real-world analogy:** The policy engine is like middleware in Express.js or a chain of security guards. Each guard (rule) checks one thing -- your ID, your ticket, your bag. If any guard says "no," you're turned away immediately. You only get through if every single guard approves. And if a guard can't make a decision (throws an error), the default answer is "no."

### Why this matters

The deny-by-default design means your wallet is safe even when things go wrong. A bug in a custom rule, a network timeout, or an unexpected edge case will result in a denied transaction -- not an approved one. Your money is protected by default.

### Policy Rules

Individual constraints that are composed into a policy. Each rule implements the `PolicyRule` interface with a single `evaluate()` method. Built-in rules:

| Rule | Purpose | Analogy |
|------|---------|---------|
| `SpendingLimitRule` | Per-transaction, daily, weekly, and monthly spending caps | A credit card's daily spending limit |
| `RateLimitRule` | Max transactions per minute and per hour | API rate limiting (e.g., 100 requests/minute) |
| `AllowlistRule` | Restrict target addresses and program IDs | A corporate card restricted to approved vendors |
| `TimeWindowRule` | Restrict when the agent can transact (active hours) | A store that's only open 9am-5pm |
| `ApprovalGateRule` | Require human approval above a configurable threshold | Manager approval for purchases over $1,000 |

::: tip Mix and match
You can combine any number of rules. A typical production setup might use all five: spending limits to cap exposure, rate limits to prevent runaway agents, an allowlist to restrict recipients, time windows for business hours only, and approval gates for high-value transactions.
:::

### Store

A minimal persistence interface (5 methods: `get`, `set`, `increment`, `append`, `getRecent`) used for spending counters, rate limit counters, idempotency keys (used to prevent the same transaction from being processed twice), and audit logs. Two implementations ship with the SDK:

- **`MemoryStore`** -- In-memory, for development and testing. Think of it like storing data in a JavaScript `Map` -- fast but gone when the process restarts.
- **`SqliteStore`** -- Persistent, using SQLite with WAL mode (a high-performance file-based database). Think of it like using a local database file that survives restarts.

::: warning Choosing the right store
Use `MemoryStore` for development and testing only. In production, always use `SqliteStore` (or a custom store implementation). Without persistence, spending limits reset on every restart, which defeats their purpose entirely.
:::

### Signer

Responsible for holding keys and signing transactions (cryptographically approving a transaction so the blockchain knows it came from the wallet owner -- like a digital signature on a legal document). The `Signer` interface has three methods: `getAddress()`, `sign()`, and `healthCheck()`. The SDK ships with:

- **`LocalSigner`** -- Holds a Solana `Keypair` in memory (development only). Simple and fast, but the key exists in plain text in your process memory.
- **`MPCSigner`** -- Stub for MPC-based signing (Phase 2). MPC (Multi-Party Computation) splits the key across multiple parties so no single server holds the full key -- significantly more secure for production.

### Chain Adapter

Encapsulates all blockchain-specific logic: building transactions, broadcasting (sending signed transactions to the blockchain network), checking balances, and validating addresses. The `ChainAdapter` interface has 6 methods. Currently, `SolanaAdapter` is the only implementation, supporting SOL transfers, SPL token transfers, and Jupiter swaps (Jupiter is a popular Solana DEX aggregator for token swaps).

**Real-world analogy:** A chain adapter is like a database driver. You write your application logic once (using the `ChainAdapter` interface), and the specific adapter (e.g., `SolanaAdapter`) handles the dialect-specific details -- just like how Sequelize lets you swap between PostgreSQL, MySQL, and SQLite without changing your application code.

### Approval Channel

An abstraction over human approval delivery mechanisms. The `ApprovalChannel` interface has a single `requestApproval()` method that sends a request to a human and blocks until a decision (approve, reject, or timeout). The SDK ships with `TelegramApprovalBot`.

**Real-world analogy:** Think of this like a pull request review. The agent wants to make a large transaction, but instead of proceeding automatically, it sends a notification to a human reviewer (via Telegram). The transaction is "paused" until the reviewer approves or rejects it -- just like code doesn't merge until someone clicks "Approve."

### Audit Logger

Records every policy decision and transaction in a **SHA-256 hash chain** (each entry includes a cryptographic fingerprint of the previous entry, making it impossible to alter past records without detection). Each audit entry contains the hash of the previous entry, creating a tamper-evident log. The `AuditLogger` includes an internal circuit breaker: after too many consecutive write failures, it blocks all transactions until logging is restored.

### Why the audit logger blocks transactions on failure

This is a deliberate safety design. If the audit system fails, transactions could happen without being recorded -- creating a gap in your compliance trail. By blocking all transactions when logging breaks, kova ensures you never lose visibility into what your agent is doing.

### Circuit Breaker

Tracks consecutive policy denials and enters a cooldown period after a configurable threshold. This prevents a runaway agent from hammering the wallet with requests that will be denied. The circuit breaker operates _before_ policy evaluation, so it cannot be bypassed.

**Real-world analogy:** This works like a physical circuit breaker in your house. If too much current flows (too many denied transactions), the breaker trips and cuts power (blocks all requests) until conditions stabilize. It protects the system from an out-of-control agent that's stuck in a retry loop.

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
The entire pipeline is serialized via a mutex (a lock that ensures only one operation runs at a time). Only one `execute()` call runs at a time, preventing time-of-check-time-of-use (TOCTOU) race conditions where concurrent calls could bypass spending limits.
:::

::: info Why so many steps?
Each step addresses a specific security or reliability concern. Steps 1-2 ensure data integrity. Step 3 prevents duplicate processing. Steps 4-5 are circuit breakers that protect against system failures and runaway agents. Step 6 enforces your custom rules. Steps 7-9 handle the actual blockchain interaction. Step 10 creates the audit trail. You don't need to manage these steps yourself -- they all run automatically when you call `execute()`.
:::

## Policy Builder vs Manual Construction

There are two ways to create a policy:

**Fluent builder** (recommended for configuration):

```typescript
// The fluent builder provides a declarative, chainable API for defining policies.
// Each method call adds a constraint. Call .build() at the end to produce an
// immutable Policy object that can be serialized to JSON or used to create rules.
const policy = Policy.create("my-policy")              // Initialize a new policy with a unique name
  .spendingLimit({ daily: { amount: "10", token: "SOL" } })  // Cap total daily spending at 10 SOL
  .rateLimit({ maxTransactionsPerHour: 20 })                  // Allow at most 20 transactions per hour
  .build();                                                    // Finalize and return the Policy object
```

**Manual rule construction** (required for the `PolicyEngine`):

```typescript
// Convert the Policy object to a plain JSON config so we can extract
// configuration for each individual rule. The "!" (non-null assertion)
// tells TypeScript these fields exist because we set them in the builder.
const config = policy.toJSON();

// Create concrete PolicyRule instances. Each rule implements the evaluate()
// method that returns ALLOW, DENY, or PENDING for a given TransactionIntent.
// The array order matters: rules are evaluated sequentially, and the engine
// stops at the first DENY. Put cheapest checks first for efficiency.
const rules = [
  new RateLimitRule(config.rateLimit!),          // Fast counter check -- runs first
  new SpendingLimitRule(config.spendingLimit!),  // Requires amount aggregation -- runs second
];

// PolicyEngine ties the rules together with a Store for stateful tracking.
// When wallet.execute() is called, the engine evaluates every rule in order.
// If all rules return ALLOW, the transaction proceeds. If any returns DENY,
// the transaction is rejected immediately with the denial reason.
const engine = new PolicyEngine(rules, store);
```

The builder produces a serializable `PolicyConfig` object. You extract the relevant fields and create individual `PolicyRule` instances, then pass them to the `PolicyEngine`. This separation keeps policy _definition_ separate from policy _execution_.

### Why two steps instead of one?

This separation is intentional. The builder creates a portable, serializable configuration (you could store it in a database, load it from a config file, or send it over an API). The rule instances are the actual runtime enforcers. This means you can define policies in one place (e.g., an admin dashboard) and instantiate them in another (e.g., your server). It's the same pattern as having a schema definition separate from your database migration runner.

## Common Questions

**Q: What is the difference between the policy engine and individual rules?**
The policy engine is the orchestrator -- it holds a list of rules and runs them in order. Each rule is a single check (like "is this under the spending limit?"). The engine combines their results: if any rule says DENY, the whole transaction is denied. Think of the engine as a test runner and each rule as an individual test case.

**Q: What happens if two transactions arrive at the same time?**
The execute pipeline uses a mutex (lock) to serialize all calls. Only one transaction is processed at a time. This prevents race conditions where, for example, two simultaneous 4 SOL transfers could both pass a 5 SOL daily limit. The second call waits until the first completes.

**Q: Do I need to understand Solana internals to use kova?**
No. The `SolanaAdapter` (chain adapter) handles all Solana-specific logic -- building transactions, managing RPC connections (the URLs used to communicate with the Solana network), converting human-readable amounts to lamports (Solana's smallest unit, like cents to dollars), and broadcasting. You interact only with the high-level `TransactionIntent` interface.

**Q: Can I use kova without an AI agent?**
Yes. While kova is designed for AI agents, the `AgentWallet` and `execute()` pipeline work perfectly for any programmatic use case where you want policy-enforced transactions. You could use it in a backend service, a cron job, or any automated system.

**Q: How do I add a new rule that kova doesn't ship with?**
Implement the `PolicyRule` interface with an `evaluate()` method that accepts a `TransactionIntent` and returns `ALLOW`, `DENY`, or `PENDING`. Then add your custom rule instance to the array you pass to `PolicyEngine`. See the [Policy Engine guide](/guide/policy-engine) for a full walkthrough.

## Next Steps

- [AgentWallet API](/guide/wallet) -- Full reference for the wallet
- [Intent Types](/guide/intents) -- All 5 intent types with interfaces
- [Policy Engine](/guide/policy-engine) -- How rule evaluation works
- [Security Model](/guide/security) -- Threat model and design decisions
