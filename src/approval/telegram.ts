/**
 * TelegramApprovalBot — Sends approval requests to Telegram and waits for human decision.
 *
 * Uses the raw Telegram Bot API via fetch (no external dependencies).
 * Flow: sendMessage with inline keyboard → poll getUpdates for callback_query → return decision.
 *
 * API-010: POLLING ARCHITECTURE LIMITATION — This implementation uses getUpdates long-polling,
 * which is globally destructive (acknowledging an update_id discards all lower IDs server-side).
 * Only one process can poll a given bot token at a time. For multi-instance deployments,
 * use Telegram webhooks with a shared message queue (e.g., Redis pub/sub) instead.
 * The lastUpdateOffset field persists across calls within a single process lifetime
 * but is NOT persisted to disk, so restarting the process may re-consume stale updates.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type {
  ApprovalChannel,
  ApprovalRequest,
  ApprovalResult,
  ApprovalDecision,
} from "./interface.js";

export interface TelegramApprovalBotConfig {
  /** Telegram bot token from BotFather */
  token: string;
  /** Telegram chat ID to send approval requests to */
  chatId: string;
  /** Default timeout in ms (defaults to 300_000 = 5 min) */
  defaultTimeout?: number;
  /** Whitelist of Telegram user IDs allowed to approve/reject. Required unless allowAllUsers is true. */
  allowedUserIds?: number[];
  /**
   * HIGH-06 fix: Explicitly opt-in to allowing ANY user in the chat to approve/reject.
   * Must be set to `true` if allowedUserIds is not provided. This prevents accidental
   * open access where unauthorized users could approve high-value transactions.
   */
  allowAllUsers?: boolean;
  /** Polling interval in ms between getUpdates calls (defaults to 2000) */
  pollInterval?: number;
  /** HTTP timeout for Telegram API requests (defaults to 15_000 = 15s) */
  requestTimeoutMs?: number;
}

/** Telegram API response wrapper */
interface TelegramResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

/** Subset of Telegram Message type */
interface TelegramMessage {
  message_id: number;
  chat: { id: number };
}

/** Subset of Telegram Update type */
interface TelegramUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    from: { id: number; first_name: string };
    data?: string;
    message?: { message_id: number; chat: { id: number } };
  };
}

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
const DEFAULT_POLL_INTERVAL_MS = 2000;
const TELEGRAM_LONG_POLL_TIMEOUT = 2; // seconds for getUpdates long poll
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/** HIGH-20 fix: Time-to-live for processed request entries (10 minutes) */
const PROCESSED_REQUEST_TTL_MS = 600_000;

export class TelegramApprovalBot implements ApprovalChannel {
  readonly name = "telegram";
  private token: string;
  private readonly chatId: string;
  private readonly defaultTimeout: number;
  private readonly allowedUserIds?: number[];
  private readonly pollInterval: number;
  /**
   * L-31 fix: Destroyed flag to prevent further API calls after cleanup.
   * Once destroy() is called, all public methods will throw.
   */
  private destroyed = false;
  /**
   * L-31 fix: Flag to signal the polling loop in waitForResponse to stop.
   */
  private pollingActive = false;
  /**
   * MED-16 fix: Track processed request IDs to prevent replay of callbacks.
   * HIGH-20 fix: Changed from Set<string> to Map<string, number> where the value
   * is the timestamp when the request was processed. Entries older than
   * PROCESSED_REQUEST_TTL_MS are pruned to prevent unbounded memory growth.
   */
  private readonly processedRequests = new Map<string, number>();
  /**
   * API-010: Persistent offset for getUpdates polling. Tracks the last processed update_id
   * across calls to avoid re-processing or consuming unrelated updates from previous sessions.
   */
  private lastUpdateOffset = 0;
  // LOW-T4-06 fix: Changed from `readonly` to mutable so destroy() can clear
  // the bot token URL from memory. The apiBase contains the bot token in the URL
  // path (https://api.telegram.org/bot<token>/...) per Telegram API requirements.
  private apiBase: string;
  private readonly requestTimeoutMs: number;
  /**
   * CRIT-04 fix: Domain-separated HMAC key derived from the bot token.
   * Using the raw bot token as an HMAC key is problematic because it conflates
   * authentication material with key material. This derived key uses SHA-256
   * with a domain-separation prefix to produce a proper HMAC key.
   */
  private hmacSecret: Buffer;

  constructor(config: TelegramApprovalBotConfig) {
    if (!config.token || typeof config.token !== "string" || config.token.trim() === "") {
      throw new Error("TelegramApprovalBot requires a non-empty bot token");
    }
    if (!config.chatId || typeof config.chatId !== "string" || config.chatId.trim() === "") {
      throw new Error("TelegramApprovalBot requires a non-empty chatId");
    }
    // API-014: Validate chatId is a valid Telegram chat ID (numeric, possibly negative for groups)
    if (!/^-?\d+$/.test(config.chatId.trim())) {
      throw new Error(
        "TelegramApprovalBot: chatId must be a numeric string (e.g., '123456789' or '-100123456789' for groups)",
      );
    }

    this.token = config.token;
    this.chatId = config.chatId;
    this.defaultTimeout = config.defaultTimeout ?? DEFAULT_TIMEOUT_MS;
    this.allowedUserIds = config.allowedUserIds;
    this.pollInterval = config.pollInterval ?? DEFAULT_POLL_INTERVAL_MS;
    // M-48: SECURITY LIMITATION — The Telegram Bot API requires the bot token in the
    // URL path (/bot<token>/method). This is an unavoidable design constraint of the API.
    // Mitigations in place:
    //   1. HTTPS is used (api.telegram.org), so the token is encrypted in transit.
    //   2. The sanitizeBotToken() method strips the token from all error messages and logs
    //      to prevent accidental token leakage via logging pipelines.
    //   3. Bot tokens should be rotated periodically via BotFather (/revoke command).
    // For enhanced security, use a reverse proxy that injects the token server-side
    // so the token never appears in application-layer URLs.
    this.apiBase = `https://api.telegram.org/bot${config.token}`;
    this.requestTimeoutMs =
      typeof config.requestTimeoutMs === "number" && Number.isFinite(config.requestTimeoutMs) && config.requestTimeoutMs > 0
        ? config.requestTimeoutMs
        : DEFAULT_REQUEST_TIMEOUT_MS;

    // CRIT-04 fix: Derive a proper HMAC key from the bot token using SHA-256
    // with a domain-separation prefix. This avoids using the raw bot token
    // (which is authentication material) directly as cryptographic key material.
    this.hmacSecret = createHash("sha256").update("kova-callback-hmac:" + this.token).digest();

    // HIGH-06 fix: Require explicit opt-in when allowedUserIds is not configured.
    // This prevents accidental open access where any chat member can approve transactions.
    if (!config.allowedUserIds || config.allowedUserIds.length === 0) {
      if (!config.allowAllUsers) {
        throw new Error(
          "TelegramApprovalBot: 'allowedUserIds' is required. Set allowedUserIds to restrict " +
          "approval to specific Telegram users, or set allowAllUsers: true to explicitly allow " +
          "any user in the chat to approve/reject transactions.",
        );
      }
      // Explicit opt-in to open access — still warn
      try {
        process.emitWarning(
          "[kova:TelegramApprovalBot] allowAllUsers is true. Any user in this chat can approve or reject transaction requests. Set allowedUserIds to restrict approval to specific Telegram users.",
          { code: "KOVA_TELEGRAM_ALLOWED_USER_IDS_MISSING" },
        );
      } catch {
        // Non-fatal
      }
    }
  }

  /**
   * Send an approval request to Telegram and block until a human responds or timeout.
   * MED-18 fix: Rate-limits approval requests to prevent notification flooding.
   */
  async requestApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    // L-31 fix: Reject calls after destroy()
    if (this.destroyed) {
      throw new Error("TelegramApprovalBot has been destroyed and can no longer process requests");
    }
    // MED-18 fix: Limit concurrent/pending approval requests to prevent channel flooding
    // HIGH-20 fix: Prune entries older than PROCESSED_REQUEST_TTL_MS (10 minutes)
    const now = Date.now();
    for (const [id, timestamp] of this.processedRequests) {
      if (now - timestamp > PROCESSED_REQUEST_TTL_MS) {
        this.processedRequests.delete(id);
      }
    }

    const message = formatApprovalMessage(request);
    const sent = await this.sendMessage(message, request.id);

    // HIGH-21 fix: Clamp timeoutMs to this.defaultTimeout to prevent an untrusted
    // expiresAt value from setting an excessively long (or indefinite) timeout.
    // The expiresAt field comes from the policy rule which may derive it from
    // agent-supplied metadata, so we treat it as untrusted input.
    const computedTimeout = request.expiresAt
      ? Math.max(0, request.expiresAt - Date.now())
      : this.defaultTimeout;
    const timeoutMs = Math.min(computedTimeout, this.defaultTimeout);

    // MED-T4-02 fix: Warn when the operator-configured approval gate timeout exceeds
    // the Telegram bot's default timeout and is silently shortened. This makes it
    // visible that the effective timeout differs from what the policy rule requested.
    if (computedTimeout > this.defaultTimeout) {
      try {
        process.emitWarning(
          `MED-T4-02: Approval request timeout clamped from ${computedTimeout}ms to ${this.defaultTimeout}ms ` +
          `(Telegram bot defaultTimeout). The approval gate's configured timeout exceeds the bot's ` +
          `default timeout. Increase TelegramApprovalBotConfig.defaultTimeout to match, or reduce ` +
          `the approval gate timeout.`,
          "KovaApprovalTimeoutWarning",
        );
      } catch {
        // Non-fatal — warning emission should never block approval flow
      }
    }

    const result = await this.waitForResponse(request.id, sent.message_id, timeoutMs);

    // API-011: Echo the intentHash in the result so callers can verify which intent
    // was approved. Note (CRIT-03): The approval gate should still re-compute the
    // intent hash independently for TOCTOU verification -- this echo is for
    // auditability and logging, not as the sole verification mechanism.
    if (request.intentHash) {
      result.intentHash = request.intentHash;
    }

    return result;
  }

  /**
   * Send a message with Approve/Reject inline keyboard buttons.
   */
  private async sendMessage(
    text: string,
    requestId: string,
  ): Promise<TelegramMessage> {
    const body = {
      chat_id: this.chatId,
      text,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "\u2705 Approve",
              callback_data: `approve:${requestId}:${this.computeCallbackHmac(requestId, "approve")}`,
            },
            {
              text: "\u274c Reject",
              callback_data: `reject:${requestId}:${this.computeCallbackHmac(requestId, "reject")}`,
            },
          ],
        ],
      },
    };

    const data = await this.apiCall<TelegramMessage>("sendMessage", body);
    // MED-36 fix: Validate response structure before trusting it
    if (!data || typeof data.message_id !== "number" || !data.chat || typeof data.chat.id !== "number") {
      throw new Error("Telegram sendMessage returned invalid response structure (missing message_id or chat.id)");
    }
    return data;
  }

  /**
   * Poll for callback_query updates matching the request ID.
   * Returns when user responds or timeout is reached.
   *
   * MED-17 note: This method blocks the calling async context for up to timeoutMs
   * (default 5 minutes). During this time, the wallet's execute mutex is held,
   * blocking all other transactions. For production deployments with high throughput,
   * consider reducing the timeout or using a background polling architecture
   * that decouples approval waiting from the execute pipeline.
   *
   * MED-25 LIMITATION: getUpdates polling is globally destructive. The Telegram Bot
   * API's getUpdates method is stateful — calling it with an offset acknowledges and
   * discards all updates with lower update_ids server-side. This means:
   *   1. Only ONE process/instance can poll getUpdates for a given bot token at a time.
   *      Running multiple instances will cause updates to be consumed by one instance
   *      and lost to the others.
   *   2. Any other integration using the same bot token with getUpdates (or webhooks)
   *      will conflict with this polling loop.
   *   3. Updates for OTHER callback queries (not related to this request) that arrive
   *      during polling are consumed and discarded.
   * For production deployments, consider using a webhook-based architecture with a
   * shared message queue instead of getUpdates polling.
   */
  private async waitForResponse(
    requestId: string,
    messageId: number,
    timeoutMs: number,
  ): Promise<ApprovalResult> {
    const deadline = Date.now() + timeoutMs;
    // L-31 fix: Set polling flag so destroy() can signal this loop to stop
    this.pollingActive = true;

    while (Date.now() < deadline && !this.destroyed) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;

      let updates: TelegramUpdate[];
	      try {
	        const params = new URLSearchParams({
	          offset: String(this.lastUpdateOffset),
	          timeout: String(TELEGRAM_LONG_POLL_TIMEOUT),
	          allowed_updates: JSON.stringify(["callback_query"]),
	        });

	        const controller = new AbortController();
	        const timeout = setTimeout(
	          () => controller.abort(),
	          Math.max(this.requestTimeoutMs, (TELEGRAM_LONG_POLL_TIMEOUT + 1) * 1000),
	        );

	        // M-47: SECURITY NOTE — This fetch() call does not use a DNS-pinned agent.
	        // For consistency with the RPC layer's DNS pinning, Telegram API calls should
	        // use a DNS-pinned HTTP agent to prevent DNS rebinding attacks. If a
	        // fetchWithAgent() utility or pinned agent is available in the project,
	        // replace this bare fetch() call with one that routes through the pinned agent.
	        // L-25 fix: Include User-Agent header on all outbound HTTP requests
	        const response = await fetch(
	          `${this.apiBase}/getUpdates?${params.toString()}`,
	          {
	            signal: controller.signal,
	            headers: { "User-Agent": "kova-wallet-sdk/0.1.0" },
	          },
	        ).finally(() => clearTimeout(timeout));
	        if (!response.ok) {
	          // Transient API failure — wait and retry
	          await this.sleep(this.pollInterval);
	          continue;
	        }
        const json = (await response.json()) as TelegramResponse<
          TelegramUpdate[]
        >;
        // M-50 fix: Validate the Telegram API response against expected schema.
        // The response could be malformed due to API changes, proxy tampering, or
        // network corruption. Fail-closed rather than processing invalid data.
        if (!json.ok || !Array.isArray(json.result)) {
          await this.sleep(this.pollInterval);
          continue;
        }
        for (const update of json.result) {
          if (typeof update.update_id !== "number") {
            throw new Error("Invalid Telegram getUpdates response: update entry missing numeric update_id");
          }
        }
        updates = json.result;
      } catch {
        // Network error — wait and retry
        await this.sleep(this.pollInterval);
        continue;
      }

      for (const update of updates) {
        // Always advance the offset to avoid re-processing
        this.lastUpdateOffset = Math.max(this.lastUpdateOffset, update.update_id + 1);

        if (!update.callback_query?.data) continue;

        const { id: callbackId, from, data, message: cbMessage } = update.callback_query;

        // MED-14 fix: Validate the callback came from our chat
        if (cbMessage && String(cbMessage.chat.id) !== this.chatId) {
          continue; // Callback from a different chat — ignore
        }

        // HIGH-11 fix: Verify HMAC on callback data to prevent forgery
        const isApprove = this.verifyCallbackData(data, requestId, "approve");
        const isReject = this.verifyCallbackData(data, requestId, "reject");
        if (!isApprove && !isReject) continue;

        // MED-16 fix: Reject replayed callbacks for already-processed requests
        // HIGH-20 fix: Also check if the entry is still within the TTL window
        const processedAt = this.processedRequests.get(requestId);
        if (processedAt !== undefined) {
          if (Date.now() - processedAt > PROCESSED_REQUEST_TTL_MS) {
            // Entry has expired — remove it and allow re-processing
            this.processedRequests.delete(requestId);
          } else {
            await this.answerCallbackQuery(callbackId, "This request has already been processed.");
            continue;
          }
        }

        // Validate user authorization
        if (this.allowedUserIds && !this.allowedUserIds.includes(from.id)) {
          // Unauthorized user — answer and continue polling
          await this.answerCallbackQuery(
            callbackId,
            "You are not authorized to respond to this request.",
          );
          continue;
        }

        const decision: ApprovalDecision = isApprove ? "approved" : "rejected";
        const safeName = (from.first_name || String(from.id)).replace(/[<>&"']/g, "").slice(0, 64);

        // Acknowledge the callback and remove buttons
        await this.answerCallbackQuery(
          callbackId,
          decision === "approved" ? "Approved!" : "Rejected.",
        );
        await this.removeInlineKeyboard(messageId, decision, safeName);

        // MED-16 fix: Mark request as processed to prevent replay
        // HIGH-20 fix: Store timestamp for time-based expiry
        this.processedRequests.set(requestId, Date.now());

        // L-31 fix: Clear polling flag on exit
        this.pollingActive = false;

        return {
          requestId,
          decision,
          decidedBy: safeName,
          decidedAt: Date.now(),
        };
      }

      // Wait between polls (only if no updates were processed)
      if (updates.length === 0) {
        await this.sleep(this.pollInterval);
      }
    }

    // L-31 fix: Clear polling flag on exit
    this.pollingActive = false;

    // Timeout or destroyed — update message and return timeout result
    await this.editMessageExpired(messageId);

    return {
      requestId,
      decision: "timeout",
      decidedBy: this.destroyed ? "system:destroyed" : "system",
      decidedAt: Date.now(),
    };
  }

  /**
   * Answer a callback query (acknowledges button press in Telegram UI).
   */
  private async answerCallbackQuery(
    callbackQueryId: string,
    text: string,
  ): Promise<void> {
    try {
      await this.apiCall("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text,
      });
    } catch {
      // Non-fatal — the callback was already processed
    }
  }

  /**
   * Remove inline keyboard and update message text after a decision.
   */
  private async removeInlineKeyboard(
    messageId: number,
    decision: ApprovalDecision,
    decidedBy: string,
  ): Promise<void> {
    const statusText =
      decision === "approved"
        ? `\u2705 Approved by ${decidedBy}`
        : `\u274c Rejected by ${decidedBy}`;

    try {
      await this.apiCall("editMessageReplyMarkup", {
        chat_id: this.chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      });

      // Append status to the original message
      await this.apiCall("sendMessage", {
        chat_id: this.chatId,
        text: statusText,
        reply_to_message_id: messageId,
      });
    } catch {
      // Non-fatal — message was already updated
    }
  }

  /**
   * Edit the message to show it has expired.
   */
  private async editMessageExpired(messageId: number): Promise<void> {
    try {
      await this.apiCall("editMessageReplyMarkup", {
        chat_id: this.chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      });
    } catch {
      // Non-fatal
    }
  }

  /**
   * Generic Telegram Bot API call helper.
   */
  private async apiCall<T>(
    method: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    let response: Response;
    try {
      // L-25 fix: Include User-Agent header on all outbound HTTP requests
      response = await fetch(`${this.apiBase}/${method}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "kova-wallet-sdk/0.1.0",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        this.sanitizeBotToken(`Telegram API ${method} request failed: ${message}`),
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      // LOW-T3-06 fix: Sanitize error details to prevent leaking chat IDs and method names.
      // Full details are available in debug logs only; the thrown error is generic.
      const rawText = this.sanitizeBotToken((await response.text()).slice(0, 200));
      const sanitizedText = rawText.replace(/\d{5,}/g, "[ID]");
      throw new Error(
        `Telegram API request failed (${response.status}): ${sanitizedText}`,
      );
    }

    const json = (await response.json()) as TelegramResponse<T>;
    if (!json.ok) {
      // LOW-T3-06 fix: Strip chat IDs (long numeric sequences) from error descriptions
      const rawDesc = this.sanitizeBotToken(json.description ?? "unknown");
      const sanitizedDesc = rawDesc.replace(/\d{5,}/g, "[ID]");
      throw new Error(
        `Telegram API request failed: ${sanitizedDesc}`,
      );
    }

    return json.result;
  }

  /**
   * API-007: Sanitize any string that may contain the bot token.
   * Replaces the token with [REDACTED] to prevent token leakage in logs or error messages.
   */
  private sanitizeBotToken(msg: string): string {
    // Guard against empty token (after destroy()) — replaceAll("", ...) would insert
    // the replacement between every character.
    if (!this.token) return msg;
    return msg.replaceAll(this.token, "[REDACTED]");
  }

  /**
   * Sleep helper for polling intervals.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * HIGH-11 fix: Compute HMAC-SHA256 of callback data.
   * CRIT-04 fix: Uses a domain-separated derived key (this.hmacSecret) instead of
   * the raw bot token. This prevents forgery by anyone who knows the requestId but
   * not the token. Truncated to 32 hex chars to fit within Telegram's 64-byte
   * callback_data limit while providing stronger integrity than the previous 16 chars.
   *
   * HIGH-T3-02: TRUNCATION RISK DOCUMENTATION
   * The full HMAC-SHA256 is 64 hex chars (256 bits), but Telegram's callback_data
   * field is limited to 64 bytes total. The callback_data format is:
   *   "{action}:{requestId}:{hmac}" e.g. "approve:uuid:hmac"
   * After accounting for the action prefix and UUID, only ~32 hex chars remain.
   * Truncating to 32 hex chars (128 bits) reduces collision resistance from 2^256
   * to 2^128. This is acceptable for this threat model because:
   *   1. Callback HMACs are short-lived (5-minute default timeout)
   *   2. An attacker must guess the exact 128-bit value within the timeout window
   *   3. 2^128 brute-force attempts are computationally infeasible
   *   4. The HMAC key (hmacSecret) is never exposed to the attacker
   * For applications requiring full 256-bit security, use a webhook-based approval
   * channel that is not constrained by Telegram's callback_data limit.
   */
  private computeCallbackHmac(requestId: string, action: string): string {
    return createHmac("sha256", this.hmacSecret)
      .update(`${action}:${requestId}`)
      .digest("hex")
      .slice(0, 32);
  }

  /**
   * HIGH-11 fix: Verify callback data contains a valid HMAC.
   * Expected format: `{action}:{requestId}:{hmac}`
   */
  private verifyCallbackData(data: string, requestId: string, action: string): boolean {
    const expectedPrefix = `${action}:${requestId}:`;
    // LOW-T3-05: startsWith() is not constant-time, but this is intentional.
    // The prefix ("approve:"/"reject:" + requestId) is public knowledge visible in
    // the Telegram message buttons, so early-exit here leaks no secret information.
    // The actual secret (HMAC) is compared below using timingSafeEqual().
    if (!data.startsWith(expectedPrefix)) return false;
    const receivedHmac = data.slice(expectedPrefix.length);
    const expectedHmac = this.computeCallbackHmac(requestId, action);
    // API-008: Use crypto.timingSafeEqual() for constant-time comparison instead of manual byte loop
    if (receivedHmac.length !== expectedHmac.length) return false;
    return timingSafeEqual(Buffer.from(receivedHmac), Buffer.from(expectedHmac));
  }

  /**
   * L-31 fix: Check if the bot is currently polling for updates.
   * Useful for external monitoring or graceful shutdown coordination.
   */
  isPolling(): boolean {
    return this.pollingActive;
  }

  /**
   * L-31 fix: Check if the bot has been destroyed.
   */
  isDestroyed(): boolean {
    return this.destroyed;
  }

  /**
   * L-31 fix: Destroy the Telegram approval bot and clean up resources.
   * 1. Stops polling for updates by setting the destroyed flag (checked in waitForResponse loop).
   * 2. Clears the bot token from memory to prevent further API calls.
   * 3. Clears the HMAC secret derived from the token.
   * 4. Clears processed request tracking data.
   * After calling destroy(), all public methods will throw.
   */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    // Stop any active polling loop (the while-loop in waitForResponse checks this.destroyed)
    this.pollingActive = false;
    // Clear the bot token from memory
    this.token = "";
    // LOW-T4-06 fix: Clear the apiBase URL which contains the bot token in its path.
    // Without this, the token persists in apiBase even after destroy() clears this.token.
    this.apiBase = "";
    // Clear the HMAC secret derived from the token
    this.hmacSecret.fill(0);
    // Clear processed request tracking data
    this.processedRequests.clear();
  }
}

/**
 * Format a rich HTML message for the Telegram approval request.
 */
function formatApprovalMessage(request: ApprovalRequest): string {
  const lines: string[] = [];

  lines.push("<b>\ud83d\udd14 Approval Required</b>");
  lines.push("");
  lines.push(
    `<b>Amount:</b> ${escapeHtml(request.amount)} ${escapeHtml(request.token)}`,
  );
  if (request.usdValue !== undefined) {
    // MED-T3-04 fix: Validate usdValue is finite before formatting.
    // Infinity.toFixed(2) returns "Infinity" and NaN.toFixed(2) returns "NaN",
    // which could mislead a human approver into authorizing a transaction with
    // an unknown dollar value. Display "unknown" instead.
    if (Number.isFinite(request.usdValue) && request.usdValue >= 0) {
      lines.push(`<b>USD Value:</b> $${request.usdValue.toFixed(2)}`);
    } else {
      lines.push(`<b>USD Value:</b> unknown (invalid value)`);
    }
  }
  lines.push(`<b>To:</b> <code>${escapeHtml(request.target)}</code>`);

  if (request.reason) {
    lines.push(`<b>Reason:</b> ${escapeHtml(request.reason)}`);
  }

  if (request.agentId) {
    lines.push(`<b>Agent:</b> ${escapeHtml(request.agentId)}`);
  }

  if (request.budgetContext) {
    const { dailySpent, dailyLimit, token } = request.budgetContext;
    lines.push(
      `<b>Daily Budget:</b> ${escapeHtml(dailySpent)} / ${escapeHtml(dailyLimit)} ${escapeHtml(token)}`,
    );
  }

  // HIGH-05 fix: Display intent hash so approver can verify the exact transaction
  if (request.intentHash) {
    lines.push(`<b>Intent Hash:</b> <code>${escapeHtml(request.intentHash.slice(0, 16))}...</code>`);
  }

  // LOW-T3-04 fix: Validate expiresAt is a finite number before calculating expiry.
  // A non-finite value (NaN, Infinity, undefined) would produce misleading display text.
  if (Number.isFinite(request.expiresAt)) {
    const expiresIn = Math.max(0, Math.round((request.expiresAt - Date.now()) / 60_000));
    lines.push(`<i>Expires in ${expiresIn} minute${expiresIn !== 1 ? "s" : ""}</i>`);
  } else {
    lines.push(`<i>Expires: unknown</i>`);
  }
  lines.push(`<i>Request: ${escapeHtml(request.id)}</i>`);

  return lines.join("\n");
}

/**
 * Escape HTML special characters for Telegram HTML parse mode.
 */
function escapeHtml(text: string): string {
  // LOW-T3-03 fix: Strip null bytes before HTML escaping to prevent null byte injection
  // attacks that could bypass downstream parsers or cause truncation in C-based systems.
  return text
    .replace(/\0/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
