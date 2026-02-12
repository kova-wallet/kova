# Sprint 2 — Results

**Project:** kova
**Sprint:** 2 — Policy Engine Rules
**Date:** 2026-02-11

---

## Summary

Sprint 2 implements all 5 policy engine rules and resolves 3 Sprint 1 security blockers. All code compiles cleanly and all 429 tests pass.

### Deliverables

| Deliverable | Status |
|------------|--------|
| SpendingLimitRule | Implemented |
| AllowlistRule | Implemented |
| RateLimitRule | Implemented |
| TimeWindowRule | Implemented |
| ApprovalGateRule | Implemented |
| S1-02 Idempotency enforcement | Fixed |
| S1-04 Execute mutex | Fixed |
| S1-09 Intent validation | Fixed |
| Security audit | 21 findings (1C, 4H, 7M, 5L, 4I) |
| QA testing | 429 tests, 104 new, all passing |
| Security fixes applied | 4 fixes from audit |

---

## Security Audit Findings (21 total)

### Fixes Applied in Sprint 2

| ID | Severity | Finding | Fix |
|----|----------|---------|-----|
| S2-03 | HIGH | Idempotency cache poisons denied/pending results | Only cache confirmed and failed results; denied/pending are not cached since denial may be temporary |
| S2-13 | LOW | `extractAmount()` accepts negative/zero amounts | Added `parsed <= 0` guard in SpendingLimitRule and ApprovalGateRule extractAmount() |
| S2-15 | LOW | Intent ID not validated for length/format | Added ID validation in validateIntent(): 1-128 chars |
| S2-16 | LOW | Idempotency cache uses unsafe JSON.parse cast | Added schema validation: checks `status` and `intentId` fields before returning cached result |

### Deferred to Sprint 3

| ID | Severity | Finding | Reason |
|----|----------|---------|--------|
| S2-01 | CRITICAL | Spending limit bypass via cross-token transfers | Requires USD-normalized aggregate limits or multi-token support — architectural decision |
| S2-02 | HIGH | TOCTOU in spending limit check-then-increment | Mitigated by S1-04 execute mutex for single-process; needs atomic increment-then-check for distributed |
| S2-04 | HIGH | AllowlistRule case-sensitive address comparison | Correct for Solana (base58 is case-sensitive); needs chain-aware normalization for EVM chains |
| S2-05 | HIGH | Rate/spending counters consumed then tx denied by later rule | Mitigated by execute mutex; needs two-phase evaluation for distributed deployments |
| S2-06 | MEDIUM | Floating-point precision in spending calculations | Needs integer arithmetic migration — cross-cutting concern |
| S2-07 | MEDIUM | AllowlistRule fail-open when address can't be extracted | Design decision: swap intents have no target address |
| S2-08 | MEDIUM | Global rate limit store keys (not scoped per wallet/agent) | Needs multi-tenancy support — Sprint 4+ |
| S2-09 | MEDIUM | TimeWindowRule doesn't validate HH:MM format | Low risk — malformed time strings would cause NaN comparison, failing closed |
| S2-10 | MEDIUM | ApprovalGate allows custom intents without amount check | Design decision: custom intents are opaque; needs configurable policy |
| S2-11 | MEDIUM | Execute mutex unbounded promise chain | Low risk in practice; consider async-mutex library for production |
| S2-12 | MEDIUM | ensureKeyWithTTL() race between check and set | Mitigated by execute mutex; needs atomic increment-with-TTL for distributed |
| S2-14 | LOW | extractToken() returns "UNKNOWN" for missing tokens | Low risk due to upstream validation |
| S2-17 | LOW | TimeWindowRule require_approval returns DENY not PENDING | Design limitation: would need approval channel integration |

### Verified as Fixed (S1 remediations)

| ID | Status |
|----|--------|
| S2-18 (S1-02) | Idempotency: verified implemented and functional |
| S2-19 (S1-04) | Execute mutex: verified implemented and functional |
| S2-20 (S1-09) | Intent validation: verified comprehensive and well-structured |
| S2-21 | PolicyEngine evaluation order: verified correct |

---

## QA Test Results

- **Total tests:** 429
- **Passing:** 429
- **New tests added:** 104 (48 in rules.test.ts, 56 in wallet.test.ts)
- **Coverage areas:** All 5 policy rules + edge cases, S1-02/S1-04/S1-09 security fix verification

### Test Distribution

| File | Tests |
|------|-------|
| rules.test.ts | 92 |
| wallet.test.ts | 123 |
| engine.test.ts | 18 |
| builder.test.ts | 56 |
| memory.test.ts | 38 |
| solana-adapter.test.ts | 36 |
| audit.test.ts | 19 |
| intent.test.ts | 18 |
| local.test.ts | 13 |
| sqlite.test.ts | 7 |
| mpc.test.ts | 5 |
| telegram.test.ts | 4 |

---

## Files Modified

### New/Rewritten
- `src/policy/rules/spending-limit.ts` — 179 lines, full implementation
- `src/policy/rules/allowlist.ts` — 119 lines, full implementation
- `src/policy/rules/rate-limit.ts` — 94 lines, full implementation
- `src/policy/rules/time-window.ts` — 121 lines, full implementation
- `src/policy/rules/approval-gate.ts` — 145 lines, full implementation
- `tests/unit/policy/rules.test.ts` — 1344 lines, comprehensive tests

### Modified
- `src/core/wallet.ts` — Added S1-02/S1-04/S1-09 fixes + S2-03/S2-15/S2-16 fixes
- `src/core/result.ts` — Added `VALIDATION_FAILED` error code
- `tests/unit/core/wallet.test.ts` — Added 56 new tests for security fixes

---

## What's Next (Sprint 3)

Sprint 3 addresses real Solana RPC integration:
- Replace mock SolanaAdapter with real RPC calls
- Transaction serialization using @solana/web3.js
- Address the S2-01 CRITICAL finding (cross-token spending limit bypass)
- Implement atomic increment-with-TTL in Store interface (S2-02, S2-12)
