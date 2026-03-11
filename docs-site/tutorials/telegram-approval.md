# Custom Approval Channels

::: info What you'll learn
- How kova's approval system works and when to use each built-in channel
- How to use `CallbackApprovalChannel` to integrate any notification system
- How to use `WebhookApprovalChannel` for HTTP-based approval flows
- How to build a complete Telegram approval integration as an example
:::

kova ships two approval channels that cover the vast majority of <Term id="human-in-the-loop" /> use cases:

| Channel | Best for | You provide |
|---------|----------|-------------|
| **`CallbackApprovalChannel`** | Custom integrations (Slack, Discord, Telegram, SMS, in-app UI) | Two callbacks: `onApprovalRequest` and `waitForDecision` |
| **`WebhookApprovalChannel`** | HTTP-based services that can receive and POST back decisions | A webhook URL and an HMAC shared secret |

Both channels implement the `ApprovalChannel` interface. Security guarantees (TOCTOU intent hashing, fail-closed timeout, self-approval prevention) are handled by `ApprovalGateRule` in the policy engine, not by the channel itself. The channel is purely a notification and decision-collection transport.

## CallbackApprovalChannel

`CallbackApprovalChannel` is the most flexible option. You provide two callbacks and the channel handles timeout racing for you.

### Configuration

```typescript
import { CallbackApprovalChannel } from "@kova/wallet";
import type { ApprovalRequest, ApprovalResult } from "@kova/wallet";

const channel = new CallbackApprovalChannel({
  // Optional name for audit logs (defaults to "callback").
  name: "my-channel",

  // Called when a transaction needs human approval.
  // Use this to send a notification through whatever system you prefer.
  // If this throws, the transaction is DENIED (fail-closed).
  onApprovalRequest: async (request: ApprovalRequest) => {
    // Send a notification to your system of choice.
    // The request contains: id, summary, amount, token, target, reason,
    // intentHash, expiresAt, and optional budgetContext.
    await sendNotification(request);
  },

  // Called to collect the human's decision.
  // Must return a Promise that resolves with an ApprovalResult.
  // The channel races this against the timeout automatically.
  // If this throws, the transaction is DENIED (fail-closed).
  waitForDecision: (request: ApprovalRequest) => {
    return new Promise<ApprovalResult>((resolve) => {
      // Store the resolver so you can call it when the human responds.
      pendingDecisions.set(request.id, resolve);
    });
  },

  // Auto-deny if no response within this duration (default: 300,000 ms / 5 minutes).
  defaultTimeout: 300_000,
});
```

### How it works

1. The policy engine calls `channel.requestApproval(request)`.
2. The channel calls your `onApprovalRequest` callback to notify a human.
3. The channel races your `waitForDecision` callback against the timeout.
4. If `waitForDecision` resolves first, that result is returned to the policy engine.
5. If the timeout fires first, the channel returns `{ decision: "timeout" }`, which the policy engine treats as DENY.

### ApprovalRequest fields

Your callbacks receive an `ApprovalRequest` with the following fields:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique request identifier |
| `summary` | `string` | Human-readable description of the action |
| `amount` | `string` | Amount in human-readable format |
| `token` | `string` | Token symbol (e.g., "SOL") |
| `target` | `string` | Recipient or target address |
| `intentHash` | `string` | SHA-256 hash binding the approval to the exact transaction |
| `expiresAt` | `number` | Timestamp when this request expires |
| `reason` | `string?` | Agent's stated reason for the transaction |
| `usdValue` | `number?` | USD value if available |
| `budgetContext` | `object?` | Current daily spend vs. limit |
| `requestedByUserId` | `string?` | User who initiated the request (for self-approval prevention) |

### ApprovalResult fields

Your `waitForDecision` callback must resolve with an `ApprovalResult`:

```typescript
{
  requestId: string;       // Must match the request's id
  decision: "approved" | "rejected" | "timeout";
  decidedBy?: string;      // Who made the decision (for audit trail)
  decidedAt: number;       // Timestamp of the decision
  intentHash?: string;     // Echo back the intent hash for TOCTOU verification
}
```

The three decision values map to policy outcomes:
- `"approved"` -- transaction proceeds
- `"rejected"` -- explicitly denied by a human
- `"timeout"` -- no response within the timeout window (also treated as DENY)

## WebhookApprovalChannel

`WebhookApprovalChannel` is designed for HTTP-based approval flows where an external service handles the human interaction and posts the decision back via HTTP.

### Configuration

```typescript
import { WebhookApprovalChannel } from "@kova/wallet";

const channel = new WebhookApprovalChannel({
  // URL to POST approval requests to. Must be HTTPS in production.
  // HTTP is allowed only for localhost.
  webhookUrl: "https://your-approval-service.example.com/approve",

  // Shared secret for HMAC-SHA256 signing (minimum 16 characters).
  // Used to sign outbound requests and verify inbound callbacks.
  hmacSecret: process.env.APPROVAL_HMAC_SECRET!,

  // Port for the callback HTTP server (default: 0 = OS-assigned).
  callbackPort: 0,

  // Path for incoming decision callbacks (default: "/approval/callback").
  callbackPath: "/approval/callback",

  // Auto-deny timeout (default: 300,000 ms / 5 minutes).
  defaultTimeout: 300_000,

  // Optional name for audit logs (defaults to "webhook").
  name: "webhook",
});

// Start the callback server before using the channel.
await channel.start();
```

### How it works

1. **Outbound request**: The channel POSTs the `ApprovalRequest` as JSON to your `webhookUrl`, with an `X-Kova-Signature` header (HMAC-SHA256 of the body). The payload includes a `callbackUrl` field so the receiver knows where to POST the decision.
2. **External processing**: Your service presents the request to a human approver through whatever UI you prefer.
3. **Inbound callback**: Your service POSTs the decision back to the callback URL with an `X-Kova-Signature` header for verification.

### Callback POST body

The external service must POST a JSON body with these fields:

```json
{
  "requestId": "the-original-request-id",
  "decision": "approved",
  "decidedBy": "alice@example.com",
  "intentHash": "the-original-intent-hash"
}
```

The `decision` field must be `"approved"`, `"rejected"`, or `"timeout"`.

### Security features

- **HMAC-SHA256 signatures** on both outbound and inbound requests prevent tampering.
- **SSRF protection**: The channel validates that the webhook URL does not resolve to a private or reserved IP address.
- **HTTPS required**: Non-localhost URLs must use HTTPS.
- **Timing-safe comparison**: Signature verification uses constant-time comparison to prevent timing attacks.

### Cleanup

When shutting down, call `destroy()` to close the callback server and resolve any pending requests as timeout:

```typescript
await channel.destroy();
```

## Wiring an Approval Channel into a Policy

Both channel types are used the same way. Pass the channel to `AgentWallet` and configure an approval gate in your policy:

```typescript
import {
  AgentWallet,
  LocalSigner,
  MemoryStore,
  SolanaAdapter,
  Policy,
} from "@kova/wallet";

// Build a policy with an approval gate.
const policy = Policy.create("approval-demo")
  .spendingLimit({
    perTransaction: { amount: "50.0", token: "SOL" },
    daily: { amount: "200.0", token: "SOL" },
  })
  .requireApproval({
    above: { amount: "5.0", token: "SOL" },  // Transactions >= 5 SOL need approval
    timeout: 300_000,
  })
  .build();

const store = new MemoryStore({ dangerouslyAllowInProduction: true });

const wallet = new AgentWallet({
  signer: new LocalSigner(keypair, { network: "devnet" }),
  chain: new SolanaAdapter({ rpcUrl: "https://api.devnet.solana.com", network: "devnet" }),
  policy,
  store,
  approval: channel,
  dangerouslyDisableAuth: true,  // Dev-only; use authToken in production
});
```

With this setup:
- Transactions under 5 SOL proceed automatically.
- Transactions of 5 SOL or more trigger an approval request through your channel.
- If no human responds within 5 minutes, the transaction is denied (<Term id="fail-closed" />).

## Example: Telegram Integration with CallbackApprovalChannel

This example shows how to build a complete Telegram approval flow using `CallbackApprovalChannel` and the Telegram Bot API. The same pattern applies to Slack, Discord, or any other messaging platform.

### Prerequisites

- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Your Telegram chat ID (send a message to your bot, then check `https://api.telegram.org/botYOUR_TOKEN/getUpdates`)

### Environment variables

```bash
export TELEGRAM_BOT_TOKEN="7123456789:AAF1xxxxxxxxxxxxxxxxxxxxxxxxxxx"
export TELEGRAM_CHAT_ID="123456789"
```

::: danger
Never commit bot tokens or secrets to source control.
:::

### Building the channel

```typescript
import { CallbackApprovalChannel } from "@kova/wallet";
import type { ApprovalRequest, ApprovalResult } from "@kova/wallet";

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

// Track pending approvals: maps request ID to its resolver function.
const pendingApprovals = new Map<string, (result: ApprovalResult) => void>();

const approvalChannel = new CallbackApprovalChannel({
  name: "telegram",

  // Send a Telegram message with Approve/Reject inline buttons.
  onApprovalRequest: async (request: ApprovalRequest) => {
    const text =
      `*Approval Request*\n\n` +
      `*Action:* ${request.summary}\n` +
      `*Amount:* ${request.amount} ${request.token}\n` +
      `*Recipient:* \`${request.target}\`\n` +
      `*Request ID:* \`${request.id}\`\n` +
      (request.reason ? `*Reason:* ${request.reason}\n` : "");

    const keyboard = {
      inline_keyboard: [[
        { text: "Approve", callback_data: `approve:${request.id}` },
        { text: "Reject", callback_data: `reject:${request.id}` },
      ]],
    };

    const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: "Markdown",
        reply_markup: keyboard,
      }),
    });

    if (!response.ok) {
      throw new Error(`Telegram sendMessage failed: ${response.status}`);
    }
  },

  // Store the resolver; the polling loop below will call it when a button is clicked.
  waitForDecision: (request: ApprovalRequest) => {
    return new Promise<ApprovalResult>((resolve) => {
      pendingApprovals.set(request.id, resolve);
    });
  },

  defaultTimeout: 300_000,
});
```

### Polling for button clicks

Telegram uses a polling model. This background loop checks for button clicks and resolves the corresponding pending approval:

```typescript
let lastUpdateId = 0;
let polling = true;

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

        // Parse "approve:<requestId>" or "reject:<requestId>"
        const [action, requestId] = query.data.split(":");
        if (!requestId) continue;

        const resolver = pendingApprovals.get(requestId);
        if (!resolver) continue;

        pendingApprovals.delete(requestId);

        resolver({
          requestId,
          decision: action === "approve" ? "approved" : "rejected",
          decidedBy: query.from.first_name || String(query.from.id),
          decidedAt: Date.now(),
        });

        // Acknowledge the button click in Telegram.
        await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            callback_query_id: query.id,
            text: action === "approve" ? "Approved." : "Rejected.",
          }),
        });
      }
    } catch (err) {
      console.error("Telegram polling error:", err);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// Start polling in the background.
pollTelegram();
```

Then pass `approvalChannel` to `AgentWallet` as shown in the wiring section above.

### Adapting for other platforms

The same `CallbackApprovalChannel` pattern works for any notification system. Replace the Telegram API calls with your platform of choice:

| Platform | `onApprovalRequest` | `waitForDecision` |
|----------|---------------------|-------------------|
| **Slack** | Post a message with Block Kit buttons | Listen for Slack interaction webhook |
| **Discord** | Send an embed with reaction buttons | Listen for Discord interaction events |
| **Email** | Send an email with approve/reject links | Poll a webhook endpoint or inbox |
| **In-app UI** | Push a WebSocket event to the frontend | Wait for a WebSocket response |
| **SMS** | Send an SMS via Twilio | Wait for an inbound SMS reply |

For HTTP-based flows where an external service handles the UI, `WebhookApprovalChannel` is simpler since it manages HMAC signing, the callback server, and SSRF protection automatically.

## Common Mistakes

1. **Forgetting to call `start()` on WebhookApprovalChannel.** The callback server must be started before any approval requests are processed. If you skip this, `requestApproval()` will throw.

2. **Using a weak HMAC secret.** `WebhookApprovalChannel` requires a secret of at least 16 characters. Use a cryptographically random string in production.

3. **Setting the approval threshold too low.** If the threshold is near zero, every transaction triggers manual approval and the agent becomes unusable. Choose a threshold that separates routine transactions from high-value ones.

4. **Not handling errors in callbacks.** If `onApprovalRequest` or `waitForDecision` throws, the transaction is denied (fail-closed). Make sure your notification code handles transient errors gracefully.

## Next Steps

- [Policy Cookbook](/tutorials/policy-cookbook) -- Explore different approval threshold configurations
- [Production Deployment](/tutorials/production) -- Use SqliteStore for persistent audit logs
- [API Reference](/api/reference) -- Full `CallbackApprovalChannel` and `WebhookApprovalChannel` configuration reference
