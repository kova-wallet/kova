# Tipping Bot

---

## What You'll Build

In this tutorial, you'll build a **Telegram tipping bot** that lets community members send SOL tips to each other (e.g., `/tip @user 0.05`). The bot is backed by a kova wallet with tight policy constraints. By the end you will have:

- A Telegram bot that parses tip commands and executes SOL transfers
- Micro-payment policies (0.1 SOL max per tip, 2 SOL daily cap)
- A custom **Per-Recipient Daily Cap** rule that prevents one user from draining the bot to a single address
- Rate limiting to prevent abuse

This is a different pattern from the other tutorials: the agent is **user-triggered** (not autonomous), but still **policy-constrained**. The kova wallet ensures the bot cannot be abused even if users spam tip commands.

---

## Prerequisites

| Tool | Minimum Version | Check with |
|------|----------------|------------|
| **Node.js** | 18.0 or later | `node --version` |
| **npm** | 9.0 or later | `npm --version` |
| **TypeScript** | 5.0 or later | `npx tsc --version` |
| **Telegram Bot Token** | — | Create via [@BotFather](https://t.me/BotFather) |

You should have completed the [Your First Agent Wallet](/tutorials/first-wallet) tutorial.

---

## Architecture

```
  Telegram Chat                   Your Server
  ─────────────                   ───────────
  User: /tip @alice 0.05 SOL
           │
           │  Telegram Bot API (polling)
           ▼
  ┌────────────────────────────────────────────┐
  │            Tip Bot                          │
  │                                             │
  │  1. Parse command: recipient, amount        │
  │  2. Resolve @username → Solana address      │
  │  3. Build transfer intent                   │
  │  4. Submit to wallet.execute()              │
  │  5. Reply with result                       │
  └──────────────────┬─────────────────────────┘
                     │
                     ▼
  ┌────────────────────────────────────────────┐
  │            AgentWallet                      │
  │                                             │
  │  Policy Engine:                             │
  │    ✓ RateLimitRule — max 30 tips/min        │
  │    ✓ PerRecipientCapRule — max 0.5 SOL/day  │
  │    ✓ SpendingLimitRule — max 0.1 per tip    │
  │                                             │
  │  If allowed → sign → broadcast → confirm    │
  └────────────────────────────────────────────┘
```

---

## Step 1: Build a Custom Per-Recipient Daily Cap Rule

The built-in `SpendingLimitRule` tracks total spending across all recipients. For a tipping bot, we also need to limit how much can be sent to a **single** recipient per day. This prevents one user from convincing others to drain the bot's balance to their address.

```typescript
import type {
  PolicyRule,
  PolicyDecision,
  PolicyContext,
  TransactionIntent,
} from "kova";

/**
 * PerRecipientCapRule — Limits how much can be sent to any single
 * recipient address within a 24-hour window.
 *
 * Uses the store to track per-recipient spending counters with TTL.
 */
export class PerRecipientCapRule implements PolicyRule {
  readonly name = "per-recipient-cap";
  private readonly maxPerRecipientDaily: number;
  private readonly token: string;

  constructor(config: { maxPerRecipientDaily: string; token: string }) {
    this.maxPerRecipientDaily = parseFloat(config.maxPerRecipientDaily);
    this.token = config.token.toUpperCase();
  }

  async evaluate(
    intent: TransactionIntent,
    context: PolicyContext,
  ): Promise<PolicyDecision> {
    // Only apply to transfer intents.
    if (intent.type !== "transfer") {
      return { decision: "ALLOW" };
    }

    const params = intent.params as { to: string; amount: string; token: string };

    // Only track the configured token.
    if (params.token.toUpperCase() !== this.token) {
      return { decision: "ALLOW" };
    }

    const amount = parseFloat(params.amount);
    const recipient = params.to;

    // Build a store key unique to this recipient and day.
    // The TTL handles expiration -- no manual cleanup needed.
    const key = `tip:recipient:${recipient}`;

    // Check current total for this recipient.
    const currentStr = await context.store.get(key);
    const current = currentStr ? parseFloat(currentStr) : 0;

    if (current + amount > this.maxPerRecipientDaily) {
      return {
        decision: "DENY",
        rule: this.name,
        reason: `Daily cap for recipient ${recipient.slice(0, 8)}... exceeded: ` +
          `${current.toFixed(4)} + ${amount} > ${this.maxPerRecipientDaily} ${this.token}`,
      };
    }

    // Atomically increment the counter. TTL = 24 hours.
    // This uses the same atomic pattern as SpendingLimitRule.
    const newTotal = await context.store.increment(key, amount);

    // Ensure the key has a TTL (24 hours). If the key is new,
    // set it with the incremented value and TTL.
    if (current === 0) {
      await context.store.set(key, String(newTotal), 86_400);
    }

    // Double-check after increment (handles concurrent tips).
    if (newTotal > this.maxPerRecipientDaily) {
      // Rollback the increment.
      await context.store.increment(key, -amount);
      return {
        decision: "DENY",
        rule: this.name,
        reason: `Daily cap for recipient ${recipient.slice(0, 8)}... would be exceeded`,
      };
    }

    return { decision: "ALLOW" };
  }
}
```

::: tip WHY NOT USE ALLOWLIST FOR THIS?
The `AllowlistRule` checks whether an address is permitted at all. The `PerRecipientCapRule` checks how much has been sent to that address **today**. A recipient can be on the allowlist but still hit their daily cap. These are complementary controls.
:::

---

## Step 2: Set Up the Wallet

```typescript
import {
  AgentWallet,
  LocalSigner,
  SqliteStore,
  SolanaAdapter,
  PolicyEngine,
  SpendingLimitRule,
  RateLimitRule,
  AuditLogger,
} from "kova";
import { Keypair } from "@solana/web3.js";

// ── Bot wallet setup ────────────────────────────────────────────────────────

const store = new SqliteStore({ path: "./tipbot.db" });

const chain = new SolanaAdapter({
  rpcUrl: "https://api.devnet.solana.com",
  commitment: "confirmed",
});

// In production, load this from an encrypted secrets store.
const keypair = Keypair.generate();
const signer = new LocalSigner(keypair);

// ── Policy: tight limits for micro-payments ─────────────────────────────────

const rules = [
  // 1. Rate limit: prevent spam. 30 tips/min handles a busy chat.
  new RateLimitRule({
    maxTransactionsPerMinute: 30,
    maxTransactionsPerHour: 200,
  }),

  // 2. Per-recipient cap: max 0.5 SOL to any single address per day.
  // Prevents one user from draining the bot.
  new PerRecipientCapRule({
    maxPerRecipientDaily: "0.5",
    token: "SOL",
  }),

  // 3. Spending limits: 0.1 SOL max per tip, 2 SOL daily total.
  new SpendingLimitRule({
    perTransaction: { amount: "0.1", token: "SOL" },
    daily: { amount: "2", token: "SOL" },
  }),
];

const engine = new PolicyEngine(rules, store);
const logger = new AuditLogger(store);

const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  logger,
});
```

---

## Step 3: Build the Telegram Bot

The bot polls for messages, parses `/tip` commands, and executes transfers through the wallet.

```typescript
// ── Telegram bot types ──────────────────────────────────────────────────────

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    from?: { id: number; username?: string; first_name: string };
    text?: string;
  };
}

// ── Address registry ────────────────────────────────────────────────────────
// Maps Telegram usernames to Solana addresses.
// In production, store this in a database and let users register with /register.

const addressBook = new Map<string, string>();

/** Register a user's Solana address */
function registerAddress(username: string, address: string) {
  addressBook.set(username.toLowerCase(), address);
}

/** Look up a user's Solana address */
function resolveAddress(username: string): string | null {
  return addressBook.get(username.toLowerCase()) ?? null;
}

// ── Bot configuration ───────────────────────────────────────────────────────

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ── Telegram API helpers ────────────────────────────────────────────────────

async function sendMessage(chatId: number, text: string) {
  await fetch(`${API_BASE}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
    }),
  });
}

async function getUpdates(offset: number): Promise<TelegramUpdate[]> {
  const res = await fetch(
    `${API_BASE}/getUpdates?offset=${offset}&timeout=30`,
  );
  const data = await res.json() as { ok: boolean; result: TelegramUpdate[] };
  return data.ok ? data.result : [];
}
```

---

## Step 4: Parse and Execute Tip Commands

```typescript
/** Parse a /tip command. Returns null if the message is not a valid tip. */
function parseTipCommand(text: string): { username: string; amount: string } | null {
  // Expected formats:
  //   /tip @alice 0.05
  //   /tip @alice 0.05 SOL
  const match = text.match(/^\/tip\s+@(\w+)\s+([\d.]+)(?:\s+SOL)?$/i);
  if (!match) return null;
  return { username: match[1], amount: match[2] };
}

/** Handle a single tip command */
async function handleTip(
  chatId: number,
  fromUser: string,
  tip: { username: string; amount: string },
) {
  // Resolve the recipient's Solana address.
  const recipientAddress = resolveAddress(tip.username);
  if (!recipientAddress) {
    await sendMessage(
      chatId,
      `@${tip.username} has not registered a Solana address.\n` +
      `They can register with: <code>/register &lt;solana-address&gt;</code>`,
    );
    return;
  }

  // Validate the amount (basic sanity check before hitting the policy engine).
  const amount = parseFloat(tip.amount);
  if (isNaN(amount) || amount <= 0) {
    await sendMessage(chatId, "Invalid amount. Usage: <code>/tip @user 0.05</code>");
    return;
  }

  // Execute the transfer through the kova wallet.
  // The policy engine handles ALL safety checks:
  //   - Is the amount under 0.1 SOL? (SpendingLimitRule)
  //   - Has the daily total exceeded 2 SOL? (SpendingLimitRule)
  //   - Has this recipient received more than 0.5 SOL today? (PerRecipientCapRule)
  //   - Has the bot hit the rate limit? (RateLimitRule)
  const result = await wallet.execute({
    type: "transfer",
    chain: "solana",
    params: {
      to: recipientAddress,
      amount: tip.amount,
      token: "SOL",
    },
    metadata: {
      agentId: "tipbot",
      reason: `Tip from @${fromUser} to @${tip.username}`,
    },
  });

  // Reply based on result.
  if (result.status === "confirmed") {
    await sendMessage(
      chatId,
      `Sent ${tip.amount} SOL to @${tip.username}\n` +
      `<a href="https://explorer.solana.com/tx/${result.txId}?cluster=devnet">View transaction</a>`,
    );
  } else if (result.status === "denied") {
    const reason = result.error?.message ?? "Unknown reason";
    await sendMessage(chatId, `Tip denied: ${reason}`);
  } else {
    await sendMessage(chatId, `Tip failed: ${result.error?.message ?? "Unknown error"}`);
  }
}

/** Handle the /register command */
async function handleRegister(
  chatId: number,
  username: string,
  text: string,
) {
  const match = text.match(/^\/register\s+([A-Za-z0-9]{32,44})$/);
  if (!match) {
    await sendMessage(chatId, "Usage: <code>/register &lt;solana-address&gt;</code>");
    return;
  }

  registerAddress(username, match[1]);
  await sendMessage(chatId, `Registered @${username} → <code>${match[1]}</code>`);
}

/** Handle the /balance command */
async function handleBalance(chatId: number) {
  const balance = await wallet.getBalance("SOL");
  const address = await wallet.getAddress();
  await sendMessage(
    chatId,
    `Bot balance: <b>${balance.amount} SOL</b>\nAddress: <code>${address}</code>`,
  );
}
```

---

## Step 5: Run the Bot Loop

```typescript
async function main() {
  const address = await wallet.getAddress();
  console.log("Tip bot wallet:", address);
  console.log("Listening for Telegram messages...\n");

  let offset = 0;

  while (true) {
    try {
      const updates = await getUpdates(offset);

      for (const update of updates) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text || !msg.from) continue;

        const text = msg.text.trim();
        const username = msg.from.username ?? msg.from.first_name;
        const chatId = msg.chat.id;

        // Route commands.
        if (text.startsWith("/tip ")) {
          const tip = parseTipCommand(text);
          if (tip) {
            await handleTip(chatId, username, tip);
          } else {
            await sendMessage(chatId, "Usage: <code>/tip @user 0.05</code>");
          }
        } else if (text.startsWith("/register ")) {
          await handleRegister(chatId, username, text);
        } else if (text === "/balance") {
          await handleBalance(chatId);
        } else if (text === "/help") {
          await sendMessage(
            chatId,
            "<b>Tip Bot Commands</b>\n\n" +
            "<code>/tip @user 0.05</code> — Send SOL to a registered user\n" +
            "<code>/register &lt;address&gt;</code> — Register your Solana address\n" +
            "<code>/balance</code> — Check the bot's SOL balance\n" +
            "<code>/help</code> — Show this message",
          );
        }
      }
    } catch (err) {
      console.error("Polling error:", err instanceof Error ? err.message : err);
      // Wait before retrying on transient errors.
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// Graceful shutdown.
process.on("SIGTERM", () => { store.close(); process.exit(0); });
process.on("SIGINT", () => { store.close(); process.exit(0); });

main().catch(console.error);
```

---

## Step 6: Test Locally

```bash
# Set your Telegram bot token.
export TELEGRAM_BOT_TOKEN="your-bot-token-from-botfather"

# Run the bot.
npx ts-node tipbot.ts
```

In your Telegram group:

```
You:   /register 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
Bot:   Registered @you → 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU

Alice: /register 9AbcDeFgHiJkLmNoPqRsTuVwXyZ123456789abcde
Bot:   Registered @alice → 9AbcDeFgHiJkLmNoPqRsTuVwXyZ123456789abcde

You:   /tip @alice 0.05
Bot:   Sent 0.05 SOL to @alice
       View transaction (link)

You:   /tip @alice 0.2
Bot:   Tip denied: Per-transaction limit exceeded: 0.2 SOL > 0.1 SOL

You:   /balance
Bot:   Bot balance: 1.95 SOL
       Address: BotAddr123...
```

---

## Policy Behavior Summary

| Action | Policy Result | Why |
|--------|--------------|-----|
| `/tip @alice 0.05` | Allowed | Under all limits |
| `/tip @alice 0.2` | Denied | Exceeds 0.1 SOL per-tip limit |
| `/tip @alice 0.05` (6th time to alice today) | Denied | Exceeds 0.5 SOL per-recipient daily cap |
| 31 tips in one minute | 31st denied | Exceeds 30/min rate limit |
| Tips totaling 2.01 SOL in one day | Denied | Exceeds 2 SOL daily spending limit |

Every denial is logged in the audit trail, including who triggered it and why.

---

## Production Considerations

### Persistent Address Book

Replace the in-memory `Map` with the store:

```typescript
// Store registrations in the kova store for persistence.
async function registerAddress(username: string, address: string) {
  await store.set(`tipbot:addr:${username.toLowerCase()}`, address);
}

async function resolveAddress(username: string): Promise<string | null> {
  return store.get(`tipbot:addr:${username.toLowerCase()}`);
}
```

### Funding the Bot

The bot needs SOL to send tips. Options:
- **Manual funding**: Transfer SOL to the bot's address from a funded wallet
- **Auto-funding**: Set up a separate process that tops up the bot when balance drops below a threshold
- **User deposits**: Let users "deposit" SOL to the bot (requires additional tracking)

### Multiple Tokens

To support USDC tips alongside SOL, add a second `SpendingLimitRule` and `PerRecipientCapRule` for USDC, and parse the token from the command:

```
/tip @alice 5 USDC
```

### Webhook vs Polling

The bot above uses long-polling for simplicity. For production, switch to webhooks:

```typescript
// Express webhook handler instead of polling loop.
app.post("/telegram/webhook", async (req, res) => {
  const update = req.body as TelegramUpdate;
  // ... handle update ...
  res.sendStatus(200);
});
```

---

## See Also

- [Your First Agent Wallet](/tutorials/first-wallet) -- basic wallet setup
- [Telegram Approval](/tutorials/telegram-approval) -- human-in-the-loop approval via Telegram
- [Custom Policy Rule](/tutorials/custom-policy-rule) -- building custom rules like `PerRecipientCapRule`
- [Spending Limit](/guide/rules/spending-limit) -- per-transaction and daily spending caps
- [Rate Limit](/guide/rules/rate-limit) -- transaction frequency limits
