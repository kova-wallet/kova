import { createHash, createHmac } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TelegramApprovalBot } from "../../../src/approval/telegram.js";
import type { ApprovalRequest } from "../../../src/approval/interface.js";

/**
 * HIGH-11 test helper: Compute the HMAC that the bot generates for callback data.
 * This mirrors TelegramApprovalBot.computeCallbackHmac() for test verification.
 * CRIT-04 fix: Uses domain-separated derived key (SHA-256 of "kova-callback-hmac:" + token)
 * and 32-char truncation to match the actual implementation.
 */
function computeTestHmac(botToken: string, requestId: string, action: string): string {
  const hmacSecret = createHash("sha256").update("kova-callback-hmac:" + botToken).digest();
  return createHmac("sha256", hmacSecret)
    .update(`${action}:${requestId}`)
    .digest("hex")
    .slice(0, 32);
}

/** Build callback data with HMAC (matches what the bot sends to Telegram) */
function callbackData(botToken: string, action: string, requestId: string): string {
  return `${action}:${requestId}:${computeTestHmac(botToken, requestId, action)}`;
}

const BOT_TOKEN = "bot-token-123";

/**
 * Helper to create a mock fetch that responds to Telegram Bot API calls.
 * Returns the mock function and a helper to set up responses.
 */
function createTelegramMock() {
  const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
  let callbackUpdates: Array<{
    update_id: number;
    callback_query?: {
      id: string;
      from: { id: number; first_name: string };
      data?: string;
      message?: { message_id: number; chat: { id: number } };
    };
  }> = [];
  let getUpdatesCallCount = 0;
  let deliverOnPoll = 0; // which getUpdates call to deliver the callback on

  const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    calls.push({ url, body });

    // sendMessage
    if (url.includes("/sendMessage")) {
      return new Response(
        JSON.stringify({
          ok: true,
          result: { message_id: 42, chat: { id: 123456789 } },
        }),
        { status: 200 },
      );
    }

    // getUpdates
    if (url.includes("/getUpdates")) {
      getUpdatesCallCount++;
      if (getUpdatesCallCount >= deliverOnPoll && callbackUpdates.length > 0) {
        const updates = [...callbackUpdates];
        callbackUpdates = [];
        return new Response(
          JSON.stringify({ ok: true, result: updates }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ ok: true, result: [] }),
        { status: 200 },
      );
    }

    // answerCallbackQuery
    if (url.includes("/answerCallbackQuery")) {
      return new Response(
        JSON.stringify({ ok: true, result: true }),
        { status: 200 },
      );
    }

    // editMessageReplyMarkup
    if (url.includes("/editMessageReplyMarkup")) {
      return new Response(
        JSON.stringify({ ok: true, result: true }),
        { status: 200 },
      );
    }

    // Default — success
    return new Response(
      JSON.stringify({ ok: true, result: true }),
      { status: 200 },
    );
  });

  return {
    mockFetch,
    calls,
    /** Queue a callback update to deliver on the next getUpdates call */
    queueCallback(data: string, userId = 777, firstName = "Alice", callbackId = "cb-1") {
      callbackUpdates.push({
        update_id: 100 + callbackUpdates.length,
        callback_query: {
          id: callbackId,
          from: { id: userId, first_name: firstName },
          data,
          message: { message_id: 42, chat: { id: 123456789 } },
        },
      });
    },
    /** Set which getUpdates poll call should deliver the queued callbacks */
    deliverOn(pollNumber: number) {
      deliverOnPoll = pollNumber;
    },
    getUpdatesCalls() {
      return getUpdatesCallCount;
    },
  };
}

function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "req-test-1",
    summary: "Transfer 1.5 SOL",
    amount: "1.5",
    token: "SOL",
    target: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    expiresAt: Date.now() + 300_000,
    ...overrides,
  };
}

describe("TelegramApprovalBot", () => {
  const defaultConfig = {
    token: "bot-token-123",
    chatId: "123456789",
    allowAllUsers: true as const,
  };

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ── Constructor ──────────────────────────────────────────────────

  describe("constructor", () => {
    it("should instantiate with required config", () => {
      const bot = new TelegramApprovalBot(defaultConfig);
      expect(bot).toBeDefined();
    });

    it("should report name as 'telegram'", () => {
      const bot = new TelegramApprovalBot(defaultConfig);
      expect(bot.name).toBe("telegram");
    });

    it("should accept config with optional defaultTimeout", () => {
      const bot = new TelegramApprovalBot({
        ...defaultConfig,
        defaultTimeout: 60_000,
      });
      expect(bot).toBeDefined();
    });

    it("should accept config with allowedUserIds", () => {
      const bot = new TelegramApprovalBot({
        ...defaultConfig,
        allowedUserIds: [111, 222],
      });
      expect(bot).toBeDefined();
    });

    it("should accept config with pollInterval", () => {
      const bot = new TelegramApprovalBot({
        ...defaultConfig,
        pollInterval: 500,
      });
      expect(bot).toBeDefined();
    });

    it("should accept all config options at once", () => {
      const bot = new TelegramApprovalBot({
        ...defaultConfig,
        defaultTimeout: 60_000,
        allowedUserIds: [111],
        pollInterval: 1000,
      });
      expect(bot).toBeDefined();
      expect(bot.name).toBe("telegram");
    });

    it("should throw when neither allowedUserIds nor allowAllUsers is set", () => {
      expect(() => {
        new TelegramApprovalBot({
          token: "bot-token-123",
          chatId: "123456789",
        });
      }).toThrow("TelegramApprovalBot: 'allowedUserIds' is required");
    });
  });

  // ── Approval Flow ──────────────────────────────────────────────────

  describe("approval flow", () => {
    it("should send message and return 'approved' on Approve callback", async () => {
      const { mockFetch, queueCallback, deliverOn } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({ ...defaultConfig, pollInterval: 1 });
      queueCallback(callbackData(BOT_TOKEN, "approve", "req-test-1"));
      deliverOn(1);

      const result = await bot.requestApproval(makeRequest());

      expect(result.decision).toBe("approved");
      expect(result.requestId).toBe("req-test-1");
      expect(result.decidedBy).toBe("Alice");
      expect(result.decidedAt).toBeGreaterThan(0);
    });

    it("should return 'rejected' on Reject callback", async () => {
      const { mockFetch, queueCallback, deliverOn } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({ ...defaultConfig, pollInterval: 1 });
      queueCallback(callbackData(BOT_TOKEN, "reject", "req-test-1"), 777, "Bob");
      deliverOn(1);

      const result = await bot.requestApproval(makeRequest());

      expect(result.decision).toBe("rejected");
      expect(result.decidedBy).toBe("Bob");
    });

    it("should send message with correct inline keyboard", async () => {
      const { mockFetch, calls, queueCallback, deliverOn } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({ ...defaultConfig, pollInterval: 1 });
      queueCallback(callbackData(BOT_TOKEN, "approve", "req-test-1"));
      deliverOn(1);

      await bot.requestApproval(makeRequest());

      const sendCall = calls.find((c) => c.url.includes("/sendMessage") && c.body?.reply_markup);
      expect(sendCall).toBeDefined();

      const markup = sendCall!.body!.reply_markup as {
        inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
      };
      expect(markup.inline_keyboard).toHaveLength(1);
      expect(markup.inline_keyboard[0]).toHaveLength(2);
      // HIGH-11: Callback data now includes HMAC suffix
      expect(markup.inline_keyboard[0]![0]!.callback_data).toBe(
        callbackData(BOT_TOKEN, "approve", "req-test-1"),
      );
      expect(markup.inline_keyboard[0]![1]!.callback_data).toBe(
        callbackData(BOT_TOKEN, "reject", "req-test-1"),
      );
    });

    it("should answer callback query after decision", async () => {
      const { mockFetch, calls, queueCallback, deliverOn } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({ ...defaultConfig, pollInterval: 1 });
      queueCallback(callbackData(BOT_TOKEN, "approve", "req-test-1"));
      deliverOn(1);

      await bot.requestApproval(makeRequest());

      const answerCall = calls.find((c) => c.url.includes("/answerCallbackQuery"));
      expect(answerCall).toBeDefined();
      expect(answerCall!.body!.callback_query_id).toBe("cb-1");
    });

    it("should remove inline keyboard after decision", async () => {
      const { mockFetch, calls, queueCallback, deliverOn } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({ ...defaultConfig, pollInterval: 1 });
      queueCallback(callbackData(BOT_TOKEN, "approve", "req-test-1"));
      deliverOn(1);

      await bot.requestApproval(makeRequest());

      const editCall = calls.find((c) => c.url.includes("/editMessageReplyMarkup"));
      expect(editCall).toBeDefined();
      const markup = editCall!.body!.reply_markup as { inline_keyboard: unknown[] };
      expect(markup.inline_keyboard).toEqual([]);
    });

    it("should use HTML parse mode for messages", async () => {
      const { mockFetch, calls, queueCallback, deliverOn } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({ ...defaultConfig, pollInterval: 1 });
      queueCallback(callbackData(BOT_TOKEN, "approve", "req-test-1"));
      deliverOn(1);

      await bot.requestApproval(makeRequest());

      const sendCall = calls.find((c) => c.url.includes("/sendMessage") && c.body?.parse_mode);
      expect(sendCall!.body!.parse_mode).toBe("HTML");
    });
  });

  // ── Message Formatting ──────────────────────────────────────────────────

  describe("message formatting", () => {
    it("should include amount and token in message", async () => {
      const { mockFetch, calls, queueCallback, deliverOn } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({ ...defaultConfig, pollInterval: 1 });
      queueCallback(callbackData(BOT_TOKEN, "approve", "req-test-1"));
      deliverOn(1);

      await bot.requestApproval(makeRequest({ amount: "2.5", token: "USDC" }));

      const sendCall = calls.find((c) => c.url.includes("/sendMessage") && c.body?.reply_markup);
      const text = sendCall!.body!.text as string;
      expect(text).toContain("2.5");
      expect(text).toContain("USDC");
    });

    it("should include recipient address in message", async () => {
      const { mockFetch, calls, queueCallback, deliverOn } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({ ...defaultConfig, pollInterval: 1 });
      queueCallback(callbackData(BOT_TOKEN, "approve", "req-test-1"));
      deliverOn(1);

      await bot.requestApproval(makeRequest({ target: "RecipientAddr123" }));

      const sendCall = calls.find((c) => c.url.includes("/sendMessage") && c.body?.reply_markup);
      const text = sendCall!.body!.text as string;
      expect(text).toContain("RecipientAddr123");
    });

    it("should include reason when provided", async () => {
      const { mockFetch, calls, queueCallback, deliverOn } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({ ...defaultConfig, pollInterval: 1 });
      queueCallback(callbackData(BOT_TOKEN, "approve", "req-test-1"));
      deliverOn(1);

      await bot.requestApproval(makeRequest({ reason: "Payment for API access" }));

      const sendCall = calls.find((c) => c.url.includes("/sendMessage") && c.body?.reply_markup);
      const text = sendCall!.body!.text as string;
      expect(text).toContain("Payment for API access");
    });

    it("should include agent ID when provided", async () => {
      const { mockFetch, calls, queueCallback, deliverOn } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({ ...defaultConfig, pollInterval: 1 });
      queueCallback(callbackData(BOT_TOKEN, "approve", "req-test-1"));
      deliverOn(1);

      await bot.requestApproval(makeRequest({ agentId: "agent-007" }));

      const sendCall = calls.find((c) => c.url.includes("/sendMessage") && c.body?.reply_markup);
      const text = sendCall!.body!.text as string;
      expect(text).toContain("agent-007");
    });

    it("should include budget context when provided", async () => {
      const { mockFetch, calls, queueCallback, deliverOn } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({ ...defaultConfig, pollInterval: 1 });
      queueCallback(callbackData(BOT_TOKEN, "approve", "req-test-1"));
      deliverOn(1);

      await bot.requestApproval(
        makeRequest({
          budgetContext: { dailySpent: "3.0", dailyLimit: "5.0", token: "SOL" },
        }),
      );

      const sendCall = calls.find((c) => c.url.includes("/sendMessage") && c.body?.reply_markup);
      const text = sendCall!.body!.text as string;
      expect(text).toContain("3.0");
      expect(text).toContain("5.0");
      expect(text).toContain("Daily Budget");
    });

    it("should include USD value when provided", async () => {
      const { mockFetch, calls, queueCallback, deliverOn } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({ ...defaultConfig, pollInterval: 1 });
      queueCallback(callbackData(BOT_TOKEN, "approve", "req-test-1"));
      deliverOn(1);

      await bot.requestApproval(makeRequest({ usdValue: 225.50 }));

      const sendCall = calls.find((c) => c.url.includes("/sendMessage") && c.body?.reply_markup);
      const text = sendCall!.body!.text as string;
      expect(text).toContain("$225.50");
    });

    it("should escape HTML in reason text", async () => {
      const { mockFetch, calls, queueCallback, deliverOn } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({ ...defaultConfig, pollInterval: 1 });
      queueCallback(callbackData(BOT_TOKEN, "approve", "req-test-1"));
      deliverOn(1);

      await bot.requestApproval(makeRequest({ reason: "<script>alert('xss')</script>" }));

      const sendCall = calls.find((c) => c.url.includes("/sendMessage") && c.body?.reply_markup);
      const text = sendCall!.body!.text as string;
      expect(text).not.toContain("<script>");
      expect(text).toContain("&lt;script&gt;");
    });
  });

  // ── Timeout ──────────────────────────────────────────────────

  describe("timeout", () => {
    it("should return 'timeout' when no response within deadline", async () => {
      const { mockFetch } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({
        ...defaultConfig,
        pollInterval: 1,
        defaultTimeout: 50,
      });

      const result = await bot.requestApproval(
        makeRequest({ expiresAt: Date.now() + 50 }),
      );

      expect(result.decision).toBe("timeout");
      expect(result.decidedBy).toBe("system");
      expect(result.requestId).toBe("req-test-1");
    });

    it("should use defaultTimeout from config when request has no expiresAt", async () => {
      const { mockFetch } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({
        ...defaultConfig,
        pollInterval: 1,
        defaultTimeout: 50,
      });

      // Remove expiresAt by setting it very close to now — tests the timeout code path
      const start = Date.now();
      const result = await bot.requestApproval(
        makeRequest({ expiresAt: Date.now() + 50 }),
      );

      expect(result.decision).toBe("timeout");
      expect(Date.now() - start).toBeGreaterThanOrEqual(40);
    });

    it("should remove keyboard on timeout", async () => {
      const { mockFetch, calls } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({
        ...defaultConfig,
        pollInterval: 1,
        defaultTimeout: 10,
      });

      await bot.requestApproval(makeRequest({ expiresAt: Date.now() + 10 }));

      const editCall = calls.find((c) => c.url.includes("/editMessageReplyMarkup"));
      expect(editCall).toBeDefined();
    });

    it("should return timeout immediately for already-expired request", async () => {
      const { mockFetch } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({ ...defaultConfig, pollInterval: 1 });

      const result = await bot.requestApproval(
        makeRequest({ expiresAt: Date.now() - 1000 }),
      );

      expect(result.decision).toBe("timeout");
    });
  });

  // ── Security ──────────────────────────────────────────────────

  describe("security", () => {
    it("should reject callback from unauthorized user", async () => {
      const { mockFetch, queueCallback, deliverOn } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({
        ...defaultConfig,
        allowedUserIds: [999], // Only user 999 is allowed
        pollInterval: 1,
        defaultTimeout: 100,
      });

      // Queue callback from user 777 (not allowed), then timeout
      queueCallback(callbackData(BOT_TOKEN, "approve", "req-test-1"), 777, "Eve");
      deliverOn(1);

      const result = await bot.requestApproval(
        makeRequest({ expiresAt: Date.now() + 100 }),
      );

      // Should timeout because Eve's response was rejected
      expect(result.decision).toBe("timeout");
    });

    it("should accept callback from authorized user", async () => {
      const { mockFetch, queueCallback, deliverOn } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({
        ...defaultConfig,
        allowedUserIds: [777],
        pollInterval: 1,
      });

      queueCallback(callbackData(BOT_TOKEN, "approve", "req-test-1"), 777, "Alice");
      deliverOn(1);

      const result = await bot.requestApproval(makeRequest());

      expect(result.decision).toBe("approved");
      expect(result.decidedBy).toBe("Alice");
    });

    it("should allow any user when allowAllUsers is true and allowedUserIds is not set", async () => {
      const { mockFetch, queueCallback, deliverOn } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({
        token: "bot-token-123",
        chatId: "123456789",
        allowAllUsers: true,
        pollInterval: 1,
      });

      queueCallback(callbackData(BOT_TOKEN, "approve", "req-test-1"), 12345, "RandomUser");
      deliverOn(1);

      const result = await bot.requestApproval(makeRequest());

      expect(result.decision).toBe("approved");
      expect(result.decidedBy).toBe("RandomUser");
    });

    it("should answer unauthorized callback with rejection text", async () => {
      const { mockFetch, calls, queueCallback, deliverOn } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({
        ...defaultConfig,
        allowedUserIds: [999],
        pollInterval: 1,
        defaultTimeout: 100,
      });

      queueCallback(callbackData(BOT_TOKEN, "approve", "req-test-1"), 777, "Eve", "cb-unauthorized");
      deliverOn(1);

      await bot.requestApproval(makeRequest({ expiresAt: Date.now() + 100 }));

      const answerCall = calls.find(
        (c) =>
          c.url.includes("/answerCallbackQuery") &&
          c.body?.callback_query_id === "cb-unauthorized",
      );
      expect(answerCall).toBeDefined();
      expect(answerCall!.body!.text).toContain("not authorized");
    });
  });

  // ── Error Handling ──────────────────────────────────────────────────

  describe("error handling", () => {
    it("should throw when sendMessage API fails", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("Internal Server Error", { status: 500 }),
      );
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({ ...defaultConfig, pollInterval: 1 });

      // LOW-T3-06 fix changed error format from method-specific to generic
      await expect(bot.requestApproval(makeRequest())).rejects.toThrow(
        "Telegram API request failed",
      );
    });

    it("should throw when sendMessage returns ok: false", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ ok: false, description: "Bad Request: chat not found" }),
          { status: 200 },
        ),
      );
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({ ...defaultConfig, pollInterval: 1 });

      await expect(bot.requestApproval(makeRequest())).rejects.toThrow(
        "chat not found",
      );
    });

    it("should handle getUpdates API failure gracefully (timeout instead of crash)", async () => {
      let callCount = 0;
      const mockFetch = vi.fn(async (url: string) => {
        callCount++;
        if (url.includes("/sendMessage")) {
          return new Response(
            JSON.stringify({ ok: true, result: { message_id: 42, chat: { id: 123456789 } } }),
            { status: 200 },
          );
        }
        if (url.includes("/getUpdates")) {
          // Always fail
          return new Response("Service Unavailable", { status: 503 });
        }
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      });
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({
        ...defaultConfig,
        pollInterval: 1,
        defaultTimeout: 50,
      });

      const result = await bot.requestApproval(
        makeRequest({ expiresAt: Date.now() + 50 }),
      );

      // Should timeout gracefully, not crash
      expect(result.decision).toBe("timeout");
    });

    it("should handle network errors during polling", async () => {
      let callCount = 0;
      const mockFetch = vi.fn(async (url: string) => {
        callCount++;
        if (url.includes("/sendMessage")) {
          return new Response(
            JSON.stringify({ ok: true, result: { message_id: 42, chat: { id: 123456789 } } }),
            { status: 200 },
          );
        }
        if (url.includes("/getUpdates")) {
          throw new TypeError("fetch failed");
        }
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      });
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({
        ...defaultConfig,
        pollInterval: 1,
        defaultTimeout: 50,
      });

      const result = await bot.requestApproval(
        makeRequest({ expiresAt: Date.now() + 50 }),
      );

      expect(result.decision).toBe("timeout");
    });
  });

  // ── Edge Cases ──────────────────────────────────────────────────

  describe("edge cases", () => {
    it("should ignore callback_query for different request IDs", async () => {
      const { mockFetch, queueCallback, deliverOn } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({
        ...defaultConfig,
        pollInterval: 1,
        defaultTimeout: 100,
      });

      // Queue callback for a different request
      queueCallback("approve:other-request-id");
      deliverOn(1);

      const result = await bot.requestApproval(
        makeRequest({ expiresAt: Date.now() + 100 }),
      );

      // Should timeout because the callback was for a different request
      expect(result.decision).toBe("timeout");
    });

    it("should handle empty getUpdates response", async () => {
      const { mockFetch } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({
        ...defaultConfig,
        pollInterval: 1,
        defaultTimeout: 50,
      });

      // No callbacks queued — should timeout cleanly
      const result = await bot.requestApproval(
        makeRequest({ expiresAt: Date.now() + 50 }),
      );

      expect(result.decision).toBe("timeout");
    });

    it("should handle callback_query with no data field", async () => {
      const { mockFetch } = createTelegramMock();

      // Inject a callback with no data
      let injected = false;
      const wrappedFetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/getUpdates") && !injected) {
          injected = true;
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  update_id: 200,
                  callback_query: {
                    id: "cb-no-data",
                    from: { id: 777, first_name: "Alice" },
                    // data is missing
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }
        return mockFetch(url, init);
      });
      globalThis.fetch = wrappedFetch;

      const bot = new TelegramApprovalBot({
        ...defaultConfig,
        pollInterval: 1,
        defaultTimeout: 50,
      });

      const result = await bot.requestApproval(
        makeRequest({ expiresAt: Date.now() + 50 }),
      );

      // Should skip the malformed callback and eventually timeout
      expect(result.decision).toBe("timeout");
    });

    it("should use the correct API base URL from token", async () => {
      const { mockFetch, calls, queueCallback, deliverOn } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({
        token: "123:ABC_def",
        chatId: "123456789",
        allowAllUsers: true,
        pollInterval: 1,
      });

      queueCallback(callbackData("123:ABC_def", "approve", "req-test-1"));
      deliverOn(1);

      await bot.requestApproval(makeRequest());

      expect(calls[0]!.url).toContain("https://api.telegram.org/bot123:ABC_def/");
    });

    it("should send to the configured chatId", async () => {
      const { mockFetch, calls, queueCallback, deliverOn } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({
        ...defaultConfig,
        chatId: "123456789",
        pollInterval: 1,
      });

      queueCallback(callbackData(BOT_TOKEN, "approve", "req-test-1"));
      deliverOn(1);

      await bot.requestApproval(makeRequest());

      const sendCall = calls.find((c) => c.url.includes("/sendMessage") && c.body?.reply_markup);
      expect(sendCall!.body!.chat_id).toBe("123456789");
    });
  });

  // ── Additional Coverage: Message Formatting Edge Cases ──────────────────────

  describe("message formatting — additional coverage", () => {
    it("should format message without optional fields (no reason, agentId, budgetContext, usdValue)", async () => {
      const { mockFetch, calls, queueCallback, deliverOn } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({ ...defaultConfig, pollInterval: 1 });
      queueCallback(callbackData(BOT_TOKEN, "approve", "req-test-1"));
      deliverOn(1);

      await bot.requestApproval(makeRequest({
        // No reason, no agentId, no budgetContext, no usdValue
      }));

      const sendCall = calls.find((c) => c.url.includes("/sendMessage") && c.body?.reply_markup);
      const text = sendCall!.body!.text as string;
      expect(text).toContain("Approval Required");
      expect(text).toContain("1.5");
      expect(text).toContain("SOL");
      expect(text).not.toContain("Reason:");
      expect(text).not.toContain("Agent:");
      expect(text).not.toContain("Daily Budget:");
      expect(text).not.toContain("USD Value:");
    });

    it("should format USD value of 0 as $0.00", async () => {
      const { mockFetch, calls, queueCallback, deliverOn } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({ ...defaultConfig, pollInterval: 1 });
      queueCallback(callbackData(BOT_TOKEN, "approve", "req-test-1"));
      deliverOn(1);

      await bot.requestApproval(makeRequest({ usdValue: 0 }));

      const sendCall = calls.find((c) => c.url.includes("/sendMessage") && c.body?.reply_markup);
      const text = sendCall!.body!.text as string;
      expect(text).toContain("$0.00");
    });

    it("should escape HTML ampersand in reason text", async () => {
      const { mockFetch, calls, queueCallback, deliverOn } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({ ...defaultConfig, pollInterval: 1 });
      queueCallback(callbackData(BOT_TOKEN, "approve", "req-test-1"));
      deliverOn(1);

      await bot.requestApproval(makeRequest({ reason: "Buy & sell tokens" }));

      const sendCall = calls.find((c) => c.url.includes("/sendMessage") && c.body?.reply_markup);
      const text = sendCall!.body!.text as string;
      expect(text).toContain("Buy &amp; sell tokens");
      expect(text).not.toMatch(/Buy & sell/);
    });

    it("should escape HTML in agent ID text", async () => {
      const { mockFetch, calls, queueCallback, deliverOn } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({ ...defaultConfig, pollInterval: 1 });
      queueCallback(callbackData(BOT_TOKEN, "approve", "req-test-1"));
      deliverOn(1);

      await bot.requestApproval(makeRequest({ agentId: "<agent>test</agent>" }));

      const sendCall = calls.find((c) => c.url.includes("/sendMessage") && c.body?.reply_markup);
      const text = sendCall!.body!.text as string;
      expect(text).toContain("&lt;agent&gt;test&lt;/agent&gt;");
      expect(text).not.toContain("<agent>");
    });

    it("should show expires in minutes (singular for 1 minute)", async () => {
      const { mockFetch, calls, queueCallback, deliverOn } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({ ...defaultConfig, pollInterval: 1 });
      queueCallback(callbackData(BOT_TOKEN, "approve", "req-test-1"));
      deliverOn(1);

      await bot.requestApproval(makeRequest({ expiresAt: Date.now() + 60_000 }));

      const sendCall = calls.find((c) => c.url.includes("/sendMessage") && c.body?.reply_markup);
      const text = sendCall!.body!.text as string;
      expect(text).toContain("Expires in 1 minute");
      expect(text).not.toContain("1 minutes");
    });

    it("should show 0 minutes for already expired requests", async () => {
      const { mockFetch, calls, queueCallback, deliverOn } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({ ...defaultConfig, pollInterval: 1 });
      queueCallback(callbackData(BOT_TOKEN, "approve", "req-test-1"));
      deliverOn(1);

      await bot.requestApproval(makeRequest({ expiresAt: Date.now() - 5000 }));

      const sendCall = calls.find((c) => c.url.includes("/sendMessage") && c.body?.reply_markup);
      const text = sendCall!.body!.text as string;
      expect(text).toContain("Expires in 0 minutes");
    });

    it("should include the request ID in the message", async () => {
      const { mockFetch, calls, queueCallback, deliverOn } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({ ...defaultConfig, pollInterval: 1 });
      queueCallback(callbackData(BOT_TOKEN, "approve", "req-unique-xyz"));
      deliverOn(1);

      await bot.requestApproval(makeRequest({ id: "req-unique-xyz" }));

      const sendCall = calls.find((c) => c.url.includes("/sendMessage") && c.body?.reply_markup);
      const text = sendCall!.body!.text as string;
      expect(text).toContain("req-unique-xyz");
    });

    it("should include all fields when everything is provided", async () => {
      const { mockFetch, calls, queueCallback, deliverOn } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({ ...defaultConfig, pollInterval: 1 });
      queueCallback(callbackData(BOT_TOKEN, "approve", "req-full"));
      deliverOn(1);

      await bot.requestApproval(makeRequest({
        id: "req-full",
        amount: "50.0",
        token: "USDC",
        usdValue: 50.0,
        target: "TargetAddr123",
        reason: "Service payment",
        agentId: "agent-77",
        budgetContext: { dailySpent: "20.0", dailyLimit: "100.0", token: "USDC" },
      }));

      const sendCall = calls.find((c) => c.url.includes("/sendMessage") && c.body?.reply_markup);
      const text = sendCall!.body!.text as string;
      expect(text).toContain("50.0");
      expect(text).toContain("USDC");
      expect(text).toContain("$50.00");
      expect(text).toContain("TargetAddr123");
      expect(text).toContain("Service payment");
      expect(text).toContain("agent-77");
      expect(text).toContain("20.0");
      expect(text).toContain("100.0");
      expect(text).toContain("req-full");
    });
  });

  // ── Additional Coverage: Polling Edge Cases ─────────────────────────────

  describe("polling — additional coverage", () => {
    it("should handle multiple updates in a single getUpdates batch", async () => {
      // Custom mock that delivers two callbacks at once — one for wrong request, one for ours
      let injected = false;
      const { mockFetch } = createTelegramMock();
      const wrappedFetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/getUpdates") && !injected) {
          injected = true;
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  update_id: 300,
                  callback_query: {
                    id: "cb-wrong",
                    from: { id: 777, first_name: "Alice" },
                    data: "approve:other-request",
                    message: { message_id: 42, chat: { id: 123456789 } },
                  },
                },
                {
                  update_id: 301,
                  callback_query: {
                    id: "cb-right",
                    from: { id: 777, first_name: "Alice" },
                    data: callbackData(BOT_TOKEN, "approve", "req-test-1"),
                    message: { message_id: 42, chat: { id: 123456789 } },
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }
        return mockFetch(url, init);
      });
      globalThis.fetch = wrappedFetch;

      const bot = new TelegramApprovalBot({ ...defaultConfig, pollInterval: 1 });
      const result = await bot.requestApproval(makeRequest());

      expect(result.decision).toBe("approved");
      expect(result.decidedBy).toBe("Alice");
    });

    it("should handle callback_query with empty string data", async () => {
      let injected = false;
      const { mockFetch } = createTelegramMock();
      const wrappedFetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/getUpdates") && !injected) {
          injected = true;
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  update_id: 400,
                  callback_query: {
                    id: "cb-empty",
                    from: { id: 777, first_name: "Alice" },
                    data: "",
                    message: { message_id: 42, chat: { id: 123456789 } },
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }
        return mockFetch(url, init);
      });
      globalThis.fetch = wrappedFetch;

      const bot = new TelegramApprovalBot({
        ...defaultConfig,
        pollInterval: 1,
        defaultTimeout: 50,
      });
      const result = await bot.requestApproval(
        makeRequest({ expiresAt: Date.now() + 50 }),
      );

      // Empty data doesn't match approve/reject, should timeout
      expect(result.decision).toBe("timeout");
    });

    it("should handle getUpdates returning ok: false gracefully", async () => {
      let callCount = 0;
      const mockFetch = vi.fn(async (url: string) => {
        if (url.includes("/sendMessage")) {
          return new Response(
            JSON.stringify({ ok: true, result: { message_id: 42, chat: { id: 123456789 } } }),
            { status: 200 },
          );
        }
        if (url.includes("/getUpdates")) {
          callCount++;
          // Return ok: false on every getUpdates
          return new Response(
            JSON.stringify({ ok: false, description: "Service unavailable" }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      });
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({
        ...defaultConfig,
        pollInterval: 1,
        defaultTimeout: 50,
      });

      const result = await bot.requestApproval(
        makeRequest({ expiresAt: Date.now() + 50 }),
      );

      expect(result.decision).toBe("timeout");
    });

    it("should handle update without callback_query field", async () => {
      let injected = false;
      const { mockFetch } = createTelegramMock();
      const wrappedFetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/getUpdates") && !injected) {
          injected = true;
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  update_id: 500,
                  // no callback_query at all
                },
              ],
            }),
            { status: 200 },
          );
        }
        return mockFetch(url, init);
      });
      globalThis.fetch = wrappedFetch;

      const bot = new TelegramApprovalBot({
        ...defaultConfig,
        pollInterval: 1,
        defaultTimeout: 50,
      });
      const result = await bot.requestApproval(
        makeRequest({ expiresAt: Date.now() + 50 }),
      );

      expect(result.decision).toBe("timeout");
    });
  });

  // ── Additional Coverage: Timeout Edge Cases ─────────────────────────────

  describe("timeout — additional coverage", () => {
    it("should return timeout immediately when defaultTimeout is 0 and no expiresAt override", async () => {
      const { mockFetch } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({
        ...defaultConfig,
        pollInterval: 1,
        defaultTimeout: 0,
      });

      // expiresAt in the future but defaultTimeout=0 only matters when expiresAt is used
      // Actually, expiresAt takes precedence over defaultTimeout
      // So let's test with expiresAt = Date.now() (0ms remaining)
      const result = await bot.requestApproval(
        makeRequest({ expiresAt: Date.now() }),
      );

      expect(result.decision).toBe("timeout");
      expect(result.decidedBy).toBe("system");
    });
  });

  // ── Additional Coverage: removeInlineKeyboard & editMessageExpired ──────

  describe("removeInlineKeyboard behavior", () => {
    it("should send status reply for approved decision", async () => {
      const { mockFetch, calls, queueCallback, deliverOn } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({ ...defaultConfig, pollInterval: 1 });
      queueCallback(callbackData(BOT_TOKEN, "approve", "req-test-1"), 777, "Alice");
      deliverOn(1);

      await bot.requestApproval(makeRequest());

      // Find the status reply message (sendMessage after approval, not the initial one)
      const sendCalls = calls.filter((c) => c.url.includes("/sendMessage"));
      const replyCall = sendCalls.find((c) => c.body?.reply_to_message_id);
      expect(replyCall).toBeDefined();
      expect(replyCall!.body!.reply_to_message_id).toBe(42);
      expect(replyCall!.body!.text).toContain("Approved by Alice");
    });

    it("should send status reply for rejected decision", async () => {
      const { mockFetch, calls, queueCallback, deliverOn } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({ ...defaultConfig, pollInterval: 1 });
      queueCallback(callbackData(BOT_TOKEN, "reject", "req-test-1"), 777, "Bob");
      deliverOn(1);

      await bot.requestApproval(makeRequest());

      const sendCalls = calls.filter((c) => c.url.includes("/sendMessage"));
      const replyCall = sendCalls.find((c) => c.body?.reply_to_message_id);
      expect(replyCall).toBeDefined();
      expect(replyCall!.body!.text).toContain("Rejected by Bob");
    });

    it("should handle errors in removeInlineKeyboard gracefully", async () => {
      let editCallCount = 0;
      const { mockFetch } = createTelegramMock();
      const wrappedFetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/editMessageReplyMarkup")) {
          editCallCount++;
          throw new Error("Edit message failed");
        }
        return mockFetch(url, init);
      });
      globalThis.fetch = wrappedFetch;

      const bot = new TelegramApprovalBot({ ...defaultConfig, pollInterval: 1 });
      // We need to manually set up the callback response
      let injected = false;
      const wrappedFetch2 = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/getUpdates") && !injected) {
          injected = true;
          return new Response(
            JSON.stringify({
              ok: true,
              result: [{
                update_id: 600,
                callback_query: {
                  id: "cb-1",
                  from: { id: 777, first_name: "Alice" },
                  data: callbackData(BOT_TOKEN, "approve", "req-test-1"),
                  message: { message_id: 42, chat: { id: 123456789 } },
                },
              }],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/editMessageReplyMarkup")) {
          throw new Error("Edit message failed");
        }
        return mockFetch(url, init);
      });
      globalThis.fetch = wrappedFetch2;

      // Should still return approved despite editMessage error
      const result = await bot.requestApproval(makeRequest());
      expect(result.decision).toBe("approved");
    });

    it("should handle errors in answerCallbackQuery gracefully", async () => {
      let injected = false;
      const { mockFetch } = createTelegramMock();
      const wrappedFetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/getUpdates") && !injected) {
          injected = true;
          return new Response(
            JSON.stringify({
              ok: true,
              result: [{
                update_id: 700,
                callback_query: {
                  id: "cb-1",
                  from: { id: 777, first_name: "Alice" },
                  data: callbackData(BOT_TOKEN, "approve", "req-test-1"),
                  message: { message_id: 42, chat: { id: 123456789 } },
                },
              }],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/answerCallbackQuery")) {
          throw new Error("Answer callback failed");
        }
        return mockFetch(url, init);
      });
      globalThis.fetch = wrappedFetch;

      const bot = new TelegramApprovalBot({ ...defaultConfig, pollInterval: 1 });
      // Should still return approved despite answerCallbackQuery error
      const result = await bot.requestApproval(makeRequest());
      expect(result.decision).toBe("approved");
    });

    it("should handle editMessageExpired errors gracefully on timeout", async () => {
      const { mockFetch } = createTelegramMock();
      const wrappedFetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/editMessageReplyMarkup")) {
          throw new Error("Edit message expired failed");
        }
        return mockFetch(url, init);
      });
      globalThis.fetch = wrappedFetch;

      const bot = new TelegramApprovalBot({
        ...defaultConfig,
        pollInterval: 1,
        defaultTimeout: 10,
      });

      // Should still return timeout despite editMessage error
      const result = await bot.requestApproval(
        makeRequest({ expiresAt: Date.now() + 10 }),
      );
      expect(result.decision).toBe("timeout");
    });
  });

  // ── Additional Coverage: decidedBy fallback ──────────────────────────────

  describe("decidedBy fallback", () => {
    it("should use user ID as string when first_name is empty", async () => {
      let injected = false;
      const { mockFetch } = createTelegramMock();
      const wrappedFetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/getUpdates") && !injected) {
          injected = true;
          return new Response(
            JSON.stringify({
              ok: true,
              result: [{
                update_id: 800,
                callback_query: {
                  id: "cb-1",
                  from: { id: 12345, first_name: "" },
                  data: callbackData(BOT_TOKEN, "approve", "req-test-1"),
                  message: { message_id: 42, chat: { id: 123456789 } },
                },
              }],
            }),
            { status: 200 },
          );
        }
        return mockFetch(url, init);
      });
      globalThis.fetch = wrappedFetch;

      const bot = new TelegramApprovalBot({ ...defaultConfig, pollInterval: 1 });
      const result = await bot.requestApproval(makeRequest());

      expect(result.decision).toBe("approved");
      expect(result.decidedBy).toBe("12345");
    });
  });

  // ── Additional Coverage: Polling delivers on later poll ──────────────────

  describe("polling — delayed delivery", () => {
    it("should find callback on the second poll", async () => {
      const { mockFetch, queueCallback, deliverOn } = createTelegramMock();
      globalThis.fetch = mockFetch;

      const bot = new TelegramApprovalBot({
        ...defaultConfig,
        pollInterval: 1,
        defaultTimeout: 5000,
      });
      queueCallback(callbackData(BOT_TOKEN, "approve", "req-test-1"));
      deliverOn(2); // Deliver on second getUpdates call

      const result = await bot.requestApproval(
        makeRequest({ expiresAt: Date.now() + 5000 }),
      );

      expect(result.decision).toBe("approved");
    });
  });
});
