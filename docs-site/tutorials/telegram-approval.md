# Human-in-the-Loop with Telegram

::: info What you'll learn
- How to implement a custom `ApprovalChannel` using Telegram as the delivery mechanism
- How to create a Telegram bot with BotFather and connect it to your agent wallet
- How the `ApprovalGateRule` pauses transaction execution and waits for a human decision
- How to wire the full flow: agent submits transaction → Telegram notification → human decides → agent resumes
- How to test the complete human-in-the-loop approval cycle end to end
:::

This tutorial walks you through setting up a Telegram-based <Term id="human-in-the-loop" /> approval system for your agent wallet using kova's `CallbackApprovalChannel`. High-value transactions will trigger a message to your Telegram chat with Approve and Reject buttons. The agent pauses and waits for your decision before proceeding.

::: tip Why Telegram?
kova ships two generic approval channels — `CallbackApprovalChannel` and `WebhookApprovalChannel` — instead of bundling a Telegram-specific implementation. This gives you full control over how approvals are delivered (Slack, Discord, email, SMS, in-app UI, etc.). This tutorial demonstrates the pattern using Telegram as one example.
:::

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

# Set your Telegram user ID for self-approval prevention.
# In private chats, this is usually the same as the chat ID.
export TELEGRAM_USER_ID="123456789"

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
const TELEGRAM_USER_ID = requireEnv("TELEGRAM_USER_ID");       // User ID for self-approval prevention
const SOLANA_SECRET_KEY = requireEnv("SOLANA_SECRET_KEY");      // Wallet keypair (JSON byte array)
```

::: details What just happened?
You set four environment variables that the application needs to run:

- **`TELEGRAM_BOT_TOKEN`** authenticates your app with the Telegram Bot API -- it proves you own this bot.
- **`TELEGRAM_CHAT_ID`** tells the bot *where* to send approval request messages.
- **`TELEGRAM_USER_ID`** identifies you for self-approval prevention -- ensures the person who requested a transaction cannot also approve it.
- **`SOLANA_SECRET_KEY`** is the wallet's private key -- the agent uses it to sign transactions after approval.

These are kept as environment variables (not hardcoded) so you never accidentally commit secrets to version control.
:::

## Step 4: Build a Telegram Approval Channel

kova's `CallbackApprovalChannel` lets you plug in any notification and decision-collection mechanism. Here, we'll use the Telegram Bot API.

The key idea: you provide two callbacks:
- **`onApprovalRequest`** — sends a Telegram message with Approve/Reject buttons
- **`waitForDecision`** — polls Telegram for the human's button click

```typescript
import { CallbackApprovalChannel } from "kova";
import type { ApprovalRequest, ApprovalResult } from "kova";

// Telegram Bot API base URL. All API calls go through this endpoint.
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// Track pending approvals: maps request ID → resolver function.
// When a human clicks Approve or Reject, we resolve the corresponding promise.
const pendingApprovals = new Map<string, (result: ApprovalResult) => void>();

// Create the approval channel using CallbackApprovalChannel.
// This implements the ApprovalChannel interface that the policy engine expects.
const approvalChannel = new CallbackApprovalChannel({
  name: "telegram",

  // Called when a transaction needs human approval.
  // Sends a Telegram message with inline Approve/Reject buttons.
  onApprovalRequest: async (request: ApprovalRequest) => {
    const text =
      `🔔 *Wallet Approval Request*\n\n` +
      `*Action:* ${request.summary}\n` +
      `*Amount:* ${request.amount} ${request.token}\n` +
      `*Recipient:* \`${request.target}\`\n` +
      `*Request ID:* \`${request.id}\`\n` +
      (request.reason ? `*Reason:* ${request.reason}\n` : "");

    // Telegram inline keyboard with Approve and Reject buttons.
    // The callback_data encodes the action and request ID so we can
    // match button clicks to pending requests.
    const keyboard = {
      inline_keyboard: [[
        { text: "✅ Approve", callback_data: `approve:${request.id}` },
        { text: "❌ Reject", callback_data: `reject:${request.id}` },
      ]],
    };

    const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "Markdown",
        reply_markup: keyboard,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Telegram sendMessage failed: ${response.status} ${body}`);
    }
  },

  // Called to wait for the human's decision.
  // Polls Telegram's getUpdates endpoint for callback queries (button clicks).
  waitForDecision: (request: ApprovalRequest) => {
    return new Promise<ApprovalResult>((resolve) => {
      pendingApprovals.set(request.id, resolve);
    });
  },

  // Auto-deny if no response within 5 minutes (fail-closed).
  defaultTimeout: 300_000,
});
```

## Step 5: Start Polling for Button Clicks

The Telegram Bot API uses a polling model — we periodically call `getUpdates` to check for new button clicks:

```typescript
let lastUpdateId = 0;
let polling = true;

// Poll Telegram for callback queries (button clicks) in a background loop.
// Each callback_data contains "approve:<requestId>" or "reject:<requestId>".
async function pollTelegram(): Promise<void> {
  while (polling) {
    try {
      const response = await fetch(
        `${TELEGRAM_API}/getUpdates?offset=${lastUpdateId + 1}&timeout=10&allowed_updates=["callback_query"]`,
      );
      const data = await response.json() as {
        ok: boolean;
        result: Array<{
          update_id: number;
          callback_query?: {
            id: string;
            from: { id: number; first_name?: string };
            data?: string;
          };
        }>;
      };

      if (!data.ok || !data.result?.length) continue;

      for (const update of data.result) {
        lastUpdateId = update.update_id;
        const query = update.callback_query;
        if (!query?.data) continue;

        // Parse the callback data: "approve:<requestId>" or "reject:<requestId>"
        const [action, requestId] = query.data.split(":");
        if (!requestId) continue;

        // Self-approval prevention: check if the clicker is the requester
        if (String(query.from.id) === TELEGRAM_USER_ID) {
          await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              callback_query_id: query.id,
              text: "Self-approval is not permitted.",
              show_alert: true,
            }),
          });
          continue;
        }

        // Look up the pending request and resolve it
        const resolver = pendingApprovals.get(requestId!);
        if (!resolver) continue;

        pendingApprovals.delete(requestId!);

        const decision = action === "approve" ? "approved" : "rejected";
        const decidedBy = query.from.first_name || String(query.from.id);

        resolver({
          requestId: requestId!,
          decision,
          decidedBy,
          decidedAt: Date.now(),
        });

        // Acknowledge the button click in Telegram (removes the loading spinner)
        await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            callback_query_id: query.id,
            text: decision === "approved" ? "Transaction approved!" : "Transaction rejected.",
          }),
        });
      }
    } catch (err) {
      console.error("Telegram polling error:", err);
      // Brief pause before retrying to avoid tight error loops
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// Start polling in the background (fire-and-forget).
pollTelegram();
```

## Step 6: Build a Policy with Approval Gate

Use `requireApproval()` in the policy builder to set the approval threshold.

```typescript
import { Policy } from "kova";

// Build a policy that combines spending limits with an approval gate.
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
    timeout: 300_000,                          // Auto-deny if no response within 5 minutes
                                               // (300,000 ms). This is the fail-closed behavior.
  })
  .build();
```

This means:
- Transactions under 5 SOL are auto-approved
- Transactions of 5 SOL or more require Telegram approval
- If no response within 5 minutes, the transaction is denied (<Term id="fail-closed" />) with `APPROVAL_TIMEOUT`

## Step 7: Create the PolicyEngine and AgentWallet

Pass the `approvalChannel` so the `ApprovalGateRule` can send approval requests.

```typescript
import { Keypair } from "@solana/web3.js";
import {
  AgentWallet,
  LocalSigner,
  MemoryStore,
  SolanaAdapter,
  SpendingLimitRule,
  RateLimitRule,
  ApprovalGateRule,
  PolicyEngine,
  AuditLogger,
} from "kova";

// Create the store for spending counters, rate limit windows, and audit log.
const store = new MemoryStore(); // Dev-only; throws in production unless KOVA_ALLOW_MEMORY_STORE=1
const config = policy.toJSON();

// Create rules in evaluation order: cheapest checks first.
const rules = [
  new SpendingLimitRule(config.spendingLimit!),
  new RateLimitRule(config.rateLimit!),
  new ApprovalGateRule(config.approvalGate!),
];

// Pass the approvalChannel so the ApprovalGateRule can send messages.
const engine = new PolicyEngine(rules, store, approvalChannel);

// Reconstruct the Solana Keypair from the environment variable.
const keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(SOLANA_SECRET_KEY))
);

const signer = new LocalSigner(keypair);
const chain = new SolanaAdapter({
  rpcUrl: "https://api.devnet.solana.com",
  commitment: "confirmed",
});
const logger = new AuditLogger(store);

// Assemble the wallet with all components, including the approval channel.
const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  approval: approvalChannel,
  logger,
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
  console.log("\n--- Small transfer (1 SOL) ---");
  const smallResult = await wallet.execute({
    type: "transfer",
    chain: "solana",
    params: {
      to: "9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde",
      amount: "1.0",     // Below the 5 SOL approval threshold
      token: "SOL",
    },
  });

  console.log("Status:", smallResult.status);    // "confirmed" -- no approval needed
  console.log("Summary:", smallResult.summary);
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
  //   3. CallbackApprovalChannel calls onApprovalRequest → sends Telegram message
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

  console.log("Status:", largeResult.status);
  console.log("Summary:", largeResult.summary);
  if (largeResult.txId) {
    console.log("Transaction ID:", largeResult.txId);
  }
  if (largeResult.error) {
    console.log("Error:", largeResult.error);
  }
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
3. The `ApprovalGateRule` called `approvalChannel.requestApproval()`, which invoked your `onApprovalRequest` callback, sending a Telegram message with inline Approve/Reject buttons.
4. The `wallet.execute()` call blocked (waited), while `pollTelegram()` checked for button clicks.
5. When you clicked Approve, the polling loop detected the callback, resolved the pending promise, and the wallet proceeded to build, sign, and broadcast the transaction.
6. After on-chain confirmation, `wallet.execute()` returned with `status: "confirmed"`.

If you had not clicked anything within 5 minutes, the `CallbackApprovalChannel` timeout would have automatically resolved as "timeout", and the policy engine would have denied the transaction (fail-closed behavior).
:::

## Step 10: What the Telegram Message Looks Like

When the large transfer is triggered, your Telegram chat receives a message like this:

```
🔔 Wallet Approval Request

Action: transfer 15.0 SOL
Amount: 15.0 SOL
Recipient: 9aE476sH92Vz7DMPyq5WLPkrKWivxeuTKEFKd2sZZcde
Request ID: a1b2c3d4-...

[✅ Approve]  [❌ Reject]
```

The two inline buttons are:
- **Approve** -- The transaction proceeds, is signed, and submitted to the network
- **Reject** -- The transaction is denied and the agent receives `APPROVAL_REJECTED`

::: tip
The message includes the request ID for traceability and <Term id="idempotency" />. You can cross-reference this with the audit log to see the full transaction lifecycle.
:::

## Step 11: Check Transaction History After Approval

```typescript
  // Retrieve the last 10 entries from the audit log.
  const history = await wallet.getTransactionHistory(10);
  console.log(`\n=== Transaction History (${history.length} entries) ===`);
  for (const tx of history) {
    console.log(`[${tx.status}] ${tx.summary}`);
    console.log(`  Intent: ${tx.intentId} | Time: ${tx.timestamp}`);
    if (tx.txId) console.log(`  Tx ID: ${tx.txId}`);
    if (tx.error) console.log(`  Error: ${tx.error}`);
    console.log();
  }

  // Verify the SHA-256 hash chain integrity of the audit log.
  const integrity = await logger.verifyIntegrity(10);
  console.log("Audit integrity:", integrity.valid ? "VALID" : "BROKEN");

  // Stop the Telegram polling loop before exiting.
  polling = false;
}

main().catch(console.error);
```

## Adapting This Pattern for Other Channels

The `CallbackApprovalChannel` pattern used here is not Telegram-specific. You can swap the Telegram Bot API calls for any notification mechanism:

| Channel | `onApprovalRequest` | `waitForDecision` |
|---------|---------------------|-------------------|
| **Slack** | Post a message with Block Kit buttons | Listen for Slack interaction webhook |
| **Discord** | Send an embed with reaction buttons | Listen for Discord interaction events |
| **Email** | Send an email with approve/reject links | Poll a webhook endpoint or inbox |
| **In-app UI** | Push a WebSocket event to the frontend | Wait for a WebSocket response |
| **SMS** | Send an SMS via Twilio | Wait for an inbound SMS reply |

For HTTP-based flows, consider using the built-in `WebhookApprovalChannel` which handles HMAC signing, callback server setup, and SSRF protection out of the box.

## Common Mistakes

1. **Confusing chat ID with user ID.** In private chats, the chat ID and user ID are the same number. In group chats, they are different. The `chatId` tells the bot *where* to send messages, while `TELEGRAM_USER_ID` is used for self-approval prevention.

2. **Not starting a conversation with the bot first.** Telegram bots cannot send messages to users who have not interacted with them. You must open a chat with your bot and send `/start` before the bot can send you approval requests.

3. **Setting the approval threshold too low.** If you set the approval threshold to 0.001 SOL, every single transaction will require manual approval -- including the ones you want to be automatic. Choose a threshold that separates routine transactions from high-value ones. A good starting point is 5-10 SOL.

## Troubleshooting

### Bot does not receive messages

- Verify the bot token by visiting `https://api.telegram.org/botYOUR_TOKEN/getMe`
- Make sure you have started a conversation with the bot (send `/start`)
- Check that the chat ID is correct
- If you recently created the bot, wait a minute and try again -- Telegram sometimes takes a moment to propagate new bots

### Approval always times out

- Increase `defaultTimeout` if you need more time to respond
- Verify the polling loop is running (check for errors in the console)
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
- **Try `WebhookApprovalChannel`** instead of `CallbackApprovalChannel` for a more production-ready setup where an external service handles the Telegram integration and posts decisions back via HTTP webhook.
- **Build a Slack or Discord approval channel** by following the same `CallbackApprovalChannel` pattern with a different API.

## Next Steps

- [Policy Cookbook](/tutorials/policy-cookbook) -- Explore different approval threshold configurations
- [Production Deployment](/tutorials/production) -- Use SqliteStore for persistent audit logs
- [API Reference](/api/reference) -- Full `CallbackApprovalChannel` and `WebhookApprovalChannel` configuration reference
