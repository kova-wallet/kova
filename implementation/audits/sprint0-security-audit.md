# Sprint 0 Security Audit Report

**Project:** kova -- Policy-Constrained Crypto Wallet SDK for AI Agents
**Sprint:** 0 (Bootstrap -- Interfaces, Stubs, and Core Scaffolding)
**Auditor:** Senior Cybersecurity Engineer
**Date:** 2026-02-11
**Scope:** All source files under `src/`, `package.json`, `tsconfig.json`, and dependency tree
**Total Files Reviewed:** 35 TypeScript source files, 5 test files, 2 config files

---

## Summary

This audit covers the Sprint 0 codebase of kova, which establishes the foundational interfaces, type definitions, stub implementations, and the first two real implementations (`MemoryStore` and `LocalSigner`). The Policy Builder includes validation logic that is also fully implemented.

**Overall Assessment:** The architectural design is sound for a Sprint 0 bootstrap. The separation of concerns (signer, store, policy engine, chain adapter) is appropriate. However, several design-level vulnerabilities and implementation issues were identified that, if left unaddressed in subsequent sprints, could lead to critical security failures including policy bypass, key leakage, and spending limit circumvention.

### Finding Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 3     |
| HIGH     | 6     |
| MEDIUM   | 8     |
| LOW      | 5     |
| INFO     | 4     |
| **Total** | **26** |

---

## Findings

---

### [CRITICAL] C-01: All Policy Rule Stubs Return `ALLOW` -- Fail-Open by Default

**File:** `src/policy/rules/spending-limit.ts`, `src/policy/rules/allowlist.ts`, `src/policy/rules/rate-limit.ts`, `src/policy/rules/time-window.ts`, `src/policy/rules/approval-gate.ts`

**Description:**
Every stub implementation of a `PolicyRule` returns `{ decision: "ALLOW" }` unconditionally. If any Sprint 1+ code is shipped that depends on these rules before their real implementation is completed, all transactions will be approved regardless of configured policy constraints. This is a classic **fail-open** anti-pattern.

For example, in `spending-limit.ts`:
```typescript
async evaluate(_intent: TransactionIntent, _context: PolicyContext): Promise<PolicyDecision> {
  // Stub -- will be implemented in Sprint 2
  return { decision: "ALLOW" };
}
```

**Risk:**
If the `execute()` method in `AgentWallet` is implemented (Sprint 1) before the policy rules are implemented (Sprint 2), there will be a window where the policy engine exists but provides zero protection. An agent could drain the wallet with no constraints.

**Recommendation:**
1. Change all policy rule stubs to return `{ decision: "DENY", rule: "<name>", reason: "Rule not yet implemented" }` so the system fails closed.
2. Add a runtime guard in `PolicyEngine.evaluate()` that rejects intents if any configured rule has not been fully implemented (e.g., via an `isImplemented` flag on the `PolicyRule` interface).
3. Alternatively, throw an error from stubs rather than returning ALLOW, similar to the approach taken in `AgentWallet.execute()`.

---

### [CRITICAL] C-02: `PolicyEngine` Allows Empty Rules Array -- No-Policy Bypass

**File:** `src/policy/engine.ts` (lines 17, 27-42)

**Description:**
The `PolicyEngine` constructor accepts an empty rules array without warning or error. When `evaluate()` is called with zero rules, it immediately returns `{ decision: "ALLOW" }`. This means a misconfigured or default-constructed engine provides no protection whatsoever.

```typescript
constructor(rules: PolicyRule[], store: Store, approval?: ApprovalChannel) {
  this.rules = rules;  // No validation -- empty array silently accepted
}

async evaluate(intent: TransactionIntent, now?: number): Promise<PolicyDecision> {
  // ... loops over rules, but if rules is empty, falls through to:
  return { decision: "ALLOW" };
}
```

This is confirmed by the test: `"should ALLOW when no rules are configured"`.

**Risk:**
A developer could accidentally create an `AgentWallet` with an empty policy engine, giving the AI agent unconstrained wallet access. This is especially dangerous because the `PolicyEngine` constructor does not require any minimum set of rules.

**Recommendation:**
1. Add a minimum-rules validation in the `PolicyEngine` constructor. At minimum, require at least one rule, or log a loud warning.
2. Consider requiring a mandatory "default deny" rule as the last rule in the chain.
3. Add a `strict` mode flag that requires at minimum a spending limit and rate limit rule.

---

### [CRITICAL] C-03: Known High-Severity Vulnerability in Dependency Chain (`bigint-buffer` Buffer Overflow)

**File:** `package.json` (dependency: `@solana/spl-token@^0.4.14`)

**Description:**
`npm audit` reveals 3 high-severity vulnerabilities rooted in `bigint-buffer`, which is vulnerable to a buffer overflow via the `toBigIntLE()` function ([GHSA-3gc7-fjrx-p6mg](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg)). The dependency chain is:

```
@solana/spl-token -> @solana/buffer-layout-utils -> bigint-buffer (VULNERABLE)
```

**Risk:**
A buffer overflow in a dependency used for token operations could lead to memory corruption, denial of service, or in worst cases, code execution. Since this library handles blockchain transaction data, corrupted buffers could result in malformed transactions.

**Recommendation:**
1. Investigate if `@solana/spl-token` v0.5.x or a later version has removed the `bigint-buffer` dependency.
2. If no upstream fix exists, consider using `npm audit fix --force` with thorough regression testing, or use `overrides` in `package.json` to pin a patched version.
3. Track this as a release blocker before any production deployment.

---

### [HIGH] H-01: `LocalSigner` Holds Private Key in Memory with No Protection

**File:** `src/signers/local.ts` (lines 9-14)

**Description:**
The `LocalSigner` stores the Solana `Keypair` (which includes the full 64-byte secret key) as a plain class field. There is no memory protection, no ability to zero out the key when done, and the keypair persists in memory for the entire lifetime of the process.

```typescript
export class LocalSigner implements Signer {
  private readonly keypair: Keypair;

  constructor(keypair: Keypair) {
    this.keypair = keypair;
  }
}
```

**Risk:**
- Memory dumps, heap snapshots, or core dumps will contain the private key in plaintext.
- The key cannot be zeroed out after use -- JavaScript does not provide reliable memory scrubbing.
- If the process is compromised, the private key is trivially extractable.

**Recommendation:**
1. Document clearly that `LocalSigner` is for **development/testing only** and must not be used in production.
2. Add a `destroy()` method that at minimum nullifies the reference and sets an internal flag that prevents further signing.
3. For production, enforce use of `MPCSigner` or an HSM-backed signer.
4. Consider accepting the secret key as a `Uint8Array` rather than a `Keypair`, so it can be overwritten with zeros after the `Keypair` is constructed (though V8 GC makes this unreliable).

---

### [HIGH] H-02: `Signer` Interface Lacks Chain Validation at the Interface Level

**File:** `src/signers/interface.ts`

**Description:**
The `Signer` interface defines `sign(transaction: UnsignedTransaction): Promise<SignedTransaction>` but has no mechanism to declare which chains the signer supports. The `UnsignedTransaction` includes a `chain` field, but it is typed as `string` (not `ChainId`), and there is no interface-level contract guaranteeing the signer will validate the chain.

The `LocalSigner` does validate at runtime (`if (transaction.chain !== "solana")`), but this is an implementation detail, not an interface guarantee.

**Risk:**
A signer implementation could silently accept a transaction for a chain it does not support, potentially signing garbage data that could be interpreted differently on another chain.

**Recommendation:**
1. Add a `supportedChains: readonly ChainId[]` property to the `Signer` interface.
2. Change the `chain` field in `UnsignedTransaction` from `string` to `ChainId`.
3. Add a `supportsChain(chain: ChainId): boolean` method to the `Signer` interface.
4. Have the `AgentWallet.execute()` method validate chain compatibility before signing.

---

### [HIGH] H-03: `Store.increment()` Is Not Truly Atomic Under Concurrent Access

**File:** `src/stores/interface.ts` (line 14), `src/stores/memory.ts` (lines 38-52)

**Description:**
The `Store` interface documents `increment` as "Atomically increment a numeric value." However, the `MemoryStore` implementation is not atomic:

```typescript
async increment(key: string, amount: number): Promise<number> {
  const existing = await this.get(key);      // Step 1: Read
  const current = existing ? parseFloat(existing) : 0;
  const newValue = current + amount;          // Step 2: Compute
  const entry = this.data.get(key);
  await this.set(key, String(newValue));      // Step 3: Write
  // ...
}
```

Although JavaScript is single-threaded, the `async/await` boundaries create potential interleaving points when multiple concurrent calls are made (e.g., via `Promise.all`). Between the `await this.get(key)` and `await this.set(key, ...)`, another `increment` call could read the stale value. This is a classic TOCTOU (Time-of-Check-to-Time-of-Use) race condition.

**Risk:**
If a spending limit rule calls `increment` to track spending and two transactions are submitted concurrently, the second transaction could read the pre-increment value of the first, effectively allowing double the spending limit. This directly enables spending limit circumvention.

**Recommendation:**
1. Make `MemoryStore.increment()` synchronous internally since there is no I/O -- remove the `await` calls and operate directly on the `Map`:
   ```typescript
   async increment(key: string, amount: number): Promise<number> {
     const entry = this.data.get(key);
     const current = entry && (!entry.expiresAt || Date.now() <= entry.expiresAt)
       ? parseFloat(entry.value) : 0;
     const newValue = current + amount;
     this.data.set(key, { value: String(newValue), expiresAt: entry?.expiresAt });
     return newValue;
   }
   ```
2. For `SqliteStore`, use `UPDATE ... SET value = value + ? WHERE key = ?` to ensure database-level atomicity.
3. Add concurrency tests that exercise `Promise.all([store.increment(...), store.increment(...)])` and verify correctness.

---

### [HIGH] H-04: `Policy.fromJSON()` Bypasses All Validation

**File:** `src/policy/builder.ts` (lines 28-30)

**Description:**
`Policy.fromJSON()` constructs a `Policy` object directly from a `PolicyConfig` without running any validation:

```typescript
static fromJSON(json: PolicyConfig): Policy {
  return new Policy({ ...json });
}
```

This bypasses all the validation logic in `PolicyBuilder.validate()`, including checks for valid amounts, time formats, and required fields.

**Risk:**
A malformed policy loaded from storage, a configuration file, or an API response could contain invalid spending limits (e.g., `amount: "0"`, `amount: "-999"`, `amount: "Infinity"`), invalid time windows, or missing required fields. This could cause policy rules to fail open or behave unpredictably at evaluation time.

**Recommendation:**
1. Run the same validation logic on JSON-loaded policies. Extract `validate()` as a static method and call it from `fromJSON()`.
2. Alternatively, have `fromJSON()` internally route through the builder to ensure all validation is applied.
3. Add schema validation (e.g., using Zod) for the `PolicyConfig` type to provide runtime type safety.

---

### [HIGH] H-05: `handleToolCall()` Accepts Unconstrained `Record<string, unknown>` Input

**File:** `src/core/wallet.ts` (line 93)

**Description:**
The `handleToolCall` method signature accepts arbitrary untyped input:

```typescript
async handleToolCall(_name: string, _input: Record<string, unknown>): Promise<unknown>
```

Both the `_name` and `_input` parameters have no validation or type narrowing. When implemented, this is the primary attack surface for AI agents interacting with the wallet.

**Risk:**
An AI agent (or a compromised agent) could pass:
- Unexpected tool names to invoke internal methods.
- Malformed inputs designed to bypass policy checks (e.g., injecting extra fields, type confusion attacks).
- Extremely large inputs to cause denial of service.

**Recommendation:**
1. Define a strict union type for valid tool names.
2. Use runtime validation (Zod, io-ts, or similar) to parse and validate `_input` against expected schemas for each tool name.
3. Add input size limits.
4. Ensure the return type is narrowed from `unknown` to `ToolCallResult`.

---

### [HIGH] H-06: No Idempotency Protection on `TransactionIntent`

**File:** `src/core/intent.ts` (lines 74-87)

**Description:**
The `TransactionIntent.id` field is optional (`id?: string`), and there is no mechanism to prevent the same intent from being evaluated and executed multiple times:

```typescript
export interface TransactionIntent {
  id?: string;          // Optional -- could be undefined
  type: IntentType;
  chain: ChainId;
  params: IntentParams;
  metadata?: IntentMetadata;
  createdAt?: number;   // Also optional
}
```

**Risk:**
An AI agent could replay the same transaction intent multiple times, either intentionally or due to retry logic. Without mandatory idempotency keys, the system has no way to detect duplicates. Combined with the spending limit race condition (H-03), this could be used to drain funds rapidly.

**Recommendation:**
1. Make `id` a required field (not optional).
2. Auto-generate a UUID in the `AgentWallet.execute()` method if not provided.
3. Store processed intent IDs in the `Store` and reject duplicates.
4. Make `createdAt` required as well, for accurate time-window-based policy evaluation.

---

### [MEDIUM] M-01: `MemoryStore.increment()` Uses `parseFloat` for Financial Amounts

**File:** `src/stores/memory.ts` (line 40)

**Description:**
The `increment` method uses `parseFloat` to convert stored string values to numbers:

```typescript
const current = existing ? parseFloat(existing) : 0;
const newValue = current + amount;
```

IEEE 754 floating-point arithmetic is notoriously imprecise for financial calculations. For example: `0.1 + 0.2 === 0.30000000000000004`.

**Risk:**
Accumulated floating-point drift in spending counters could cause incorrect spending limit enforcement. Over many small transactions, the stored total could diverge from the true total, potentially allowing slightly more spending than the configured limit.

**Recommendation:**
1. Use fixed-point arithmetic internally. Store amounts as integers representing the smallest unit (e.g., lamports for SOL).
2. Alternatively, use a library like `decimal.js` or `bignumber.js` for arbitrary-precision arithmetic.
3. At minimum, document the precision limitations and add rounding logic.

---

### [MEDIUM] M-02: `SpendingLimitConfig` Does Not Enforce Hierarchical Consistency

**File:** `src/policy/types.ts` (lines 57-62), `src/policy/builder.ts` (lines 145-158)

**Description:**
The spending limit configuration allows `perTransaction`, `daily`, `weekly`, and `monthly` limits to be set independently. The validation only checks that individual amounts are positive numbers. There is no check that:
- `perTransaction <= daily <= weekly <= monthly`
- All limits use the same token
- At least one limit tier is configured when `spendingLimit` is set

```typescript
export interface SpendingLimitConfig {
  perTransaction?: TokenAmount;
  daily?: TokenAmount;
  weekly?: TokenAmount;
  monthly?: TokenAmount;
}
```

**Risk:**
A misconfigured policy could have `perTransaction: 100 SOL` with `daily: 10 SOL`, creating contradictory constraints that could behave unpredictably. Mixed tokens across tiers (e.g., daily limit in SOL but weekly in USDC) could lead to comparison errors in the spending limit rule implementation.

**Recommendation:**
1. Add validation that `perTransaction <= daily <= weekly <= monthly` when multiple tiers are set.
2. Validate that all configured tiers use the same token, or explicitly support cross-token limits with USD normalization.
3. Require at least one tier when `spendingLimit` is set.

---

### [MEDIUM] M-03: `PolicyConfig` Has Conflicting Allow/Deny Lists with No Precedence Definition

**File:** `src/policy/types.ts` (lines 99-110)

**Description:**
`PolicyConfig` supports both `allowAddresses` and `denyAddresses` (similarly for programs):

```typescript
export interface PolicyConfig {
  // ...
  allowAddresses?: string[];
  denyAddresses?: string[];
  allowPrograms?: string[];
  denyPrograms?: string[];
  // ...
}
```

There is no documented or enforced precedence rule for what happens when the same address appears in both lists, or whether `allowAddresses` is an exclusive allowlist (deny all others) or a supplemental allowlist.

**Risk:**
Ambiguous semantics could lead to implementation bugs where an address on the deny list is still allowed because it also appears on the allow list, or vice versa. Different developers implementing the allowlist rule might interpret the semantics differently.

**Recommendation:**
1. Document the precedence clearly: typically deny takes precedence over allow.
2. Add validation that rejects configurations where the same address appears in both allow and deny lists.
3. Document whether setting `allowAddresses` creates an exclusive allowlist (all addresses not on the list are denied) or just a priority list.
4. Consider a single list with explicit `allow`/`deny` actions per entry for clarity.

---

### [MEDIUM] M-04: `IntentMetadata.agentId` Is Optional and Untrusted

**File:** `src/core/intent.ts` (lines 63-72)

**Description:**
The `agentId` in `IntentMetadata` is an optional, self-reported string:

```typescript
export interface IntentMetadata {
  reason?: string;
  agentId?: string;
  taskId?: string;
  urgency?: "low" | "normal" | "high";
}
```

There is no mechanism to authenticate or validate the `agentId`. An AI agent could claim to be any agent, or omit the field entirely.

**Risk:**
Per-agent rate limiting, spending limits, or audit attribution would be unreliable. A compromised agent could spoof another agent's ID to consume its budget, or omit the agent ID to evade per-agent tracking.

**Recommendation:**
1. Make `agentId` required (not optional) on `TransactionIntent` itself, not just metadata.
2. Implement agent authentication -- the `AgentWallet` should assign and verify agent IDs, not accept self-reported values.
3. Consider adding an API key or token-based authentication for agents.

---

### [MEDIUM] M-05: `LocalSigner.sign()` Silently Falls Back on Deserialization Failure

**File:** `src/signers/local.ts` (lines 29-40)

**Description:**
The `sign()` method first tries to deserialize as a `VersionedTransaction`, and if that throws, falls back to `Transaction.from()`:

```typescript
try {
  const versionedTx = VersionedTransaction.deserialize(transaction.data);
  versionedTx.sign([this.keypair]);
  // ...
} catch {
  const legacyTx = Transaction.from(transaction.data);
  legacyTx.sign(this.keypair);
  // ...
}
```

The catch block is bare -- it catches **all** exceptions, not just deserialization errors. If the versioned transaction deserializes successfully but signing fails (e.g., due to corrupted data), the error is silently swallowed and the code attempts legacy deserialization of the same data.

**Risk:**
- A genuine signing error could be masked, leading to signing of unintended data via the legacy path.
- If both paths fail, only the legacy error is thrown, obscuring the root cause.

**Recommendation:**
1. Narrow the catch clause to only catch deserialization-specific errors.
2. Log the first error before attempting fallback.
3. Consider detecting the transaction version explicitly (e.g., by checking the first byte) rather than relying on try/catch control flow.

---

### [MEDIUM] M-06: `LocalSigner.sign()` Returns Empty Signature on Missing Signature

**File:** `src/signers/local.ts` (lines 33, 39)

**Description:**
After signing, the code uses a nullish coalescing fallback to an empty `Uint8Array`:

```typescript
signature = versionedTx.signatures[0] ?? new Uint8Array();
// and
signature = legacyTx.signature ?? new Uint8Array();
```

If for any reason the signing operation does not produce a signature (which would indicate a bug or data corruption), the code returns an empty byte array as the signature rather than throwing an error.

**Risk:**
A transaction with an empty/invalid signature would fail on-chain, but the SDK would report it as "signed successfully." Downstream code might broadcast this invalid transaction, wasting fees and confusing error handling.

**Recommendation:**
1. Throw an explicit error if the signature is null, undefined, or zero-length after signing.
2. Add a post-signing validation step that verifies the signature is the expected length (64 bytes for Ed25519 on Solana).

---

### [MEDIUM] M-07: `MemoryStore` Lazy TTL Expiration Allows Stale Reads on `increment`

**File:** `src/stores/memory.ts` (lines 38-52)

**Description:**
The `increment()` method calls `this.get(key)` which performs lazy TTL expiration. If the key has expired, `get()` deletes it and returns `null`, causing `increment` to start from 0. However, there is a subtle bug: after calling `get()`, the code then calls `this.data.get(key)` again at line 43 to retrieve the TTL information:

```typescript
async increment(key: string, amount: number): Promise<number> {
  const existing = await this.get(key);       // May delete expired entry
  const current = existing ? parseFloat(existing) : 0;
  const newValue = current + amount;
  const entry = this.data.get(key);           // Entry was deleted -- this returns undefined
  await this.set(key, String(newValue));      // Creates new entry with NO TTL
  if (entry?.expiresAt) {                     // entry is undefined, so TTL is lost
    // ...
  }
  return newValue;
}
```

When a key has expired, `get()` deletes it. The subsequent `this.data.get(key)` returns `undefined`, so the TTL is not preserved on the new entry. This means spending counters that rely on TTL-based rolling windows (e.g., "daily limit resets every 24 hours") will lose their TTL after the first increment following expiry.

**Risk:**
This is actually the correct behavior for expired keys (start fresh). However, for **non-expired** keys, the TTL preservation logic has a different issue: the `await this.set(key, String(newValue))` at line 44 creates a **new** entry without TTL, and then line 46-49 patches the TTL back. Between these two lines, a concurrent read would see the value without a TTL.

**Recommendation:**
1. Refactor `increment()` to not go through `get()` and `set()` -- operate on the internal `Map` directly in a single synchronous operation.
2. This eliminates both the TTL race and the atomicity issue from H-03.

---

### [MEDIUM] M-08: `toJSON()` / `getConfig()` Perform Shallow Copies Only

**File:** `src/policy/builder.ts` (lines 40-42, 49-52)

**Description:**
Both `toJSON()` and `getConfig()` return shallow copies of the config:

```typescript
toJSON(): PolicyConfig {
  return { ...this.config };  // Shallow copy
}
```

Nested objects (arrays like `allowAddresses`, objects like `spendingLimit`) are shared by reference. A caller can mutate the returned config and affect the internal state of the `Policy` object.

**Risk:**
A malicious or careless consumer could modify a policy's internal configuration after construction, bypassing the builder's validation. For example: `policy.getConfig().spendingLimit!.daily!.amount = "999999"`.

**Recommendation:**
1. Use `structuredClone()` (available in Node 18+) for deep copying.
2. Alternatively, use `JSON.parse(JSON.stringify(this.config))` as a deep copy mechanism.
3. Consider using `Object.freeze()` recursively on the config to prevent mutation.

---

### [LOW] L-01: `RateLimitConfig` Does Not Validate for Zero or Negative Values

**File:** `src/policy/types.ts` (lines 65-68), `src/policy/builder.ts` (lines 98-101)

**Description:**
The `PolicyBuilder.rateLimit()` method stores the config without validation:

```typescript
rateLimit(config: RateLimitConfig): this {
  this.config.rateLimit = config;
  return this;
}
```

A rate limit of `{ maxTransactionsPerMinute: 0 }` or `{ maxTransactionsPerMinute: -1 }` would be accepted.

**Risk:**
A zero or negative rate limit could cause unexpected behavior in the rate limit rule implementation -- either blocking all transactions or having no effect depending on the comparison logic.

**Recommendation:**
1. Add validation in `PolicyBuilder.validate()` that rate limit values are positive integers.
2. Validate that at least one of `maxTransactionsPerMinute` or `maxTransactionsPerHour` is set when rate limiting is configured.

---

### [LOW] L-02: `CooldownConfig` Is Not Validated in `PolicyBuilder.validate()`

**File:** `src/policy/builder.ts` (lines 127-143)

**Description:**
The `validate()` method checks `spendingLimit`, `activeHours`, and `approvalGate`, but does **not** validate `cooldown`:

```typescript
private validate(): void {
  // ... validates spendingLimit, activeHours, approvalGate
  // Missing: no validation for cooldown
}
```

**Risk:**
A cooldown with `waitMinutes: 0` or `waitMinutes: -1` would be silently accepted. The `afterTransactionAbove` amount is also unvalidated.

**Recommendation:**
Add cooldown validation to `validate()`:
- `waitMinutes` must be a positive number.
- `afterTransactionAbove.amount` must be a positive, parseable number.
- `afterTransactionAbove.token` must be non-empty.

---

### [LOW] L-03: `SolanaAdapter.isValidAddress()` Uses Only Regex Validation

**File:** `src/chains/solana/adapter.ts` (lines 56-59)

**Description:**
Address validation uses a simple regex:

```typescript
isValidAddress(address: string): boolean {
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  return base58Regex.test(address);
}
```

This checks the character set and length but does not verify that the string is actually a valid base58-decoded 32-byte public key.

**Risk:**
Invalid addresses that happen to match the regex pattern could pass validation, only to fail at transaction submission time. While this is a low immediate risk, it could lead to user confusion and wasted gas fees.

**Recommendation:**
1. Use `@solana/web3.js` `PublicKey` constructor with try/catch for proper validation.
2. Additionally verify the decoded bytes are exactly 32 bytes long.

---

### [LOW] L-04: `AuditLogger.getRecent()` Performs Unsafe JSON Parsing

**File:** `src/logging/audit.ts` (lines 23-26)

**Description:**
The audit logger parses stored JSON entries without error handling:

```typescript
async getRecent(count: number = 10): Promise<AuditEntry[]> {
  const raw = await this.store.getRecent(this.storeKey, count);
  return raw.map((r) => JSON.parse(r) as AuditEntry);
}
```

If any stored entry is corrupted or not valid JSON, the entire `getRecent()` call will throw, losing access to all audit entries.

**Risk:**
Corrupted audit data could prevent security investigations. The `as AuditEntry` cast provides no runtime type checking.

**Recommendation:**
1. Wrap `JSON.parse` in try/catch per entry and skip/log corrupted entries.
2. Add runtime type validation of parsed entries (e.g., using Zod or a type guard).

---

### [LOW] L-05: `SwapParams.maxSlippage` Has No Upper Bound

**File:** `src/core/intent.ts` (lines 19-28)

**Description:**
The `maxSlippage` field is typed as `number` with no validation:

```typescript
export interface SwapParams {
  // ...
  maxSlippage?: number;  // No bounds checking
}
```

**Risk:**
An agent could set `maxSlippage: 1.0` (100%) or higher, which would allow a swap to execute at any price, potentially losing the entire value of the trade to MEV bots or front-running.

**Recommendation:**
1. Add a reasonable upper bound (e.g., 0.05 = 5%) enforced at the intent validation level.
2. Consider making this a policy-configurable maximum.

---

### [INFO] I-01: TypeScript Strict Mode Is Enabled -- Good Security Baseline

**File:** `tsconfig.json`

**Description:**
The TypeScript configuration has `"strict": true`, `"noUncheckedIndexedAccess": true`, and `"noFallthroughCasesInSwitch": true`. These settings provide strong compile-time safety.

**Risk:** None -- this is a positive finding.

**Recommendation:** Maintain these settings. Consider also enabling `"exactOptionalPropertyTypes": true` for even stricter optional property handling.

---

### [INFO] I-02: `AgentWallet` Class Has Proper Encapsulation

**File:** `src/core/wallet.ts`

**Description:**
All internal components (`signer`, `chain`, `policy`, `store`, `approval`, `logger`) are declared as `private readonly`. The wallet does not expose any method to directly access the signer or replace the policy engine after construction.

**Risk:** None -- this is a positive finding.

**Recommendation:** Ensure this encapsulation is maintained in future sprints. In particular, never add a public getter for the `signer` object.

---

### [INFO] I-03: `PolicyContext.now` Is Injectable -- Good for Testing

**File:** `src/policy/types.ts` (line 39), `src/policy/engine.ts` (line 31)

**Description:**
The policy evaluation accepts an optional `now` timestamp parameter, allowing deterministic time-based testing:

```typescript
async evaluate(intent: TransactionIntent, now?: number): Promise<PolicyDecision> {
  const context: PolicyContext = {
    now: now ?? Date.now(),
  };
}
```

**Risk:** None -- this is a positive finding for testability.

**Recommendation:** Ensure that the `now` parameter is only accessible internally and cannot be manipulated by AI agents through the public API (e.g., `handleToolCall` should not pass through a caller-controlled timestamp).

---

### [INFO] I-04: `MemoryStore` Has No Size Bounds on Lists

**File:** `src/stores/memory.ts` (lines 54-58)

**Description:**
The `append()` method grows lists without bound:

```typescript
async append(key: string, value: string): Promise<void> {
  const list = this.lists.get(key) ?? [];
  list.push(value);
  this.lists.set(key, list);
}
```

**Risk:**
In a long-running process, audit logs and transaction lists will grow indefinitely, eventually causing out-of-memory conditions. This is acceptable for a development/testing store but should be documented.

**Recommendation:**
1. Add an optional `maxListSize` configuration to `MemoryStore`.
2. Implement circular buffer semantics or automatic pruning of old entries.
3. Document the memory growth characteristics clearly.

---

## Conclusion

The Sprint 0 codebase establishes a well-structured foundation for the kova SDK. The separation of concerns between the policy engine, signer, store, and chain adapter is architecturally sound. TypeScript strict mode and proper encapsulation in the `AgentWallet` class provide a good security baseline.

However, **three critical issues must be addressed before Sprint 1 code goes live:**

1. **Fail-open policy stubs (C-01):** All policy rules unconditionally return ALLOW. If the execute path is implemented before the rules, the entire policy engine is a no-op. Change stubs to fail-closed (DENY or throw).

2. **Empty rules bypass (C-02):** A PolicyEngine with zero rules silently allows all transactions. Add a minimum-rules requirement or mandatory default-deny.

3. **Dependency vulnerability (C-03):** The `bigint-buffer` buffer overflow in the `@solana/spl-token` dependency chain must be resolved before any production deployment.

Additionally, the **high-severity findings** around key handling (H-01), store atomicity (H-03), validation bypass via `fromJSON` (H-04), and missing idempotency (H-06) should be tracked as Sprint 1/2 requirements to ensure the policy enforcement layer is trustworthy.

The medium and low findings represent defense-in-depth improvements that should be prioritized based on implementation schedule.

**Recommended Priority for Remediation:**
1. Immediately: Change all policy rule stubs to fail-closed (C-01)
2. Immediately: Add empty-rules guard to PolicyEngine (C-02)
3. Sprint 1 blocker: Resolve `bigint-buffer` vulnerability (C-03)
4. Sprint 1: Fix Store atomicity (H-03) and add idempotency (H-06)
5. Sprint 2: Implement `fromJSON` validation (H-04), fix LocalSigner error handling (M-05, M-06)
6. Sprint 2: Add hierarchical spending limit validation (M-02), allow/deny precedence (M-03)
7. Ongoing: Address remaining medium, low, and informational findings

---

*End of audit report.*
