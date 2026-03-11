# Policy Configuration Cookbook

::: info What you'll learn
- How to configure six real-world policy patterns — from ultra-restrictive read-only agents to liberal high-frequency traders
- How each built-in rule (spending limit, rate limit, time window, allowlist, approval gate) works in practice
- How to combine multiple rules into a single policy for layered defense
- How to serialize policies to JSON for version control and reproducible deployments
- How to extend existing policies to create stricter variants without starting from scratch
:::

## Prerequisites

Before diving in, make sure you have:

- **Node.js 18 or later** installed ([download here](https://nodejs.org/))
- **kova installed** in your project (`npm install kova`)
- **A basic understanding of what an agent wallet is.** If you are new, start with [Your First Agent Wallet](/tutorials/first-wallet) first.
- **Familiarity with TypeScript.** All examples use TypeScript, but the concepts apply to JavaScript too.

::: tip New to blockchain?
A **policy** in kova is a set of rules that controls what your AI agent is allowed to do with the wallet. Think of it like parental controls for a credit card: you can set spending limits, restrict who can receive money, limit transaction frequency, and even require manual approval for large amounts. The agent can never bypass these rules, no matter what.
:::

---

This cookbook provides six ready-to-use policy configurations covering the most common scenarios for agent wallets. Each example includes the full `Policy.create()` code, an explanation of the rationale, and sample intents showing what would be allowed or denied.

At the end, you will learn how to serialize policies to JSON and extend existing policies to create stricter variants.

## Common Imports

All examples use these imports:

```typescript
// Import all policy-related components from kova.
// These are used across every example in this cookbook.
import {
  Policy,             // Fluent builder for creating policy configurations declaratively
  SpendingLimitRule,  // Enforces per-transaction and periodic (daily/weekly/monthly) spending caps
  AllowlistRule,      // Restricts which destination addresses or program IDs the agent can interact with
  RateLimitRule,      // Enforces max transactions per minute/hour using rolling time windows
  TimeWindowRule,     // Restricts when the agent can transact (e.g., business hours only)
  ApprovalGateRule,   // Requires human approval for transactions above a configurable threshold
  PolicyEngine,       // Evaluates an ordered list of rules against each transaction intent
  MemoryStore,        // In-memory Store implementation for dev/testing (state lost on restart)
} from "kova";
```

---

## 1. Conservative Agent

**Use case:** A cautious agent performing small, infrequent payments to known recipients. Ideal for customer service bots that issue refunds or micro-tips.

```typescript
// Conservative policy: very tight guardrails for low-trust scenarios.
// Ideal for customer service bots issuing small refunds or micro-tips.
const conservativePolicy = Policy.create("conservative-agent")
  .spendingLimit({
    perTransaction: { amount: "0.1", token: "SOL" },  // Max 0.1 SOL (~$20) per single transaction
    daily: { amount: "0.5", token: "SOL" },            // Max 0.5 SOL total per 24-hour window
  })
  .allowAddresses([
    // Strict allowlist: only these two addresses can receive funds.
    // The agent cannot send to ANY other address, even if the amount is tiny.
    "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",
    "FxkPQ7oB5E1RW8vwM9BwGhkRwJSmHftCFAi6KhFNiWaP",
  ])
  .rateLimit({
    maxTransactionsPerMinute: 2,  // At most 2 transactions per rolling 60s window
  })
  .build();  // Finalize the immutable Policy object
```

**Rationale:**
- Per-transaction cap of 0.1 SOL prevents any single large mistake
- Daily cap of 0.5 SOL limits total exposure even if the agent runs all day
- Strict allowlist (the inverse of a <Term id="denylist" />) means the agent can only send to pre-approved addresses
- 2 transactions per minute (<Term id="rolling-window" />) prevents rapid-fire spending

**Allowed intent:**

```typescript
// This intent will PASS all policy rules:
//   - 0.05 SOL is under the 0.1 SOL per-transaction limit
//   - The recipient is on the allowlist
//   - Assuming rate limit has not been exceeded
const allowed = {
  type: "transfer",   // Simple SOL transfer
  chain: "solana",    // Target blockchain
  params: {
    to: "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",  // Allowed recipient address
    amount: "0.05",   // Well within the 0.1 SOL per-tx limit
    token: "SOL",     // Native SOL token
  },
};
// Result: { status: "confirmed" }
```

**Denied intent:**

```typescript
// This intent will be DENIED by the SpendingLimitRule:
//   - 0.5 SOL exceeds the 0.1 SOL per-transaction cap (5x over the limit).
//   - Even though the recipient is on the allowlist, the spending limit
//     check runs first and short-circuits the evaluation.
const denied = {
  type: "transfer",
  chain: "solana",
  params: {
    to: "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",  // Address is allowed, but irrelevant here
    amount: "0.5",   // 5x over the 0.1 SOL per-transaction limit
    token: "SOL",
  },
};
// Result: { status: "denied", error: "SPENDING_LIMIT_EXCEEDED" }
```

::: details What just happened?
The conservative policy is the tightest configuration for real-money use. It creates a "sandbox" where your agent can only send small amounts to addresses you have pre-approved. The three rules work together as layers of defense:

1. **SpendingLimitRule** checks the amount first (cheapest check).
2. **AllowlistRule** checks the destination address.
3. **RateLimitRule** checks how many transactions have happened recently.

If any single rule says "no," the entire transaction is denied immediately -- the remaining rules are not even evaluated. This short-circuit behavior keeps evaluation fast and predictable.
:::

---

## 2. Liberal Agent

**Use case:** A high-trust agent with broad permissions. Suitable for internal treasury management or automated market-making where speed and volume matter more than tight restrictions.

```typescript
// Liberal policy: high-trust configuration for internal operations.
// No allowlist, so the agent can transact with any valid Solana address.
// Use only in controlled environments with additional monitoring.
const liberalPolicy = Policy.create("liberal-agent")
  .spendingLimit({
    perTransaction: { amount: "100.0", token: "SOL" },  // Up to 100 SOL per transaction
    daily: { amount: "500.0", token: "SOL" },            // Up to 500 SOL per day total
  })
  .rateLimit({
    maxTransactionsPerMinute: 30,  // 30 transactions per minute for high-frequency operations
  })
  // Note: no .allowAddresses() -- the agent can send to ANY valid address.
  // Note: no .activeHours() -- the agent operates 24/7.
  .build();
```

**Rationale:**
- High per-transaction and daily limits allow large operations
- No allowlist means the agent can transact with any address
- 30 transactions per minute supports high-frequency activity
- Still has limits to prevent runaway behavior

**Allowed intent:**

```typescript
// This intent will PASS: 50 SOL is within the 100 SOL per-transaction limit,
// and there is no allowlist restricting recipient addresses.
const allowed = {
  type: "transfer",
  chain: "solana",
  params: {
    to: "ANY_VALID_SOLANA_ADDRESS_HERE",  // Any valid base58 Solana address is accepted
    amount: "50.0",                        // Within the 100 SOL per-tx limit
    token: "SOL",
  },
};
// Result: { status: "confirmed" }
```

**Denied intent:**

```typescript
// This intent will be DENIED: 150 SOL exceeds the 100 SOL per-transaction limit.
// Even liberal policies have guardrails to prevent runaway behavior.
const denied = {
  type: "transfer",
  chain: "solana",
  params: {
    to: "ANY_VALID_SOLANA_ADDRESS_HERE",
    amount: "150.0",  // 1.5x over the 100 SOL per-tx cap
    token: "SOL",
  },
};
// Result: { status: "denied", error: "SPENDING_LIMIT_EXCEEDED" }
```

::: warning
Liberal policies should only be used in controlled environments with additional monitoring. Consider adding a <Term id="circuit-breaker" /> and audit log integrity checks.
:::

::: details What just happened?
The liberal policy removes the address allowlist and time window restrictions, giving the agent broad freedom to transact. This is appropriate for internal operations where the agent is trusted and monitored externally. Notice that even "liberal" policies still have spending limits -- there is no configuration in kova that allows truly unlimited spending. This is a deliberate safety design.
:::

---

## 3. Business Hours Agent

**Use case:** An agent that only operates during business hours. Ideal for payment processing bots that should be dormant outside office hours.

```typescript
// Business hours policy: restricts agent activity to specific days and times.
// Any transaction attempted outside the defined windows is immediately denied.
// This prevents overnight or weekend exploits if the agent is compromised.
const businessHoursPolicy = Policy.create("business-hours-agent")
  .spendingLimit({
    perTransaction: { amount: "5.0", token: "SOL" },   // Moderate per-tx limit for business payments
    daily: { amount: "50.0", token: "SOL" },            // Reasonable daily cap for normal operations
  })
  .rateLimit({
    maxTransactionsPerMinute: 10,  // 10 transactions per minute during business hours
  })
  .activeHours({
    timezone: "America/New_York",  // All times are interpreted in this timezone (IANA format)
    windows: [
      {
        days: ["Mon", "Tue", "Wed", "Thu", "Fri"],  // Weekdays only -- no Sat/Sun
        start: "09:00",  // 9:00 AM ET -- earliest the agent can transact
        end: "17:00",    // 5:00 PM ET -- latest the agent can transact
      },
      // You can add multiple windows, e.g., for Saturday half-days:
      // { days: ["Sat"], start: "10:00", end: "14:00" }
    ],
  })
  .build();
```

**Rationale:**
- Moderate spending limits for normal business operations
- Time window restricts activity to Mon-Fri, 9:00 AM - 5:00 PM Eastern
- No transactions outside these hours, preventing overnight exploits
- If the agent is compromised at night, no funds can move

**Allowed intent (during business hours):**

```typescript
// This intent will PASS if executed on a Tuesday at 2:00 PM ET:
//   - The current time falls within the Mon-Fri 9:00-17:00 window
//   - 2.5 SOL is within the 5 SOL per-transaction limit
//   - No allowlist restriction on this policy
const allowed = {
  type: "transfer",
  chain: "solana",
  params: {
    to: "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH",
    amount: "2.5",    // Within the 5 SOL per-tx limit
    token: "SOL",
  },
};
// Result: { status: "confirmed" }
```

**Denied intent (outside business hours):**

```typescript
// This intent will be DENIED by the TimeWindowRule:
//   - Saturday is not included in the ["Mon"..."Fri"] days list
//   - Even though the amount (0.5 SOL) and address are fine,
//     the time window check runs before other rules and blocks it
const denied = {
  type: "transfer",
  chain: "solana",
  params: {
    to: "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH",
    amount: "0.5",    // Amount is fine, but the day is not
    token: "SOL",
  },
};
// Result: { status: "denied", error: "OUTSIDE_TIME_WINDOW" }
```

::: details What just happened?
The business hours policy adds a time dimension to your security model. The `TimeWindowRule` checks the current time (in the specified timezone) against your defined windows before any other rule runs. If the current moment falls outside all windows, the transaction is immediately denied. This is especially powerful for preventing overnight exploits: even if an attacker compromises your agent at 2 AM, no funds can move until the next business-hours window opens.

The timezone parameter uses the IANA timezone database format (e.g., `"America/New_York"`, `"Europe/London"`, `"Asia/Tokyo"`). You can find your timezone string at [timeapi.io/timezone](https://timeapi.io/timezone).
:::

---

## 4. High-Value Approval

**Use case:** An agent that can handle small payments autonomously but requires human approval for anything above a threshold. Perfect for finance teams that want automation for routine payments with oversight for large ones.

```typescript
import { CallbackApprovalChannel } from "kova";

// Create a callback-based approval channel for human-in-the-loop approval.
// When a high-value transaction is attempted, the channel notifies a human
// and waits for their approve/reject decision.
const approvalBot = new CallbackApprovalChannel({
  name: "my-approval",
  onApprovalRequest: async (request) => {
    await notifyApprover(request); // Send notification via your preferred channel
  },
  waitForDecision: async (request) => {
    return pollForResponse(request.id); // Wait for human's response
  },
  defaultTimeout: 300_000,               // 5 minutes to respond before auto-deny
});

// High-value approval policy: small transactions proceed automatically,
// but anything >= 10 SOL requires explicit human approval.
const highValuePolicy = Policy.create("high-value-approval")
  .spendingLimit({
    perTransaction: { amount: "50.0", token: "SOL" },  // Hard cap at 50 SOL even with approval
    daily: { amount: "200.0", token: "SOL" },           // Daily safety net of 200 SOL
  })
  .rateLimit({
    maxTransactionsPerMinute: 10,  // 10 transactions per minute
  })
  .requireApproval({
    above: { amount: "10.0", token: "SOL" },  // Trigger approval for 10+ SOL transactions
    timeout: 300000,                            // 5 minutes before auto-deny (fail-closed)
  })
  .build();
```

**Rationale:**
- Transactions under 10 SOL proceed automatically
- Transactions of 10 SOL or more trigger an approval notification via the configured `ApprovalChannel`
- The approver has 5 minutes to approve or reject
- Daily limit of 200 SOL provides an overall safety net

**Creating the engine with approval:**

```typescript
// Extract the policy config and create rule instances.
const config = highValuePolicy.toJSON();
const rules = [
  new SpendingLimitRule(config.spendingLimit!),  // Check spending caps first (cheapest)
  new RateLimitRule(config.rateLimit!),            // Check rate limits next
  new ApprovalGateRule(config.approvalGate!),   // Approval gate runs last -- only for allowed intents
];
const store = new MemoryStore(); // Dev-only; throws in production unless KOVA_ALLOW_MEMORY_STORE=1
// Pass the approvalBot as the third argument so the ApprovalGateRule can
// send approval requests when a transaction exceeds the approval threshold.
const engine = new PolicyEngine(rules, store, approvalBot);
```

**Allowed intent (below threshold):**

```typescript
// This intent will PASS automatically without triggering an approval request:
//   - 5 SOL is below the 10 SOL approval threshold
//   - Also within the 50 SOL per-transaction spending limit
//   - The ApprovalGateRule only activates for amounts >= the threshold
const allowed = {
  type: "transfer",
  chain: "solana",
  params: {
    to: "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",
    amount: "5.0",    // Below the 10 SOL approval threshold
    token: "SOL",
  },
};
// Result: { status: "confirmed" } -- no approval needed
```

**Pending intent (above threshold):**

```typescript
// This intent will trigger an approval request because 25 SOL >= 10 SOL threshold.
// The wallet.execute() call BLOCKS until the human responds or the timeout expires.
// Three possible outcomes after approval is requested:
const pendingApproval = {
  type: "transfer",
  chain: "solana",
  params: {
    to: "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",
    amount: "25.0",   // Above the 10 SOL threshold -- triggers approval
    token: "SOL",
  },
};
// Immediately returns: { status: "pending" } -- waiting for human response
// If human clicks Approve:  { status: "confirmed", txId: "..." }  -- transaction proceeds
// If human clicks Reject:   { status: "denied", error: "APPROVAL_REJECTED" }
// If no response in 5 min:  { status: "denied", error: "APPROVAL_TIMEOUT" } (fail-closed)
```

::: details What just happened?
The high-value approval policy introduces a human-in-the-loop pattern. The `ApprovalGateRule` works differently from the other rules: instead of immediately allowing or denying, it can *pause* the transaction and wait for a human decision. This is the `"pending"` status -- a third state beyond "confirmed" and "denied."

The "fail-closed" design means that if the human does not respond within the timeout, the transaction is automatically **denied** (not approved). This is a deliberate safety choice: silence is treated as rejection.

To set up an approval channel, see the [Custom Approval Channels tutorial](/tutorials/telegram-approval).
:::

---

## 5. DeFi Trader

**Use case:** An agent that executes token swaps via <Term id="jupiter">Jupiter</Term>. Needs permission to call DeFi programs and higher rate limits for rapid trading strategies.

```typescript
// DeFi Trader policy: allows token swaps via approved DeFi protocols.
// Uses .allowPrograms() instead of .allowAddresses() to restrict which
// on-chain programs (smart contracts) the agent can interact with.
const defiTraderPolicy = Policy.create("defi-trader")
  .spendingLimit({
    perTransaction: { amount: "10.0", token: "SOL" },   // Max 10 SOL per swap
    daily: { amount: "100.0", token: "SOL" },            // Max 100 SOL per day for active trading
  })
  .allowPrograms([
    // Restrict the agent to interacting only with these Solana program IDs.
    // Any transaction that invokes a program NOT on this list will be denied.
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",  // Jupiter v6 aggregator (DEX routing)
    "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",  // Orca Whirlpool (concentrated liquidity AMM)
  ])
  .rateLimit({
    maxTransactionsPerMinute: 10,  // 10 swaps per minute for rapid trading
  })
  .build();
```

**Rationale:**
- Moderate per-transaction limit to bound individual swap sizes
- Higher daily limit for active trading strategies
- Program allowlist restricts interactions to specific <Term id="dex">DeFi</Term> protocols
- 10 transactions per minute allows rapid but bounded trading

**Allowed intent:**

```typescript
// This swap intent will PASS: 5 SOL is within the 10 SOL per-tx limit,
// and Jupiter is on the allowed programs list.
// Note: swap intents require a custom ChainAdapter implementation -- they are
// NOT built into SolanaAdapter (which only supports transfers).
const allowed = {
  type: "swap",        // Swap intent type (requires a custom ChainAdapter; not built into SolanaAdapter)
  chain: "solana",
  params: {
    fromToken: "SOL",                                           // Source token (native SOL)
    toToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  // Destination: USDC mint address
    amount: "5.0",       // Swap 5 SOL worth of tokens
    maxSlippage: 0.01,   // Accept up to 1% price slippage during the swap
  },
};
// Result: { status: "confirmed", txId: "..." }
```

**Denied intent:**

```typescript
// This swap will be DENIED by the RateLimitRule if the agent has already
// executed 10 transactions in the last 60 seconds. The rate limit uses a
// rolling window, so the counter resets as older transactions age out.
const denied = {
  type: "swap",
  chain: "solana",
  params: {
    fromToken: "SOL",
    toToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  // USDC
    amount: "0.1",       // Amount is fine, but rate limit is exceeded
    maxSlippage: 0.01,
  },
};
// Result: { status: "denied", error: "RATE_LIMIT_EXCEEDED" }
```

::: details What just happened?
The DeFi trader policy uses `.allowPrograms()` instead of `.allowAddresses()`. This is an important distinction:

- **`allowAddresses`** restricts *who* can receive funds (recipient wallet addresses).
- **`allowPrograms`** restricts *which on-chain programs* (smart contracts) the agent can interact with.

For DeFi operations like token swaps, the agent does not send funds to a wallet address -- it interacts with a program (like Jupiter's aggregator) that routes the swap through liquidity pools. The program allowlist ensures the agent can only use approved DeFi protocols and cannot interact with arbitrary or malicious contracts.

**Slippage** is the difference between the expected price and the actual price when the swap executes. A `maxSlippage` of `0.01` means you accept up to 1% price movement. If the price moves more than that between the quote and execution, the swap transaction will fail on-chain (your funds are safe -- you just pay the transaction fee).
:::

---

## 6. Read-Only Agent

**Use case:** An agent that can only read data -- check balances and view policy. It cannot execute any transactions. Perfect for monitoring bots and dashboards.

```typescript
// Read-only policy: the safest possible configuration -- near-zero financial risk.
// Setting spending limits to "0.000000001" (1 lamport) effectively blocks ALL
// meaningful transfers and swaps. We use this value instead of "0" because the
// policy builder rejects zero amounts (amount must be > 0).
// The agent can still read data (balance, address, policy, history)
// because read operations bypass the policy engine entirely.
const readOnlyPolicy = Policy.create("read-only-agent")
  .spendingLimit({
    perTransaction: { amount: "0.000000001", token: "SOL" },  // 1 lamport -- effectively zero
    daily: { amount: "0.000000001", token: "SOL" },            // 1 lamport daily cap reinforces the restriction
  })
  .rateLimit({
    maxTransactionsPerMinute: 30,  // High rate limit allows frequent data polling
                                    // (only applies to read operations in practice)
  })
  .build();
```

**Rationale:**
- Setting both spending limits to 0.000000001 SOL (1 lamport) effectively blocks all meaningful transfers and swaps
- The agent can still call `wallet.getBalance("SOL")`, `wallet.getAddress()`, `wallet.getPolicy()`, and `wallet.getTransactionHistory()` since these are read operations that bypass the policy engine
- High rate limit allows frequent data polling
- This is the safest configuration -- zero financial risk

**Allowed operation (read-only):**

```typescript
// These read operations will WORK even with a zero spending limit.
// Read methods bypass the policy engine entirely -- they go directly
// to the chain adapter or store without any rule evaluation.
const balance = await wallet.getBalance("SOL");            // Queries SOL balance from Solana RPC
const address = await wallet.getAddress();                  // Returns the wallet's public key
const policySummary = await wallet.getPolicy();             // Returns the active policy summary
const history = await wallet.getTransactionHistory(100);    // Retrieves last 100 audit log entries
```

**Denied intent:**

```typescript
// This intent will be DENIED even though the amount is tiny (0.001 SOL).
// When the per-transaction spending limit is "0.000000001" (1 lamport),
// any practical amount exceeds it. This is the definitive way to create
// a truly read-only agent.
const denied = {
  type: "transfer",
  chain: "solana",
  params: {
    to: "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",
    amount: "0.001",  // Even 0.001 SOL exceeds a limit of 0
    token: "SOL",
  },
};
// Result: { status: "denied", error: "SPENDING_LIMIT_EXCEEDED" }
```

::: tip
Even a 0.001 SOL transfer will be denied when the per-transaction limit is "0.000000001". This is the most restrictive policy possible.
:::

---

## Policy Serialization

Policies can be serialized to JSON for storage, version control, or sharing across environments.

### Save a policy to a file

```typescript
// Node.js file system utilities for reading and writing policy files.
import { writeFileSync, readFileSync } from "fs";
import { Policy } from "kova";

// Build a policy using the fluent builder.
const policy = Policy.create("my-policy")
  .spendingLimit({
    perTransaction: { amount: "5.0", token: "SOL" },
    daily: { amount: "50.0", token: "SOL" },
  })
  .allowAddresses([
    "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",
  ])
  .rateLimit({
    maxTransactionsPerMinute: 10,
  })
  .build();

// Serialize the policy to a plain JSON object using toJSON().
// This produces a PolicyConfig that includes all rule configurations.
const policyJson = policy.toJSON();
// Write the JSON to a file with pretty-printing (2-space indent).
// You can commit this file to version control to track policy changes over time.
writeFileSync("policy.json", JSON.stringify(policyJson, null, 2));
console.log("Policy saved to policy.json");
```

### Load a policy from a file

```typescript
// Read the policy JSON file back from disk.
// This could be loaded at application startup or from a configuration service.
const loaded = JSON.parse(readFileSync("policy.json", "utf-8"));

// Reconstruct a Policy object from the deserialized JSON.
// Policy.fromJSON() validates the structure and returns an immutable Policy.
// You can then extract config from it to create rule instances, just like
// you would with a freshly built policy.
const restoredPolicy = Policy.fromJSON(loaded);

console.log("Loaded policy:", restoredPolicy.getName());
console.log("Config:", JSON.stringify(restoredPolicy.toJSON(), null, 2));
```

The serialized JSON looks like this:

```json
{
  // "name" identifies this policy in audit logs and UI. Must be unique per policy.
  "name": "my-policy",

  // "spendingLimit" configures per-transaction and periodic spending caps.
  // Amounts are strings to avoid floating-point precision issues.
  "spendingLimit": {
    "perTransaction": { "amount": "5.0", "token": "SOL" },
    "daily": { "amount": "50.0", "token": "SOL" }
  },

  // "allowAddresses" restricts which Solana addresses can receive funds.
  // Only base58-encoded public keys are accepted.
  "allowAddresses": [
    "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde"
  ],

  // "rateLimit" configures transaction frequency caps.
  // Uses rolling time windows (not fixed calendar windows).
  "rateLimit": {
    "maxTransactionsPerMinute": 10
  }
}
```

::: tip
Store policy JSON files in version control alongside your application code. This gives you a full audit trail of policy changes over time.
:::

---

## Policy Extension

Use `Policy.extend()` to derive a new policy from an existing one. The new policy inherits all settings from the base and lets you override or add rules.

```typescript
import { Policy } from "kova";

// Start with a liberal base policy that has high limits and no allowlist.
// This serves as the "template" that we will derive stricter variants from.
const basePolicy = Policy.create("liberal-agent")
  .spendingLimit({
    perTransaction: { amount: "100.0", token: "SOL" },  // 100 SOL per tx
    daily: { amount: "500.0", token: "SOL" },            // 500 SOL per day
  })
  .rateLimit({
    maxTransactionsPerMinute: 30,  // 30 per minute
  })
  .build();

// Policy.extend() creates a new policy that inherits all settings from the base.
// You can then override specific rules or add new ones.
// Rules not explicitly overridden are inherited as-is from the base policy.
const stricterPolicy = Policy.extend(basePolicy, "stricter-liberal")
  .spendingLimit({
    // Override: reduce spending limits from 100/500 to 10/50 SOL
    perTransaction: { amount: "10.0", token: "SOL" },
    daily: { amount: "50.0", token: "SOL" },
  })
  .allowAddresses([
    // Add: the base policy had no allowlist; the extended policy restricts recipients
    "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",
  ])
  // Note: rateLimit is NOT called here, so it inherits the base's 30/min
  .build();

console.log("Base policy:", basePolicy.getName());
// Output: Base policy: liberal-agent

console.log("Extended policy:", stricterPolicy.getName());
// Output: Extended policy: stricter-liberal

// Verify the overridden spending limit
const stricterConfig = stricterPolicy.toJSON();
console.log("Max per tx:", stricterConfig.spendingLimit?.perTransaction.amount);
// Output: Max per tx: 10.0
// (overridden from 100.0 in the base policy)

// Verify the inherited rate limit (unchanged from base)
console.log("Rate limit:", stricterConfig.rateLimit?.maxTransactionsPerMinute);
// Output: Rate limit: 30
// (inherited from base -- we did not override this)

// Verify the newly added allowlist
console.log("Allowlist:", stricterConfig.allowAddresses);
// Output: Allowlist: ["9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde"]
// (added in extension -- the base policy had no allowlist)
```

This pattern is useful for:
- Creating environment-specific policies (dev vs. staging vs. production)
- Giving different agents different privilege levels from a common base
- Temporarily tightening an existing policy during incidents

---

## Quick Reference Table

| Policy | Per-Tx Limit | Daily Limit | Allowlist | Rate Limit | Time Window | Approval |
|--------|-------------|-------------|-----------|------------|-------------|----------|
| Conservative | 0.1 SOL | 0.5 SOL | Yes | 2/min | No | No |
| Liberal | 100 SOL | 500 SOL | No | 30/min | No | No |
| Business Hours | 5 SOL | 50 SOL | No | 10/min | Mon-Fri 9-5 ET | No |
| High-Value Approval | 50 SOL | 200 SOL | No | 10/min | No | Above 10 SOL |
| DeFi Trader | 10 SOL | 100 SOL | No (programs) | 10/min | No | No |
| Read-Only | ~0 SOL | ~0 SOL | No | 30/min | No | No |

## Common Mistakes

Here are three mistakes newcomers frequently make with policy configuration:

1. **Forgetting to call `.build()`.** The `Policy.create()` method returns a builder, not a policy. If you pass the builder (instead of the built policy) to `PolicyEngine`, you will get a confusing runtime error. Always chain `.build()` at the end.

2. **Confusing `allowAddresses` with `allowPrograms`.** Address allowlists restrict *recipient wallets* (who receives the funds). Program allowlists restrict *which smart contracts* the agent can interact with (e.g., Jupiter for swaps). Using `allowAddresses` when you mean `allowPrograms` will cause all DeFi transactions to be denied, because the Jupiter program ID is not a wallet address.

3. **Setting daily limits lower than per-transaction limits.** If your per-transaction limit is 10 SOL but your daily limit is 5 SOL, the agent can never actually send 10 SOL in a single transaction -- the daily limit will block it first. Always make sure `daily >= perTransaction`.

## Troubleshooting

### Policy denials you did not expect

- **`SPENDING_LIMIT_EXCEEDED`**: Check both your per-transaction and daily limits. Remember that the daily limit is cumulative -- if the agent already spent 9 SOL today and tries to send 2 more SOL with a daily limit of 10, the transaction is denied.
- **`RATE_LIMIT_EXCEEDED`**: The rate limit uses a rolling window, not a fixed calendar window. If you set 2 transactions per minute, the counter starts from the first transaction and resets 60 seconds later. Rapid bursts within the same window will be denied.
- **`OUTSIDE_TIME_WINDOW`**: Double-check your timezone string. `"EST"` is not the same as `"America/New_York"` (EST does not account for daylight saving time). Always use IANA timezone format.
- **`PROGRAM_NOT_ALLOWED`**: You are using `allowPrograms` but the transaction tries to interact with a program not on the list. Verify the program ID is correct and matches the exact on-chain address.

### Policy loads from JSON but rules do not work

Make sure you are creating rule instances from the loaded config. `Policy.fromJSON()` gives you a `Policy` object, but you still need to extract the config with `.toJSON()` and create `SpendingLimitRule`, `RateLimitRule`, etc. instances from it. The `Policy` object itself does not enforce rules -- the `PolicyEngine` with its rule instances does.

## What to Try Next

Now that you understand the six policy patterns, here are some concrete challenges to deepen your understanding:

- **Combine business hours with approval gates.** Create a policy that only operates Monday-Friday 9-5 ET and also requires human approval for transactions above 2 SOL. Which rule should be evaluated first?
- **Create environment-specific policies using `Policy.extend()`.** Start with a liberal base policy and derive three variants: `dev` (high limits, no allowlist), `staging` (moderate limits, allowlist), and `production` (tight limits, allowlist, approval gate, business hours).
- **Serialize and diff policies.** Save two policies to JSON files and compare them with `diff` or a JSON comparison tool. This is how you would review policy changes in a pull request.

## Next Steps

- [Your First Agent Wallet](/tutorials/first-wallet) -- Start from scratch
- [Custom Approval Channels](/tutorials/telegram-approval) -- Set up the approval channel used in Policy 4
- [Building a DeFi Agent](/tutorials/defi-agent) -- Put the DeFi Trader policy to work
- [Production Deployment](/tutorials/production) -- Harden any of these policies for real use
