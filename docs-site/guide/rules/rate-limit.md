# RateLimitRule

::: info What you'll learn
- How per-minute and per-hour transaction limits prevent runaway agents
- How TTL-based counters automatically reset after each time window
- Why denied transactions do not count against the rate limit
- The atomic increment-then-check pattern that prevents concurrent bypasses
- How to combine rate limits with spending limits for comprehensive protection
:::

`RateLimitRule` limits how many transactions your AI agent can execute in a given time period -- like an API rate limiter, but for blockchain transactions.

The `RateLimitRule` limits the number of transactions per time window. It prevents a runaway agent from executing too many transactions in a short period.

## When to Use This

- **Prevent runaway loops**: Use `RateLimitRule` when a bug in your agent could cause it to fire hundreds of transactions per second, draining your wallet before you can intervene.
- **Protect against compromised agents**: If an attacker gains control of your agent, rate limits buy you time to detect and shut it down before significant damage is done.
- **Control blockchain fees**: Each transaction on a blockchain costs a small fee. Limiting transaction frequency prevents unexpected fee accumulation (e.g., 1,000 transactions at $0.01 each = $10 in fees alone).

## How It Works

Think of `RateLimitRule` as a bouncer at a door who counts how many people have entered in the last minute. Every time your agent tries to send a transaction:

1. The rule checks a counter: "How many transactions has this agent sent in the last 60 seconds?"
2. If the count is at the limit (e.g., 5 out of 5), the transaction is rejected immediately.
3. If the count is below the limit, the transaction is allowed and the counter increments.
4. After 60 seconds, the counter automatically resets to zero and a new window begins.

The same logic applies to the per-hour counter, but with a 3,600-second window.

::: tip
`RateLimitRule` is the cheapest rule to evaluate -- it only reads and writes a simple counter. Always place it **first** in your rule list so that runaway agents are stopped before more expensive checks (like spending limits or approval gates) run.
:::

## Decision Table

| Transactions in Last Minute | Per-Minute Limit | Transactions in Last Hour | Per-Hour Limit | Result |
|---|---|---|---|---|
| 2 | 5 | 10 | 30 | **ALLOW** -- under both limits |
| 5 | 5 | 10 | 30 | **DENY** -- per-minute limit reached |
| 2 | 5 | 30 | 30 | **DENY** -- per-hour limit reached |
| 5 | 5 | 30 | 30 | **DENY** -- both limits reached |
| 0 | 5 | 0 | 30 | **ALLOW** -- fresh window, no transactions yet |

## Import

```typescript
// Import the RateLimitRule class, which limits how many transactions
// the agent can execute per minute and/or per hour.
import { RateLimitRule } from "@kova-sdk/wallet";

// Import the TypeScript type for the rate limit configuration.
import type { RateLimitConfig } from "@kova-sdk/wallet";
```

## RateLimitConfig

```typescript
// Configuration for the RateLimitRule.
// Both fields are optional, but at least ONE must be configured (both cannot be omitted).
// Values must be positive integers (enforced at validation time).
interface RateLimitConfig {
  /** Maximum number of transactions per rolling minute */
  maxTransactionsPerMinute?: number;
  /** Maximum number of transactions per rolling hour */
  maxTransactionsPerHour?: number;
  /** Counter algorithm: "fixed-window" (TTL-based reset) or "sliding-window" (rolling sum). Default: "fixed-window" */
  algorithm?: "fixed-window" | "sliding-window";
  /** Optional key prefix for store isolation between rule instances */
  keyPrefix?: string;
}
```

Both fields are optional individually, but **at least one must be configured** -- omitting both will cause a validation error. Values must be positive integers.

## Constructor

```typescript
// Create a RateLimitRule with both per-minute and per-hour limits.
// - maxTransactionsPerMinute: at most 5 transactions in any rolling 60-second window.
// - maxTransactionsPerHour: at most 30 transactions in any rolling 3600-second window.
// Both limits are enforced independently — a transaction must pass BOTH to be allowed.
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

::: tip WHAT IS TTL?
TTL stands for "Time To Live." It is a common pattern in software where data is automatically deleted after a set amount of time. Here, the counter that tracks "how many transactions happened this minute" is automatically erased after 60 seconds. This is the same concept used in DNS caching, Redis keys, and HTTP cache headers.
:::

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

::: warning
If a transaction passes the rate limit but is denied by a later rule (e.g., `SpendingLimitRule`), it still counts against the rate limit. This is by design -- the rate limit measures how many times the agent _attempted_ to transact, not how many succeeded. This behavior prevents an agent from "burning through" rate limit capacity on transactions that will ultimately fail.
:::

## Code Examples

### Per-Minute Only

Allow at most 3 transactions per minute:

```typescript
// Create a rate limit rule with only a per-minute cap.
// The per-hour limit is not configured, so there is no hourly cap.
// This is useful when you want to prevent burst activity but allow
// sustained throughput over longer periods.
const rule = new RateLimitRule({
  maxTransactionsPerMinute: 3,
});
```

### Per-Hour Only

Allow at most 50 transactions per hour:

```typescript
// Create a rate limit rule with only a per-hour cap.
// The per-minute limit is not configured, so short bursts are allowed
// as long as the hourly total stays under 50.
// This is useful for agents that work in bursts but should have an overall throttle.
const rule = new RateLimitRule({
  maxTransactionsPerHour: 50,
});
```

### Both Limits

Apply both per-minute and per-hour limits:

```typescript
// Import the necessary classes for a complete rate-limited policy engine.
import { PolicyEngine, RateLimitRule, SpendingLimitRule, MemoryStore } from "@kova-sdk/wallet";

// Create a shared in-memory store for counter persistence.
const store = new MemoryStore();

// Create a PolicyEngine with rate limiting as the first rule (cheapest to evaluate).
// The RateLimitRule checks both per-minute and per-hour counters.
// If either limit is exceeded, the transaction is denied immediately
// without evaluating the more expensive SpendingLimitRule.
const engine = new PolicyEngine(
  [
    // Rate limit rule: max 5 per minute AND max 30 per hour.
    // Both limits must pass for the transaction to proceed.
    // A transaction might pass the per-minute check but fail the per-hour check.
    new RateLimitRule({
      maxTransactionsPerMinute: 5,
      maxTransactionsPerHour: 30,
    }),

    // Spending limit rule: evaluated only if the rate limit passes.
    // This ordering saves store read/write operations when the rate limit denies.
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
Rate limit exceeded: 5/5 transactions per minute already used
Rate limit exceeded: 30/30 transactions per hour already used
```

The message includes both the current count and the configured limit.

::: warning Error sanitization
By default, `AgentWallet` sanitizes denial messages before returning them to the caller, stripping numeric values and rule names to prevent policy reconnaissance by untrusted agents. To see the full detailed messages (e.g., in a dashboard or during development), set `verboseErrors: true` in the `AgentWalletConfig`. See [AgentWallet Configuration](/guide/wallet#agentwallet-config) for details.
:::

## Introspection

```typescript
// Retrieve the rule's configuration for inspection or logging.
// Returns the RateLimitConfig object used to construct this rule.
const config = rule.getConfig();
console.log("Max per minute:", config.maxTransactionsPerMinute);  // e.g., 5 (or undefined if not configured)
console.log("Max per hour:", config.maxTransactionsPerHour);      // e.g., 30 (or undefined if not configured)
```

::: tip
The `RateLimitRule` is the cheapest rule to evaluate -- it only reads a counter from the store. Place it first in your rule ordering for best performance.
:::

## See Also

- [SpendingLimitRule](/guide/rules/spending-limit) -- caps how much the agent can spend (rate limits control _frequency_, spending limits control _amount_)
- [AllowlistRule](/guide/rules/allowlist) -- restricts which addresses the agent can send to
- [TimeWindowRule](/guide/rules/time-window) -- restricts when the agent can transact (time-of-day vs. frequency)
- [Stores](/guide/stores) -- the persistence backends that track rate limit counters across restarts
