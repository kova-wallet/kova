# Sprint 2 -- Security Audit Report

**Date:** 2026-02-11
**Auditor:** Security Engineer (Claude)
**Scope:** Policy engine rules (SpendingLimitRule, AllowlistRule, RateLimitRule, TimeWindowRule, ApprovalGateRule), security fixes (S1-02 idempotency, S1-04 execute mutex, S1-09 intent validation)

---

## Sprint 1 Remediation Status

Before detailing Sprint 2 findings, the following Sprint 1 findings were verified against the current codebase:

| Sprint 1 ID | Finding | Status |
|-------------|---------|--------|
| S1-02 | No idempotency enforcement -- intent replay attack | **FIXED** -- Idempotency cache implemented in `wallet.ts` lines 114-123 using `IDEMPOTENCY_PREFIX` + intent ID with 24-hour TTL |
| S1-03 | Unsafe `as` type assertions on PolicyDecision | **FIXED** -- `wallet.ts` lines 131-138 now uses proper discriminated union narrowing; `policyDecision.decision === "DENY"` is checked before accessing `.rule` and `.reason` |
| S1-04 | Race condition in concurrent `execute()` calls | **FIXED** -- Promise-based mutex implemented in `wallet.ts` lines 58-59, 94-106; `executeLock` serializes all `execute()` calls |
| S1-05 | Audit entry records objects by reference | **FIXED** -- `logAudit()` at lines 427-430 now uses `structuredClone()` on intent, policyDecisions, finalDecision, and transactionResult |
| S1-06 | `getTransactionHistory()` limit not validated | **FIXED** -- Lines 252-255 now validate with `Number.isFinite()`, clamp to `[1, 1000]`, and `Math.floor()` |
| S1-09 | `normalizeIntent()` does not validate input fields | **FIXED** -- New `validateIntent()` method at lines 297-355 validates type, chain, params structure, and type-specific fields |
| S1-01 | Silent audit log failure | **NOT FIXED** -- `logAudit()` at lines 433-437 still silently swallows errors. No circuit breaker or callback mechanism added |
| S1-12 | `ruleAudits` array only records final decision | **NOT FIXED** -- Lines 129-140 still construct a single-entry array from the final decision only |

---

## Summary

This audit covers the Sprint 2 implementation, which introduces five concrete policy rules (SpendingLimitRule, AllowlistRule, RateLimitRule, TimeWindowRule, ApprovalGateRule) and three security fixes addressing Sprint 1 findings S1-02, S1-04, and S1-09.

**Overall Assessment:** The Sprint 2 implementation represents a significant maturation of the security posture. The three remediations (idempotency, execute mutex, intent validation) are well-implemented and close important attack vectors identified in Sprint 1. The policy rules are structurally sound, follow fail-closed principles consistently, and demonstrate good defensive coding practices (e.g., invalid timezone causes denial, missing approval channel causes denial). However, several medium and high severity issues exist, primarily around: (1) spending limit bypass via cross-token manipulation, (2) TOCTOU race between policy check and counter increment within individual rules, (3) floating-point precision issues in financial calculations, (4) idempotency cache poisoning for denied transactions, and (5) allowlist bypass through case sensitivity and missing address normalization.

### Finding Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 1     |
| HIGH     | 4     |
| MEDIUM   | 7     |
| LOW      | 5     |
| INFO     | 4     |
| **Total** | **21** |

---

## Findings

---

### S2-01 [CRITICAL]: Spending Limit Bypass via Cross-Token Transfers -- No Cross-Currency Aggregation

**File:** `/Users/haythembalti/Documents/kova/src/policy/rules/spending-limit.ts`, lines 39-50, 91-107
**Lines:** 39-50 (per-transaction check), 91-107 (window limit check)

**Description:**
The SpendingLimitRule only enforces limits when the intent's token matches the configured limit token (case-insensitive). If the spending limit is configured for SOL, an agent can bypass it entirely by transferring USDC, wSOL, or any other token:

```typescript
// Line 40: Per-transaction check
if (token.toUpperCase() === this.config.perTransaction.token.toUpperCase()) {
  // ... only checked when tokens match
}

// Line 91: Window limit check
if (token.toUpperCase() !== limitConfig.token.toUpperCase()) {
  return null; // Different token, skip this limit <-- BYPASS
}
```

The `SpendingLimitConfig` type only supports a single `TokenAmount` per window (one token per limit), meaning there is no way to configure limits for multiple tokens simultaneously, nor is there any USD-normalization to aggregate spending across tokens.

Consider: An agent has a daily limit of 10 SOL. It transfers 1000 USDC (worth ~7 SOL) -- the spending limit rule returns `null` for the window check because `"USDC" !== "SOL"`, and the per-transaction check is similarly skipped. The agent can drain the entire wallet of non-SOL tokens with zero enforcement.

**Risk:** Complete spending limit bypass for any token not matching the configured limit token. In a wallet holding multiple tokens, an agent can freely transfer all tokens except the one the limit is configured for.

**Recommendation:**
1. Support an array of `TokenAmount` entries per window to cover multiple tokens:
   ```typescript
   export interface SpendingLimitConfig {
     perTransaction?: TokenAmount[];
     daily?: TokenAmount[];
     weekly?: TokenAmount[];
     monthly?: TokenAmount[];
   }
   ```
2. Add a USD-denominated aggregate limit that normalizes all tokens via a price oracle before comparison. This requires integrating with `ChainAdapter.getValueInUSD()` or similar.
3. As an immediate mitigation, adopt a **fail-closed** posture: if a token is not in the configured limit set, DENY the transaction rather than skipping the check. This aligns with the project's stated deny-by-default principle:
   ```typescript
   if (token.toUpperCase() !== limitConfig.token.toUpperCase()) {
     return {
       decision: "DENY",
       rule: this.name,
       reason: `Token ${token} is not covered by spending limit policy (only ${limitConfig.token} is configured)`,
     };
   }
   ```

---

### S2-02 [HIGH]: TOCTOU Race in Spending Limit -- Check-Then-Increment Is Not Atomic

**File:** `/Users/haythembalti/Documents/kova/src/policy/rules/spending-limit.ts`, lines 53-77
**Lines:** 53-77 (check windows then increment)

**Description:**
While the S1-04 execute mutex serializes `execute()` calls, the SpendingLimitRule's evaluate method performs a non-atomic check-then-act pattern: it checks the current spend (lines 53-74), and only increments counters (line 77) after all checks pass. The counter increment is inside `evaluate()`, not after the actual transaction broadcast.

The execute mutex in `wallet.ts` serializes full `execute()` calls, which should protect this in a single-process deployment. However, the architectural concern is:

1. **Multi-process deployment:** If two wallet instances share a Redis-backed store (a planned migration path), the in-process mutex provides no protection. Two processes can both read the current spend, both pass the limit check, and both increment -- exceeding the limit.

2. **Counter increment on evaluation, not on success:** The spending counter is incremented during `evaluate()` (line 77), not after the transaction is confirmed on-chain. If the transaction fails at the build, sign, or broadcast step (lines 178-200 in wallet.ts), the budget is consumed but no money actually moved. Over time, failed transactions will eat into the spending budget, causing legitimate transactions to be denied.

```typescript
// Lines 76-79: Counters are incremented BEFORE the transaction is broadcast
await this.incrementCounters(context, amount, token);
return { decision: "ALLOW" };
// ... transaction might fail at build/sign/broadcast
```

**Risk:** In multi-process deployments, spending limits can be exceeded via concurrent requests. In single-process deployments, failed transactions permanently reduce available budget.

**Recommendation:**
1. Implement optimistic increment: use `store.increment()` atomically and check the result against the limit, rather than separate check-then-increment:
   ```typescript
   const newTotal = await context.store.increment(key, amount);
   if (newTotal > limit) {
     // Roll back
     await context.store.increment(key, -amount);
     return { decision: "DENY", ... };
   }
   ```
2. Add a rollback mechanism: if the transaction fails at the broadcast stage, decrement the spending counters. This could be a callback passed through the policy context or a two-phase commit pattern.
3. Document that the execute mutex is a single-process guarantee only, and that multi-process deployments require a distributed lock (e.g., Redis SETNX).

---

### S2-03 [HIGH]: Idempotency Cache Poisons Denied Transactions -- Denied Intent IDs Become Permanently Blocked

**File:** `/Users/haythembalti/Documents/kova/src/core/wallet.ts`, lines 143-161
**Lines:** 143-161 (DENY branch caches result)

**Description:**
The idempotency implementation caches ALL transaction results, including denied ones:

```typescript
// Line 159: Denied result is cached
if (policyDecision.decision === "DENY") {
  // ...
  await this.cacheResult(idempotencyKey, result);  // <-- Caches the denial
  return result;
}
```

This means that if an intent with ID `"abc-123"` is first submitted with an amount that exceeds the spending limit and is denied, the denial result is cached for 24 hours. If the agent later resubmits the same intent ID after the spending window has reset (or after the limit is increased), the cached denial is returned without re-evaluating the policy:

```typescript
// Lines 116-123: Returns cached result without policy re-evaluation
const cachedResult = await this.store.get(idempotencyKey);
if (cachedResult !== null) {
  try {
    return JSON.parse(cachedResult) as TransactionResult;  // <-- Returns stale denial
  } catch { }
}
```

More dangerously, a "pending" status is also cached (line 173). If an approval request times out and the result is cached as `"pending"`, the agent can never retry that intent ID -- it will always get the stale "pending" result.

**Risk:** Denied and pending results are permanently cached (for 24 hours), preventing legitimate retries with the same intent ID. This creates a denial-of-service vector: an attacker who can predict or influence intent IDs can "poison" them by triggering denials under conditions they control, blocking future legitimate use.

**Recommendation:**
1. Only cache successful (confirmed) results for idempotency. Denied and pending results should not be cached, as they are transient states:
   ```typescript
   // Only cache confirmed transactions
   if (result.status === "confirmed") {
     await this.cacheResult(idempotencyKey, result);
   }
   ```
2. If caching denials is desired to prevent retry storms, use a much shorter TTL (e.g., 60 seconds) for denied/pending results vs. 24 hours for confirmed results.
3. Add the ability to invalidate/retry a specific intent ID through a dedicated method.

---

### S2-04 [HIGH]: AllowlistRule Address Comparison Is Case-Sensitive -- Bypass via Case Variation

**File:** `/Users/haythembalti/Documents/kova/src/policy/rules/allowlist.ts`, lines 31-36, 46-61
**Lines:** 31-36 (constructor stores addresses as-is), 46-61 (comparison uses `Set.has()`)

**Description:**
The AllowlistRule stores addresses in Sets without any normalization:

```typescript
constructor(config: AllowlistConfig) {
  this.allowAddresses = new Set(config.allowAddresses ?? []);  // No normalization
  this.denyAddresses = new Set(config.denyAddresses ?? []);    // No normalization
  // ...
}
```

And compares using `Set.has()`, which is case-sensitive:

```typescript
if (targetAddress && this.denyAddresses.has(targetAddress)) {  // Case-sensitive!
```

On Ethereum and Base (EIP-55 chains), addresses are hex-encoded and case carries checksum information but the same address can be represented in all-lowercase, all-uppercase, or mixed-case. For example:
- `0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B` (checksummed)
- `0xab5801a7d398351b8be11c439e05c5b3259aec9b` (lowercase)
- `0xAB5801A7D398351B8BE11C439E05C5B3259AEC9B` (uppercase)

All three represent the same address. An agent can bypass the denylist by submitting the address in a different case than the one stored in the deny set. Similarly, if the allowlist contains the checksummed form, a lowercase form would be denied even though it is the same address.

On Solana, base58 addresses are case-sensitive, so this is less of a concern -- but the code does not distinguish chains.

**Risk:** On EVM chains (Ethereum, Base), the entire allowlist/denylist can be bypassed by submitting addresses in a different case encoding.

**Recommendation:**
1. Normalize all addresses to a canonical form in the constructor:
   ```typescript
   constructor(config: AllowlistConfig) {
     this.allowAddresses = new Set(
       (config.allowAddresses ?? []).map(a => a.toLowerCase())
     );
     this.denyAddresses = new Set(
       (config.denyAddresses ?? []).map(a => a.toLowerCase())
     );
     // ...
   }
   ```
2. Normalize the extracted target address before comparison:
   ```typescript
   const targetAddress = this.extractTargetAddress(intent)?.toLowerCase();
   ```
3. Ideally, apply chain-specific normalization (e.g., EIP-55 checksum for EVM, no change for Solana). This could be injected via a normalizer function in the config.

---

### S2-05 [HIGH]: Rate Limit Counter Increment on Approval Gate Timeout Creates Budget Exhaustion

**File:** `/Users/haythembalti/Documents/kova/src/policy/engine.ts`, lines 39-44
**Lines:** 39-44 (sequential rule evaluation)

**Description:**
The PolicyEngine evaluates rules sequentially and stops at the first non-ALLOW decision. Rules that return ALLOW before a later rule returns DENY have already incremented their counters. Specifically, the RateLimitRule and SpendingLimitRule both increment counters inside `evaluate()` when they return ALLOW:

```typescript
// rate-limit.ts line 59: Increments on ALLOW
await this.incrementCounters(context);
return { decision: "ALLOW" };

// spending-limit.ts line 77: Increments on ALLOW
await this.incrementCounters(context, amount, token);
return { decision: "ALLOW" };
```

If the rule evaluation order is: RateLimit -> SpendingLimit -> ApprovalGate, and the ApprovalGate times out or rejects, then:
1. RateLimitRule evaluated and returned ALLOW -- counter incremented
2. SpendingLimitRule evaluated and returned ALLOW -- counter incremented
3. ApprovalGateRule evaluated and returned DENY (timeout/rejection)

The transaction is denied, but the rate limit and spending counters have already been consumed. Over time, a stream of approval-rejected transactions will exhaust both the rate limit and spending budget.

This also applies to TimeWindowRule -- if time-window check passes but a later rule denies, the earlier counters are already consumed.

**Risk:** Repeated approval-denied transactions drain rate limit and spending limit budgets without any actual transactions occurring, creating an effective denial-of-service on the wallet.

**Recommendation:**
1. Implement a two-phase evaluation: first evaluate all rules without side effects (read-only check), then commit all counters only when the final decision is ALLOW:
   ```typescript
   // Phase 1: Check (read-only)
   for (const rule of this.rules) {
     const decision = await rule.check(intent, context);
     if (decision.decision !== "ALLOW") return decision;
   }
   // Phase 2: Commit (increment counters)
   for (const rule of this.rules) {
     await rule.commit?.(intent, context);
   }
   return { decision: "ALLOW" };
   ```
2. Alternatively, add a `rollback()` method to stateful rules and invoke it when a later rule denies.
3. As a minimum fix, reorder rules so ApprovalGateRule and TimeWindowRule (non-stateful) are evaluated before SpendingLimitRule and RateLimitRule (stateful).

---

### S2-06 [MEDIUM]: Floating-Point Precision in Spending Limit Arithmetic

**File:** `/Users/haythembalti/Documents/kova/src/policy/rules/spending-limit.ts`, lines 41, 95, 99, 121, 141, 157
**Lines:** Multiple

**Description:**
All amount handling in the spending limit rule uses `parseFloat()` and standard JavaScript floating-point arithmetic:

```typescript
const limit = parseFloat(this.config.perTransaction.amount);  // Line 41
const limit = parseFloat(limitConfig.amount);                  // Line 95
if (currentSpent + amount > limit) {                           // Line 99 -- floating-point addition
const parsed = parseFloat(value);                              // Line 141
const parsed = parseFloat(params.amount);                      // Line 157
```

JavaScript uses IEEE 754 double-precision floats, which cannot precisely represent many decimal values. For example:
- `0.1 + 0.2 === 0.30000000000000004` (not `0.3`)
- After 10 transactions of 0.1 SOL: `10 * 0.1 === 0.9999999999999999` (not `1.0`)

This means:
- A 1.0 SOL daily limit might allow 10 transactions of 0.1 SOL (total `0.999...`) plus one more 0.1 transaction because `0.999... + 0.1 = 1.099... > 1.0` -- or might not, depending on accumulation order.
- An attacker can exploit precision boundaries to get one extra transaction through by choosing amounts that accumulate favorably.
- The cumulative error grows with the number of transactions, making daily/weekly/monthly limits progressively less accurate.

**Risk:** Financial calculations using floating-point can allow spending limits to be exceeded by small amounts, or conversely, deny legitimate transactions slightly below the limit. The risk increases with transaction volume.

**Recommendation:**
1. Use integer arithmetic with a fixed decimal multiplier (e.g., multiply all amounts by 1e9 to work in lamports/smallest units):
   ```typescript
   private parseAmount(amount: string, decimals: number = 9): bigint {
     const [whole, frac = ""] = amount.split(".");
     const padded = frac.padEnd(decimals, "0").slice(0, decimals);
     return BigInt(whole + padded);
   }
   ```
2. Alternatively, use a decimal arithmetic library (e.g., `decimal.js`, `bignumber.js`).
3. At minimum, add an epsilon tolerance to comparisons:
   ```typescript
   const EPSILON = 1e-10;
   if (currentSpent + amount > limit + EPSILON) { // deny }
   ```
   (Note: the epsilon approach is a band-aid and does not fully solve the problem.)

---

### S2-07 [MEDIUM]: AllowlistRule Allows Intents With No Extractable Address -- Fail-Open

**File:** `/Users/haythembalti/Documents/kova/src/policy/rules/allowlist.ts`, lines 46-61, 85-108
**Lines:** 46-61 (checks guarded by `if (targetAddress && ...)`)

**Description:**
The AllowlistRule extracts the target address and program ID from the intent params. If extraction returns `null`, all checks are skipped and the rule returns ALLOW:

```typescript
const targetAddress = this.extractTargetAddress(intent);  // Could be null
const programId = this.extractProgramId(intent);          // Could be null

// Line 46: Check only runs if targetAddress is truthy
if (targetAddress && this.denyAddresses.has(targetAddress)) { ... }

// Line 55: Check only runs if targetAddress is truthy
if (targetAddress && this.hasAllowAddresses && !this.allowAddresses.has(targetAddress)) { ... }
```

If an agent crafts an intent where the target address is stored in an unexpected field (not `to`, `programId`, `collection`, or `validator`), `extractTargetAddress()` returns `null`, and the allowlist check is entirely bypassed. For example, a custom intent could use an `accounts` array where the target is in account entries rather than in `programId` -- the AllowlistRule would return ALLOW regardless of whether those accounts are denylisted.

Additionally, the `extractProgramId()` method only checks custom intents (line 114: `if (intent.type === "custom"`), meaning program ID checks are not applied to non-custom intent types even if they interact with programs.

**Risk:** The allowlist can be bypassed by constructing intents that store the target address in non-standard fields, or by using custom intents where the target is in the `accounts` array rather than `programId`.

**Recommendation:**
1. When an allowlist is configured (allow or deny) and no address can be extracted, fail closed:
   ```typescript
   if (!targetAddress && (this.hasAllowAddresses || this.denyAddresses.size > 0)) {
     return {
       decision: "DENY",
       rule: this.name,
       reason: "Cannot extract target address from intent for allowlist evaluation",
     };
   }
   ```
2. For custom intents, also check all addresses in the `accounts` array against the allow/deny lists.
3. Extend `extractTargetAddress()` to cover more parameter shapes, including nested account arrays.

---

### S2-08 [MEDIUM]: Rate Limit Keys Are Not Scoped per Agent or per Wallet

**File:** `/Users/haythembalti/Documents/kova/src/policy/rules/rate-limit.ts`, lines 14, 32-33
**Lines:** 14 (KEY_PREFIX), 32-33 (key construction)

**Description:**
Rate limit counter keys are constructed as simple global strings:

```typescript
const KEY_PREFIX = "ratelimit:";
const key = `${KEY_PREFIX}minute`;  // "ratelimit:minute"
const key = `${KEY_PREFIX}hour`;    // "ratelimit:hour"
```

If multiple `AgentWallet` instances share the same store (a supported pattern per the architecture), they share the same rate limit counters. Agent A's transactions count against Agent B's rate limit, and vice versa. An attacker controlling Agent A could exhaust the rate limit counter, denying Agent B the ability to transact (cross-agent DoS).

The same issue applies to the SpendingLimitRule keys:
```typescript
const KEY_PREFIX = "spending:";
const key = `${KEY_PREFIX}daily:${upperToken}`;  // "spending:daily:SOL"
```

**Risk:** In multi-agent deployments sharing a store, one agent's activity counts against all agents' rate limits and spending limits, enabling cross-agent denial-of-service.

**Recommendation:**
1. Scope all store keys by wallet/agent identifier:
   ```typescript
   const key = `${KEY_PREFIX}${context.walletId}:minute`;
   ```
2. Add a `walletId` or `agentId` field to `PolicyContext` that uniquely identifies the wallet instance.
3. At minimum, document that separate wallets must use separate store instances to maintain rate limit isolation.

---

### S2-09 [MEDIUM]: TimeWindowRule `parseTimeToMinutes()` Does Not Validate Input Format

**File:** `/Users/haythembalti/Documents/kova/src/policy/rules/time-window.ts`, lines 108-111
**Lines:** 108-111

**Description:**
The `parseTimeToMinutes()` method splits on `:` and converts to numbers without validation:

```typescript
private parseTimeToMinutes(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours! * 60 + minutes!;
}
```

If `time` is malformed (e.g., `"25:70"`, `"abc"`, `""`, `"9"` without minutes, `"-1:30"`), the result could be:
- `"25:70"` -> `25 * 60 + 70 = 1570` (beyond a day's 1440 minutes)
- `"abc"` -> `NaN * 60 + NaN = NaN`
- `""` -> `NaN * 60 + NaN = NaN`
- `"9"` -> `9 * 60 + undefined = NaN`

NaN comparisons in `isWithinActiveHours()` at lines 93-99 would always evaluate to `false`, which would cause the rule to deny (fail-closed). However, extreme values like `1570` would create windows that extend beyond midnight in unexpected ways, potentially allowing transactions outside intended hours.

**Risk:** Malformed time configurations could create incorrect time windows that either permanently deny (NaN case, fail-closed -- acceptable) or extend beyond intended hours (extreme value case -- security issue).

**Recommendation:**
1. Validate time format in the constructor:
   ```typescript
   private validateTime(time: string): void {
     const match = time.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
     if (!match) {
       throw new Error(`Invalid time format: "${time}". Expected "HH:MM" (00:00 to 23:59)`);
     }
   }
   ```
2. Validate in `parseTimeToMinutes()` and return a safe default or throw if invalid.
3. Validate the entire `ActiveHoursConfig` in the constructor, including that `windows` is non-empty and all day strings are valid.

---

### S2-10 [MEDIUM]: ApprovalGateRule Allows Custom Intents Without Amount -- Approval Bypass

**File:** `/Users/haythembalti/Documents/kova/src/policy/rules/approval-gate.ts`, lines 28-33
**Lines:** 28-33

**Description:**
The ApprovalGateRule allows intents through if no amount can be extracted:

```typescript
async evaluate(intent: TransactionIntent, context: PolicyContext): Promise<PolicyDecision> {
  const amount = this.extractAmount(intent);
  if (amount === null) {
    return { decision: "ALLOW" };  // <-- No amount = no approval needed
  }
```

Custom intents (type `"custom"`) typically do not have an `amount` field in their params -- they have `programId`, `data`, and `accounts`. This means custom intents bypass the approval gate entirely, regardless of what they actually do. A custom intent could invoke an on-chain program that transfers tokens, drains accounts, or performs any arbitrary operation -- all without requiring human approval.

Similarly, mint intents without an `amount` field bypass approval. While minting might not directly transfer tokens, it could have financial implications (mint fees, royalties).

**Risk:** Any intent type that does not include a standard `amount` field bypasses the approval gate, even if the intent performs high-value on-chain operations.

**Recommendation:**
1. Add a configurable policy for intents without amounts:
   ```typescript
   export interface ApprovalGateConfig {
     above: TokenAmount;
     noAmountPolicy?: "allow" | "deny" | "require_approval";  // default: "require_approval"
     // ...
   }
   ```
2. Default to requiring approval for unquantifiable intents:
   ```typescript
   if (amount === null) {
     if (this.config.noAmountPolicy === "allow") {
       return { decision: "ALLOW" };
     }
     return {
       decision: "DENY",
       rule: this.name,
       reason: "Cannot determine transaction value for approval evaluation",
     };
   }
   ```
3. For custom intents specifically, always require approval since their on-chain behavior is opaque to the policy engine.

---

### S2-11 [MEDIUM]: Execute Mutex Implementation Leaks Promise Chain -- Unbounded Memory Growth

**File:** `/Users/haythembalti/Documents/kova/src/core/wallet.ts`, lines 58-59, 94-106
**Lines:** 94-106

**Description:**
The mutex is implemented as a linked promise chain:

```typescript
private executeLock: Promise<void> = Promise.resolve();

async execute(intent: TransactionIntent): Promise<TransactionResult> {
  // ...
  let releaseLock: () => void;
  const previousLock = this.executeLock;
  this.executeLock = new Promise<void>((resolve) => { releaseLock = resolve; });

  await previousLock;
  // ...
}
```

Each `execute()` call creates a new Promise and chains it to the previous one. The `releaseLock` closure captures the resolve function, and the `previousLock` reference creates a chain. While JavaScript's garbage collector should clean up resolved promises, the pattern has a subtle issue: if `executeInternal()` throws an exception that is not caught by the try/finally (unlikely given the current code but possible if the finally block itself throws), `releaseLock!()` would never be called, permanently blocking all future `execute()` calls -- a deadlock.

Additionally, if `execute()` is called many times concurrently (e.g., an agent fires 10,000 requests), 10,000 promises are chained. While each individually is small, the chain creates a deep reference graph that may delay garbage collection.

**Risk:** If the finally block fails to execute (unlikely but possible via engine-level errors), the wallet permanently deadlocks. High concurrency could cause temporary memory pressure.

**Recommendation:**
1. Add a safety timeout to the lock acquisition:
   ```typescript
   const lockTimeout = Promise.race([
     previousLock,
     new Promise<void>((_, reject) =>
       setTimeout(() => reject(new Error("Execute lock timeout")), 30_000)
     ),
   ]);
   await lockTimeout;
   ```
2. Consider using an established mutex library (e.g., `async-mutex`) that handles edge cases around deadlocks and cancellation.
3. Add a catch in the finally to ensure the lock is always released:
   ```typescript
   } finally {
     try { releaseLock!(); } catch { /* ensure release */ }
   }
   ```

---

### S2-12 [MEDIUM]: Spending Limit `ensureKeyWithTTL()` Has Race Condition Between Check and Set

**File:** `/Users/haythembalti/Documents/kova/src/policy/rules/spending-limit.ts`, lines 146-151
**Lines:** 146-151

**Description:**
The `ensureKeyWithTTL()` method checks if a key exists and creates it if not:

```typescript
private async ensureKeyWithTTL(context: PolicyContext, key: string, ttl: number): Promise<void> {
  const existing = await context.store.get(key);  // Read
  if (existing === null) {
    await context.store.set(key, "0", ttl);        // Write (with fresh TTL)
  }
}
```

This is called before every `increment()` to ensure the key exists with a TTL. However, there is a race condition: if the key expires between the `get()` call and the `increment()` call (a small but nonzero window), the `increment()` will create a new key without a TTL (per MemoryStore's increment behavior at line 57-58, which only preserves `existingTtl` if it was present).

More importantly, the same race exists in `RateLimitRule.ensureKeyWithTTL()` (lines 88-92) with identical code.

In the MemoryStore, `increment()` creates a key without TTL if the key does not exist (line 56-60). So if a key expires between `ensureKeyWithTTL()` and `increment()`, the counter resets to the amount but has no TTL, meaning it will never expire. Accumulated spend would persist indefinitely, permanently reducing the available budget.

**Risk:** Under rare timing conditions, spending or rate limit counters can lose their TTL and persist indefinitely, causing permanent denial of transactions.

**Recommendation:**
1. Make `increment()` accept an optional TTL parameter for atomic increment-with-ttl:
   ```typescript
   increment(key: string, amount: number, ttlSeconds?: number): Promise<number>;
   ```
2. In `MemoryStore.increment()`, if the key does not exist and a TTL is provided, set the TTL on the new entry.
3. Alternatively, always set TTL in `increment()` rather than relying on a separate `ensureKeyWithTTL()` call.

---

### S2-13 [LOW]: Spending Limit `extractAmount()` Accepts Negative and Zero Amounts

**File:** `/Users/haythembalti/Documents/kova/src/policy/rules/spending-limit.ts`, lines 154-161
**Lines:** 154-161

**Description:**
The `extractAmount()` method parses the amount without validating that it is positive:

```typescript
private extractAmount(intent: TransactionIntent): number | null {
  const params = intent.params as unknown as Record<string, unknown>;
  if ("amount" in params && typeof params.amount === "string") {
    const parsed = parseFloat(params.amount);
    return isNaN(parsed) ? null : parsed;  // Accepts negative values
  }
  return null;
}
```

While the `wallet.ts` `validateIntent()` method now validates that amounts are positive (lines 319-320), this defense-in-depth gap means that if `validateIntent()` is ever bypassed or relaxed, a negative amount would cause `incrementCounters()` to decrement the spending counter, effectively increasing the agent's remaining budget.

The same issue exists in `ApprovalGateRule.extractAmount()` (lines 114-119) and the `RateLimitRule` does not have this issue (it uses fixed increment of 1).

**Risk:** Low due to upstream validation in wallet.ts. If the validation layer is bypassed, negative amounts would decrease spending counters, granting additional budget.

**Recommendation:**
1. Add defense-in-depth validation in each rule:
   ```typescript
   const parsed = parseFloat(params.amount);
   return (isNaN(parsed) || parsed <= 0) ? null : parsed;
   ```
2. Apply the same fix to `ApprovalGateRule.extractAmount()`.

---

### S2-14 [LOW]: SpendingLimitRule `extractToken()` Returns "UNKNOWN" for Missing Tokens

**File:** `/Users/haythembalti/Documents/kova/src/policy/rules/spending-limit.ts`, lines 164-173
**Lines:** 164-173

**Description:**
If neither `token` nor `fromToken` is found in the intent params, `extractToken()` returns `"UNKNOWN"`:

```typescript
private extractToken(intent: TransactionIntent): string {
  // ...
  return "UNKNOWN";
}
```

Since the spending limit checks compare `token.toUpperCase() === limitConfig.token.toUpperCase()`, the "UNKNOWN" token will never match any configured limit, causing all checks to be skipped and the transaction to be allowed without enforcement. This is the same bypass vector as S2-01 but triggered by a missing token field rather than a different token.

**Risk:** Low due to upstream validation, but represents an additional dimension of the spending limit bypass.

**Recommendation:**
1. If token cannot be determined, fail closed:
   ```typescript
   private extractToken(intent: TransactionIntent): string | null {
     // ...
     return null;
   }
   // In evaluate():
   if (token === null) {
     return { decision: "DENY", rule: this.name, reason: "Cannot determine token for spending limit evaluation" };
   }
   ```

---

### S2-15 [LOW]: Intent Validation Does Not Validate `intent.id` Format or Length

**File:** `/Users/haythembalti/Documents/kova/src/core/wallet.ts`, lines 297-355
**Lines:** 297-355 (validateIntent method)

**Description:**
The `validateIntent()` method validates type, chain, and params but does not validate the `intent.id` field. A user-provided ID is used as a store key (`idempotency:${intentId}`) without any length or character validation:

```typescript
const idempotencyKey = `${IDEMPOTENCY_PREFIX}${intentId}`;
```

A malicious agent could provide an extremely long `id` (e.g., 10 MB string) that would:
1. Consume excessive memory when stored as a key in MemoryStore
2. Cause performance degradation in key lookups
3. Potentially crash the process if the store backend has key-length limits

Additionally, special characters in the ID (newlines, null bytes, colons) could conflict with the store's key scheme or cause injection issues if the store backend is Redis (where newlines are protocol-significant).

**Risk:** Denial of service via excessively long intent IDs; potential key injection in external store backends.

**Recommendation:**
1. Validate `intent.id` in `validateIntent()`:
   ```typescript
   if (intent.id !== undefined) {
     if (typeof intent.id !== "string" || intent.id.length === 0 || intent.id.length > 128) {
       return "Intent ID must be a string between 1 and 128 characters";
     }
     if (!/^[a-zA-Z0-9\-_]+$/.test(intent.id)) {
       return "Intent ID contains invalid characters (allowed: alphanumeric, hyphens, underscores)";
     }
   }
   ```

---

### S2-16 [LOW]: Idempotency Cache Uses `JSON.parse()` with Unsafe `as` Cast

**File:** `/Users/haythembalti/Documents/kova/src/core/wallet.ts`, lines 118-119
**Lines:** 118-119

**Description:**
The cached result is deserialized with `JSON.parse()` and cast to `TransactionResult` without validation:

```typescript
return JSON.parse(cachedResult) as TransactionResult;
```

If the store is shared with other systems, or if a store entry is corrupted (valid JSON but wrong schema), this cast will silently return an object that does not conform to `TransactionResult`. The caller (an AI agent) would receive a malformed response with potentially missing fields like `status`, `summary`, or `intentId`.

**Risk:** Low -- requires store corruption or shared-store key collision. Could cause unexpected behavior in agent code consuming the result.

**Recommendation:**
1. Validate the parsed object before returning:
   ```typescript
   const parsed = JSON.parse(cachedResult);
   if (parsed && typeof parsed.status === "string" && typeof parsed.intentId === "string") {
     return parsed as TransactionResult;
   }
   // Invalid cached data -- proceed with fresh execution
   ```

---

### S2-17 [LOW]: TimeWindowRule `require_approval` Mode Returns DENY Instead of PENDING

**File:** `/Users/haythembalti/Documents/kova/src/policy/rules/time-window.ts`, lines 39-44
**Lines:** 39-44

**Description:**
When `outsideHoursPolicy` is set to `"require_approval"`, the TimeWindowRule returns a DENY decision rather than a PENDING decision:

```typescript
if (this.config.outsideHoursPolicy === "require_approval") {
  return {
    decision: "DENY",              // <-- Should be "PENDING" or trigger approval flow
    rule: this.name,
    reason: "Transaction requires approval outside active hours",
  };
}
```

The `PolicyDecision` type supports a `PENDING` decision with an `approvalRequestId` field, which the ApprovalGateRule uses. The TimeWindowRule's `require_approval` mode should either delegate to an approval channel (similar to ApprovalGateRule) or return a PENDING decision. Currently, it denies the transaction outright, making the `require_approval` config option functionally identical to `deny`.

**Risk:** The `require_approval` configuration option does not function as documented. Operators who configure this expecting approval flow will get outright denial instead.

**Recommendation:**
1. Either integrate with the approval channel from `PolicyContext`:
   ```typescript
   if (this.config.outsideHoursPolicy === "require_approval") {
     if (!context.approval) {
       return { decision: "DENY", rule: this.name, reason: "..." };
     }
     const result = await context.approval.requestApproval({ ... });
     // Handle approval/rejection/timeout
   }
   ```
2. Or return a PENDING decision so the wallet can handle it:
   ```typescript
   return {
     decision: "PENDING",
     rule: this.name,
     approvalRequestId: crypto.randomUUID(),
   };
   ```
3. Or remove the `require_approval` option if it is not going to be implemented, to avoid misleading configuration.

---

### S2-18 [INFO]: S1-02 Idempotency Fix Verified -- Implemented and Functional

**File:** `/Users/haythembalti/Documents/kova/src/core/wallet.ts`, lines 25-28, 114-123, 357-364

**Description:**
The idempotency mechanism is implemented with:
- A 24-hour TTL (`IDEMPOTENCY_TTL = 86_400`)
- Store key prefix `"idempotency:"`
- Cache check before policy evaluation (line 116)
- Cache write after result generation (lines 159, 173, 199, 218)
- Graceful fallback on corrupted cache entries (line 120)
- Silent failure on cache write errors (line 361-363)

The implementation correctly returns cached results for duplicate intent IDs and uses `JSON.stringify`/`JSON.parse` for serialization. The silent failure on cache write (line 361-363) is acceptable since the primary transaction should not be blocked by a cache write failure.

**Risk:** None -- this is a positive remediation verification. See S2-03 for a related finding about caching denied results.

---

### S2-19 [INFO]: S1-04 Execute Mutex Fix Verified -- Implemented and Functional

**File:** `/Users/haythembalti/Documents/kova/src/core/wallet.ts`, lines 58-59, 94-106

**Description:**
The execute mutex is implemented using a promise-chaining pattern:
- `executeLock` is initialized to `Promise.resolve()` (immediately resolved)
- Each `execute()` call creates a new Promise, saves the current lock as `previousLock`, and sets the new Promise as the current lock
- The caller awaits `previousLock` before proceeding
- The lock is released in a `finally` block

This effectively serializes all `execute()` calls in FIFO order within a single process. The implementation is correct for single-process Node.js deployments.

**Risk:** None -- this is a positive remediation verification. See S2-11 for edge cases.

---

### S2-20 [INFO]: S1-09 Intent Validation Fix Verified -- Comprehensive and Well-Structured

**File:** `/Users/haythembalti/Documents/kova/src/core/wallet.ts`, lines 297-355

**Description:**
The `validateIntent()` method validates:
- Intent is a non-null object (line 298)
- Type is one of the valid intent types (line 302)
- Chain is one of the valid chain IDs (line 306)
- Params is a non-null object (line 310)
- Transfer-specific: `to` is non-empty string, `amount` is positive number string, `token` is non-empty string
- Swap-specific: `fromToken`, `toToken`, `amount` validated
- Mint-specific: `collection`, `metadataUri` validated
- Stake-specific: `amount` is positive number string, `token` is non-empty string
- Custom-specific: `programId` non-empty, `data` is string, `accounts` is array

Validation runs before the mutex acquisition (line 80), which is correct -- invalid intents should be rejected quickly without holding the lock.

**Risk:** None -- this is a positive remediation verification.

---

### S2-21 [INFO]: Policy Engine Maintains Correct Evaluation Order and Fail-Closed Behavior

**File:** `/Users/haythembalti/Documents/kova/src/policy/engine.ts`, lines 32-47

**Description:**
The PolicyEngine evaluates rules sequentially, stops at the first non-ALLOW decision, and requires at least one rule (constructor guard at line 18). The design is intentionally simple and correct:
- No parallelism that could cause ordering issues
- DENY and PENDING short-circuit immediately
- Only returns ALLOW after all rules have explicitly allowed

The engine also provides `getRuleNames()` for introspection. The `now` parameter is injectable for deterministic testing of TimeWindowRule.

**Risk:** None -- this is a positive observation. See S2-05 for the counter-increment timing issue.

---

## Positive Observations

1. **Consistent fail-closed design:** All five rules and the engine follow the fail-closed principle. Invalid timezones deny (TimeWindowRule), missing approval channels deny (ApprovalGateRule), and the engine requires at least one rule. This is a strong security posture.

2. **Good separation of concerns:** Each rule is self-contained with its own configuration type, store keys, and extraction logic. The PolicyContext cleanly injects dependencies.

3. **Correct use of `structuredClone()` for audit entries:** The S1-05 fix prevents mutable references from corrupting the audit trail.

4. **Validation before mutex:** The `validateIntent()` call happens before acquiring the execute lock (line 80), meaning invalid requests are rejected quickly without serialization overhead.

5. **TTL-based expiration for spending counters:** Using TTL-based counters with lazy expiration is a reasonable approach for time-windowed spending limits, avoiding the complexity of sliding-window implementations.

6. **ApprovalGateRule fails closed on channel errors:** The try/catch at lines 82-89 returns DENY on any approval channel exception, which is the correct security-first behavior.

7. **AllowlistRule deny-takes-precedence order:** The evaluation order (deny before allow) is correct and well-documented in the class comment.

8. **RateLimitRule uses integer counting:** Unlike spending limits, rate limit counters use `parseInt()` with fixed `+1` increments, avoiding floating-point issues.

9. **Idempotency cache has bounded TTL:** The 24-hour TTL prevents unbounded storage growth from cached results.

10. **Intent validation covers all five intent types:** Each type has specific field validation with clear error messages that help agents understand what went wrong.

---

## Sprint 0/1 Findings Still Unresolved

| Prior ID | Status | Notes |
|----------|--------|-------|
| S1-01 | Open | Silent audit log failure -- no circuit breaker added |
| S1-07 | Open | Mock adapter always succeeds (Sprint 3 scope) |
| S1-08 | Open | Mock adapter serializes intent to tx data (Sprint 3 scope) |
| S1-10 | Open | `getValueInUSD()` returns 0 for unknown tokens (Sprint 3 scope) |
| S1-11 | Open | Audit entries lack integrity protection |
| S1-12 | Open | ruleAudits only records final decision, not per-rule breakdown |
| S1-13 | Open | `AuditLogger.getRecent()` uses unsafe `as` cast |

---

## Conclusion

Sprint 2 delivers five well-structured policy rules and three important security fixes. The remediation of S1-02 (idempotency), S1-04 (execute mutex), and S1-09 (intent validation) significantly improves the security baseline. The policy rules demonstrate consistent fail-closed behavior and clean separation of concerns.

The most significant finding is **S2-01 (CRITICAL): the spending limit bypass via cross-token transfers**, which allows an agent to circumvent spending limits entirely by using any token other than the one the limit is configured for. This should be addressed before production deployment.

The four HIGH findings (S2-02 through S2-05) represent defense-in-depth gaps in the spending limit counter atomicity, idempotency cache poisoning of denied transactions, allowlist case-sensitivity bypass on EVM chains, and rate limit counter consumption on later-denied transactions. These should be addressed in Sprint 3.

The MEDIUM findings cover floating-point precision, fail-open behavior on unextractable addresses, global rate limit keys, time format validation, approval bypass for custom intents, mutex memory concerns, and TTL race conditions. These represent incremental improvements to an already-solid foundation.

### Recommended Priority for Remediation

1. **Immediately (Sprint 2 hotfix):**
   - S2-01: Add fail-closed behavior for uncovered tokens in spending limits
   - S2-04: Normalize addresses for case-insensitive comparison in AllowlistRule

2. **Sprint 3 blockers:**
   - S2-02: Implement atomic increment-then-check for spending counters
   - S2-03: Only cache confirmed results for idempotency (not denials/pending)
   - S2-05: Reorder rules or implement two-phase evaluation to prevent counter consumption on denied transactions

3. **Sprint 3 recommended:**
   - S2-06: Migrate to integer arithmetic for financial amounts
   - S2-07: Fail closed when allowlist address cannot be extracted
   - S2-08: Scope store keys by wallet/agent ID
   - S2-10: Require approval for custom intents with unknown amounts

4. **Ongoing:**
   - S2-09, S2-11, S2-12, S2-13, S2-14, S2-15, S2-16, S2-17: Address alongside related feature work

---

*End of Sprint 2 security audit report.*
