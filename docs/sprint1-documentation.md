# Sprint 1 — Core Skeleton Documentation

**Project:** kova
**Sprint:** 1 — Core Skeleton
**Date:** 2026-02-11

---

## Overview

Sprint 1 implements the core transaction execution pipeline. After this sprint, `AgentWallet.execute()` processes an intent through the full lifecycle: normalization, policy evaluation, transaction building, signing, broadcasting, and audit logging.

All chain interactions use mock responses (SolanaAdapter returns deterministic mock data). Real Solana RPC integration is deferred to Sprint 3.

---

## Architecture

### Execute Pipeline

```
TransactionIntent
      │
      ▼
normalizeIntent()    ← Auto-assign UUID + timestamp
      │
      ▼
PolicyEngine.evaluate()
      │
      ├─ DENY    → Return denied result + log audit
      ├─ PENDING → Return pending result + log audit
      └─ ALLOW   → Continue ▼
                        │
                  signer.getAddress()
                        │
                  chain.buildTransaction(intent, address)
                        │
                  signer.sign(unsignedTx)
                        │
                  chain.broadcast(signedTx.data)
                        │
                  logAudit(intent, decision, txResult)
                        │
                  Return confirmed result
                        │
              (catch) → Return failed result + log audit
```

### Component Interaction

```
┌──────────────────────────────────────────────────────┐
│                     AgentWallet                       │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │  Signer  │  │  Chain   │  │  Policy  │           │
│  │          │  │ Adapter  │  │  Engine  │           │
│  │ address  │  │          │  │          │           │
│  │ sign()   │  │ build()  │  │evaluate()│           │
│  │          │  │broadcast()│ │          │           │
│  └──────────┘  └──────────┘  └──────────┘           │
│                                                      │
│  ┌──────────┐  ┌──────────────┐                     │
│  │  Store   │  │ AuditLogger  │                     │
│  │          │  │              │                     │
│  │ append() │◄─│ log()        │                     │
│  │getRecent()│◄│ getRecent()  │                     │
│  └──────────┘  └──────────────┘                     │
└──────────────────────────────────────────────────────┘
```

---

## API Reference

### `AgentWallet.execute(intent: TransactionIntent): Promise<TransactionResult>`

Executes a transaction intent through the full pipeline.

**Parameters:**
- `intent` — A `TransactionIntent` describing the desired operation

**Returns:** A `TransactionResult` with one of four statuses:

| Status | When | txId | error |
|--------|------|------|-------|
| `"confirmed"` | Policy allows, chain accepts | Present | None |
| `"denied"` | Policy denies the intent | None | `POLICY_DENIED` with rule name |
| `"pending"` | Policy requires human approval | None | None |
| `"failed"` | Policy allows but chain/signer fails | None | `TRANSACTION_FAILED` with message |

**Example:**

```typescript
const result = await wallet.execute({
  type: "transfer",
  chain: "solana",
  params: { to: "RecipientAddr...", amount: "1.0", token: "SOL" },
  metadata: { agentId: "my-agent", reason: "Payment for service" },
});

if (result.status === "confirmed") {
  console.log(`Sent! TX: ${result.txId}`);
  console.log(result.summary); // "Sent 1.0 SOL to Reci...ddr"
}
```

### `AgentWallet.getBalance(token: string): Promise<TokenBalance>`

Gets the wallet's balance for a specific token.

**Example:**
```typescript
const balance = await wallet.getBalance("SOL");
// { token: "SOL", amount: "10.0", decimals: 9, usdValue: 1500 }
```

### `AgentWallet.getAddress(): Promise<string>`

Returns the wallet's public address.

### `AgentWallet.getTransactionHistory(limit?: number): Promise<TransactionResult[]>`

Returns recent transaction history from the audit log, most recent first.

**Parameters:**
- `limit` — Maximum entries to return (default: 10, max: 1000). Invalid values (NaN, negative, Infinity) are sanitized to the default.

**Example:**
```typescript
const history = await wallet.getTransactionHistory(5);
// Returns last 5 transactions with status, summary, txId, intentId, timestamp
```

---

## Intent Normalization

When `execute()` receives an intent, it normalizes it before processing:

1. **ID assignment**: If `intent.id` is not provided, a UUID v4 is auto-generated
2. **Timestamp assignment**: If `intent.createdAt` is not provided, `Date.now()` is used
3. **Passthrough**: All other fields (type, chain, params, metadata) are preserved as-is

The normalized intent is what gets passed to the policy engine, chain adapter, and audit log.

---

## Summary Generation

Human-readable summaries are generated based on intent type:

| Intent Type | Summary Format | Example |
|-------------|---------------|---------|
| `transfer` | `Sent {amount} {token} to {shortAddr}` | `Sent 1.0 SOL to Reci...1234` |
| `swap` | `Swapped {amount} {fromToken} for {toToken}` | `Swapped 5.0 SOL for USDC` |
| `mint` | `Minted NFT from collection {addr8}...` | `Minted NFT from collection DeGods12...` |
| `stake` | `Staked {amount} {token}` | `Staked 100 SOL` |
| `custom` | `Executed {type} on {chain}` | `Executed custom on solana` |

Addresses longer than 8 characters are truncated to `first4...last4`.

---

## Audit Logging

Every `execute()` call produces an audit entry regardless of outcome:

```typescript
interface AuditEntry {
  timestamp: number;        // When the audit was recorded
  intentId: string;         // The normalized intent ID
  agentId?: string;         // From intent.metadata.agentId
  intent: TransactionIntent; // Deep-cloned copy of the normalized intent
  policyDecisions: PolicyRuleAudit[];  // Rule evaluation results
  finalDecision: PolicyDecision;        // ALLOW, DENY, or PENDING
  transactionResult?: {     // Only for confirmed transactions
    txId: string;
    status: "confirmed" | "failed";
  };
}
```

**Key behaviors:**
- Audit entries are deep-cloned (`structuredClone`) to prevent shared references
- Logging failures are swallowed — a failed log never blocks a transaction
- History queries use `buildSummary()` for consistent rich summaries

---

## SolanaAdapter (Mock Mode)

All `SolanaAdapter` methods return deterministic mock data in Sprint 1:

| Method | Mock Behavior |
|--------|---------------|
| `getBalance(addr, token)` | Returns `{ amount: "10.0", decimals: 9/6 }` with USD value for known tokens |
| `getValueInUSD(token, amount)` | Returns `amount * price` for SOL ($150), USDC ($1), USDT ($1). Throws for unknown tokens. |
| `buildTransaction(intent, addr)` | Returns JSON-encoded intent as `Uint8Array` with description |
| `broadcast(signedData)` | Returns `"mock_tx_{uuid}"` (unique per call) |
| `getTransactionStatus(txId)` | Returns `{ status: "confirmed", txId, blockTime }` |
| `isValidAddress(addr)` | Base58 regex validation (32-44 chars, no 0/O/I/l) |

**Known mock tokens:** SOL ($150), USDC ($1), USDT ($1)

---

## Error Handling

### Transaction Errors

All errors during the build/sign/broadcast phase are caught and returned as `TransactionResult` with `status: "failed"`:

```typescript
{
  status: "failed",
  error: {
    code: "TRANSACTION_FAILED",
    message: "RPC connection failed"  // Original error message
  },
  summary: "Transaction failed: RPC connection failed"
}
```

Non-Error throws (strings, numbers, null, undefined, objects) are converted via `String()`.

### Audit Logging Errors

If `AuditLogger.log()` throws, the error is silently caught. The transaction result is still returned to the caller. This is by design — audit logging should never block transaction execution.

---

## Security Fixes Applied

| ID | Fix | Description |
|----|-----|-------------|
| S1-03 | Discriminated union narrowing | Replaced `as` casts with proper TypeScript narrowing for PolicyDecision |
| S1-05 | structuredClone in logAudit | Prevents audit entries from sharing references with live code |
| S1-06 | Limit validation | `getTransactionHistory` validates and clamps limit to `[1, 1000]` |
| S1-10 | Unknown token throws | `getValueInUSD` throws for unknown tokens instead of returning 0 |
| S1-14 | Explicit status mapping | `mapAuditStatus()` with documented handling for each state |
| S1-15 | Consistent summaries | `getTransactionHistory` uses `buildSummary()` for rich summaries |

---

## Testing

**307 tests** across 12 test files, all passing.

Sprint 1 code coverage: **100% statements, 97.14% branches, 100% functions, 100% lines**

### Test Architecture

Wallet tests use **mock objects** (not real SolanaAdapter/LocalSigner) for isolation:

```typescript
function createMockSigner(): Signer { /* returns address, signs with dummy bytes */ }
function createMockChain(): ChainAdapter { /* returns mock balance, builds mock tx, broadcasts */ }
```

This allows testing the pipeline without real Solana transaction serialization.

---

## What's Next (Sprint 2)

Sprint 2 implements the policy rules:
- `SpendingLimitRule` — per-transaction, daily, weekly, monthly limits
- `AllowlistRule` — address and program allowlists/denylists
- `RateLimitRule` — transactions per minute/hour
- `TimeWindowRule` — active hours restrictions
- `ApprovalGateRule` — human approval above threshold

Sprint 2 blockers from the security audit:
- S1-02: Idempotency enforcement (prevent duplicate intent execution)
- S1-04: Execute mutex (prevent concurrent policy bypass)
- S1-09: Intent validation (validate amounts, addresses, chain before policy evaluation)
