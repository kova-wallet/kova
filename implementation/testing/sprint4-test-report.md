# Sprint 4 — QA Test Report

**Date:** 2026-02-11
**Sprint:** 4 — Telegram Bot + Approval Flow

## Test Summary

| File | Before | After | New |
|------|--------|-------|-----|
| telegram.test.ts | 36 | 56 | 20 |
| wallet.test.ts | 131 | 137 | 6 |
| rules.test.ts | 92 | 102 | 10 |
| **Total** | 576 | 612 | 36 |

## Coverage Analysis

### Areas with good coverage (pre-existing)

- **TelegramApprovalBot constructor**: All config permutations tested (6 tests)
- **Approval flow happy path**: Approve/reject callbacks, inline keyboard setup, answerCallbackQuery, HTML parse mode (6 tests)
- **Message formatting**: Amount, token, target address, reason, agentId, budgetContext, usdValue, HTML escaping (7 tests)
- **Timeout behavior**: Deadline-based timeout, defaultTimeout, keyboard removal on timeout, already-expired request (4 tests)
- **Security**: Authorized/unauthorized user callbacks, allowedUserIds enforcement (4 tests)
- **Error handling**: sendMessage API failure (HTTP error + ok:false), getUpdates API failure, network errors during polling (4 tests)
- **Edge cases**: Wrong request ID, empty getUpdates, missing data field, correct API base URL, correct chatId (5 tests)
- **ApprovalGateRule**: All core branches (below/at/above threshold, approved/rejected/timeout, no channel, channel error, token mismatch, custom intent, decidedBy) (12 tests)
- **ApprovalGateRule edge cases**: Boundary values, approval request fields, case-insensitive token, default timeout, reason/agentId from metadata, UUID generation, swap target extraction (8 tests)
- **Wallet approval integration**: Below threshold, above threshold (approved/rejected/timeout), no channel configured, channel throws, approval request fields, audit logging (8 tests)

### Gaps identified and filled

#### telegram.test.ts (20 new tests)

1. **Format message without optional fields** — Verified that omitting reason, agentId, budgetContext, and usdValue produces a message without those sections
2. **USD value of 0** — Confirmed `$0.00` is rendered correctly (edge case for `toFixed(2)`)
3. **HTML ampersand escaping** — Tested `&` -> `&amp;` conversion in reason text
4. **HTML escaping in agentId** — Tested `<agent>` -> `&lt;agent&gt;` conversion
5. **Singular minute display** — Verified "Expires in 1 minute" (not "1 minutes")
6. **0 minutes for expired requests** — Verified `Math.max(0, ...)` clamp works
7. **Request ID in message** — Confirmed the request ID appears in the formatted text
8. **All fields present** — Full integration of every optional field in one message
9. **Multiple updates in single batch** — Two callbacks in one getUpdates response (wrong ID + right ID)
10. **Empty string callback data** — `data: ""` is correctly treated as non-matching
11. **getUpdates ok:false** — Separate from HTTP 503; tests the `json.ok === false` branch
12. **Update without callback_query** — Tests the `!update.callback_query?.data` guard
13. **defaultTimeout of 0** — Immediate timeout when expiresAt equals current time
14. **removeInlineKeyboard status reply (approved)** — Verified reply message contains "Approved by Alice"
15. **removeInlineKeyboard status reply (rejected)** — Verified reply message contains "Rejected by Bob"
16. **removeInlineKeyboard error handling** — editMessageReplyMarkup throws, bot still returns decision
17. **answerCallbackQuery error handling** — answerCallbackQuery throws, bot still returns decision
18. **editMessageExpired error handling** — editMessageReplyMarkup throws on timeout, bot still returns timeout
19. **decidedBy fallback to user ID** — When `first_name` is empty string, falls back to `String(from.id)`
20. **Callback delivered on second poll** — Validates polling loop continues across multiple iterations

#### wallet.test.ts (6 new tests)

1. **Threshold boundary — exactly at threshold** — 5.0 SOL with threshold of 5 does NOT trigger approval (`<=`)
2. **Just above threshold** — 5.01 SOL triggers approval
3. **Different token — USDC transfer with SOL threshold** — 1000 USDC passes without approval when threshold is for SOL
4. **Swap intent above threshold — approved** — Swap 10 SOL triggers approval, approved
5. **Swap intent above threshold — rejected** — Swap 10 SOL triggers approval, rejected -> denied
6. **Swap intent below threshold** — Swap 2 SOL does not trigger approval

#### rules.test.ts (10 new tests)

1. **Swap fromToken threshold check** — Swap intent with `fromToken: "SOL"` correctly matched against SOL threshold
2. **Swap below threshold** — Swap 3 SOL below threshold of 5 -> ALLOW
3. **Negative amount** — extractAmount returns null for negative -> ALLOW
4. **Zero amount** — extractAmount returns null for zero -> ALLOW
5. **NaN amount** — extractAmount returns null for non-numeric -> ALLOW
6. **Stake intent target extraction** — Validator address used as `target` in approval request
7. **Mint intent with no amount** — extractAmount returns null -> ALLOW (no amount to check)
8. **Configured timeout value** — `timeout: 10_000` produces expiresAt ~= now + 10s
9. **Timeout of 0** — `timeout: 0` produces expiresAt ~= now
10. **UNKNOWN token extraction** — Intent with no token/fromToken yields "UNKNOWN", matched against threshold

### Remaining gaps (deferred)

- **Real sleep/timing verification**: The `sleep()` method between polls is not directly observable (it's a private method calling `setTimeout`). Verifying exact timing would require injecting a clock or spy on `setTimeout`, which adds test complexity without meaningful coverage gain since the timeout behavior is already well-tested end-to-end.
- **Concurrent approval requests**: Testing two simultaneous `requestApproval` calls on the same bot instance is not covered because the real Telegram bot would share polling state and offset tracking. This is an integration-level concern.
- **Long-polling `timeout` query parameter**: The `TELEGRAM_LONG_POLL_TIMEOUT` constant (2 seconds) is sent to Telegram's `getUpdates` but not explicitly verified in tests. It's a passthrough constant.
- **apiCall response body truncation**: The `text.slice(0, 200)` in the error message is not tested for very long error bodies. This is a minor formatting concern.

## Test Results

All 612 tests passing.

```
 Test Files  13 passed (13)
      Tests  612 passed (612)
   Duration  1.09s
```
