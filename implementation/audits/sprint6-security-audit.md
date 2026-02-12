# Sprint 6 -- Security Audit

**Date:** 2026-02-12
**Auditor:** Security Review (Automated)
**Scope:** Audit Logging + Security Hardening -- Hash Chain Integrity, Failure Counting, Circuit Breaker, Fail-Closed Policy Evaluation
**Files Reviewed:**

- `src/policy/types.ts` (PolicyRuleAudit, PolicyEvaluationResult types)
- `src/policy/engine.ts` (evaluate() with per-rule auditing and fail-closed try/catch)
- `src/logging/audit.ts` (AuditLogger with SHA-256 hash chain, failure counting, circuit breaker)
- `src/logging/types.ts` (AuditEntry with hash/previousHash fields, re-exports)
- `src/core/circuit-breaker.ts` (CircuitBreaker class with store-backed denial tracking)
- `src/core/wallet.ts` (Integration hub: audit circuit check, circuit breaker, real per-rule ruleAudits)
- `src/core/result.ts` (PolicySummary.circuitBreaker field, CIRCUIT_BREAKER_OPEN error code)
- `src/index.ts` (New exports: CircuitBreaker, AuditCircuitOpenError, AuditLoggerConfig, IntegrityReport, etc.)
- `src/stores/interface.ts` (Store interface -- for context on append/getRecent/increment)
- `src/stores/memory.ts` (MemoryStore -- for context on operation semantics)

---

## Summary

Sprint 6 introduces audit logging hardening and a transaction-level circuit breaker. The key changes are:

1. **PolicyEngine.evaluate()** now returns `PolicyEvaluationResult` containing per-rule `PolicyRuleAudit` entries with timing data from `performance.now()`. Each `rule.evaluate()` call is wrapped in try/catch: a throwing rule produces a DENY decision (fail-closed behavior) with the error message recorded in the audit trail.

2. **AuditLogger** is enhanced with SHA-256 hash chain integrity. Each audit entry is hashed with `createHash("sha256").update(entryJson + previousHash)` and the hash is stored alongside the entry. A `verifyIntegrity()` method walks the chain forward, re-computing hashes and verifying `previousHash` links. The logger also tracks consecutive write failures: after `maxConsecutiveFailures` (default 3), it throws `AuditCircuitOpenError` and the wallet refuses further transactions.

3. **CircuitBreaker** is a new store-backed module that tracks consecutive policy denials. After `threshold` denials (default 5), it enters a time-based cooldown (`cooldownMs`, default 5 minutes) during which all transactions are blocked. This prevents runaway agent behavior.

4. **AgentWallet** integrates both mechanisms: the execute pipeline checks `logger.isCircuitOpen()` and `circuitBreaker.check()` before policy evaluation. The `logAudit()` method passes real per-rule audit data from the engine. The `getPolicy()` response now includes circuit breaker status.

The overall design is sound. The fail-closed behavior in the policy engine is correctly implemented. The hash chain provides tamper detection for the audit log. The circuit breaker adds a valuable safety net against runaway agents.

However, there are several security concerns. The most significant is a non-atomic hash chain write sequence where the audit entry and the last-hash pointer are persisted in separate store operations -- a crash between `store.append()` and `store.set()` permanently corrupts the hash chain. The `verifyIntegrity()` method's hash recomputation relies on `JSON.stringify` property ordering, which is not guaranteed to match across serialization/deserialization round-trips for all JavaScript engines. The circuit breaker stores its state in the shared `Store` using predictable keys, making it susceptible to direct store manipulation. The `AuditLogger` constructor's duck-typing heuristic for Store-vs-Config disambiguation can be fooled by edge cases.

### Finding Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH     | 2 |
| MEDIUM   | 4 |
| LOW      | 3 |
| INFO     | 4 |
| **Total** | **13** |

---

## Findings

---

### S6-01 [HIGH] -- Non-Atomic Hash Chain Write Creates Permanent Corruption Window

**File:** `src/logging/audit.ts`
**Line(s):** 111-113
**Description:** The `log()` method persists a new audit entry in two separate store operations:

```typescript
// Persist the entry and update the last hash
await this.store.append(this.storeKey, JSON.stringify(enrichedEntry));
await this.store.set(this.hashKey, hash);
```

These two operations are not atomic. If the process crashes, the store connection drops, or `store.set()` throws after `store.append()` succeeds, the system enters a permanently broken state:

1. The enriched entry (with its `hash` and `previousHash` fields) has been appended to `audit:log`.
2. The `audit:last_hash` pointer still points to the *previous* entry's hash, not the newly appended entry's hash.
3. The next call to `log()` reads the stale `audit:last_hash`, computes a new entry's hash using the wrong `previousHash`, and appends it. This creates a chain where entry N+1's `previousHash` does not match entry N's `hash`.
4. `verifyIntegrity()` will report the chain as broken at entry N+1, even though no tampering occurred.

Worse, because the failure happens *after* `store.append()` succeeds, the catch block at line 118 increments `consecutiveFailures` -- but the entry was already persisted. This means the audit log contains the entry but the failure counter reflects a "failed" write.

The inverse scenario (where `store.append()` fails but `store.set()` would have succeeded) is not possible because `store.set()` is only reached after `store.append()` succeeds. However, the window between these two calls is the vulnerability.

For a production store backed by Redis or a database, network partitions or timeouts during this window are realistic failure modes.

**Impact:** A crash or store error between the two writes permanently corrupts the hash chain. All subsequent entries will have incorrect `previousHash` values. `verifyIntegrity()` will report tampering when none occurred (false positive), undermining trust in the integrity mechanism. If operators dismiss integrity failures as "known to be flaky," actual tampering could go undetected.

**Recommendation:** Combine both operations into a single atomic store call, or use a transaction if the store supports it. One approach is to extend the `Store` interface with a `batch()` method. A simpler approach for the current architecture is to store the last hash *within* the list itself (e.g., always read the most recent entry from the list and extract its hash, rather than maintaining a separate `audit:last_hash` key):

```typescript
async log(entry: AuditEntry): Promise<boolean> {
  if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
    throw new AuditCircuitOpenError(this.consecutiveFailures);
  }

  try {
    // Derive previous hash from the most recent entry in the list
    const recentRaw = await this.store.getRecent(this.storeKey, 1);
    let previousHash = "";
    if (recentRaw.length > 0) {
      try {
        const lastEntry = JSON.parse(recentRaw[0]!) as AuditEntry;
        previousHash = lastEntry.hash ?? "";
      } catch {
        // Corrupted last entry — start a new chain segment
      }
    }

    const entryJson = JSON.stringify(entry);
    const hash = createHash("sha256")
      .update(entryJson + previousHash)
      .digest("hex");

    const enrichedEntry: AuditEntry = {
      ...entry,
      hash,
      previousHash: previousHash || undefined,
    };

    // Single atomic write — no separate hash pointer to update
    await this.store.append(this.storeKey, JSON.stringify(enrichedEntry));

    this.consecutiveFailures = 0;
    return true;
  } catch (err) {
    this.consecutiveFailures++;
    this.onAuditFailure?.(err, this.consecutiveFailures);
    return false;
  }
}
```

This eliminates the `audit:last_hash` key entirely. The trade-off is an extra `getRecent(key, 1)` read per log call, but this removes the atomicity vulnerability.

**Status:** Fix now

---

### S6-02 [HIGH] -- Hash Chain Verification Depends on JSON.stringify Property Order Stability

**File:** `src/logging/audit.ts`
**Line(s):** 98-102 (write path), 214-218 (verify path)
**Description:** During the write path in `log()`, the hash is computed as:

```typescript
const entryJson = JSON.stringify(entry);
const hash = createHash("sha256")
  .update(entryJson + previousHash)
  .digest("hex");
```

During the verification path in `verifyIntegrity()`, the hash is recomputed as:

```typescript
const { hash: _storedHash, previousHash: prevHash, ...entryContent } = entry;
const entryJson = JSON.stringify(entryContent);
const expectedHash = createHash("sha256")
  .update(entryJson + (prevHash ?? ""))
  .digest("hex");
```

There are two distinct problems:

1. **Different objects are being hashed.** The write path hashes `JSON.stringify(entry)` where `entry` is the *original* `AuditEntry` (without `hash` and `previousHash` fields). The verification path hashes `JSON.stringify(entryContent)` where `entryContent` is the *enriched* entry with `hash` and `previousHash` stripped via destructuring. If the original `entry` object happened to have any extra properties, or if properties are ordered differently after a round-trip through `JSON.stringify(enrichedEntry)` then `JSON.parse()` then destructuring, the hash could differ.

   Specifically, the write path computes: `SHA256(JSON.stringify(originalEntry) + previousHash)`.
   The verify path computes: `SHA256(JSON.stringify(parsedEnrichedEntry minus hash/previousHash) + previousHash)`.

   These are the same **only if** `JSON.stringify(originalEntry)` produces the same output as `JSON.stringify(parsedEnrichedEntry minus hash/previousHash)`. In the current code, the enriched entry is created as `{ ...entry, hash, previousHash }`, so the spread puts the original fields first and `hash`/`previousHash` last. After removing `hash` and `previousHash` via destructuring, the remaining fields should have the same order. However, `JSON.parse()` of the stored enriched entry will produce an object with all fields in the order they were serialized -- including `hash` and `previousHash` at the end. Destructuring removes them, so the remaining fields have the same order. **This works correctly in V8/Node.js**, but the ECMAScript spec does not guarantee `JSON.stringify` property enumeration order for integer-like keys vs string keys.

2. **AuditEntry fields with `undefined` values are dropped by `JSON.stringify`.** The `entry` object passed to `log()` may have `agentId: undefined` and `transactionResult: undefined`. `JSON.stringify` drops these fields. But the enriched entry `{ ...entry, hash, previousHash }` also drops them (spread preserves the key but `JSON.stringify` still omits `undefined` values). After round-tripping through `JSON.parse`, those keys are simply absent (not `undefined`). So destructuring the parsed entry produces the same result. **This is currently safe**, but fragile -- if any future code adds a field with a default value that differs between the write path and the parse path, the hash will break silently.

**Impact:** While this works correctly in current Node.js/V8 environments, the hash chain's integrity guarantee rests on an implementation detail of `JSON.stringify` property ordering. A future V8 change, a different JavaScript runtime, or a store implementation that reorders JSON fields during persistence could cause all hash verifications to fail (false positives) or, worse, allow a tampered entry to pass verification if an attacker can predict the ordering difference.

**Recommendation:** Use a canonical serialization format that guarantees deterministic output regardless of property order. The simplest approach is to sort object keys before hashing:

```typescript
function canonicalize(obj: unknown): string {
  return JSON.stringify(obj, Object.keys(obj as object).sort());
}
```

Or use a dedicated canonical JSON library. Apply the same canonicalization in both the write path and the verify path:

```typescript
// Write path
const entryJson = canonicalize(entry);
const hash = createHash("sha256").update(entryJson + previousHash).digest("hex");

// Verify path
const { hash: _storedHash, previousHash: prevHash, ...entryContent } = entry;
const entryJson = canonicalize(entryContent);
const expectedHash = createHash("sha256").update(entryJson + (prevHash ?? "")).digest("hex");
```

**Status:** Fix now

---

### S6-03 [MEDIUM] -- Circuit Breaker State Stored Under Predictable Keys With No Access Control

**File:** `src/core/circuit-breaker.ts`
**Line(s):** 27-29
**Description:** The circuit breaker stores its denial counter and cooldown timestamp using hardcoded, predictable store keys:

```typescript
const DENIAL_COUNT_KEY = "circuit:denial_count";
const COOLDOWN_UNTIL_KEY = "circuit:cooldown_until";
```

Any code with access to the `Store` instance can directly manipulate these values:

```typescript
// Reset the circuit breaker by clearing the denial counter
await store.set("circuit:denial_count", "0");
await store.set("circuit:cooldown_until", "");

// Open the circuit breaker by setting a high denial count
await store.set("circuit:denial_count", "999");

// Force a long cooldown by setting a far-future timestamp
await store.set("circuit:cooldown_until", String(Date.now() + 86400000));
```

The `Store` is shared across the entire wallet -- it is used for idempotency keys (`idempotency:*`), spending limits (`spending:*`), rate limits (`ratelimit:*`), audit logs (`audit:*`), and now circuit breaker state (`circuit:*`). There is no namespace isolation or access control.

This is the same architectural pattern as the existing spending/rate limit keys, so it is not a regression. However, the circuit breaker is a *safety mechanism* -- bypassing it is more security-critical than bypassing a spending limit, because the circuit breaker is meant to be a last-resort protection against runaway agents.

**Impact:** A compromised component, a malicious custom policy rule, or a code path with access to the shared `Store` can silently reset the circuit breaker (allowing a blocked agent to resume transactions) or force-open it (denying service). The shared store lacks namespace isolation, so any store key collision or deliberate manipulation is possible.

**Recommendation:** Consider prefixing circuit breaker keys with a wallet-specific identifier (e.g., the wallet address or a random nonce generated at construction time) to prevent cross-wallet manipulation in a shared store:

```typescript
constructor(store: Store, config?: Partial<CircuitBreakerConfig>, namespace?: string) {
  this.denialCountKey = namespace
    ? `circuit:${namespace}:denial_count`
    : "circuit:denial_count";
  // ...
}
```

For stronger isolation, consider a dedicated store instance for safety-critical state, or at minimum document that the store keys are security-sensitive and must not be writable by untrusted code.

**Status:** Fix now

---

### S6-04 [MEDIUM] -- Audit Logger Constructor Duck-Typing Heuristic Can Misidentify Store vs Config

**File:** `src/logging/audit.ts`
**Line(s):** 64-75
**Description:** The `AuditLogger` constructor uses duck-typing to determine whether the argument is a bare `Store` or an `AuditLoggerConfig`:

```typescript
constructor(storeOrConfig: Store | AuditLoggerConfig) {
    if ("get" in storeOrConfig && "set" in storeOrConfig && !("store" in storeOrConfig)) {
      // Legacy: bare Store passed directly
      this.store = storeOrConfig as Store;
      this.maxConsecutiveFailures = 3;
    } else {
      // New config object
      const config = storeOrConfig as AuditLoggerConfig;
      this.store = config.store;
      this.maxConsecutiveFailures = config.maxConsecutiveFailures ?? 3;
      this.onAuditFailure = config.onAuditFailure;
    }
```

The heuristic checks for `"get" in obj && "set" in obj && !("store" in obj)`. This can be fooled in at least two scenarios:

1. **A Store implementation that has a `store` property.** If a custom `Store` implementation (e.g., a decorator or proxy store) has a property named `store` (e.g., `this.store = innerStore` for a delegating store), the check `!("store" in storeOrConfig)` returns `false`, and the constructor falls through to the config branch. It then tries to access `config.store`, which would be the inner store -- this might accidentally work, or it might be a completely wrong object. This is fragile and could cause silent misconfiguration.

2. **An AuditLoggerConfig that happens to have `get` and `set` methods.** While unlikely given the current `AuditLoggerConfig` type (which only has `store`, `maxConsecutiveFailures`, and `onAuditFailure`), if the config object is created from a class instance or a Proxy that has `get`/`set` methods on it, the constructor would misidentify it as a Store.

More practically, consider a `Store` wrapper:

```typescript
class CachingStore implements Store {
  constructor(private store: Store) {} // has "store" property
  async get(key: string) { return this.store.get(key); }
  async set(key: string, value: string) { return this.store.set(key, value); }
  // ...
}

const logger = new AuditLogger(new CachingStore(realStore));
// Constructor sees "store" in obj → treats as AuditLoggerConfig
// config.store = cachingStore.store = realStore (accidentally works, but fragile)
```

**Impact:** A custom `Store` implementation with a `store` property causes the constructor to take the wrong branch, potentially extracting the wrong store reference or failing at runtime with an unclear error. This is a correctness bug that could cause the audit logger to write to an unexpected store or fail to initialize.

**Recommendation:** Use a more robust detection mechanism. The simplest approach is to check for a property that only `AuditLoggerConfig` has and `Store` cannot have:

```typescript
constructor(storeOrConfig: Store | AuditLoggerConfig) {
    if (typeof (storeOrConfig as AuditLoggerConfig).store === "object" &&
        (storeOrConfig as AuditLoggerConfig).store !== null &&
        "get" in (storeOrConfig as AuditLoggerConfig).store) {
      // Config object: has a .store property that looks like a Store
      const config = storeOrConfig as AuditLoggerConfig;
      this.store = config.store;
      this.maxConsecutiveFailures = config.maxConsecutiveFailures ?? 3;
      this.onAuditFailure = config.onAuditFailure;
    } else {
      // Legacy: bare Store passed directly
      this.store = storeOrConfig as Store;
      this.maxConsecutiveFailures = 3;
    }
```

Or, better, use a discriminator field:

```typescript
export interface AuditLoggerConfig {
  _type: "audit-logger-config"; // discriminator
  store: Store;
  maxConsecutiveFailures?: number;
  onAuditFailure?: AuditFailureCallback;
}
```

**Status:** Fix now

---

### S6-05 [MEDIUM] -- Transaction Proceeds After Audit Log Write Failure (Fail-Open for Current Transaction)

**File:** `src/core/wallet.ts`
**Line(s):** 555-580
**Description:** The `logAudit()` method catches all exceptions from `logger.log()`, including `AuditCircuitOpenError`:

```typescript
private async logAudit(
    intent: TransactionIntent,
    ruleAudits: PolicyRuleAudit[],
    finalDecision: AuditEntry["finalDecision"],
    txResult?: { txId: string; status: "confirmed" | "failed" },
  ): Promise<void> {
    // ...
    try {
      await this.logger.log(entry);
    } catch (err) {
      if (err instanceof AuditCircuitOpenError) {
        // Audit is now broken — future transactions will be blocked
        // But don't break the current transaction flow
      }
      // Other logging failures are swallowed (backward compatible)
    }
  }
```

This means that when a successful transaction (status "confirmed") is logged at line 269:

```typescript
await this.logAudit(normalizedIntent, ruleAudits, policyDecision, { txId, status: "confirmed" });
```

If the audit write fails, the transaction has *already been broadcast to the chain*. The transaction result is returned to the caller with `status: "confirmed"`, but there is no audit record of it. This is a correct design choice for the *current* transaction (you cannot un-broadcast a transaction), but it means:

1. The confirmed transaction exists on-chain but not in the audit log.
2. The `consecutiveFailures` counter increments, but the *next* transaction (not this one) will be blocked if the circuit opens.
3. There is a window of up to `maxConsecutiveFailures` transactions that can execute *and succeed* without any audit trail.

With the default `maxConsecutiveFailures = 3`, an attacker who can cause audit write failures (e.g., by exhausting store capacity or causing network timeouts) can execute up to 3 fully confirmed transactions with no audit record before the circuit opens.

Furthermore, when `logAudit()` is called for DENY and PENDING outcomes (lines 229 and 243), those failures are also swallowed. This means denial audit records can be silently lost, making it impossible to detect that an agent was repeatedly attempting denied transactions.

**Impact:** Up to `maxConsecutiveFailures` transactions can execute without any audit trail if the store is failing. Denial and pending audit records can be silently dropped without blocking the pipeline.

**Recommendation:** Consider two changes:

1. **For confirmed transactions:** Log the audit entry *before* broadcasting (or at least attempt it). If the pre-broadcast audit fails, block the transaction. This is a significant architectural change but provides true fail-closed audit behavior.

2. **For the current architecture:** Reduce `maxConsecutiveFailures` to 1 for the most paranoid deployments, and ensure the `onAuditFailure` callback triggers an external alert. Also consider returning a warning in the `TransactionResult` when the audit write failed:

```typescript
if (!auditWriteSuccess) {
  result.chainData = { ...result.chainData, auditWarning: "Audit log write failed for this transaction" };
}
```

**Status:** Fix now

---

### S6-06 [MEDIUM] -- Circuit Breaker `check()` and `recordOutcome()` Are Not Atomic, Enabling TOCTOU Races

**File:** `src/core/circuit-breaker.ts`
**Line(s):** 53-68 (check), 77-98 (recordOutcome)
**File:** `src/core/wallet.ts`
**Line(s):** 187-211
**Description:** The wallet calls `circuitBreaker.check()` and `circuitBreaker.recordOutcome()` as separate async operations around the policy evaluation:

```typescript
// wallet.ts executeInternal():
// Step 1: Check circuit breaker
const cbReason = await this.circuitBreaker.check();
if (cbReason) { return denied; }

// Step 2: Evaluate policy (awaits)
const evaluationResult = await this.policy.evaluate(normalizedIntent);

// Step 3: Record outcome
await this.circuitBreaker.recordOutcome(policyDecision.decision);
```

While the wallet's `execute()` method is serialized by a mutex (line 136-147), the circuit breaker's `check()` method itself reads two store keys non-atomically:

```typescript
async check(now?: number): Promise<string | null> {
    const currentTime = now ?? Date.now();
    const cooldownUntil = await this.store.get(COOLDOWN_UNTIL_KEY);
    if (cooldownUntil !== null) {
      const expiresAt = parseInt(cooldownUntil, 10);
      if (!isNaN(expiresAt) && currentTime < expiresAt) {
        return `Circuit breaker open: ...`;
      }
      // Cooldown expired — reset
      await this.reset();
    }
    return null;
  }
```

And `recordOutcome()` reads and writes non-atomically:

```typescript
async recordOutcome(decision: "ALLOW" | "DENY" | "PENDING", now?: number): Promise<void> {
    // ...
    const newCount = await this.store.increment(DENIAL_COUNT_KEY, 1);
    if (newCount >= this.config.threshold) {
      const currentTime = now ?? Date.now();
      const cooldownExpiry = currentTime + this.config.cooldownMs;
      await this.store.set(COOLDOWN_UNTIL_KEY, String(cooldownExpiry));
    }
  }
```

In the wallet, the execute mutex ensures that only one `executeInternal()` runs at a time, so these circuit breaker calls are effectively serialized *within a single wallet instance*. However, if multiple `AgentWallet` instances share the same store (e.g., in a multi-process deployment), the non-atomic check-then-act pattern in `check()` and `recordOutcome()` creates race conditions:

- Two wallets both call `check()` simultaneously, both see the cooldown has expired, both call `reset()`, and then both proceed -- this is benign (double reset).
- Two wallets both call `recordOutcome("DENY")` concurrently. `store.increment()` is atomic (returns new value), so the threshold check is correct. However, the `store.set(COOLDOWN_UNTIL_KEY, ...)` could be called twice with slightly different timestamps -- also benign.

The primary concern is the `check()` method's `await this.reset()` call at line 65. If `reset()` sets `DENIAL_COUNT_KEY` to "0" and `COOLDOWN_UNTIL_KEY` to "" non-atomically, a concurrent `recordOutcome("DENY")` could increment the counter between the two `reset()` writes, losing the reset.

**Impact:** In a single-wallet-instance deployment (the expected case), the execute mutex prevents these races. In a multi-instance deployment sharing a store, the non-atomic operations could cause the circuit breaker to reset prematurely or miss the transition to cooldown. The practical risk is low because the circuit breaker is a safety net, not a primary control.

**Recommendation:** Document that `CircuitBreaker` is designed for single-instance use behind the wallet's execute mutex. For multi-instance deployments, recommend using a store that supports atomic transactions (e.g., Redis MULTI/EXEC) and implement the check-and-increment as a single atomic operation:

```typescript
// Ideal: Lua script in Redis
// EVALSHA check_and_record denial_count_key cooldown_key threshold cooldown_ms now
```

For the current implementation, add a comment documenting the concurrency assumption:

```typescript
/**
 * Note: CircuitBreaker is designed for use behind AgentWallet's execute mutex.
 * Multi-instance deployments sharing a store may experience race conditions.
 */
```

**Status:** Deferred (acceptable for single-instance use; document concurrency limitations)

---

### S6-07 [LOW] -- Policy Engine Error Messages in Fail-Closed Path Leak Rule Implementation Details

**File:** `src/policy/engine.ts`
**Line(s):** 56-76
**Description:** When a rule's `evaluate()` method throws an exception, the error message is captured and included in both the `PolicyRuleAudit.reason` and the `PolicyDeny.reason`:

```typescript
} catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    ruleAudits.push({
      rule: rule.name,
      result: "DENY",
      reason: `Rule evaluation error: ${errorMsg}`,
      evaluationTimeMs: ruleMs,
    });

    return {
      decision: {
        decision: "DENY",
        rule: rule.name,
        reason: `Rule evaluation error: ${errorMsg}`,
      },
      ruleAudits,
      totalEvaluationTimeMs: totalMs,
    };
```

The `errorMsg` is the raw exception message from the rule. For built-in rules, these messages are controlled and safe. But for custom rules (user-implemented `PolicyRule` implementations), the error could contain:

- Database connection strings from a rule that queries an external database
- API keys or tokens from a rule that calls an external service
- Stack trace fragments from deeply nested errors
- Internal file paths

This error message flows through the wallet's `logAudit()` into the audit log (where it is persisted to the store) and through the `TransactionResult.error.message` field back to the caller (which could be an LLM agent via `handleToolCall()`).

The wallet's `handleToolCall()` at line 398-404 catches errors generically and returns a sanitized message, but this error does not come from a thrown exception -- it comes from the structured `TransactionResult.error.message`, which is passed through by `transactionResultToToolResult()` at line 738:

```typescript
error: result.error?.message ?? result.summary,
```

So the raw rule error message is exposed to the agent.

**Impact:** A custom policy rule that throws an exception with sensitive details in its message will have those details persisted in the audit log and returned to the calling agent. This could leak database credentials, API keys, or infrastructure details.

**Recommendation:** Sanitize the error message in the fail-closed path:

```typescript
} catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const sanitizedMsg = `Rule "${rule.name}" threw an exception during evaluation`;
    ruleAudits.push({
      rule: rule.name,
      result: "DENY",
      reason: sanitizedMsg,
      evaluationTimeMs: ruleMs,
    });

    // Log the full error internally for debugging
    // console.error(`PolicyEngine: rule ${rule.name} threw:`, err);

    return {
      decision: {
        decision: "DENY",
        rule: rule.name,
        reason: sanitizedMsg,
      },
      ruleAudits,
      totalEvaluationTimeMs: totalMs,
    };
```

**Status:** Fix now

---

### S6-08 [LOW] -- `performance.now()` Timing Data in PolicyRuleAudit May Enable Side-Channel Attacks

**File:** `src/policy/engine.ts`
**Line(s):** 48, 51, 58, 79, 88, 97
**Description:** The policy engine records high-resolution timing for each rule evaluation using `performance.now()`:

```typescript
const totalStart = performance.now();

for (const rule of this.rules) {
    const ruleStart = performance.now();
    // ... evaluate rule ...
    const ruleMs = performance.now() - ruleStart;
    ruleAudits.push({
      rule: rule.name,
      // ...
      evaluationTimeMs: ruleMs,
    });
```

This timing data is included in `PolicyRuleAudit`, which flows through to:
1. The `AuditEntry.policyDecisions` array (persisted in the audit log)
2. The `TransactionResult` via `logAudit()` (not directly, but the audit entry is accessible via `getTransactionHistory()`)

`performance.now()` provides microsecond-resolution timing on most platforms. This precision can reveal:

- **Allowlist rule timing:** Whether an address was found via early return vs. full set iteration (though `Set.has()` is O(1), the timing could still differ for cache hot/cold lookups).
- **Spending limit rule timing:** Whether the spending limit check hit the store (cache miss) vs. passed immediately (no limit configured). The time difference between a rule that queries the store and one that short-circuits could reveal which limits are configured.
- **Approval gate rule timing:** Whether the rule performed a threshold comparison (fast) vs. triggered an approval request (slow, involves network I/O).

An adversarial agent that can call `getTransactionHistory()` or observe `TransactionResult` details could correlate timing data across multiple denied transactions to infer policy configuration details that are not directly exposed by `getPolicy()`.

In modern browsers, `performance.now()` has been reduced to 5us or 100us resolution to mitigate Spectre-style timing attacks. Node.js does not apply this mitigation by default, so the full resolution is available.

**Impact:** Low. The timing data could theoretically reveal some information about policy configuration and store performance characteristics. However, the `getPolicy()` endpoint already exposes most policy configuration directly, limiting the incremental information gain from timing. The primary risk is in deployments where policy details are intentionally kept opaque to the agent.

**Recommendation:** Consider rounding timing values to reduce precision:

```typescript
const ruleMs = Math.round(performance.now() - ruleStart);
```

Or, for maximum opacity, only record coarse-grained categories:

```typescript
evaluationTimeMs: ruleMs < 1 ? 0 : ruleMs < 10 ? 10 : ruleMs < 100 ? 100 : Math.round(ruleMs),
```

Alternatively, document that `PolicyRuleAudit.evaluationTimeMs` is intended for internal diagnostics and should not be exposed to agents. The `getTransactionHistory()` method already strips per-rule audit data (it only returns status, txId, summary, intentId, timestamp), so this data is only exposed through direct audit log access.

**Status:** Deferred (low practical risk; timing data is not directly exposed to agents through the current API surface)

---

### S6-09 [LOW] -- Circuit Breaker `cooldownMs: 0` Allows Instant Recovery, Defeating the Purpose

**File:** `src/core/circuit-breaker.ts`
**Line(s):** 42-44
**Description:** The constructor validates that `cooldownMs >= 0`:

```typescript
if (this.config.cooldownMs < 0) {
    throw new Error("CircuitBreaker cooldownMs must be >= 0");
}
```

A `cooldownMs` of 0 means the cooldown expires immediately. The `check()` method compares `currentTime < expiresAt`:

```typescript
const expiresAt = parseInt(cooldownUntil, 10);
if (!isNaN(expiresAt) && currentTime < expiresAt) {
    // Still in cooldown
    return `Circuit breaker open: ...`;
}
// Cooldown expired — reset
await this.reset();
```

With `cooldownMs: 0`, the cooldown expiry is `currentTime + 0 = currentTime`. On the very next `check()` call, `currentTime` will be >= `expiresAt` (since at least some nanoseconds have elapsed), so the cooldown is already expired. This effectively makes the circuit breaker a no-op: it triggers, immediately resets, and allows the next transaction through.

This configuration can be set intentionally (to disable cooldown while keeping denial counting) or accidentally (by passing `cooldownMs: 0` thinking it means "use default").

**Impact:** A `cooldownMs` of 0 allows an adversarial agent to continue sending transactions without any effective pause, even after hitting the denial threshold. The circuit breaker's protective purpose is entirely defeated.

**Recommendation:** Either enforce a minimum cooldown (e.g., `cooldownMs >= 1000`) or treat `cooldownMs: 0` as "circuit breaker disabled" with a clear log message:

```typescript
if (this.config.cooldownMs < 1000) {
    throw new Error("CircuitBreaker cooldownMs must be at least 1000 (1 second). Use cooldownMs: false to disable.");
}
```

Or document that `cooldownMs: 0` is a valid "no cooldown" configuration and accept the trade-off.

**Status:** Fix now

---

### S6-10 [INFO] -- `verifyIntegrity()` Cannot Validate the First Entry's Previous Hash

**File:** `src/logging/audit.ts`
**Line(s):** 197-199
**Description:** The `verifyIntegrity()` method explicitly skips validation of the first entry's `previousHash`:

```typescript
if (i === 0) {
    // First entry's previousHash must be undefined or match whatever was before
    // We can't verify the very first entry's previousHash without the entry before it
}
```

When `verifyIntegrity(count)` is called with a `count` less than the total number of entries, the "first" entry in the checked range is not actually the first entry in the full chain. Its `previousHash` should match the entry *before* the range, but that entry is not loaded.

This means an attacker could tamper with the oldest entry in any verified range (replace it entirely) as long as the replacement entry's hash is self-consistent. The `previousHash` of the next entry would need to match, so the attacker would also need to recompute all subsequent hashes -- which defeats the chain. However, if the attacker replaces the *first* entry in the verified range (not the first entry in the full chain), only the `previousHash` link is unchecked.

**Impact:** No practical impact for full-chain verification. For partial verification (verifying the most recent N entries), the oldest entry in the range cannot be fully validated. An attacker who can replace this single entry and update its hash (but not subsequent entries) would be detected by the `previousHash` check on entry i=1. The only undetectable tampering is replacing the very first entry ever logged (entry 0 of the full chain), but that entry's `previousHash` is `undefined` anyway.

**Recommendation:** Add a note to the `IntegrityReport` indicating whether the full chain was verified or only a subset:

```typescript
return {
  valid: true,
  entriesChecked: entries.length,
  firstBrokenAt: -1,
  partial: raw.length === count, // true if we may have only checked a subset
};
```

No code change required for security -- this is an inherent limitation of partial chain verification.

**Status:** Not an issue (inherent limitation; document in API)

---

### S6-11 [INFO] -- Audit Circuit Breaker (`isCircuitOpen`) Is In-Memory Only, Does Not Survive Process Restart

**File:** `src/logging/audit.ts`
**Line(s):** 58, 90, 116, 119, 140
**Description:** The `AuditLogger`'s `consecutiveFailures` counter is an in-memory instance variable:

```typescript
private consecutiveFailures = 0;
```

This counter is not persisted to the store. If the process restarts (e.g., a Node.js crash or deployment), the counter resets to 0 and the audit circuit closes, even if the underlying store is still broken.

By contrast, the `CircuitBreaker` class persists its denial count to the store (using `store.increment(DENIAL_COUNT_KEY, 1)` and `store.get(COOLDOWN_UNTIL_KEY)`), so it survives restarts.

The difference in behavior is intentional and reasonable: the audit circuit breaker's job is to detect that the store itself is broken, so persisting state *to the store* would be paradoxical. However, this means:

1. A process restart resets the audit circuit, allowing up to `maxConsecutiveFailures` more transactions without audit before the circuit re-opens.
2. If the store is intermittently failing (e.g., network flapping), the process could be restarted repeatedly to bypass the audit circuit indefinitely.

**Impact:** No immediate risk in normal operation. The in-memory approach is the correct design choice given that the store is the component being monitored. In adversarial scenarios where an attacker can trigger process restarts, the audit circuit can be repeatedly reset.

**Recommendation:** Consider writing the failure count to a local file or an alternative out-of-band persistence mechanism. Alternatively, document this behavior and ensure that process restart frequency is monitored externally. No code change required.

**Status:** Not an issue (by-design trade-off; document in operational guide)

---

### S6-12 [INFO] -- `CircuitBreaker.reset()` Clears Cooldown With Empty String Instead of Deleting Key

**File:** `src/core/circuit-breaker.ts`
**Line(s):** 101-104
**Description:** The `reset()` method clears the cooldown by setting the key to an empty string:

```typescript
async reset(): Promise<void> {
    await this.store.set(DENIAL_COUNT_KEY, "0");
    await this.store.set(COOLDOWN_UNTIL_KEY, "");
}
```

The `check()` method reads this value and checks for `null`:

```typescript
const cooldownUntil = await this.store.get(COOLDOWN_UNTIL_KEY);
if (cooldownUntil !== null) {
    const expiresAt = parseInt(cooldownUntil, 10);
    if (!isNaN(expiresAt) && currentTime < expiresAt) {
```

When `COOLDOWN_UNTIL_KEY` is set to `""`, `store.get()` returns `""` (not `null`), so the `if (cooldownUntil !== null)` check enters the branch. Then `parseInt("", 10)` returns `NaN`, and `!isNaN(NaN)` is `false`, so the cooldown check is skipped. The code then falls through to `await this.reset()` (line 65) -- calling reset *again* while already in a reset call.

This creates a redundant `reset()` call on every `check()` after a reset. It is not harmful (both calls set the same values), but it is wasteful and could cause confusion in debugging. More importantly, the `Store` interface does not have a `delete()` method, so setting to `""` is the only way to "clear" a key. The `Store.get()` contract says "Returns null if not found" -- but `set(key, "")` creates a key with an empty string value, which is *found* and returns `""`, not `null`.

**Impact:** No security risk. A minor inefficiency where `check()` calls `reset()` redundantly on every invocation after a reset. This doubles the store writes during the "healthy" state after a cooldown expires.

**Recommendation:** Check for both `null` and `""` in the `check()` method:

```typescript
const cooldownUntil = await this.store.get(COOLDOWN_UNTIL_KEY);
if (cooldownUntil !== null && cooldownUntil !== "") {
    // ...
}
```

Or change `reset()` to use a sentinel value that `parseInt` handles cleanly:

```typescript
await this.store.set(COOLDOWN_UNTIL_KEY, "0"); // parseInt("0") = 0 < currentTime → expired
```

**Status:** Not an issue (minor inefficiency; no security impact)

---

### S6-13 [INFO] -- Duplicate `PolicyRuleAudit` Export Names in `index.ts` May Confuse Consumers

**File:** `src/index.ts`
**Line(s):** 49, 90
**Description:** The `index.ts` barrel exports `PolicyRuleAudit` under two different names from two different paths:

```typescript
// Line 49: from policy/types.ts, aliased
export type {
  // ...
  PolicyRuleAudit as PolicyRuleAuditType,
  // ...
} from "./policy/types.js";

// Line 90: from logging/types.ts, original name
export type { AuditEntry, PolicyRuleAudit } from "./logging/types.js";
```

Both resolve to the same type (since `logging/types.ts` re-exports `PolicyRuleAudit` from `policy/types.ts`), but consumers see two exports: `PolicyRuleAuditType` and `PolicyRuleAudit`. This is confusing:

```typescript
import { PolicyRuleAudit, PolicyRuleAuditType } from "kova";
// These are the same type
```

The alias `PolicyRuleAuditType` appears to have been introduced to avoid a name collision in the exports, but having both available creates ambiguity about which one to import.

**Impact:** No security impact. This is a developer experience issue that could lead to inconsistent imports across a codebase.

**Recommendation:** Remove one of the two exports. Since `PolicyRuleAudit` is the canonical name, keep it and remove the `PolicyRuleAuditType` alias:

```typescript
// Remove from line 49:
// PolicyRuleAudit as PolicyRuleAuditType,
```

**Status:** Not an issue (DX concern, not a security vulnerability)

---

## Verified as Correct

The following areas were reviewed and found to be properly implemented:

1. **Fail-Closed Policy Evaluation:** The `PolicyEngine.evaluate()` method correctly wraps each `rule.evaluate()` call in a try/catch (line 54-77). A throwing rule produces a DENY decision with audit trail. There are no code paths where a rule error results in anything other than DENY. The remaining rules are not evaluated after a DENY (short-circuit at line 87-94). **Verdict: Secure.**

2. **AuditLogger SHA-256 Hash Implementation:** The hash is computed using Node.js `createHash("sha256")` from the `node:crypto` module, which uses OpenSSL. The hash input is `entryJson + previousHash`, which concatenates the JSON representation of the entry with the previous hash. While string concatenation has theoretical ambiguity risks (S6-02), the SHA-256 implementation itself is correct. **Verdict: Secure (with S6-02 caveat).**

3. **AuditLogger Failure Counting and Circuit:** The `consecutiveFailures` counter increments on each failed write (line 119) and resets to 0 on success (line 116). The `isCircuitOpen()` check (line 140-142) correctly compares against `maxConsecutiveFailures`. The `log()` method throws `AuditCircuitOpenError` when the circuit is open (line 90-92), preventing further write attempts. **Verdict: Secure.**

4. **Wallet Audit Circuit Check Placement:** The `isCircuitOpen()` check at line 173 is placed *before* policy evaluation and transaction execution. This ensures that no new transactions are processed when audit logging is broken. The check is inside the execute mutex, preventing TOCTOU races. **Verdict: Secure.**

5. **Wallet Circuit Breaker Check Placement:** The `circuitBreaker.check()` at line 188 is placed after the audit circuit check and before policy evaluation. The `circuitBreaker.recordOutcome()` at line 210 is called after policy evaluation. Both are inside the execute mutex. **Verdict: Secure.**

6. **CircuitBreaker Constructor Validation:** The constructor validates `threshold >= 1` and `cooldownMs >= 0` (with S6-09 caveat for `cooldownMs = 0`). The default config is sensible (threshold=5, cooldownMs=300000). The `getConfig()` returns a frozen copy. **Verdict: Secure.**

7. **CircuitBreaker PENDING Handling:** The `recordOutcome()` method treats `PENDING` as a no-op (line 84-87), which is correct. A PENDING decision means a human is being asked for approval -- this is not a denial and should not contribute to the circuit breaker's denial counter. **Verdict: Correct.**

8. **CircuitBreaker ALLOW Reset:** The `recordOutcome()` method resets the denial counter to "0" on ALLOW (line 79-81). This is correct: a successful transaction indicates the agent is operating normally, so the consecutive denial count should reset. **Verdict: Correct.**

9. **PolicyEvaluationResult Type Safety:** The `PolicyEvaluationResult` type is well-defined with `decision: PolicyDecision`, `ruleAudits: PolicyRuleAudit[]`, and `totalEvaluationTimeMs: number`. The `PolicyRuleAudit` type uses a union `"ALLOW" | "DENY" | "PENDING"` for the result field, matching the possible `PolicyDecision.decision` values. **Verdict: Secure.**

10. **AuditEntry Hash Fields Are Optional:** The `hash?: string` and `previousHash?: string` fields in `AuditEntry` are optional (line 32-34 of `logging/types.ts`), maintaining backward compatibility with existing audit entries that do not have hash chain data. **Verdict: Correct.**

11. **Circuit Breaker Status in getPolicy():** The `getPolicy()` method (wallet.ts lines 337-345) correctly reads circuit breaker config and status, exposing `threshold`, `cooldownMs`, and `isOpen` in the `PolicySummary`. This gives agents visibility into the circuit breaker state. The `isOpen` check calls `circuitBreaker.check()` which may reset an expired cooldown as a side effect, which is acceptable. **Verdict: Correct.**

12. **Wallet Constructor AuditLogger Creation:** The wallet constructor (lines 95-104) correctly handles three cases: (a) a pre-built logger is provided, (b) `onAuditFailure` is provided so a config-based logger is created, (c) neither, so a legacy store-based logger is created. **Verdict: Correct.**

---

## Risk Summary by File

| File | Findings | Highest Severity |
|------|----------|-----------------|
| `src/logging/audit.ts` | S6-01, S6-02, S6-04, S6-10, S6-11 | HIGH |
| `src/core/circuit-breaker.ts` | S6-03, S6-06, S6-09, S6-12 | MEDIUM |
| `src/core/wallet.ts` | S6-05 | MEDIUM |
| `src/policy/engine.ts` | S6-07, S6-08 | LOW |
| `src/logging/types.ts` | (none -- types are correctly defined) | -- |
| `src/policy/types.ts` | (none -- types are correctly defined) | -- |
| `src/core/result.ts` | (none -- CIRCUIT_BREAKER_OPEN code is appropriate) | -- |
| `src/index.ts` | S6-13 | INFO |

---

## Recommended Priority for Remediation

**Immediate (before any production use):**
1. **S6-01** -- Make hash chain writes atomic (eliminate crash window between append and set)
2. **S6-02** -- Use canonical JSON serialization for hash computation (prevent cross-environment hash mismatches)
3. **S6-05** -- Consider fail-closed audit for confirmed transactions, or at minimum alert on audit write failures

**Before beta/production:**
4. **S6-03** -- Namespace circuit breaker store keys to prevent cross-wallet manipulation
5. **S6-04** -- Improve AuditLogger constructor Store-vs-Config detection to handle decorator stores
6. **S6-07** -- Sanitize rule error messages in the fail-closed DENY path

**Hardening:**
7. **S6-06** -- Document single-instance concurrency assumption for CircuitBreaker
8. **S6-09** -- Enforce a minimum cooldown period for CircuitBreaker (e.g., >= 1 second)
9. **S6-08** -- Consider rounding timing data or restricting access to PolicyRuleAudit
10. **S6-12** -- Fix redundant reset call by checking for empty string in circuit breaker check()

---

## Test Coverage Recommendations

The following scenarios should be covered by unit tests for the Sprint 6 code:

1. **Hash chain crash simulation:** Mock `store.set()` to throw after `store.append()` succeeds. Verify that subsequent entries have broken `previousHash` links and that `verifyIntegrity()` detects the break.
2. **Hash chain tampering detection:** Write 10 entries, modify one entry's content in the store, and verify `verifyIntegrity()` detects the tampered entry.
3. **Hash chain entry reordering:** Write entries A, B, C, then reorder them to A, C, B in the store and verify `verifyIntegrity()` detects the reorder.
4. **Audit circuit breaker threshold:** Write `maxConsecutiveFailures` failing logs and verify that the next `log()` call throws `AuditCircuitOpenError`. Verify `isCircuitOpen()` returns true. Call `resetFailureCount()` and verify the circuit closes.
5. **Audit circuit blocks transactions:** Set up a wallet with a logger whose circuit is open. Call `execute()` and verify the transaction is blocked with `STORE_ERROR`.
6. **Circuit breaker denial counting:** Record `threshold - 1` DENY outcomes and verify `check()` returns null. Record one more DENY and verify `check()` returns a non-null reason.
7. **Circuit breaker cooldown expiry:** Open the circuit breaker, advance time past `cooldownMs`, and verify `check()` returns null (circuit resets).
8. **Circuit breaker ALLOW reset:** Record 3 DENYs, then 1 ALLOW, then verify the denial counter is reset to 0.
9. **Circuit breaker PENDING no-op:** Record PENDING outcomes and verify the denial counter does not change.
10. **Policy engine fail-closed:** Create a rule that throws an Error. Verify `evaluate()` returns DENY with the rule's name and an audit entry with result "DENY".
11. **Policy engine fail-closed with non-Error throw:** Create a rule that throws a string. Verify `evaluate()` returns DENY with the stringified value in the audit.
12. **AuditLogger constructor with decorator store:** Pass a Store that has a `store` property and verify it is correctly identified (tests S6-04).
13. **CircuitBreaker with cooldownMs=0:** Verify that after denial threshold is reached, the next `check()` call sees the cooldown as already expired.
14. **verifyIntegrity with partial chain:** Write 20 entries, verify only the last 5 with `verifyIntegrity(5)`, and confirm the report is valid.
15. **verifyIntegrity with corrupted JSON:** Inject a non-JSON string into the audit log list and verify `verifyIntegrity()` reports corruption.
