# Core Concepts

::: info What you'll learn
- The layered architecture of kova and how components fit together
- Each key abstraction in order of importance: AgentWallet, Intents, Policy Engine, Stores, Signers, Chain Adapters, and more
- The full 10-step execute pipeline that every transaction goes through
- The two ways to define policies: fluent builder vs manual construction
:::

This page covers the architecture of `kova` and the key abstractions you will work with, **presented in order of importance**. Each concept builds on the one before it. Analogies to common software patterns are included so you don't need blockchain experience to follow along.

## Architecture Overview

`kova` follows a layered architecture where each component has a single responsibility:

```
+------------------------------------------------------+
|                    AI Agent                           |
|            (Claude / OpenAI / LangChain)              |
+--------------------+--------- -----------------------+
                     | tool call
                     v
+------------------------------------------------------+
|                 AgentWallet                            |
|         (orchestrates the full pipeline)              |
|------------------------------------------------------|
|  +----------+  +----------+  +-------------------+   |
|  |  Signer  |  |  Store   |  |  Chain Adapter    |   |
|  +----------+  +----------+  +-------------------+   |
|  +----------------------------------------------+    |
|  |            Policy Engine                      |    |
|  |  +---------+ +----------+ +---------------+   |    |
|  |  | Rules   | | Store    | | Approval Chan |   |    |
|  |  +---------+ +----------+ +---------------+   |    |
|  +----------------------------------------------+    |
|  +----------------------------------------------+    |
|  |          Audit Logger + Circuit Breaker       |    |
|  +----------------------------------------------+    |
+------------------------------------------------------+
```

::: tip How to read this diagram
Think of `AgentWallet` as the "controller" in an MVC application. It receives requests (tool calls from the AI agent), coordinates several services (signer, policy engine, chain adapter), and returns a result. No component talks directly to the AI agent except through the wallet.
:::

---

## 1. AgentWallet (Most Important)

The `AgentWallet` is the single entry point for everything in kova. It is the object your code creates, configures, and hands to your AI agent integration. Every other component plugs into the wallet.

**Real-world analogy:** AgentWallet is like an Express `app` object. It ties together your routes (tool handlers), middleware (policy engine), database (store), and external services (chain adapter) into one orchestrated unit.

```typescript
// AgentWallet is constructed by wiring together four required components
// and several optional ones. This is the only object your code creates directly.
import {
  AgentWallet,    // The orchestrator -- always required
  LocalSigner,    // Signs transactions (dev: in-memory key; prod: use MpcSigner)
  MemoryStore,    // Persists counters and logs (dev: in-memory; prod: use SqliteStore)
  SolanaAdapter,  // Handles Solana-specific operations (build tx, broadcast, balance)
  PolicyEngine,   // Evaluates policy rules against each transaction intent
} from "kova";

// Create the wallet by wiring together all components.
// Each component is a self-contained module with a clear interface.
const wallet = new AgentWallet({
  // signer: Who signs transactions. The signer holds the private key and
  // produces cryptographic signatures that authorize spending.
  signer: new LocalSigner(keypair),

  // chain: Where transactions go. The chain adapter builds unsigned transactions
  // from intents, broadcasts signed transactions, and queries balances.
  chain: new SolanaAdapter({
    rpcUrl: "https://api.devnet.solana.com",  // Free test network
  }),

  // policy: What's allowed. The policy engine evaluates every transaction
  // against your rules before it can be signed and broadcast.
  policy: engine,

  // store: Where state lives. Spending counters, rate limit windows,
  // audit log entries, and idempotency caches all live in the store.
  store,
});
```

### Key methods

| Method | What it does | When to use |
|--------|-------------|-------------|
| `execute(intent, metadata?)` | Runs the full 10-step pipeline: validate, policy check, sign, broadcast | Direct programmatic use |
| `handleToolCall(name, params)` | Dispatches an AI agent's tool call to the right wallet method | AI agent integration |
| `getBalance(token?)` | Returns the wallet's balance for a given token | Read-only queries |
| `getAddress()` | Returns the wallet's public address | Display or verification |
| `getPolicy()` | Returns a human-readable summary of active policy constraints | Agent introspection (opt-in) |
| `getTransactionHistory(limit?)` | Returns recent audit log entries | Monitoring and debugging |
| `destroy()` | Cleans up resources (closes DB connections, stops polling) | Graceful shutdown |

---

## 2. Transaction Intents

A **TransactionIntent** is a high-level, declarative description of what an agent wants to accomplish. Agents express _what_ they want (e.g., "transfer 1 SOL to address X"), not _how_ to do it (e.g., "build a Solana instruction with these accounts"). The SDK handles all chain-specific details.

**Real-world analogy:** A transaction intent is like filling out a bank transfer form. You write down the recipient, the amount, and the reason -- the bank handles the wire protocol, routing, and settlement. The AI agent fills out the "form" and kova does the rest.

### The 5 Intent Types

```typescript
// ── Transfer: Send tokens from the wallet to a recipient ────────────────────
// This is the most common intent type. The agent specifies who to pay,
// how much, and which token. The SDK builds the correct Solana instruction.
const transferIntent: TransactionIntent = {
  type: "transfer",        // Intent type identifier
  chain: "solana",         // Target blockchain
  params: {
    to: "9WzDXwBb...",    // Recipient's Solana address (base58-encoded public key)
    amount: "1.5",         // Human-readable amount (the SDK converts to lamports internally)
    token: "SOL",          // "SOL" for native currency, or a mint address for SPL tokens
  },
};

// ── Swap: Exchange one token for another via Jupiter DEX ────────────────────
// Jupiter is a DEX aggregator on Solana that finds the best swap route.
// The agent specifies what to sell, what to buy, and how much.
const swapIntent: TransactionIntent = {
  type: "swap",
  chain: "solana",
  params: {
    fromToken: "SOL",      // Token to sell
    toToken: "USDC",       // Token to buy
    amount: "2.0",         // Amount of fromToken to sell
    maxSlippage: 0.01,     // Max acceptable price difference (1%). Defaults to 0.5%
  },
};

// ── Mint: Create a new NFT ──────────────────────────────────────────────────
// Mints an NFT into a collection. The metadata URI points to a JSON file
// (usually on Arweave or IPFS) containing the NFT's name, image, and attributes.
const mintIntent: TransactionIntent = {
  type: "mint",
  chain: "solana",
  params: {
    collection: "CollectionAddress...",  // The NFT collection's program address
    metadataUri: "https://arweave.net/...",  // URI pointing to the NFT metadata JSON
    to: "RecipientAddress...",  // Optional: defaults to the wallet's own address
  },
};

// ── Stake: Delegate tokens to a validator ───────────────────────────────────
// Staking locks tokens to help secure the network in exchange for rewards.
// The agent specifies how much to stake and optionally which validator.
const stakeIntent: TransactionIntent = {
  type: "stake",
  chain: "solana",
  params: {
    amount: "10",          // Amount to stake
    token: "SOL",          // Token to stake
    validator: "Validator...",  // Optional: specific validator address
  },
};

// ── Custom: Execute arbitrary Solana instructions ───────────────────────────
// WARNING: This is a dangerous escape hatch. Custom intents bypass semantic
// policy checks (the policy engine can't understand arbitrary instructions).
// Always pair with ApprovalGateRule for human review.
const customIntent: TransactionIntent = {
  type: "custom",
  chain: "solana",
  params: {
    programId: "ProgramAddress...",  // The Solana program to interact with
    data: "base64EncodedData...",    // Instruction data (base64-encoded)
    accounts: [                      // Accounts the instruction reads/writes
      { address: "...", isSigner: true, isWritable: true },
      { address: "...", isSigner: false, isWritable: false },
    ],
  },
};
```

::: info What are SPL tokens?
SPL tokens (Solana Program Library tokens) are custom tokens built on Solana, similar to ERC-20 tokens on Ethereum. Examples include USDC, USDT, and other digital assets. When transferring SPL tokens, you use the token's mint address instead of `"SOL"` in the `token` field.
:::

---

## 3. Policy Engine

The core enforcement layer. The `PolicyEngine` holds an ordered list of `PolicyRule` instances and evaluates them sequentially against each transaction intent. Evaluation stops at the first `DENY`. If all rules pass, the intent is `ALLOW`ed.

The engine follows a **deny-by-default, fail-closed** design: if any rule throws an exception, the result is `DENY` with an audit trail.

**Real-world analogy:** The policy engine is like middleware in Express.js or a chain of security guards. Each guard (rule) checks one thing -- your ID, your ticket, your bag. If any guard says "no," you're turned away immediately. You only get through if every single guard approves. And if a guard can't make a decision (throws an error), the default answer is "no."

### Why deny-by-default matters

The deny-by-default design means your wallet is safe even when things go wrong. A bug in a custom rule, a network timeout, or an unexpected edge case will result in a denied transaction -- not an approved one. Your money is protected by default.

### Two-Phase Evaluation

The engine uses a sophisticated two-phase evaluation to prevent counter inflation:

1. **Dry-run phase**: Evaluates all rules using a snapshot of the store. No real counters are modified.
2. **Commit phase**: If the dry-run passes, the same evaluation runs against the real store to atomically update counters.

This prevents a subtle bug where multiple rules could each increment their counters during evaluation, then one rule denies -- leaving inflated counters even though the transaction was rejected.

### Built-in Policy Rules

| Rule | Purpose | Analogy |
|------|---------|---------|
| `SpendingLimitRule` | Per-transaction, daily, weekly, and monthly spending caps | A credit card's daily spending limit |
| `RateLimitRule` | Max transactions per minute and per hour | API rate limiting (e.g., 100 requests/minute) |
| `AllowlistRule` | Restrict target addresses and program IDs | A corporate card restricted to approved vendors |
| `TimeWindowRule` | Restrict when the agent can transact (active hours) | A store that's only open 9am-5pm |
| `ApprovalGateRule` | Require human approval above a configurable threshold | Manager approval for purchases over $1,000 |

::: tip Recommended rule order
Place rules from cheapest to most expensive evaluation cost: `RateLimitRule` (counter check) -> `TimeWindowRule` (clock check) -> `AllowlistRule` (address lookup) -> `SpendingLimitRule` (amount aggregation) -> `ApprovalGateRule` (network call to human). This ensures denied transactions fail as fast as possible.
:::

### Policy Builder vs Manual Construction

There are two ways to create a policy:

**Fluent builder** (recommended for configuration):

```typescript
// The fluent builder provides a declarative, chainable API for defining policies.
// Each method call adds a constraint. Call .build() at the end to produce an
// immutable Policy object that can be serialized to JSON or used to create rules.
const policy = Policy.create("my-policy")              // Initialize with a unique name
  .spendingLimit({ daily: { amount: "10", token: "SOL" } })  // Cap daily spending
  .rateLimit({ maxTransactionsPerHour: 20 })                  // Cap hourly rate
  .allowAddresses(["addr1", "addr2"])                          // Restrict recipients
  .build();                                                    // Finalize
```

**Manual rule construction** (required for the `PolicyEngine`):

```typescript
// Convert the Policy to a config object, then instantiate each rule.
// The "!" (non-null assertion) tells TypeScript these fields exist
// because we set them in the builder above.
const config = policy.toJSON();

// Create rules in evaluation order: cheapest first for performance.
const rules = [
  new RateLimitRule(config.rateLimit!),          // Fast counter check
  new SpendingLimitRule(config.spendingLimit!),  // Requires amount aggregation
];

// PolicyEngine ties the rules together with a Store for stateful tracking.
const engine = new PolicyEngine(rules, store);
```

### Why two steps instead of one?

This separation is intentional. The builder creates a portable, serializable configuration (you could store it in a database, load it from a config file, or send it over an API). The rule instances are the actual runtime enforcers. This means you can define policies in one place (e.g., an admin dashboard) and instantiate them in another (e.g., your server).

---

## 4. Stores

A minimal persistence interface used for spending counters, rate limit counters, idempotency keys (to prevent the same transaction from being processed twice), and audit logs.

**Real-world analogy:** A store is like a database adapter. The SDK needs to remember "how much has this agent spent today?" and "has this transaction been processed before?" The store provides that persistence.

### Store Interface

```typescript
// The Store interface defines 6 operations that the SDK needs for all
// stateful tracking. Any class implementing this interface can be used.
interface Store {
  get(key: string): Promise<string | null>;              // Read a value by key
  set(key: string, value: string, ttl?: number): Promise<void>;  // Write a value with optional TTL
  setIfNotExists(key: string, value: string, ttl?: number): Promise<boolean>;  // Atomic conditional write
  increment(key: string, amount: number): Promise<number>;  // Atomic counter increment
  append(key: string, value: string): Promise<void>;        // Append to a list (for sliding windows)
  getRecent(key: string, count: number): Promise<string[]>; // Read recent list entries
}
```

### Which store to use

| Store | Use case | Trade-off |
|-------|----------|-----------|
| `MemoryStore` | Development, testing, CI | Fast but all state lost on restart |
| `SqliteStore` | Production | Persistent, encrypted, survives restarts |
| Custom | Redis, PostgreSQL, etc. | Implement the `Store` interface |

::: warning Always use SqliteStore in production
With `MemoryStore`, spending limits reset on every process restart. An agent could spend its daily limit, you restart the server, and the counter goes back to zero -- allowing the agent to spend the full limit again. `SqliteStore` persists to a file so counters survive restarts.
:::

---

## 5. Signers

Responsible for holding keys and signing transactions (cryptographically approving a transaction so the blockchain knows it came from the wallet owner).

```typescript
// The Signer interface defines how the wallet signs transactions.
// All signers implement these methods regardless of how they store keys.
interface Signer {
  getAddress(): Promise<string>;                  // The wallet's public address
  sign(transaction: UnsignedTransaction): Promise<SignedTransaction>;  // Sign a transaction
}
```

| Signer | Security | Use case |
|--------|----------|----------|
| `LocalSigner` | Key in process memory (insecure) | Development and testing only |
| `MpcSigner` | Key split across multiple parties (hardware-backed) | Production |

::: warning Never use LocalSigner in production
`LocalSigner` holds the private key in plain text in your process memory. A core dump, debugger attachment, or V8 heap snapshot could expose it. For any real funds, use `MpcSigner` with a provider like Turnkey, Fireblocks, or Lit Protocol.
:::

---

## 6. Chain Adapters

Encapsulates all blockchain-specific logic: building transactions, broadcasting, checking balances, and validating addresses.

**Real-world analogy:** A chain adapter is like a database driver. You write your application logic once (using the `ChainAdapter` interface), and the specific adapter handles the dialect-specific details -- just like how an ORM lets you swap between PostgreSQL and MySQL without changing your app code.

```typescript
// The ChainAdapter interface defines chain-specific operations.
// Currently only SolanaAdapter is implemented, but the interface
// is designed to support any blockchain.
interface ChainAdapter {
  getBalance(address: string, token?: string): Promise<string>;        // Token balance
  getValueInUSD(amount: string, token: string): Promise<number>;       // Price oracle
  buildTransaction(intent: TransactionIntent): Promise<UnsignedTransaction>;  // Intent -> tx
  simulateTransaction(tx: UnsignedTransaction): Promise<SimulationResult>;    // Pre-flight check
  broadcast(signedTx: SignedTransaction): Promise<string>;             // Submit to network
  getTransactionStatus(txId: string): Promise<TransactionStatusResult>;  // Confirmation polling
}
```

---

## 7. Approval Channel

An abstraction over human approval delivery mechanisms. When the `ApprovalGateRule` triggers (transaction above a threshold), it sends a request through the `ApprovalChannel` and blocks until a human responds.

**Real-world analogy:** Think of this like a pull request review. The agent wants to make a large transaction, but instead of proceeding automatically, it sends a notification to a human reviewer via Telegram. The transaction is "paused" until the reviewer approves or rejects it.

The SDK ships with `TelegramApprovalBot`, which sends inline-button messages to a Telegram chat.

---

## 8. Audit Logger

Records every policy decision and transaction in a **SHA-256 hash chain** -- each entry includes a cryptographic hash of the previous entry, making it impossible to alter past records without detection. The `AuditLogger` includes an internal circuit breaker: after too many consecutive write failures, it blocks all transactions until logging is restored.

### Why the audit logger blocks transactions on failure

This is a deliberate safety design. If the audit system fails, transactions could happen without being recorded -- creating a gap in your compliance trail. By blocking all transactions when logging breaks, kova ensures you never lose visibility into what your agent is doing.

---

## 9. Circuit Breaker

Tracks consecutive policy denials and enters a cooldown period after a configurable threshold. This prevents a runaway agent from hammering the wallet with requests that will be denied.

**Real-world analogy:** This works like a physical circuit breaker in your house. If too much current flows (too many denied transactions), the breaker trips and cuts power (blocks all requests) until conditions stabilize.

Key features:
- **Per-intent-type isolation**: 5 denied swaps won't block transfers
- **Per-agent isolation**: One misbehaving agent won't lock out other agents
- **Configurable thresholds**: Default is 5 consecutive denials, 5-minute cooldown

---

## The Execute Pipeline

When you call `wallet.execute(intent)`, the following 10-step pipeline runs:

```
Intent
  |
  v
+---------------------+
|  1. Validate         |  Verify intent structure, types, required fields
+----------+----------+
           v
+---------------------+
|  2. Normalize        |  Assign ID (UUID), timestamp if not provided
+----------+----------+
           v
+---------------------+
|  3. Idempotency      |  Check if this intent ID was already processed (24h TTL)
|     Check            |  If cached -> return cached result immediately
+----------+----------+
           v
+---------------------+
|  4. Audit Circuit    |  Is the audit logger healthy?
|     Check            |  If broken -> FAIL (refuse all transactions)
+----------+----------+
           v
+---------------------+
|  5. Transaction      |  Has the agent hit too many consecutive denials?
|     Circuit Breaker  |  If open -> DENY with cooldown message
+----------+----------+
           v
+---------------------+
|  6. Policy           |  Evaluate all rules sequentially (two-phase)
|     Evaluation       |  DENY -> return immediately with reason
|                      |  PENDING -> return (awaiting human approval)
|                      |  ALLOW -> continue
+----------+----------+
           v
+---------------------+
|  7. Build Tx         |  Chain adapter builds unsigned transaction from intent
+----------+----------+
           v
+---------------------+
|  8. Sign             |  Signer signs the transaction with the private key
+----------+----------+
           v
+---------------------+
|  9. Broadcast        |  Chain adapter sends to network, waits for confirmation
+----------+----------+
           v
+---------------------+
| 10. Audit Log        |  Record full audit entry with hash chain integrity
|     + Return Result  |  Cache result for idempotency, return TransactionResult
+---------------------+
```

::: tip
The entire pipeline is serialized via a mutex (a lock that ensures only one operation runs at a time). Only one `execute()` call runs at a time, preventing time-of-check-time-of-use (TOCTOU) race conditions where concurrent calls could bypass spending limits.
:::

::: info Why so many steps?
Each step addresses a specific security or reliability concern. Steps 1-2 ensure data integrity. Step 3 prevents duplicate processing. Steps 4-5 are circuit breakers that protect against system failures and runaway agents. Step 6 enforces your custom rules. Steps 7-9 handle the actual blockchain interaction. Step 10 creates the audit trail. You don't need to manage these steps yourself -- they all run automatically when you call `execute()`.
:::

## Common Questions

**Q: What is the difference between the policy engine and individual rules?**
The policy engine is the orchestrator -- it holds a list of rules and runs them in order. Each rule is a single check (like "is this under the spending limit?"). The engine combines their results: if any rule says DENY, the whole transaction is denied. Think of the engine as a test runner and each rule as an individual test case.

**Q: What happens if two transactions arrive at the same time?**
The execute pipeline uses a mutex (lock) to serialize all calls. Only one transaction is processed at a time. This prevents race conditions where, for example, two simultaneous 4 SOL transfers could both pass a 5 SOL daily limit. The second call waits until the first completes.

**Q: Do I need to understand Solana internals to use kova?**
No. The `SolanaAdapter` handles all Solana-specific logic -- building transactions, managing RPC connections, converting human-readable amounts to lamports (Solana's smallest unit, like cents to dollars), and broadcasting. You interact only with the high-level `TransactionIntent` interface.

**Q: Can I use kova without an AI agent?**
Yes. While kova is designed for AI agents, `AgentWallet` and `execute()` work perfectly for any programmatic use case where you want policy-enforced transactions -- backend services, cron jobs, or any automated system.

**Q: How do I add a custom policy rule?**
Implement the `PolicyRule` interface with an `evaluate()` method that accepts a `TransactionIntent` and returns `ALLOW`, `DENY`, or `PENDING`. Then add your custom rule to the array you pass to `PolicyEngine`. See the [Custom Policy Rule tutorial](/tutorials/custom-policy-rule).

## Next Steps

- [AgentWallet API](/guide/wallet) -- Full reference for the wallet
- [Intent Types](/guide/intents) -- All 5 intent types with complete interfaces
- [Policy Engine](/guide/policy-engine) -- How rule evaluation works in depth
- [Security Model](/guide/security) -- Threat model and design decisions
