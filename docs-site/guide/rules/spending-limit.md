# SpendingLimitRule

The `SpendingLimitRule` enforces per-transaction, daily, weekly, and monthly spending caps. It uses store counters with TTL-based expiration for time-window tracking.

## Import

```typescript
import { SpendingLimitRule } from "kova";
import type { SpendingLimitConfig, TokenAmount } from "kova";
```

## SpendingLimitConfig

```typescript
interface SpendingLimitConfig {
  /** Maximum amount per single transaction */
  perTransaction?: TokenAmount;
  /** Maximum total amount over a rolling 24-hour window */
  daily?: TokenAmount;
  /** Maximum total amount over a rolling 7-day window */
  weekly?: TokenAmount;
  /** Maximum total amount over a rolling 30-day window */
  monthly?: TokenAmount;
}

interface TokenAmount {
  /** Human-readable amount (e.g., "10") */
  amount: string;
  /** Token symbol (e.g., "SOL", "USDC") */
  token: string;
}
```

All fields are optional. Configure only the limits you need. Each limit specifies a `TokenAmount` with both the cap and the token it applies to.

## Constructor

```typescript
const rule = new SpendingLimitRule({
  perTransaction: { amount: "2", token: "SOL" },
  daily: { amount: "10", token: "SOL" },
  weekly: { amount: "50", token: "SOL" },
  monthly: { amount: "150", token: "SOL" },
});
```

The constructor takes only a `SpendingLimitConfig` object. No additional arguments (store, chain) are needed -- the store is provided via the `PolicyContext` at evaluation time.

## How Rolling Windows Work

Time-window limits (daily, weekly, monthly) use **lazy TTL** via the store:

1. On the first transaction, a counter key is created in the store with a TTL matching the window duration:
   - Daily: 86,400 seconds (24 hours)
   - Weekly: 604,800 seconds (7 days)
   - Monthly: 2,592,000 seconds (30 days)
2. Each allowed transaction increments the counter by the transaction amount.
3. When the TTL expires, the store automatically removes the key. The next transaction starts a fresh counter.

This means the windows are **rolling** -- they measure spending over the last N seconds from the first transaction, not calendar days/weeks/months.

```
Time ──────────────────────────────────────────────►
     │                                              │
     ├── Daily window (24h TTL) ───────────────────►│
     │  Tx: 2 SOL                                   │
     │       Tx: 3 SOL                              │
     │            Tx: 1 SOL                         │
     │  Counter: 6 SOL                              │
     │                                    Key expires, counter resets
```

## Token Matching

Token matching is **case-insensitive**. A limit configured for `"SOL"` will match intents using `"sol"`, `"Sol"`, or `"SOL"`.

If the intent's token does not match the limit's token, the limit is skipped (not denied). This means a SOL spending limit will not affect USDC transactions.

```typescript
// This limit only applies to SOL transactions
const rule = new SpendingLimitRule({
  daily: { amount: "10", token: "SOL" },
});

// SOL transfer: checked against the daily limit
wallet.execute({ type: "transfer", chain: "solana", params: { to: "...", amount: "5", token: "SOL" } });

// USDC transfer: limit is skipped (different token), always ALLOW from this rule
wallet.execute({ type: "transfer", chain: "solana", params: { to: "...", amount: "1000", token: "USDC" } });
```

## Code Examples

### Conservative Spending Limits

Suitable for a low-trust agent with tight budget constraints:

```typescript
const conservativeRule = new SpendingLimitRule({
  perTransaction: { amount: "0.5", token: "SOL" },
  daily: { amount: "2", token: "SOL" },
  weekly: { amount: "10", token: "SOL" },
  monthly: { amount: "30", token: "SOL" },
});
```

### Liberal Spending Limits

Suitable for a trusted agent with a larger budget:

```typescript
const liberalRule = new SpendingLimitRule({
  perTransaction: { amount: "50", token: "SOL" },
  daily: { amount: "200", token: "SOL" },
  monthly: { amount: "2000", token: "SOL" },
});
```

### Multi-Token Limits

To enforce limits on multiple tokens, create separate rules:

```typescript
import { PolicyEngine, SpendingLimitRule, MemoryStore } from "kova";

const store = new MemoryStore();

const engine = new PolicyEngine(
  [
    new SpendingLimitRule({
      perTransaction: { amount: "5", token: "SOL" },
      daily: { amount: "50", token: "SOL" },
    }),
    new SpendingLimitRule({
      perTransaction: { amount: "100", token: "USDC" },
      daily: { amount: "500", token: "USDC" },
    }),
  ],
  store,
);
```

## What Happens When Limits Are Exceeded

When a transaction would exceed any configured limit, the rule returns `DENY` with a descriptive reason:

**Per-transaction limit exceeded:**
```
DENY: Per-transaction limit exceeded: 3 SOL > 2 SOL
```

**Daily limit exceeded:**
```
DENY: Daily spending limit exceeded: 8 + 3 = 11 SOL > 10 SOL
```

**Weekly limit exceeded:**
```
DENY: Weekly spending limit exceeded: 45 + 10 = 55 SOL > 50 SOL
```

The reason includes the current spent amount, the transaction amount, the total that would result, and the configured limit. This information is included in the `TransactionResult.error.message` field and in the audit log.

## Atomic Increment-Then-Check

The spending limit rule uses an **atomic increment-then-check** pattern to prevent TOCTOU (time-of-check-time-of-use) race conditions:

1. The counter is **incremented first** via `store.increment()` with the transaction amount.
2. If the new total exceeds the configured limit, the increment is **rolled back** and the rule returns `DENY`.
3. If the new total is within limits, the counter stays incremented and the rule returns `ALLOW`.

This ensures that two concurrent evaluations cannot both read the same counter value and both pass. Even if two `execute()` calls run concurrently (e.g., from different async contexts), the atomic increment guarantees at most one will succeed when the combined amount would exceed the limit.

::: tip
Place `SpendingLimitRule` after cheap rules like `RateLimitRule` in the engine ordering. This way, counters are only incremented when cheaper rules have already passed.
:::

## Introspection

```typescript
const config = rule.getConfig();
console.log("Daily limit:", config.daily?.amount, config.daily?.token);
```
