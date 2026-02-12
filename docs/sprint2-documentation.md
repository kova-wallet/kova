# Sprint 2 — Policy Engine Rules Documentation

**Project:** kova
**Sprint:** 2 — Policy Engine Rules
**Date:** 2026-02-11

---

## Overview

Sprint 2 implements all five policy engine rules that govern agent transaction behavior. After this sprint, the `PolicyEngine` evaluates transactions against spending limits, address allowlists, rate limits, time-based windows, and approval thresholds. Three Sprint 1 security blockers (idempotency, execute mutex, intent validation) are also resolved.

---

## Architecture

### Policy Evaluation Pipeline

```
TransactionIntent
      │
      ▼
validateIntent()       ← S1-09: Reject malformed intents early
      │
      ▼
Execute Mutex          ← S1-04: Serialize concurrent calls
      │
      ▼
Idempotency Check      ← S1-02: Return cached result for duplicate IDs
      │
      ▼
PolicyEngine.evaluate()
      │
      ├─ RateLimitRule     ← Cheapest check first (counter lookup)
      ├─ TimeWindowRule    ← Timezone-aware active hours
      ├─ AllowlistRule     ← Address/program allow/deny lists
      ├─ SpendingLimitRule ← Per-tx, daily, weekly, monthly caps
      └─ ApprovalGateRule  ← Human approval above threshold
      │
      ├─ First DENY → Stop, return denied result
      ├─ First PENDING → Stop, return pending result
      └─ All ALLOW → Continue to build/sign/broadcast
```

### Rule Evaluation Order

Rules are evaluated from cheapest to most expensive. The engine stops at the first non-ALLOW decision:

1. **RateLimitRule** — Simple counter check (O(1))
2. **TimeWindowRule** — Date/time computation (O(1))
3. **AllowlistRule** — Set lookup (O(1))
4. **SpendingLimitRule** — Store counter reads (O(n) where n = number of configured windows)
5. **ApprovalGateRule** — May block on human approval (seconds to minutes)

---

## Policy Rules Reference

### SpendingLimitRule

Enforces per-transaction, daily, weekly, and monthly spending caps using TTL-based store counters.

**Configuration:**

```typescript
{
  perTransaction?: { amount: string; token: string };
  daily?: { amount: string; token: string };
  weekly?: { amount: string; token: string };
  monthly?: { amount: string; token: string };
}
```

**Behavior:**
- Per-transaction limit: Compares intent amount directly against the limit
- Daily/weekly/monthly limits: Accumulates spent amounts in store counters with TTL expiration
- Token-aware: Only enforces limits for matching tokens (case-insensitive)
- Counters are only incremented on ALLOW (denied transactions don't count)
- Intents without amounts (e.g., custom) are allowed through

**Store keys:** `spending:{daily|weekly|monthly}:{TOKEN}`

**TTLs:** daily = 24h, weekly = 7d, monthly = 30d

**Example:**

```typescript
const rule = new SpendingLimitRule({
  perTransaction: { amount: "10", token: "SOL" },
  daily: { amount: "100", token: "SOL" },
  monthly: { amount: "1000", token: "SOL" },
});
```

---

### AllowlistRule

Restricts which addresses and programs the agent can interact with.

**Configuration:**

```typescript
{
  allowAddresses?: string[];   // Whitelist — only these addresses are allowed
  denyAddresses?: string[];    // Blacklist — these addresses are always denied
  allowPrograms?: string[];    // Whitelist for program IDs (custom intents only)
  denyPrograms?: string[];     // Blacklist for program IDs (custom intents only)
}
```

**Evaluation order (deny takes precedence):**
1. If address is in `denyAddresses` → DENY
2. If `allowAddresses` is configured and address is NOT in it → DENY
3. If programId is in `denyPrograms` → DENY
4. If `allowPrograms` is configured and programId is NOT in it → DENY
5. Otherwise → ALLOW

**Address extraction by intent type:**

| Intent Type | Target Address Field |
|------------|---------------------|
| transfer | `params.to` |
| custom | `params.programId` |
| mint | `params.collection` |
| stake | `params.validator` |
| swap | None (no target address) |

**Program ID extraction:** Only for `custom` intent type (`params.programId`).

---

### RateLimitRule

Limits the number of transactions per time window using store counters with TTL-based expiration.

**Configuration:**

```typescript
{
  maxTransactionsPerMinute?: number;
  maxTransactionsPerHour?: number;
}
```

**Behavior:**
- Counters are incremented on ALLOW, so denied transactions don't consume rate limit budget
- Per-minute counter expires after 60 seconds
- Per-hour counter expires after 3600 seconds
- A limit of 0 means no transactions are allowed

**Store keys:** `ratelimit:minute`, `ratelimit:hour`

---

### TimeWindowRule

Restricts when the agent can transact based on timezone-aware time windows.

**Configuration:**

```typescript
{
  timezone: string;                        // IANA timezone (e.g., "America/New_York")
  windows: Array<{
    days: ("mon"|"tue"|"wed"|"thu"|"fri"|"sat"|"sun")[];
    start: string;                         // "HH:MM" format
    end: string;                           // "HH:MM" format
  }>;
  outsideHoursPolicy?: "deny" | "require_approval";
}
```

**Behavior:**
- Uses `Intl.DateTimeFormat` for timezone-aware evaluation
- Supports overnight ranges (e.g., 22:00 to 06:00)
- Start time is inclusive, end time is exclusive
- Fails closed on invalid timezone (denies all)
- Empty windows array denies all transactions
- Multiple windows can be configured for the same day

**Outside hours policies:**
- `"deny"` (default): Returns DENY with timezone in the reason
- `"require_approval"`: Returns DENY with "requires approval" message

---

### ApprovalGateRule

Requires human approval for transactions above a configured threshold.

**Configuration:**

```typescript
{
  above: { amount: string; token: string };  // Threshold for requiring approval
  channel?: "telegram" | "slack" | "custom"; // Approval channel type
  timeout?: number;                          // Timeout in ms (default: 300000 = 5 min)
}
```

**Behavior:**
- If amount ≤ threshold → ALLOW (no approval needed)
- If amount > threshold and no approval channel → DENY (fail closed)
- If amount > threshold and channel available → request approval:
  - `approved` → ALLOW
  - `rejected` → DENY (includes `decidedBy` if available)
  - `timeout` → DENY
- Channel errors → DENY (fail closed)
- Token-aware: Only triggers for matching tokens (case-insensitive)
- Intents without amounts (custom) are allowed through

**Approval request fields:**
- `id`: Intent ID or generated UUID
- `summary`: Human-readable description (e.g., "transfer 10.5 SOL")
- `amount`, `token`, `target`: Transaction details
- `reason`: From intent metadata
- `agentId`: From intent metadata
- `expiresAt`: Current time + configured timeout

---

## Security Fixes Applied

### S1-02: Idempotency Enforcement

**Problem:** Duplicate intent IDs could be executed multiple times, causing double-spending.

**Fix:** Before processing, check `idempotency:{intentId}` in the store. If found, return the cached result. After processing confirmed or failed results, cache them with a 24-hour TTL.

**Design decisions:**
- Denied and pending results are NOT cached (S2-03 fix) — denial may be temporary (rate limits expire, budgets reset)
- Cache validation checks `status` and `intentId` fields before returning (S2-16 fix)
- Cache write failures are silently caught — they must not block the transaction

### S1-04: Execute Mutex

**Problem:** Concurrent `execute()` calls could bypass spending limits via TOCTOU race (two calls both check the counter before either increments it).

**Fix:** Promise-chain mutex serializes all `execute()` calls. Each call waits for the previous one to complete before proceeding.

**Design decisions:**
- Validation runs before acquiring the mutex (invalid intents don't hold the lock)
- Lock is always released in a `finally` block
- Single-process only — distributed deployments need external locking

### S1-09: Intent Validation

**Problem:** Malformed intents could cause runtime errors deep in the pipeline.

**Fix:** `validateIntent()` runs before any processing:
- Validates `type` is one of: transfer, swap, mint, stake, custom
- Validates `chain` is one of: solana, ethereum, base
- Validates `params` is a non-null object
- Validates `id` is 1-128 characters if provided (S2-15 fix)
- Type-specific validation for all required fields
- Rejects empty strings, NaN amounts, zero/negative amounts

### S2-03: Idempotency Cache Poisoning

**Problem:** Caching denied results meant that temporary denials (rate limit, spending limit) would persist as cached results even after the limit resets.

**Fix:** Only cache `confirmed` and `failed` results. Denied and pending results are not cached.

### S2-13: Negative Amount Defense-in-Depth

**Problem:** `extractAmount()` in SpendingLimitRule and ApprovalGateRule accepted negative values, which could decrement spending counters if upstream validation is bypassed.

**Fix:** Added `parsed <= 0` guard — negative and zero amounts are treated as null (no amount).

---

## Testing

**429 tests** across 12 test files, all passing.

### Test Coverage Summary

| Component | Tests | Coverage Focus |
|-----------|-------|---------------|
| SpendingLimitRule | 22 | Per-tx/daily/weekly/monthly limits, boundary amounts, token matching, counter persistence |
| AllowlistRule | 18 | Deny precedence, address extraction, program filtering, case sensitivity |
| RateLimitRule | 14 | Counter mechanics, limit of 0/1, high-volume traffic, DENY doesn't increment |
| TimeWindowRule | 19 | Timezone-aware, overnight ranges, midnight boundary, multiple windows, invalid timezone |
| ApprovalGateRule | 25 | Threshold behavior, approval/rejection/timeout, channel errors, request field verification |
| S1-02 Idempotency | 6 | Cache hit/miss, no re-evaluation, denied not cached |
| S1-04 Execute mutex | 4 | Serialization, TOCTOU prevention, release on failure, concurrency |
| S1-09 Intent validation | 46 | All types validated, invalid fields rejected, valid intents accepted |

---

## Known Limitations

| ID | Description | Planned Resolution |
|----|-------------|-------------------|
| S2-01 | Spending limits only enforce per configured token — other tokens bypass the limit | Sprint 3: USD-normalized aggregate limits |
| S2-04 | AllowlistRule address comparison is case-sensitive (correct for Solana, not for EVM) | Sprint 3+: Chain-aware address normalization |
| S2-06 | Spending calculations use JavaScript floating-point | Sprint 3+: Integer arithmetic migration |
| S2-08 | Rate limit store keys are global (not scoped per wallet/agent) | Sprint 4+: Multi-tenancy |
| S2-17 | TimeWindowRule `require_approval` returns DENY, not PENDING | Sprint 3+: Approval channel integration |

---

## What's Next (Sprint 3)

Sprint 3 implements real Solana RPC integration:
- Replace mock SolanaAdapter with real transaction building
- @solana/web3.js integration for serialization
- Real balance queries and broadcasting
- Address S2-01 (critical spending limit bypass)
