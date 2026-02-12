# Policy Engine

The `PolicyEngine` is the core enforcement layer of `kova`. It holds an ordered list of policy rules and evaluates them sequentially against each transaction intent.

## Constructor

```typescript
import { PolicyEngine } from "kova";

const engine = new PolicyEngine(rules, store, approval?);
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `rules` | `PolicyRule[]` | Yes | Ordered list of rules to evaluate. Must contain at least one rule. |
| `store` | `Store` | Yes | Store instance for spending counters, rate limits, etc. |
| `approval` | `ApprovalChannel` | No | Approval channel for rules that require human-in-the-loop |

::: danger
The `PolicyEngine` constructor throws an error if `rules` is empty. An engine with zero rules would allow all transactions unconditionally, violating the deny-by-default principle.
:::

```typescript
import {
  PolicyEngine,
  MemoryStore,
  SpendingLimitRule,
  RateLimitRule,
} from "kova";

const store = new MemoryStore();

const engine = new PolicyEngine(
  [
    new RateLimitRule({ maxTransactionsPerMinute: 5 }),
    new SpendingLimitRule({ daily: { amount: "10", token: "SOL" } }),
  ],
  store,
);
```

## How evaluate() Works

```typescript
async evaluate(intent: TransactionIntent): Promise<PolicyEvaluationResult>
```

The `evaluate()` method processes rules **sequentially** in the order they were provided to the constructor:

1. For each rule, call `rule.evaluate(intent, context)`.
2. If a rule returns `DENY`, stop immediately and return the denial.
3. If a rule returns `PENDING`, stop immediately and return the pending state.
4. If a rule returns `ALLOW`, continue to the next rule.
5. If all rules return `ALLOW`, the final decision is `ALLOW`.
6. **If a rule throws an exception**, the result is `DENY` (fail-closed). The error message is captured in the audit trail.

Every rule evaluation is timed. The result includes per-rule audit data showing which rules were evaluated, their decisions, and how long each took.

```
Rule 1 (rate-limit)    → ALLOW   (0.2ms)
Rule 2 (time-window)   → ALLOW   (0.1ms)
Rule 3 (allowlist)     → ALLOW   (0.05ms)
Rule 4 (spending-limit) → DENY   (1.3ms)   ← stops here
Rule 5 (approval-gate) → (not evaluated)
```

## Rule Ordering Strategy

Order rules from cheapest to most expensive. This minimizes wasted computation when a cheap rule would deny the transaction anyway.

**Recommended order:**

| Position | Rule | Cost | Reason |
|----------|------|------|--------|
| 1 | `RateLimitRule` | Very low | Simple counter lookup, no amount parsing |
| 2 | `TimeWindowRule` | Very low | Date/time check, no store access |
| 3 | `AllowlistRule` | Low | Set membership check |
| 4 | `SpendingLimitRule` | Medium | Store reads for spending counters |
| 5 | `ApprovalGateRule` | Very high | Blocks for minutes waiting for human response |

```typescript
const engine = new PolicyEngine(
  [
    new RateLimitRule(config.rateLimit!),
    new TimeWindowRule(config.activeHours!),
    new AllowlistRule({ allowAddresses: config.allowAddresses }),
    new SpendingLimitRule(config.spendingLimit!),
    new ApprovalGateRule(config.approvalGate!),
  ],
  store,
  approval,
);
```

::: tip
If you place `ApprovalGateRule` first, every high-value transaction would trigger a Telegram message even if it would be denied by a rate limit. By placing cheap rules first, the agent gets an instant denial without bothering the human approver.
:::

## PolicyEvaluationResult

```typescript
interface PolicyEvaluationResult {
  /** The final policy decision */
  decision: PolicyDecision;
  /** Per-rule audit trail (one entry per rule evaluated) */
  ruleAudits: PolicyRuleAudit[];
  /** Total wall-clock time for all rule evaluations */
  totalEvaluationTimeMs: number;
}
```

### PolicyDecision

```typescript
type PolicyDecision = PolicyAllow | PolicyDeny | PolicyPending;

interface PolicyAllow {
  decision: "ALLOW";
}

interface PolicyDeny {
  decision: "DENY";
  rule: string;       // Which rule produced this denial
  reason: string;     // Human-readable explanation
}

interface PolicyPending {
  decision: "PENDING";
  rule: string;                // Which rule requires approval
  approvalRequestId: string;   // The approval request ID
}
```

### PolicyRuleAudit

```typescript
interface PolicyRuleAudit {
  /** Which policy rule was evaluated */
  rule: string;
  /** The result: "ALLOW" | "DENY" | "PENDING" */
  result: "ALLOW" | "DENY" | "PENDING";
  /** Human-readable explanation (present on DENY) */
  reason?: string;
  /** Time taken to evaluate this rule in milliseconds */
  evaluationTimeMs: number;
}
```

## Engine Introspection

### getRuleNames()

Get the names of all configured rules.

```typescript
const names = engine.getRuleNames();
// ["rate-limit", "allowlist", "spending-limit"]
```

### getRules()

Get a frozen copy of the rules array. This is used internally by the wallet for policy introspection.

```typescript
const rules = engine.getRules();
// Returns: readonly PolicyRule[]
```

## Building from a Policy Config

The most common pattern is to use the `Policy` builder to define constraints, then extract the config to create individual rules:

```typescript
import {
  Policy,
  PolicyEngine,
  MemoryStore,
  SpendingLimitRule,
  RateLimitRule,
  AllowlistRule,
  TimeWindowRule,
  ApprovalGateRule,
  TelegramApprovalBot,
} from "kova";

// Step 1: Build the policy config
const policy = Policy.create("production-agent")
  .spendingLimit({
    perTransaction: { amount: "5", token: "SOL" },
    daily: { amount: "50", token: "SOL" },
    monthly: { amount: "500", token: "SOL" },
  })
  .allowAddresses([
    "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH",
  ])
  .rateLimit({
    maxTransactionsPerMinute: 3,
    maxTransactionsPerHour: 30,
  })
  .activeHours({
    timezone: "America/New_York",
    windows: [
      { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" },
    ],
  })
  .requireApproval({
    above: { amount: "10", token: "SOL" },
    timeout: 600_000,
  })
  .build();

// Step 2: Extract config
const config = policy.toJSON();

// Step 3: Create rules (cheapest first)
const store = new MemoryStore();
const approval = new TelegramApprovalBot({
  token: process.env.TELEGRAM_BOT_TOKEN!,
  chatId: process.env.TELEGRAM_CHAT_ID!,
});

const rules = [
  new RateLimitRule(config.rateLimit!),
  new TimeWindowRule(config.activeHours!),
  new AllowlistRule({ allowAddresses: config.allowAddresses }),
  new SpendingLimitRule(config.spendingLimit!),
  new ApprovalGateRule(config.approvalGate!),
];

// Step 4: Create the engine
const engine = new PolicyEngine(rules, store, approval);
```

## Policy Builder API

### Policy.create(name)

Create a new policy with the given name. Returns a `PolicyBuilder`.

```typescript
const builder = Policy.create("my-policy");
```

### Policy.fromJSON(config)

Load a policy from a `PolicyConfig` object. Validates the config before constructing.

```typescript
const policy = Policy.fromJSON({
  name: "restored-policy",
  spendingLimit: { daily: { amount: "10", token: "SOL" } },
  rateLimit: { maxTransactionsPerHour: 20 },
});
```

### Policy.extend(base, name)

Create a new policy that inherits all settings from an existing policy, then override specific fields.

```typescript
const basePolicy = Policy.create("base")
  .spendingLimit({ daily: { amount: "10", token: "SOL" } })
  .rateLimit({ maxTransactionsPerHour: 20 })
  .build();

const stricterPolicy = Policy.extend(basePolicy, "stricter")
  .spendingLimit({ daily: { amount: "5", token: "SOL" } })
  .build();
```

### policy.toJSON()

Serialize the policy to a `PolicyConfig` object. Returns a deep copy that is safe to mutate.

```typescript
const config: PolicyConfig = policy.toJSON();
```

### policy.getConfig()

Get the full configuration as a `Readonly<PolicyConfig>`. Returns a deep copy.

```typescript
const config: Readonly<PolicyConfig> = policy.getConfig();
```

### policy.getName()

Get the policy name.

```typescript
const name: string = policy.getName();
```

## Serialization Roundtrip

Policies can be serialized to JSON for storage, transmission, or configuration files:

```typescript
import { Policy } from "kova";

// Create a policy
const original = Policy.create("agent-policy")
  .spendingLimit({
    perTransaction: { amount: "2", token: "SOL" },
    daily: { amount: "20", token: "SOL" },
  })
  .rateLimit({ maxTransactionsPerMinute: 5, maxTransactionsPerHour: 50 })
  .allowAddresses(["9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"])
  .build();

// Serialize to JSON
const json = original.toJSON();
const serialized = JSON.stringify(json, null, 2);
console.log(serialized);

// Deserialize from JSON
const parsed = JSON.parse(serialized);
const restored = Policy.fromJSON(parsed);

// Verify roundtrip
console.log("Name:", restored.getName());
const restoredConfig = restored.getConfig();
console.log("Daily limit:", restoredConfig.spendingLimit?.daily?.amount);
// Output: "20"
```

This makes it straightforward to store policy configurations in databases, configuration files, or environment variables and reconstruct them at runtime.
