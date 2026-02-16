# Human-in-the-Loop with Telegram

::: info What you'll learn
- How to create a Telegram bot with BotFather and connect it to your agent wallet
- How the `ApprovalGateRule` pauses transaction execution and waits for a human decision
- How to build inline Approve/Reject buttons that resolve pending approvals
- How to wire the full flow: agent submits transaction → Telegram notification → human decides → agent resumes
- How to test the complete human-in-the-loop approval cycle end to end
:::

This tutorial walks you through setting up a Telegram-based <Term id="human-in-the-loop" /> approval system for your agent wallet. High-value transactions will trigger a message to your Telegram chat with Approve and Reject buttons. The agent pauses and waits for your decision before proceeding.

::: tip New to "human-in-the-loop"?
"Human-in-the-loop" (HITL) is a pattern where an automated system pauses at critical decision points and asks a human for approval before continuing. In this case, your AI agent will handle small transactions automatically but ask *you* for permission before executing large ones -- similar to how a bank might call you to confirm a large wire transfer.
:::

## Prerequisites

- **Node.js 18 or later** ([download here](https://nodejs.org/))
- **A Telegram account** -- the free messaging app ([telegram.org](https://telegram.org/))
- **kova installed** (`npm install kova @solana/web3.js`)
- **A funded Solana devnet wallet** -- you will need some devnet SOL for testing. See [Your First Agent Wallet](/tutorials/first-wallet) if you have not set this up yet.
- **About 20 minutes** to complete this tutorial

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

**Expected output from BotFather:**

```
Done! Congratulations on your new bot. You will find it at t.me/my_wallet_approval_bot.
You can now add a description, about section and profile picture for your bot, see /help for a list of commands.

Use this token to access the HTTP Bot API:
7123456789:AAF1xxxxxxxxxxxxxxxxxxxxxxxxxxx
```

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
         // "id" is the chat ID you need. Copy this number.
         // For private chats: a positive integer (e.g., 123456789).
         // For group chats: a negative integer (e.g., -1001234567890).
         "id": 123456789,
         // "type" will be "private" for 1-on-1 chats or "group"/"supergroup" for groups.
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
# Set the Telegram bot token obtained from @BotFather in Step 1.
# This authenticates your application with the Telegram Bot API.
export TELEGRAM_BOT_TOKEN="7123456789:AAF1xxxxxxxxxxxxxxxxxxxxxxxxxxx"

# Set the chat ID where the bot will send approval request messages.
# For private chats, this is a positive integer. For group chats, it is negative.
export TELEGRAM_CHAT_ID="123456789"

# Set the Solana wallet secret key as a JSON array of 64 bytes.
# This is the keypair that the agent will use to sign transactions.
# NEVER commit this value to source control.
export SOLANA_SECRET_KEY='[1,2,3,...,64]'
```

Add a validation pattern at the top of your script to fail fast if variables are missing:

```typescript
// Helper function to validate that required environment variables are set.
// Throws immediately at startup if any are missing, rather than failing
// later during runtime when a missing value causes a cryptic error.
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    // Fail fast with a clear error message identifying the missing variable.
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Load and validate all required environment variables at startup.
const TELEGRAM_BOT_TOKEN = requireEnv("TELEGRAM_BOT_TOKEN");   // Bot token from @BotFather
const TELEGRAM_CHAT_ID = requireEnv("TELEGRAM_CHAT_ID");       // Chat ID for approval messages
const SOLANA_SECRET_KEY = requireEnv("SOLANA_SECRET_KEY");      // Wallet keypair (JSON byte array)
```

::: details What just happened?
You set three environment variables that the application needs to run:

- **`TELEGRAM_BOT_TOKEN`** authenticates your app with the Telegram Bot API -- it proves you own this bot.
- **`TELEGRAM_CHAT_ID`** tells the bot *where* to send approval request messages.
- **`SOLANA_SECRET_KEY`** is the wallet's private key -- the agent uses it to sign transactions after approval.

These are kept as environment variables (not hardcoded) so you never accidentally commit secrets to version control.
:::

## Step 4: Create the TelegramApprovalBot Instance

```typescript
import { TelegramApprovalBot } from "kova";

// Create the TelegramApprovalBot instance. This implements the ApprovalChannel
// interface and sends rich messages with inline Approve/Reject buttons.
// When a high-value transaction is detected, it sends a message to the specified
// chat and polls for the human's button-click response.
const approvalBot = new TelegramApprovalBot({
  token: TELEGRAM_BOT_TOKEN,               // Authenticates with the Telegram Bot API
  chatId: TELEGRAM_CHAT_ID,                 // Chat where approval messages are delivered
  defaultTimeout: 300000,                    // 5 minutes to respond before auto-deny (fail-closed)
  allowedUserIds: [TELEGRAM_CHAT_ID],        // Only these Telegram user IDs can approve/reject.
                                             // Prevents unauthorized users from approving transactions.
  pollInterval: 2000,                        // Poll Telegram for callback responses every 2 seconds.
                                             // Lower = more responsive, higher = fewer API calls.
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

// Build a policy that combines spending limits with a Telegram approval gate.
// The key concept: transactions below the threshold proceed automatically,
// while those at or above the threshold require explicit human approval.
const policy = Policy.create("telegram-approval-policy")
  .spendingLimit({
    perTransaction: { amount: "50.0", token: "SOL" },  // Hard cap: no single tx over 50 SOL
    daily: { amount: "200.0", token: "SOL" },           // Hard cap: no more than 200 SOL per day
  })
  .rateLimit({
    maxTransactionsPerMinute: 10,  // Max 10 transactions per rolling minute
  })
  .requireApproval({
    above: { amount: "5.0", token: "SOL" },  // Trigger approval for transactions >= 5 SOL
    channel: "telegram",                       // Send the approval request via Telegram
    timeout: 300_000,                          // Auto-deny if no response within 5 minutes
                                               // (300,000 ms). This is the fail-closed behavior.
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
  SpendingLimitRule,   // Enforces per-transaction and daily spending caps
  RateLimitRule,       // Enforces max transactions per time window
  ApprovalGateRule,    // Triggers human approval for high-value transactions
  PolicyEngine,        // Evaluates all rules sequentially
  MemoryStore,         // In-memory state store for dev/testing
} from "kova";

// Create the store for spending counters, rate limit windows, and audit log.
const store = new MemoryStore();
// Extract the policy configuration to create individual rule instances.
const config = policy.toJSON();

// Create rules in evaluation order: cheapest checks first.
// If spending or rate limits deny the intent, the approval gate is never reached.
const rules = [
  new SpendingLimitRule(config.spendingLimit!),  // Check spending caps first
  new RateLimitRule(config.rateLimit!),            // Check rate limits next
  new ApprovalGateRule(config.requireApproval!),   // Approval gate runs last (most expensive)
];

// Pass the approvalBot as the third argument to PolicyEngine.
// This connects the ApprovalGateRule to the Telegram delivery mechanism.
// When the gate rule detects a transaction above the threshold, it calls
// approvalBot.requestApproval() to send the Telegram message.
const engine = new PolicyEngine(rules, store, approvalBot);
```

## Step 7: Create the AgentWallet

Assemble the wallet with both the engine and the approval channel.

```typescript
import { Keypair } from "@solana/web3.js";
import {
  AgentWallet,     // Top-level wallet object the agent interacts with
  LocalSigner,     // Signs transactions using an in-memory Solana Keypair
  SolanaAdapter,   // Chain adapter for Solana (build tx, broadcast, query balance)
  AuditLogger,     // Tamper-evident SHA-256 hash chain audit log
} from "kova";

// Reconstruct the Solana Keypair from the secret key environment variable.
// The secret key is a JSON-encoded array of 64 bytes.
const keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(SOLANA_SECRET_KEY))
);

// Create the signer, chain adapter, and audit logger.
const signer = new LocalSigner(keypair);       // Signs transactions with the local keypair
const chain = new SolanaAdapter({
  rpcUrl: "https://api.devnet.solana.com",     // Solana devnet for testing
  commitment: "confirmed",                      // Wait for supermajority confirmation
});
const logger = new AuditLogger(store);          // Records all transaction attempts

// Assemble the AgentWallet with all components, including the approval bot.
// The `approval` field is optional -- only needed when using ApprovalGateRule.
const wallet = new AgentWallet({
  signer,                   // Signs transactions before broadcast
  chain,                    // Builds and broadcasts Solana transactions
  policy: engine,           // Evaluates policy rules (including the approval gate)
  store,                    // Shared state for counters, audit log, and caches
  approval: approvalBot,    // Telegram bot for human-in-the-loop approval
  logger,                   // Records every transaction attempt in the hash chain
});
```

## Step 8: Execute a Small Transfer (Auto-Approved)

Transactions below the 5 SOL threshold go through immediately without any Telegram notification.

```typescript
async function main() {
  // Print the wallet address for reference (useful for funding via airdrop).
  console.log("Wallet address:", await wallet.getAddress());

  // Small transfer: 1 SOL is below the 5 SOL approval threshold,
  // so it proceeds automatically without triggering a Telegram message.
  // The policy engine checks spending limits and rate limits, but the
  // ApprovalGateRule sees the amount is below the threshold and returns ALLOW.
  console.log("\n--- Small transfer (1 SOL) ---");
  const smallResult = await wallet.execute({
    type: "transfer",    // Simple SOL transfer
    chain: "solana",
    params: {
      to: "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",  // Recipient address
      amount: "1.0",     // Below the 5 SOL approval threshold
      token: "SOL",
    },
  });

  console.log("Status:", smallResult.status);    // "confirmed" -- no approval needed
  console.log("Summary:", smallResult.summary);
  // Output:
  //   Status: confirmed
  //   Summary: Transferred 1.0 SOL to 9aE476...
```

**Expected output:**

```
--- Small transfer (1 SOL) ---
Status: confirmed
Summary: Transferred 1.0 SOL to 9aE476...
```

Notice that no Telegram message was sent. The `ApprovalGateRule` checked the amount (1 SOL), saw it was below the 5 SOL threshold, and returned `ALLOW` without contacting Telegram.

## Step 9: Execute a Large Transfer (Triggers Telegram Approval)

Transactions at or above the threshold trigger a Telegram message and the `wallet.execute()` call blocks until you respond.

```typescript
  // Large transfer: 15 SOL is above the 5 SOL approval threshold.
  // This triggers the following flow:
  //   1. PolicyEngine evaluates spending limit and rate limit (both ALLOW)
  //   2. ApprovalGateRule detects amount >= 5 SOL threshold
  //   3. TelegramApprovalBot sends a message with Approve/Reject buttons
  //   4. wallet.execute() BLOCKS here, waiting for the human response
  //   5. Human clicks a button (or timeout expires after 5 minutes)
  console.log("\n--- Large transfer (15 SOL) ---");
  console.log("Waiting for Telegram approval...");

  const largeResult = await wallet.execute({
    type: "transfer",
    chain: "solana",
    params: {
      to: "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",
      amount: "15.0",    // Above the 5 SOL threshold -- triggers Telegram approval
      token: "SOL",
    },
  });

  // Check the result -- three possible outcomes after approval request:
  console.log("Status:", largeResult.status);
  console.log("Summary:", largeResult.summary);
  if (largeResult.txId) {
    // txId is present only if the transaction was approved and confirmed on-chain.
    console.log("Transaction ID:", largeResult.txId);
  }
  if (largeResult.error) {
    // Error is present for denied (rejected/timeout) or failed transactions.
    console.log("Error:", largeResult.error);
  }
  // If approved:
  //   Status: confirmed
  //   Summary: Transferred 15.0 SOL to 9aE476...
  //   Transaction ID: 4xR8n...
  //
  // If rejected (human clicked Reject):
  //   Status: denied
  //   Error: APPROVAL_REJECTED
  //
  // If timeout (no response within 5 minutes):
  //   Status: denied
  //   Error: APPROVAL_TIMEOUT
```

**Expected output (if you click Approve in Telegram):**

```
--- Large transfer (15 SOL) ---
Waiting for Telegram approval...
Status: confirmed
Summary: Transferred 15.0 SOL to 9aE476...
Transaction ID: 4xR8n...
```

**Expected output (if you click Reject in Telegram):**

```
--- Large transfer (15 SOL) ---
Waiting for Telegram approval...
Status: denied
Error: APPROVAL_REJECTED
```

::: details What just happened?
Here is the full sequence that occurred when you executed the 15 SOL transfer:

1. Your code called `wallet.execute()` with a 15 SOL transfer intent.
2. The `PolicyEngine` evaluated the intent against each rule in order:
   - `SpendingLimitRule`: 15 SOL is under the 50 SOL per-transaction cap -- ALLOW.
   - `RateLimitRule`: This is only the second transaction -- ALLOW.
   - `ApprovalGateRule`: 15 SOL is at or above the 5 SOL threshold -- PAUSE.
3. The `ApprovalGateRule` called `approvalBot.requestApproval()`, which sent a message to your Telegram chat with inline Approve/Reject buttons.
4. The `wallet.execute()` call blocked (waited), polling Telegram every 2 seconds for your response.
5. When you clicked Approve, the bot detected the callback, and the wallet proceeded to build, sign, and broadcast the transaction.
6. After on-chain confirmation, `wallet.execute()` returned with `status: "confirmed"`.

If you had not clicked anything within 5 minutes, the system would have automatically denied the transaction (fail-closed behavior).
:::

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
  // Retrieve the last 10 entries from the audit log.
  // Both the small (auto-approved) and large (Telegram-approved) transfers
  // are recorded, along with any denied or failed attempts.
  const history = await wallet.getTransactionHistory(10);
  console.log(`\n=== Transaction History (${history.length} entries) ===`);
  for (const tx of history) {
    console.log(`[${tx.status}] ${tx.summary}`);
    console.log(`  Intent: ${tx.intentId} | Time: ${tx.timestamp}`);
    if (tx.txId) console.log(`  Tx ID: ${tx.txId}`);       // Only for submitted transactions
    if (tx.error) console.log(`  Error: ${tx.error}`);     // Only for denied/failed transactions
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

  // Verify the SHA-256 hash chain integrity of the audit log.
  // Each entry's hash includes the previous entry's hash, forming a
  // tamper-evident chain. If any entry is modified, this check fails.
  const integrity = await logger.verifyIntegrity(10);
  console.log("Audit integrity:", integrity.valid ? "VALID" : "BROKEN");
}

// Run the async main function; log any unhandled errors.
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
// Fail fast if any required environment variable is missing.
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const TELEGRAM_BOT_TOKEN = requireEnv("TELEGRAM_BOT_TOKEN");   // Bot token from @BotFather
const TELEGRAM_CHAT_ID = requireEnv("TELEGRAM_CHAT_ID");       // Chat ID for approval messages
const SOLANA_SECRET_KEY = requireEnv("SOLANA_SECRET_KEY");      // Wallet keypair (JSON byte array)

// --- Approval Bot ---
// TelegramApprovalBot sends approval requests to Telegram and polls for responses.
const approvalBot = new TelegramApprovalBot({
  token: TELEGRAM_BOT_TOKEN,
  chatId: TELEGRAM_CHAT_ID,
  defaultTimeout: 300000,                // 5 minutes to respond before auto-deny
  allowedUserIds: [TELEGRAM_CHAT_ID],    // Only this user can approve/reject
  pollInterval: 2000,                    // Check for responses every 2 seconds
});

// --- Policy ---
// Transactions < 5 SOL proceed automatically; >= 5 SOL require Telegram approval.
const policy = Policy.create("telegram-approval-policy")
  .spendingLimit({
    perTransaction: { amount: "50.0", token: "SOL" },  // Hard cap per transaction
    daily: { amount: "200.0", token: "SOL" },           // Hard cap per day
  })
  .rateLimit({
    maxTransactionsPerMinute: 10,  // Max 10 transactions per rolling minute
  })
  .requireApproval({
    above: { amount: "5.0", token: "SOL" },  // Approval threshold
    channel: "telegram",                       // Delivery mechanism
    timeout: 300_000,                          // 5 minutes before auto-deny
  })
  .build();

// --- Engine ---
// Create the store, rules, and policy engine.
const store = new MemoryStore();
const config = policy.toJSON();
const rules = [
  new SpendingLimitRule(config.spendingLimit!),  // Check spending caps first
  new RateLimitRule(config.rateLimit!),            // Check rate limits next
  new ApprovalGateRule(config.requireApproval!),   // Approval gate runs last
];
// Pass approvalBot so the ApprovalGateRule can send Telegram messages.
const engine = new PolicyEngine(rules, store, approvalBot);

// --- Wallet ---
// Reconstruct the Solana Keypair from the environment variable.
const keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(SOLANA_SECRET_KEY))
);
const signer = new LocalSigner(keypair);           // Signs transactions locally
const chain = new SolanaAdapter({
  rpcUrl: "https://api.devnet.solana.com",         // Devnet for testing
  commitment: "confirmed",                          // Wait for supermajority
});
const logger = new AuditLogger(store);              // Tamper-evident audit log

// Assemble the wallet with all components including the approval bot.
const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  approval: approvalBot,   // Enables human-in-the-loop approval flow
  logger,
});

// --- Main ---
async function main() {
  console.log("Wallet address:", await wallet.getAddress());

  // Small transfer: auto-approved (1 SOL < 5 SOL threshold)
  console.log("\n--- Small transfer (1 SOL) ---");
  const smallResult = await wallet.execute({
    type: "transfer",
    chain: "solana",
    params: {
      to: "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",
      amount: "1.0",     // Below threshold -- no Telegram message sent
      token: "SOL",
    },
  });
  console.log("Status:", smallResult.status);
  console.log("Summary:", smallResult.summary);

  // Large transfer: triggers Telegram approval (15 SOL >= 5 SOL threshold)
  // This call BLOCKS until the human approves, rejects, or the timeout expires.
  console.log("\n--- Large transfer (15 SOL) ---");
  console.log("Waiting for Telegram approval...");
  const largeResult = await wallet.execute({
    type: "transfer",
    chain: "solana",
    params: {
      to: "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",
      amount: "15.0",    // Above threshold -- triggers Telegram approval
      token: "SOL",
    },
  });
  console.log("Status:", largeResult.status);
  console.log("Summary:", largeResult.summary);
  if (largeResult.txId) console.log("Tx ID:", largeResult.txId);
  if (largeResult.error) console.log("Error:", largeResult.error);

  // View the audit trail after both transactions.
  const history = await wallet.getTransactionHistory(10);
  console.log(`\n=== Transaction History (${history.length} entries) ===`);
  for (const tx of history) {
    console.log(`[${tx.status}] ${tx.summary} (${tx.timestamp})`);
  }

  // Verify the SHA-256 hash chain integrity.
  const integrity = await logger.verifyIntegrity(10);
  console.log("\nAudit integrity:", integrity.valid ? "VALID" : "BROKEN");
}

main().catch(console.error);
```

## Common Mistakes

1. **Confusing chat ID with user ID.** In private chats, the chat ID and user ID are the same number. In group chats, they are different. The `chatId` parameter tells the bot *where* to send messages, while `allowedUserIds` controls *who* can click the buttons. If you are in a group chat, make sure `allowedUserIds` contains your personal user ID, not the group chat ID.

2. **Not starting a conversation with the bot first.** Telegram bots cannot send messages to users who have not interacted with them. You must open a chat with your bot and send `/start` before the bot can send you approval requests.

3. **Setting the approval threshold too low.** If you set the approval threshold to 0.001 SOL, every single transaction will require manual approval -- including the ones you want to be automatic. Choose a threshold that separates routine transactions from high-value ones. A good starting point is 5-10 SOL.

## Troubleshooting

### Bot does not receive messages

- Verify the bot token by visiting `https://api.telegram.org/botYOUR_TOKEN/getMe`
- Make sure you have started a conversation with the bot (send `/start`)
- Check that the chat ID is correct
- If you recently created the bot, wait a minute and try again -- Telegram sometimes takes a moment to propagate new bots

### Telegram bot not responding

- **Check the bot token:** Copy your `TELEGRAM_BOT_TOKEN` and visit `https://api.telegram.org/botYOUR_TOKEN/getMe` in your browser. If you see `{"ok":false}`, the token is invalid. Go back to @BotFather and verify.
- **Check the chat ID:** Visit `https://api.telegram.org/botYOUR_TOKEN/getUpdates` after sending a message to the bot. If the response is empty (`{"ok":true,"result":[]}`), the bot has not received any messages yet -- send `/start` to the bot first.
- **Firewall or proxy issues:** If you are behind a corporate firewall, Telegram API requests may be blocked. Try from a different network or use a VPN.

### Approval always times out

- Increase `defaultTimeout` if you need more time to respond
- Verify `allowedUserIds` includes your Telegram user ID (not the chat ID if they differ)
- Check that `pollInterval` is not too long (2000ms is a good default)
- Make sure your internet connection is stable -- the bot polls Telegram's servers and needs consistent connectivity

### Bot works but buttons do not appear

- Telegram inline keyboards require the bot to have permission to send messages in the chat
- In group chats, make sure the bot is an admin or has the "Send Messages" permission

### Error: "Missing required environment variable"

- Make sure you exported the environment variables in the same terminal session where you are running the script. Environment variables set with `export` only persist in the current shell session.
- If you are using a `.env` file, make sure you have a library like `dotenv` installed and configured to load it (`import 'dotenv/config'` at the top of your script).

## What to Try Next

- **Lower the threshold to 1 SOL** and send three transactions (0.5 SOL, 1.5 SOL, 3 SOL) to observe which ones trigger approval and which proceed automatically.
- **Add a second approver** by creating a Telegram group, adding your bot, and setting `chatId` to the group chat ID. Now multiple people can approve transactions.
- **Combine with a time window policy.** Add `.activeHours()` to the policy so the agent can only transact during business hours, and transactions above the threshold also require approval. See the [Policy Cookbook](/tutorials/policy-cookbook) for the business hours pattern.

## Next Steps

- [Policy Cookbook](/tutorials/policy-cookbook) -- Explore different approval threshold configurations
- [Production Deployment](/tutorials/production) -- Use SqliteStore for persistent audit logs
- [API Reference](/api/reference) -- Full TelegramApprovalBot configuration reference
