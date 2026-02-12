# RateLimitRule

The `RateLimitRule` limits the number of transactions per time window. It prevents a runaway agent from executing too many transactions in a short period.

## Import

```typescript
import { RateLimitRule } from "kova";
import type { RateLimitConfig } from "kova";
```

## RateLimitConfig

```typescript
interface RateLimitConfig {
  /** Maximum number of transactions per rolling minute */
  maxTransactionsPerMinute?: number;
  /** Maximum number of transactions per rolling hour */
  maxTransactionsPerHour?: number;
}
```

Both fields are optional. Configure one or both as needed. Values must be positive integers.

## Constructor

```typescript
const rule = new RateLimitRule({
  maxTransactionsPerMinute: 5,
  maxTransactionsPerHour: 30,
});
```

The constructor takes only a `RateLimitConfig` object.

## Counter Mechanics

Rate limit counters use **TTL-based expiration** in the store:

| Counter | Store Key | TTL |
|---------|-----------|-----|
| Per-minute | `ratelimit:minute` | 60 seconds |
| Per-hour | `ratelimit:hour` | 3,600 seconds |

### How It Works

The rule uses an **atomic increment-then-check** pattern to prevent TOCTOU race conditions:

1. On evaluation, the rule atomically **increments** the counter first via `store.increment()`.
2. If the new count exceeds the configured limit, the rule **rolls back** the increment and returns `DENY`.
3. If the new count is within limits, the counter stays incremented and the rule returns `ALLOW`.
4. When the TTL expires, the store automatically removes the key. The next transaction starts a fresh counter.

This pattern ensures that two concurrent evaluations cannot both read the same counter value and both pass. The increment is atomic, so the second evaluation will see the already-incremented count.

```
Time ──────────────────────────────────────────────►
     │                                   │
     ├── Minute window (60s TTL) ───────►│
     │  Tx 1 → counter: 1               │
     │  Tx 2 → counter: 2               │
     │  Tx 3 → counter: 3               │
     │  Tx 4 → counter: 4               │
     │  Tx 5 → counter: 5               │
     │  Tx 6 → DENY (5/5 per minute)    │
     │                          Key expires, counter resets
     │  Tx 7 → counter: 1 (new window)  │
```

## Denied Transactions Do Not Count

Counters are incremented **only on ALLOW**. If the rate limit check passes but a later rule in the policy engine denies the transaction, the rate limit counter has already been incremented. However, transactions that are denied by the rate limit itself do NOT increment the counter. This prevents a denied burst from extending the lockout.

```
Tx 1 → rate-limit: ALLOW (counter: 1) → spending-limit: DENY
        ↑ counter was incremented because rate-limit returned ALLOW

Tx 2 → rate-limit: DENY (counter: 5/5)
        ↑ counter NOT incremented because rate-limit returned DENY
```

## Code Examples

### Per-Minute Only

Allow at most 3 transactions per minute:

```typescript
const rule = new RateLimitRule({
  maxTransactionsPerMinute: 3,
});
```

### Per-Hour Only

Allow at most 50 transactions per hour:

```typescript
const rule = new RateLimitRule({
  maxTransactionsPerHour: 50,
});
```

### Both Limits

Apply both per-minute and per-hour limits:

```typescript
import { PolicyEngine, RateLimitRule, SpendingLimitRule, MemoryStore } from "kova";

const store = new MemoryStore();

const engine = new PolicyEngine(
  [
    new RateLimitRule({
      maxTransactionsPerMinute: 5,
      maxTransactionsPerHour: 30,
    }),
    new SpendingLimitRule({
      daily: { amount: "10", token: "SOL" },
    }),
  ],
  store,
);
```

With both limits configured, both must pass for the transaction to be allowed. A transaction might pass the per-minute check but fail the per-hour check.

## Denial Messages

```
DENY: Rate limit exceeded: 5/5 transactions per minute
DENY: Rate limit exceeded: 30/30 transactions per hour
```

The message includes both the current count and the configured limit.

## Introspection

```typescript
const config = rule.getConfig();
console.log("Max per minute:", config.maxTransactionsPerMinute);
console.log("Max per hour:", config.maxTransactionsPerHour);
```

::: tip
The `RateLimitRule` is the cheapest rule to evaluate -- it only reads a counter from the store. Place it first in your rule ordering for best performance.
:::
