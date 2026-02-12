# TimeWindowRule

The `TimeWindowRule` restricts when the agent can transact by defining active hours windows. Transactions outside active hours are denied or require approval.

## Import

```typescript
import { TimeWindowRule } from "kova";
import type { ActiveHoursConfig, TimeWindow } from "kova";
```

## ActiveHoursConfig

```typescript
interface ActiveHoursConfig {
  /** IANA timezone identifier (e.g., "America/New_York", "Europe/London") */
  timezone: string;
  /** One or more active time windows */
  windows: TimeWindow[];
  /** What to do outside active hours: "deny" (default) or "require_approval" */
  outsideHoursPolicy?: "deny" | "require_approval";
}
```

## TimeWindow

```typescript
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

The constructor takes only an `ActiveHoursConfig` object.

## Timezone Handling

The rule uses `Intl.DateTimeFormat` to convert the current UTC time to the configured timezone. This means:

- You can use any valid IANA timezone identifier (e.g., `"America/New_York"`, `"Asia/Tokyo"`, `"UTC"`)
- Daylight saving time transitions are handled automatically
- If the timezone is invalid, the rule **fails closed** (denies the transaction)

```typescript
// Valid timezones
new TimeWindowRule({ timezone: "America/New_York", windows: [...] });
new TimeWindowRule({ timezone: "Europe/London", windows: [...] });
new TimeWindowRule({ timezone: "Asia/Tokyo", windows: [...] });
new TimeWindowRule({ timezone: "UTC", windows: [...] });
```

::: danger
If you provide an invalid timezone string, the rule will deny ALL transactions. This is the fail-closed behavior -- an invalid configuration is treated as "never active."
:::

## Overnight Windows

The rule supports overnight windows where the start time is after the end time. For example, a window from 22:00 to 06:00 means "active from 10 PM until 6 AM the next morning."

```typescript
const rule = new TimeWindowRule({
  timezone: "America/New_York",
  windows: [
    {
      days: ["mon", "tue", "wed", "thu", "fri"],
      start: "22:00",
      end: "06:00",
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
const rule = new TimeWindowRule({
  timezone: "America/New_York",
  windows: [
    // Weekday business hours
    {
      days: ["mon", "tue", "wed", "thu", "fri"],
      start: "09:00",
      end: "17:00",
    },
    // Saturday morning
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
const rule = new TimeWindowRule({
  timezone: "America/New_York",
  windows: [
    { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" },
  ],
  outsideHoursPolicy: "require_approval",
});
```

::: tip
When `outsideHoursPolicy` is set to `"require_approval"`, the rule still returns `DENY` (not `PENDING`). The denial reason indicates that approval is required. To actually implement the approval flow, pair this rule with an `ApprovalGateRule` and handle the outside-hours case in your application logic.
:::

## Code Examples

### Business Hours Only

Classic 9-to-5, Monday through Friday:

```typescript
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
const rule = new TimeWindowRule({
  timezone: "America/Chicago",
  windows: [
    {
      days: ["mon", "tue", "wed", "thu", "fri"],
      start: "22:00",
      end: "06:00",
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
const config = rule.getConfig();
console.log("Timezone:", config.timezone);
console.log("Windows:", config.windows);
console.log("Outside policy:", config.outsideHoursPolicy);
```
