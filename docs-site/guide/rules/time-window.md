# TimeWindowRule

::: info What you'll learn
- How to restrict agent transactions to specific days and times
- How IANA timezones handle daylight saving time automatically
- How overnight windows (start > end) wrap around midnight
- How multiple windows combine with logical OR
- The `outsideHoursPolicy` option for require-approval vs deny
:::

`TimeWindowRule` restricts when your AI agent can send transactions -- like setting "business hours" on a bank account so no transfers happen at 3 AM.

The `TimeWindowRule` restricts when the agent can transact by defining active hours windows. Transactions outside active hours are denied or require approval.

## When to Use This

- **Limit to business hours**: Use `TimeWindowRule` when your agent should only operate during work hours (e.g., Monday-Friday, 9 AM-5 PM) so a human team can monitor it in real time.
- **Match market hours**: Restrict a trading agent to times when markets are active and liquid, avoiding off-hours when prices are more volatile and slippage is higher.
- **Night-shift operations**: Configure an overnight window (e.g., 10 PM-6 AM) for agents that perform maintenance or batch operations during off-peak hours when network fees are lower.

## How It Works

`TimeWindowRule` works like a schedule or calendar. You define one or more "active windows" -- specific days and times when the agent is allowed to transact. Every time the agent tries to send a transaction:

1. The rule checks the current time in the timezone you configured (e.g., "America/New_York").
2. It asks: "Is right now inside any of my active windows?"
3. If yes, the transaction is allowed.
4. If no, the transaction is either denied outright or flagged as needing approval (depending on your configuration).

You can define multiple windows (e.g., weekday business hours AND Saturday mornings), and a transaction is allowed if it falls within **any** of them.

## Decision Table

Given a rule configured for Mon-Fri, 09:00-17:00, America/New_York:

| Current Time (Eastern) | Day | Result |
|---|---|---|
| 10:30 AM | Wednesday | **ALLOW** -- within business hours |
| 8:55 AM | Monday | **DENY** -- 5 minutes before window opens |
| 5:01 PM | Friday | **DENY** -- 1 minute after window closes |
| 2:00 PM | Saturday | **DENY** -- not a configured day |
| 12:00 PM | Tuesday | **ALLOW** -- within business hours |

## Import

```typescript
// Import the TimeWindowRule class, which restricts WHEN the agent can execute transactions.
import { TimeWindowRule } from "@kova/wallet";

// Import the TypeScript types for configuring active hours.
// ActiveHoursConfig: the top-level config with timezone, windows, and outside-hours policy.
// TimeWindow: defines a specific window of days and times when transactions are allowed.
import type { ActiveHoursConfig, TimeWindow } from "@kova/wallet";
```

## ActiveHoursConfig

```typescript
// Configuration for the TimeWindowRule.
// Defines the timezone, one or more active time windows, and what happens
// when a transaction is attempted outside those windows.
interface ActiveHoursConfig {
  /** IANA timezone identifier (e.g., "America/New_York", "Europe/London") */
  timezone: string;
  /** One or more active time windows */
  windows: TimeWindow[];
  /** What to do outside active hours: "deny" (default) or "require_approval" */
  outsideHoursPolicy?: "deny" | "require_approval";
}
```

::: tip WHAT IS AN IANA TIMEZONE?
IANA timezones are the standard way to identify timezones in software. They use the format `"Continent/City"` (e.g., `"America/New_York"`, `"Europe/London"`, `"Asia/Tokyo"`). Unlike simple offsets like "UTC-5", IANA timezones automatically handle daylight saving time. You can find the full list at [timeapi.io/documentation/iana-timezones](https://timeapi.io/documentation/iana-timezones).
:::

## TimeWindow

```typescript
// Defines a single window of active hours on specific days of the week.
// A transaction is allowed if the current time (in the configured timezone)
// falls within ANY of the configured windows.
interface TimeWindow {
  /** Days of the week this window applies to */
  days: Array<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun">;
  /** Start time in "HH:MM" format (24-hour) */
  start: string;
  /** End time in "HH:MM" format (24-hour) */
  end: string;
}
```

## Constructor

```typescript
// Create a TimeWindowRule that only allows transactions on weekdays from 9 AM to 5 PM Eastern.
// - timezone: "America/New_York" uses the IANA timezone database, which automatically
//   handles daylight saving time transitions (EST/EDT).
// - windows: an array of time windows. Here we define a single window covering
//   Monday through Friday, 09:00 to 17:00.
// Transactions outside this window will be denied (the default outsideHoursPolicy).
const rule = new TimeWindowRule({
  timezone: "America/New_York",
  windows: [
    {
      days: ["mon", "tue", "wed", "thu", "fri"],  // Weekdays only
      start: "09:00",  // 9:00 AM local time (24-hour format)
      end: "17:00",    // 5:00 PM local time (24-hour format)
    },
  ],
});
```

The constructor takes only an `ActiveHoursConfig` object.

## Timezone Handling

The rule uses `Intl.DateTimeFormat` to convert the current UTC time to the configured timezone. This means:

- You can use any valid IANA timezone identifier (e.g., `"America/New_York"`, `"Asia/Tokyo"`, `"UTC"`)
- Daylight saving time transitions are handled automatically
- If the timezone is invalid, the rule **fails closed** (denies the transaction)

```typescript
// All of these are valid IANA timezone identifiers.
// The rule uses the JavaScript Intl.DateTimeFormat API under the hood,
// which supports the full IANA timezone database.
new TimeWindowRule({ timezone: "America/New_York", windows: [...] }); // US Eastern (handles EST/EDT automatically)
new TimeWindowRule({ timezone: "Europe/London", windows: [...] });    // UK (handles GMT/BST automatically)
new TimeWindowRule({ timezone: "Asia/Tokyo", windows: [...] });       // Japan Standard Time (no DST)
new TimeWindowRule({ timezone: "UTC", windows: [...] });              // UTC (no DST, useful for global operations)
```

::: danger
If you provide an invalid timezone string, the rule will deny ALL transactions. This is the fail-closed behavior -- an invalid configuration is treated as "never active."
:::

::: tip WHAT DOES "FAIL CLOSED" MEAN?
"Fail closed" is a security principle meaning "when something goes wrong, block everything rather than allow everything." It is the safe default for security systems -- if the timezone configuration is broken, it is better to block all transactions (which you will quickly notice) than to allow all transactions (which could cause silent financial loss).
:::

## Overnight Windows

The rule supports overnight windows where the start time is after the end time. For example, a window from 22:00 to 06:00 means "active from 10 PM until 6 AM the next morning."

```typescript
// Create a night-shift window: active from 10 PM to 6 AM on weekdays.
// When start > end (22:00 > 06:00), the rule interprets this as an overnight window
// that wraps around midnight. The rule handles the wrap-around internally.
const rule = new TimeWindowRule({
  timezone: "America/New_York",
  windows: [
    {
      days: ["mon", "tue", "wed", "thu", "fri"],  // Active on weekday nights
      start: "22:00",  // 10:00 PM — start of the overnight window
      end: "06:00",    // 6:00 AM the next morning — end of the overnight window
    },
  ],
});
```

The rule correctly handles the wrap-around:
- At 23:00 on Monday (within `start` to midnight) -- **ALLOW**
- At 03:00 on Tuesday (midnight to `end`) -- **ALLOW** (if Tuesday is in the `days` list)
- At 12:00 on Monday -- **DENY** (outside the window)

## Multiple Windows

You can define multiple windows. A transaction is allowed if the current time falls within **any** of the configured windows.

```typescript
// Create a rule with two separate active windows.
// A transaction is ALLOWED if the current time matches ANY window (logical OR).
const rule = new TimeWindowRule({
  timezone: "America/New_York",
  windows: [
    // Window 1: Weekday business hours (Mon-Fri, 9 AM to 5 PM).
    {
      days: ["mon", "tue", "wed", "thu", "fri"],
      start: "09:00",
      end: "17:00",
    },
    // Window 2: Saturday morning only (Sat, 10 AM to 2 PM).
    // This allows limited weekend operations without full weekend access.
    {
      days: ["sat"],
      start: "10:00",
      end: "14:00",
    },
  ],
});
```

## Outside Hours Policy

By default, transactions outside active hours are denied. You can change this to `"require_approval"`:

```typescript
// Create a rule where off-hours transactions require approval instead of being denied.
// During business hours (Mon-Fri, 9-5): transactions are allowed normally.
// Outside business hours: transactions are denied with a message indicating approval is required.
const rule = new TimeWindowRule({
  timezone: "America/New_York",
  windows: [
    { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" },
  ],
  outsideHoursPolicy: "require_approval",  // Change from default "deny" to "require_approval"
});
```

::: warning DEPRECATION NOTICE
The `"require_approval"` value for `outsideHoursPolicy` is **deprecated**. It currently behaves identically to `"deny"` -- the only difference is the denial reason string (the message says "requires approval" instead of "outside active hours"). It does **not** route transactions to an approval channel. For real approval-gated behavior outside active hours, pair `TimeWindowRule` with [`ApprovalGateRule`](/guide/rules/approval-gate) instead.
:::

## Code Examples

### Business Hours Only

Classic 9-to-5, Monday through Friday:

```typescript
// Standard business hours: weekdays only, 9 AM to 5 PM Eastern.
// Transactions at 8:59 AM or 5:01 PM are denied.
// Weekend transactions are denied entirely.
const rule = new TimeWindowRule({
  timezone: "America/New_York",
  windows: [
    {
      days: ["mon", "tue", "wed", "thu", "fri"],
      start: "09:00",
      end: "17:00",
    },
  ],
});
```

### Weekend Only

Allow transactions only on weekends:

```typescript
// Weekend-only operations: transactions allowed Saturday and Sunday, all day.
// Weekday transactions are denied entirely.
// Using "00:00" to "23:59" covers the full 24-hour day.
const rule = new TimeWindowRule({
  timezone: "UTC",
  windows: [
    {
      days: ["sat", "sun"],
      start: "00:00",
      end: "23:59",
    },
  ],
});
```

### 24/7 with Broader Hours

Allow all week with extended hours:

```typescript
// Effectively 24/7 operation by covering all 7 days from midnight to 23:59.
// This is useful as a base configuration that can be tightened later,
// or when you want the TimeWindowRule present in the engine but not restrictive.
const rule = new TimeWindowRule({
  timezone: "UTC",
  windows: [
    {
      days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      start: "00:00",
      end: "23:59",
    },
  ],
});
```

### Night Shift

Active from 10 PM to 6 AM on weekdays:

```typescript
// Night-shift configuration: active from 10 PM to 6 AM Central Time.
// Uses the overnight window feature (start > end triggers wrap-around logic).
// This is useful for agents that operate during off-peak hours
// when network fees may be lower or when human operators work night shifts.
const rule = new TimeWindowRule({
  timezone: "America/Chicago",
  windows: [
    {
      days: ["mon", "tue", "wed", "thu", "fri"],
      start: "22:00",  // 10:00 PM Central
      end: "06:00",    // 6:00 AM Central (next morning)
    },
  ],
});
```

## Denial Messages

When a transaction is denied due to the time window:

```
DENY: Transaction denied: outside active hours (timezone: America/New_York)
```

When `outsideHoursPolicy` is `"require_approval"`:

```
DENY: Transaction requires approval outside active hours
```

## Introspection

```typescript
// Retrieve the rule's configuration for inspection or logging.
// Returns the ActiveHoursConfig object used to construct this rule.
const config = rule.getConfig();
console.log("Timezone:", config.timezone);                  // e.g., "America/New_York"
console.log("Windows:", config.windows);                    // Array of TimeWindow objects
console.log("Outside policy:", config.outsideHoursPolicy);  // "deny" or "require_approval" (or undefined for default "deny")
```

## See Also

- [ApprovalGateRule](/guide/rules/approval-gate) -- pair with `outsideHoursPolicy: "require_approval"` to allow off-hours transactions with human sign-off
- [RateLimitRule](/guide/rules/rate-limit) -- limits transaction frequency (complements time-of-day restrictions)
- [SpendingLimitRule](/guide/rules/spending-limit) -- caps how much the agent can spend per day/week/month
- [AllowlistRule](/guide/rules/allowlist) -- restricts which addresses the agent can send to
