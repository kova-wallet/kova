# Human Approval

The human approval system provides a human-in-the-loop mechanism for high-value or sensitive transactions. When a policy rule requires approval, the SDK sends a request through an `ApprovalChannel` and blocks until a human responds or the request times out.

## ApprovalChannel Interface

```typescript
import type { ApprovalChannel, ApprovalRequest, ApprovalResult, ApprovalDecision } from "kova";
```

```typescript
interface ApprovalChannel {
  /** Name of this channel (e.g., "telegram", "slack") */
  readonly name: string;

  /** Send an approval request and wait for a decision */
  requestApproval(request: ApprovalRequest): Promise<ApprovalResult>;
}
```

## ApprovalRequest

The request object sent to the human approver:

```typescript
interface ApprovalRequest {
  /** Unique identifier for this approval request */
  id: string;
  /** What the agent wants to do (human-readable) */
  summary: string;
  /** Amount in human-readable format */
  amount: string;
  /** Token symbol */
  token: string;
  /** USD value (if available) */
  usdValue?: number;
  /** Recipient or target address */
  target: string;
  /** Agent's stated reason for this transaction */
  reason?: string;
  /** Agent identifier */
  agentId?: string;
  /** Current daily spend vs limit */
  budgetContext?: {
    dailySpent: string;
    dailyLimit: string;
    token: string;
  };
  /** When this request expires */
  expiresAt: number;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique request ID (used to match responses) |
| `summary` | `string` | Human-readable summary (e.g., "transfer 15 SOL") |
| `amount` | `string` | Transaction amount |
| `token` | `string` | Token symbol |
| `usdValue` | `number?` | USD equivalent (if price oracle is available) |
| `target` | `string` | Recipient address |
| `reason` | `string?` | Why the agent wants to do this (from intent metadata) |
| `agentId` | `string?` | Which agent initiated the request |
| `budgetContext` | `object?` | Current spending vs limits |
| `expiresAt` | `number` | Unix timestamp when the request expires |

## ApprovalResult and ApprovalDecision

```typescript
type ApprovalDecision = "approved" | "rejected" | "timeout";

interface ApprovalResult {
  requestId: string;
  decision: ApprovalDecision;
  decidedBy?: string;
  decidedAt: number;
}
```

| Decision | Meaning | Effect |
|----------|---------|--------|
| `approved` | Human approved the transaction | Policy returns `ALLOW` |
| `rejected` | Human rejected the transaction | Policy returns `DENY` |
| `timeout` | No response within the timeout period | Policy returns `DENY` |

## TelegramApprovalBot

The `TelegramApprovalBot` sends approval requests to a Telegram chat and waits for the human to tap an Approve or Reject button.

### Setup Guide

#### 1. Create a Telegram Bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` and follow the prompts
3. BotFather gives you a bot token like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`

#### 2. Get Your Chat ID

1. Start a conversation with your new bot (send any message)
2. Open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in your browser
3. Find the `"chat":{"id":` value in the JSON response -- this is your chat ID

::: tip
For group chats, add the bot to the group and send a message. The chat ID for groups is typically a negative number (e.g., `-1001234567890`).
:::

#### 3. Configure the Bot

```typescript
import { TelegramApprovalBot } from "kova";

const approval = new TelegramApprovalBot({
  token: process.env.TELEGRAM_BOT_TOKEN!,
  chatId: process.env.TELEGRAM_CHAT_ID!,
  defaultTimeout: 300_000,       // 5 minutes
  allowedUserIds: [123456789],   // Only this user can approve/reject
  pollInterval: 2_000,           // Check for responses every 2 seconds
});
```

### TelegramApprovalBotConfig

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `token` | `string` | Yes | -- | Bot token from BotFather |
| `chatId` | `string` | Yes | -- | Telegram chat ID to send requests to |
| `defaultTimeout` | `number` | No | `300,000` (5 min) | Default timeout in milliseconds |
| `allowedUserIds` | `number[]` | No | `undefined` (any user) | Whitelist of Telegram user IDs allowed to respond |
| `pollInterval` | `number` | No | `2,000` | Milliseconds between getUpdates polls |

### How Polling Works

The `TelegramApprovalBot` uses Telegram's long-polling mechanism:

1. **Send message**: Posts an HTML-formatted message to the chat with inline keyboard buttons (Approve / Reject)
2. **Poll for updates**: Calls `getUpdates` with a long-poll timeout of 2 seconds
3. **Match callback**: When a user taps a button, Telegram sends a `callback_query` update. The bot matches it to the pending request via the callback data
4. **Validate user**: If `allowedUserIds` is configured, only whitelisted users can respond. Unauthorized button taps are acknowledged with an error message but ignored
5. **Return result**: The bot answers the callback query, removes the inline keyboard, and returns the `ApprovalResult`

### Approval Flow Diagram

```
Agent                  SDK                  Telegram
  │                      │                     │
  │  execute(intent)     │                     │
  │─────────────────────►│                     │
  │                      │                     │
  │                      │  sendMessage         │
  │                      │  (with Approve/      │
  │                      │   Reject buttons)    │
  │                      │────────────────────►│
  │                      │                     │
  │                      │     (waiting...)     │  Human sees message
  │                      │                     │
  │                      │  getUpdates (poll)   │
  │                      │────────────────────►│
  │                      │                     │  Human taps "Approve"
  │                      │  callback_query     │
  │                      │◄────────────────────│
  │                      │                     │
  │                      │  answerCallbackQuery │
  │                      │────────────────────►│
  │                      │                     │
  │  TransactionResult   │                     │
  │◄─────────────────────│                     │
```

### allowedUserIds Security

The `allowedUserIds` field restricts who can respond to approval requests. When set:

- Only Telegram users whose user ID is in the list can approve or reject
- Other users who tap the buttons see an error message: "You are not authorized to respond to this request"
- The bot continues polling until an authorized user responds or the timeout expires

::: danger
If `allowedUserIds` is not configured, **any user** who has access to the chat can approve or reject transactions. In a group chat, this means anyone in the group can approve. Always set `allowedUserIds` in production.
:::

### Token Redaction

The `TelegramApprovalBot` automatically redacts the bot token from error messages. If a Telegram API call fails, the error message replaces the token with `[REDACTED]` to prevent accidental exposure in logs.

## Implementing a Custom ApprovalChannel

You can implement approval via Slack, email, SMS, or any other channel:

```typescript
import type {
  ApprovalChannel,
  ApprovalRequest,
  ApprovalResult,
} from "kova";

export class SlackApprovalChannel implements ApprovalChannel {
  readonly name = "slack";
  private readonly webhookUrl: string;
  private readonly channelId: string;

  constructor(config: { webhookUrl: string; channelId: string }) {
    this.webhookUrl = config.webhookUrl;
    this.channelId = config.channelId;
  }

  async requestApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    // 1. Post a message with interactive buttons to Slack
    const message = this.formatMessage(request);
    const messageId = await this.postMessage(message);

    // 2. Wait for a button click via Slack interactivity webhook
    const decision = await this.waitForResponse(
      request.id,
      messageId,
      request.expiresAt - Date.now(),
    );

    return {
      requestId: request.id,
      decision,
      decidedAt: Date.now(),
    };
  }

  private formatMessage(request: ApprovalRequest): object {
    return {
      channel: this.channelId,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Approval Required*\n${request.summary}\nAmount: ${request.amount} ${request.token}\nTo: \`${request.target}\``,
          },
        },
        {
          type: "actions",
          elements: [
            { type: "button", text: { type: "plain_text", text: "Approve" }, action_id: `approve:${request.id}` },
            { type: "button", text: { type: "plain_text", text: "Reject" }, action_id: `reject:${request.id}` },
          ],
        },
      ],
    };
  }

  private async postMessage(message: object): Promise<string> {
    // Post to Slack API
    const response = await fetch(this.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    const data = await response.json() as { ts: string };
    return data.ts;
  }

  private async waitForResponse(
    requestId: string,
    messageId: string,
    timeoutMs: number,
  ): Promise<"approved" | "rejected" | "timeout"> {
    // Implement polling or webhook listener for Slack interactivity
    // This is a simplified example
    return "timeout";
  }
}
```

### Using a Custom Channel

```typescript
import { PolicyEngine, ApprovalGateRule, MemoryStore } from "kova";
import { SlackApprovalChannel } from "./slack-approval";

const approval = new SlackApprovalChannel({
  webhookUrl: process.env.SLACK_WEBHOOK_URL!,
  channelId: "C0123456789",
});

const engine = new PolicyEngine(
  [
    new ApprovalGateRule({
      above: { amount: "10", token: "SOL" },
      timeout: 300_000,
    }),
  ],
  new MemoryStore(),
  approval,
);
```
