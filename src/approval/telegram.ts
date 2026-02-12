/**
 * TelegramApprovalBot — Sends approval requests to Telegram and waits for human decision.
 *
 * Uses the raw Telegram Bot API via fetch (no external dependencies).
 * Flow: sendMessage with inline keyboard → poll getUpdates for callback_query → return decision.
 */

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
  /** Whitelist of Telegram user IDs allowed to approve/reject. If not set, any user can respond. */
  allowedUserIds?: number[];
  /** Polling interval in ms between getUpdates calls (defaults to 2000) */
  pollInterval?: number;
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

export class TelegramApprovalBot implements ApprovalChannel {
  readonly name = "telegram";
  private readonly token: string;
  private readonly chatId: string;
  private readonly defaultTimeout: number;
  private readonly allowedUserIds?: number[];
  private readonly pollInterval: number;
  private readonly apiBase: string;

  constructor(config: TelegramApprovalBotConfig) {
    this.token = config.token;
    this.chatId = config.chatId;
    this.defaultTimeout = config.defaultTimeout ?? DEFAULT_TIMEOUT_MS;
    this.allowedUserIds = config.allowedUserIds;
    this.pollInterval = config.pollInterval ?? DEFAULT_POLL_INTERVAL_MS;
    this.apiBase = `https://api.telegram.org/bot${config.token}`;
  }

  /**
   * Send an approval request to Telegram and block until a human responds or timeout.
   */
  async requestApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    const message = formatApprovalMessage(request);
    const sent = await this.sendMessage(message, request.id);

    const timeoutMs = request.expiresAt
      ? Math.max(0, request.expiresAt - Date.now())
      : this.defaultTimeout;

    return this.waitForResponse(request.id, sent.message_id, timeoutMs);
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
              callback_data: `approve:${requestId}`,
            },
            {
              text: "\u274c Reject",
              callback_data: `reject:${requestId}`,
            },
          ],
        ],
      },
    };

    const data = await this.apiCall<TelegramMessage>("sendMessage", body);
    return data;
  }

  /**
   * Poll for callback_query updates matching the request ID.
   * Returns when user responds or timeout is reached.
   */
  private async waitForResponse(
    requestId: string,
    messageId: number,
    timeoutMs: number,
  ): Promise<ApprovalResult> {
    const deadline = Date.now() + timeoutMs;
    let lastUpdateOffset = 0;

    while (Date.now() < deadline) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;

      let updates: TelegramUpdate[];
      try {
        const params = new URLSearchParams({
          offset: String(lastUpdateOffset),
          timeout: String(TELEGRAM_LONG_POLL_TIMEOUT),
          allowed_updates: JSON.stringify(["callback_query"]),
        });

        const response = await fetch(
          `${this.apiBase}/getUpdates?${params.toString()}`,
        );
        if (!response.ok) {
          // Transient API failure — wait and retry
          await this.sleep(this.pollInterval);
          continue;
        }
        const json = (await response.json()) as TelegramResponse<
          TelegramUpdate[]
        >;
        if (!json.ok) {
          await this.sleep(this.pollInterval);
          continue;
        }
        updates = json.result;
      } catch {
        // Network error — wait and retry
        await this.sleep(this.pollInterval);
        continue;
      }

      for (const update of updates) {
        // Always advance the offset to avoid re-processing
        lastUpdateOffset = Math.max(lastUpdateOffset, update.update_id + 1);

        if (!update.callback_query?.data) continue;

        const { id: callbackId, from, data, message: cbMessage } = update.callback_query;

        // MED-14 fix: Validate the callback came from our chat
        if (cbMessage && String(cbMessage.chat.id) !== this.chatId) {
          continue; // Callback from a different chat — ignore
        }

        // Check if this callback is for our request
        const isApprove = data === `approve:${requestId}`;
        const isReject = data === `reject:${requestId}`;
        if (!isApprove && !isReject) continue;

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

    // Timeout — update message and return timeout result
    await this.editMessageExpired(messageId);

    return {
      requestId,
      decision: "timeout",
      decidedBy: "system",
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
    const response = await fetch(`${this.apiBase}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = (await response.text()).slice(0, 200).replaceAll(this.token, "[REDACTED]");
      throw new Error(
        `Telegram API ${method} failed (${response.status}): ${text}`,
      );
    }

    const json = (await response.json()) as TelegramResponse<T>;
    if (!json.ok) {
      const desc = (json.description ?? "unknown").replaceAll(this.token, "[REDACTED]");
      throw new Error(
        `Telegram API ${method} returned error: ${desc}`,
      );
    }

    return json.result;
  }

  /**
   * Sleep helper for polling intervals.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
    lines.push(`<b>USD Value:</b> $${request.usdValue.toFixed(2)}`);
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

  const expiresIn = Math.max(0, Math.round((request.expiresAt - Date.now()) / 60_000));
  lines.push(`<i>Expires in ${expiresIn} minute${expiresIn !== 1 ? "s" : ""}</i>`);
  lines.push(`<i>Request: ${escapeHtml(request.id)}</i>`);

  return lines.join("\n");
}

/**
 * Escape HTML special characters for Telegram HTML parse mode.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
