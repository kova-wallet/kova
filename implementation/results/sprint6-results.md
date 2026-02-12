# Sprint 6 — Results

**Project:** kova
**Sprint:** 6 — Audit Logging + Security Hardening
**Date:** 2026-02-12

---

## Summary

Sprint 6 implements audit logging hardening and a transaction-level circuit breaker. PolicyEngine.evaluate() now returns per-rule audit data with timing measurements and fail-closed error handling. AuditLogger gains SHA-256 hash chain integrity, consecutive failure counting with a circuit breaker, and a verifyIntegrity() method. A new store-backed CircuitBreaker module tracks consecutive policy denials with configurable cooldown. This sprint also resolves three deferred Sprint 1 findings (S1-01, S1-11, S1-12). All code compiles cleanly and all 892 tests pass.

### Deliverables

| Deliverable | Status |
|------------|--------|
| PolicyEngine per-rule audit with `PolicyEvaluationResult` | Implemented |
| Fail-closed policy evaluation (try/catch per rule) | Implemented (S1-12 fix) |
| AuditLogger SHA-256 hash chain integrity | Implemented (S1-11 fix) |
| AuditLogger failure counting + `AuditCircuitOpenError` | Implemented (S1-01 fix) |
| `AuditLogger.verifyIntegrity()` method | Implemented |
| CircuitBreaker (store-backed denial tracking + cooldown) | Implemented |
| AgentWallet integration (audit circuit, circuit breaker, per-rule audit) | Implemented |
| New exports (CircuitBreaker, AuditCircuitOpenError, etc.) | Implemented |
| Security audit | 13 findings (0C, 2H, 4M, 3L, 4I) |
| QA testing | 892 tests, 95 new, all passing |
| Security fixes applied | 5 fixes from audit |

---

## Deferred Sprint 1 Findings Resolved

Sprint 6 closes three findings that were deferred during Sprint 1:

| Original ID | Description | Resolution |
|-------------|-------------|------------|
| S1-01 | Audit write failures silently swallowed — no detection or escalation | AuditLogger now tracks consecutive write failures. After `maxConsecutiveFailures` (default 3), it throws `AuditCircuitOpenError` and the wallet refuses further transactions. An optional `onAuditFailure` callback provides external alerting. |
| S1-11 | Audit log entries have no integrity protection — tampered entries are undetectable | Each audit entry is now hashed with SHA-256 using a hash chain (`hash = SHA256(entryJson + previousHash)`). `verifyIntegrity()` walks the chain forward and detects content modification, reordering, and corrupted entries. |
| S1-12 | Policy rule exceptions could bypass deny — no fail-closed guarantee | `PolicyEngine.evaluate()` wraps each `rule.evaluate()` in try/catch. A throwing rule produces a DENY decision with the rule name and an audit entry recording the failure. No code path allows a rule error to result in anything other than DENY. |

---

## Security Audit Findings (13 total)

### Fixes Applied in Sprint 6

| ID | Severity | Finding | Fix |
|----|----------|---------|-----|
| S6-01 | HIGH | Non-atomic hash chain write — crash between `store.append()` and `store.set()` permanently corrupts the hash chain | Made hash chain writes atomic: derive `previousHash` from last entry in list via `getRecent(key, 1)` instead of maintaining a separate `audit:last_hash` key. Single `store.append()` call eliminates the crash window. |
| S6-02 | HIGH | Hash chain verification depends on `JSON.stringify` property order stability — cross-environment hash mismatches possible | Used canonical JSON serialization (sorted keys via `JSON.stringify(obj, Object.keys(obj).sort())`) for hash computation in both `log()` and `verifyIntegrity()`. Deterministic output regardless of property order. |
| S6-09 | LOW | `cooldownMs: 0` allows instant recovery, defeating the circuit breaker's purpose | Documented that `cooldownMs=0` is a valid "counting-only" configuration. Added documentation note in the CircuitBreaker constructor. |
| S6-12 | INFO | Redundant `reset()` calls on every `check()` after cooldown expires — `""` is not `null` so the cooldown branch is always entered | Fixed by checking for both `null` and empty string in `check()` method: `if (cooldownUntil !== null && cooldownUntil !== "")`. |
| S6-13 | INFO | Duplicate `PolicyRuleAudit` export — both `PolicyRuleAuditType` alias and `PolicyRuleAudit` exported from `index.ts` | Removed duplicate `PolicyRuleAuditType` alias from `index.ts`. `PolicyRuleAudit` is now exported only from the logging re-export. |

### Deferred Findings

| ID | Severity | Finding | Reason |
|----|----------|---------|--------|
| S6-03 | MEDIUM | Circuit breaker store key namespacing — predictable keys with no access control | Single-instance deployment assumption. Same architectural pattern as existing spending/rate limit keys. Namespace isolation deferred to multi-instance hardening. |
| S6-04 | MEDIUM | AuditLogger constructor duck-typing edge case — Store with a `store` property misidentified as config | Edge case requiring a decorator Store pattern. Current code accidentally works for delegating stores but is fragile. Deferred to API cleanup pass. |
| S6-05 | MEDIUM | Audit write failures for confirmed transactions — up to `maxConsecutiveFailures` txs can execute without audit trail | Acceptable: maximum 3 transactions before the audit circuit opens. The `onAuditFailure` callback enables external alerting. Pre-broadcast audit logging would require significant architectural changes. |
| S6-06 | MEDIUM | CircuitBreaker `check()`/`recordOutcome()` non-atomic — TOCTOU race in multi-instance deployments | Single-instance mutex protects against races in the expected deployment model. Multi-instance deployments require atomic store operations (e.g., Redis MULTI/EXEC). |
| S6-07 | LOW | Rule error messages in fail-closed path leak implementation details to agents | Engine errors do not reach agents via the normal API surface. `handleToolCall()` returns sanitized messages. Raw error messages appear only in audit log entries, which are not exposed through `getTransactionHistory()`. |
| S6-08 | LOW | `performance.now()` timing data in PolicyRuleAudit may enable side-channel inference | Timing data is not exposed to agents through the current API surface. `getTransactionHistory()` strips per-rule audit data. Only direct audit log access reveals timing. |
| S6-10 | INFO | `verifyIntegrity()` cannot validate the first entry's `previousHash` in partial chain verification | Inherent limitation of partial chain verification. Full-chain verification is unaffected. No code change required. |
| S6-11 | INFO | In-memory audit failure counter (`consecutiveFailures`) does not survive process restart | By design: the store is the monitored component, so persisting failure state to the store would be paradoxical. Process restart frequency should be monitored externally. |

---

## QA Test Results

- **Total tests:** 892
- **Passing:** 892
- **New tests added:** 95
- **Previous total:** 797 (Sprints 0-5)
- **Net change:** +95 tests (797 → 892)

### New Test Files

| File | Tests |
|------|-------|
| circuit-breaker.test.ts | 25 |
| fail-closed.test.ts | 30 |
| adversarial.test.ts | 40 |

### Modified Test Files

| File | New Tests |
|------|-----------|
| engine.test.ts | +8 |
| audit.test.ts | (modified for hash chain / circuit) |
| wallet.test.ts | (modified for per-rule audit data) |

### Test Distribution (all 17 files)

| File | Tests |
|------|-------|
| adapters.test.ts | 181 |
| wallet.test.ts | 133 |
| rules.test.ts | 102 |
| solana-utils.test.ts | 57 |
| builder.test.ts | 56 |
| telegram.test.ts | 56 |
| sqlite.test.ts | 54 |
| solana-adapter.test.ts | 39 |
| adversarial.test.ts | 40 |
| memory.test.ts | 38 |
| fail-closed.test.ts | 30 |
| circuit-breaker.test.ts | 25 |
| engine.test.ts | 26 |
| audit.test.ts | 19 |
| intent.test.ts | 18 |
| local.test.ts | 13 |
| mpc.test.ts | 5 |

### QA Test Coverage Highlights

- **CircuitBreaker**: All methods (check, recordOutcome, reset, getConfig) tested with boundary conditions, injectable timestamps, config validation, and wallet integration (25 tests)
- **Fail-closed behavior**: All 7 failure mode categories covered — store, signer, RPC, approval channel, policy rule, audit, unknown intent (30 tests)
- **Adversarial inputs**: SQL injection, HTML/XSS, path traversal, newline injection, JSON injection, unicode control characters, null bytes, type confusion (10 type variants), store manipulation, race conditions (40 tests)
- **Policy engine per-rule audits**: Audit trail structure, timing measurements, early-termination semantics, and fail-closed error recording (8 new tests)
- **Audit hash chain**: Integrity verification, tamper detection, corrupted JSON handling, empty log handling
- **Notable finding:** `parseFloat("Infinity")` passes `> 0` validation — carried forward from Sprint 5, documented as known behavior

---

## Files Modified

### New Files

- `src/core/circuit-breaker.ts` — CircuitBreaker class with store-backed denial tracking and configurable cooldown
- `src/policy/types.ts` — PolicyRuleAudit, PolicyEvaluationResult types
- `tests/unit/core/circuit-breaker.test.ts` — 25 tests for CircuitBreaker
- `tests/unit/core/fail-closed.test.ts` — 30 tests for fail-closed behavior
- `tests/unit/core/adversarial.test.ts` — 40 tests for adversarial inputs, bypass attempts, races, type confusion

### Modified Files

- `src/policy/engine.ts` — evaluate() returns `PolicyEvaluationResult` with per-rule `PolicyRuleAudit` entries, try/catch per rule for fail-closed behavior (S1-12 fix)
- `src/logging/audit.ts` — SHA-256 hash chain integrity (S1-11 fix), consecutive failure counting with `AuditCircuitOpenError` (S1-01 fix), `verifyIntegrity()` method, atomic hash chain writes (S6-01 fix), canonical JSON serialization (S6-02 fix)
- `src/logging/types.ts` — AuditEntry with `hash`/`previousHash` fields, re-exports for PolicyRuleAudit
- `src/core/wallet.ts` — Audit circuit check, circuit breaker check, real per-rule audit data from engine, `getPolicy()` includes circuit breaker status
- `src/core/result.ts` — PolicySummary.circuitBreaker field, CIRCUIT_BREAKER_OPEN error code
- `src/index.ts` — New exports: CircuitBreaker, CircuitBreakerConfig, AuditCircuitOpenError, AuditLoggerConfig, AuditFailureCallback, IntegrityReport, PolicyEvaluationResult; removed duplicate PolicyRuleAuditType alias (S6-13 fix)
- `tests/unit/policy/engine.test.ts` — 8 new tests for per-rule audit data and fail-closed rule errors
- `tests/unit/logging/audit.test.ts` — Modified for hash chain and audit circuit testing
- `tests/unit/core/wallet.test.ts` — Modified for per-rule audit data in audit entries

---

## Key Design Decisions

1. **Fail-closed via try/catch per rule**: Each `rule.evaluate()` is individually wrapped. A throwing rule produces DENY with the rule name recorded, and remaining rules are not evaluated. This is the strictest interpretation of fail-closed — no exception can bypass policy.
2. **SHA-256 hash chain with single atomic write**: The previous hash is derived from `getRecent(key, 1)` rather than a separate pointer key. This eliminates the crash window between two store operations at the cost of one extra read per log call (S6-01 fix).
3. **Canonical JSON for hash computation**: Sorted keys ensure deterministic serialization across environments and round-trips through `JSON.parse`/`JSON.stringify` (S6-02 fix).
4. **In-memory audit failure counter**: The `consecutiveFailures` counter is intentionally not persisted to the store, because the store is the component being monitored. Persisting failure state to a broken store would be paradoxical.
5. **Circuit breaker as a safety net, not primary control**: The CircuitBreaker tracks consecutive policy denials and imposes a cooldown. It is designed to catch runaway agent behavior, not to replace policy rules. PENDING outcomes are treated as no-ops (not denials).
6. **`cooldownMs=0` as counting-only mode**: Rather than enforcing a minimum cooldown, `cooldownMs=0` is documented as a valid configuration that provides denial counting without a blocking cooldown period (S6-09 resolution).
7. **Audit circuit check before all other checks**: `isCircuitOpen()` is checked first in the execute pipeline (before circuit breaker, before policy). If audit logging is broken, no transactions proceed.

---

## What's Next

Sprint 6 completes the audit logging and security hardening layer. The SDK now provides:
- Full transaction execution pipeline (Sprint 0-1)
- 5 policy rules: spending limits, allowlists, rate limits, time windows, approval gates (Sprint 2)
- Solana chain adapter with real RPC integration patterns (Sprint 3)
- Telegram approval bot for human-in-the-loop (Sprint 4)
- Agent adapter layer for Claude, OpenAI, and LangChain (Sprint 5)
- Audit logging with SHA-256 hash chain integrity, fail-closed policy evaluation, and circuit breaker protection (Sprint 6)
