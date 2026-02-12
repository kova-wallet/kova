# ApprovalGateRule

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
3. **If the amount is above the threshold**, the rule sends a notification (e.g., a Telegram message) to a human approver with details of the transaction.
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
// until a human approver grants permission (e.g., via Telegram).
import { ApprovalGateRule } from "kova";

// Import the TypeScript types for configuring the approval gate.
// ApprovalGateConfig: defines the threshold, channel hint, and timeout.
// TokenAmount: a { amount, token } pair representing the approval threshold.
import type { ApprovalGateConfig, TokenAmount } from "kova";
```

## ApprovalGateConfig

```typescript
// Configuration for the ApprovalGateRule.
// Defines at what threshold human approval is required and how long to wait for a response.
interface ApprovalGateConfig {
  /** Transactions above this amount require approval */
  above: TokenAmount;
  /** Channel type hint (optional, for documentation) */
  channel?: "telegram" | "slack" | "custom";
  /** Timeout in milliseconds. Defaults to 300,000 (5 minutes) */
  timeout?: number;
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

::: tip
Custom intents have no `amount` field, so they always pass the approval gate. If you need approval for custom intents, implement a custom `PolicyRule`.
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
An `ApprovalChannel` is the communication mechanism used to reach a human approver. It is an abstraction -- the SDK provides `TelegramApprovalBot` out of the box (sends a message to a Telegram chat), but you can implement any channel (Slack, email, SMS, a web dashboard). The channel is responsible for delivering the approval request and returning the human's decision.
:::

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

## Integration with TelegramApprovalBot

The most common setup pairs `ApprovalGateRule` with `TelegramApprovalBot`:

```typescript
// Import all the classes needed for a policy engine with Telegram-based human approval.
import {
  PolicyEngine,
  SpendingLimitRule,
  ApprovalGateRule,
  TelegramApprovalBot,
  MemoryStore,
} from "kova";

// Create a shared in-memory store for counter persistence.
const store = new MemoryStore();

// Create a Telegram approval bot.
// This bot sends approval requests to a Telegram chat and listens for approve/reject responses.
// - token: the Telegram Bot API token (created via @BotFather). Keep this secret!
// - chatId: the ID of the Telegram chat (or group) where approval messages are sent.
// - defaultTimeout: how long to wait for a response before auto-denying (5 minutes).
// - allowedUserIds: only these Telegram user IDs can approve/reject.
//   This prevents unauthorized users in the group from approving transactions.
const approval = new TelegramApprovalBot({
  token: process.env.TELEGRAM_BOT_TOKEN!,
  chatId: process.env.TELEGRAM_CHAT_ID!,
  defaultTimeout: 300_000,
  allowedUserIds: [123456789],
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
    // trigger a Telegram approval request. The 10-minute timeout means the human
    // has 10 minutes to respond before the request is auto-denied.
    new ApprovalGateRule({
      above: { amount: "10", token: "SOL" },
      timeout: 600_000,
    }),
  ],
  store,
  approval, // Pass the TelegramApprovalBot as the approval channel for the engine
);
```

With this setup:

- Transactions up to 10 SOL are auto-approved (if spending limits allow)
- Transactions between 10 and 50 SOL trigger a Telegram approval request
- Transactions above 50 SOL are denied by the spending limit (never reach the approval gate)

::: tip
Place `ApprovalGateRule` **last** in your rule list. It is the most expensive rule because it blocks execution for minutes while waiting for a human response. Cheaper rules (rate limits, spending limits, allowlists) should run first to filter out obviously invalid transactions before involving a human.
:::

## Code Example: Require Approval Above 10 SOL

```typescript
// Full end-to-end example: build an AgentWallet with rate limiting, spending limits,
// and human approval for transactions above 10 SOL via Telegram.
import {
  AgentWallet,
  PolicyEngine,
  MemoryStore,
  LocalSigner,
  SolanaAdapter,
  SpendingLimitRule,
  RateLimitRule,
  ApprovalGateRule,
  TelegramApprovalBot,
} from "kova";
import { Keypair } from "@solana/web3.js";

// Create the core infrastructure components.
const store = new MemoryStore();                                    // In-memory store (use SqliteStore for production)
const signer = new LocalSigner(Keypair.generate());                 // Random keypair for testing on devnet
const chain = new SolanaAdapter({ rpcUrl: "https://api.devnet.solana.com" }); // Solana devnet RPC

// Set up the Telegram approval channel.
// The bot will send a message like "Agent wants to transfer 15 SOL to 9WzD... Approve/Reject?"
// and wait for the human's response.
const approval = new TelegramApprovalBot({
  token: process.env.TELEGRAM_BOT_TOKEN!,       // Bot API token from @BotFather
  chatId: process.env.TELEGRAM_CHAT_ID!,        // Target chat for approval messages
  allowedUserIds: [123456789],                   // Only this user can approve/reject
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
    // Most expensive rule (blocks execution for up to 5 minutes waiting for Telegram response).
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
// This bypasses the approval gate entirely — no Telegram message is sent.
// The transaction is auto-approved by all rules and executed on-chain.
const small = await wallet.execute({
  type: "transfer",
  chain: "solana",
  params: { to: "9WzDXwBb...", amount: "5", token: "SOL" },
});
console.log("Small transfer:", small.status); // "confirmed" or "failed"

// Example 2: Large transfer (15 SOL > 10 SOL threshold).
// The rate limit and spending limit pass, but the ApprovalGateRule triggers.
// A Telegram message is sent to the configured chat with approve/reject buttons.
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
