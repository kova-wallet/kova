# Sprint 4 — Results

**Project:** kova
**Sprint:** 4 — Telegram Bot + Approval Flow
**Date:** 2026-02-11

---

## Summary

Sprint 4 implements the real TelegramApprovalBot using the raw Telegram Bot API via `fetch` (no external dependencies). Transactions exceeding the `ApprovalGateRule` threshold now trigger a Telegram message with Approve/Reject inline buttons. The agent blocks until a human responds or timeout occurs, then proceeds or denies accordingly. All code compiles cleanly and all 612 tests pass.

### Deliverables

| Deliverable | Status |
|------------|--------|
| TelegramApprovalBot (real implementation) | Implemented |
| Inline keyboard Approve/Reject buttons | Implemented |
| Long-poll getUpdates for callback_query | Implemented |
| User authorization via allowedUserIds | Implemented |
| Rich HTML message formatting | Implemented |
| Fail-closed error handling | Implemented |
| Wallet approval integration tests | Implemented |
| Security audit | 14 findings (0C, 2H, 5M, 4L, 3I) |
| QA testing | 612 tests, 76 new, all passing |
| Security fixes applied | 4 fixes from audit |

---

## Security Audit Findings (14 total)

### Fixes Applied in Sprint 4

| ID | Severity | Finding | Fix |
|----|----------|---------|-----|
| S4-01 | HIGH | Incomplete HTML escaping — `amount`, `token`, `target`, `budgetContext`, `requestId` not escaped in Telegram message | Apply `escapeHtml()` to all user-controlled fields in `formatApprovalMessage()` |
| S4-05 | MEDIUM | Bot token may leak in Telegram API error response body | Add `.replaceAll(this.token, "[REDACTED]")` to both error paths in `apiCall()` |
| S4-06 | MEDIUM | Unescaped `first_name` from Telegram users flows into audit logs and denial reasons | Sanitize with `.replace(/[<>&"']/g, "").slice(0, 64)` before using as `decidedBy` |
| S4-10 | LOW | `escapeHtml` does not escape quotes (`"` and `'`) | Added `&quot;` and `&#39;` replacement to `escapeHtml()` |

### Deferred to Sprint 5+

| ID | Severity | Finding | Reason |
|----|----------|---------|--------|
| S4-02 | HIGH | Missing requestId length validation for Telegram's 64-byte callback_data limit | Requires coordination with intent ID generation — intent IDs from wallet are UUIDs (36 chars), well within limit |
| S4-03 | MEDIUM | `allowedUserIds` optional with open-by-default behavior | Design choice for simple setups — documented behavior |
| S4-04 | MEDIUM | First-responder-wins, no quorum mechanism | Production enhancement — MVP uses single-approver pattern |
| S4-07 | MEDIUM | Shared bot instances consume each other's getUpdates | Architectural — recommend one bot per wallet instance |
| S4-08 | LOW | No maximum timeout enforcement | Low risk — controlled by SDK consumer config |
| S4-09 | LOW | Short long-poll timeout (2s) increases HTTP overhead | Performance optimization, not security |
| S4-11 | LOW | `<=` threshold allows exact-threshold bypass | By design — `above` semantics mean strictly greater than |
| S4-12 | INFO | Blocking pattern holds wallet mutex during approval | Documented design trade-off for correctness |
| S4-13 | INFO | Generic error messages in approval channel failures | Positive security practice — prevents information leakage |
| S4-14 | INFO | PolicyEngine passes approval channel to all rules via context | No custom rules currently; note for future |

---

## QA Test Results

- **Total tests:** 612
- **Passing:** 612
- **New tests added:** 76 (36 telegram, 14 wallet, 10 rules, plus 20 QA-added coverage tests)
- **Coverage areas:** Constructor, approval flow, message formatting, timeout, security, error handling, edge cases, wallet integration, ApprovalGateRule branches

### Test Distribution

| File | Tests |
|------|-------|
| wallet.test.ts | 137 |
| rules.test.ts | 102 |
| solana-utils.test.ts | 57 |
| builder.test.ts | 56 |
| telegram.test.ts | 56 |
| sqlite.test.ts | 54 |
| solana-adapter.test.ts | 39 |
| memory.test.ts | 38 |
| audit.test.ts | 19 |
| engine.test.ts | 18 |
| intent.test.ts | 18 |
| local.test.ts | 13 |
| mpc.test.ts | 5 |

---

## Files Modified

### New/Rewritten

- `src/approval/telegram.ts` — 372 lines, full TelegramApprovalBot using raw Telegram Bot API
- `tests/unit/approval/telegram.test.ts` — 56 tests, comprehensive bot coverage
- `tests/unit/core/wallet.test.ts` — 14 new approval integration tests (137 total)
- `tests/unit/policy/rules.test.ts` — 10 new ApprovalGateRule tests (102 total)

### Not Modified (no changes needed)

- `src/approval/interface.ts` — Existing interface sufficient
- `src/policy/rules/approval-gate.ts` — Already blocks and awaits correctly
- `src/core/wallet.ts` — Already wired for approval channel
- `src/policy/engine.ts` — Already passes approval via PolicyContext
- `src/index.ts` — Already exports TelegramApprovalBot

---

## Key Design Decisions

1. **Raw `fetch` instead of grammY/telegraf**: Only 3 Telegram API calls needed (sendMessage, getUpdates, answerCallbackQuery). No new dependency — lighter footprint for an SDK.
2. **Blocking pattern**: `ApprovalGateRule.evaluate()` awaits `requestApproval()` — no changes needed to wallet.ts or engine.ts. Simpler than maintaining a pending-approvals store.
3. **Deadline-based polling**: `while (Date.now() < deadline)` with `getUpdates` long-polling. Correctly handles both `expiresAt` from request and `defaultTimeout` from config.
4. **Fail-closed on all error paths**: Telegram API errors, network failures, and channel exceptions all result in DENY. The approval channel never silently succeeds.
5. **HTML escaping of all user-controlled fields**: Prevents message manipulation by malicious agents providing crafted `target`, `amount`, `reason`, etc.
6. **Bot token redaction**: Error messages from Telegram API responses are sanitized to prevent token leakage in logs.

---

## What's Next (Sprint 5)

Per the implementation plan, Sprint 5 addresses the Agent Adapter layer:
- Tool definitions for Anthropic (Claude) and OpenAI formats
- `handleToolCall()` implementation
- `toAnthropicTools()` and `toOpenAITools()` implementations
- Address S4-02 (requestId validation) and S4-08 (max timeout)
