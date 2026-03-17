# Policy Engine

::: info What you'll learn
- How the PolicyEngine evaluates rules sequentially with fail-closed semantics
- Why rule ordering matters and the recommended order for performance
- How to use the fluent Policy builder to define constraints declaratively
- How policy configs can be serialized, stored, and restored
- The three possible evaluation outcomes: ALLOW, DENY, and PENDING
:::

## Overview

The `PolicyEngine` is **like middleware in Express.js or a firewall in front of your server -- every transaction request must pass through it before anything happens on the blockchain**. Just as Express middleware can inspect an incoming HTTP request and decide to allow it, reject it, or ask for additional authentication, the PolicyEngine inspects every transaction intent and decides whether to allow it, deny it, or pause it for human approval.

Without a PolicyEngine, your AI agent would have unrestricted access to your wallet. With it, you define the exact rules for what the agent is allowed to do -- spending limits, rate limits, address allowlists, time windows, and approval thresholds. The engine enforces these rules automatically on every transaction.

The `PolicyEngine` is the core enforcement layer of `kova`. It holds an ordered list of policy rules and evaluates them sequentially against each transaction intent.

::: warning Advanced API
`PolicyEngine` is exported as `@internal` from `@kova-sdk/wallet`. For most use cases, prefer the `Policy` builder pattern (shown below) which provides a safer, declarative API. Direct `PolicyEngine` usage is available for advanced scenarios where you need fine-grained control over rule construction.
:::

### When would I use this?

- **You want to limit how much your agent can spend.** Set per-transaction, daily, weekly, or monthly spending caps.
- **You want to control how fast your agent can transact.** Rate-limit transactions to prevent runaway loops.
- **You want to restrict where funds can go.** Allowlist specific recipient addresses and block everything else.
- **You want human oversight for large transactions.** Require human approval above a certain amount via any channel (Slack, email, webhook, etc.).
- **You want transactions restricted to business hours.** Only allow operations during specific days and times.

## Constructor

```typescript
// Import the PolicyEngine class from the kova SDK.
// The PolicyEngine is responsible for evaluating transaction intents against a set of rules.
import { PolicyEngine } from "@kova-sdk/wallet";

// Create a new PolicyEngine instance.
// - rules: an ordered array of PolicyRule objects (evaluated sequentially; order matters!).
// - store: the persistence layer for rule state (spending counters, rate-limit counters, etc.).
// - approval (optional): the approval channel used by rules that require human-in-the-loop (e.g., ApprovalGateRule).
const engine = new PolicyEngine(rules, store, approval?, getValueInUSD?, mutexTimeoutMs?, storeOpTimeoutMs?, minEvaluationTimeMs?);
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `rules` | `PolicyRule[]` | Yes | Ordered list of rules to evaluate. Must contain at least one rule. |
| `store` | `Store` | Yes | Store instance for spending counters, rate limits, etc. (the database that tracks how much has been spent) |
| `approval` | `ApprovalChannel` | No | Approval channel for rules that require human-in-the-loop (e.g., `CallbackApprovalChannel`) |
| `getValueInUSD` | `(token: string, amount: string) => Promise<number>` | No | Function to convert token amounts to USD for spending limit evaluation |
| `mutexTimeoutMs` | `number` | No | Timeout in milliseconds for acquiring the evaluation mutex |
| `storeOpTimeoutMs` | `number` | No | Timeout in milliseconds for individual store operations during evaluation |
| `minEvaluationTimeMs` | `number` | No | Minimum evaluation time in milliseconds to prevent timing side-channel attacks |

::: danger
The `PolicyEngine` constructor throws an error if `rules` is empty. An engine with zero rules would allow all transactions unconditionally, violating the deny-by-default principle. You must always have at least one rule.
:::

```typescript
// Import the necessary classes for building a policy engine.
// PolicyEngine: the core evaluator that runs rules against intents.
// MemoryStore: in-memory store for development/testing (data lost on restart).
// SpendingLimitRule: enforces per-transaction, daily, weekly, monthly spending caps.
// RateLimitRule: limits the number of transactions per time window.
import {
  PolicyEngine,
  MemoryStore,
  SpendingLimitRule,
  RateLimitRule,
} from "@kova-sdk/wallet";

// Create an in-memory store for rule state persistence.
// In production, use SqliteStore or a custom Store implementation for durability.
const store = new MemoryStore();

// Create a PolicyEngine with two rules, ordered from cheapest to most expensive.
// Rule 1 (RateLimitRule): allows at most 5 transactions per minute. This is a simple
//   counter check — very fast — so it runs first. If the rate limit is exceeded,
//   the more expensive SpendingLimitRule is never evaluated.
// Rule 2 (SpendingLimitRule): allows at most 10 SOL per rolling 24-hour period.
//   This requires reading and updating counters in the store, which is more expensive.
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
// Method signature: takes a TransactionIntent and returns a PolicyEvaluationResult.
// The result contains the final decision (ALLOW/DENY/PENDING), per-rule audit data,
// and the total evaluation time. This method is called internally by AgentWallet.execute().
async evaluate(intent: TransactionIntent, now?: number): Promise<PolicyEvaluationResult>
```

The `evaluate()` method processes rules **sequentially** in the order they were provided to the constructor. Think of it as a pipeline of security checkpoints -- the transaction must pass through each one, and any single checkpoint can reject it.

### Two-Phase Evaluation (Dry-Run + Commit)

The PolicyEngine uses a **two-phase evaluation** strategy to prevent counter inflation:

1. **Dry-run phase**: All rules are evaluated without modifying any counters in the store. This determines whether the transaction _would_ be allowed.
2. **Commit phase**: If the dry-run returns ALLOW, the engine re-evaluates and commits counter updates (spending amounts, rate limit increments) to the store.

This prevents a subtle bug: if a rule increments a spending counter during evaluation, but a later rule denies the transaction, the counter would be inflated even though no money was actually spent. The two-phase approach ensures counters are only updated when the transaction actually proceeds.

### How Two-Phase Evaluation Works

1. **Phase 1 (Dry-Run)**: All rules are evaluated using a `DryRunStore` -- a temporary overlay that intercepts counter writes (spending increments, rate limit bumps) and records them without modifying the real store. This determines whether the transaction _would_ be allowed without side effects.
2. **Phase 2 (Commit)**: If Phase 1 returns ALLOW, the engine re-evaluates and commits counter updates to the real store using a `Phase2TrackingStore`. If any rule fails during Phase 2, all counter updates are rolled back to maintain consistency.
3. **Exception Handling**: If a rule throws an exception during evaluation, the result is automatically `DENY` (fail-closed). The error is captured in the audit trail but sanitized before reaching the agent.

This prevents counter inflation: if rule A increments a spending counter but rule B denies the transaction, the counter would be inflated even though no money was actually spent. The two-phase approach ensures counters are only updated when the transaction proceeds.

### Sequential Rule Evaluation

1. For each rule, call `rule.evaluate(intent, context)`.
2. If a rule returns `DENY`, stop immediately and return the denial.
3. If a rule returns `PENDING`, stop immediately and return the pending state.
4. If a rule returns `ALLOW`, continue to the next rule.
5. If all rules return `ALLOW`, the final decision is `ALLOW`.
6. **If a rule throws an exception**, the result is `DENY` (fail-closed). The error message is captured in the audit trail.

::: tip Fail-closed design
The PolicyEngine uses a "fail-closed" design, meaning that if anything goes wrong (a rule throws an error, a database is unreachable, etc.), the transaction is **denied** rather than allowed. This is the same principle used in firewalls -- when in doubt, block the request. It is always safer to accidentally deny a legitimate transaction than to accidentally allow a malicious one.
:::

Every rule evaluation is timed. The result includes per-rule audit data showing which rules were evaluated, their decisions, and how long each took.

```
Rule 1 (rate-limit)    → ALLOW   (0.2ms)
Rule 2 (time-window)   → ALLOW   (0.1ms)
Rule 3 (allowlist)     → ALLOW   (0.05ms)
Rule 4 (spending-limit) → DENY   (1.3ms)   ← stops here
Rule 5 (approval-gate) → (not evaluated)
```

## Rule Ordering Strategy

Order rules from cheapest to most expensive. This minimizes wasted computation when a cheap rule would deny the transaction anyway. This is the same optimization pattern you see in database query planners or short-circuit evaluation in boolean logic.

**Recommended order:**

| Position | Rule | Cost | Reason |
|----------|------|------|--------|
| 1 | `RateLimitRule` | Very low | Simple counter lookup, no amount parsing |
| 2 | `TimeWindowRule` | Very low | Date/time check, no store access |
| 3 | `AllowlistRule` | Low | Set membership check |
| 4 | `SpendingLimitRule` | Medium | Store reads for spending counters |
| 5 | `ApprovalGateRule` | Very high | Blocks for minutes waiting for human response |

```typescript
// Create a PolicyEngine with all five built-in rules in the recommended order.
// Rules are evaluated top-to-bottom; evaluation stops at the first DENY or PENDING.
const engine = new PolicyEngine(
  [
    // Position 1: RateLimitRule — cheapest check (simple counter in store).
    // Denies immediately if the agent has exceeded its transaction-per-minute/hour quota.
    new RateLimitRule(config.rateLimit!),

    // Position 2: TimeWindowRule — very cheap (in-memory date/time comparison).
    // Denies if the current time falls outside the configured active hours.
    new TimeWindowRule(config.activeHours!),

    // Position 3: AllowlistRule — cheap (O(1) Set lookup).
    // Denies if the target address or program is not in the allowlist (or is denylisted).
    new AllowlistRule({ allowAddresses: config.allowAddresses }),

    // Position 4: SpendingLimitRule — medium cost (reads/writes counters in the store).
    // Denies if the transaction would exceed per-transaction, daily, weekly, or monthly caps.
    new SpendingLimitRule(config.spendingLimit!),

    // Position 5: ApprovalGateRule — most expensive (blocks execution waiting for human response).
    // Only reached if ALL cheaper rules have passed. Sends an approval request and waits.
    new ApprovalGateRule(config.approvalGate!),
  ],
  store,
  approval, // The approval channel (e.g., CallbackApprovalChannel) used by ApprovalGateRule
);
```

::: tip
If you place `ApprovalGateRule` first, every high-value transaction would trigger an approval request even if it would be denied by a rate limit. By placing cheap rules first, the agent gets an instant denial without bothering the human approver.
:::

::: warning You do not need all five rules
Most setups only need 2-3 rules. A common minimal configuration is just `RateLimitRule` + `SpendingLimitRule`. Only add `AllowlistRule`, `TimeWindowRule`, or `ApprovalGateRule` when your use case requires them.
:::

::: warning Spending limit and approval gate interaction
Because `SpendingLimitRule` evaluates before `ApprovalGateRule`, the spending limit acts as a **hard ceiling**. Transactions that exceed the spending limit are denied outright and never reach the approval gate for human review. If you want transactions above a threshold to route to human approval instead of being denied, set the per-transaction spending limit **higher** than the approval gate threshold. For example:

- Per-transaction spending limit: **10 SOL** (hard cap)
- Approval gate threshold: **1 SOL** (human review)
- Transactions ≤ 1 SOL: auto-approved
- Transactions 1-10 SOL: routed to approval
- Transactions > 10 SOL: denied by spending limit
:::

## Verbose Error Messages

By default, policy denial messages are **sanitized** before being returned to the caller. Numeric values (amounts, limits), rule names, and other details are stripped to prevent untrusted agents from performing policy reconnaissance.

To see the full, unredacted denial messages (useful for dashboards and debugging), set `verboseErrors: true` when constructing the `AgentWallet`:

```typescript
const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  verboseErrors: true, // Show full denial details (amounts, limits, rule names)
});
```

With `verboseErrors: false` (default):
```
Denied by policy: Per-transaction policy rule limit exceeded
```

With `verboseErrors: true`:
```
Denied by policy: Per-transaction spending limit exceeded: tried to send 3 SOL, limit is 2 SOL
```

## PolicyEvaluationResult

The result object returned by `evaluate()`. It tells you the final decision, provides a detailed audit trail for each rule that was evaluated, and reports the total evaluation time.

```typescript
// The result returned by PolicyEngine.evaluate().
// Contains the overall decision, a detailed audit trail for each rule evaluated,
// and the total wall-clock time for the entire evaluation.
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

The three possible outcomes. If you have used HTTP status codes, think of `ALLOW` as 200 OK, `DENY` as 403 Forbidden, and `PENDING` as 202 Accepted (processing, awaiting human input).

```typescript
// A discriminated union representing the three possible outcomes of policy evaluation.
// Use the `decision` field to determine which variant you have.
type PolicyDecision = PolicyAllow | PolicyDeny | PolicyPending;

// All rules passed — the transaction is approved to proceed.
interface PolicyAllow {
  decision: "ALLOW";
}

// A rule denied the transaction — it will NOT be executed.
interface PolicyDeny {
  decision: "DENY";
  rule: string;       // The name of the rule that produced this denial (e.g., "spending-limit")
  reason: string;     // Human-readable explanation (e.g., "Daily spending limit exceeded: 8 + 3 = 11 SOL > 10 SOL")
}

// A rule requires human approval — the transaction is paused until a decision arrives.
interface PolicyPending {
  decision: "PENDING";
  rule: string;                // The name of the rule that requires approval (e.g., "approval-gate")
  approvalRequestId: string;   // The unique ID of the approval request (used to track the response)
}
```

### PolicyRuleAudit

Each rule evaluation produces an audit entry. These are stored in the audit log and are invaluable for debugging why a transaction was allowed or denied.

```typescript
// One entry in the per-rule audit trail. The PolicyEngine creates one of these
// for each rule it evaluates, recording the decision and timing.
// This data is stored in the audit log for post-incident analysis.
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

### Denial Reason Sanitization

When a policy denial is returned to an AI agent via `handleToolCall()`, the denial reason is sanitized:

- Rule names are replaced with the generic label `"policy rule"` so the agent cannot learn which specific rule blocked it
- Counter values and threshold details are stripped
- The full, unsanitized reason is preserved in the audit log for human operators

This prevents a malicious or probing agent from reverse-engineering policy limits by analyzing denial messages.

## Engine Introspection

These methods let you inspect the engine's configuration at runtime. Useful for building admin dashboards, logging which rules are active, or debugging policy issues.

### getRuleNames()

Get the names of all configured rules.

```typescript
// Retrieve an array of rule name strings from the engine.
// Useful for logging, debugging, or building admin UIs that display which rules are active.
const names = engine.getRuleNames();
// Example output: ["rate-limit", "allowlist", "spending-limit"]
```

### getRules()

Get a frozen copy of the rules array. This is used internally by the wallet for policy introspection.

```typescript
// Get a read-only (frozen) copy of the rules array.
// You can inspect rule configurations but cannot modify the engine's rules after construction.
// This is used internally by AgentWallet.getPolicy() to build the PolicySummary.
const rules = engine.getRules();
// Returns: readonly PolicyRule[]
```

::: tip Immutable after construction
The PolicyEngine's rules are locked after construction. You cannot add, remove, or reorder rules at runtime. This is a deliberate safety decision -- policy changes should be explicit and require creating a new engine, not silently modifying a running one.
:::

## Building from a Policy Config

The most common pattern is to use the `Policy` builder to define constraints, then extract the config to create individual rules. The `Policy` builder provides a fluent (chainable) API -- if you have used libraries like Joi, Zod, or Knex.js, the pattern will feel familiar.

```typescript
// Import all the classes and rules needed for the full Policy builder workflow.
import {
  Policy,              // The fluent builder for constructing policy configurations
  PolicyEngine,        // The runtime engine that evaluates rules
  MemoryStore,         // In-memory persistence (use SqliteStore in production)
  SpendingLimitRule,   // Enforces spending caps
  RateLimitRule,       // Limits transaction frequency
  AllowlistRule,       // Restricts allowed addresses and programs
  TimeWindowRule,      // Restricts when transactions can occur
  ApprovalGateRule,    // Requires human approval above a threshold
  CallbackApprovalChannel, // Sends approval requests via callbacks
} from "@kova-sdk/wallet";

// Step 1: Build the policy config using the fluent builder API.
// The builder provides a chainable interface for defining all constraints.
// Policy.create() takes a human-readable name for this policy.
const policy = Policy.create("production-agent")
  // Set spending limits: max 5 SOL per transaction, 50 SOL per day, 500 SOL per month.
  // These are rolling windows (not calendar-based), tracked via store counters.
  .spendingLimit({
    perTransaction: { amount: "5", token: "SOL" },
    daily: { amount: "50", token: "SOL" },
    monthly: { amount: "500", token: "SOL" },
  })
  // Restrict transfers to only these two pre-approved Solana addresses.
  // Any transfer to an address NOT in this list will be denied by AllowlistRule.
  .allowAddresses([
    "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH",
  ])
  // Set rate limits: max 3 transactions per minute, 30 per hour.
  // Prevents runaway agents from flooding the network.
  .rateLimit({
    maxTransactionsPerMinute: 3,
    maxTransactionsPerHour: 30,
  })
  // Set active hours: only allow transactions on weekdays, 9 AM to 5 PM Eastern.
  // Transactions outside this window will be denied.
  .activeHours({
    timezone: "America/New_York",
    windows: [
      { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" },
    ],
  })
  // Require human approval for transactions above 10 SOL.
  // The timeout of 600,000ms (10 minutes) means unanswered requests are auto-denied.
  .requireApproval({
    above: { amount: "10", token: "SOL" },
    timeout: 600_000,
  })
  // Finalize the policy. This validates all configuration (rejects invalid amounts,
  // overlapping allow/deny lists, etc.) and returns a frozen Policy object.
  .build();

// Step 2: Extract the raw config object from the built policy.
// This is a plain JSON-serializable object that can be stored, logged, or transmitted.
const config = policy.toJSON();

// Step 3: Create the rule instances and support objects.
// Each rule is constructed from the relevant section of the policy config.
const store = new MemoryStore();

// Set up the approval channel for human-in-the-loop approval.
const approval = new CallbackApprovalChannel({
  name: "my-approval",
  onApprovalRequest: async (request) => {
    await notifyApprover(request);
  },
  waitForDecision: async (request) => {
    return pollForResponse(request.id);
  },
});

// Create the rule array in the recommended order: cheapest rules first.
// This ensures that expensive operations (like waiting for human approval)
// only run when all cheap checks have already passed.
const rules = [
  new RateLimitRule(config.rateLimit!),                          // Cheapest: counter lookup
  new TimeWindowRule(config.activeHours!),                       // Cheap: date/time check
  new AllowlistRule({ allowAddresses: config.allowAddresses }),  // Cheap: Set membership check
  new SpendingLimitRule(config.spendingLimit!),                  // Medium: store counter read/write
  new ApprovalGateRule(config.approvalGate!),                    // Expensive: blocks for human response
];

// Step 4: Create the PolicyEngine with the ordered rules, store, and approval channel.
// The engine is now ready to be passed to an AgentWallet constructor.
const engine = new PolicyEngine(rules, store, approval);
```

## Policy Builder API

The `Policy` builder provides a fluent interface for constructing policy configurations. It validates your settings at build time and produces a serializable config object.

### Policy.create(name)

Create a new policy with the given name. Returns a `PolicyBuilder`.

```typescript
// Start building a new policy. The name is used for identification in logs and summaries.
// Returns a PolicyBuilder with chainable methods for configuring constraints.
const builder = Policy.create("my-policy");
```

### Policy.fromJSON(config)

Load a policy from a `PolicyConfig` object. Validates the config before constructing. Use this when loading policies from a database, config file, or API response.

```typescript
// Reconstruct a Policy from a plain JSON config object.
// This is useful for loading policies from a database, config file, or API response.
// The config is validated — invalid values (negative amounts, bad time formats, etc.)
// will throw an error.
const policy = Policy.fromJSON({
  name: "restored-policy",
  spendingLimit: { daily: { amount: "10", token: "SOL" } },
  rateLimit: { maxTransactionsPerHour: 20 },
});
```

### Policy.extend(base, name)

Create a new policy that inherits all settings from an existing policy, then override specific fields. This is useful when you have multiple agents with different trust levels -- create a base policy with common settings, then create stricter or looser variants.

```typescript
// Create a base policy with moderate limits.
const basePolicy = Policy.create("base")
  .spendingLimit({ daily: { amount: "10", token: "SOL" } })
  .rateLimit({ maxTransactionsPerHour: 20 })
  .build();

// Extend the base policy to create a stricter variant.
// Policy.extend() copies all settings from basePolicy, then the chained methods override
// specific fields. Here we tighten the daily spending limit from 10 SOL to 5 SOL.
// The rate limit (20/hour) is inherited unchanged from the base.
const stricterPolicy = Policy.extend(basePolicy, "stricter")
  .spendingLimit({ daily: { amount: "5", token: "SOL" } })
  .build();
```

### policy.toJSON()

Serialize the policy to a `PolicyConfig` object. Returns a deep copy that is safe to mutate.

```typescript
// Serialize the policy to a plain JSON object.
// The returned object is a deep copy — mutating it does NOT affect the original policy.
// Use this for saving to a database, sending over an API, or logging.
const config: PolicyConfig = policy.toJSON();
```

### policy.getConfig()

Get the full configuration as a `Readonly<PolicyConfig>`. Returns a deep copy.

```typescript
// Get the full policy configuration as a read-only deep copy.
// The Readonly<> type hint reminds you not to mutate it, though runtime enforcement
// depends on the implementation.
const config: Readonly<PolicyConfig> = policy.getConfig();
```

### policy.getName()

Get the policy name.

```typescript
// Retrieve the human-readable name given to this policy at creation time.
// This is included in PolicySummary and audit logs.
const name: string = policy.getName();
```

## Serialization Roundtrip

Policies can be serialized to JSON for storage, transmission, or configuration files. This makes it easy to store your policy in a database, load it from a config file, or send it over an API -- and reconstruct the exact same policy later.

```typescript
import { Policy } from "@kova-sdk/wallet";

// Create a policy with spending limits, rate limits, and an address allowlist.
const original = Policy.create("agent-policy")
  .spendingLimit({
    perTransaction: { amount: "2", token: "SOL" },
    daily: { amount: "20", token: "SOL" },
  })
  .rateLimit({ maxTransactionsPerMinute: 5, maxTransactionsPerHour: 50 })
  .allowAddresses(["9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"])
  .build();

// Serialize the policy to a JSON-compatible object, then to a JSON string.
// JSON.stringify with (null, 2) produces pretty-printed output for readability.
const json = original.toJSON();
const serialized = JSON.stringify(json, null, 2);
console.log(serialized);

// Deserialize: parse the JSON string back into a plain object,
// then reconstruct a full Policy instance using Policy.fromJSON().
// The fromJSON() method validates the config, ensuring it is well-formed.
const parsed = JSON.parse(serialized);
const restored = Policy.fromJSON(parsed);

// Verify the roundtrip: the restored policy should have the same name and config
// as the original. This confirms that serialization preserves all policy data.
console.log("Name:", restored.getName());
const restoredConfig = restored.getConfig();
console.log("Daily limit:", restoredConfig.spendingLimit?.daily?.amount);
// Output: "20"
```

This makes it straightforward to store policy configurations in databases, configuration files, or environment variables and reconstruct them at runtime.

## Common Mistakes

**1. Putting `ApprovalGateRule` before cheaper rules.**
If `ApprovalGateRule` is first, every high-value transaction will trigger an approval request to a human -- even ones that would be instantly denied by a rate limit or spending cap. Always put cheap rules first and expensive rules last.

**2. Passing an empty rules array.**
The `PolicyEngine` constructor throws an error if you pass `[]`. This is intentional -- a policy with no rules would allow everything, which defeats the purpose. You must always have at least one rule.

**3. Forgetting to pass the `approval` channel when using `ApprovalGateRule`.**
If you include an `ApprovalGateRule` in your rules but do not pass an `ApprovalChannel` to the `PolicyEngine` constructor, the approval rule will not be able to send approval requests and will deny all transactions that trigger it.

## Quick Reference

### Built-in Rules

| Rule | What it does | Key config |
|------|-------------|------------|
| `RateLimitRule` | Limits how many transactions can execute per minute/hour | `maxTransactionsPerMinute`, `maxTransactionsPerHour` |
| `TimeWindowRule` | Restricts transactions to specific days and times | `timezone`, `windows` (day + start/end time) |
| `AllowlistRule` | Only allows transactions to pre-approved addresses | `allowAddresses`, `denyAddresses`, `allowPrograms` |
| `SpendingLimitRule` | Caps spending per-transaction, daily, weekly, or monthly | `perTransaction`, `daily`, `weekly`, `monthly` |
| `ApprovalGateRule` | Requires human approval above a threshold | `above` (amount + token), `timeout` |

### PolicyEngine Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `evaluate(intent, now?)` | `Promise<PolicyEvaluationResult>` | Evaluate an intent against all rules (called internally by `wallet.execute()`). Optional `now` parameter overrides the current timestamp. |
| `getRuleNames()` | `string[]` | Get the names of all configured rules |
| `getRules()` | `readonly PolicyRule[]` | Get a frozen copy of the rules array |

### Policy Builder Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `Policy.create(name)` | `PolicyBuilder` | Start building a new policy with the given name |
| `Policy.fromJSON(config)` | `Policy` | Reconstruct a policy from a serialized config object |
| `Policy.extend(base, name)` | `PolicyBuilder` | Create a new policy inheriting settings from a base policy |
| `.spendingLimit(config)` | `PolicyBuilder` | Set spending caps (per-tx, daily, weekly, monthly) |
| `.allowAddresses(addresses)` | `PolicyBuilder` | Restrict transfers to specific recipient addresses |
| `.rateLimit(config)` | `PolicyBuilder` | Set transaction frequency limits |
| `.activeHours(config)` | `PolicyBuilder` | Restrict transactions to specific days/times |
| `.requireApproval(config)` | `PolicyBuilder` | Require human approval above a threshold |
| `.build()` | `Policy` | Validate and finalize the policy (returns a frozen Policy) |
| `policy.toJSON()` | `PolicyConfig` | Serialize to a JSON-compatible config object (deep copy) |
| `policy.getConfig()` | `Readonly<PolicyConfig>` | Get the full config as a read-only deep copy |
| `policy.getName()` | `string` | Get the policy name |
