# Kova Wallet SDK — Final Security Audit Report

**Date:** 2026-02-12
**Version:** 0.1.0
**Classification:** CONFIDENTIAL
**Verdict:** CONDITIONAL PASS — Requires remediation of CRITICAL and HIGH findings before mainnet deployment

---

## Audit Team

| Engineer | Specialization | Workstream |
|----------|---------------|------------|
| Engineer 1 | Cryptographic Systems | Crypto & Key Management |
| Engineer 2 | Key Management & HSM | Crypto & Key Management |
| Engineer 3 | Policy Enforcement | Policy Engine & Input Validation |
| Engineer 4 | Input Validation | Policy Engine & Input Validation |
| Engineer 5 | Concurrency & Race Conditions | Concurrency & Data Integrity |
| Engineer 6 | Data Integrity & Storage | Concurrency & Data Integrity |
| Engineer 7 | Authentication & Authorization | Auth, Network & Error Handling |
| Engineer 8 | Network Security & API | Auth, Network & Error Handling |
| Engineer 9 | Adversarial AI & Abuse | Adversarial Scenarios & Supply Chain |
| Engineer 10 | Supply Chain & Dependencies | Adversarial Scenarios & Supply Chain |

---

## 1. Executive Summary

Ten world-class cybersecurity engineers conducted an exhaustive line-by-line audit of the kova wallet SDK across five parallel workstreams. The audit covered every source file in `src/`, every test file in `tests/`, the dependency tree, and the build configuration.

**The SDK demonstrates strong security fundamentals.** Fail-closed design, mutex serialization, hash-chained audit logging, circuit breakers, parameterized SQL queries, error sanitization, and deep-clone isolation are all implemented correctly. The test suite (918 tests) includes dedicated adversarial, fail-closed, and concurrency test suites — exceptional for a v0.1.0 SDK.

**However, 57 findings were identified** across all workstreams, including issues that must be resolved before any mainnet deployment:

| Severity | Count | Summary |
|----------|-------|---------|
| **CRITICAL** | 4 | Infinity bypass, spending limit TOCTOU, unbounded audit growth, public circuit breaker reset |
| **HIGH** | 11 | Hash chain bugs, timing attacks, SSRF, no HTTPS enforcement, concurrent approval conflicts, policy info leakage |
| **MEDIUM** | 18 | Mutex limitations, key management gaps, Telegram auth, Jupiter trust, floating-point arithmetic |
| **LOW** | 15 | Input length limits, error leakage, TTL cleanup, overnight window ambiguity |
| **INFO** | 9 | Best practices, positive observations, documentation items |

---

## 2. CRITICAL Findings

### CRIT-01: "Infinity" Amount Bypasses Validation and Reaches Chain Adapter
**Source:** PE-01, ADV-01, NET-04 (Engineers 3, 4, 8, 9)
**Affected:** `src/core/wallet.ts:456-457`, `466-467`, `479-480`

`parseFloat("Infinity")` returns `Infinity`, which is not `NaN` and is `> 0`, so it passes all amount validation. If no spending limit is configured for the intent's token, the `Infinity` amount reaches `buildTransaction()` and the chain adapter with undefined behavior.

**Fix:**
```typescript
if (isNaN(parsed) || !Number.isFinite(parsed) || parsed <= 0)
```

---

### CRIT-02: Spending Limit TOCTOU — Check-Then-Act Is Not Atomic
**Source:** RC-01 (Engineer 5)
**Affected:** `src/policy/rules/spending-limit.ts:34-84`, `src/core/wallet.ts:204-270`

The SpendingLimitRule checks the current spending against limits, then increments counters as separate operations. Two `AgentWallet` instances sharing the same `Store` can both check simultaneously, both see the budget as available, and both allow — exceeding the configured limit. Additionally, counters increment on policy ALLOW *before* transaction broadcast, so failed transactions consume budget.

**Fix:** Implement atomic check-and-increment (increment first, deny if over limit, decrement on broadcast failure). For multi-instance deployments, use store-level atomic operations.

---

### CRIT-03: Unbounded Audit Log Growth — Memory Exhaustion DoS
**Source:** ADV-02, RC-14 (Engineers 5, 6, 9)
**Affected:** `src/stores/memory.ts:67-72`, `src/logging/audit.ts:130`

`MemoryStore.append()` pushes to an unbounded array. A compromised agent generating rapid-fire requests (even denied ones that still generate audit entries) can cause unbounded memory growth until OOM. The `SqliteStore` has the same issue with the `lists` table growing without bounds.

**Fix:** Implement a maximum list size (e.g., 100,000 entries) with FIFO eviction. Add periodic cleanup for SqliteStore.

---

### CRIT-04: CircuitBreaker.reset() Is Public and Unrestricted
**Source:** ADV-03 (Engineer 9)
**Affected:** `src/core/circuit-breaker.ts:109-113`, exported via `src/index.ts:83`

The `CircuitBreaker` class is publicly exported and its `reset()` method can clear cooldown state by writing directly to fixed store keys. Any code with access to the shared `Store` can reset the circuit breaker. The same applies to `AuditLogger.resetFailureCount()`.

**Fix:** Make `reset()` internal or require an authentication token. Consider not exporting `CircuitBreaker` directly. Use HMAC-protected store keys.

---

## 3. HIGH Findings

### HIGH-01: `canonicalJson()` Only Sorts Top-Level Keys — Hash Chain Integrity Broken
**Source:** KM-01, RC-04 (Engineers 1, 5)
**Affected:** `src/logging/audit.ts:56-58`

`JSON.stringify` with a replacer array sorts only top-level keys. Nested objects (intent params, policy decisions) have keys in insertion order, which is non-deterministic across JS engines and serialization round-trips. This undermines the entire audit hash chain.

**Fix:** Replace with recursive key-sorting serializer.

---

### HIGH-02: Non-Constant-Time Hash Comparison — Timing Side-Channel
**Source:** KM-02 (Engineer 1)
**Affected:** `src/logging/audit.ts:219, 237`

Hash comparisons use `!==` which short-circuits on first mismatch. An attacker with access to `verifyIntegrity()` could exploit timing differences to forge audit entries byte-by-byte.

**Fix:** Use `crypto.timingSafeEqual()` for all hash comparisons.

---

### HIGH-03: AllowlistRule Case Sensitivity — Bypass on Ethereum/Base
**Source:** PE-02 (Engineer 3)
**Affected:** `src/policy/rules/allowlist.ts:24-27, 56, 65`

The AllowlistRule uses exact `Set.has()` string matching. Ethereum addresses are case-insensitive (EIP-55), so `0xAbCd...` in a denylist can be bypassed by sending to `0xabcd...`.

**Fix:** Normalize addresses to lowercase for non-Solana chains before comparison.

---

### HIGH-04: Rate Limit TOCTOU — Same Pattern as Spending Limit
**Source:** RC-02 (Engineer 5)
**Affected:** `src/policy/rules/rate-limit.ts:34-67`

Identical to CRIT-02. Rate limit check and increment are non-atomic. Multi-instance deployments can bypass rate limits.

**Fix:** Use atomic increment-and-check.

---

### HIGH-05: `ensureKeyWithTTL` Race Condition — TTL Loss
**Source:** RC-03 (Engineer 5)
**Affected:** `src/policy/rules/rate-limit.ts:92-98`, `spending-limit.ts:151-156`

If a key expires between `ensureKeyWithTTL` and `increment`, the increment creates a new key **without TTL**. The counter persists forever, permanently capping spending/rate limits.

**Fix:** Always apply TTL when initializing counters. Use atomic set-with-TTL-if-not-exists.

---

### HIGH-06: Audit Hash Chain Verification Does Not Detect Tail Deletions
**Source:** RC-05 (Engineer 5)
**Affected:** `src/logging/audit.ts:177-248`

`verifyIntegrity()` only checks the most recent N entries and skips `previousHash` verification on the first entry in the window. An attacker can delete oldest entries without detection.

**Fix:** Store a genesis hash anchor. Track total entry count. Verify the first entry's `previousHash` against a stored anchor.

---

### HIGH-07: No RPC URL Validation — SSRF Risk
**Source:** AUTH-01 (Engineer 7)
**Affected:** `src/chains/solana/adapter.ts:44-51`, `src/chains/solana/swaps.ts:50,77,94`

`SolanaAdapter` accepts arbitrary `rpcUrl` with zero validation. An attacker controlling config can point to internal services (AWS metadata endpoint, localhost Redis), creating an SSRF vector. Same for `jupiterApiUrl`.

**Fix:** Validate URL schemes (enforce HTTPS except localhost for dev). Reject RFC 1918 / link-local addresses.

---

### HIGH-08: No HTTPS Enforcement for RPC or Jupiter API
**Source:** AUTH-02 (Engineer 8)
**Affected:** `src/chains/solana/adapter.ts:46`, `src/chains/solana/swaps.ts:83,94,156`

HTTP URLs transmit signed transactions in cleartext, enabling MITM attacks. For Jupiter, a MITM could replace swap transactions with fund-draining ones.

**Fix:** Enforce HTTPS for all external connections. Allow HTTP only for `localhost`/`127.0.0.1`.

---

### HIGH-09: Agent Can Exploit `getPolicy()` to Calculate Exact Remaining Budget
**Source:** ADV-05 (Engineer 9)
**Affected:** `src/core/wallet.ts:313-348, 745-786`

The `wallet_get_policy` tool reveals exact current spending counters, rate limit counters, circuit breaker status, and cooldown timings. A compromised agent can calculate precise remaining budget and time requests optimally.

**Fix:** Do not expose `used` amounts or current counter values. Show only the limits. Rate-limit `getPolicy()` calls.

---

### HIGH-10: No Maximum Length Validation on String Inputs
**Source:** PE-06, ADV-06 (Engineers 4, 9)
**Affected:** `src/core/wallet.ts:452-489`

Addresses, tokens, data fields, and metadata have no maximum length. A 1MB address passes validation, is `structuredClone`'d (doubling memory), and stored in the audit log.

**Fix:** Enforce max lengths: addresses (128), tokens (64), data (1MB), URIs (2048), reason (1024).

---

### HIGH-11: `handleToolCall` Uses Unsafe Type Assertions on Agent Input
**Source:** ADV-07 (Engineer 9)
**Affected:** `src/core/wallet.ts:584-594`

Tool handlers use `as string` casts without runtime validation. `input.reason` could be a truthy object that gets stored in the audit log as arbitrary nested data.

**Fix:** Add explicit `typeof` checks before casting in each handler.

---

## 4. MEDIUM Findings

| ID | Title | Source | Affected |
|----|-------|--------|----------|
| MED-01 | Private key persists in memory indefinitely — no zeroing/destroy() | KM-03 | `signers/local.ts:14-18` |
| MED-02 | Double deserialization of versioned transactions (TOCTOU in signing) | KM-04 | `signers/local.ts:35-48` |
| MED-03 | MPCSigner stub could be accidentally used in production | KM-05 | `signers/mpc.ts:17-38` |
| MED-04 | Hash chain uses concatenation without domain separation | KM-06 | `logging/audit.ts:118-119` |
| MED-05 | Audit hash chain has no HMAC — integrity but not authenticity | KM-07 | `logging/audit.ts:116-120` |
| MED-06 | Rules array not frozen at PolicyEngine construction | PE-03 | `policy/engine.ts:27` |
| MED-07 | Spending counters increment before transaction confirmation | PE-04 | `policy/rules/spending-limit.ts:81-84` |
| MED-08 | Rate limit keys lack agent/wallet namespacing | PE-05, RC-17 | `policy/rules/rate-limit.ts:37,50` |
| MED-09 | Custom intent data field lacks base64 validation | PE-07 | `core/wallet.ts:487` |
| MED-10 | Mutex is instance-local — no cross-instance serialization | RC-06 | `core/wallet.ts:84-85` |
| MED-11 | Mutex has no timeout or deadlock recovery | RC-07 | `core/wallet.ts:136-148` |
| MED-12 | Concurrent audit log writes can corrupt hash chain | RC-09 | `logging/audit.ts:95-140` |
| MED-13 | `parseFloat` in store increment causes floating-point drift | RC-10, ADV-10 | `stores/memory.ts:52`, `stores/sqlite.ts:92` |
| MED-14 | Telegram bot accepts callbacks from any chat — no chatId validation | AUTH-03 | `approval/telegram.ts:164-203` |
| MED-15 | Predictable request IDs enable pre-approval attacks | AUTH-04 | `approval/telegram.ts:104-105` |
| MED-16 | Concurrent approval requests consume each other's updates | AUTH-05 | `approval/telegram.ts:131-210` |
| MED-17 | Jupiter swap transactions trusted without content verification | AUTH-07 | `chains/solana/swaps.ts:77-137` |
| MED-18 | Idempotency store.get failure throws unstructured exception | ADV-04 | `core/wallet.ts:157-158` |

---

## 5. LOW Findings

| ID | Title | Source |
|----|-------|--------|
| LOW-01 | No `toJSON()` override — `JSON.stringify(signer)` leaks keypair | KM-08 |
| LOW-02 | No input size validation on transaction data before deserialization | KM-09 |
| LOW-03 | `verifyIntegrity` has boundary gap in partial-window verification | KM-11 |
| LOW-04 | AllowlistRule bypassed entirely for swap intents | PE-08 |
| LOW-05 | Rules silently ALLOW intents with unparseable/zero amounts | PE-09 |
| LOW-06 | Overnight time window day boundary ambiguity | PE-10 |
| LOW-07 | Policy builder overlap detection is case-sensitive | PE-11 |
| LOW-08 | JSON.parse on agent-controlled input without depth limit | PE-12 |
| LOW-09 | MemoryStore lists grow unbounded | RC-14 |
| LOW-10 | SqliteStore lists table has no index cleanup | RC-15 |
| LOW-11 | Expired kv entries never actively cleaned | RC-16 |
| LOW-12 | No timeout on network fetch calls (Jupiter, Telegram, RPC) | NET-01 |
| LOW-13 | Jupiter error bodies leak to calling code | NET-02 |
| LOW-14 | RPC error messages propagated unsanitized | NET-03 |
| LOW-15 | Dependency versions use caret ranges, not pinned | SC-01 |

---

## 6. INFO / Positive Findings

| ID | Title |
|----|-------|
| INFO-01 | No `console.log` of sensitive data in `src/` — `console.log` leaks keys via inspect |
| INFO-02 | `Signer` interface lacks `destroy()` lifecycle method |
| INFO-03 | `randomUUID()` for intent IDs is cryptographically sound |
| INFO-04 | Typosquat risk for short package name "kova" |
| INFO-05 | No `eval()`, `new Function()`, or dynamic code execution found |
| INFO-06 | No `postinstall` lifecycle scripts in `package.json` |
| INFO-07 | `tsconfig.json` uses `strict: true` and all security-relevant flags |
| INFO-08 | `better-sqlite3` native module build-time supply chain consideration |
| INFO-09 | `@solana/web3.js` v1.x is in maintenance mode — consider v2 migration |

---

## 7. Positive Observations — What Kova Gets Right

The audit team unanimously recognized the following security strengths:

1. **Fail-Closed Design (Excellent):** Every `rule.evaluate()` call is wrapped in try/catch; exceptions produce DENY. The audit circuit breaker blocks transactions when logging fails. PolicyEngine requires at least one rule.

2. **Mutex Serialization (Excellent):** The promise-chain mutex correctly serializes `execute()` within a single instance. Validation occurs before mutex acquisition to prevent lock starvation DoS.

3. **SQL Injection Protection (Excellent):** `SqliteStore` uses parameterized queries (`?` placeholders) throughout. Zero string concatenation in SQL.

4. **Error Sanitization (Excellent):** `handleToolCall` outer catch returns generic error messages. Telegram bot redacts its token from all error paths.

5. **Clean Signer Abstraction (Excellent):** The private key never leaves `LocalSigner`. No tool handler exposes any path to signing material. Only the public address is returned.

6. **Deep Clone Isolation (Good):** `structuredClone()` used extensively for audit entries, policy configs, and JSON round-trips, preventing shared mutable reference bugs.

7. **Denied Results Not Cached (Good):** Temporary denials (rate limit, approval pending) don't permanently block retries with the same intent ID.

8. **Comprehensive Adversarial Test Suite (Good):** 30+ tests covering prompt injection, SQL injection, type confusion, race conditions, store manipulation, and audit integrity — exceptional for v0.1.0.

9. **Token Case Normalization (Good):** SpendingLimitRule and ApprovalGateRule normalize token names with `.toUpperCase()` before comparison.

10. **Frozen Defensive Copies (Good):** `getRules()` returns `Object.freeze([...this.rules])`. `Policy.toJSON()` returns deep copies.

---

## 8. Remediation Priority

### P0 — Before ANY Mainnet Deployment
| Finding | Fix Effort | Impact |
|---------|-----------|--------|
| CRIT-01: Infinity bypass | 1 line | Prevents undefined chain adapter behavior |
| CRIT-02: Spending limit TOCTOU | Medium | Prevents multi-instance budget bypass |
| HIGH-01: canonicalJson | 10 lines | Restores hash chain integrity |
| HIGH-02: Timing attack | 5 lines | Prevents audit forgery |
| HIGH-07: SSRF | 20 lines | Prevents internal network scanning |
| HIGH-08: HTTPS enforcement | 10 lines | Prevents MITM on signed transactions |
| HIGH-10: Input length limits | 15 lines | Prevents memory exhaustion |

### P1 — Before Production with Real Funds
| Finding | Fix Effort | Impact |
|---------|-----------|--------|
| CRIT-03: Unbounded audit growth | 20 lines | Prevents OOM DoS |
| CRIT-04: Public circuit breaker reset | 10 lines | Prevents safety bypass |
| HIGH-03: Allowlist case sensitivity | 10 lines | Prevents denylist bypass |
| HIGH-04: Rate limit TOCTOU | Medium | Prevents rate limit bypass |
| HIGH-05: TTL loss race | 15 lines | Prevents permanent counter lock |
| HIGH-06: Tail deletion detection | 20 lines | Prevents audit log tampering |
| HIGH-09: Policy info leakage | 10 lines | Limits agent intelligence gathering |
| HIGH-11: Unsafe type assertions | 15 lines | Prevents audit data injection |

### P2 — Next Sprint
| Finding | Fix Effort | Impact |
|---------|-----------|--------|
| MED-01 through MED-18 | Varies | Defense-in-depth improvements |
| LOW-01 through LOW-15 | Varies | Edge case hardening |

---

## 9. Scope & Methodology

### Files Audited (Complete Source Tree)
```
src/core/wallet.ts              src/core/intent.ts
src/core/circuit-breaker.ts     src/core/result.ts
src/policy/engine.ts            src/policy/rules.ts
src/policy/builder.ts           src/policy/interface.ts
src/policy/serialization.ts     src/policy/rules/*.ts (5 files)
src/stores/memory.ts            src/stores/sqlite.ts
src/stores/interface.ts         src/signers/local.ts
src/signers/mpc.ts              src/signers/interface.ts
src/chains/solana/adapter.ts    src/chains/solana/transaction-builder.ts
src/chains/solana/transfers.ts  src/chains/solana/swaps.ts
src/chains/solana/utils.ts      src/chains/interface.ts
src/approval/telegram.ts        src/approval/interface.ts
src/adapters/tool-adapter.ts    src/adapters/langchain.ts
src/adapters/openai.ts          src/logging/audit.ts
src/index.ts
```

### Tests Reviewed
```
tests/unit/core/*.test.ts (4 files: wallet, adversarial, circuit-breaker, fail-closed)
tests/unit/policy/*.test.ts (3 files: rules, engine, builder)
tests/unit/stores/*.test.ts (2 files: memory, sqlite)
tests/unit/signers/*.test.ts (2 files: local, mpc)
tests/unit/chains/*.test.ts (2 files: solana-adapter, solana-utils)
tests/unit/approval/telegram.test.ts
tests/unit/adapters/adapters.test.ts
tests/unit/logging/audit.test.ts
tests/e2e/agent-demo.test.ts
```

### Configuration Reviewed
```
package.json    tsconfig.json    package-lock.json
```

### Methodology
- Full line-by-line source code review
- Cross-reference between implementation and test coverage
- Adversarial attack scenario modeling per OWASP and STRIDE frameworks
- Concurrency analysis for single-instance and multi-instance deployments
- Dependency supply chain analysis
- Cryptographic primitive correctness verification

---

## 10. Conclusion

The kova wallet SDK v0.1.0 has a **strong security architecture** with deliberate hardening at multiple layers. The fail-closed design, mutex serialization, parameterized queries, error sanitization, and comprehensive test suite are exemplary for an SDK at this stage.

However, **4 CRITICAL and 11 HIGH findings must be addressed before mainnet deployment.** The most impactful are the Infinity validation bypass (CRIT-01, trivial fix), the spending limit TOCTOU race (CRIT-02, architectural), the broken `canonicalJson` in the audit hash chain (HIGH-01, moderate fix), and the SSRF/HTTPS issues (HIGH-07/08, moderate fix).

**Recommendation:** Address all P0 findings, re-audit the affected code paths, then proceed with a staged mainnet rollout starting with low-value wallets.

---

*This report was produced by 10 cybersecurity engineers operating across 5 parallel audit workstreams. All findings are based on static analysis of the source code at commit HEAD as of 2026-02-12.*
