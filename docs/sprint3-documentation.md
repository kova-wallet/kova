# Sprint 3 — Solana Chain Adapter Documentation

**Project:** kova
**Sprint:** 3 — Solana Chain Adapter (Real RPC Integration)
**Date:** 2026-02-11

---

## Overview

Sprint 3 replaces the mock `SolanaAdapter` with a real Solana RPC integration. After this sprint, agents can build, sign, and broadcast real SOL transfers, SPL token transfers, and Jupiter DEX swaps on Solana devnet. A persistent `SqliteStore` is also implemented for production-grade state storage.

---

## Architecture

### Transaction Pipeline

```
TransactionIntent
      │
      ▼
SolanaAdapter.buildTransaction()
      │
      ├─ transfer + SOL  → buildSOLTransfer()  → SystemProgram.transfer
      ├─ transfer + SPL  → buildSPLTransfer()  → createTransferInstruction + ATA
      └─ swap            → buildJupiterSwap()  → Jupiter V6 API → VersionedTransaction
      │
      ▼
UnsignedTransaction { chain: "solana", data: Uint8Array }
      │
      ▼
LocalSigner.sign()
      │
      ├─ VersionedTransaction.deserialize() → sign → serialize (Jupiter swaps)
      └─ Transaction.from()                 → sign → serialize (SOL/SPL transfers)
      │
      ▼
SolanaAdapter.broadcast()
      │
      └─ sendRawTransaction() → confirmTransaction() → txId
```

### Module Structure

```
src/chains/solana/
├── adapter.ts     — SolanaAdapter class (ChainAdapter implementation)
├── transfers.ts   — buildSOLTransfer, buildSPLTransfer, addPriorityFee
├── swaps.ts       — buildJupiterSwap, getTokenPriceUSD
├── utils.ts       — Token registry, amount conversion, validation, errors
└── index.ts       — Public re-exports
```

---

## API Reference

### SolanaAdapter

```typescript
import { SolanaAdapter } from "kova/chains/solana";

const adapter = new SolanaAdapter({
  rpcUrl: "https://api.devnet.solana.com",
  commitment: "confirmed",           // optional, default: "confirmed"
  jupiterApiUrl: "https://quote-api.jup.ag/v6",  // optional
  jupiterPriceApiUrl: "https://price.jup.ag/v2",  // optional
});
```

#### `getBalance(address, token)`

Returns the token balance for a wallet address.

- **SOL**: Queries native lamport balance via `connection.getBalance()`
- **SPL tokens**: Derives the Associated Token Account (ATA) and queries its balance
- Attempts USD pricing via Jupiter Price API (non-fatal on failure)
- Throws `INVALID_ADDRESS` for invalid Solana addresses
- Throws `INVALID_TOKEN` for unrecognized token symbols

```typescript
const balance = await adapter.getBalance("7xKX...AsU", "SOL");
// { token: "SOL", amount: "1.5", decimals: 9, usdValue: 225.50 }
```

#### `getValueInUSD(token, amount)`

Returns the USD value of a token amount.

- Queries Jupiter Price API v2
- Falls back to $1 for USDC/USDT (stablecoin assumption)
- Throws `PRICE_UNAVAILABLE` for unknown tokens when API is unreachable (fail-closed)

```typescript
const usd = await adapter.getValueInUSD("USDC", "100.0");
// 100.0 (stablecoin fallback)
```

#### `buildTransaction(intent, signerAddress)`

Builds an unsigned transaction from a `TransactionIntent`.

| Intent Type | Token | Delegated To |
|------------|-------|-------------|
| `transfer` | SOL | `buildSOLTransfer()` |
| `transfer` | USDC, USDT, etc. | `buildSPLTransfer()` |
| `swap` | any | `buildJupiterSwap()` |
| `mint`, `stake`, `custom` | — | Throws `UNSUPPORTED_INTENT` |

Returns `UnsignedTransaction { chain: "solana", data: Uint8Array, description: string }`.

#### `broadcast(signedTxData)`

Broadcasts a signed transaction to the Solana network.

- Calls `connection.sendRawTransaction()` with preflight checks
- Waits for confirmation via `connection.confirmTransaction()`
- Returns the transaction signature (txId)
- Throws `BROADCAST_FAILED` on failure

#### `getTransactionStatus(txId)`

Queries the confirmation status of a transaction.

- Returns `{ status: "finalized" | "confirmed" | "failed" | "not_found", txId, error? }`
- Throws `STATUS_CHECK_FAILED` on RPC communication errors

#### `isValidAddress(address)`

Validates a Solana address using `PublicKey` parsing from `@solana/web3.js`.

---

## Token Support

### Registry

| Symbol | Mainnet Mint | Devnet Mint | Decimals |
|--------|-------------|-------------|----------|
| SOL | `So1111...1112` | `So1111...1112` | 9 |
| USDC | `EPjFWd...Dt1v` | `4zMMC9...ncDU` | 6 |
| USDT | `Es9vMF...wNYB` | — | 6 |

### Raw Mint Addresses

When the token is not in the registry, `resolveTokenMint()` attempts to parse it as a raw base58 mint address. This allows agents to work with any SPL token by providing the mint directly.

For transfers, the decimals must be in the registry (throws `UNKNOWN_DECIMALS` for unknown tokens). For swaps, Jupiter handles decimal resolution, but the SDK still requires known decimals for amount calculation (also throws `UNKNOWN_DECIMALS`).

---

## Amount Conversion

All amount conversion uses BigInt-safe string arithmetic to avoid floating-point precision issues:

```typescript
import { toSmallestUnit, fromSmallestUnit } from "kova/chains/solana";

// Human-readable → smallest unit (lamports, micro-tokens)
toSmallestUnit("1.5", 9);    // 1_500_000_000n (SOL → lamports)
toSmallestUnit("100.0", 6);  // 100_000_000n (USDC → micro-USDC)

// Smallest unit → human-readable
fromSmallestUnit(1_500_000_000n, 9);  // "1.5"
fromSmallestUnit(100_000_000n, 6);    // "100"
```

**Validation**: `toSmallestUnit` rejects:
- Negative amounts (`"-1"`)
- Zero amounts (`"0"`)
- Malformed strings (`"abc"`, `".5"`, `"1.2.3"`)
- Only accepts positive decimal numbers matching `/^\d+(\.\d+)?$/`

---

## SOL Transfers

```typescript
// Built internally by adapter.buildTransaction()
const unsignedTx = await adapter.buildTransaction({
  type: "transfer",
  chain: "solana",
  params: { to: "7xKX...AsU", amount: "0.1", token: "SOL" }
}, signerAddress);
```

**Implementation details:**
- Uses `SystemProgram.transfer` with BigInt lamports (no `Number()` truncation)
- Adds priority fee instructions via `ComputeBudgetProgram`
- Fetches latest blockhash and sets fee payer
- Serializes with `{ requireAllSignatures: false }` for unsigned output

---

## SPL Token Transfers

```typescript
const unsignedTx = await adapter.buildTransaction({
  type: "transfer",
  chain: "solana",
  params: { to: "7xKX...AsU", amount: "50.0", token: "USDC" }
}, signerAddress);
```

**Implementation details:**
- Resolves token symbol to mint address via registry
- Derives sender and recipient Associated Token Accounts (ATAs)
- If recipient ATA doesn't exist, adds `createAssociatedTokenAccountInstruction` (sender pays ~0.002 SOL rent)
- Distinguishes "ATA not found" from actual RPC errors (doesn't mask failures)
- Uses `createTransferInstruction` with BigInt amount

---

## Jupiter Swaps

```typescript
const unsignedTx = await adapter.buildTransaction({
  type: "swap",
  chain: "solana",
  params: {
    fromToken: "SOL",
    toToken: "USDC",
    amount: "1.0",
    maxSlippage: 0.005  // 0.5% (50 bps)
  }
}, signerAddress);
```

**Implementation details:**
1. Resolves token symbols to mint addresses
2. `GET /quote` from Jupiter V6 API with inputMint, outputMint, amount in smallest unit, slippageBps
3. `POST /swap` with the quote, returning a base64-encoded `VersionedTransaction`
4. Decodes and verifies the `VersionedTransaction` before returning
5. `LocalSigner` handles `VersionedTransaction` natively (deserialize → sign → re-serialize)

**Error handling:**
- `JUPITER_QUOTE_FAILED`: Quote API returned non-200 (error body truncated to 200 chars)
- `JUPITER_SWAP_FAILED`: Swap API returned non-200
- `JUPITER_DESERIALIZE_FAILED`: Returned transaction couldn't be deserialized
- `UNKNOWN_DECIMALS`: Token not in registry (no silent fallback)

---

## SqliteStore

Persistent key-value and list storage using `better-sqlite3`.

```typescript
import { SqliteStore } from "kova/stores/sqlite";

const store = new SqliteStore({ path: "./wallet-data.db" });
// or for in-memory (testing):
const store = new SqliteStore({ path: ":memory:" });
```

### Schema

```sql
CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER);
CREATE TABLE lists (key TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL,
                    id INTEGER PRIMARY KEY AUTOINCREMENT);
CREATE INDEX idx_lists_key_id ON lists(key, id DESC);
```

### Features

- **WAL journal mode** for concurrent read performance
- **5-second busy timeout** for lock contention handling
- **Lazy TTL expiration**: expired keys deleted on read
- **Atomic increment**: uses `db.transaction()` for serializable read-modify-write
- **MemoryStore parity**: identical interface semantics, verified by 11 parity tests

### Methods

| Method | Behavior |
|--------|----------|
| `get(key)` | Returns value or null. Deletes expired keys lazily. |
| `set(key, value, ttlSeconds?)` | `INSERT OR REPLACE` with optional expiry timestamp |
| `increment(key, amount)` | Atomic read-modify-write via `db.transaction()`. Treats non-numeric values as 0. |
| `append(key, value)` | Inserts into `lists` table with auto-incrementing ID |
| `getRecent(key, count)` | Returns newest entries first via `ORDER BY id DESC LIMIT ?` |
| `clear()` | Drops all data from both tables |
| `close()` | Closes the database connection |

---

## Priority Fees

The `addPriorityFee` function queries recent prioritization fees and sets:
- **Compute unit price**: Median of recent fees (minimum 1000 micro-lamports/CU)
- **Compute unit limit**: 200,000 CUs (appropriate for transfers and swaps)

Silently no-ops on failure — safe for devnet where fees are negligible.

---

## Error Handling

All Solana-specific errors use `SolanaAdapterError` with structured error codes:

| Code | Description |
|------|-------------|
| `INVALID_ADDRESS` | Invalid Solana address format |
| `INVALID_TOKEN` | Unknown token symbol or mint |
| `INVALID_AMOUNT` | Negative, zero, or malformed amount |
| `UNKNOWN_DECIMALS` | Can't determine token decimals |
| `UNSUPPORTED_INTENT` | Intent type not supported (mint, stake, custom) |
| `PRICE_UNAVAILABLE` | Jupiter Price API unreachable for non-stablecoin |
| `BROADCAST_FAILED` | Transaction broadcast or confirmation failed |
| `STATUS_CHECK_FAILED` | RPC error during transaction status query |
| `JUPITER_QUOTE_FAILED` | Jupiter quote API error |
| `JUPITER_SWAP_FAILED` | Jupiter swap API error |
| `JUPITER_DESERIALIZE_FAILED` | Invalid transaction from Jupiter |
| `RPC_ERROR` | Generic RPC communication failure |

---

## Security Considerations

### Fixed in Sprint 3

1. **BigInt truncation (S3-01)**: Transfer amounts passed as `bigint` directly, not `Number()` — prevents silent fund loss for amounts > 2^53
2. **Amount validation (S3-02)**: `toSmallestUnit` rejects negative, zero, and malformed inputs
3. **ATA error handling (S3-03)**: Distinguishes "account not found" from RPC errors — prevents masking failures
4. **Decimal safety (S3-05)**: Unknown tokens throw instead of silently defaulting to 9 decimals
5. **Error sanitization (S3-08)**: Jupiter API error bodies truncated before inclusion in errors
6. **Status error propagation (S3-11)**: RPC errors propagated instead of masked as "not_found"

### Known Limitations (Deferred)

- Jupiter API URLs are not validated against an allowlist (S3-04)
- Devnet detection uses URL string matching, not explicit config (S3-07)
- Spending counters in SqliteStore use floating-point arithmetic (S3-09)
- No HTTPS enforcement on RPC URL (S3-10)

---

## Test Summary

| Test File | Count | Focus |
|-----------|-------|-------|
| solana-utils.test.ts | 57 | Token registry, amount conversion, address validation, ATA, errors |
| solana-adapter.test.ts | 39 | Constructor, isValidAddress, getValueInUSD fallback, error paths |
| sqlite.test.ts | 54 | CRUD, TTL, increment, append/getRecent, concurrency, MemoryStore parity |
| **Sprint 3 total** | **150** | |
| **Project total** | **536** | All passing |
