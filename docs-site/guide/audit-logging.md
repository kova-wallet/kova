# Audit Logging

kova records every policy decision and transaction result in a tamper-evident audit log. The log uses a SHA-256 hash chain so that any modification or deletion of entries can be detected after the fact.

## AuditLogger Constructor

The `AuditLogger` accepts either a bare `Store` (for backward compatibility) or an `AuditLoggerConfig` object with additional options:

```typescript
import { AuditLogger, MemoryStore } from "kova";

const store = new MemoryStore();

// Simple: pass a Store directly
const logger = new AuditLogger(store);

// Advanced: pass a config object
const loggerWithConfig = new AuditLogger({
  store,
  maxConsecutiveFailures: 5,
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
interface AuditLoggerConfig {
  /** The store for persisting audit entries */
  store: Store;
  /** Maximum consecutive failures before circuit opens. Default: 3 */
  maxConsecutiveFailures?: number;
  /** Callback invoked on each write failure */
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
interface AuditEntry {
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** The intent ID (UUID) */
  intentId: string;
  /** Agent that initiated the request (optional) */
  agentId?: string;
  /** Deep clone of the full transaction intent */
  intent: TransactionIntent;
  /** Per-rule policy evaluation results */
  policyDecisions: PolicyRuleAudit[];
  /** The final policy decision (ALLOW, DENY, or PENDING) */
  finalDecision: PolicyDecision;
  /** Transaction result if the intent was submitted to the chain */
  transactionResult?: {
    txId: string;
    status: "confirmed" | "failed";
    blockTime?: number;
  };
  /** SHA-256 hash of this entry (computed by the logger) */
  hash?: string;
  /** Hash of the previous audit entry */
  previousHash?: string;
}
```

The `policyDecisions` array contains one entry per rule that was evaluated:

```typescript
interface PolicyRuleAudit {
  /** Which policy rule was evaluated */
  rule: string;
  /** The result: ALLOW, DENY, or PENDING */
  result: "ALLOW" | "DENY" | "PENDING";
  /** Explanation for DENY decisions */
  reason?: string;
  /** Wall-clock time for this rule's evaluation */
  evaluationTimeMs: number;
}
```

A complete audit entry for a denied transfer looks like this:

```typescript
{
  timestamp: 1700000000000,
  intentId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  intent: {
    type: "transfer",
    chain: "solana",
    params: { to: "9aE4...", amount: "100", token: "SOL" },
    id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    createdAt: 1700000000000
  },
  policyDecisions: [
    { rule: "rate-limit", result: "ALLOW", evaluationTimeMs: 0.12 },
    { rule: "spending-limit", result: "DENY", reason: "Transfer exceeds per-transaction limit of 10 SOL", evaluationTimeMs: 0.08 }
  ],
  finalDecision: {
    decision: "DENY",
    rule: "spending-limit",
    reason: "Transfer exceeds per-transaction limit of 10 SOL"
  },
  transactionResult: undefined,
  hash: "a3f2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3",
  previousHash: "e4f3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4"
}
```

## Verifying Integrity

The `verifyIntegrity(count)` method walks the hash chain from oldest to newest and checks that:

1. Every entry has a `hash` field.
2. Every entry's `previousHash` matches the preceding entry's `hash`.
3. Every entry's `hash` matches the recomputed SHA-256 of its content plus the previous hash.

```typescript
import { AuditLogger, MemoryStore } from "kova";

const store = new MemoryStore();
const logger = new AuditLogger(store);

// After some transactions have been logged...
const report = await logger.verifyIntegrity(100);

console.log(report);
// {
//   valid: true,
//   entriesChecked: 47,
//   firstBrokenAt: -1
// }
```

The `IntegrityReport` interface:

```typescript
interface IntegrityReport {
  /** Whether the entire chain is valid */
  valid: boolean;
  /** Total entries checked */
  entriesChecked: number;
  /** Index of the first broken link (0-based from oldest), or -1 if valid */
  firstBrokenAt: number;
  /** Description of the integrity issue, if any */
  error?: string;
}
```

If tampering is detected, the report tells you exactly where the chain broke:

```typescript
const report = await logger.verifyIntegrity(100);
if (!report.valid) {
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
const logger = new AuditLogger({
  store,
  maxConsecutiveFailures: 5, // Open circuit after 5 consecutive failures
});

// Check if the circuit is open
if (logger.isCircuitOpen()) {
  console.error("Audit logging is down -- all transactions are blocked");
}

// Get the failure count
console.log(logger.getFailureCount()); // 0..maxConsecutiveFailures

// Manually reset after fixing the underlying issue
logger.resetFailureCount();
```

When the audit circuit breaker is open, the `AgentWallet` returns an error before even reaching the policy engine:

```typescript
{
  status: "failed",
  summary: "Transaction blocked: audit logging is unavailable",
  error: {
    code: "STORE_ERROR",
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
import { AuditLogger, MemoryStore } from "kova";

const store = new MemoryStore();

const logger = new AuditLogger({
  store,
  maxConsecutiveFailures: 3,
  onAuditFailure: (error, consecutiveFailures) => {
    // Send alert on first failure
    if (consecutiveFailures === 1) {
      alertOps(`Audit log write failed: ${error}`);
    }

    // Emergency alert when circuit is about to open
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
import {
  AgentWallet,
  PolicyEngine,
  SpendingLimitRule,
  AuditLogger,
  MemoryStore,
  LocalSigner,
  SolanaAdapter,
} from "kova";

const store = new MemoryStore();
const signer = new LocalSigner({ privateKey: process.env.WALLET_PRIVATE_KEY! });
const chain = new SolanaAdapter({ rpcUrl: process.env.SOLANA_RPC_URL! });

// Create a custom audit logger with failure monitoring
const logger = new AuditLogger({
  store,
  maxConsecutiveFailures: 3,
  onAuditFailure: (error, failures) => {
    console.error(`Audit failure #${failures}:`, error);
  },
});

const rules = [
  new SpendingLimitRule({
    perTransaction: { amount: "10", token: "SOL" },
    daily: { amount: "50", token: "SOL" },
  }),
];
const engine = new PolicyEngine(rules, store);

const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  logger, // Pass the custom logger
});

// Execute a transaction (audit entry is written automatically)
const result = await wallet.handleToolCall("wallet_transfer", {
  to: "9aE4Uy6gzM...",
  amount: "2",
  token: "SOL",
  chain: "solana",
  reason: "Test transfer",
});

console.log("Transaction result:", result);

// Verify the audit trail
const report = await logger.verifyIntegrity(100);
if (report.valid) {
  console.log(`Audit trail OK: ${report.entriesChecked} entries verified`);
} else {
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
