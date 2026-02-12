# Sprint 4 -- Security Audit

**Date:** 2026-02-11
**Auditor:** Security Review (Automated)
**Scope:** Telegram Bot + Approval Flow
**Files Reviewed:**

- `src/approval/telegram.ts` (full rewrite -- TelegramApprovalBot implementation)
- `src/approval/interface.ts` (ApprovalChannel interface and types)
- `src/policy/rules/approval-gate.ts` (ApprovalGateRule policy rule)
- `src/core/wallet.ts` (approval-related integration in AgentWallet)
- `src/policy/engine.ts` (approval context passing to policy rules)
- `tests/unit/approval/telegram.test.ts` (36 unit tests)
- `tests/unit/core/wallet.test.ts` (8 approval integration tests)

---

## Summary

Sprint 4 introduces human-in-the-loop approval for high-value transactions via a Telegram bot. The implementation is well-structured: the `ApprovalChannel` interface is clean, the `ApprovalGateRule` correctly delegates to it, and the `TelegramApprovalBot` implements long-polling with proper deadline enforcement. The system correctly fails closed in all error paths (no approval channel configured, channel throws, timeout). The `AgentWallet` mutex from Sprint 1 serializes execution, preventing concurrent policy bypass.

However, there are several security findings, most notably: incomplete HTML escaping that allows injection via the `amount`, `token`, and `target` fields; a first-responder-wins race condition where two authorized users could both attempt to respond; the `allowedUserIds` whitelist being optional (open-by-default); missing `requestId` validation that enables cross-request callback replay; and a potential for Telegram API error messages to leak the bot token.

### Finding Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 0 |
| HIGH     | 2 |
| MEDIUM   | 5 |
| LOW      | 4 |
| INFO     | 3 |
| **Total** | **14** |

---

## Findings

---

### S4-01 [HIGH] -- Incomplete HTML Escaping Allows Injection via Amount, Token, and Target Fields

**File:** `src/approval/telegram.ts`
**Line(s):** 326-358
**Description:** The `formatApprovalMessage` function only applies `escapeHtml()` to the `reason` and `agentId` fields. The `amount`, `token`, `target`, `budgetContext.dailySpent`, `budgetContext.dailyLimit`, and `budgetContext.token` fields are interpolated directly into the HTML message without escaping:

```typescript
lines.push(`<b>Amount:</b> ${request.amount} ${request.token}`);
// ...
lines.push(`<b>To:</b> <code>${request.target}</code>`);
// ...
lines.push(`<b>Daily Budget:</b> ${dailySpent} / ${dailyLimit} ${token}`);
```

While `amount` and `token` pass through `ApprovalGateRule.buildApprovalRequest` where they are derived from numeric parsing and string extraction, the `target` field is taken directly from intent params (`to`, `programId`, `collection`, or `validator`). An attacker controlling the `to` address could inject HTML tags like `<b>Approved</b>` or `<a href="...">Click here</a>` into the Telegram message, potentially deceiving the human approver into thinking the transaction is something other than what it is.

Telegram's HTML parse mode supports `<b>`, `<i>`, `<code>`, `<pre>`, `<a href="">`, `<tg-spoiler>`, and other tags. An attacker could craft a `to` address containing `</code><b>SAFE TREASURY WALLET</b><code>` to make a malicious address appear legitimate.

**Impact:** A malicious agent could craft transaction parameters that alter how the approval message renders in Telegram, potentially tricking a human approver into approving a transaction to an unintended address. This is particularly dangerous because the human is the last line of defense.

**Recommendation:** Apply `escapeHtml()` to ALL user-controlled fields before interpolation:

```typescript
lines.push(`<b>Amount:</b> ${escapeHtml(request.amount)} ${escapeHtml(request.token)}`);
lines.push(`<b>To:</b> <code>${escapeHtml(request.target)}</code>`);
if (request.budgetContext) {
  const { dailySpent, dailyLimit, token } = request.budgetContext;
  lines.push(
    `<b>Daily Budget:</b> ${escapeHtml(dailySpent)} / ${escapeHtml(dailyLimit)} ${escapeHtml(token)}`,
  );
}
```

**Status:** Open

---

### S4-02 [HIGH] -- Missing `requestId` Format Validation Enables Cross-Request Callback Replay

**File:** `src/approval/telegram.ts`
**Line(s):** 100-109, 174-176
**Description:** The `requestId` is used directly in `callback_data` without any validation of its format or length:

```typescript
callback_data: `approve:${requestId}`,
callback_data: `reject:${requestId}`,
```

And the matching logic is a simple string comparison:

```typescript
const isApprove = data === `approve:${requestId}`;
const isReject = data === `reject:${requestId}`;
```

Telegram's `callback_data` is limited to 1-64 bytes. If the `requestId` is long (e.g., a UUID is 36 characters, making `approve:UUID` = 44 bytes, within limits), but the `ApprovalGateRule.buildApprovalRequest` at line 102 uses `intent.id ?? crypto.randomUUID()`, and intent IDs can be up to 128 characters (per wallet validation). A 128-character intent ID would produce `approve:<128 chars>` = 136 bytes, exceeding Telegram's 64-byte `callback_data` limit. The Telegram API would silently truncate or reject this.

More critically, the polling loop at line 164-203 uses `getUpdates` which returns ALL callback queries for the bot, not just for the current chat. If two approval requests are pending simultaneously (from different `AgentWallet` instances sharing the same bot), and they happen to have `requestId` values where one is a prefix of the other, or if a previously captured callback is replayed, the simple string equality check does protect against cross-matching. However, there is no nonce or HMAC binding the callback_data to the specific message, so a Telegram user who has seen a previous `approve:req-id` callback_data could potentially replay it if a new request happens to use the same ID.

The `requestId` comes from `intent.id ?? crypto.randomUUID()`, so if the caller provides a predictable or reused intent ID, a malicious Telegram user could pre-craft a callback_query matching that ID.

**Impact:** If intent IDs are predictable or reusable, an attacker who has previously observed a callback_data pattern could pre-approve a future transaction. If the intent ID exceeds ~56 characters, the callback_data will be silently truncated by Telegram, potentially causing the approval to never match or worse, matching an unintended request.

**Recommendation:**
1. Validate that `requestId` length stays within `callback_data` limits (max ~56 chars after the `approve:` prefix).
2. Generate a short, random, one-time nonce for the callback_data rather than using the raw requestId. Map the nonce back to the requestId internally.
3. Consider including a timestamp or HMAC in the callback_data to prevent replay.

```typescript
private generateCallbackId(): string {
  return crypto.randomUUID().slice(0, 8); // short, random, unique per request
}
```

**Status:** Open

---

### S4-03 [MEDIUM] -- `allowedUserIds` Is Optional with Open-by-Default Behavior

**File:** `src/approval/telegram.ts`
**Line(s):** 22-23, 69, 179
**Description:** The `allowedUserIds` configuration is optional. When not set, any Telegram user who can interact with the bot can approve or reject transactions:

```typescript
allowedUserIds?: number[];
// ...
if (this.allowedUserIds && !this.allowedUserIds.includes(from.id)) {
```

This is an open-by-default design. If a developer forgets to set `allowedUserIds`, or if the bot is added to a group chat, any user in that group could approve high-value transactions. The test suite even explicitly tests this behavior ("should allow any user when allowedUserIds is not set").

**Impact:** If `allowedUserIds` is not configured (the default), any Telegram user who can send messages to the bot or is in the same group chat can approve transactions. This could lead to unauthorized transaction approval by untrusted parties.

**Recommendation:** Make `allowedUserIds` required (non-optional) in the config, or at minimum log a prominent warning when it is not set. Consider requiring at least one authorized user:

```typescript
constructor(config: TelegramApprovalBotConfig) {
  if (!config.allowedUserIds || config.allowedUserIds.length === 0) {
    throw new Error(
      "TelegramApprovalBot requires at least one allowedUserId. " +
      "Without this, any Telegram user can approve transactions."
    );
  }
  // ...
}
```

**Status:** Open

---

### S4-04 [MEDIUM] -- First-Responder-Wins Race Between Multiple Authorized Users

**File:** `src/approval/telegram.ts`
**Line(s):** 164-203
**Description:** The polling loop processes callback queries sequentially within each `getUpdates` batch. If two authorized users both press "Approve" and "Reject" respectively, the first callback_query encountered in the update batch wins, and the second is silently ignored (the function returns after the first match).

This is the intended design (first-responder-wins), but there is no mechanism to:
1. Notify the second responder that their action was ignored.
2. Require multiple approvals (quorum) for very high-value transactions.
3. Prevent a single compromised authorized user from unilaterally approving any transaction.

The inline keyboard buttons remain visible to the second user even after the first has responded, because `removeInlineKeyboard` is called after the decision is made. Between the time the first user clicks and the keyboard is removed, the second user could also click, sending a callback_query that will never be processed (since `waitForResponse` has already returned).

**Impact:** A single compromised authorized Telegram account can unilaterally approve any transaction above the threshold. There is no multi-signature or quorum mechanism for high-value approvals.

**Recommendation:** For the current MVP, document that this is single-approver and accept the risk. For production, consider:
1. A configurable quorum requirement (e.g., 2-of-3 approvers for transactions above a higher threshold).
2. Answering the second responder's callback with "This request has already been resolved."
3. A "veto" mechanism where any authorized user can reject within a grace period even after approval.

**Status:** Deferred (acceptable for MVP, document the limitation)

---

### S4-05 [MEDIUM] -- Bot Token May Leak in Error Messages from `apiCall`

**File:** `src/approval/telegram.ts`
**Line(s):** 288-313
**Description:** The `apiCall` method constructs the URL using `this.apiBase` which contains the bot token:

```typescript
this.apiBase = `https://api.telegram.org/bot${config.token}`;
// ...
const response = await fetch(`${this.apiBase}/${method}`, { ... });
if (!response.ok) {
  const text = (await response.text()).slice(0, 200);
  throw new Error(
    `Telegram API ${method} failed (${response.status}): ${text}`,
  );
}
```

While the error message itself does not include the URL, the Telegram API response body (captured in `text`) could potentially echo back the request URL or token in its error description. Additionally, if this error propagates up through the `ApprovalGateRule` catch block at line 82-89, the bot token could appear in:
- The policy denial reason string (line 87): `"Approval channel error: failed to get approval..."`
- Audit log entries
- Error messages returned to the calling agent

The truncation to 200 characters (line 299) is good but not sufficient, as the token itself could be in the first 200 characters of the response.

**Impact:** If the Telegram API returns an error body containing the request URL or token, the bot token could be exposed in error messages, audit logs, or responses to the agent. A leaked bot token allows an attacker to impersonate the bot and approve/reject transactions.

**Recommendation:** Sanitize the Telegram API error response to ensure it does not contain the bot token:

```typescript
if (!response.ok) {
  const text = (await response.text()).slice(0, 200);
  const sanitized = text.replace(this.token, "[REDACTED]");
  throw new Error(
    `Telegram API ${method} failed (${response.status}): ${sanitized}`,
  );
}
```

Also sanitize in the `json.description` path at line 308.

**Status:** Open

---

### S4-06 [MEDIUM] -- `decidedBy` Uses Unescaped `first_name` in Status Message

**File:** `src/approval/telegram.ts`
**Line(s):** 242-268
**Description:** The `removeInlineKeyboard` method constructs a status message using the Telegram user's `first_name` without HTML escaping:

```typescript
const statusText =
  decision === "approved"
    ? `\u2705 Approved by ${decidedBy}`
    : `\u274c Rejected by ${decidedBy}`;
```

And then sends it via `sendMessage` (line 260-264), but without `parse_mode: "HTML"`. This specific call does not use HTML parse mode, so HTML injection is not possible in this particular message. However, the `decidedBy` value (from `first_name`) is also returned in the `ApprovalResult`:

```typescript
return {
  requestId,
  decision,
  decidedBy: from.first_name || String(from.id),
  decidedAt: Date.now(),
};
```

This value flows into the `ApprovalGateRule` denial reason at line 80:

```typescript
reason: `Transaction of ${amount} ${token} was rejected by approver${result.decidedBy ? ` (${result.decidedBy})` : ""}`,
```

And subsequently into audit log entries. A Telegram user with a malicious `first_name` (e.g., containing SQL fragments, HTML tags, or format string specifiers) could inject content into audit logs and policy denial reason strings.

**Impact:** A malicious Telegram user could set their `first_name` to contain injection payloads that flow into audit logs and denial reason strings. While this is unlikely to cause direct code execution (the values are used as strings), it could corrupt audit logs or cause display issues in downstream UIs that render these strings.

**Recommendation:** Sanitize `from.first_name` before using it:

```typescript
const safeName = from.first_name.replace(/[<>&"']/g, "").slice(0, 64) || String(from.id);
```

**Status:** Open

---

### S4-07 [MEDIUM] -- Shared Bot Instance Processes Unrelated Callback Queries

**File:** `src/approval/telegram.ts`
**Line(s):** 137-162
**Description:** The `getUpdates` call retrieves ALL pending callback_query updates for the bot, filtered only to `["callback_query"]`. The polling loop advances the offset to avoid re-processing, but if the bot is used for other purposes (or multiple `TelegramApprovalBot` instances share the same bot token), the `getUpdates` call will consume and advance past callback queries intended for other consumers.

The `offset` parameter in `getUpdates` is global to the bot -- once an update is acknowledged (by passing a higher offset), it cannot be retrieved again. If two `requestApproval` calls run concurrently (which the wallet mutex prevents within a single wallet, but not across multiple wallet instances sharing the same bot), one could consume the other's callback_query.

**Impact:** If multiple `AgentWallet` instances share the same Telegram bot token and run concurrently, one instance's `getUpdates` polling could consume and discard callback_query updates intended for another instance's approval request. The consumed request would then time out, resulting in a denial.

**Recommendation:** For production use:
1. Document that each `TelegramApprovalBot` instance should use a dedicated bot token.
2. Consider using Telegram webhooks instead of long-polling, which allows routing callbacks to specific handlers.
3. Alternatively, use a centralized callback dispatcher that routes callback_queries to the correct `waitForResponse` call based on requestId.

**Status:** Open

---

### S4-08 [LOW] -- No Maximum Timeout Enforcement

**File:** `src/approval/telegram.ts`
**Line(s):** 52, 68, 81-83
**Description:** The `defaultTimeout` from config and the computed `timeoutMs` from `expiresAt` are not bounded by any maximum. A caller could set `expiresAt` to `Date.now() + Number.MAX_SAFE_INTEGER`, causing the polling loop to run for millions of years. Similarly, `defaultTimeout` can be set to any positive number.

The `ApprovalGateConfig.timeout` field (line 88 in `approval-gate.ts`) also lacks a maximum bound:

```typescript
const timeoutMs = this.config.timeout ?? DEFAULT_TIMEOUT_MS;
```

**Impact:** An extremely large timeout value would cause the `waitForResponse` polling loop to run indefinitely, tying up the wallet's execute mutex and effectively creating a denial-of-service against the wallet. No other transactions could be processed until the approval times out.

**Recommendation:** Enforce a maximum timeout (e.g., 1 hour):

```typescript
const MAX_TIMEOUT_MS = 3_600_000; // 1 hour
const timeoutMs = Math.min(
  request.expiresAt
    ? Math.max(0, request.expiresAt - Date.now())
    : this.defaultTimeout,
  MAX_TIMEOUT_MS,
);
```

**Status:** Open

---

### S4-09 [LOW] -- Telegram `getUpdates` Long-Poll Timeout is Very Short

**File:** `src/approval/telegram.ts`
**Line(s):** 54, 139
**Description:** The `TELEGRAM_LONG_POLL_TIMEOUT` is set to 2 seconds:

```typescript
const TELEGRAM_LONG_POLL_TIMEOUT = 2; // seconds for getUpdates long poll
```

Combined with the `pollInterval` default of 2 seconds (line 53), each polling cycle takes approximately 4 seconds (2s long poll + 2s sleep when no updates). This means the minimum response latency for a human's approval is up to 4 seconds, and during the 2-second sleep window, the system is not listening for updates at all.

More importantly, the short long-poll timeout means the bot makes a new HTTP request every ~4 seconds. For a 5-minute default timeout, that is approximately 75 HTTP requests per approval request. This is not a problem for a single bot, but if many approval requests are pending or the system scales, it increases load on both the Telegram API and the host.

**Impact:** Minor latency increase (up to 4 seconds) between human button press and the system detecting the response. Increased HTTP request volume compared to a longer long-poll timeout.

**Recommendation:** Increase the long-poll timeout to 15-30 seconds, which is the Telegram-recommended range. This reduces HTTP overhead and improves response latency:

```typescript
const TELEGRAM_LONG_POLL_TIMEOUT = 15; // seconds
```

When a callback arrives during the long poll, Telegram returns immediately, so latency is not increased for the happy path.

**Status:** Open

---

### S4-10 [LOW] -- `escapeHtml` Does Not Escape Quotes

**File:** `src/approval/telegram.ts`
**Line(s):** 364-369
**Description:** The `escapeHtml` function escapes `&`, `<`, and `>` but not `"` (double quote) or `'` (single quote):

```typescript
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
```

In Telegram's HTML parse mode, double quotes are used in `<a href="...">` tags. While the current code does not construct any `<a>` tags dynamically, if future changes introduce link construction using escaped values, the missing quote escaping could allow attribute injection.

**Impact:** No immediate exploitability in the current code, since no dynamic attributes are constructed. However, this is a defense-in-depth gap that could become exploitable if the message formatting code evolves.

**Recommendation:** Add quote escaping for completeness:

```typescript
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
```

**Status:** Open

---

### S4-11 [LOW] -- `ApprovalGateRule` Threshold Comparison Uses `<=` Allowing Exact-Threshold Bypass

**File:** `src/policy/rules/approval-gate.ts`
**Line(s):** 45-46
**Description:** The threshold comparison uses `<=` (less-than-or-equal):

```typescript
if (amount <= threshold) {
  return { decision: "ALLOW" };
}
```

This means a transaction of exactly the threshold amount (e.g., exactly 5.0 SOL when the threshold is 5.0 SOL) passes through without approval. Whether this is a bug or intentional depends on the policy semantics. The config field is named `above`, which suggests "above the threshold" requires approval -- making the `<=` check correct (only amounts strictly greater than the threshold require approval).

However, this could be confusing to operators who configure `above: { amount: "5", token: "SOL" }` expecting that 5.0 SOL transactions also require approval.

**Impact:** Transactions at exactly the threshold amount bypass approval. This is consistent with the `above` naming but may surprise operators.

**Recommendation:** Document the behavior clearly. If "at or above" semantics are desired, change to `<`:

```typescript
if (amount < threshold) {
  return { decision: "ALLOW" };
}
```

**Status:** Not an issue (behavior matches documented semantics, but documentation should be explicit)

---

### S4-12 [INFO] -- `ApprovalGateRule` Accepts Approval Synchronously (Blocking Pattern)

**File:** `src/policy/rules/approval-gate.ts`
**Line(s):** 28, 61-62
**Description:** The `ApprovalGateRule.evaluate()` method calls `context.approval.requestApproval(request)` and awaits the result inline. This means the entire `PolicyEngine.evaluate()` call blocks until the human responds or the timeout expires. During this blocking period, the wallet's execute mutex is held (from `wallet.ts` line 94-106), preventing any other transactions from being processed.

For the current single-wallet design, this is acceptable -- the mutex exists to prevent TOCTOU races. But it means that a 5-minute approval timeout blocks the entire wallet for 5 minutes.

**Impact:** No security issue per se. This is a design trade-off between correctness (mutex prevents TOCTOU) and availability (wallet is blocked during approval). Documented for awareness.

**Recommendation:** No change needed for the current architecture. For future consideration:
1. A queue-based design where pending approvals do not hold the mutex.
2. The `PENDING` policy decision type exists in the codebase but the current `ApprovalGateRule` resolves to `ALLOW` or `DENY` synchronously rather than returning `PENDING` and resolving later.

**Status:** Not an issue (documented design trade-off)

---

### S4-13 [INFO] -- Approval Channel Error Messages in Policy Denial Are Generic

**File:** `src/policy/rules/approval-gate.ts`
**Line(s):** 82-89
**Description:** When the approval channel throws an exception, the catch block produces a generic denial reason:

```typescript
} catch {
  return {
    decision: "DENY",
    rule: this.name,
    reason: `Approval channel error: failed to get approval for ${amount} ${token} transaction`,
  };
}
```

The original error message is discarded. This is actually a security-positive design: it prevents internal error details (including potentially the bot token from S4-05) from leaking into the denial reason. However, it also means operators have no way to distinguish between "Telegram API returned 401 unauthorized" and "network timeout" from the policy decision alone.

**Impact:** No security issue. This is a positive security practice (error sanitization). Noted for operational awareness -- if the approval channel is misconfigured, the only signal is generic denial reasons in the audit log.

**Recommendation:** Consider logging the full error internally (not in the denial reason) for operational debugging:

```typescript
} catch (err) {
  // Log internally for debugging (do not include in reason sent to agent)
  console.error("Approval channel error:", err);
  return {
    decision: "DENY",
    rule: this.name,
    reason: `Approval channel error: failed to get approval for ${amount} ${token} transaction`,
  };
}
```

**Status:** Not an issue (positive security practice)

---

### S4-14 [INFO] -- `PolicyEngine` Passes `approval` to All Rules via `PolicyContext`

**File:** `src/policy/engine.ts`
**Line(s):** 33-37
**Description:** The `PolicyEngine.evaluate()` method creates a `PolicyContext` containing the `approval` channel and passes it to ALL rules, not just the `ApprovalGateRule`:

```typescript
const context: PolicyContext = {
  store: this.store,
  approval: this.approval,
  now: now ?? Date.now(),
};
```

Any policy rule receives the approval channel reference. A malicious or buggy custom rule could call `context.approval.requestApproval()` directly, potentially sending spurious approval requests to the human operator or consuming bot API quota.

**Impact:** No immediate risk with the current built-in rules. However, if the system supports user-defined custom policy rules in the future, those rules would have unnecessary access to the approval channel.

**Recommendation:** Consider restricting approval channel access to only the `ApprovalGateRule`, or make the approval channel a constructor dependency of that rule rather than passing it through the context. This follows the principle of least privilege.

**Status:** Not an issue (no custom rules currently, but note for future architecture)

---

## Verified as Correct

The following areas were reviewed and found to be properly implemented:

1. **Fail-Closed on Missing Approval Channel:** When `ApprovalGateRule` detects that `context.approval` is undefined and the amount exceeds the threshold, it returns `DENY` with a clear reason (line 50-56). This is the correct fail-closed behavior. **Verdict: Secure.**

2. **Fail-Closed on Approval Channel Exception:** The try/catch at lines 61-89 in `approval-gate.ts` returns `DENY` on any exception from the approval channel. This ensures that Telegram API failures, network errors, or any other exception class results in transaction denial. **Verdict: Secure.**

3. **Fail-Closed on Timeout:** The `TelegramApprovalBot.waitForResponse` returns `decision: "timeout"` when the deadline expires (lines 211-219), and the `ApprovalGateRule` maps timeout to `DENY` (lines 68-73). **Verdict: Secure.**

4. **Polling Loop Deadline Enforcement:** The `while (Date.now() < deadline)` check at line 131, combined with the `remainingMs <= 0` break at line 133, correctly bounds the polling loop. The loop cannot run past the deadline. **Verdict: Secure.**

5. **Wallet Execute Mutex Serialization:** The `AgentWallet.execute()` method acquires a mutex before calling `executeInternal()` (lines 94-106), and releases it in a `finally` block. This prevents two concurrent transactions from racing through the policy engine. The approval flow runs within this mutex, so two concurrent high-value transactions will be serialized. **Verdict: Secure.**

6. **`callback_data` Matching Uses Exact String Equality:** The comparison at lines 174-176 uses strict equality (`===`), not substring matching or regex. This prevents a callback_data value like `approve:req-1-malicious` from matching `approve:req-1`. **Verdict: Secure.**

7. **`getUpdates` Offset Advancement:** The offset is always advanced to `update.update_id + 1` (line 167), even for updates that do not match the current request. This prevents stale updates from being re-processed on the next poll cycle. **Verdict: Secure.**

8. **Transient Error Handling in Polling:** Both HTTP errors (line 146-149) and network exceptions (line 159-162) in the polling loop result in a sleep-and-retry rather than a crash or immediate return. The loop continues until the deadline. **Verdict: Secure.**

9. **Non-Fatal Cleanup Operations:** The `answerCallbackQuery`, `removeInlineKeyboard`, and `editMessageExpired` methods all catch and swallow errors (lines 234, 265, 282). These are post-decision cleanup operations -- their failure should not affect the approval result. **Verdict: Correct design.**

10. **Intent ID Validation:** The wallet validates intent IDs are between 1-128 characters (line 321-323), preventing empty or extremely long IDs from reaching the approval system. **Verdict: Secure** (though 128 characters is too long for Telegram callback_data per S4-02).

11. **`ApprovalRequest.id` Uses `crypto.randomUUID()`:** When the intent has no ID, `buildApprovalRequest` at line 102 generates a cryptographically random UUID. This provides strong uniqueness guarantees for request IDs. **Verdict: Secure.**

12. **Negative/Zero Amount Rejection:** The `extractAmount` method at lines 114-120 rejects negative and zero amounts by returning `null`, which causes the rule to return `ALLOW` (amounts cannot be compared to threshold). Combined with wallet-level validation that rejects non-positive amounts, negative amounts never reach the approval gate. **Verdict: Secure.**

---

## Risk Summary by File

| File | Findings | Highest Severity |
|------|----------|-----------------|
| `src/approval/telegram.ts` | S4-01, S4-02, S4-03, S4-05, S4-06, S4-07, S4-08, S4-09, S4-10 | HIGH |
| `src/policy/rules/approval-gate.ts` | S4-11, S4-12, S4-13 | LOW |
| `src/policy/engine.ts` | S4-14 | INFO |
| `src/core/wallet.ts` | (none -- approval integration is correct) | -- |
| `src/approval/interface.ts` | (none -- clean interface definition) | -- |

---

## Recommended Priority for Remediation

**Immediate (before any production use):**
1. **S4-01** -- Escape all user-controlled fields in HTML messages (prevents approver deception)
2. **S4-03** -- Make `allowedUserIds` required or fail loudly when not set
3. **S4-05** -- Sanitize bot token from error messages

**Before beta/production:**
4. **S4-02** -- Validate requestId length for callback_data limits; consider short nonces
5. **S4-07** -- Document single-bot-instance requirement or implement callback dispatcher
6. **S4-06** -- Sanitize `first_name` before use in audit-visible strings

**Hardening:**
7. **S4-08** -- Enforce maximum timeout bound
8. **S4-09** -- Increase long-poll timeout to 15-30 seconds
9. **S4-10** -- Add quote escaping to `escapeHtml`
10. **S4-04** -- Document single-approver limitation; plan quorum for production

---

## Test Coverage Assessment

The test suite provides solid coverage of the happy path and key security scenarios:

- **Covered:** Approve/reject flow, timeout, unauthorized user rejection, HTML escaping of `reason`, different request ID filtering, network error resilience, API failure resilience, empty `getUpdates` response, missing `callback_data`, correct API URL construction, inline keyboard structure, full wallet integration (below-threshold passthrough, approve, reject, timeout, no-channel fail-closed, channel-error fail-closed, request field validation, audit logging).

- **Not covered:** HTML escaping of `amount`/`token`/`target` fields (S4-01), `requestId` exceeding callback_data limits (S4-02), extremely long timeout values (S4-08), concurrent bot instances sharing a token (S4-07), `first_name` injection via `decidedBy` (S4-06), bot token leaking in error messages (S4-05).

**Recommendation:** Add tests for the uncovered scenarios, particularly:
- A test that verifies `target` fields containing HTML tags are escaped in the message
- A test that verifies error messages do not contain the bot token
- A test with a very long `requestId` to verify behavior at Telegram's callback_data limit
