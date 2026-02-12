# Sprint 1 -- Security Audit Report

**Project:** kova -- Policy-Constrained Crypto Wallet SDK for AI Agents
**Sprint:** 1 (Core Execute Pipeline, Mock Adapter, Audit Logging Integration)
**Auditor:** Senior Cybersecurity Engineer
**Date:** 2026-02-11
**Scope:** Sprint 1 source files -- `src/core/wallet.ts`, `src/chains/solana/adapter.ts`, `src/core/intent.ts`, `src/core/result.ts`, `src/logging/audit.ts`, `src/logging/types.ts`, `src/policy/engine.ts`, plus cross-cutting review of interfaces and tests
**Total Files Reviewed:** 7 primary source files, 5 interface files, 3 test files, 5 policy rule stubs

---

## Sprint 0 Remediation Status

Before detailing Sprint 1 findings, the following Sprint 0 findings were verified:

| ID | Finding | Status |
|----|---------|--------|
| C-01 | Policy rule stubs return ALLOW (fail-open) | **FIXED** -- All stubs now return `DENY` with "not yet implemented" reason |
| C-02 | PolicyEngine allows empty rules array | **FIXED** -- Constructor now throws if `rules.length === 0` |
| C-03 | `bigint-buffer` dependency vulnerability | **NOT VERIFIED** -- Out of scope for code review; requires `npm audit` re-run |
| H-03 | `MemoryStore.increment()` race condition | **FIXED** -- Refactored to synchronous internal operation without await between read/write |
| L-04 | `AuditLogger.getRecent()` unsafe JSON parsing | **FIXED** -- Now wraps each entry in try/catch, skipping corrupted entries |

---

## Summary

This audit covers the Sprint 1 implementation, which wires together the full transaction execution pipeline (`normalize -> policy -> build -> sign -> broadcast -> log -> result`), introduces mock methods in `SolanaAdapter`, integrates audit logging, and adds helper methods (`getBalance`, `getTransactionHistory`, summary generation).

**Overall Assessment:** The execute pipeline is structurally sound and follows the intended architecture. The fail-closed policy stance from Sprint 0 remediation is respected. However, several medium and high severity issues exist, primarily around: (1) silent audit logging failures creating forensic blind spots, (2) lack of idempotency enforcement on intent replay, (3) unsafe type assertions in the policy decision handling, and (4) mock adapter behavior that will mask critical security properties when replaced with real implementations.

### Finding Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 1     |
| HIGH     | 4     |
| MEDIUM   | 6     |
| LOW      | 4     |
| INFO     | 3     |
| **Total** | **18** |

---

## Findings

---

### S1-01 [CRITICAL]: Silent Audit Log Failure Creates Undetectable Transaction Execution

**File:** `/Users/haythembalti/Documents/kova/src/core/wallet.ts`, lines 271-275

**Description:**
The `logAudit()` private method silently swallows all logging exceptions:

```typescript
try {
  await this.logger.log(entry);
} catch {
  // Logging failure must not break the transaction flow
}
```

This design decision means that if the audit log store is unavailable, full, corrupted, or misconfigured, transactions will execute and return success to the caller with **zero evidence** that they occurred. The comment "Logging failure must not break the transaction flow" reflects a liveness-over-safety tradeoff that is inappropriate for a financial security system.

Critically, this interacts with the `execute()` pipeline at line 129: the transaction has already been broadcast and confirmed on-chain before `logAudit()` is called. A failure at this point means real money has moved but the audit trail has a gap.

**Impact:**
- An attacker who can induce store failures (e.g., filling disk, corrupting the store, or exploiting a DoS vector on the store backend) can execute unlimited transactions with no audit trail.
- Forensic investigation after a compromise would have incomplete data, potentially missing the most important transactions.
- Compliance frameworks (SOC 2, PCI DSS) require that security-relevant events are reliably logged; silent failures violate this requirement.
- The test at line 346-355 of `wallet.test.ts` explicitly validates this behavior (`"should not break if audit logging fails"`), meaning this is an intentional design decision, not a bug -- making it more dangerous because it will not be "discovered" organically.

**Recommendation:**
1. Separate the concern: the transaction result should still be returned to the caller, but audit failures must be surfaced. Implement a fallback logging mechanism (e.g., write to stderr, an in-memory ring buffer, or a secondary store).
2. Add an `onAuditFailure` callback to `AgentWalletConfig` so operators can wire up alerts:
   ```typescript
   export interface AgentWalletConfig {
     // ... existing fields
     onAuditFailure?: (entry: AuditEntry, error: Error) => void;
   }
   ```
3. Track consecutive audit failures and trigger a circuit breaker that halts transaction execution after N consecutive audit write failures:
   ```typescript
   private auditFailureCount = 0;
   private readonly maxAuditFailures = 3;

   private async logAudit(...): Promise<void> {
     if (this.auditFailureCount >= this.maxAuditFailures) {
       throw new Error("Audit logging circuit breaker open: too many consecutive failures");
     }
     try {
       await this.logger.log(entry);
       this.auditFailureCount = 0;
     } catch (err) {
       this.auditFailureCount++;
       this.config.onAuditFailure?.(entry, err instanceof Error ? err : new Error(String(err)));
       // Still allow the current transaction through, but next one may be blocked
     }
   }
   ```
4. At minimum, log the error to `console.error` in the catch block so it is observable in process output.

---

### S1-02 [HIGH]: No Idempotency Enforcement -- Intent Replay Attack

**File:** `/Users/haythembalti/Documents/kova/src/core/wallet.ts`, lines 57-60, 221-227

**Description:**
The `execute()` method auto-generates an `id` via `normalizeIntent()` if one is not provided, but it never checks whether an intent with a given ID has already been processed:

```typescript
private normalizeIntent(intent: TransactionIntent): TransactionIntent {
  return {
    ...intent,
    id: intent.id ?? randomUUID(),
    createdAt: intent.createdAt ?? Date.now(),
  };
}
```

If a caller provides the same `id` twice (or if no `id` is provided and the same intent object is submitted twice), the system will execute both submissions independently. There is no deduplication check against previously processed intent IDs.

This was flagged in Sprint 0 as H-06 with a recommendation to "store processed intent IDs in the Store and reject duplicates." That recommendation has not been implemented.

**Impact:**
- An AI agent (or compromised agent) can replay the same transaction intent repeatedly, draining funds beyond what the policy engine intends to allow.
- Retry logic in agent frameworks (e.g., LangChain, CrewAI) commonly retries failed tool calls. If a transaction succeeds on-chain but the result is lost due to a network error, the retry will execute the transaction again.
- Combined with the mock adapter's always-success behavior (S1-07), this is untestable in the current sprint and will become a live vulnerability in Sprint 3.

**Recommendation:**
1. Before policy evaluation, check whether the intent ID has already been processed:
   ```typescript
   async execute(intent: TransactionIntent): Promise<TransactionResult> {
     const normalizedIntent = this.normalizeIntent(intent);
     const intentId = normalizedIntent.id!;

     // Idempotency check
     const existing = await this.store.get(`intent:${intentId}`);
     if (existing) {
       return JSON.parse(existing) as TransactionResult;
     }

     // ... rest of pipeline ...

     // After successful execution, store the result
     await this.store.set(`intent:${intentId}`, JSON.stringify(result));
     return result;
   }
   ```
2. Set a TTL on the idempotency key (e.g., 24 hours) to prevent unbounded storage growth.
3. Add tests that submit the same intent ID twice and verify the second call returns the cached result without re-executing.

---

### S1-03 [HIGH]: Unsafe Type Assertions on PolicyDecision Bypass Type Safety

**File:** `/Users/haythembalti/Documents/kova/src/core/wallet.ts`, lines 68, 70, 79-80, 99

**Description:**
The `execute()` method uses bare `as` type assertions to extract fields from `PolicyDecision`, bypassing TypeScript's discriminated union narrowing:

```typescript
// Line 68: After checking decision === "ALLOW"
rule: policyDecision.decision === "ALLOW" ? "all" : (policyDecision as { rule: string }).rule ?? "unknown",

// Line 79-80: After checking decision === "DENY"
message: (policyDecision as { reason: string }).reason,
policyRule: (policyDecision as { rule: string }).rule,

// Line 99: After checking decision === "PENDING"
summary: `Awaiting human approval (request: ${(policyDecision as { approvalRequestId: string }).approvalRequestId})`,
```

The `PolicyDecision` type is a proper discriminated union (`PolicyAllow | PolicyDeny | PolicyPending`) with the `decision` field as discriminant. TypeScript can narrow this automatically inside `if` blocks. The `as` casts suppress type checking entirely, meaning:
- If `PolicyDeny` is ever refactored to rename `reason` to `message`, these casts will silently produce `undefined` instead of a compile error.
- If a new decision type is added (e.g., `"ESCALATE"`), the code will fall through to the transaction execution block at line 109 with no type error.

**Impact:**
- A future policy decision type that is not `ALLOW`, `DENY`, or `PENDING` would bypass all guards and proceed directly to transaction building, signing, and broadcasting. This is a **policy bypass vector**.
- Refactoring the `PolicyDecision` types becomes unsafe because the compiler cannot catch mismatches in wallet.ts.
- The `?? "unknown"` fallback on line 68 masks situations where the rule name is genuinely missing, hiding bugs.

**Recommendation:**
1. Use TypeScript's discriminated union narrowing instead of `as` casts:
   ```typescript
   if (policyDecision.decision === "DENY") {
     const error: TransactionError = {
       code: "POLICY_DENIED",
       message: policyDecision.reason,    // TypeScript knows this is PolicyDeny
       policyRule: policyDecision.rule,    // TypeScript knows this is PolicyDeny
     };
     // ...
   }

   if (policyDecision.decision === "PENDING") {
     const result: TransactionResult = {
       status: "pending",
       summary: `Awaiting human approval (request: ${policyDecision.approvalRequestId})`,
       // ...
     };
     // ...
   }
   ```
2. Add an exhaustive check after the known decision types to catch unknown decisions at runtime:
   ```typescript
   // After DENY and PENDING checks, before the transaction block:
   if (policyDecision.decision !== "ALLOW") {
     throw new Error(`Unknown policy decision: ${(policyDecision as { decision: string }).decision}`);
   }
   ```
3. Alternatively, use a `switch` statement with an exhaustiveness check using `never`:
   ```typescript
   switch (policyDecision.decision) {
     case "DENY": /* ... */ return result;
     case "PENDING": /* ... */ return result;
     case "ALLOW": break;
     default: {
       const _exhaustive: never = policyDecision;
       throw new Error(`Unknown decision: ${(_exhaustive as { decision: string }).decision}`);
     }
   }
   ```

---

### S1-04 [HIGH]: Race Condition in Concurrent `execute()` Calls -- Policy-then-Act TOCTOU

**File:** `/Users/haythembalti/Documents/kova/src/core/wallet.ts`, lines 57-150

**Description:**
The `execute()` pipeline performs policy evaluation (line 63) and transaction execution (lines 109-127) as separate asynchronous steps with no mutual exclusion. If two `execute()` calls are in flight concurrently (which is possible via `Promise.all` or concurrent agent tool calls), both can pass policy evaluation before either has broadcast its transaction.

Consider this sequence with a $100/day spending limit:
1. Agent submits Intent A for $80 (at time T1)
2. Agent submits Intent B for $80 (at time T1 + 1ms)
3. `execute(A)` evaluates policy: $0 spent today, $80 < $100 limit --> ALLOW
4. `execute(B)` evaluates policy: $0 spent today (A hasn't been recorded yet), $80 < $100 limit --> ALLOW
5. Both transactions are broadcast: $160 spent, exceeding the $100 limit by 60%

This is a classic TOCTOU (Time-of-Check to Time-of-Use) race condition. The policy check and the state update (recording the spend) are not atomic.

**Impact:**
- Spending limits can be circumvented by submitting multiple transactions concurrently.
- Rate limits can be bypassed in the same manner.
- The severity escalates when real policy rules (Sprint 2) are implemented, because the race window exists in the `execute()` pipeline itself, not in the individual rules.

**Recommendation:**
1. Implement a per-wallet mutex/semaphore that serializes `execute()` calls:
   ```typescript
   import { Mutex } from 'async-mutex'; // or implement a simple one

   export class AgentWallet {
     private readonly executeMutex = new Mutex();

     async execute(intent: TransactionIntent): Promise<TransactionResult> {
       return this.executeMutex.runExclusive(() => this._executeInternal(intent));
     }

     private async _executeInternal(intent: TransactionIntent): Promise<TransactionResult> {
       // ... current execute() body
     }
   }
   ```
2. Alternatively, implement optimistic locking in the Store: have the spending limit rule use `increment()` atomically and check the result against the limit, rather than checking first and incrementing later.
3. Add a concurrency test that fires `Promise.all([wallet.execute(intentA), wallet.execute(intentB)])` and verifies that the combined spend does not exceed the policy limit.

---

### S1-05 [HIGH]: Audit Entry Records Policy Decision Object by Reference -- Mutable After Logging

**File:** `/Users/haythembalti/Documents/kova/src/core/wallet.ts`, lines 255-276

**Description:**
The `logAudit()` method constructs an `AuditEntry` using direct references to the `intent` and `finalDecision` objects:

```typescript
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
    intent,                    // <-- Direct reference, not a copy
    policyDecisions: ruleAudits,  // <-- Direct reference
    finalDecision,             // <-- Direct reference
    transactionResult: txResult,
  };
```

While the entry is immediately serialized to JSON via `this.logger.log(entry)` (which calls `JSON.stringify`), the serialization is inside a try/catch that swallows errors (S1-01). If serialization fails (e.g., due to circular references injected by a malicious rule implementation, or BigInt values), the mutable references could be modified after the "logging" attempt.

More importantly, the `intent` object passed to `logAudit()` is the same object reference used throughout `execute()`. The `normalizeIntent()` method uses spread (`{ ...intent }`), which is a shallow copy. If `intent.params` or `intent.metadata` contain nested objects that are later mutated (e.g., by a custom chain adapter), the audit entry would reflect the mutated state, not the original state at the time of logging.

**Impact:**
- Audit log entries could contain data that does not match the actual intent that was evaluated and executed.
- In a forensic investigation, tampered audit entries would undermine the integrity of the evidence.
- A malicious `PolicyRule` implementation could modify the intent object during evaluation, and the audit log would reflect the modified version.

**Recommendation:**
1. Deep-clone the intent before storing it in the audit entry:
   ```typescript
   const entry: AuditEntry = {
     timestamp: Date.now(),
     intentId: intent.id!,
     agentId: intent.metadata?.agentId,
     intent: structuredClone(intent),
     policyDecisions: structuredClone(ruleAudits),
     finalDecision: structuredClone(finalDecision),
     transactionResult: txResult ? { ...txResult } : undefined,
   };
   ```
2. Alternatively, serialize the entry eagerly (before the try/catch) so the JSON snapshot is captured at the correct moment.

---

### S1-06 [MEDIUM]: `getTransactionHistory()` Limit Parameter Not Validated -- Negative/Zero Values

**File:** `/Users/haythembalti/Documents/kova/src/core/wallet.ts`, line 179

**Description:**
The `getTransactionHistory()` method accepts a `limit` parameter with a default of 10 but performs no validation:

```typescript
async getTransactionHistory(limit: number = 10): Promise<TransactionResult[]> {
  const entries = await this.logger.getRecent(limit);
```

Passing `limit = -1`, `limit = 0`, `limit = Infinity`, `limit = NaN`, or `limit = 999999999` would be forwarded directly to `this.logger.getRecent()`, which delegates to `this.store.getRecent()`. The `MemoryStore.getRecent()` handles `count <= 0` by returning `[]`, but `Infinity` and `NaN` produce undefined behavior with `Array.slice()`. A very large limit could cause the store to load the entire audit log into memory.

**Impact:**
- A denial-of-service attack via an extremely large limit value could exhaust memory.
- `NaN` propagation could cause unexpected behavior in downstream code.
- Non-integer values (e.g., `3.7`) would produce unpredictable slicing behavior.

**Recommendation:**
```typescript
async getTransactionHistory(limit: number = 10): Promise<TransactionResult[]> {
  const sanitizedLimit = Math.max(1, Math.min(Math.floor(limit), 1000));
  if (!Number.isFinite(sanitizedLimit)) {
    throw new Error("Invalid limit parameter");
  }
  const entries = await this.logger.getRecent(sanitizedLimit);
  // ...
}
```

---

### S1-07 [MEDIUM]: Mock Adapter Always Succeeds -- Masks Critical Failure Modes

**File:** `/Users/haythembalti/Documents/kova/src/chains/solana/adapter.ts`, lines 42-103

**Description:**
All mock methods in `SolanaAdapter` return success unconditionally:
- `getBalance()` always returns `"10.0"` (line 45)
- `getValueInUSD()` always returns a valid number (line 57)
- `buildTransaction()` always succeeds (line 65)
- `broadcast()` always returns a mock tx ID (line 88)
- `getTransactionStatus()` always returns `"confirmed"` (line 97)

There is no way to test failure paths (insufficient balance, RPC timeout, transaction rejection, etc.) through the adapter itself. While the wallet test suite does test error cases by injecting mock chain adapters that throw, the `SolanaAdapter` class itself cannot produce errors.

**Impact:**
- When the mock adapter is replaced with real RPC calls in Sprint 3, multiple new failure modes will be introduced simultaneously, dramatically increasing risk.
- The `getBalance()` mock always returns `"10.0"`, meaning balance checks appear to succeed even when the real balance would be zero. If a pre-transaction balance check is added (which it should be), the mock will always pass it.
- The `getValueInUSD()` mock returns `0` for unknown tokens rather than throwing, meaning spending limits denominated in USD would evaluate unknown tokens as "free."
- The `getTransactionStatus()` mock always returns `"confirmed"`, which means any post-broadcast confirmation logic will never exercise the `"failed"` or `"not_found"` paths.

**Recommendation:**
1. Add a `MockSolanaAdapter` or configuration flags that allow injecting specific failure scenarios:
   ```typescript
   export interface SolanaAdapterConfig {
     rpcUrl: string;
     commitment?: "processed" | "confirmed" | "finalized";
     jupiterApiUrl?: string;
     // Sprint 1 mock controls
     mockConfig?: {
       shouldFailBroadcast?: boolean;
       mockBalance?: string;
       mockUsdPrice?: number;
       broadcastLatencyMs?: number;
     };
   }
   ```
2. Add a test suite that exercises each failure mode of the `ChainAdapter` interface.
3. Track each mock method as a Sprint 3 migration task with explicit security test requirements.

---

### S1-08 [MEDIUM]: `buildTransaction()` Serializes Full Intent Params into Mock Transaction Data

**File:** `/Users/haythembalti/Documents/kova/src/chains/solana/adapter.ts`, lines 65-82

**Description:**
The mock `buildTransaction()` method serializes the full intent into the unsigned transaction payload:

```typescript
async buildTransaction(
  intent: TransactionIntent,
  _signerAddress: string,
): Promise<UnsignedTransaction> {
  const mockPayload = JSON.stringify({
    type: intent.type,
    params: intent.params,  // <-- Full params including recipient, amount, token
    mock: true,
  });
  return {
    chain: "solana",
    data: encoder.encode(mockPayload),
    description: `Mock ${intent.type} transaction`,
  };
}
```

This means the "unsigned transaction" data is a plaintext JSON serialization of the intent. The signer then signs this JSON data, and the signed data is passed to `broadcast()`. The `broadcast()` method ignores its input entirely (line 88: `async broadcast(_signedTxData: Uint8Array)`).

**Impact:**
- This creates a false security model: code written against the mock adapter might assume the transaction data is opaque binary, but it is actually human-readable JSON that could be logged, intercepted, or inspected.
- When replaced with real Solana transaction serialization in Sprint 3, any code that depends on the mock format (e.g., parsing the transaction data) will silently break.
- The signer signs JSON text instead of actual Solana transaction bytes, which means signature verification tests are meaningless -- they verify that arbitrary bytes can be signed, not that valid Solana transactions are correctly signed.

**Recommendation:**
1. Generate mock data that structurally resembles real Solana transaction bytes (e.g., a fixed-length buffer with a version byte prefix) rather than serialized JSON.
2. Add a `mock: true` field to the `UnsignedTransaction` metadata (not the data payload) so downstream code can detect mock transactions if needed.
3. Ensure the Sprint 3 migration plan includes re-running all signer integration tests against real transaction formats.

---

### S1-09 [MEDIUM]: `normalizeIntent()` Does Not Validate or Sanitize Input Fields

**File:** `/Users/haythembalti/Documents/kova/src/core/wallet.ts`, lines 221-227

**Description:**
The `normalizeIntent()` method only assigns `id` and `createdAt` defaults. It performs no validation of any other fields:

```typescript
private normalizeIntent(intent: TransactionIntent): TransactionIntent {
  return {
    ...intent,
    id: intent.id ?? randomUUID(),
    createdAt: intent.createdAt ?? Date.now(),
  };
}
```

The following inputs are accepted without validation:
- `intent.type` could be any string (TypeScript's `IntentType` is only compile-time)
- `intent.chain` could be any string (e.g., `"ethereum"` when only Solana is configured)
- `intent.params.amount` could be `"-1.0"`, `"Infinity"`, `"NaN"`, `"0"`, or `"99999999999"`
- `intent.params.to` could be an invalid address, empty string, or an address on the wrong chain
- `intent.metadata.agentId` is self-reported and untrusted (Sprint 0 M-04, still unresolved)
- `intent.id` if user-provided, could be an empty string, extremely long, or contain injection characters

**Impact:**
- Negative amounts could confuse spending limit arithmetic (e.g., spending `-100 SOL` would decrease the daily spend counter, effectively granting more budget).
- Invalid addresses would only be caught at broadcast time (wasting gas/compute), or worse, could be valid addresses on a different chain.
- A malicious `agentId` could contain control characters or injection payloads that corrupt log displays or downstream integrations.
- The `chain` field is not validated against the configured chain adapter, so a Solana-configured wallet could accept intents targeting "ethereum."

**Recommendation:**
1. Add a `validateIntent()` step in `execute()` before policy evaluation:
   ```typescript
   private validateIntent(intent: TransactionIntent): void {
     if (intent.chain !== this.chain.chain) {
       throw new Error(`Chain mismatch: wallet is configured for ${this.chain.chain}, got ${intent.chain}`);
     }
     if (isTransferIntent(intent)) {
       const amount = parseFloat(intent.params.amount);
       if (!Number.isFinite(amount) || amount <= 0) {
         throw new Error(`Invalid transfer amount: ${intent.params.amount}`);
       }
       if (!this.chain.isValidAddress(intent.params.to)) {
         throw new Error(`Invalid recipient address: ${intent.params.to}`);
       }
     }
     // ... similar for other intent types
   }
   ```
2. Validate `intent.id` length and character set if user-provided (max 128 chars, alphanumeric + hyphens).
3. Sanitize `intent.metadata` fields to prevent injection attacks in log viewers.

---

### S1-10 [MEDIUM]: `getValueInUSD()` Returns 0 for Unknown Tokens -- Spending Limit Bypass

**File:** `/Users/haythembalti/Documents/kova/src/chains/solana/adapter.ts`, lines 56-59

**Description:**
The mock `getValueInUSD()` returns `0` for any token not in the hardcoded `MOCK_PRICES` map:

```typescript
async getValueInUSD(token: string, amount: string): Promise<number> {
  const price = MOCK_PRICES[token.toUpperCase()] ?? 0;
  return parseFloat(amount) * price;
}
```

When spending limit rules are implemented in Sprint 2, they will likely call `getValueInUSD()` to normalize different tokens into a common USD denomination for comparison against spending limits. A token with a price of `0` would be treated as "free," allowing unlimited transfers of that token.

**Impact:**
- An agent could bypass USD-denominated spending limits by using any token not in the mock price list.
- Even in the real implementation, a price feed outage or unsupported token would return 0, making this a persistent pattern risk.
- This could be exploited by creating intents for obscure tokens that have real value but are not in the price feed.

**Recommendation:**
1. Throw an error for unknown tokens rather than returning 0:
   ```typescript
   async getValueInUSD(token: string, amount: string): Promise<number> {
     const price = MOCK_PRICES[token.toUpperCase()];
     if (price === undefined) {
       throw new Error(`No price data available for token: ${token}`);
     }
     return parseFloat(amount) * price;
   }
   ```
2. In the spending limit rule implementation (Sprint 2), treat unknown token prices as DENY rather than allowing at $0.
3. Document the fail-closed principle: if the system cannot determine the value of a transaction, it should deny rather than assume zero cost.

---

### S1-11 [MEDIUM]: Audit Entries Lack Integrity Protection -- No Hash Chain or Signatures

**File:** `/Users/haythembalti/Documents/kova/src/logging/audit.ts`, lines 18-19

**Description:**
Audit entries are stored as plain JSON strings via `store.append()`:

```typescript
async log(entry: AuditEntry): Promise<void> {
  await this.store.append(this.storeKey, JSON.stringify(entry));
}
```

There is no integrity protection on stored audit entries. Anyone with write access to the store can:
- Delete entries (removing evidence of transactions)
- Modify entries (changing amounts, addresses, or policy decisions)
- Insert fabricated entries (creating false evidence)
- Reorder entries (disrupting chronological analysis)

The `getRecent()` method silently skips corrupted entries (line 29), which means deleted/corrupted entries simply disappear from history with no indication of tampering.

**Impact:**
- An attacker who gains access to the store backend can erase all evidence of unauthorized transactions.
- In a multi-agent system, one compromised agent could modify audit entries to frame another agent.
- The silent skip of corrupted entries (while good for availability) means tamper detection is impossible.
- This violates the immutability requirement for financial audit trails.

**Recommendation:**
1. Add a hash chain to link entries together, making deletion or insertion detectable:
   ```typescript
   async log(entry: AuditEntry): Promise<void> {
     const previousHash = await this.getLastEntryHash();
     const entryWithHash = {
       ...entry,
       previousHash,
       hash: this.computeHash(entry, previousHash),
     };
     await this.store.append(this.storeKey, JSON.stringify(entryWithHash));
   }
   ```
2. Add an HMAC using a server-side key to prevent modification of individual entries.
3. Add a `verifyIntegrity()` method that walks the hash chain and reports gaps or inconsistencies.
4. When `getRecent()` encounters a corrupted entry, log a security alert (not just skip silently).

---

### S1-12 [LOW]: `ruleAudits` Array in `execute()` Is Incomplete -- Only Records Final Decision

**File:** `/Users/haythembalti/Documents/kova/src/core/wallet.ts`, lines 66-73

**Description:**
The audit rule recording creates a single-element array based on the final policy decision:

```typescript
const ruleAudits: PolicyRuleAudit[] = [
  {
    rule: policyDecision.decision === "ALLOW" ? "all" : (policyDecision as { rule: string }).rule ?? "unknown",
    result: policyDecision.decision,
    reason: policyDecision.decision === "DENY" ? (policyDecision as { reason: string }).reason : undefined,
    evaluationTimeMs: 0,
  },
];
```

The `PolicyEngine.evaluate()` method iterates through multiple rules but only returns the final decision. The intermediate rule evaluations (rules that returned ALLOW before the final DENY, or all rules when the final decision is ALLOW) are lost. The audit log records only one entry with `evaluationTimeMs: 0` (hardcoded).

**Impact:**
- Security investigators cannot determine which rules were evaluated, which passed, and how long each took.
- Performance degradation in a specific rule would be invisible.
- If a rule that should have denied was incorrectly returning ALLOW, the audit trail would show only the final "ALLOW" with no per-rule breakdown.
- The `rule: "all"` string for ALLOW decisions provides no useful information.

**Recommendation:**
1. Modify `PolicyEngine.evaluate()` to return per-rule audit data alongside the final decision:
   ```typescript
   interface PolicyEvaluationResult {
     decision: PolicyDecision;
     ruleAudits: PolicyRuleAudit[];
     totalEvaluationTimeMs: number;
   }

   async evaluate(intent: TransactionIntent, now?: number): Promise<PolicyEvaluationResult> {
     const ruleAudits: PolicyRuleAudit[] = [];
     for (const rule of this.rules) {
       const start = performance.now();
       const decision = await rule.evaluate(intent, context);
       const elapsed = performance.now() - start;
       ruleAudits.push({
         rule: rule.name,
         result: decision.decision,
         reason: decision.decision === "DENY" ? decision.reason : undefined,
         evaluationTimeMs: elapsed,
       });
       if (decision.decision !== "ALLOW") {
         return { decision, ruleAudits, totalEvaluationTimeMs: /* sum */ };
       }
     }
     return { decision: { decision: "ALLOW" }, ruleAudits, totalEvaluationTimeMs: /* sum */ };
   }
   ```
2. Pass the full `ruleAudits` array to `logAudit()` instead of constructing a synthetic single-entry array.

---

### S1-13 [LOW]: `AuditLogger.getRecent()` Uses Unsafe `as AuditEntry` Cast

**File:** `/Users/haythembalti/Documents/kova/src/logging/audit.ts`, lines 23-34

**Description:**
The `getRecent()` method parses JSON and casts the result to `AuditEntry` without runtime validation:

```typescript
async getRecent(count: number = 10): Promise<AuditEntry[]> {
  const raw = await this.store.getRecent(this.storeKey, count);
  const entries: AuditEntry[] = [];
  for (const r of raw) {
    try {
      entries.push(JSON.parse(r) as AuditEntry);
    } catch {
      // Skip corrupted entries
    }
  }
  return entries;
}
```

The `JSON.parse(r) as AuditEntry` cast provides no runtime type safety. If the stored data is valid JSON but not a valid `AuditEntry` (e.g., `{"foo": "bar"}` or data from a different version of the schema), it will be returned as if it were a valid entry. Downstream code accessing `entry.intentId` or `entry.policyDecisions` would get `undefined` without any type error.

**Impact:**
- Schema migrations between versions would silently produce malformed entries.
- Store corruption (valid JSON but wrong schema) would not be detected.
- An attacker with store write access could inject entries with missing/falsified fields.

**Recommendation:**
1. Add a runtime type guard or validation function:
   ```typescript
   function isValidAuditEntry(obj: unknown): obj is AuditEntry {
     return (
       typeof obj === "object" && obj !== null &&
       "timestamp" in obj && typeof (obj as Record<string, unknown>).timestamp === "number" &&
       "intentId" in obj && typeof (obj as Record<string, unknown>).intentId === "string" &&
       "intent" in obj &&
       "policyDecisions" in obj && Array.isArray((obj as Record<string, unknown>).policyDecisions) &&
       "finalDecision" in obj
     );
   }
   ```
2. Use a schema validation library (e.g., Zod) for robust parsing.
3. Log a warning when an entry fails validation (not just when JSON.parse fails).

---

### S1-14 [LOW]: `getTransactionHistory()` Status Mapping Has Implicit Fallthrough to `"failed"`

**File:** `/Users/haythembalti/Documents/kova/src/core/wallet.ts`, lines 181-186

**Description:**
The status mapping in `getTransactionHistory()` uses a ternary chain with a final fallback to `"failed"`:

```typescript
status: entry.transactionResult?.status === "confirmed" ? "confirmed" as const :
  entry.finalDecision.decision === "DENY" ? "denied" as const :
  entry.finalDecision.decision === "PENDING" ? "pending" as const :
  "failed" as const,
```

This means any unrecognized combination of `transactionResult.status` and `finalDecision.decision` will be silently classified as `"failed"`. For example:
- An ALLOW decision with no transaction result (which happens when execution throws, line 147) correctly maps to "failed".
- But if a new status like `"processing"` is added to `transactionResult.status`, it would also map to "failed."

**Impact:**
- Future status values would be silently misclassified, potentially hiding pending or in-progress transactions from history.
- The agent calling `getTransactionHistory()` would see incorrect status information.

**Recommendation:**
1. Add explicit handling for each known state and throw/log for unknown states:
   ```typescript
   function mapAuditStatus(entry: AuditEntry): TransactionStatus {
     if (entry.transactionResult?.status === "confirmed") return "confirmed";
     if (entry.transactionResult?.status === "failed") return "failed";
     if (entry.finalDecision.decision === "DENY") return "denied";
     if (entry.finalDecision.decision === "PENDING") return "pending";
     if (entry.finalDecision.decision === "ALLOW" && !entry.transactionResult) return "failed";
     console.warn(`Unexpected audit entry state: decision=${entry.finalDecision.decision}, txStatus=${entry.transactionResult?.status}`);
     return "failed";
   }
   ```

---

### S1-15 [LOW]: `getTransactionHistory()` Summary Does Not Match `execute()` Summary

**File:** `/Users/haythembalti/Documents/kova/src/core/wallet.ts`, lines 187 vs 230-252

**Description:**
When `execute()` returns a result, the `summary` field uses the rich `buildSummary()` method (e.g., `"Sent 1.0 SOL to Reci...1234"`). However, `getTransactionHistory()` generates a different, simpler summary:

```typescript
summary: `${entry.intent.type} on ${entry.intent.chain}`,
```

This produces summaries like `"transfer on solana"` instead of `"Sent 1.0 SOL to Reci...1234"`. The information discrepancy means that the real-time result and the historical record show different descriptions for the same transaction.

**Impact:**
- Agents relying on `getTransactionHistory()` for context about past transactions get less useful information.
- Inconsistency between real-time and historical summaries could cause confusion in debugging.
- The audit log already stores the full intent, so the rich summary could be reconstructed.

**Recommendation:**
1. Either store the `summary` from `execute()` in the audit entry, or reuse the `buildSummary()` method in `getTransactionHistory()`:
   ```typescript
   return entries.map((entry) => ({
     // ... status mapping
     summary: this.buildSummary(entry.intent),  // Reuse rich summary
     intentId: entry.intentId,
     timestamp: entry.timestamp,
   }));
   ```
2. Alternatively, add a `summary` field to `AuditEntry` and populate it during `logAudit()`.

---

### S1-16 [INFO]: Sprint 0 C-01 Remediation Verified -- Policy Rule Stubs Now Fail Closed

**File:** `/Users/haythembalti/Documents/kova/src/policy/rules/spending-limit.ts`, line 19; `allowlist.ts`, line 26; `rate-limit.ts`, line 19

**Description:**
All policy rule stubs have been updated from `return { decision: "ALLOW" }` to:

```typescript
return { decision: "DENY", rule: this.name, reason: "SpendingLimitRule not yet implemented" };
```

This is a positive finding. The system now fails closed for unimplemented rules, meaning a misconfigured wallet that includes these stubs will deny all transactions rather than allowing them.

**Risk:** None -- this is a positive remediation verification.

**Recommendation:** Maintain this fail-closed pattern. When implementing real rules in Sprint 2, add integration tests that verify the transition from stub DENY to real evaluation logic.

---

### S1-17 [INFO]: Sprint 0 C-02 Remediation Verified -- Empty Rules Array Rejected

**File:** `/Users/haythembalti/Documents/kova/src/policy/engine.ts`, lines 18-21

**Description:**
The `PolicyEngine` constructor now throws when given an empty rules array:

```typescript
if (rules.length === 0) {
  throw new Error(
    "PolicyEngine requires at least one rule. An engine with no rules would allow all transactions unconditionally, violating the deny-by-default principle.",
  );
}
```

This is confirmed by the test at `engine.test.ts` line 24-28.

**Risk:** None -- this is a positive remediation verification.

**Recommendation:** Maintain this guard. The error message clearly communicates the security rationale.

---

### S1-18 [INFO]: `MemoryStore.increment()` Race Condition Fixed (Sprint 0 H-03)

**File:** `/Users/haythembalti/Documents/kova/src/stores/memory.ts`, lines 38-62

**Description:**
The `MemoryStore.increment()` method has been refactored to operate synchronously on the internal `Map` without any `await` calls between read and write:

```typescript
async increment(key: string, amount: number): Promise<number> {
  // Synchronous atomic operation -- no await between read and write
  const entry = this.data.get(key);
  let current = 0;
  let existingTtl: number | undefined;
  if (entry) {
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.data.delete(key);
    } else {
      const parsed = parseFloat(entry.value);
      current = isNaN(parsed) ? 0 : parsed;
      existingTtl = entry.expiresAt;
    }
  }
  const newValue = current + amount;
  const newEntry: StoreEntry = { value: String(newValue) };
  if (existingTtl) {
    newEntry.expiresAt = existingTtl;
  }
  this.data.set(key, newEntry);
  return newValue;
}
```

The TTL preservation is also correctly handled inline. However, note that `parseFloat` is still used for financial amounts (Sprint 0 M-01, still open).

**Risk:** The `MemoryStore`-level race is fixed, but the pipeline-level TOCTOU in `execute()` remains (see S1-04).

**Recommendation:** Track S1-04 for the remaining concurrency issue. The `MemoryStore` fix is sound for single-threaded Node.js.

---

## Summary Statistics

| Severity | Count | IDs |
|----------|-------|-----|
| CRITICAL | 1 | S1-01 |
| HIGH | 4 | S1-02, S1-03, S1-04, S1-05 |
| MEDIUM | 6 | S1-06, S1-07, S1-08, S1-09, S1-10, S1-11 |
| LOW | 4 | S1-12, S1-13, S1-14, S1-15 |
| INFO | 3 | S1-16, S1-17, S1-18 |
| **Total** | **18** | |

## Open Sprint 0 Findings Still Unresolved

The following Sprint 0 findings remain relevant in the Sprint 1 codebase:

| Sprint 0 ID | Status | Notes |
|-------------|--------|-------|
| C-03 | Open | `bigint-buffer` dependency vulnerability -- requires re-audit |
| H-01 | Open | `LocalSigner` private key in memory -- no `destroy()` method |
| H-02 | Open | `Signer` interface lacks chain validation |
| H-04 | Open | `Policy.fromJSON()` bypasses validation |
| H-05 | Open | `handleToolCall()` accepts unconstrained input (stub, not yet implemented) |
| M-01 | Open | `parseFloat` used for financial amounts |
| M-02 | Open | Spending limit hierarchical consistency not enforced |
| M-03 | Open | Allow/deny list precedence undefined |
| M-04 | Open | `agentId` optional and untrusted |
| M-08 | Open | Shallow copies in `toJSON()`/`getConfig()` |
| L-01 | Open | Rate limit config allows zero/negative values |
| L-02 | Open | Cooldown config not validated |
| L-03 | Open | Solana address validation regex-only |
| L-05 | Open | `maxSlippage` has no upper bound |
| I-04 | Open | `MemoryStore` lists have no size bounds |

## Recommended Priority for Remediation

1. **Immediately (Sprint 1 hotfix):**
   - S1-01: Add audit failure alerting and circuit breaker
   - S1-03: Replace `as` casts with proper discriminated union narrowing + exhaustive check

2. **Sprint 2 blockers:**
   - S1-02: Implement idempotency enforcement before spending limits are live
   - S1-04: Add execute mutex to prevent concurrent policy bypass
   - S1-09: Add intent validation (especially amount and address validation) before spending limit rules depend on these values

3. **Sprint 2 recommended:**
   - S1-05: Deep-clone audit entry data
   - S1-10: Fail closed on unknown token prices
   - S1-11: Begin audit log integrity protection design
   - S1-12: Return per-rule audit data from PolicyEngine

4. **Sprint 3 (adapter migration):**
   - S1-07: Replace mock adapter with configurable failure injection
   - S1-08: Generate structurally realistic mock transaction data

5. **Ongoing:**
   - S1-06, S1-13, S1-14, S1-15: Address alongside related feature work

---

*End of Sprint 1 security audit report.*
