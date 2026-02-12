# Sprint 3 — Results

**Project:** kova
**Sprint:** 3 — Solana Chain Adapter (Real RPC Integration)
**Date:** 2026-02-11

---

## Summary

Sprint 3 replaces the mock SolanaAdapter with real Solana RPC integration via `@solana/web3.js`, adds Jupiter V6 swap support, Jupiter Price API for USD valuation, and implements `SqliteStore` for persistent state. All code compiles cleanly and all 536 tests pass.

### Deliverables

| Deliverable | Status |
|------------|--------|
| Token registry + amount conversion (utils.ts) | Implemented |
| SOL transfer builder (transfers.ts) | Implemented |
| SPL token transfer builder (transfers.ts) | Implemented |
| Priority fee estimation (transfers.ts) | Implemented |
| Jupiter swap integration (swaps.ts) | Implemented |
| Jupiter USD pricing (swaps.ts) | Implemented |
| SolanaAdapter real RPC (adapter.ts) | Implemented |
| SqliteStore with better-sqlite3 (sqlite.ts) | Implemented |
| Security audit | 16 findings (1C, 3H, 5M, 4L, 3I) |
| QA testing | 536 tests, 107 new, all passing |
| Security fixes applied | 6 fixes from audit |

---

## Security Audit Findings (16 total)

### Fixes Applied in Sprint 3

| ID | Severity | Finding | Fix |
|----|----------|---------|-----|
| S3-01 | CRITICAL | `Number(lamports)` truncation for large transfers | Pass `bigint` directly to `SystemProgram.transfer` and `createTransferInstruction` — both accept `bigint` natively |
| S3-02 | HIGH | `toSmallestUnit` accepts negative/zero/malformed amounts | Added regex validation (`/^\d+(\.\d+)?$/`) and `result <= 0n` guard |
| S3-03 | HIGH | Blanket catch in ATA existence check masks RPC errors | Distinguish `TokenAccountNotFoundError` from other errors; re-throw `SolanaAdapterError("RPC_ERROR")` for actual failures |
| S3-05 | MEDIUM | Silent fallback to 9 decimals for unknown tokens in swap | Throw `SolanaAdapterError("UNKNOWN_DECIMALS")` instead of silently defaulting — consistent with transfer path |
| S3-08 | MEDIUM | Jupiter error responses may leak sensitive information | Truncate error bodies to 200 chars before including in thrown error |
| S3-11 | LOW | `getTransactionStatus` swallows all errors as `not_found` | Throw `SolanaAdapterError("STATUS_CHECK_FAILED")` for RPC errors instead of masking them |

### Deferred to Sprint 4+

| ID | Severity | Finding | Reason |
|----|----------|---------|--------|
| S3-04 | HIGH | SSRF via user-controlled Jupiter API URLs | Requires allowlist design decision — currently only set by SDK consumer, not agents |
| S3-06 | MEDIUM | Token impersonation via raw mint address bypasses symbol-based policy | Requires policy layer to operate on resolved mint addresses — architectural change |
| S3-07 | MEDIUM | Devnet detection via `includes("devnet")` is fragile | Needs explicit `network` config field — breaking API change |
| S3-09 | MEDIUM | Floating-point in spending counters (SqliteStore increment) | Needs integer-scaled counter migration — cross-cutting with policy engine |
| S3-10 | LOW | No HTTPS enforcement on RPC URL | Low risk for devnet; needs localhost exception logic for dev |
| S3-12 | LOW | SqliteStore database path not validated | Path is SDK-consumer controlled, not agent-controlled |
| S3-13 | LOW | `addPriorityFee` silently swallows all errors | By design for devnet; needs configurable fallback fee for mainnet |
| S3-14 | INFO | Token registry is hardcoded and not extensible | Feature request for Sprint 4+ |
| S3-15 | INFO | `broadcast` uses `getLatestBlockhash` after send for confirmation | Standard Solana pattern — no change needed |
| S3-16 | INFO | Module re-exports expose internal implementation details | Design decision — useful for advanced consumers |

---

## QA Test Results

- **Total tests:** 536
- **Passing:** 536
- **New tests added:** 107 (57 in solana-utils.test.ts, 39 in solana-adapter.test.ts, 54 in sqlite.test.ts, minus 43 replaced from old mock-based tests)
- **Coverage areas:** Token registry, amount conversion, address validation, ATA derivation, adapter constructor/error paths, stablecoin fallback, SqliteStore CRUD + TTL + concurrency + MemoryStore parity

### Test Distribution

| File | Tests |
|------|-------|
| rules.test.ts | 92 |
| wallet.test.ts | 123 |
| solana-utils.test.ts | 57 |
| sqlite.test.ts | 54 |
| builder.test.ts | 56 |
| solana-adapter.test.ts | 39 |
| memory.test.ts | 38 |
| audit.test.ts | 19 |
| intent.test.ts | 18 |
| engine.test.ts | 18 |
| local.test.ts | 13 |
| mpc.test.ts | 5 |
| telegram.test.ts | 4 |

---

## Files Modified

### New/Rewritten

- `src/chains/solana/utils.ts` — 122 lines, token registry, BigInt amount conversion, address validation, error class
- `src/chains/solana/transfers.ts` — 209 lines, SOL + SPL transfer builders, priority fee estimation, ATA auto-creation
- `src/chains/solana/swaps.ts` — 168 lines, Jupiter V6 swap integration, USD pricing via Jupiter Price API v2
- `src/chains/solana/adapter.ts` — 263 lines, real RPC integration via `@solana/web3.js` Connection
- `src/stores/sqlite.ts` — 136 lines, better-sqlite3 with WAL mode, parameterized SQL, atomic increment
- `tests/unit/chains/solana-utils.test.ts` — 57 tests, comprehensive utils coverage
- `tests/unit/chains/solana-adapter.test.ts` — 39 tests, rewritten for real adapter
- `tests/unit/stores/sqlite.test.ts` — 54 tests, full CRUD + TTL + concurrency + parity

### Modified

- `src/chains/solana/index.ts` — Updated re-exports for all new modules
- `package.json` — Added `better-sqlite3` + `@types/better-sqlite3` dependencies

---

## Key Design Decisions

1. **BigInt-safe amount conversion**: `toSmallestUnit("0.1", 9)` → `100_000_000n` exactly (string-based, no float precision issues)
2. **Unsigned transaction pipeline**: `buildTransaction()` → `Uint8Array` → `LocalSigner.sign()` → `broadcast()` — no changes to wallet.ts or signer interface needed
3. **VersionedTransaction support**: Jupiter returns VersionedTransaction; LocalSigner already handles both legacy and versioned
4. **Stablecoin price fallback**: $1 for USDC/USDT when Jupiter Price API is down; throw for unknown tokens (fail-closed)
5. **SqliteStore mirrors MemoryStore**: Identical interface semantics, lazy TTL expiration, `getRecent()` returns newest-first

---

## What's Next (Sprint 4)

Per the implementation plan, Sprint 4 addresses the Signer layer:
- MPC signer implementation with threshold signatures
- Key derivation and secure storage
- Address S3-04 (SSRF URL validation) and S3-07 (explicit network config)
- Address S2-01 CRITICAL (cross-token spending limit bypass via USD normalization)
