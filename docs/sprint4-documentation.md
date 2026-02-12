# Sprint 4 — Telegram Bot + Approval Flow Documentation

**Project:** kova
**Sprint:** 4 — Telegram Bot + Approval Flow
**Date:** 2026-02-11

---

## Overview

Sprint 4 implements the real `TelegramApprovalBot` — a human-in-the-loop approval channel that sends approval requests to Telegram and waits for a human decision via inline keyboard buttons. After this sprint, transactions exceeding the `ApprovalGateRule` threshold trigger a Telegram message with Approve/Reject buttons, and the agent blocks until a human responds or timeout occurs.

---

## Architecture

### Approval Flow

```
AgentWallet.execute(intent)
      │
      ▼
PolicyEngine.evaluate(intent)
      │
      ├─ SpendingLimitRule, RateLimitRule, etc. → ALLOW
      │
      ▼
ApprovalGateRule.evaluate(intent, context)
      │
      ├─ amount <= threshold → ALLOW (no approval needed)
      ├─ amount > threshold, no channel → DENY (fail-closed)
      └─ amount > threshold, channel available:
            │
            ▼
      context.approval.requestApproval(request)
            │
            ▼
      TelegramApprovalBot.requestApproval()
            │
            ├─ sendMessage() → Telegram inline keyboard
            ├─ waitForResponse() → poll getUpdates
            │     ├─ User clicks Approve → "approved"
            │     ├─ User clicks Reject → "rejected"
            │     └─ Deadline expires → "timeout"
            │
            ▼
      ApprovalResult { decision, decidedBy, decidedAt }
            │
            ├─ "approved" → ALLOW → build → sign → broadcast
            ├─ "rejected" → DENY
            └─ "timeout" → DENY
```

### Key Properties

- **Blocking**: `requestApproval()` blocks until human responds or timeout
- **Fail-closed**: All error paths result in DENY
- **Serialized**: Wallet execute mutex prevents concurrent approvals
- **No external dependencies**: Uses raw `fetch` for Telegram Bot API

---

## API Reference

### TelegramApprovalBot

```typescript
import { TelegramApprovalBot } from "kova";

const bot = new TelegramApprovalBot({
  token: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",  // from BotFather
  chatId: "-1001234567890",                              // target chat
  defaultTimeout: 300_000,   // optional, default: 5 min
  allowedUserIds: [12345],   // optional, whitelist of Telegram user IDs
  pollInterval: 2000,        // optional, ms between polls
});
```

#### Configuration

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `token` | `string` | Yes | — | Telegram bot token from BotFather |
| `chatId` | `string` | Yes | — | Telegram chat ID for approval messages |
| `defaultTimeout` | `number` | No | `300_000` (5 min) | Timeout in ms when `expiresAt` not set |
| `allowedUserIds` | `number[]` | No | — | Whitelist of authorized Telegram user IDs |
| `pollInterval` | `number` | No | `2000` | Interval between `getUpdates` polls in ms |

#### `requestApproval(request: ApprovalRequest): Promise<ApprovalResult>`

Sends an approval request message to Telegram and blocks until a human responds.

**Flow:**
1. Format rich HTML message with transaction details
2. Send via `sendMessage` with inline keyboard (Approve/Reject buttons)
3. Poll `getUpdates` for matching `callback_query`
4. Validate user authorization (if `allowedUserIds` configured)
5. Acknowledge callback and remove inline keyboard
6. Return decision

**Returns:**
- `{ decision: "approved", decidedBy: "Alice", ... }` — Human approved
- `{ decision: "rejected", decidedBy: "Bob", ... }` — Human rejected
- `{ decision: "timeout", decidedBy: "system", ... }` — No response within deadline

---

## Integration with AgentWallet

```typescript
import { AgentWallet, PolicyBuilder, TelegramApprovalBot } from "kova";

const bot = new TelegramApprovalBot({
  token: process.env.TELEGRAM_BOT_TOKEN!,
  chatId: process.env.TELEGRAM_CHAT_ID!,
  allowedUserIds: [Number(process.env.TELEGRAM_ADMIN_ID)],
});

const policy = new PolicyBuilder("production-policy")
  .spendingLimit({ perTransaction: { amount: "100", token: "SOL" } })
  .approvalGate({ above: { amount: "10", token: "SOL" } })
  .build(store, bot);

const wallet = new AgentWallet({
  signer,
  chain,
  policy,
  store,
  approval: bot,
});

// Transaction below 10 SOL → auto-approved
await wallet.execute({
  type: "transfer",
  chain: "solana",
  params: { to: "...", amount: "5.0", token: "SOL" },
});

// Transaction above 10 SOL → Telegram approval required
await wallet.execute({
  type: "transfer",
  chain: "solana",
  params: { to: "...", amount: "50.0", token: "SOL" },
});
// → Sends Telegram message, blocks until human approves/rejects/timeout
```

---

## Telegram Message Format

The approval message is formatted in HTML with the following structure:

```
🔔 Approval Required

Amount: 50.0 SOL
USD Value: $7,500.00
To: 7xKX...AsU

Reason: Quarterly vendor payment
Agent: agent-42
Daily Budget: 20.0 / 100.0 SOL
Expires in 5 minutes
Request: a1b2c3d4-...

[✅ Approve] [❌ Reject]
```

All user-controlled fields are HTML-escaped to prevent message manipulation.

---

## ApprovalGateRule

The `ApprovalGateRule` bridges the policy engine and the approval channel:

```typescript
import { ApprovalGateRule } from "kova/policy/rules";

const rule = new ApprovalGateRule({
  above: { amount: "10", token: "SOL" },  // threshold
  timeout: 300_000,                        // optional, default 5 min
});
```

### Behavior

| Scenario | Result |
|----------|--------|
| Amount ≤ threshold | ALLOW (no approval needed) |
| Amount > threshold, channel available, approved | ALLOW |
| Amount > threshold, channel available, rejected | DENY |
| Amount > threshold, channel available, timeout | DENY |
| Amount > threshold, no channel configured | DENY (fail-closed) |
| Channel throws exception | DENY (fail-closed) |
| Different token than threshold | ALLOW (rule doesn't apply) |
| Intent with no amount (e.g., custom) | ALLOW (no amount to check) |

### Threshold Semantics

The `above` field uses strictly-greater-than semantics: a transaction of exactly the threshold amount is **allowed** without approval. Only amounts strictly greater than the threshold require approval.

---

## Security Features

### Applied in Sprint 4

1. **HTML escaping (S4-01)**: All user-controlled fields (`amount`, `token`, `target`, `reason`, `agentId`, `budgetContext`, `requestId`) are escaped before inclusion in the HTML message. Prevents approver deception via crafted transaction parameters.

2. **Bot token redaction (S4-05)**: Telegram API error responses are sanitized with `.replaceAll(this.token, "[REDACTED]")` before inclusion in error messages. Prevents bot token leakage in logs and error propagation.

3. **User name sanitization (S4-06)**: The Telegram user's `first_name` is sanitized with `.replace(/[<>&"']/g, "").slice(0, 64)` before use as `decidedBy` in approval results, audit logs, and status messages.

4. **Quote escaping (S4-10)**: `escapeHtml()` now escapes `"` → `&quot;` and `'` → `&#39;` in addition to `&`, `<`, `>`. Defense-in-depth against potential attribute injection.

### Design Decisions

5. **Fail-closed**: Every error path in the approval flow results in DENY — including Telegram API failures, network errors, and channel exceptions.

6. **Exact callback_data matching**: Uses strict equality (`===`) for `callback_data` comparison, preventing prefix-based attacks.

7. **Offset advancement**: `getUpdates` offset is always advanced for all updates, preventing replay of stale callback queries.

8. **allowedUserIds whitelist**: When configured, only listed Telegram user IDs can approve/reject. Unauthorized users receive a "not authorized" callback answer and the bot continues polling.

### Known Limitations (Deferred)

- `allowedUserIds` is optional — any user can respond if not set (S4-03)
- First-responder-wins with no quorum mechanism (S4-04)
- No maximum timeout enforcement (S4-08)
- Shared bot instances may consume each other's updates (S4-07)

---

## Test Summary

| Test File | Count | Focus |
|-----------|-------|-------|
| telegram.test.ts | 56 | Constructor, approval flow, formatting, timeout, security, error handling, edge cases |
| wallet.test.ts | 137 | Full pipeline including 14 approval integration tests |
| rules.test.ts | 102 | All 5 policy rules including 22 ApprovalGateRule tests |
| **Sprint 4 total** | **76 new** | |
| **Project total** | **612** | All passing |
