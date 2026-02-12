# Policy Configuration Cookbook

This cookbook provides six ready-to-use policy configurations covering the most common scenarios for agent wallets. Each example includes the full `Policy.create()` code, an explanation of the rationale, and sample intents showing what would be allowed or denied.

At the end, you will learn how to serialize policies to JSON and extend existing policies to create stricter variants.

## Common Imports

All examples use these imports:

```typescript
import {
  Policy,
  SpendingLimitRule,
  AllowlistRule,
  RateLimitRule,
  TimeWindowRule,
  ApprovalGateRule,
  PolicyEngine,
  MemoryStore,
} from "kova";
```

---

## 1. Conservative Agent

**Use case:** A cautious agent performing small, infrequent payments to known recipients. Ideal for customer service bots that issue refunds or micro-tips.

```typescript
const conservativePolicy = Policy.create("conservative-agent")
  .spendingLimit({
    perTransaction: { amount: "0.1", token: "SOL" },
    daily: { amount: "0.5", token: "SOL" },
  })
  .allowAddresses([
    "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",
    "FxkPQ7oB5E1RW8vwM9BwGhkRwJSmHftCFAi6KhFNiWaP",
  ])
  .rateLimit({
    maxTransactionsPerMinute: 2,
  })
  .build();
```

**Rationale:**
- Per-transaction cap of 0.1 SOL prevents any single large mistake
- Daily cap of 0.5 SOL limits total exposure even if the agent runs all day
- Strict allowlist (the inverse of a <Term id="denylist" />) means the agent can only send to pre-approved addresses
- 2 transactions per minute (<Term id="rolling-window" />) prevents rapid-fire spending

**Allowed intent:**

```typescript
// This will PASS: small transfer to an allowed address
const allowed = {
  type: "transfer",
  chain: "solana",
  params: {
    to: "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",
    amount: "0.05",
    token: "SOL",
  },
};
// Result: { status: "confirmed" }
```

**Denied intent:**

```typescript
// This will be DENIED: amount exceeds per-transaction limit
const denied = {
  type: "transfer",
  chain: "solana",
  params: {
    to: "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",
    amount: "0.5",
    token: "SOL",
  },
};
// Result: { status: "denied", error: "SPENDING_LIMIT_EXCEEDED" }
```

---

## 2. Liberal Agent

**Use case:** A high-trust agent with broad permissions. Suitable for internal treasury management or automated market-making where speed and volume matter more than tight restrictions.

```typescript
const liberalPolicy = Policy.create("liberal-agent")
  .spendingLimit({
    perTransaction: { amount: "100.0", token: "SOL" },
    daily: { amount: "500.0", token: "SOL" },
  })
  .rateLimit({
    maxTransactionsPerMinute: 30,
  })
  .build();
```

**Rationale:**
- High per-transaction and daily limits allow large operations
- No allowlist means the agent can transact with any address
- 30 transactions per minute supports high-frequency activity
- Still has limits to prevent runaway behavior

**Allowed intent:**

```typescript
// This will PASS: large transfer with no allowlist restriction
const allowed = {
  type: "transfer",
  chain: "solana",
  params: {
    to: "ANY_VALID_SOLANA_ADDRESS_HERE",
    amount: "50.0",
    token: "SOL",
  },
};
// Result: { status: "confirmed" }
```

**Denied intent:**

```typescript
// This will be DENIED: exceeds per-transaction limit
const denied = {
  type: "transfer",
  chain: "solana",
  params: {
    to: "ANY_VALID_SOLANA_ADDRESS_HERE",
    amount: "150.0",
    token: "SOL",
  },
};
// Result: { status: "denied", error: "SPENDING_LIMIT_EXCEEDED" }
```

::: warning
Liberal policies should only be used in controlled environments with additional monitoring. Consider adding a <Term id="circuit-breaker" /> and audit log integrity checks.
:::

---

## 3. Business Hours Agent

**Use case:** An agent that only operates during business hours. Ideal for payment processing bots that should be dormant outside office hours.

```typescript
const businessHoursPolicy = Policy.create("business-hours-agent")
  .spendingLimit({
    perTransaction: { amount: "5.0", token: "SOL" },
    daily: { amount: "50.0", token: "SOL" },
  })
  .rateLimit({
    maxTransactionsPerMinute: 10,
  })
  .activeHours({
    timezone: "America/New_York",
    windows: [
      {
        days: ["Mon", "Tue", "Wed", "Thu", "Fri"],
        start: "09:00",
        end: "17:00",
      },
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
// This will PASS: within business hours on a Tuesday at 2:00 PM ET
const allowed = {
  type: "transfer",
  chain: "solana",
  params: {
    to: "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH",
    amount: "2.5",
    token: "SOL",
  },
};
// Result: { status: "confirmed" }
```

**Denied intent (outside business hours):**

```typescript
// This will be DENIED: Saturday at 10:00 AM ET -- not a business day
const denied = {
  type: "transfer",
  chain: "solana",
  params: {
    to: "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH",
    amount: "0.5",
    token: "SOL",
  },
};
// Result: { status: "denied", error: "OUTSIDE_TIME_WINDOW" }
```

---

## 4. High-Value Approval

**Use case:** An agent that can handle small payments autonomously but requires human approval for anything above a threshold. Perfect for finance teams that want automation for routine payments with oversight for large ones.

```typescript
import { TelegramApprovalBot } from "kova";

const approvalBot = new TelegramApprovalBot({
  token: process.env.TELEGRAM_BOT_TOKEN!,
  chatId: process.env.TELEGRAM_CHAT_ID!,
  defaultTimeout: 300000, // 5 minutes
});

const highValuePolicy = Policy.create("high-value-approval")
  .spendingLimit({
    perTransaction: { amount: "50.0", token: "SOL" },
    daily: { amount: "200.0", token: "SOL" },
  })
  .rateLimit({
    maxTransactionsPerMinute: 10,
  })
  .requireApproval({
    above: { amount: "10.0", token: "SOL" },
    channel: "telegram",
    timeout: 300000,
  })
  .build();
```

**Rationale:**
- Transactions under 10 SOL proceed automatically
- Transactions of 10 SOL or more trigger a Telegram notification requiring approval
- The operator has 5 minutes to approve or reject
- Daily limit of 200 SOL provides an overall safety net

**Creating the engine with approval:**

```typescript
const config = highValuePolicy.toJSON();
const rules = [
  new SpendingLimitRule(config.spendingLimit!),
  new RateLimitRule(config.rateLimit!),
  new ApprovalGateRule(config.requireApproval!),
];
const store = new MemoryStore();
const engine = new PolicyEngine(rules, store, approvalBot);
```

**Allowed intent (below threshold):**

```typescript
// This will PASS automatically: under the 10 SOL approval threshold
const allowed = {
  type: "transfer",
  chain: "solana",
  params: {
    to: "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",
    amount: "5.0",
    token: "SOL",
  },
};
// Result: { status: "confirmed" } -- no approval needed
```

**Pending intent (above threshold):**

```typescript
// This will be PENDING: triggers Telegram approval request
const pendingApproval = {
  type: "transfer",
  chain: "solana",
  params: {
    to: "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",
    amount: "25.0",
    token: "SOL",
  },
};
// Result: { status: "pending" } until approved
// After approval: { status: "confirmed", txId: "..." }
// If rejected: { status: "denied", error: "APPROVAL_REJECTED" }
// If timeout: { status: "denied", error: "APPROVAL_TIMEOUT" }
```

---

## 5. DeFi Trader

**Use case:** An agent that executes token swaps via <Term id="jupiter">Jupiter</Term>. Needs permission to call DeFi programs and higher rate limits for rapid trading strategies.

```typescript
const defiTraderPolicy = Policy.create("defi-trader")
  .spendingLimit({
    perTransaction: { amount: "10.0", token: "SOL" },
    daily: { amount: "100.0", token: "SOL" },
  })
  .allowPrograms([
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",  // Jupiter v6
    "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",  // Orca Whirlpool
  ])
  .rateLimit({
    maxTransactionsPerMinute: 10,
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
// This will PASS: swap within limits
const allowed = {
  type: "swap",
  chain: "solana",
  params: {
    fromToken: "SOL",
    toToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
    amount: "5.0",
    maxSlippage: 0.01,
  },
};
// Result: { status: "confirmed", txId: "..." }
```

**Denied intent:**

```typescript
// This will be DENIED: too many transactions in one minute
// (after 10 transactions in the last 60 seconds)
const denied = {
  type: "swap",
  chain: "solana",
  params: {
    fromToken: "SOL",
    toToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amount: "0.1",
    maxSlippage: 0.01,
  },
};
// Result: { status: "denied", error: "RATE_LIMIT_EXCEEDED" }
```

---

## 6. Read-Only Agent

**Use case:** An agent that can only read data -- check balances and view policy. It cannot execute any transactions. Perfect for monitoring bots and dashboards.

```typescript
const readOnlyPolicy = Policy.create("read-only-agent")
  .spendingLimit({
    perTransaction: { amount: "0", token: "SOL" },
    daily: { amount: "0", token: "SOL" },
  })
  .rateLimit({
    maxTransactionsPerMinute: 30,
  })
  .build();
```

**Rationale:**
- Setting both spending limits to zero effectively blocks all transfers and swaps
- The agent can still call `wallet.getBalance()`, `wallet.getAddress()`, `wallet.getPolicy()`, and `wallet.getTransactionHistory()` since these are read operations that bypass the policy engine
- High rate limit allows frequent data polling
- This is the safest configuration -- zero financial risk

**Allowed operation (read-only):**

```typescript
// These will WORK: read operations do not go through the policy engine
const balance = await wallet.getBalance("SOL");
const address = await wallet.getAddress();
const policySummary = await wallet.getPolicy();
const history = await wallet.getTransactionHistory(100);
```

**Denied intent:**

```typescript
// This will be DENIED: spending limit is 0
const denied = {
  type: "transfer",
  chain: "solana",
  params: {
    to: "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",
    amount: "0.001",
    token: "SOL",
  },
};
// Result: { status: "denied", error: "SPENDING_LIMIT_EXCEEDED" }
```

::: tip
Even a 0.001 SOL transfer will be denied when the per-transaction limit is "0". This is the most restrictive policy possible.
:::

---

## Policy Serialization

Policies can be serialized to JSON for storage, version control, or sharing across environments.

### Save a policy to a file

```typescript
import { writeFileSync, readFileSync } from "fs";
import { Policy } from "kova";

// Build a policy
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

// Serialize to JSON
const policyJson = policy.toJSON();
writeFileSync("policy.json", JSON.stringify(policyJson, null, 2));
console.log("Policy saved to policy.json");
```

### Load a policy from a file

```typescript
// Read from file
const loaded = JSON.parse(readFileSync("policy.json", "utf-8"));
const restoredPolicy = Policy.fromJSON(loaded);

console.log("Loaded policy:", restoredPolicy.getName());
console.log("Config:", JSON.stringify(restoredPolicy.toJSON(), null, 2));
```

The serialized JSON looks like this:

```json
{
  "name": "my-policy",
  "spendingLimit": {
    "perTransaction": { "amount": "5.0", "token": "SOL" },
    "daily": { "amount": "50.0", "token": "SOL" }
  },
  "allowAddresses": [
    "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde"
  ],
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

// Start with the liberal policy
const basePolicy = Policy.create("liberal-agent")
  .spendingLimit({
    perTransaction: { amount: "100.0", token: "SOL" },
    daily: { amount: "500.0", token: "SOL" },
  })
  .rateLimit({
    maxTransactionsPerMinute: 30,
  })
  .build();

// Extend it to create a stricter version
const stricterPolicy = Policy.extend(basePolicy, "stricter-liberal")
  .spendingLimit({
    perTransaction: { amount: "10.0", token: "SOL" },
    daily: { amount: "50.0", token: "SOL" },
  })
  .allowAddresses([
    "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",
  ])
  .build();

console.log("Base policy:", basePolicy.getName());
// Output: Base policy: liberal-agent

console.log("Extended policy:", stricterPolicy.getName());
// Output: Extended policy: stricter-liberal

const stricterConfig = stricterPolicy.toJSON();
console.log("Max per tx:", stricterConfig.spendingLimit?.perTransaction.amount);
// Output: Max per tx: 10.0
// (overridden from 100.0)

console.log("Rate limit:", stricterConfig.rateLimit?.maxTransactionsPerMinute);
// Output: Rate limit: 30
// (inherited from base)

console.log("Allowlist:", stricterConfig.allowAddresses);
// Output: Allowlist: ["9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde"]
// (added in extension)
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
| Read-Only | 0 SOL | 0 SOL | No | 30/min | No | No |

## Next Steps

- [Your First Agent Wallet](/tutorials/first-wallet) -- Start from scratch
- [Telegram Approval](/tutorials/telegram-approval) -- Set up the approval channel used in Policy 4
- [Building a DeFi Agent](/tutorials/defi-agent) -- Put the DeFi Trader policy to work
- [Production Deployment](/tutorials/production) -- Harden any of these policies for real use
