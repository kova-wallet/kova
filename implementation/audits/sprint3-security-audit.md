# Sprint 3 -- Security Audit Report

**Date:** 2026-02-11
**Auditor:** Kai (Security Engineer)
**Scope:** Real Solana RPC integration replacing the mock SolanaAdapter -- `utils.ts`, `transfers.ts`, `swaps.ts`, `adapter.ts`, `sqlite.ts`, `index.ts`

---

## Summary

Sprint 3 replaces the mock SolanaAdapter with real Solana RPC integration via `@solana/web3.js`, adds Jupiter DEX swap support, and introduces a persistent `SqliteStore`. The implementation delegates cleanly across focused modules (utils, transfers, swaps, adapter). Overall the code demonstrates solid engineering practices: parameterized SQL, BigInt-based amount arithmetic, proper error typing, and fail-closed behavior for pricing failures. However, there are several significant issues, most notably around unsafe `BigInt`-to-`Number` truncation on transfer amounts, missing validation of negative/zero amounts, a TOCTOU race condition in ATA creation, and potential SSRF through user-controlled API URLs.

### Finding Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 1     |
| HIGH     | 3     |
| MEDIUM   | 5     |
| LOW      | 4     |
| INFO     | 3     |
| **Total** | **16** |

---

## Findings

---

### S3-01 [CRITICAL]: BigInt-to-Number Truncation Causes Silent Fund Loss on Large Transfers

**File:** `src/chains/solana/transfers.ts:55` and `src/chains/solana/transfers.ts:141`

**Description:** Both `buildSOLTransfer` (line 55) and `buildSPLTransfer` (line 141) convert the BigInt lamport amount to `Number()` before passing it to Solana instructions:

```typescript
// transfers.ts:55
lamports: Number(lamports),

// transfers.ts:141
createTransferInstruction(senderATA, recipientATA, sender, Number(amount)),
```

JavaScript's `Number` type uses IEEE 754 double-precision floats, which can only safely represent integers up to `2^53 - 1` (9,007,199,254,740,991). For SOL (9 decimals), this caps out at approximately 9,007,199.254 SOL (~$1.35B at current prices). For SPL tokens with 6 decimals, the safe range is approximately 9,007,199,254 tokens. Amounts beyond `Number.MAX_SAFE_INTEGER` will be silently truncated or rounded, causing the transaction to transfer an incorrect amount.

While these thresholds are extremely high and unlikely to be reached in a devnet MVP, `SystemProgram.transfer` accepts `number | bigint` for lamports, and `createTransferInstruction` accepts `number | bigint` for amount. Passing `bigint` directly would be both correct and zero-cost.

**Impact:** If a transfer amount exceeds `Number.MAX_SAFE_INTEGER` in smallest units, the actual transferred amount will be silently wrong. An agent transferring a very large amount could lose funds or transfer less than intended. This is the most dangerous class of bug in financial software -- silent incorrect arithmetic.

**Recommendation:** Pass the `bigint` values directly without converting to `Number`:

```typescript
// transfers.ts:55
lamports: lamports,  // bigint is accepted by SystemProgram.transfer

// transfers.ts:141
createTransferInstruction(senderATA, recipientATA, sender, amount),  // bigint accepted
```

---

### S3-02 [HIGH]: No Validation of Negative, Zero, or Malformed Amounts

**File:** `src/chains/solana/utils.ts:60-65`, `src/chains/solana/transfers.ts:36-76`, `src/chains/solana/swaps.ts:46-133`

**Description:** The `toSmallestUnit` function does not validate its input for:
- Negative amounts (e.g., `"-1.5"`) -- `BigInt("-1" + "500000000")` will produce `-1500000000n`, a negative value
- Zero amounts (e.g., `"0"`) -- produces `0n`, creating a zero-value transfer
- Non-numeric strings (e.g., `"abc"`) -- `BigInt("abc")` will throw an unhandled exception
- Multiple decimal points (e.g., `"1.2.3"`) -- `split(".")` produces 3 parts, the third is silently ignored, but behavior is undefined
- Empty strings (e.g., `""`) -- `BigInt("")` throws
- Extremely long strings -- could be used for DoS via BigInt computation

Neither `buildSOLTransfer`, `buildSPLTransfer`, nor `buildJupiterSwap` validate that the amount is positive and well-formed before calling `toSmallestUnit`.

**Impact:**
- Negative amounts could create transactions that fail on-chain with confusing errors or, depending on the Solana runtime's handling of negative values after `Number()` conversion, could create unexpected behavior.
- Zero-amount transfers waste SOL on transaction fees with no value transferred.
- Malformed strings cause unhandled exceptions that crash the calling process.

**Recommendation:** Add input validation to `toSmallestUnit`:

```typescript
export function toSmallestUnit(amount: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(amount)) {
    throw new SolanaAdapterError("INVALID_AMOUNT", `Invalid amount: "${amount}". Must be a positive decimal number.`);
  }
  const result = BigInt(whole + fractional);
  if (result <= 0n) {
    throw new SolanaAdapterError("INVALID_AMOUNT", `Amount must be positive, got: ${amount}`);
  }
  return result;
}
```

Also validate at the `buildSOLTransfer` / `buildSPLTransfer` / `buildJupiterSwap` level as defense-in-depth.

---

### S3-03 [HIGH]: TOCTOU Race Condition in ATA Check-Then-Create

**File:** `src/chains/solana/transfers.ts:119-133`

**Description:** The SPL transfer checks whether the recipient's Associated Token Account (ATA) exists by calling `getAccount()`, and if it throws, adds a `createAssociatedTokenAccountInstruction` to the transaction:

```typescript
try {
  await getAccount(connection, recipientATA);
} catch {
  // ATA doesn't exist -- sender pays for creation
  transaction.add(createAssociatedTokenAccountInstruction(...));
}
```

This is a Time-of-Check-to-Time-of-Use (TOCTOU) race condition. Between the `getAccount()` check and the transaction being executed on-chain:
1. Another transaction could create the ATA, causing the create instruction to fail (though `createAssociatedTokenAccountInstruction` is typically idempotent on-chain).
2. More critically, `getAccount()` could fail for reasons other than a non-existent account (network timeout, RPC error, rate limiting), and the blanket `catch` treats **all** failures as "ATA doesn't exist," potentially adding an unnecessary create instruction.

**Impact:** The blanket catch block masks RPC errors. If the RPC node is overloaded and returns an error, the code will always add the ATA creation instruction, which is wasteful (sender pays ~0.002 SOL rent) but not catastrophic since the on-chain program is idempotent for ATA creation. However, this could lead to unnecessary costs for the sender.

**Recommendation:** Distinguish between "account not found" errors and other RPC errors:

```typescript
import { TokenAccountNotFoundError } from "@solana/spl-token";

try {
  await getAccount(connection, recipientATA);
} catch (err) {
  if (err instanceof TokenAccountNotFoundError ||
      (err instanceof Error && err.name === "TokenAccountNotFoundError")) {
    transaction.add(createAssociatedTokenAccountInstruction(...));
  } else {
    throw new SolanaAdapterError("RPC_ERROR", `Failed to check recipient ATA: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

---

### S3-04 [HIGH]: User-Controlled Jupiter API URL Enables SSRF

**File:** `src/chains/solana/swaps.ts:46-51`, `src/chains/solana/adapter.ts:27-36`

**Description:** The `jupiterApiUrl` and `jupiterPriceApiUrl` are configurable via `SolanaAdapterConfig` and passed directly into `fetch()` calls:

```typescript
// swaps.ts:78
const quoteResponse = await fetch(quoteUrl.toString());

// swaps.ts:89
const swapResponse = await fetch(`${jupiterApiUrl}/swap`, { ... });

// swaps.ts:151
const response = await fetch(url.toString());
```

If an agent or untrusted configuration source can set these URLs, it becomes a Server-Side Request Forgery (SSRF) vector. An attacker could set `jupiterApiUrl` to `http://169.254.169.254/latest/meta-data/` (AWS metadata endpoint) or `http://localhost:8080/admin` to probe internal services.

**Impact:** If configuration is sourced from untrusted input (e.g., agent-provided config), an attacker can make the wallet SDK send HTTP requests to arbitrary internal services, potentially exfiltrating cloud credentials or probing internal APIs.

**Recommendation:** Validate API URLs against an allowlist of known Jupiter API domains:

```typescript
const ALLOWED_JUPITER_HOSTS = ["quote-api.jup.ag", "price.jup.ag", "api.jup.ag"];

function validateApiUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new SolanaAdapterError("INVALID_CONFIG", "API URL must use HTTPS");
  if (!ALLOWED_JUPITER_HOSTS.includes(parsed.hostname)) {
    throw new SolanaAdapterError("INVALID_CONFIG", `Untrusted API host: ${parsed.hostname}`);
  }
}
```

---

### S3-05 [MEDIUM]: Unvalidated Token Decimals Fallback to 9 in Swap Path

**File:** `src/chains/solana/swaps.ts:64-65`

**Description:** When building a Jupiter swap, if the token is not in the registry, the code falls back to 9 decimals:

```typescript
const fromDecimals = getTokenDecimals(params.fromToken, isDevnet) ?? 9;
```

If a user provides a raw mint address for a token with 6 decimals (e.g., USDC on a non-registered network), the code would use 9 decimals instead, inflating the amount by 1000x. For example, swapping "1.0" of a 6-decimal token would compute `1000000000` instead of `1000000`, sending 1000x more tokens to Jupiter.

**Impact:** Incorrect decimal assumption could cause the user to sell 1000x more tokens than intended, resulting in significant financial loss.

**Recommendation:** Either refuse to swap unknown tokens without explicit decimal specification, or query the token's mint account on-chain to retrieve the actual decimals:

```typescript
const fromDecimals = getTokenDecimals(params.fromToken, isDevnet);
if (fromDecimals === null) {
  throw new SolanaAdapterError(
    "UNKNOWN_DECIMALS",
    `Cannot determine decimals for ${params.fromToken}. Use a known symbol or provide decimals.`
  );
}
```

Note that the transfer path (`buildSPLTransfer`) correctly rejects unknown decimals (line 100-105). The swap path should be consistent.

---

### S3-06 [MEDIUM]: Token Impersonation via Registry Collision

**File:** `src/chains/solana/utils.ts:34-44`

**Description:** The `resolveTokenMint` function first checks the symbol registry, then falls back to parsing the input as a raw mint address:

```typescript
const entry = registry[token.toUpperCase()];
if (entry) return new PublicKey(entry.mint);
try { return new PublicKey(token); } catch { return null; }
```

This means a user cannot override the registry by passing a raw mint address that collides with a known symbol. However, the risk is reversed: if an agent passes a token string like `"USDC"`, the code will always use the hardcoded mint. An attacker who controls the `token` field in a `TransferParams` could provide an arbitrary mint address (any valid base58 string) that gets resolved as a legitimate token, bypassing any allowlist that operates on symbol names.

**Impact:** If policy rules are based on token symbols (e.g., "only allow USDC transfers"), an attacker could bypass them by providing a raw mint address of any arbitrary token. The policy layer would need to resolve mint addresses to verify against allowlists.

**Recommendation:** If token allowlisting is implemented in the policy layer, ensure it operates on resolved mint addresses (not just symbols). Consider adding a `resolvedMint` field to the transaction description for policy evaluation.

---

### S3-07 [MEDIUM]: Devnet Detection via String Matching is Fragile

**File:** `src/chains/solana/utils.ts:111-113`

**Description:** The `isDevnetUrl` function uses a simple `includes("devnet")` check:

```typescript
export function isDevnetUrl(rpcUrl: string): boolean {
  return rpcUrl.includes("devnet");
}
```

This is fragile and can produce incorrect results:
- A custom RPC at `https://my-devnet-proxy.company.com/mainnet` would be detected as devnet
- A devnet URL like `https://rpc.example.com/?network=dev` would NOT be detected as devnet
- An attacker could craft a URL like `https://mainnet.example.com/devnet-bypass` to trick the system into using devnet token mints on mainnet

**Impact:** Incorrect network detection would cause the adapter to use wrong token mint addresses (devnet mints on mainnet or vice versa), which could cause transactions to fail or, worse, interact with the wrong tokens.

**Recommendation:** Use explicit configuration rather than URL-sniffing:

```typescript
export interface SolanaAdapterConfig {
  rpcUrl: string;
  network: "mainnet-beta" | "devnet" | "testnet";
  // ...
}
```

---

### S3-08 [MEDIUM]: Jupiter Error Responses May Leak Sensitive Information

**File:** `src/chains/solana/swaps.ts:80-84`, `src/chains/solana/swaps.ts:101-106`

**Description:** When Jupiter API calls fail, the full response body is included in the error message:

```typescript
const body = await quoteResponse.text();
throw new SolanaAdapterError(
  "JUPITER_QUOTE_FAILED",
  `Jupiter quote failed (${quoteResponse.status}): ${body}`,
);
```

The Jupiter API could return error bodies containing internal state, routing information, or debug data. If these errors propagate to an agent or logging system, they could leak information about the system's configuration or trading strategy.

**Impact:** Error messages containing full API response bodies could leak internal Jupiter routing details, rate limit state, or other operational information to agents or external logging systems.

**Recommendation:** Truncate error bodies and sanitize before including in error messages:

```typescript
const body = (await quoteResponse.text()).slice(0, 200);
throw new SolanaAdapterError(
  "JUPITER_QUOTE_FAILED",
  `Jupiter quote failed with status ${quoteResponse.status}`,
);
```

Log the full body internally if needed for debugging, but do not include it in the thrown error.

---

### S3-09 [MEDIUM]: SqliteStore `increment` Uses Floating-Point Parsing for Counter Values

**File:** `src/stores/sqlite.ts:88`

**Description:** The `increment` method uses `parseFloat` to read the current counter value:

```typescript
const parsed = parseFloat(existing.value);
current = isNaN(parsed) ? 0 : parsed;
```

And then performs floating-point addition:

```typescript
const newValue = current + amount;
```

Since `increment` is used for spending limit counters (per the Store interface documentation), this means spending amounts are subject to floating-point precision errors. For example, `0.1 + 0.2 = 0.30000000000000004` in JavaScript. Over many increments, these errors could accumulate and either allow a user to slightly exceed their spending limit or slightly under-count.

**Impact:** Floating-point arithmetic errors in spending counters could cause limits to be slightly inaccurate. In the worst case, accumulated rounding errors could allow marginal limit bypass over many transactions.

**Recommendation:** For a devnet MVP this is acceptable, but for production consider storing counter values as integer-scaled amounts (e.g., lamports or micro-dollars) and using integer arithmetic throughout the counter path.

---

### S3-10 [LOW]: No HTTPS Enforcement on RPC URL

**File:** `src/chains/solana/adapter.ts:44-51`

**Description:** The `SolanaAdapter` constructor accepts any `rpcUrl` without validating the protocol:

```typescript
constructor(config: SolanaAdapterConfig) {
  this.connection = new Connection(config.rpcUrl, config.commitment ?? "confirmed");
}
```

An HTTP (non-TLS) RPC URL would transmit all transaction data, including signed transactions, in plaintext. This is especially dangerous because signed transactions contain the signature itself, which an eavesdropper could observe and potentially front-run.

**Impact:** If an HTTP URL is used, network eavesdroppers could observe transaction data, wallet addresses, and signed transaction content in transit.

**Recommendation:** Validate that the RPC URL uses HTTPS (with an exception for `localhost` / `127.0.0.1` for local development):

```typescript
const url = new URL(config.rpcUrl);
if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
  throw new SolanaAdapterError("INVALID_CONFIG", "RPC URL must use HTTPS");
}
```

---

### S3-11 [LOW]: `getTransactionStatus` Swallows All Errors as `not_found`

**File:** `src/chains/solana/adapter.ts:252-254`

**Description:** The `getTransactionStatus` method catches all errors and returns `not_found`:

```typescript
} catch {
  return { status: "not_found", txId };
}
```

This masks RPC failures, network issues, and other operational problems. If the RPC is down, all status queries will report "not_found" instead of raising an error, giving a false impression that transactions were never submitted.

**Impact:** Silent masking of RPC errors could lead to agents believing their transactions never went through, potentially causing them to resubmit transactions. This could lead to double-spending from the agent's perspective.

**Recommendation:** Distinguish between "transaction genuinely not found" and "RPC communication failure":

```typescript
} catch (err) {
  throw new SolanaAdapterError(
    "STATUS_CHECK_FAILED",
    `Failed to check transaction status: ${err instanceof Error ? err.message : String(err)}`
  );
}
```

---

### S3-12 [LOW]: SqliteStore Database Path Not Validated

**File:** `src/stores/sqlite.ts:22-27`

**Description:** The `SqliteStore` constructor accepts any filesystem path without validation:

```typescript
constructor(config: SqliteStoreConfig) {
  this.db = new Database(config.path);
}
```

If the path is sourced from untrusted input, this could be used for path traversal (e.g., `../../../etc/important-file`) or to create database files in unexpected locations.

**Impact:** An attacker who controls the database path could create or overwrite files at arbitrary filesystem locations, limited by the process's file permissions.

**Recommendation:** Validate that the path is within an expected directory and doesn't contain path traversal sequences:

```typescript
import path from "path";
if (config.path !== ":memory:") {
  const resolved = path.resolve(config.path);
  if (!resolved.startsWith(expectedDataDir)) {
    throw new Error(`Database path must be within ${expectedDataDir}`);
  }
}
```

---

### S3-13 [LOW]: `addPriorityFee` Silently Ignores All Errors

**File:** `src/chains/solana/transfers.ts:196-198`

**Description:** The `addPriorityFee` function wraps its entire body in a try-catch that silently swallows all errors:

```typescript
} catch {
  // Fee estimation failure is non-fatal
}
```

While the comment explains the rationale (devnet fees are negligible), on mainnet this means transactions could be submitted with no priority fee, causing them to be stuck or dropped during congestion periods.

**Impact:** On mainnet during congestion, transactions without priority fees may fail to land, causing user frustration and potential resubmission loops.

**Recommendation:** Log the failure (even at debug level) so operators can diagnose fee estimation issues. Consider making the fallback fee configurable:

```typescript
} catch (err) {
  console.warn("Priority fee estimation failed, using default:", err);
  transaction.add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: DEFAULT_PRIORITY_FEE }),
  );
}
```

---

### S3-14 [INFO]: Token Registry is Hardcoded and Not Extensible

**File:** `src/chains/solana/utils.ts:11-21`

**Description:** The `TOKEN_MINTS` and `DEVNET_TOKEN_MINTS` registries are hardcoded constants with only SOL, USDC, and USDT. Any new token requires a code change and redeployment. The devnet registry only has SOL and USDC, so USDT is not available on devnet.

**Impact:** Limited token support. Agents wanting to use tokens not in the registry must provide raw mint addresses, and they will lose decimal-resolution support (which defaults to 9 in swaps per S3-05 and null in transfers).

**Recommendation:** Consider making the token registry configurable via `SolanaAdapterConfig`, or support on-chain mint account queries to dynamically resolve decimals.

---

### S3-15 [INFO]: `broadcast` Uses `getLatestBlockhash` After Send for Confirmation

**File:** `src/chains/solana/adapter.ts:203-208`

**Description:** The `broadcast` method calls `getLatestBlockhash()` after `sendRawTransaction()` to get a blockhash for confirmation:

```typescript
const txId = await this.connection.sendRawTransaction(signedTxData, { ... });
const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
await this.connection.confirmTransaction({ signature: txId, blockhash, lastValidBlockHeight }, ...);
```

The blockhash used for confirmation is different from the blockhash used when the transaction was built. This is fine for the `confirmTransaction` API (it just needs a valid recent blockhash as a reference point for expiry), but if there's significant delay between the send and the getLatestBlockhash call, the confirmation timeout window could be shorter than expected.

**Impact:** No functional issue -- this is the standard pattern. Noted for documentation purposes only.

**Recommendation:** No change needed. The pattern is correct for Solana's confirmation API.

---

### S3-16 [INFO]: Module Re-exports Expose Internal Implementation Details

**File:** `src/chains/solana/index.ts:1-17`

**Description:** The barrel `index.ts` re-exports all internal utility functions, error types, token constants, and builder functions. This gives consumers access to low-level primitives like `toSmallestUnit`, `buildSOLTransfer`, and `TOKEN_MINTS` that could be misused outside the intended `SolanaAdapter` interface.

**Impact:** No security impact per se, but consumers could call `buildSOLTransfer` directly, bypassing any policy enforcement or validation that `SolanaAdapter.buildTransaction` provides.

**Recommendation:** Consider limiting public exports to `SolanaAdapter`, `SolanaAdapterConfig`, and `SolanaAdapterError`. Keep builder functions and utilities as internal implementation details.

---

## Verified as Correct

The following areas were reviewed and found to be properly implemented:

1. **SQL Injection Prevention (SqliteStore):** All queries in `sqlite.ts` use parameterized statements (`?` placeholders) via `better-sqlite3`'s `.prepare().get()/.run()/.all()` API. No string interpolation is used in SQL queries. The `initialize()` method uses `.exec()` for DDL but contains only static SQL with no user input. **Verdict: Secure.**

2. **SqliteStore Transaction Isolation for `increment`:** The `increment` method wraps its read-modify-write cycle in `this.db.transaction(() => { ... })()`, which provides SQLite serializable isolation. Combined with WAL mode and a 5-second busy timeout, this eliminates the TOCTOU race condition that would exist if the read and write were separate operations. **Verdict: Secure.**

3. **Address Validation:** `isValidSolanaAddress` delegates to `@solana/web3.js`'s `PublicKey` constructor, which performs proper base58 decoding and length validation. The adapter's `getBalance` method validates addresses before use. **Verdict: Secure.**

4. **BigInt-Based Amount Conversion:** `toSmallestUnit` uses string-based arithmetic to avoid floating-point precision loss during the decimal-to-smallest-unit conversion. The whole + fractional string concatenation approach correctly handles arbitrary decimal precision. **Verdict: Secure** (modulo the input validation issue in S3-02).

5. **Fail-Closed Pricing:** `getValueInUSD` in `adapter.ts` throws `PRICE_UNAVAILABLE` for unknown tokens when the Jupiter price API is unreachable, rather than defaulting to zero or allowing the transaction to proceed without valuation. The stablecoin fallback ($1 for USDC/USDT) is a reasonable pragmatic choice. **Verdict: Secure.**

6. **Jupiter Transaction Deserialization Verification:** `buildJupiterSwap` deserializes the Jupiter-returned base64 transaction to verify it's a valid `VersionedTransaction` before returning it. This prevents corrupted or malformed transactions from reaching the signer. **Verdict: Secure.**

7. **Error Type Design:** `SolanaAdapterError` uses structured error codes (`INVALID_TOKEN`, `JUPITER_QUOTE_FAILED`, etc.) that allow callers to distinguish between error types programmatically without parsing error messages. **Verdict: Well-designed.**

8. **SQLite WAL Mode and Busy Timeout:** The `SqliteStore` enables WAL mode for better concurrent read performance and sets a 5-second busy timeout to handle lock contention gracefully. **Verdict: Secure.**

9. **Unsupported Intent Rejection:** The `buildTransaction` method explicitly throws for unrecognized intent types (`"UNSUPPORTED_INTENT"`), implementing fail-closed behavior. **Verdict: Secure.**

10. **Priority Fee Estimation:** The median-based priority fee calculation is a reasonable approach that avoids both overpaying (using max) and underpaying (using min). The 200,000 CU compute budget limit is appropriate for transfer and swap operations. **Verdict: Reasonable.**

---

## Risk Summary by File

| File | Findings | Highest Severity |
|------|----------|-----------------|
| `src/chains/solana/transfers.ts` | S3-01, S3-03, S3-13 | CRITICAL |
| `src/chains/solana/utils.ts` | S3-02, S3-06, S3-07 | HIGH |
| `src/chains/solana/swaps.ts` | S3-04, S3-05, S3-08 | HIGH |
| `src/chains/solana/adapter.ts` | S3-04, S3-10, S3-11, S3-15 | HIGH |
| `src/stores/sqlite.ts` | S3-09, S3-12 | MEDIUM |
| `src/chains/solana/index.ts` | S3-16 | INFO |

---

## Recommended Priority for Remediation

**Immediate (before any mainnet use):**
1. **S3-01** -- Fix `Number(lamports)` / `Number(amount)` truncation by passing `bigint` directly
2. **S3-02** -- Add amount validation (positive, well-formed, bounded)
3. **S3-05** -- Remove the silent fallback to 9 decimals for unknown tokens in swap path

**Before beta/production:**
4. **S3-03** -- Differentiate ATA "not found" from RPC errors
5. **S3-04** -- Validate Jupiter API URLs against domain allowlist
6. **S3-07** -- Replace URL-sniffing devnet detection with explicit config

**Hardening:**
7. **S3-06** -- Ensure policy layer uses resolved mint addresses, not symbols
8. **S3-08** -- Sanitize external API error bodies
9. **S3-09** -- Use integer-scaled counters for spending limits
10. **S3-10** -- Enforce HTTPS on RPC URL
11. **S3-11** -- Propagate RPC errors from status checks
12. **S3-12** -- Validate database file path
13. **S3-13** -- Log priority fee estimation failures
