# ApprovalGateRule

The `ApprovalGateRule` requires human approval for transactions above a configurable threshold. It integrates with the `ApprovalChannel` abstraction to send approval requests and wait for human decisions.

## Import

```typescript
import { ApprovalGateRule } from "kova";
import type { ApprovalGateConfig, TokenAmount } from "kova";
```

## ApprovalGateConfig

```typescript
interface ApprovalGateConfig {
  /** Transactions above this amount require approval */
  above: TokenAmount;
  /** Channel type hint (optional, for documentation) */
  channel?: "telegram" | "slack" | "custom";
  /** Timeout in milliseconds. Defaults to 300,000 (5 minutes) */
  timeout?: number;
}

interface TokenAmount {
  amount: string;
  token: string;
}
```

## Constructor

```typescript
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

::: danger
If you configure an `ApprovalGateRule` but do NOT provide an `ApprovalChannel` to the `PolicyEngine`, all transactions above the threshold will be automatically denied. Always pass the approval channel to the `PolicyEngine` constructor.
:::

## Integration with TelegramApprovalBot

The most common setup pairs `ApprovalGateRule` with `TelegramApprovalBot`:

```typescript
import {
  PolicyEngine,
  SpendingLimitRule,
  ApprovalGateRule,
  TelegramApprovalBot,
  MemoryStore,
} from "kova";

const store = new MemoryStore();

const approval = new TelegramApprovalBot({
  token: process.env.TELEGRAM_BOT_TOKEN!,
  chatId: process.env.TELEGRAM_CHAT_ID!,
  defaultTimeout: 300_000,
  allowedUserIds: [123456789],
});

const engine = new PolicyEngine(
  [
    new SpendingLimitRule({
      perTransaction: { amount: "50", token: "SOL" },
      daily: { amount: "200", token: "SOL" },
    }),
    new ApprovalGateRule({
      above: { amount: "10", token: "SOL" },
      timeout: 600_000,
    }),
  ],
  store,
  approval, // Pass approval channel to the engine
);
```

With this setup:

- Transactions up to 10 SOL are auto-approved (if spending limits allow)
- Transactions between 10 and 50 SOL trigger a Telegram approval request
- Transactions above 50 SOL are denied by the spending limit (never reach the approval gate)

## Code Example: Require Approval Above 10 SOL

```typescript
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

const store = new MemoryStore();
const signer = new LocalSigner(Keypair.generate());
const chain = new SolanaAdapter({ rpcUrl: "https://api.devnet.solana.com" });

const approval = new TelegramApprovalBot({
  token: process.env.TELEGRAM_BOT_TOKEN!,
  chatId: process.env.TELEGRAM_CHAT_ID!,
  allowedUserIds: [123456789],
});

const engine = new PolicyEngine(
  [
    new RateLimitRule({ maxTransactionsPerMinute: 5 }),
    new SpendingLimitRule({ daily: { amount: "100", token: "SOL" } }),
    new ApprovalGateRule({
      above: { amount: "10", token: "SOL" },
      timeout: 300_000,
    }),
  ],
  store,
  approval,
);

const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  approval,
});

// This will auto-approve (5 SOL < 10 SOL threshold)
const small = await wallet.execute({
  type: "transfer",
  chain: "solana",
  params: { to: "9WzDXwBb...", amount: "5", token: "SOL" },
});
console.log("Small transfer:", small.status); // "confirmed" or "failed"

// This will trigger Telegram approval (15 SOL > 10 SOL threshold)
const large = await wallet.execute({
  type: "transfer",
  chain: "solana",
  params: { to: "9WzDXwBb...", amount: "15", token: "SOL" },
});
console.log("Large transfer:", large.status); // depends on human decision
```

## Introspection

```typescript
const config = rule.getConfig();
console.log("Threshold:", config.above.amount, config.above.token);
console.log("Timeout:", config.timeout, "ms");
```
