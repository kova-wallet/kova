# Sprint 6 — Audit Logging + Security Hardening Documentation

**Project:** kova
**Sprint:** 6 — Audit Logging + Security Hardening
**Date:** 2026-02-12

---

## Overview

Sprint 6 enhances the wallet's audit logging system and adds security hardening mechanisms. This sprint resolves three deferred findings from the Sprint 1 security review:

- **S1-01**: Audit write failures were silently ignored, meaning a broken store could allow transactions to proceed without any audit trail.
- **S1-11**: Audit entries had no integrity guarantees. A compromised store could tamper with or reorder entries without detection.
- **S1-12**: Policy evaluation only returned the final decision. Per-rule audit data (which rules ran, what each decided, how long each took) was not captured.

Additionally, a new **Circuit Breaker** prevents runaway agent behavior by tracking consecutive policy denials and entering a cooldown period.

---

## Architecture

### Execute Pipeline (Updated)

```
AgentWallet.execute(intent)
      |
      |- 1. validateIntent()           -- type/structure checks
      |- 2. normalizeIntent()           -- assign ID, timestamp
      |- 3. idempotency check           -- return cached result if duplicate
      |- 4. audit circuit check         -- logger.isCircuitOpen()
      |       (blocks if audit is broken)
      |- 5. circuit breaker check       -- circuitBreaker.check()
      |       (blocks if too many consecutive denials)
      |- 6. policy evaluation           -- returns PolicyEvaluationResult
      |       |- per-rule audits        -- rule name, result, reason, timing
      |       |- fail-closed            -- throwing rule => DENY
      |- 7. record outcome              -- circuitBreaker.recordOutcome()
      |- 8. build -> sign -> broadcast  -- chain adapter + signer
      |- 9. logAudit()                  -- hash-chained entry with per-rule data
      |- 10. return TransactionResult
```

### Hash Chain Integrity

```
Entry 0                Entry 1                Entry 2
+--------------+       +--------------+       +--------------+
| intent       |       | intent       |       | intent       |
| policyDecisions      | policyDecisions      | policyDecisions
| finalDecision|       | finalDecision|       | finalDecision|
| hash: abc123 | <--+  | hash: def456 | <--+  | hash: ghi789 |
| previousHash:|    |  | previousHash:|    |  | previousHash:|
|   (none)     |    +--| abc123       |    +--| def456       |
+--------------+       +--------------+       +--------------+

hash = SHA-256( canonicalJson(entry) + previousHash )
```

---

## Feature 1: Per-Rule Audit Data (S1-12 Fix)

`PolicyEngine.evaluate()` now returns a `PolicyEvaluationResult` instead of a bare `PolicyDecision`. This provides a complete audit trail of every rule that was evaluated, including timing data.

### PolicyEvaluationResult

```typescript
interface PolicyEvaluationResult {
  /** The final policy decision */
  decision: PolicyDecision;
  /** Per-rule audit trail (one entry per rule evaluated) */
  ruleAudits: PolicyRuleAudit[];
  /** Total wall-clock time for all rule evaluations */
  totalEvaluationTimeMs: number;
}

interface PolicyRuleAudit {
  /** Which policy rule was evaluated */
  rule: string;
  /** The result of the evaluation */
  result: "ALLOW" | "DENY" | "PENDING";
  /** Human-readable explanation (present on DENY) */
  reason?: string;
  /** Time taken to evaluate this rule */
  evaluationTimeMs: number;
}
```

### How It Works

The engine iterates through rules in order, wrapping each evaluation in a timer:

```typescript
// From src/policy/engine.ts
async evaluate(intent: TransactionIntent, now?: number): Promise<PolicyEvaluationResult> {
  const context: PolicyContext = {
    store: this.store,
    approval: this.approval,
    now: now ?? Date.now(),
  };

  const ruleAudits: PolicyRuleAudit[] = [];
  const totalStart = performance.now();

  for (const rule of this.rules) {
    const ruleStart = performance.now();
    let decision: PolicyDecision;

    try {
      decision = await rule.evaluate(intent, context);
    } catch (err) {
      // Fail-closed: rule evaluation error -> DENY with audit trail
      const ruleMs = performance.now() - ruleStart;
      const errorMsg = err instanceof Error ? err.message : String(err);
      ruleAudits.push({
        rule: rule.name,
        result: "DENY",
        reason: `Rule evaluation error: ${errorMsg}`,
        evaluationTimeMs: ruleMs,
      });

      const totalMs = performance.now() - totalStart;
      return {
        decision: {
          decision: "DENY",
          rule: rule.name,
          reason: `Rule evaluation error: ${errorMsg}`,
        },
        ruleAudits,
        totalEvaluationTimeMs: totalMs,
      };
    }

    const ruleMs = performance.now() - ruleStart;
    ruleAudits.push({
      rule: rule.name,
      result: decision.decision,
      reason: decision.decision === "DENY" ? decision.reason : undefined,
      evaluationTimeMs: ruleMs,
    });

    if (decision.decision !== "ALLOW") {
      const totalMs = performance.now() - totalStart;
      return { decision, ruleAudits, totalEvaluationTimeMs: totalMs };
    }
  }

  const totalMs = performance.now() - totalStart;
  return {
    decision: { decision: "ALLOW" },
    ruleAudits,
    totalEvaluationTimeMs: totalMs,
  };
}
```

### Audit Entry Structure

The per-rule audit data is recorded into every audit log entry via the `policyDecisions` field:

```typescript
interface AuditEntry {
  timestamp: number;
  intentId: string;
  agentId?: string;
  intent: TransactionIntent;
  policyDecisions: PolicyRuleAudit[];
  finalDecision: PolicyDecision;
  transactionResult?: { txId: string; status: "confirmed" | "failed" };
  hash?: string;
  previousHash?: string;
}
```

---

## Feature 2: Fail-Closed Policy Evaluation

Each `rule.evaluate()` call in the engine is wrapped in a try/catch block. If a rule throws an exception, it produces a DENY decision with full audit trail rather than propagating as an uncaught exception.

This guarantees that no rule error can ever result in an unauthorized transaction proceeding. The error message is captured in the audit trail for debugging.

```typescript
try {
  decision = await rule.evaluate(intent, context);
} catch (err) {
  // Fail-closed: a throwing rule means DENY, not an uncaught crash
  const errorMsg = err instanceof Error ? err.message : String(err);
  ruleAudits.push({
    rule: rule.name,
    result: "DENY",
    reason: `Rule evaluation error: ${errorMsg}`,
    evaluationTimeMs: ruleMs,
  });
  return {
    decision: { decision: "DENY", rule: rule.name, reason: `Rule evaluation error: ${errorMsg}` },
    ruleAudits,
    totalEvaluationTimeMs: totalMs,
  };
}
```

---

## Feature 3: SHA-256 Hash Chain Integrity (S1-11 Fix)

Each audit entry is hashed using SHA-256 over the canonical JSON representation of the entry concatenated with the previous entry's hash. This creates a tamper-evident chain.

### Hashing Algorithm

```typescript
// Canonical JSON serialization with sorted keys (deterministic)
function canonicalJson(obj: unknown): string {
  return JSON.stringify(obj, Object.keys(obj as Record<string, unknown>).sort());
}

// Hash computation
const entryJson = canonicalJson(entry);
const hash = createHash("sha256")
  .update(entryJson + previousHash)
  .digest("hex");

const enrichedEntry: AuditEntry = {
  ...entry,
  hash,
  previousHash: previousHash || undefined,
};
```

### Integrity Verification

`AuditLogger.verifyIntegrity()` walks the chain from oldest to newest and detects:

- **Tampered entries** -- hash mismatch when recomputed from entry content
- **Reordered entries** -- previousHash link does not match the preceding entry's hash
- **Corrupted JSON entries** -- entries that fail to parse
- **Missing hash fields** -- entries without a hash value

```typescript
const report = await logger.verifyIntegrity(100);
// report: IntegrityReport
// {
//   valid: true,          -- entire chain is intact
//   entriesChecked: 47,   -- number of entries verified
//   firstBrokenAt: -1,    -- no broken link (-1 means valid)
// }
```

If tampering is detected:

```typescript
// {
//   valid: false,
//   entriesChecked: 12,
//   firstBrokenAt: 12,
//   error: "Entry 12 hash does not match recomputed hash (tampered or corrupted)"
// }
```

### IntegrityReport

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

---

## Feature 4: Audit Failure Detection (S1-01 Fix)

`AuditLogger.log()` now returns `Promise<boolean>` -- `true` on success, `false` on failure. After `maxConsecutiveFailures` (default: 3) consecutive write failures, it throws `AuditCircuitOpenError`.

The wallet checks `logger.isCircuitOpen()` before executing any transaction. When the audit circuit is open, all transactions are refused until audit logging is restored.

### AuditLogger Configuration

```typescript
interface AuditLoggerConfig {
  /** The store for persisting audit entries */
  store: Store;
  /** Maximum consecutive failures before circuit opens. Default: 3 */
  maxConsecutiveFailures?: number;
  /** Callback invoked on each write failure */
  onAuditFailure?: AuditFailureCallback;
}

type AuditFailureCallback = (error: unknown, consecutiveFailures: number) => void;
```

### Backward Compatibility

The constructor accepts either a bare `Store` (legacy) or an `AuditLoggerConfig` object:

```typescript
// Legacy usage (still works)
const logger = new AuditLogger(store);

// New config-based usage
const logger = new AuditLogger({
  store,
  maxConsecutiveFailures: 5,
  onAuditFailure: (error, count) => {
    console.error(`Audit write failed (${count} consecutive): ${error}`);
  },
});
```

### Failure Flow

1. `log()` attempts to write. On failure, increments `consecutiveFailures` and invokes the `onAuditFailure` callback, then returns `false`.
2. On success, `consecutiveFailures` is reset to 0 and returns `true`.
3. If `consecutiveFailures >= maxConsecutiveFailures`, `log()` throws `AuditCircuitOpenError` instead of attempting a write.
4. The wallet checks `logger.isCircuitOpen()` before `execute()`:

```typescript
// From src/core/wallet.ts
if (this.logger.isCircuitOpen()) {
  return {
    status: "failed",
    summary: "Transaction blocked: audit logging is unavailable",
    intentId,
    timestamp: Date.now(),
    error: {
      code: "STORE_ERROR",
      message: "Audit logging circuit breaker is open. Transactions are blocked until audit logging is restored.",
    },
  };
}
```

### Manual Recovery

After fixing the underlying store issue, the failure counter can be reset:

```typescript
logger.resetFailureCount();
// logger.isCircuitOpen() now returns false
// Transactions can resume
```

---

## Feature 5: Circuit Breaker

The `CircuitBreaker` class tracks consecutive policy denials and enters a configurable cooldown period after hitting a threshold. This prevents a runaway agent from flooding the system with denied requests.

The circuit breaker operates at the wallet level, before policy evaluation, so it cannot be bypassed by reconfiguring policy rules.

### CircuitBreakerConfig

```typescript
interface CircuitBreakerConfig {
  /** Number of consecutive denials before circuit opens. Must be >= 1. Default: 5 */
  threshold: number;
  /** Cooldown period in milliseconds. Must be >= 0. Default: 300_000 (5 min) */
  cooldownMs: number;
}
```

### How It Works

```typescript
// From src/core/circuit-breaker.ts
const breaker = new CircuitBreaker(store, { threshold: 5, cooldownMs: 300_000 });

// Before executing: check if blocked
const reason = await breaker.check();
if (reason) {
  // reason: "Circuit breaker open: 180s cooldown remaining after 5 consecutive denials"
  // Block the transaction
}

// After policy evaluation: record outcome
await breaker.recordOutcome("DENY");   // increments counter, may trigger cooldown
await breaker.recordOutcome("ALLOW");  // resets counter to 0
await breaker.recordOutcome("PENDING"); // no-op (pending is not a denial)
```

### State Management

The circuit breaker persists its state in the store using two keys:

| Store Key | Purpose |
|-----------|---------|
| `circuit:denial_count` | Consecutive denial counter |
| `circuit:cooldown_until` | Cooldown expiry timestamp (epoch ms) |

An ALLOW decision resets the counter to 0. A DENY increments it. When the counter reaches the threshold, a cooldown timestamp is written. During cooldown, `check()` returns a human-readable denial reason. After cooldown expires, `check()` automatically resets the circuit.

### Manual Reset

```typescript
await breaker.reset(); // Clears counter and cooldown immediately
```

---

## Feature 6: Wallet Integration

The wallet's `execute()` pipeline now incorporates all Sprint 6 features. The full pipeline is:

1. **Validate intent** -- type and structure checks
2. **Normalize intent** -- assign ID and timestamp
3. **Idempotency check** -- return cached result for duplicate intent IDs
4. **Audit circuit check** -- `logger.isCircuitOpen()` blocks if audit is broken
5. **Circuit breaker check** -- `circuitBreaker.check()` blocks during cooldown
6. **Policy evaluation** -- returns `PolicyEvaluationResult` with per-rule audits
7. **Record outcome** -- `circuitBreaker.recordOutcome()` tracks denials
8. **Build, sign, broadcast** -- chain adapter and signer
9. **Log audit** -- hash-chained entry with real per-rule data
10. **Return result**

### Execute Pipeline Code

```typescript
// From src/core/wallet.ts (simplified)

// Step 4: Audit circuit check
if (this.logger.isCircuitOpen()) {
  return { status: "failed", error: { code: "STORE_ERROR", message: "..." } };
}

// Step 5: Circuit breaker check
if (this.circuitBreaker) {
  const cbReason = await this.circuitBreaker.check();
  if (cbReason) {
    return { status: "denied", error: { code: "CIRCUIT_BREAKER_OPEN", message: cbReason } };
  }
}

// Step 6: Policy evaluation with per-rule audits
const evaluationResult = await this.policy.evaluate(normalizedIntent);
const policyDecision = evaluationResult.decision;
const ruleAudits = evaluationResult.ruleAudits;

// Step 7: Record outcome for circuit breaker
if (this.circuitBreaker) {
  await this.circuitBreaker.recordOutcome(policyDecision.decision);
}

// ... build, sign, broadcast ...

// Step 9: Log audit with real per-rule data
await this.logAudit(normalizedIntent, ruleAudits, policyDecision, { txId, status: "confirmed" });
```

### logAudit Implementation

```typescript
// From src/core/wallet.ts
private async logAudit(
  intent: TransactionIntent,
  ruleAudits: PolicyRuleAudit[],
  finalDecision: AuditEntry["finalDecision"],
  txResult?: { txId: string; status: "confirmed" | "failed" },
): Promise<void> {
  const entry: AuditEntry = {
    timestamp: Date.now(),
    intentId: intent.id!,
    agentId: intent.metadata?.agentId,
    intent: structuredClone(intent),
    policyDecisions: structuredClone(ruleAudits),
    finalDecision: structuredClone(finalDecision),
    transactionResult: txResult ? structuredClone(txResult) : undefined,
  };

  try {
    await this.logger.log(entry);
  } catch (err) {
    if (err instanceof AuditCircuitOpenError) {
      // Audit is now broken -- future transactions will be blocked
      // But don't break the current transaction flow
    }
    // Other logging failures are swallowed (backward compatible)
  }
}
```

---

## Configuration

### Full Wallet Configuration

```typescript
import { AgentWallet } from "kova";

const wallet = new AgentWallet({
  signer,    // Signer instance
  chain,     // ChainAdapter instance
  policy,    // PolicyEngine instance
  store,     // Store instance

  // Circuit breaker options (or false to disable)
  circuitBreaker: { threshold: 5, cooldownMs: 300_000 },

  // Callback for audit failures
  onAuditFailure: (error, count) => {
    console.error(`Audit write failed (${count} consecutive): ${error}`);
  },
});
```

### Disabling the Circuit Breaker

```typescript
const wallet = new AgentWallet({
  signer,
  chain,
  policy,
  store,
  circuitBreaker: false, // No circuit breaker
});
```

### Custom Audit Logger

```typescript
import { AuditLogger } from "kova";

const logger = new AuditLogger({
  store,
  maxConsecutiveFailures: 5,
  onAuditFailure: (error, count) => {
    alertOpsTeam(`Audit failure #${count}: ${error}`);
  },
});

const wallet = new AgentWallet({
  signer,
  chain,
  policy,
  store,
  logger, // Use custom logger
});
```

---

## Error Handling

### New Error Codes

| Error Code | Trigger | Status |
|------------|---------|--------|
| `STORE_ERROR` | `logger.isCircuitOpen()` returns true | `"failed"` |
| `CIRCUIT_BREAKER_OPEN` | `circuitBreaker.check()` returns a denial reason | `"denied"` |

### AuditCircuitOpenError

Thrown by `AuditLogger.log()` when the consecutive failure count reaches `maxConsecutiveFailures`:

```typescript
class AuditCircuitOpenError extends Error {
  constructor(consecutiveFailures: number) {
    super(
      `Audit circuit breaker open: ${consecutiveFailures} consecutive write failures. ` +
      `Transactions are blocked until audit logging is restored.`,
    );
    this.name = "AuditCircuitOpenError";
  }
}
```

### Error Flow Summary

```
Audit store fails 3 times consecutively
  -> logger.isCircuitOpen() returns true
  -> wallet.execute() returns { status: "failed", error.code: "STORE_ERROR" }
  -> ALL transactions blocked until logger.resetFailureCount() is called

Agent gets 5 consecutive DENY decisions
  -> circuitBreaker enters cooldown (default 5 minutes)
  -> wallet.execute() returns { status: "denied", error.code: "CIRCUIT_BREAKER_OPEN" }
  -> ALL transactions blocked until cooldown expires or breaker.reset() is called

Policy rule throws an exception
  -> PolicyEngine catches it, returns DENY with audit trail
  -> Transaction is denied (fail-closed)
  -> Error message captured in ruleAudits[].reason
```

---

## API Reference

### New Exports

```typescript
// Classes
export { CircuitBreaker } from "./core/circuit-breaker.js";
export { AuditLogger, AuditCircuitOpenError } from "./logging/audit.js";

// Types
export type { CircuitBreakerConfig } from "./core/circuit-breaker.js";
export type { AuditLoggerConfig, AuditFailureCallback, IntegrityReport } from "./logging/audit.js";
export type { AuditEntry, PolicyRuleAudit } from "./logging/types.js";
export type { PolicyEvaluationResult } from "./policy/types.js";
```

### `AuditLogger`

#### `constructor(storeOrConfig: Store | AuditLoggerConfig)`

Creates an audit logger. Accepts a bare `Store` for backward compatibility or an `AuditLoggerConfig` object.

#### `log(entry: AuditEntry): Promise<boolean>`

Logs an audit entry with hash chain integrity. Returns `true` on success, `false` on failure. Throws `AuditCircuitOpenError` after `maxConsecutiveFailures` consecutive failures.

#### `getRecent(count?: number): Promise<AuditEntry[]>`

Returns the most recent audit entries (default: 10). Skips corrupted entries gracefully.

#### `isCircuitOpen(): boolean`

Returns `true` if the audit circuit breaker is open (too many consecutive write failures).

#### `getFailureCount(): number`

Returns the current consecutive failure count.

#### `resetFailureCount(): void`

Resets the failure counter to 0. Use after fixing the underlying store issue.

#### `verifyIntegrity(count?: number): Promise<IntegrityReport>`

Verifies the integrity of the hash chain over the most recent `count` entries (default: 100). Walks the chain from oldest to newest checking hash links and recomputing hashes.

### `CircuitBreaker`

#### `constructor(store: Store, config?: Partial<CircuitBreakerConfig>)`

Creates a circuit breaker with the given store and optional config overrides. Throws if `threshold < 1` or `cooldownMs < 0`.

#### `check(now?: number): Promise<string | null>`

Returns `null` if OK, or a human-readable denial reason string if the circuit is open. Automatically resets after the cooldown period expires.

#### `recordOutcome(decision: "ALLOW" | "DENY" | "PENDING", now?: number): Promise<void>`

Records a policy evaluation outcome. ALLOW resets the counter, DENY increments it (triggers cooldown at threshold), PENDING is a no-op.

#### `reset(): Promise<void>`

Manually resets the circuit breaker -- clears the denial counter and cooldown timestamp.

#### `getConfig(): Readonly<CircuitBreakerConfig>`

Returns a frozen copy of the current configuration.

### `PolicyEngine.evaluate()`

**Signature changed** from `Promise<PolicyDecision>` to `Promise<PolicyEvaluationResult>`.

```typescript
interface PolicyEvaluationResult {
  decision: PolicyDecision;
  ruleAudits: PolicyRuleAudit[];
  totalEvaluationTimeMs: number;
}
```

### `AgentWalletConfig` (Updated)

```typescript
interface AgentWalletConfig {
  signer: Signer;
  chain: ChainAdapter;
  policy: PolicyEngine;
  store: Store;
  approval?: ApprovalChannel;
  logger?: AuditLogger;
  /** Circuit breaker config, or false to disable. Default: enabled */
  circuitBreaker?: Partial<CircuitBreakerConfig> | false;
  /** Callback invoked when an audit log write fails */
  onAuditFailure?: AuditFailureCallback;
}
```

---

## Security Model

### Fail-Closed Guarantees

- **Policy evaluation**: A throwing rule produces DENY, not an uncaught exception. No rule error can result in an unauthorized transaction.
- **Audit logging**: When audit writes fail repeatedly, all transactions are blocked. No transaction can proceed without an audit trail.
- **Circuit breaker**: Operates before policy evaluation in the pipeline. Cannot be bypassed by reconfiguring policy rules.

### Hash Chain Integrity

- **Deterministic hashing**: Uses `canonicalJson()` with sorted keys to ensure consistent hash computation regardless of property insertion order.
- **Chained hashes**: Each entry's hash includes the previous entry's hash, so reordering or inserting entries breaks the chain.
- **Verification**: `verifyIntegrity()` walks the entire chain, recomputing each hash and checking each previousHash link.

### Audit Circuit Breaker vs. Circuit Breaker

These are two distinct mechanisms:

| Feature | Audit Circuit Breaker | Circuit Breaker |
|---------|----------------------|-----------------|
| **Location** | `AuditLogger` | `CircuitBreaker` class |
| **Tracks** | Consecutive audit write failures | Consecutive policy denials |
| **Trigger** | `maxConsecutiveFailures` (default: 3) | `threshold` (default: 5) |
| **Recovery** | `resetFailureCount()` | Auto-resets after `cooldownMs` or manual `reset()` |
| **Effect** | Blocks ALL transactions (`status: "failed"`) | Blocks ALL transactions (`status: "denied"`) |
| **Purpose** | Ensures audit trail integrity | Prevents runaway agent behavior |

---

## Files

| File | Purpose |
|------|---------|
| `src/logging/audit.ts` | `AuditLogger` with hash chain integrity and failure detection |
| `src/logging/types.ts` | `AuditEntry`, `PolicyRuleAudit` re-export |
| `src/core/circuit-breaker.ts` | `CircuitBreaker` class for consecutive denial tracking |
| `src/core/wallet.ts` | Updated `execute()` pipeline with audit + circuit breaker checks |
| `src/policy/engine.ts` | Updated `evaluate()` returning `PolicyEvaluationResult` |
| `src/policy/types.ts` | `PolicyEvaluationResult`, `PolicyRuleAudit` types |
