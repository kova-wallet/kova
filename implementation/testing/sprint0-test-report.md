# Sprint 0 Test Report

**Project:** kova -- Policy-constrained crypto wallet SDK for AI agents
**Sprint:** 0 (Foundation)
**Date:** 2026-02-11
**Test Runner:** Vitest 4.0.18 with v8 coverage

---

## Summary

| Metric | Before | After |
|--------|--------|-------|
| Test Files | 5 | 12 |
| Total Tests | 47 | 209 |
| Tests Passing | 47 | 209 |
| Tests Failing | 0 | 0 |
| Statement Coverage | 63.18% | 94.50% |
| Branch Coverage | 79.72% | 91.89% |
| Function Coverage | 52.38% | 100.00% |
| Line Coverage | 63.12% | 94.41% |

All 209 tests pass. Coverage increased from 63% to 94.5% statements, with 100% function coverage across the entire codebase.

---

## Test Coverage Breakdown (by module)

### Core (`src/core/`)

| File | Stmts | Branch | Funcs | Lines | Status |
|------|-------|--------|-------|-------|--------|
| intent.ts | 100% | 100% | 100% | 100% | Fully covered |
| wallet.ts | 100% | 100% | 100% | 100% | Fully covered |
| result.ts | 0% | 0% | 0% | 0% | Type-only file (no executable code) |

### Policy (`src/policy/`)

| File | Stmts | Branch | Funcs | Lines | Status |
|------|-------|--------|-------|-------|--------|
| builder.ts | 100% | 100% | 100% | 100% | Fully covered |
| engine.ts | 100% | 100% | 100% | 100% | Fully covered |
| types.ts | 0% | 0% | 0% | 0% | Type-only file (no executable code) |
| serialization.ts | 0% | 0% | 0% | 0% | Re-export only |

### Policy Rules (`src/policy/rules/`)

| File | Stmts | Branch | Funcs | Lines | Status |
|------|-------|--------|-------|-------|--------|
| allowlist.ts | 100% | 100% | 100% | 100% | Stub tested |
| approval-gate.ts | 100% | 100% | 100% | 100% | Stub tested |
| rate-limit.ts | 100% | 100% | 100% | 100% | Stub tested |
| spending-limit.ts | 100% | 100% | 100% | 100% | Stub tested |
| time-window.ts | 100% | 100% | 100% | 100% | Stub tested |

### Signers (`src/signers/`)

| File | Stmts | Branch | Funcs | Lines | Status |
|------|-------|--------|-------|-------|--------|
| local.ts | 33.33% | 16.66% | 100% | 33.33% | Partial -- sign() body requires real Solana txns |
| mpc.ts | 100% | 100% | 100% | 100% | Stub tested |
| interface.ts | 0% | 0% | 0% | 0% | Type-only file (no executable code) |

### Stores (`src/stores/`)

| File | Stmts | Branch | Funcs | Lines | Status |
|------|-------|--------|-------|-------|--------|
| memory.ts | 100% | 95% | 100% | 100% | Near-complete (1 branch in TTL preservation) |
| sqlite.ts | 100% | 100% | 100% | 100% | Stub tested |
| interface.ts | 0% | 0% | 0% | 0% | Type-only file (no executable code) |

### Chains (`src/chains/`)

| File | Stmts | Branch | Funcs | Lines | Status |
|------|-------|--------|-------|-------|--------|
| solana/adapter.ts | 100% | 100% | 100% | 100% | Fully covered |
| interface.ts | 0% | 0% | 0% | 0% | Type-only file (no executable code) |
| solana/swaps.ts | 0% | 0% | 0% | 0% | Re-export only |
| solana/transfers.ts | 0% | 0% | 0% | 0% | Re-export only |
| solana/utils.ts | 0% | 0% | 0% | 0% | Re-export only |

### Approval (`src/approval/`)

| File | Stmts | Branch | Funcs | Lines | Status |
|------|-------|--------|-------|-------|--------|
| telegram.ts | 100% | 100% | 100% | 100% | Stub tested |
| interface.ts | 0% | 0% | 0% | 0% | Type-only file (no executable code) |

### Logging (`src/logging/`)

| File | Stmts | Branch | Funcs | Lines | Status |
|------|-------|--------|-------|-------|--------|
| audit.ts | 100% | 100% | 100% | 100% | Fully covered |
| types.ts | 0% | 0% | 0% | 0% | Type-only file (no executable code) |

### Adapters (`src/adapters/`)

| File | Stmts | Branch | Funcs | Lines | Status |
|------|-------|--------|-------|-------|--------|
| claude.ts | 0% | 0% | 0% | 0% | Re-export only (Sprint 5) |
| openai.ts | 0% | 0% | 0% | 0% | Re-export only (Sprint 5) |
| langchain.ts | 0% | 0% | 0% | 0% | Re-export only (Sprint 5) |
| types.ts | 0% | 0% | 0% | 0% | Type-only file (no executable code) |

---

## Tests Added (7 new test files, 162 new tests)

### 1. `tests/unit/core/intent.test.ts` (18 tests) -- NEW FILE

**Why:** All 5 type guard functions (`isTransferIntent`, `isSwapIntent`, `isMintIntent`, `isStakeIntent`, `isCustomIntent`) had 0% coverage. These are critical for type-safe intent handling throughout the SDK.

**What it tests:**
- Each type guard correctly identifies its matching intent type
- Each type guard returns `false` for all other intent types
- Type narrowing provides access to type-specific params
- Intents with optional fields (metadata, id, createdAt)
- Intents on different chains (solana, ethereum)
- Swap intents with optional maxSlippage

### 2. `tests/unit/stores/memory.test.ts` (24 new tests added to existing file)

**Why:** MemoryStore had 89.65% line coverage with gaps in TTL edge cases, increment edge cases, and list behavior. Lines 46-48 (TTL preservation on increment) were uncovered.

**What was added:**
- **TTL edge cases:** zero TTL, negative TTL, lazy deletion on get, value before TTL expiry, TTL overwrite
- **Increment edge cases:** increment by zero, first increment by zero, very large values, multiple sequential increments, TTL preservation on increment, increment of expired key, non-numeric value handling
- **List edge cases:** count=0 behavior (discovered a JavaScript quirk: `slice(-0)` returns full array), count larger than list size, empty string append, JSON string serialization roundtrip, separate lists per key, large number of appends, count=1
- **Key isolation:** key-value vs list store independence, special characters in keys, empty string key
- **Clear:** operations after clear, clearing both stores

### 3. `tests/unit/policy/builder.test.ts` (39 new tests added to existing file)

**Why:** PolicyBuilder had 92.18% line coverage with uncovered validation branches for zero amounts, edge case time formats, and some config paths.

**What was added:**
- **Spending limit validation:** zero amount, whitespace-only token, valid daily/weekly/monthly, invalid amounts for all periods, very small amounts, very large amounts, simultaneous field validation
- **Active hours validation:** missing timezone, empty windows, empty days, invalid end time, missing leading zero, invalid minutes, multiple windows, midnight boundaries
- **Approval gate validation:** zero amount, NaN amount, zero timeout, no timeout (default), channel configuration
- **Denylist configuration:** address denylist, program denylist, empty lists, array reference isolation
- **Cooldown configuration:** basic config test
- **Extend overrides:** spending limit override, rate limit override
- **Serialization:** object reference independence, full roundtrip, minimal config fromJSON
- **Policy name edge cases:** special characters, very long names, unicode

### 4. `tests/unit/policy/engine.test.ts` (12 new tests added to existing file)

**Why:** While the engine had 100% line coverage, there were no tests for context passing, timestamp injection, sequential evaluation order, approval channel propagation, or intent type variety.

**What was added:**
- Store passed correctly to rule context
- Injectable `now` timestamp passed through context
- Default `Date.now()` used when no timestamp provided
- Intent object passed to each rule
- First DENY wins when multiple rules deny
- Detailed DENY reason propagation
- Approval channel passed to context when provided
- Undefined approval when not configured
- Sequential (not parallel) rule evaluation verified
- PENDING stops evaluation like DENY
- Evaluation with all intent types
- Empty rule names list

### 5. `tests/unit/signers/local.test.ts` (9 new tests added to existing file)

**Why:** LocalSigner had only 33.33% line coverage. While the `sign()` body requires real Solana transactions to exercise fully, there were many untested scenarios for address generation and error handling.

**What was added:**
- Rejection of 'base' chain and empty string chain
- Different addresses from different keypairs
- Same address from same secret key (determinism)
- Address length between 32-44 characters (multi-sample)
- Base58 character set validation (no 0, O, I, l)
- Multiple healthCheck calls
- Error message includes the rejected chain name
- Optional description field in UnsignedTransaction

### 6. `tests/unit/core/wallet.test.ts` (8 new tests added to existing file)

**Why:** AgentWallet had 78.57% line coverage missing `getTransactionHistory()`, `toAnthropicTools()`, `toOpenAITools()`, optional config fields, and address determinism.

**What was added:**
- Deterministic address across calls
- `getTransactionHistory()` stub throws "Not implemented"
- `getTransactionHistory()` with custom limit throws "Not implemented"
- `toAnthropicTools()` throws "Not implemented"
- `toOpenAITools()` throws "Not implemented"
- Optional approval channel accepted in constructor
- Optional audit logger accepted in constructor
- Signer from config used for getAddress

### 7. `tests/unit/signers/mpc.test.ts` (5 tests) -- NEW FILE

**Why:** MPCSigner had 0% coverage. While it is a stub, confirming its contract (throws "not yet implemented", healthCheck returns false) ensures future implementations do not regress.

**What it tests:**
- Instantiation without errors
- `getAddress()` throws "not yet implemented"
- `sign()` throws "not yet implemented"
- `healthCheck()` returns false
- Different provider configurations accepted

### 8. `tests/unit/stores/sqlite.test.ts` (7 tests) -- NEW FILE

**Why:** SqliteStore had 0% coverage. Testing the stubs documents the expected interface contract for Sprint 3 implementation.

**What it tests:**
- Instantiation without errors
- All 5 Store interface methods throw "not yet implemented"
- `set()` with optional TTL parameter

### 9. `tests/unit/logging/audit.test.ts` (8 tests) -- NEW FILE

**Why:** AuditLogger had 0% coverage despite having actual implemented logic (not a stub). The `log()` and `getRecent()` methods delegate to the store and perform JSON serialization.

**What it tests:**
- Logging a single audit entry and retrieving it
- Multiple entries retrieved in reverse chronological order
- Count parameter respected in getRecent
- Default count of 10
- Empty result when no entries exist
- Full structure preservation through JSON roundtrip (including transactionResult)
- Policy decision details preserved (ALLOW, DENY with reasons)
- PENDING decision handling

### 10. `tests/unit/chains/solana-adapter.test.ts` (17 tests) -- NEW FILE

**Why:** SolanaAdapter had only 22.22% line coverage. The `isValidAddress()` method had implementation logic worth testing, and all stub methods needed contract verification.

**What it tests:**
- Instantiation and chain property
- Config with commitment and Jupiter API URL
- `isValidAddress()`: valid base58 addresses, invalid characters (0, O, I, l), too short, too long, empty string, special characters, Ethereum-style addresses
- All 5 stub methods throw "Not implemented"

### 11. `tests/unit/approval/telegram.test.ts` (4 tests) -- NEW FILE

**Why:** TelegramApprovalBot had 0% coverage.

**What it tests:**
- Instantiation without errors
- Name property is "telegram"
- `requestApproval()` throws "not yet implemented"
- Config with optional defaultTimeout

### 12. `tests/unit/policy/rules.test.ts` (11 tests) -- NEW FILE

**Why:** All 5 policy rule classes had 0% coverage. Testing stubs documents each rule's `name` property and current stub behavior.

**What it tests:**
- Each rule's `name` property matches expected value
- Each rule returns ALLOW (stub behavior) with various config options
- AllowlistRule accepts empty config

---

## Test Gaps Remaining

### Cannot Test in Sprint 0 (implementation deferred)

| Module | Gap | Sprint |
|--------|-----|--------|
| LocalSigner.sign() | Transaction signing with real Solana serialized transactions (lines 29-42 of local.ts) | Sprint 1 |
| SolanaAdapter methods | getBalance, getValueInUSD, buildTransaction, broadcast, getTransactionStatus | Sprint 3 |
| SqliteStore | All methods (currently stubs) | Sprint 3 |
| TelegramApprovalBot | requestApproval with real Telegram API | Sprint 4 |
| AI Adapters | claude.ts, openai.ts, langchain.ts (currently re-exports) | Sprint 5 |
| MPCSigner | getAddress, sign with real MPC provider | Phase 2 |

### Known Edge Cases Not Yet Covered

1. **MemoryStore.increment TTL preservation branch (line 47):** When an incremented key previously had a TTL, the code checks `entry.expiresAt` after the `get()` call. Because `get()` may delete the entry on expiration, there is a narrow branch where `entry` exists but `stored` does not after `set()`. This is a minor code path that requires precise timing to exercise.

2. **MemoryStore.getRecent with count=0:** Returns the full list due to `slice(-0) === slice(0)`. This is a JavaScript quirk, not a bug per se, but should be documented or guarded against in a future sprint.

3. **MemoryStore.increment with non-numeric value:** Returns NaN. The implementation does not guard against this. Consider adding input validation in a future sprint.

4. **PolicyBuilder validation is build-time only:** Invalid configurations can be constructed through the builder methods without error; validation only runs on `.build()`. This is by design but could lead to confusing error messages for users who chain many methods before building.

---

## Edge Cases Tested

| Category | Edge Case | Result |
|----------|-----------|--------|
| MemoryStore TTL | Zero TTL does not expire key (`ttlSeconds > 0` guard) | Pass |
| MemoryStore TTL | Negative TTL does not expire key | Pass |
| MemoryStore TTL | Overwrite TTL with no-TTL set | Pass |
| MemoryStore TTL | Lazy deletion on read (expired key cleaned up on get) | Pass |
| MemoryStore Increment | Increment by zero | Pass |
| MemoryStore Increment | First increment by zero (creates key at 0) | Pass |
| MemoryStore Increment | Very large values (MAX_SAFE_INTEGER) | Pass |
| MemoryStore Increment | Increment of expired key (treats as new) | Pass |
| MemoryStore Increment | Non-numeric existing value (returns NaN) | Pass |
| MemoryStore List | count=0 returns full array (JavaScript slice quirk) | Pass (documented) |
| MemoryStore List | count > list size returns all items | Pass |
| MemoryStore List | Empty string append | Pass |
| MemoryStore List | JSON roundtrip through append/getRecent | Pass |
| MemoryStore Keys | Special characters (:, /, .) in keys | Pass |
| MemoryStore Keys | Empty string key | Pass |
| MemoryStore Keys | KV store and list store are independent per key | Pass |
| PolicyBuilder | Zero spending amount rejected | Pass |
| PolicyBuilder | Whitespace-only token rejected | Pass |
| PolicyBuilder | Very small amount (0.0001) accepted | Pass |
| PolicyBuilder | Very large amount (999999999) accepted | Pass |
| PolicyBuilder | Time without leading zero rejected | Pass |
| PolicyBuilder | Invalid minutes (09:60) rejected | Pass |
| PolicyBuilder | Midnight boundaries (00:00 to 23:59) accepted | Pass |
| PolicyBuilder | Array inputs are copied (no shared references) | Pass |
| PolicyBuilder | Empty allow/deny lists accepted | Pass |
| PolicyBuilder | Zero approval timeout rejected | Pass |
| PolicyBuilder | NaN approval amount rejected | Pass |
| PolicyBuilder | Special characters in policy name accepted | Pass |
| PolicyBuilder | Very long policy name accepted | Pass |
| PolicyEngine | Injectable `now` timestamp passed to context | Pass |
| PolicyEngine | Default `Date.now()` used when no timestamp | Pass |
| PolicyEngine | PENDING stops evaluation (same as DENY) | Pass |
| PolicyEngine | Sequential evaluation order (not parallel) | Pass |
| PolicyEngine | Approval channel propagation | Pass |
| LocalSigner | Base58 address format (no 0, O, I, l) | Pass |
| LocalSigner | Address length 32-44 characters | Pass |
| LocalSigner | Deterministic address from same secret key | Pass |
| LocalSigner | Error message includes rejected chain name | Pass |
| SolanaAdapter | Ethereum-style address rejected | Pass |
| SolanaAdapter | Address too short/too long rejected | Pass |
| Intent guards | Each guard returns false for all non-matching types | Pass |
| Intent guards | Works with all optional fields present | Pass |

---

## Recommendations

### Immediate (Sprint 1)

1. **Fix `getRecent(count=0)` behavior:** Add a guard `if (count <= 0) return [];` to `MemoryStore.getRecent()` to avoid the `slice(-0)` quirk.

2. **Guard against non-numeric increment:** Add `if (isNaN(current))` check in `MemoryStore.increment()` and either throw or default to 0.

3. **Add integration tests for LocalSigner.sign():** Once Sprint 1 implements the execute flow with real Solana transactions, add tests for the versioned and legacy transaction signing paths (lines 29-42 of local.ts).

### Medium-term (Sprints 2-3)

4. **Test policy rule implementations:** When SpendingLimitRule, AllowlistRule, RateLimitRule, TimeWindowRule, and ApprovalGateRule get real implementations in Sprint 2, replace stub tests with comprehensive behavioral tests.

5. **Integration tests:** Add tests that wire AgentWallet with real PolicyEngine rules and MemoryStore to verify the full evaluate-sign-broadcast pipeline.

6. **SqliteStore tests:** When Sprint 3 implements SqliteStore, add tests verifying TTL expiration, concurrent access, and persistence across restarts.

### Long-term (Sprints 4-6)

7. **E2E tests:** Add end-to-end tests using Solana devnet for real transaction submission and confirmation.

8. **Approval flow tests:** Test the full human-in-the-loop flow with mock Telegram bot.

9. **AI adapter tests:** Verify tool definition formats match Anthropic, OpenAI, and LangChain schemas.

10. **Performance tests:** Benchmark MemoryStore under high-concurrency scenarios (hundreds of concurrent increments/appends) to identify race conditions in async operations.

---

## Test Execution Details

```
Test Runner: Vitest 4.0.18
Coverage Provider: v8
Environment: Node.js (macOS Darwin 24.6.0)
Total Duration: ~638ms (transform 528ms, tests 349ms)

Test Files: 12 passed (12)
Tests:      209 passed (209)
```
