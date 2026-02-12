# Sprint 2 -- QA Test Report

**Date:** 2026-02-11
**Tester:** QA Engineer (Claude)
**Sprint scope:** All 5 policy rules + security fixes (S1-02, S1-04, S1-09)

## Summary

- **Total tests:** 429
- **Passing:** 429
- **Failing:** 0
- **New tests added:** 104 (48 in rules.test.ts, 56 in wallet.test.ts)
- **Test files modified:** 2 (tests/unit/policy/rules.test.ts, tests/unit/core/wallet.test.ts)
- **Test files unchanged:** engine.test.ts (18 tests, no new additions needed)

## Test Coverage by Component

### Policy Rules (tests/unit/policy/rules.test.ts) -- 92 tests total

| Component | Existing Tests | New Tests | Total |
|-----------|---------------|-----------|-------|
| AllowlistRule | 11 | 7 | 18 |
| SpendingLimitRule | 11 | 11 | 22 |
| RateLimitRule | 7 | 7 | 14 |
| TimeWindowRule | 8 | 11 | 19 |
| ApprovalGateRule | 13 | 12 | 25 |

### AgentWallet (tests/unit/core/wallet.test.ts) -- 123 tests total

| Component | Existing Tests | New Tests | Total |
|-----------|---------------|-----------|-------|
| Constructor | 3 | 0 | 3 |
| getAddress() | 3 | 0 | 3 |
| getBalance() | 2 | 0 | 2 |
| execute() -- full pipeline | 14 | 0 | 14 |
| execute() -- summary generation | 6 | 0 | 6 |
| getTransactionHistory() | 8 | 0 | 8 |
| execute() -- multiple transactions | 3 | 0 | 3 |
| execute() -- intent normalization | 4 | 0 | 4 |
| execute() -- audit logging details | 12 | 0 | 12 |
| execute() -- error handling edge cases | 5 | 0 | 5 |
| execute() -- concurrent executions | 3 | 0 | 3 |
| execute() -- metadata and params | 6 | 0 | 6 |
| getTransactionHistory() -- advanced | 5 | 0 | 5 |
| Stubs (not implemented) | 4 | 0 | 4 |
| **S1-02 Idempotency** | 0 | **6** | 6 |
| **S1-04 Execute mutex** | 0 | **4** | 4 |
| **S1-09 Intent validation** | 0 | **46** | 46 |

### PolicyEngine (tests/unit/policy/engine.test.ts) -- 18 tests (unchanged)

Pre-existing tests adequately cover engine evaluation order, deny-first semantics, PENDING handling, context injection, and sequential rule evaluation.

## Edge Cases Tested

### SpendingLimitRule (11 new tests)
- Zero amount (0 <= limit, ALLOW)
- NaN amount (treated as no-amount intent, ALLOW)
- Negative amount (-1.0 <= limit, ALLOW)
- Amount exactly equal to per-transaction limit (boundary, ALLOW)
- Amount just above per-transaction limit (1.000001 > 1.0, DENY)
- Combined daily + weekly + monthly limits (daily triggers first)
- Counter persistence across multiple calls (3+3+3=9 then +2 DENY)
- Exactly remaining daily budget allowed (7+3=10 ALLOW, then 0.001 DENY)
- Independent tracking of different tokens (SOL limit ignores USDC)
- Very large amounts within limit
- Floating-point precision at boundary

### AllowlistRule (7 new tests)
- No target address in intent (swap intent, ALLOW)
- Empty string target address (falsy, skips checks, ALLOW -- documents behavior)
- Empty allowAddresses array (no whitelist restriction, ALLOW)
- Both allow and deny configured for same address (deny takes precedence)
- Case-sensitive address comparison
- ProgramId as both target address and programId for custom intents
- Non-custom intents with allowPrograms configured (ALLOW)
- Multiple addresses in allow list

### RateLimitRule (7 new tests)
- Limit of 0 per minute (immediate DENY)
- Limit of 0 per hour (immediate DENY)
- Limit of 1 per minute (exactly 1 ALLOW, then DENY)
- Limit of 1 per hour (exactly 1 ALLOW, then DENY)
- Counter does NOT increment on DENY (verified via store read)
- Both minute and hour limits at 0 (minute check fires first)
- High-volume traffic (100 ALLOWs then 101st DENY)

### TimeWindowRule (11 new tests)
- Exactly at end time (exclusive, DENY)
- Exactly at start time (inclusive, ALLOW)
- Midnight boundary (00:00, ALLOW)
- Multiple windows for the same day
- Gap between windows (DENY)
- US Eastern timezone (America/New_York) with UTC offset
- Overnight window wrapping past midnight
- require_approval message content
- deny message includes timezone name
- Weekend-only window
- Empty windows array (always deny)

### ApprovalGateRule (12 new tests)
- Amount exactly equals threshold (strict >, ALLOW)
- Amount just above threshold (1.000001 > 1.0, DENY)
- Approval request field verification (id, summary, amount, token, target, expiresAt)
- Case-insensitive token comparison (sol vs SOL)
- Default 5-minute timeout when not configured
- Reason extracted from metadata when params has no reason
- AgentId extracted from intent metadata
- UUID generated for approval request when intent has no id
- Target extraction for swap intent (falls back to "unknown")

## Security Fix Verification

### S1-02 -- Idempotency (6 tests)

| Test | Description | Result |
|------|-------------|--------|
| Cached result for same ID | Same intent ID on second call returns cached result without re-execution | PASS |
| Different IDs independent | Intents with different IDs are processed independently | PASS |
| Denied results cached | Denied results are cached and returned on retry | PASS |
| No policy re-evaluation | Policy engine is NOT re-invoked for cached results (verified via call counter) | PASS |
| Auto-generated IDs unique | Intents without IDs get unique UUIDs, no accidental caching | PASS |
| Failed results cached | Failed transaction results are cached and returned | PASS |

**Verdict:** S1-02 is properly implemented. The idempotency cache correctly stores and retrieves results keyed by intent ID, and avoids re-executing the full pipeline on duplicates.

### S1-04 -- Execute Mutex (4 tests)

| Test | Description | Result |
|------|-------------|--------|
| Serialized execution | Concurrent execute() calls are serialized (start/end pairs don't overlap) | PASS |
| TOCTOU prevention | Rate-limiting rule correctly sees updated state from serialized calls | PASS |
| Mutex release on failure | Mutex is released even when internal execution throws | PASS |
| High concurrency | 10 concurrent execute() calls all complete correctly | PASS |

**Verdict:** S1-04 is properly implemented. The execute mutex correctly serializes concurrent calls using a promise-chain pattern, preventing TOCTOU races where concurrent calls could bypass rate limits or spending counters.

### S1-09 -- Intent Validation (46 tests)

| Category | Tests | Result |
|----------|-------|--------|
| Invalid intent type | Rejects "invalid_type", includes type in message | PASS |
| Invalid chain | Rejects "bitcoin", includes chain in message | PASS |
| Missing/null params | Rejects null params | PASS |
| Transfer validation | Empty to, empty amount, empty token, NaN amount, zero amount, negative amount, whitespace-only fields | ALL PASS |
| Swap validation | Empty fromToken, empty toToken, invalid amount | ALL PASS |
| Mint validation | Empty collection, empty metadataUri | ALL PASS |
| Stake validation | Invalid amount, empty token | ALL PASS |
| Custom validation | Empty programId, non-string data, non-array accounts | ALL PASS |
| Valid intents accepted | All 5 intent types on all 3 chains | ALL PASS |
| Intent ID in error | Returns "unknown" when no id, preserves id when provided | ALL PASS |
| Validation before mutex | Invalid intents return immediately, no deadlock | PASS |

**Verdict:** S1-09 is properly implemented. All intent types are validated for required fields, empty strings, and invalid amounts before any processing occurs. Validation runs before the mutex is acquired, preventing deadlocks from invalid inputs.

## Recommendations

1. **Empty string address handling (AllowlistRule):** The current implementation treats empty string addresses as falsy, so they skip the deny check. If empty target addresses should be blocked, the `extractTargetAddress` return value check should use `!== null` rather than truthiness. This is a design decision, not a bug, but worth documenting.

2. **Negative amounts in SpendingLimitRule:** The spending limit rule allows negative amounts through since `parseFloat("-1") > limit` is false. The wallet's S1-09 validation now rejects negative amounts at the entry point, so this is defense-in-depth. However, if the spending limit rule is used standalone (without the wallet validation layer), negative amounts would be allowed.

3. **Floating-point precision:** Spending limit comparisons use JavaScript's native floating-point arithmetic. For production use with high-precision financial amounts, consider using a decimal arithmetic library. Current tests verify boundary behavior is correct for typical amounts.

4. **TTL-based counter reset:** Rate limit and spending limit counters rely on MemoryStore TTL expiration (lazy on read). Tests do not simulate TTL expiration (would require mocking `Date.now()`). This is covered by MemoryStore's own test suite but could benefit from integration-level tests.

5. **Test timing sensitivity:** The S1-04 mutex serialization test uses a 20ms delay to verify ordering. On extremely slow CI environments, this could be flaky. Consider using a mock timer if this becomes an issue.
