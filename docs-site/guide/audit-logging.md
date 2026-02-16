# Audit Logging

::: info What you'll learn
- How the SHA-256 hash chain creates a tamper-evident audit trail
- The `AuditEntry` structure and what gets recorded for every transaction
- How to verify audit log integrity with `verifyIntegrity()`
- The audit circuit breaker that blocks transactions when logging fails
- Security hardening: domain separators, timing-safe comparison, write serialization
:::

kova records every policy decision and transaction result in a tamper-evident audit log. The log uses a SHA-256 hash chain so that any modification or deletion of entries can be detected after the fact.

## AuditLogger Constructor

The `AuditLogger` accepts either a bare `Store` (for backward compatibility) or an `AuditLoggerConfig` object with additional options:

```typescript
// Import AuditLogger and a store implementation from kova.
import { AuditLogger, MemoryStore } from "kova";

// Create a store instance to persist audit entries.
const store = new MemoryStore();

// Simple usage: pass a Store directly. The logger will use default settings
// (maxConsecutiveFailures = 3, no failure callback).
const logger = new AuditLogger(store);

// Advanced usage: pass a config object for more control over failure handling.
const loggerWithConfig = new AuditLogger({
  store,
  // Open the audit circuit breaker after 5 consecutive write failures
  // (default is 3). Once open, ALL transactions are blocked to preserve
  // the integrity of the audit trail.
  maxConsecutiveFailures: 5,
  // Callback invoked each time an audit write fails. Use this to trigger
  // alerts to your ops team so they can fix the underlying store issue
  // before the circuit breaker opens and blocks all transactions.
  onAuditFailure: (error, consecutiveFailures) => {
    console.error(
      `Audit write failed (${consecutiveFailures} consecutive):`,
      error,
    );
  },
});
```

The `AuditLoggerConfig` interface:

```typescript
// Configuration options for the AuditLogger.
interface AuditLoggerConfig {
  /** The store for persisting audit entries */
  // The same Store interface used by PolicyEngine and AgentWallet.
  // Audit entries are appended to a list in this store using store.append().
  store: Store;
  /** Maximum consecutive failures before circuit opens. Default: 3 */
  // After this many consecutive write failures, the audit logger's internal
  // circuit breaker opens, causing all subsequent transactions to be blocked.
  maxConsecutiveFailures?: number;
  /** Callback invoked on each write failure */
  // Called every time store.append() fails. The second argument is the running
  // count of consecutive failures. Use this for alerting and monitoring.
  onAuditFailure?: (error: unknown, consecutiveFailures: number) => void;
}
```

## How Hash Chaining Works

Every audit entry is hashed using SHA-256 and linked to the previous entry's hash, forming an append-only chain. This makes it impossible to tamper with or delete entries without breaking the chain.

The process works as follows:

1. **Retrieve the previous hash.** The logger reads the most recent audit entry from the store and extracts its `hash` field.
2. **Serialize the entry.** The current entry (without `hash` and `previousHash` fields) is serialized to **canonical JSON** -- keys sorted alphabetically to ensure deterministic output regardless of property insertion order.
3. **Compute the hash.** SHA-256 is computed over `canonicalJson(entry) + previousHash`.
4. **Store the enriched entry.** The entry is augmented with `hash` and `previousHash` fields and appended to the store.

```
Entry 1: hash = SHA-256(canonicalJson(entry1) + "")
Entry 2: hash = SHA-256(canonicalJson(entry2) + entry1.hash)
Entry 3: hash = SHA-256(canonicalJson(entry3) + entry2.hash)
```

### Security Hardening

The hash chain implementation includes several security measures:

**Recursive canonical JSON.** Keys are sorted at all nesting levels, not just the top level. This ensures deterministic hashing for deeply nested objects like `intent.params` and `intent.metadata`.

**Domain separator.** A domain separator (`\x00kova:audit:v1\x00`) is included in every hash computation to prevent length-extension attacks and cross-context hash collisions:
```
hash = SHA-256(canonicalJson(entry) + "\x00kova:audit:v1\x00" + previousHash)
```

**Timing-safe comparison.** Hash verification in `verifyIntegrity()` uses `crypto.timingSafeEqual()` instead of string equality (`===`). This prevents timing side-channel attacks where an attacker could forge hashes by measuring comparison time.

**Write serialization.** The `log()` method uses an internal mutex to serialize concurrent writes. Without this, two concurrent `log()` calls could read the same `previousHash` and produce entries with identical chain links, corrupting the hash chain.

## AuditEntry Structure

Each entry in the audit log captures the full context of a transaction attempt:

```typescript
// An AuditEntry records everything about a single transaction attempt:
// what the agent wanted to do, what each policy rule decided, and
// whether the transaction was ultimately submitted and confirmed.
interface AuditEntry {
  /** Unix timestamp in milliseconds */
  // When this audit entry was created (wall-clock time).
  timestamp: number;
  /** The intent ID (UUID) */
  // Unique identifier for the transaction intent, matching the
  // TransactionIntent.id field. Used to correlate audit entries with intents.
  intentId: string;
  /** Agent that initiated the request (optional) */
  // Identifies which AI agent initiated this transaction.
  // Useful when multiple agents share the same wallet.
  agentId?: string;
  /** Deep clone of the full transaction intent */
  // A snapshot of the complete TransactionIntent at the time of evaluation.
  // Deep-cloned so that subsequent modifications to the intent object
  // do not alter the audit record.
  intent: TransactionIntent;
  /** Per-rule policy evaluation results */
  // An array with one entry per policy rule that was evaluated.
  // Shows exactly which rules allowed/denied the transaction and why.
  policyDecisions: PolicyRuleAudit[];
  /** The final policy decision (ALLOW, DENY, or PENDING) */
  // The aggregate result after all rules have been evaluated.
  // If any rule returns DENY, the final decision is DENY.
  finalDecision: PolicyDecision;
  /** Transaction result if the intent was submitted to the chain */
  // Only populated if the transaction was actually broadcast to the blockchain.
  // Undefined if the transaction was denied by policy and never submitted.
  transactionResult?: {
    txId: string;                         // The on-chain transaction ID
    status: "confirmed" | "failed";       // Whether the transaction succeeded on-chain
    blockTime?: number;                   // Unix timestamp of the block (if available)
  };
  /** SHA-256 hash of this entry (computed by the logger) */
  // The hash chain link for this entry. Computed over the canonical JSON
  // of the entry content plus the previous entry's hash.
  hash?: string;
  /** Hash of the previous audit entry */
  // Links this entry to the preceding one, forming the tamper-evident chain.
  // Empty string for the very first entry in the log.
  previousHash?: string;
}
```

The `policyDecisions` array contains one entry per rule that was evaluated:

```typescript
// Records the result of evaluating a single policy rule against a transaction intent.
interface PolicyRuleAudit {
  /** Which policy rule was evaluated */
  // The name/identifier of the rule (e.g., "spending-limit", "rate-limit").
  rule: string;
  /** The result: ALLOW, DENY, or PENDING */
  // ALLOW means the rule passed. DENY means the rule blocked the transaction.
  // PENDING means the rule requires external input (e.g., human approval).
  result: "ALLOW" | "DENY" | "PENDING";
  /** Explanation for DENY decisions */
  // Human-readable reason why the rule denied the transaction.
  // Only populated when result is "DENY" (e.g., "Exceeds daily spending limit").
  reason?: string;
  /** Wall-clock time for this rule's evaluation */
  // How long this rule took to evaluate, in milliseconds.
  // Useful for identifying slow rules that may be bottlenecking execution.
  evaluationTimeMs: number;
}
```

A complete audit entry for a denied transfer looks like this:

```typescript
// Example of a complete audit entry for a transaction that was denied
// by the spending-limit policy rule. This is what gets stored in the
// audit log after JSON serialization.
{
  // When the transaction was attempted
  timestamp: 1700000000000,
  // Unique ID for this transaction intent (UUID v4)
  intentId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  // The full intent that was evaluated -- a deep clone of the original
  intent: {
    type: "transfer",          // This was a transfer operation
    chain: "solana",           // On the Solana blockchain
    params: { to: "9aE4...", amount: "100", token: "SOL" }, // Transfer details
    id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",            // Matches intentId above
    createdAt: 1700000000000   // When the intent was created
  },
  // Results from each policy rule evaluated, in order
  policyDecisions: [
    // Rate-limit rule passed (this transaction was within the rate limit)
    { rule: "rate-limit", result: "ALLOW", evaluationTimeMs: 0.12 },
    // Spending-limit rule denied the transaction (100 SOL exceeds the 10 SOL per-transaction limit)
    { rule: "spending-limit", result: "DENY", reason: "Transfer exceeds per-transaction limit of 10 SOL", evaluationTimeMs: 0.08 }
  ],
  // The final aggregated decision -- DENY because spending-limit denied it
  finalDecision: {
    decision: "DENY",
    rule: "spending-limit",    // Which rule caused the denial
    reason: "Transfer exceeds per-transaction limit of 10 SOL"
  },
  // No transaction result because the transaction was denied and never submitted
  transactionResult: undefined,
  // SHA-256 hash of this entry, linking it to the chain
  hash: "a3f2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3",
  // Hash of the previous entry in the chain (links to the entry before this one)
  previousHash: "e4f3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4"
}
```

## Verifying Integrity

The `verifyIntegrity(count)` method walks the hash chain from oldest to newest and checks that:

1. Every entry has a `hash` field.
2. Every entry's `previousHash` matches the preceding entry's `hash`.
3. Every entry's `hash` matches the recomputed SHA-256 of its content plus the previous hash.

```typescript
// Import AuditLogger and a store for integrity verification.
import { AuditLogger, MemoryStore } from "kova";

// Create the store and logger (in a real app, these would be the same
// instances used by the AgentWallet during transaction execution).
const store = new MemoryStore();
const logger = new AuditLogger(store);

// After some transactions have been logged, verify the entire hash chain.
// The argument (100) is the maximum number of recent entries to check.
// Pass a large number to verify the entire log.
const report = await logger.verifyIntegrity(100);

// The report tells you whether the chain is intact.
console.log(report);
// {
//   valid: true,              -- All hashes match: no tampering detected
//   entriesChecked: 47,       -- 47 audit entries were verified
//   firstBrokenAt: -1         -- -1 means no broken links found
// }
```

The `IntegrityReport` interface:

```typescript
// The result of a hash chain integrity verification.
interface IntegrityReport {
  /** Whether the entire chain is valid */
  // true if all checked entries have correct hashes and chain links.
  valid: boolean;
  /** Total entries checked */
  // The number of audit entries that were actually verified.
  entriesChecked: number;
  /** Index of the first broken link (0-based from oldest), or -1 if valid */
  // If tampering is detected, this tells you exactly which entry is the
  // first one with a mismatched hash. -1 means no issues found.
  firstBrokenAt: number;
  /** Description of the integrity issue, if any */
  // A human-readable explanation of what went wrong (e.g., "hash mismatch",
  // "missing previousHash"). Only populated when valid is false.
  error?: string;
}
```

If tampering is detected, the report tells you exactly where the chain broke:

```typescript
// Check the integrity report and handle failures.
const report = await logger.verifyIntegrity(100);
if (!report.valid) {
  // Log the exact entry index and error description for investigation.
  // firstBrokenAt is 0-indexed from the oldest entry in the checked range.
  console.error(`Integrity broken at entry ${report.firstBrokenAt}: ${report.error}`);
  // "Entry 23 hash does not match recomputed hash (tampered or corrupted)"
}
```

::: danger
A broken hash chain means that one or more audit entries have been modified, deleted, or inserted after the fact. This is a serious security event. You should immediately investigate the store contents and consider freezing the wallet until the audit trail is restored.
:::

## Audit Circuit Breaker

If the audit log store becomes unavailable (e.g., database down, disk full), writing audit entries will fail. After `maxConsecutiveFailures` consecutive write failures (default: 3), the audit logger's internal circuit breaker opens and **all subsequent transactions are blocked**.

This is a deliberate safety mechanism: if the system cannot prove what happened, it refuses to do anything.

```typescript
// Create a logger with a custom failure threshold.
const logger = new AuditLogger({
  store,
  maxConsecutiveFailures: 5, // Open circuit after 5 consecutive failures
});

// Check if the audit circuit breaker is currently open (tripped).
// When open, the AgentWallet will refuse to execute any transactions.
if (logger.isCircuitOpen()) {
  console.error("Audit logging is down -- all transactions are blocked");
}

// Get the current count of consecutive write failures.
// This goes from 0 (healthy) up to maxConsecutiveFailures (circuit open).
console.log(logger.getFailureCount()); // 0..maxConsecutiveFailures

// After fixing the underlying store issue (e.g., restarting the database),
// manually reset the failure counter to close the circuit breaker.
// This resumes normal transaction processing.
logger.resetFailureCount();
```

When the audit circuit breaker is open, the `AgentWallet` returns an error before even reaching the policy engine:

```typescript
// This is the error response returned by AgentWallet.execute() when
// the audit circuit breaker is open. The transaction is never evaluated
// by the policy engine or submitted to the blockchain.
{
  status: "failed",
  summary: "Transaction blocked: audit logging is unavailable",
  error: {
    code: "STORE_ERROR",       // Error code indicating a store/persistence issue
    message: "Audit logging circuit breaker is open. Transactions are blocked until audit logging is restored."
  }
}
```

::: warning
The audit circuit breaker is separate from the [transaction circuit breaker](./circuit-breaker.md). The audit circuit breaker protects the integrity of the audit trail. The transaction circuit breaker protects against runaway agent behavior. Both can independently block transactions.
:::

## The `onAuditFailure` Callback

The `onAuditFailure` callback is invoked each time an audit write fails, giving you a hook for alerting:

```typescript
// Import AuditLogger and a store.
import { AuditLogger, MemoryStore } from "kova";

const store = new MemoryStore();

// Create a logger with a failure callback for operational alerting.
const logger = new AuditLogger({
  store,
  maxConsecutiveFailures: 3, // Circuit opens after 3 consecutive failures
  onAuditFailure: (error, consecutiveFailures) => {
    // Send an alert to your ops team on the very first failure.
    // Early alerting gives your team time to fix the issue before
    // the circuit breaker opens and blocks all transactions.
    if (consecutiveFailures === 1) {
      alertOps(`Audit log write failed: ${error}`);
    }

    // Send an emergency alert when the circuit is about to open.
    // At 2 consecutive failures with a threshold of 3, the next failure
    // will trip the circuit breaker and block all transactions.
    if (consecutiveFailures >= 2) {
      alertOps(
        `CRITICAL: ${consecutiveFailures} consecutive audit failures. ` +
        `Circuit will open at ${3}. Transactions will be blocked.`,
      );
    }
  },
});
```

## Full Example

Here is a complete example that creates a wallet with audit logging, runs a transaction, and verifies the audit trail:

```typescript
// Import all the components needed for a wallet with audit logging.
import {
  AgentWallet,       // The main wallet class that orchestrates everything
  PolicyEngine,      // Evaluates policy rules against transaction intents
  SpendingLimitRule,  // A policy rule that enforces spending caps
  AuditLogger,       // Records tamper-evident audit entries for every transaction
  MemoryStore,       // In-memory persistence (use SqliteStore in production)
  LocalSigner,       // In-memory key signer (use a remote signer in production)
  SolanaAdapter,     // Solana blockchain adapter for building/submitting transactions
} from "kova";

// Create a shared store for all SDK components.
const store = new MemoryStore({ dangerouslyAllowInProduction: true });

// Create a signer from a Keypair. In production, use MpcSigner.
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
const keypair = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY!));
const signer = new LocalSigner(keypair, { dangerouslyAllowInProduction: true });

// Create a Solana chain adapter connected to the configured RPC endpoint.
const chain = new SolanaAdapter({ rpcUrl: process.env.SOLANA_RPC_URL! });

// Create a custom audit logger with failure monitoring.
// The onAuditFailure callback alerts you when audit writes fail,
// giving you time to fix the store before the circuit breaker opens.
const logger = new AuditLogger({
  store,
  maxConsecutiveFailures: 3,  // Block all transactions after 3 consecutive failures
  onAuditFailure: (error, failures) => {
    console.error(`Audit failure #${failures}:`, error);
  },
});

// Define the policy rules that govern what the agent can do.
const rules = [
  new SpendingLimitRule({
    perTransaction: { amount: "10", token: "SOL" }, // Max 10 SOL per transaction
    daily: { amount: "50", token: "SOL" },          // Max 50 SOL per day total
  }),
];

// Create the policy engine with the rules and the shared store.
// The store persists spending counters so limits survive process restarts.
const engine = new PolicyEngine(rules, store);

// Assemble the AgentWallet with all components wired together.
const wallet = new AgentWallet({
  signer,       // Signs transactions with the wallet's private key
  chain,        // Builds and submits Solana transactions
  policy: engine, // Evaluates spending limits before allowing transactions
  store,        // Shared persistence backend
  logger,       // Pass the custom logger to record audit entries
});

// Execute a transaction via the AI tool call interface.
// The wallet will: evaluate policy -> write audit entry -> build tx -> sign -> broadcast.
const result = await wallet.handleToolCall("wallet_transfer", {
  to: "9aE4Uy6gzM...",   // Recipient's Solana address
  amount: "2",             // Send 2 SOL
  token: "SOL",           // Native SOL transfer
  chain: "solana",        // Solana blockchain
  reason: "Test transfer", // Human-readable reason (recorded in audit log)
});

console.log("Transaction result:", result);

// After the transaction, verify the integrity of the audit trail.
// This walks the SHA-256 hash chain and checks that no entries have been
// tampered with, deleted, or inserted.
const report = await logger.verifyIntegrity(100);
if (report.valid) {
  // All hashes match -- the audit trail is intact.
  console.log(`Audit trail OK: ${report.entriesChecked} entries verified`);
} else {
  // SECURITY ALERT: One or more audit entries have been modified.
  // Investigate immediately and consider freezing the wallet.
  console.error(`INTEGRITY FAILURE at entry ${report.firstBrokenAt}: ${report.error}`);
}
```

## What Happens When Audit Is Down

The following table summarizes the behavior when audit logging encounters problems:

| Scenario | Behavior |
|---|---|
| Single write failure | `log()` returns `false`; `onAuditFailure` called; transaction **still completes** |
| Consecutive failures below threshold | Same as above; counter increments each time |
| Consecutive failures reach threshold | `AuditCircuitOpenError` thrown; circuit opens |
| Circuit open, new transaction attempted | Transaction blocked with `STORE_ERROR` before policy evaluation |
| Store restored, `resetFailureCount()` called | Circuit closes; normal operation resumes |
| Successful write after partial failures | Counter resets to 0; circuit stays closed |

::: danger
When audit logging is down, **all transactions are blocked**. This is intentional -- a financial system without an audit trail is a liability. Design your store layer for high availability, and monitor the `onAuditFailure` callback to catch issues before the circuit opens.
:::
