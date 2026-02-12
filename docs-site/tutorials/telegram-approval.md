# Human-in-the-Loop with Telegram

This tutorial walks you through setting up a Telegram-based <Term id="human-in-the-loop" /> approval system for your agent wallet. High-value transactions will trigger a message to your Telegram chat with Approve and Reject buttons. The agent pauses and waits for your decision before proceeding.

## Prerequisites

- Node.js 18 or later
- A Telegram account
- kova installed (`npm install kova @solana/web3.js`)

## Step 1: Create a Telegram Bot via @BotFather

Open Telegram and search for **@BotFather**. Start a conversation and follow these steps:

1. Send `/newbot`
2. BotFather asks: "What name do you want for your bot?" -- Enter a display name, e.g., `Wallet Approval Bot`
3. BotFather asks: "Choose a username for your bot" -- Enter a unique username ending in `bot`, e.g., `my_wallet_approval_bot`
4. BotFather responds with your **bot token**. It looks like:
   ```
   7123456789:AAF1xxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
5. Save this token securely. You will need it in Step 3.

::: danger
Never share your bot token publicly or commit it to source control. Anyone with this token can control your bot.
:::

## Step 2: Get Your Chat ID

You need the chat ID where the bot will send approval requests. The simplest way to get it:

1. Open a conversation with your new bot in Telegram
2. Send any message to the bot (e.g., "hello")
3. Open this URL in your browser (replace `YOUR_BOT_TOKEN`):
   ```
   https://api.telegram.org/botYOUR_BOT_TOKEN/getUpdates
   ```
4. Look for the `chat` object in the JSON response:
   ```json
   {
     "message": {
       "chat": {
         "id": 123456789,
         "type": "private"
       }
     }
   }
   ```
5. The `id` value (e.g., `123456789`) is your chat ID.

::: tip
For group chats, the chat ID is typically a negative number (e.g., `-1001234567890`). Add your bot to the group first, then send a message in the group and check `getUpdates`.
:::

## Step 3: Set Environment Variables

Store your credentials as environment variables. Create a `.env` file or export them in your shell:

```bash
export TELEGRAM_BOT_TOKEN="7123456789:AAF1xxxxxxxxxxxxxxxxxxxxxxxxxxx"
export TELEGRAM_CHAT_ID="123456789"
export SOLANA_SECRET_KEY='[1,2,3,...,64]'
```

Add a validation pattern at the top of your script to fail fast if variables are missing:

```typescript
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const TELEGRAM_BOT_TOKEN = requireEnv("TELEGRAM_BOT_TOKEN");
const TELEGRAM_CHAT_ID = requireEnv("TELEGRAM_CHAT_ID");
const SOLANA_SECRET_KEY = requireEnv("SOLANA_SECRET_KEY");
```

## Step 4: Create the TelegramApprovalBot Instance

```typescript
import { TelegramApprovalBot } from "kova";

const approvalBot = new TelegramApprovalBot({
  token: TELEGRAM_BOT_TOKEN,
  chatId: TELEGRAM_CHAT_ID,
  defaultTimeout: 300000,    // 5 minutes to respond
  allowedUserIds: [TELEGRAM_CHAT_ID], // Only you can approve
  pollInterval: 2000,        // Check for responses every 2 seconds
});
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `token` | `string` | Bot token from @BotFather |
| `chatId` | `string` | Chat ID where approval messages are sent |
| `defaultTimeout` | `number` | Milliseconds to wait for a response (default: 300000) |
| `allowedUserIds` | `string[]` | Only these user IDs can approve or reject |
| `pollInterval` | `number` | How often to poll for callback responses in ms |

## Step 5: Build a Policy with Approval Gate

Use `requireApproval()` in the policy builder to set the approval threshold.

```typescript
import { Policy } from "kova";

const policy = Policy.create("telegram-approval-policy")
  .spendingLimit({
    perTransaction: { amount: "50.0", token: "SOL" },
    daily: { amount: "200.0", token: "SOL" },
  })
  .rateLimit({
    maxTransactionsPerMinute: 10,
  })
  .requireApproval({
    above: { amount: "5.0", token: "SOL" },
    channel: "telegram",
    timeout: 300_000,
  })
  .build();
```

This means:
- Transactions under 5 SOL are auto-approved
- Transactions of 5 SOL or more require Telegram approval
- If no response within 5 minutes, the transaction is denied (<Term id="fail-closed" />) with `APPROVAL_TIMEOUT`

## Step 6: Create the PolicyEngine with Approval Channel

Pass the `approvalBot` as the third argument to `PolicyEngine` so the `ApprovalGateRule` can send approval requests.

```typescript
import {
  SpendingLimitRule,
  RateLimitRule,
  ApprovalGateRule,
  PolicyEngine,
  MemoryStore,
} from "kova";

const store = new MemoryStore();
const config = policy.toJSON();

const rules = [
  new SpendingLimitRule(config.spendingLimit!),
  new RateLimitRule(config.rateLimit!),
  new ApprovalGateRule(config.requireApproval!),
];

const engine = new PolicyEngine(rules, store, approvalBot);
```

## Step 7: Create the AgentWallet

Assemble the wallet with both the engine and the approval channel.

```typescript
import { Keypair } from "@solana/web3.js";
import {
  AgentWallet,
  LocalSigner,
  SolanaAdapter,
  AuditLogger,
} from "kova";

const keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(SOLANA_SECRET_KEY))
);

const signer = new LocalSigner(keypair);
const chain = new SolanaAdapter({
  rpcUrl: "https://api.devnet.solana.com",
  commitment: "confirmed",
});
const logger = new AuditLogger(store);

const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  approval: approvalBot,
  logger,
});
```

## Step 8: Execute a Small Transfer (Auto-Approved)

Transactions below the 5 SOL threshold go through immediately without any Telegram notification.

```typescript
async function main() {
  console.log("Wallet address:", await wallet.getAddress());

  // Small transfer: auto-approved (below 5 SOL threshold)
  console.log("\n--- Small transfer (1 SOL) ---");
  const smallResult = await wallet.execute({
    type: "transfer",
    chain: "solana",
    params: {
      to: "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",
      amount: "1.0",
      token: "SOL",
    },
  });

  console.log("Status:", smallResult.status);
  console.log("Summary:", smallResult.summary);
  // Output:
  //   Status: confirmed
  //   Summary: Transferred 1.0 SOL to 9aE476...
```

## Step 9: Execute a Large Transfer (Triggers Telegram Approval)

Transactions at or above the threshold trigger a Telegram message and the `wallet.execute()` call blocks until you respond.

```typescript
  // Large transfer: requires Telegram approval (>= 5 SOL threshold)
  console.log("\n--- Large transfer (15 SOL) ---");
  console.log("Waiting for Telegram approval...");

  const largeResult = await wallet.execute({
    type: "transfer",
    chain: "solana",
    params: {
      to: "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",
      amount: "15.0",
      token: "SOL",
    },
  });

  console.log("Status:", largeResult.status);
  console.log("Summary:", largeResult.summary);
  if (largeResult.txId) {
    console.log("Transaction ID:", largeResult.txId);
  }
  if (largeResult.error) {
    console.log("Error:", largeResult.error);
  }
  // If approved:
  //   Status: confirmed
  //   Summary: Transferred 15.0 SOL to 9aE476...
  //   Transaction ID: 4xR8n...
  //
  // If rejected:
  //   Status: denied
  //   Error: APPROVAL_REJECTED
  //
  // If timeout:
  //   Status: denied
  //   Error: APPROVAL_TIMEOUT
```

## Step 10: What the Telegram Message Looks Like

When the large transfer is triggered, your Telegram chat receives a message like this:

```
🔔 Wallet Approval Request

Action: transfer
Amount: 15.0 SOL
Recipient: 9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde
Chain: solana
Intent ID: intent_a1b2c3d4

[✅ Approve]  [❌ Reject]
```

The two inline buttons are:
- **Approve** -- The transaction proceeds, is signed, and submitted to the network
- **Reject** -- The transaction is denied and the agent receives `APPROVAL_REJECTED`

::: tip
The message includes the intent ID for traceability and <Term id="idempotency" />. You can cross-reference this with the audit log to see the full transaction lifecycle.
:::

## Step 11: Check Transaction History After Approval

```typescript
  // View transaction history
  const history = await wallet.getTransactionHistory(10);
  console.log(`\n=== Transaction History (${history.length} entries) ===`);
  for (const tx of history) {
    console.log(`[${tx.status}] ${tx.summary}`);
    console.log(`  Intent: ${tx.intentId} | Time: ${tx.timestamp}`);
    if (tx.txId) console.log(`  Tx ID: ${tx.txId}`);
    if (tx.error) console.log(`  Error: ${tx.error}`);
    console.log();
  }
  // Output:
  //   === Transaction History (2 entries) ===
  //   [confirmed] Transferred 1.0 SOL to 9aE476...
  //     Intent: intent_... | Time: 2025-01-15T10:30:00.000Z
  //     Tx ID: 5Uj7...
  //
  //   [confirmed] Transferred 15.0 SOL to 9aE476...
  //     Intent: intent_... | Time: 2025-01-15T10:31:00.000Z
  //     Tx ID: 4xR8n...

  // Verify audit integrity
  const integrity = await logger.verifyIntegrity(10);
  console.log("Audit integrity:", integrity.valid ? "VALID" : "BROKEN");
}

main().catch(console.error);
```

## Full Working Code

```typescript
import { Keypair } from "@solana/web3.js";
import {
  AgentWallet,
  LocalSigner,
  MemoryStore,
  SolanaAdapter,
  Policy,
  SpendingLimitRule,
  RateLimitRule,
  ApprovalGateRule,
  PolicyEngine,
  AuditLogger,
  TelegramApprovalBot,
} from "kova";

// --- Environment Validation ---
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const TELEGRAM_BOT_TOKEN = requireEnv("TELEGRAM_BOT_TOKEN");
const TELEGRAM_CHAT_ID = requireEnv("TELEGRAM_CHAT_ID");
const SOLANA_SECRET_KEY = requireEnv("SOLANA_SECRET_KEY");

// --- Approval Bot ---
const approvalBot = new TelegramApprovalBot({
  token: TELEGRAM_BOT_TOKEN,
  chatId: TELEGRAM_CHAT_ID,
  defaultTimeout: 300000,
  allowedUserIds: [TELEGRAM_CHAT_ID],
  pollInterval: 2000,
});

// --- Policy ---
const policy = Policy.create("telegram-approval-policy")
  .spendingLimit({
    perTransaction: { amount: "50.0", token: "SOL" },
    daily: { amount: "200.0", token: "SOL" },
  })
  .rateLimit({
    maxTransactionsPerMinute: 10,
  })
  .requireApproval({
    above: { amount: "5.0", token: "SOL" },
    channel: "telegram",
    timeout: 300_000,
  })
  .build();

// --- Engine ---
const store = new MemoryStore();
const config = policy.toJSON();
const rules = [
  new SpendingLimitRule(config.spendingLimit!),
  new RateLimitRule(config.rateLimit!),
  new ApprovalGateRule(config.requireApproval!),
];
const engine = new PolicyEngine(rules, store, approvalBot);

// --- Wallet ---
const keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(SOLANA_SECRET_KEY))
);
const signer = new LocalSigner(keypair);
const chain = new SolanaAdapter({
  rpcUrl: "https://api.devnet.solana.com",
  commitment: "confirmed",
});
const logger = new AuditLogger(store);

const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  approval: approvalBot,
  logger,
});

// --- Main ---
async function main() {
  console.log("Wallet address:", await wallet.getAddress());

  // Small transfer: auto-approved
  console.log("\n--- Small transfer (1 SOL) ---");
  const smallResult = await wallet.execute({
    type: "transfer",
    chain: "solana",
    params: {
      to: "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",
      amount: "1.0",
      token: "SOL",
    },
  });
  console.log("Status:", smallResult.status);
  console.log("Summary:", smallResult.summary);

  // Large transfer: requires Telegram approval
  console.log("\n--- Large transfer (15 SOL) ---");
  console.log("Waiting for Telegram approval...");
  const largeResult = await wallet.execute({
    type: "transfer",
    chain: "solana",
    params: {
      to: "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",
      amount: "15.0",
      token: "SOL",
    },
  });
  console.log("Status:", largeResult.status);
  console.log("Summary:", largeResult.summary);
  if (largeResult.txId) console.log("Tx ID:", largeResult.txId);
  if (largeResult.error) console.log("Error:", largeResult.error);

  // Transaction history
  const history = await wallet.getTransactionHistory(10);
  console.log(`\n=== Transaction History (${history.length} entries) ===`);
  for (const tx of history) {
    console.log(`[${tx.status}] ${tx.summary} (${tx.timestamp})`);
  }

  // Audit integrity
  const integrity = await logger.verifyIntegrity(10);
  console.log("\nAudit integrity:", integrity.valid ? "VALID" : "BROKEN");
}

main().catch(console.error);
```

## Troubleshooting

### Bot does not receive messages

- Verify the bot token by visiting `https://api.telegram.org/botYOUR_TOKEN/getMe`
- Make sure you have started a conversation with the bot (send `/start`)
- Check that the chat ID is correct

### Approval always times out

- Increase `defaultTimeout` if you need more time to respond
- Verify `allowedUserIds` includes your Telegram user ID (not the chat ID if they differ)
- Check that `pollInterval` is not too long (2000ms is a good default)

### Bot works but buttons do not appear

- Telegram inline keyboards require the bot to have permission to send messages in the chat
- In group chats, make sure the bot is an admin or has the "Send Messages" permission

## Next Steps

- [Policy Cookbook](/tutorials/policy-cookbook) -- Explore different approval threshold configurations
- [Production Deployment](/tutorials/production) -- Use SqliteStore for persistent audit logs
- [API Reference](/api/reference) -- Full TelegramApprovalBot configuration reference
