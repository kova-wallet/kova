# SpendingLimitRule

::: info What you'll learn
- How per-transaction, daily, weekly, and monthly spending caps work
- How rolling time windows differ from calendar-based resets
- How token matching ensures SOL limits don't affect USDC transactions
- The atomic increment-then-check pattern that prevents race conditions
- How to configure conservative vs. liberal spending limits
:::

`SpendingLimitRule` caps how much your AI agent can spend -- like setting a daily budget on a corporate credit card.

The `SpendingLimitRule` enforces per-transaction, daily, weekly, and monthly spending caps. It uses sliding window logs with timestamp-based tracking for time-window enforcement.

## When to Use This

- **Prevent runaway spending**: Use `SpendingLimitRule` when you want to prevent your agent from spending more than $50/day, even if a bug causes it to loop.
- **Tiered budgets for trust levels**: Set tight per-transaction limits for a new, untested agent (e.g., max 0.5 SOL per transaction), then raise them as the agent proves reliable.
- **Hard caps alongside approval gates**: Combine with `ApprovalGateRule` so that small transactions auto-approve, medium ones require human approval, and very large ones are blocked outright.

## How It Works

Think of `SpendingLimitRule` as a prepaid budget tracker. Every time your agent tries to send money, this rule checks:

1. **Is this single transaction too large?** (per-transaction limit)
2. **Has the agent already spent too much today?** (daily limit)
3. **Has the agent already spent too much this week?** (weekly limit)
4. **Has the agent already spent too much this month?** (monthly limit)

If any answer is "yes," the transaction is blocked. The rule keeps running totals using counters that automatically reset after their time window expires (24 hours, 7 days, or 30 days).

::: tip
Each limit is scoped to a specific token (e.g., SOL or USDC). If the intent's token does not match the configured limit's token, the transaction is **denied** (not allowed). To permit multiple tokens, create separate `SpendingLimitRule` instances -- one per token -- or use USD-denominated limits which are token-agnostic.
:::

## Decision Table

| Transaction | Per-Tx Limit | Daily Spent So Far | Daily Limit | Result |
|---|---|---|---|---|
| Send 1 SOL | 2 SOL | 0 SOL | 10 SOL | **ALLOW** -- under both limits |
| Send 3 SOL | 2 SOL | 0 SOL | 10 SOL | **DENY** -- exceeds per-transaction limit |
| Send 1 SOL | 2 SOL | 9.5 SOL | 10 SOL | **DENY** -- 9.5 + 1 = 10.5, exceeds daily limit |
| Send 100 USDC | 2 SOL | 5 SOL | 10 SOL | **DENY** -- mismatched token, rule denies by default |
| Send 2 SOL | 2 SOL | 0 SOL | 10 SOL | **DENY** -- exactly at per-transaction limit (uses >= comparison) |

## Import

```typescript
// Import the SpendingLimitRule class, which enforces spending caps on transactions.
import { SpendingLimitRule } from "@kova-sdk/wallet";

// Import the TypeScript types for configuring spending limits.
// SpendingLimitConfig: defines per-transaction, daily, weekly, and monthly caps.
// TokenAmount: a { amount, token } pair representing a cap value and the token it applies to.
// UsdSpendingLimit: a { amount } pair for USD-denominated limits.
import type { SpendingLimitConfig, TokenAmount, UsdSpendingLimit } from "@kova-sdk/wallet";
```

## SpendingLimitConfig

```typescript
// Configuration for the SpendingLimitRule.
// All fields are optional — configure only the limits you need.
// Each limit is a TokenAmount specifying the cap and which token it applies to.
interface SpendingLimitConfig {
  /** Maximum amount per single transaction */
  perTransaction?: TokenAmount;
  /** Maximum total amount over a rolling 24-hour window */
  daily?: TokenAmount;
  /** Maximum total amount over a rolling 7-day window */
  weekly?: TokenAmount;
  /** Maximum total amount over a rolling 30-day window */
  monthly?: TokenAmount;
  /** Maximum per-transaction amount in USD */
  perTransactionUSD?: UsdSpendingLimit;
  /** Maximum total USD amount over a rolling 24-hour window */
  dailyUSD?: UsdSpendingLimit;
  /** Maximum total USD amount over a rolling 7-day window */
  weeklyUSD?: UsdSpendingLimit;
  /** Maximum total USD amount over a rolling 30-day window */
  monthlyUSD?: UsdSpendingLimit;
  /** Optional key prefix for store isolation between rule instances */
  keyPrefix?: string;
}

// Represents a USD spending limit.
interface UsdSpendingLimit {
  /** USD amount as a string (e.g., "100") */
  amount: string;
}

// Represents a token amount used in spending limit configuration.
// The amount is a string to avoid floating-point precision issues
// (e.g., "10" instead of 10 to prevent IEEE 754 rounding errors).
interface TokenAmount {
  /** Human-readable amount (e.g., "10") */
  amount: string;
  /** Token symbol (e.g., "SOL", "USDC") */
  token: string;
}
```

All fields are optional. Configure only the limits you need. Each limit specifies a `TokenAmount` with both the cap and the token it applies to.

::: tip WHAT IS A TOKEN?
In blockchain, a "token" is a type of digital currency. Think of tokens like different currencies -- SOL is Solana's native currency (like USD is to the US), while USDC is a stablecoin pegged to the US dollar (like a digital dollar bill). Each token has a symbol (e.g., "SOL", "USDC") used throughout the SDK.
:::

## Constructor

```typescript
// Create a SpendingLimitRule with all four time-window limits configured.
// - perTransaction: no single transaction can exceed 2 SOL.
// - daily: total spending over any rolling 24-hour period cannot exceed 10 SOL.
// - weekly: total spending over any rolling 7-day period cannot exceed 50 SOL.
// - monthly: total spending over any rolling 30-day period cannot exceed 150 SOL.
// The store (for counter persistence) is NOT passed here — it is provided via
// the PolicyContext when the PolicyEngine calls rule.evaluate().
const rule = new SpendingLimitRule({
  perTransaction: { amount: "2", token: "SOL" },
  daily: { amount: "10", token: "SOL" },
  weekly: { amount: "50", token: "SOL" },
  monthly: { amount: "150", token: "SOL" },
});
```

The constructor takes only a `SpendingLimitConfig` object. No additional arguments (store, chain) are needed -- the store is provided via the `PolicyContext` at evaluation time.

## How Rolling Windows Work

Time-window limits (daily, weekly, monthly) use **sliding window logs** -- each transaction is recorded as a `"timestamp:amount"` entry in a store list, and the total is computed by summing entries within the trailing window:

1. Each allowed transaction appends a `"timestamp:amount"` entry to a per-window store list.
2. On evaluation, recent entries are retrieved and only those with timestamps within the sliding window are summed:
   - Daily: last 86,400 seconds (24 hours)
   - Weekly: last 604,800 seconds (7 days)
   - Monthly: last 2,592,000 seconds (30 days)
3. If the projected total (current window sum + new transaction amount) would meet or exceed the limit, the transaction is denied.
4. Expired entries are garbage-collected periodically to prevent unbounded list growth.

This means the windows are truly **sliding** -- they measure spending over the last N seconds relative to the current time, not calendar days/weeks/months. This eliminates the boundary double-spend vulnerability present in fixed-window TTL-based counters. All amounts are tracked with BigInt precision (PRECISION_DECIMALS=9) to avoid floating-point rounding errors.

::: tip WHAT DOES "ROLLING WINDOW" MEAN?
A rolling window is like a sliding 24-hour clock, not a calendar day. If your first transaction happens at 3 PM on Tuesday, the "daily" window runs until 3 PM on Wednesday -- not until midnight. This is different from calendar-based limits where spending resets at midnight every night.
:::

```
Time ──────────────────────────────────────────────►
     │                                              │
     ├── Daily window (sliding 24h) ───────────────►│
     │  Log: "ts1:2"                                │
     │       Log: "ts2:3"                           │
     │            Log: "ts3:1"                      │
     │  Window total: 6 SOL (sum of entries in last 24h)
     │                          Oldest entries fall out of window naturally
```

## Token Matching

Token matching is **case-insensitive**. A limit configured for `"SOL"` will match intents using `"sol"`, `"Sol"`, or `"SOL"`.

If the intent's token does not match the limit's token, the transaction is **denied** (not skipped). This cross-token denial behavior prevents untracked spending in tokens not covered by the configured limits.

```typescript
// This spending limit only applies to SOL transactions.
// If the intent uses a different token (e.g., USDC), this rule
// DENIES the transaction because the token does not match.
const rule = new SpendingLimitRule({
  daily: { amount: "10", token: "SOL" },
});

// SOL transfer: the token matches "SOL" (case-insensitive), so the 5 SOL
// is checked against the 10 SOL daily limit and counted toward the running total.
wallet.execute({ type: "transfer", chain: "solana", params: { to: "...", amount: "5", token: "SOL" } });

// USDC transfer: the token "USDC" does not match the limit's token "SOL",
// so this rule DENIES the transaction. To allow USDC, add a separate SpendingLimitRule
// for USDC, or use USD-denominated limits which are token-agnostic.
wallet.execute({ type: "transfer", chain: "solana", params: { to: "...", amount: "1000", token: "USDC" } });
```

## Code Examples

### Conservative Spending Limits

Suitable for a low-trust agent with tight budget constraints:

```typescript
// Conservative limits for a low-trust agent.
// These tight caps minimize financial risk while the agent builds trust.
// - Max 0.5 SOL per transaction (prevents large accidental payments).
// - Max 2 SOL per day (limits daily exposure).
// - Max 10 SOL per week and 30 SOL per month (caps total liability).
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
// Liberal limits for a trusted, well-tested agent.
// Higher caps allow the agent more autonomy, suitable after establishing trust.
// Note: no weekly limit is configured — only per-transaction, daily, and monthly.
// Unconfigured windows are simply not enforced by this rule.
const liberalRule = new SpendingLimitRule({
  perTransaction: { amount: "50", token: "SOL" },
  daily: { amount: "200", token: "SOL" },
  monthly: { amount: "2000", token: "SOL" },
});
```

### Multi-Token Limits

To enforce limits on multiple tokens, create separate rules:

```typescript
// Import the necessary classes for a multi-token spending limit setup.
import { PolicyEngine, SpendingLimitRule, MemoryStore } from "@kova-sdk/wallet";

// Create a store shared by all rules for counter persistence.
const store = new MemoryStore();

// Create a PolicyEngine with two SpendingLimitRule instances — one for each token.
// Each rule checks its configured token; transactions in unrecognized tokens are DENIED
// (not passed through) to prevent untracked spending via cross-token bypass.
const engine = new PolicyEngine(
  [
    // Rule 1: SOL spending limits.
    // Caps SOL transactions at 5 SOL per tx and 50 SOL per day.
    // USDC transactions are DENIED by this rule (token mismatch with no USD limits).
    new SpendingLimitRule({
      perTransaction: { amount: "5", token: "SOL" },
      daily: { amount: "50", token: "SOL" },
    }),

    // Rule 2: USDC spending limits.
    // Caps USDC transactions at 100 USDC per tx and 500 USDC per day.
    // SOL transactions are DENIED by this rule (token mismatch with no USD limits).
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
Per-transaction spending limit exceeded: tried to send 3 SOL, limit is 2 SOL
```

**Daily limit exceeded:**
```
Daily spending limit exceeded: tried to send 3 SOL, daily limit is 10 SOL (already spent ~8.0000 SOL in this daily window)
```

**Weekly limit exceeded:**
```
Weekly spending limit exceeded: tried to send 10 SOL, weekly limit is 50 SOL (already spent ~45.0000 SOL in this weekly window)
```

The reason includes the attempted amount, the configured limit, and for time-window limits, the current accumulated spend within the window. This information is included in the `TransactionResult.error.message` field and in the audit log.

::: warning Error sanitization
By default, `AgentWallet` sanitizes denial messages before returning them to the caller, stripping numeric values and rule names to prevent policy reconnaissance by untrusted agents. To see the full detailed messages (e.g., in a dashboard or during development), set `verboseErrors: true` in the `AgentWalletConfig`. See [AgentWallet Configuration](/guide/wallet#agentwallet-config) for details.
:::

## Atomic Increment-Then-Check

The spending limit rule uses an **atomic increment-then-check** pattern to prevent TOCTOU (time-of-check-time-of-use) race conditions:

1. The counter is **incremented first** via `store.increment()` with the transaction amount.
2. If the new total exceeds the configured limit, the increment is **rolled back** and the rule returns `DENY`.
3. If the new total is within limits, the counter stays incremented and the rule returns `ALLOW`.

This ensures that two concurrent evaluations cannot both read the same counter value and both pass. Even if two `execute()` calls run concurrently (e.g., from different async contexts), the atomic increment guarantees at most one will succeed when the combined amount would exceed the limit.

::: warning WHAT IS A RACE CONDITION?
A race condition happens when two operations run at the same time and produce unexpected results. Imagine two transactions both check the counter at "8 SOL spent" and both think they can spend 2 more (under a 10 SOL limit). Without atomic operations, both would pass, pushing the total to 12 SOL. The atomic increment-then-check prevents this by ensuring only one transaction can update the counter at a time.
:::

::: tip
Place `SpendingLimitRule` after cheap rules like `RateLimitRule` in the engine ordering. This way, counters are only incremented when cheaper rules have already passed.
:::

## Introspection

```typescript
// Retrieve the rule's configuration for inspection or logging.
// Returns a copy of the SpendingLimitConfig used to construct this rule.
const config = rule.getConfig();

// Access specific limit values. The optional chaining (?.) handles cases
// where a particular time-window limit was not configured.
console.log("Daily limit:", config.daily?.amount, config.daily?.token);
```

## See Also

- [RateLimitRule](/guide/rules/rate-limit) -- limits the number of transactions per time window (pair with spending limits for comprehensive protection)
- [AllowlistRule](/guide/rules/allowlist) -- restricts which addresses the agent can send to
- [ApprovalGateRule](/guide/rules/approval-gate) -- requires human approval above a threshold (combine with spending limits for layered security)
- [Stores](/guide/stores) -- the persistence backends that track spending counters across restarts
