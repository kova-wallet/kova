# ApprovalGateRule

::: info What you'll learn
- How to require human approval for transactions above a configurable threshold
- The full approval flow: request, wait, approve/reject/timeout
- How to integrate with CallbackApprovalChannel or WebhookApprovalChannel for real-time notifications
- Fail-closed behavior: what happens when approval channels are unavailable
- Why the approval gate should always be the last rule in the chain
:::

`ApprovalGateRule` pauses high-value transactions and waits for a human to approve or reject them -- like a manager signing off on expense reports above a certain dollar amount.

The `ApprovalGateRule` requires human approval for transactions above a configurable threshold. It integrates with the `ApprovalChannel` abstraction to send approval requests and wait for human decisions.

## When to Use This

- **Human-in-the-loop for large transactions**: Use `ApprovalGateRule` when transactions above a certain value (e.g., 10 SOL) should require a human to explicitly approve them before they execute.
- **Compliance and oversight**: In regulated environments, certain transaction sizes may require managerial sign-off. This rule automates the request-and-wait workflow.
- **Gradual trust building**: Start with a low approval threshold for a new agent, then raise it as the agent proves reliable -- giving humans visibility into early operations.

## How It Works

Think of `ApprovalGateRule` as an expense approval workflow. When your agent tries to send a transaction:

1. The rule checks the transaction amount against a threshold (e.g., 10 SOL).
2. **If the amount is at or below the threshold**, the transaction is auto-approved -- no human needed.
3. **If the amount is above the threshold**, the rule sends a notification (via the configured `ApprovalChannel`) to a human approver with details of the transaction.
4. The system then **waits** for the human to respond with "approve" or "reject."
5. If the human approves, the transaction proceeds. If they reject (or do not respond within the timeout), the transaction is denied.

::: tip
The `ApprovalGateRule` only applies to transactions in the same token as the threshold. A threshold of 10 SOL will not trigger approval for USDC transactions. USDC transactions pass through this rule untouched.
:::

## Decision Table

Given a threshold of 10 SOL with a 5-minute timeout:

| Transaction | Token Match? | Human Response | Result |
|---|---|---|---|
| Send 5 SOL | Yes (SOL) | N/A | **ALLOW** -- below threshold, no approval needed |
| Send 15 SOL | Yes (SOL) | Approved within 5 min | **ALLOW** -- human approved |
| Send 15 SOL | Yes (SOL) | Rejected | **DENY** -- human rejected |
| Send 15 SOL | Yes (SOL) | No response in 5 min | **DENY** -- timed out |
| Send 1000 USDC | No (USDC vs SOL) | N/A | **ALLOW** -- different token, rule does not apply |
| Send 15 SOL | Yes (SOL) | No approval channel configured | **DENY** -- cannot request approval |

## Import

```typescript
// Import the ApprovalGateRule class, which blocks high-value transactions
// until a human approver grants permission via the configured ApprovalChannel.
import { ApprovalGateRule } from "@kova-sdk/wallet";

// Import the TypeScript types for configuring the approval gate.
// ApprovalGateConfig: defines the threshold, channel hint, timeout, and cumulative window.
// TokenAmount: a { amount, token } pair representing the approval threshold.
// UsdSpendingLimit: a { amount } pair for USD-denominated thresholds.
import type { ApprovalGateConfig, TokenAmount, UsdSpendingLimit } from "@kova-sdk/wallet";
```

## ApprovalGateConfig

```typescript
// Configuration for the ApprovalGateRule.
// Defines at what threshold human approval is required and how long to wait for a response.
interface ApprovalGateConfig {
  /** Transactions above this amount require approval */
  above: TokenAmount;
  /** USD-denominated threshold (alternative to token-specific threshold) */
  aboveUSD?: UsdSpendingLimit;
  /** Channel type hint (optional, for documentation) */
  channel?: string;
  /** Timeout in milliseconds. Defaults to 300,000 (5 minutes) */
  timeout?: number;
  /** Rolling window in seconds for cumulative amount tracking */
  cumulativeWindow?: number;
}

// Represents a USD spending limit.
interface UsdSpendingLimit {
  /** USD amount as a string (e.g., "100") */
  amount: string;
}

// Represents the threshold amount and token.
// Transactions with an amount > this value (for the matching token) trigger the approval flow.
interface TokenAmount {
  amount: string;
  token: string;
}
```

## Constructor

```typescript
// Create an ApprovalGateRule that requires human approval for any transaction above 10 SOL.
// - above: the threshold — transactions at or below 10 SOL are auto-approved by this rule.
//   Transactions above 10 SOL trigger the approval flow.
// - timeout: 600,000ms (10 minutes) — if the human does not respond within 10 minutes,
//   the approval request expires and the transaction is automatically denied.
const rule = new ApprovalGateRule({
  above: { amount: "10", token: "SOL" },
  timeout: 600_000, // 10 minutes
});
```

The constructor takes only an `ApprovalGateConfig` object.

## How Threshold Comparison Works

The rule compares the transaction amount against the threshold:

1. **Extract amount**: Get the `amount` field from the intent params (works for transfer, swap, mint, and stake intents).
2. **Token match**: Compare the intent's token with the threshold's token (case-insensitive). If the tokens do not match, the rule returns `ALLOW` -- it does not apply to other token types.
3. **Threshold check**: If `amount <= threshold`, return `ALLOW`. If `amount > threshold`, request approval.

```
Intent: transfer 5 SOL    │ Threshold: 10 SOL    │ Result: ALLOW (below threshold)
Intent: transfer 15 SOL   │ Threshold: 10 SOL    │ Result: request approval
Intent: transfer 100 USDC │ Threshold: 10 SOL    │ Result: ALLOW (different token)
```

::: warning
Custom intents no longer pass through the approval gate. They are denied by default. If you need custom intents to bypass the approval gate, implement a custom `PolicyRule` that handles them explicitly.
:::

## The Approval Flow

When a transaction exceeds the threshold:

```
1. Amount > threshold
   │
   ▼
2. Is an ApprovalChannel configured?
   │         │
   NO        YES
   │         │
   ▼         ▼
3. DENY    4. Build ApprovalRequest
              │
              ▼
           5. channel.requestApproval(request)
              │
              ├── "approved"  → ALLOW
              ├── "rejected"  → DENY
              ├── "timeout"   → DENY
              └── throws      → DENY (fail-closed)
```

::: tip WHAT IS AN APPROVAL CHANNEL?
An `ApprovalChannel` is the communication mechanism used to reach a human approver. It is an abstraction -- the SDK provides `CallbackApprovalChannel` and `WebhookApprovalChannel` out of the box, but you can implement any channel (Slack, email, SMS, a web dashboard). The channel is responsible for delivering the approval request and returning the human's decision.
:::

### Intent Hash Binding

When an approval request is sent, a SHA-256 hash of the intent is computed and included in the request. This binds the approval to the exact transaction parameters. If the intent is modified between the approval request and execution, the hash will not match and the transaction will be denied. This prevents replay or substitution attacks.

### PENDING State

When the approval channel is available and the request is sent, the approval flow blocks the `execute()` pipeline until a decision is received (or timeout). The caller sees:

- `"confirmed"` if approved and the transaction succeeds
- `"denied"` if rejected or timed out
- `"pending"` if the approval mechanism returns a pending state

## Fail-Closed Behavior

The `ApprovalGateRule` is fail-closed in multiple ways:

| Scenario | Result |
|----------|--------|
| No approval channel configured | **DENY** with message: "no approval channel is configured" |
| Approval channel throws an error | **DENY** with message: "Approval channel error" |
| Approval request times out | **DENY** with message: "Approval request timed out" |
| Human rejects the request | **DENY** with message: "was rejected by approver" |
| Amount is below threshold | **ALLOW** (approval not needed) |
| Different token than threshold | **ALLOW** (rule does not apply) |

::: warning WHAT DOES "FAIL CLOSED" MEAN?
"Fail closed" means that when anything goes wrong (network error, timeout, misconfiguration), the system blocks the transaction rather than allowing it. This is a deliberate security choice -- it is better to temporarily block a legitimate transaction (which a human can retry) than to accidentally allow an unauthorized one.
:::

::: danger
If you configure an `ApprovalGateRule` but do NOT provide an `ApprovalChannel` to the `PolicyEngine`, all transactions above the threshold will be automatically denied. Always pass the approval channel to the `PolicyEngine` constructor.
:::

## Integration with CallbackApprovalChannel

The most common setup pairs `ApprovalGateRule` with `CallbackApprovalChannel`:

```typescript
// Import all the classes needed for a policy engine with callback-based human approval.
import {
  PolicyEngine,
  SpendingLimitRule,
  ApprovalGateRule,
  CallbackApprovalChannel,
  MemoryStore,
} from "@kova-sdk/wallet";

// Create a shared in-memory store for counter persistence.
const store = new MemoryStore();

// Create a callback-based approval channel.
// You provide two callbacks: one to notify a human, one to wait for their decision.
// This pattern works with any notification mechanism (Slack, email, SMS, etc.).
const approval = new CallbackApprovalChannel({
  name: "my-approval",
  onApprovalRequest: async (request) => {
    // Send a notification to a human (e.g., via Slack, email, SMS).
    await notifyApprover(request);
  },
  waitForDecision: async (request) => {
    // Wait for the human's response (e.g., poll a database, listen on a webhook).
    return pollForResponse(request.id);
  },
  defaultTimeout: 300_000, // 5-minute timeout before auto-denying
});

// Create the PolicyEngine with spending limits and an approval gate.
// The spending limit runs FIRST (cheaper), and the approval gate runs SECOND (expensive).
const engine = new PolicyEngine(
  [
    // SpendingLimitRule: hard cap at 50 SOL per transaction and 200 SOL per day.
    // Transactions above 50 SOL are denied outright — they never reach the approval gate.
    new SpendingLimitRule({
      perTransaction: { amount: "50", token: "SOL" },
      daily: { amount: "200", token: "SOL" },
    }),

    // ApprovalGateRule: transactions above 10 SOL (but under the 50 SOL hard cap)
    // trigger an approval request. The 10-minute timeout means the human
    // has 10 minutes to respond before the request is auto-denied.
    new ApprovalGateRule({
      above: { amount: "10", token: "SOL" },
      timeout: 600_000,
    }),
  ],
  store,
  approval, // Pass the approval channel to the engine
);
```

With this setup:

- Transactions up to 10 SOL are auto-approved (if spending limits allow)
- Transactions between 10 and 50 SOL trigger an approval request
- Transactions above 50 SOL are denied by the spending limit (never reach the approval gate)

::: warning Rule ordering matters
Because `SpendingLimitRule` evaluates **before** `ApprovalGateRule`, the spending limit's per-transaction cap acts as a hard ceiling. If you set a per-transaction spending limit of 10 SOL and an approval gate threshold of 5 SOL, transactions between 5-10 SOL will route to approval, but transactions above 10 SOL will be **denied outright** by the spending limit and never reach the approval gate.

To allow large transactions to route through approval instead of being denied, set the per-transaction spending limit **higher** than the approval gate threshold. The spending limit serves as the absolute maximum, while the approval gate controls which transactions need human review.
:::

::: tip
Place `ApprovalGateRule` **last** in your rule list. It is the most expensive rule because it blocks execution for minutes while waiting for a human response. Cheaper rules (rate limits, spending limits, allowlists) should run first to filter out obviously invalid transactions before involving a human.
:::

## Code Example: Require Approval Above 10 SOL

```typescript
// Full end-to-end example: build an AgentWallet with rate limiting, spending limits,
// and human approval for transactions above 10 SOL.
import {
  AgentWallet,
  PolicyEngine,
  MemoryStore,
  LocalSigner,
  SolanaAdapter,
  SpendingLimitRule,
  RateLimitRule,
  ApprovalGateRule,
  CallbackApprovalChannel,
} from "@kova-sdk/wallet";
import { Keypair } from "@solana/web3.js";

// Create the core infrastructure components.
const store = new MemoryStore();                                    // In-memory store (use SqliteStore for production)
const signer = new LocalSigner(Keypair.generate());                 // Random keypair for testing on devnet
const chain = new SolanaAdapter({ rpcUrl: "https://api.devnet.solana.com" }); // Solana devnet RPC

// Set up the approval channel using callbacks.
// The channel will notify a human and wait for their approve/reject decision.
const approval = new CallbackApprovalChannel({
  name: "my-approval",
  onApprovalRequest: async (request) => {
    await notifyApprover(request); // Send notification via your preferred channel
  },
  waitForDecision: async (request) => {
    return pollForResponse(request.id); // Wait for human's response
  },
});

// Build the PolicyEngine with three rules in recommended order (cheapest first).
const engine = new PolicyEngine(
  [
    // Rule 1: Rate limit — max 5 transactions per minute.
    // Cheapest check, runs first to short-circuit runaway agents.
    new RateLimitRule({ maxTransactionsPerMinute: 5 }),

    // Rule 2: Spending limit — max 100 SOL per day.
    // Medium cost (reads/writes counters). Runs before the expensive approval gate.
    new SpendingLimitRule({ daily: { amount: "100", token: "SOL" } }),

    // Rule 3: Approval gate — transactions above 10 SOL require human approval.
    // Most expensive rule (blocks execution for up to 5 minutes waiting for human response).
    // Only reached if rate limit and spending limit both pass.
    new ApprovalGateRule({
      above: { amount: "10", token: "SOL" },
      timeout: 300_000,  // 5-minute timeout for human response
    }),
  ],
  store,
  approval, // Pass the approval channel to the engine
);

// Assemble the AgentWallet with all components.
const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  approval, // Also pass to wallet for policy introspection
});

// Example 1: Small transfer (5 SOL < 10 SOL threshold).
// This bypasses the approval gate entirely — no approval notification is sent.
// The transaction is auto-approved by all rules and executed on-chain.
const small = await wallet.execute({
  type: "transfer",
  chain: "solana",
  params: { to: "9WzDXwBb...", amount: "5", token: "SOL" },
});
console.log("Small transfer:", small.status); // "confirmed" or "failed"

// Example 2: Large transfer (15 SOL > 10 SOL threshold).
// The rate limit and spending limit pass, but the ApprovalGateRule triggers.
// An approval notification is sent through the configured ApprovalChannel.
// The execute() call blocks until the human responds or the 5-minute timeout expires.
const large = await wallet.execute({
  type: "transfer",
  chain: "solana",
  params: { to: "9WzDXwBb...", amount: "15", token: "SOL" },
});
console.log("Large transfer:", large.status); // depends on human decision
```

## Introspection

```typescript
// Retrieve the rule's configuration for inspection or logging.
// Returns the ApprovalGateConfig object used to construct this rule.
const config = rule.getConfig();
console.log("Threshold:", config.above.amount, config.above.token); // e.g., "10 SOL"
console.log("Timeout:", config.timeout, "ms");                       // e.g., 600000 ms (10 minutes)
```

## See Also

- [SpendingLimitRule](/guide/rules/spending-limit) -- set hard spending caps (use alongside approval gates so very large transactions are denied outright, not sent for approval)
- [TimeWindowRule](/guide/rules/time-window) -- pair with `outsideHoursPolicy: "require_approval"` to require sign-off for off-hours transactions
- [RateLimitRule](/guide/rules/rate-limit) -- prevent runaway agents from flooding approval channels with requests
- [AllowlistRule](/guide/rules/allowlist) -- restrict which addresses the agent can send to (checked before the approval gate)
