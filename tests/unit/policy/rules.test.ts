import { describe, it, expect } from "vitest";
import { AllowlistRule } from "../../../src/policy/rules/allowlist.js";
import { SpendingLimitRule } from "../../../src/policy/rules/spending-limit.js";
import { RateLimitRule } from "../../../src/policy/rules/rate-limit.js";
import { TimeWindowRule } from "../../../src/policy/rules/time-window.js";
import { ApprovalGateRule } from "../../../src/policy/rules/approval-gate.js";
import { MemoryStore } from "../../../src/stores/memory.js";
import type { TransactionIntent } from "../../../src/core/intent.js";
import type { PolicyContext } from "../../../src/policy/types.js";
import type { ApprovalChannel, ApprovalResult } from "../../../src/approval/interface.js";

function makeIntent(overrides?: Partial<TransactionIntent>): TransactionIntent {
  return {
    id: "test-intent-1",
    type: "transfer",
    chain: "solana",
    params: { to: "RecipientAddr1234567890abcdef", amount: "1.0", token: "SOL" },
    ...overrides,
  };
}

function makeContext(overrides?: Partial<PolicyContext>): PolicyContext {
  return {
    store: new MemoryStore(),
    now: Date.now(),
    ...overrides,
  };
}

function makeApprovalChannel(decision: ApprovalResult["decision"] = "approved"): ApprovalChannel {
  return {
    name: "mock",
    requestApproval: async (req) => ({
      requestId: req.id,
      decision,
      decidedAt: Date.now(),
    }),
  };
}

// ─────────────────────────────────────────────────
// AllowlistRule
// ─────────────────────────────────────────────────
describe("AllowlistRule", () => {
  it("should instantiate with a name of 'allowlist'", () => {
    const rule = new AllowlistRule({});
    expect(rule.name).toBe("allowlist");
  });

  it("should ALLOW when no allow/deny lists are configured", async () => {
    const rule = new AllowlistRule({});
    const result = await rule.evaluate(makeIntent(), makeContext());
    expect(result.decision).toBe("ALLOW");
  });

  it("should DENY when target address is in denyAddresses", async () => {
    const rule = new AllowlistRule({
      denyAddresses: ["RecipientAddr1234567890abcdef"],
    });
    const result = await rule.evaluate(makeIntent(), makeContext());
    expect(result.decision).toBe("DENY");
    if (result.decision === "DENY") {
      // H-38 fix: generic denial message, no longer says "denylisted"
      expect(result.reason).toContain("not permitted");
    }
  });

  it("should DENY when target address is NOT in allowAddresses", async () => {
    const rule = new AllowlistRule({
      allowAddresses: ["OtherAddr123"],
    });
    const result = await rule.evaluate(makeIntent(), makeContext());
    expect(result.decision).toBe("DENY");
    if (result.decision === "DENY") {
      // H-38 fix: generic denial message
      expect(result.reason).toContain("not in allowlist");
    }
  });

  it("should ALLOW when target address is in allowAddresses", async () => {
    const rule = new AllowlistRule({
      allowAddresses: ["RecipientAddr1234567890abcdef"],
    });
    const result = await rule.evaluate(makeIntent(), makeContext());
    expect(result.decision).toBe("ALLOW");
  });

  it("should DENY takes precedence: denyAddresses over allowAddresses", async () => {
    const addr = "RecipientAddr1234567890abcdef";
    const rule = new AllowlistRule({
      allowAddresses: [addr],
      denyAddresses: [addr],
    });
    const result = await rule.evaluate(makeIntent(), makeContext());
    expect(result.decision).toBe("DENY");
  });

  it("should DENY when programId is in denyPrograms (custom intent)", async () => {
    const rule = new AllowlistRule({
      denyPrograms: ["BadProgram123"],
    });
    const intent = makeIntent({
      type: "custom",
      params: { programId: "BadProgram123", data: "abc", accounts: [] } as any,
    });
    const result = await rule.evaluate(intent, makeContext());
    expect(result.decision).toBe("DENY");
  });

  it("should DENY when programId is NOT in allowPrograms (custom intent)", async () => {
    const rule = new AllowlistRule({
      allowPrograms: ["AllowedProgram"],
    });
    const intent = makeIntent({
      type: "custom",
      params: { programId: "OtherProgram", data: "abc", accounts: [] } as any,
    });
    const result = await rule.evaluate(intent, makeContext());
    expect(result.decision).toBe("DENY");
  });

  it("should ALLOW when programId is in allowPrograms", async () => {
    const rule = new AllowlistRule({
      allowPrograms: ["GoodProgram123"],
    });
    const intent = makeIntent({
      type: "custom",
      params: { programId: "GoodProgram123", data: "abc", accounts: [] } as any,
    });
    const result = await rule.evaluate(intent, makeContext());
    expect(result.decision).toBe("ALLOW");
  });

  it("should extract target from stake intent (validator field)", async () => {
    const rule = new AllowlistRule({
      denyAddresses: ["BadValidator"],
    });
    const intent = makeIntent({
      type: "stake",
      params: { amount: "10", token: "SOL", validator: "BadValidator" },
    });
    const result = await rule.evaluate(intent, makeContext());
    expect(result.decision).toBe("DENY");
  });

  it("should extract target from mint intent (collection field)", async () => {
    const rule = new AllowlistRule({
      allowAddresses: ["GoodCollection"],
    });
    const intent = makeIntent({
      type: "mint",
      params: { collection: "GoodCollection", metadataUri: "https://example.com" },
    });
    const result = await rule.evaluate(intent, makeContext());
    expect(result.decision).toBe("ALLOW");
  });
});

// ─────────────────────────────────────────────────
// SpendingLimitRule
// ─────────────────────────────────────────────────
describe("SpendingLimitRule", () => {
  it("should instantiate with a name of 'spending-limit'", () => {
    const rule = new SpendingLimitRule({});
    expect(rule.name).toBe("spending-limit");
  });

  it("should ALLOW when amount is within per-transaction limit", async () => {
    const rule = new SpendingLimitRule({
      perTransaction: { amount: "5", token: "SOL" },
    });
    const result = await rule.evaluate(makeIntent(), makeContext());
    expect(result.decision).toBe("ALLOW");
  });

  it("should DENY when amount exceeds per-transaction limit", async () => {
    const rule = new SpendingLimitRule({
      perTransaction: { amount: "0.5", token: "SOL" },
    });
    const result = await rule.evaluate(makeIntent(), makeContext());
    expect(result.decision).toBe("DENY");
    if (result.decision === "DENY") {
      expect(result.reason).toContain("Per-transaction spending limit exceeded");
    }
  });

  it("should DENY when token doesn't match any configured limit and no USD limits exist", async () => {
    const rule = new SpendingLimitRule({
      perTransaction: { amount: "0.5", token: "USDC" },
    });
    // AUDIT-CRIT-01: Intent is for SOL but only USDC limit is configured (no USD limits).
    // Cross-token bypass prevention denies untracked tokens.
    const result = await rule.evaluate(makeIntent(), makeContext());
    expect(result.decision).toBe("DENY");
    expect(result.reason).toContain("no configured spending limit");
  });

  it("should DENY when daily limit is exceeded", async () => {
    const store = new MemoryStore();
    const rule = new SpendingLimitRule({
      daily: { amount: "5", token: "SOL" },
    });
    const ctx = makeContext({ store });

    // First 4 SOL should ALLOW
    const result1 = await rule.evaluate(
      makeIntent({ params: { to: "addr", amount: "4", token: "SOL" } }),
      ctx,
    );
    expect(result1.decision).toBe("ALLOW");

    // Next 2 SOL should DENY (4 + 2 = 6 > 5)
    const result2 = await rule.evaluate(
      makeIntent({ params: { to: "addr", amount: "2", token: "SOL" } }),
      ctx,
    );
    expect(result2.decision).toBe("DENY");
    if (result2.decision === "DENY") {
      expect(result2.reason).toContain("Spending limit exceeded");
    }
  });

  it("should DENY when weekly limit is exceeded", async () => {
    const store = new MemoryStore();
    const rule = new SpendingLimitRule({
      weekly: { amount: "10", token: "SOL" },
    });
    const ctx = makeContext({ store });

    await rule.evaluate(makeIntent({ params: { to: "addr", amount: "8", token: "SOL" } }), ctx);

    const result = await rule.evaluate(
      makeIntent({ params: { to: "addr", amount: "5", token: "SOL" } }),
      ctx,
    );
    expect(result.decision).toBe("DENY");
  });

  it("should DENY when monthly limit is exceeded", async () => {
    const store = new MemoryStore();
    const rule = new SpendingLimitRule({
      monthly: { amount: "100", token: "SOL" },
    });
    const ctx = makeContext({ store });

    await rule.evaluate(makeIntent({ params: { to: "addr", amount: "80", token: "SOL" } }), ctx);

    const result = await rule.evaluate(
      makeIntent({ params: { to: "addr", amount: "30", token: "SOL" } }),
      ctx,
    );
    expect(result.decision).toBe("DENY");
  });

  it("should DENY custom intents with no amount (CRIT-01 fail-closed)", async () => {
    const rule = new SpendingLimitRule({
      perTransaction: { amount: "1", token: "SOL" },
    });
    const intent = makeIntent({
      type: "custom",
      params: { programId: "prog", data: "abc", accounts: [] } as any,
    });
    const result = await rule.evaluate(intent, makeContext());
    // CRIT-01 fix: can't determine cost → DENY
    expect(result.decision).toBe("DENY");
  });

  it("should handle case-insensitive token comparison", async () => {
    const rule = new SpendingLimitRule({
      perTransaction: { amount: "0.5", token: "sol" },
    });
    const intent = makeIntent({ params: { to: "addr", amount: "1.0", token: "SOL" } });
    const result = await rule.evaluate(intent, makeContext());
    expect(result.decision).toBe("DENY");
  });

  it("should extract token from swap intent (fromToken)", async () => {
    const rule = new SpendingLimitRule({
      perTransaction: { amount: "0.5", token: "SOL" },
    });
    const intent = makeIntent({
      type: "swap",
      params: { fromToken: "SOL", toToken: "USDC", amount: "1.0" },
    });
    const result = await rule.evaluate(intent, makeContext());
    expect(result.decision).toBe("DENY");
  });
});

// ─────────────────────────────────────────────────
// RateLimitRule
// ─────────────────────────────────────────────────
describe("RateLimitRule", () => {
  it("should instantiate with a name of 'rate-limit'", () => {
    // POLICY-014: RateLimitRule now requires at least one limit
    const rule = new RateLimitRule({ maxTransactionsPerMinute: 10 });
    expect(rule.name).toBe("rate-limit");
  });

  it("should throw when no limits are configured (POLICY-014)", () => {
    // POLICY-014: Empty config is now rejected to prevent no-op rules
    expect(() => new RateLimitRule({})).toThrow("requires at least one limit");
  });

  it("should ALLOW when within per-minute limit", async () => {
    const rule = new RateLimitRule({ maxTransactionsPerMinute: 5 });
    const result = await rule.evaluate(makeIntent(), makeContext());
    expect(result.decision).toBe("ALLOW");
  });

  it("should DENY when per-minute limit is exceeded", async () => {
    const store = new MemoryStore();
    const rule = new RateLimitRule({ maxTransactionsPerMinute: 2 });
    const ctx = makeContext({ store });

    await rule.evaluate(makeIntent(), ctx);
    await rule.evaluate(makeIntent(), ctx);
    const result = await rule.evaluate(makeIntent(), ctx);

    expect(result.decision).toBe("DENY");
    if (result.decision === "DENY") {
      // MED-T3-07 fix: Rate limit denial messages are now generic ("Rate limit exceeded")
      // and no longer include specific window labels like "per minute" or "per hour".
      expect(result.reason).toContain("Rate limit exceeded");
    }
  });

  it("should DENY when per-hour limit is exceeded", async () => {
    const store = new MemoryStore();
    const rule = new RateLimitRule({ maxTransactionsPerHour: 3 });
    const ctx = makeContext({ store });

    await rule.evaluate(makeIntent(), ctx);
    await rule.evaluate(makeIntent(), ctx);
    await rule.evaluate(makeIntent(), ctx);
    const result = await rule.evaluate(makeIntent(), ctx);

    expect(result.decision).toBe("DENY");
    if (result.decision === "DENY") {
      // MED-T3-07 fix: Rate limit denial messages are now generic
      expect(result.reason).toContain("Rate limit exceeded");
    }
  });

  it("should track both per-minute and per-hour limits independently", async () => {
    const store = new MemoryStore();
    const rule = new RateLimitRule({
      maxTransactionsPerMinute: 10,
      maxTransactionsPerHour: 2,
    });
    const ctx = makeContext({ store });

    await rule.evaluate(makeIntent(), ctx);
    await rule.evaluate(makeIntent(), ctx);

    // Minute limit not exceeded (2 < 10) but hour limit exceeded (2 >= 2)
    const result = await rule.evaluate(makeIntent(), ctx);
    expect(result.decision).toBe("DENY");
    if (result.decision === "DENY") {
      // MED-T3-07 fix: Rate limit denial messages are now generic
      expect(result.reason).toContain("Rate limit exceeded");
    }
  });
});

// ─────────────────────────────────────────────────
// TimeWindowRule
// ─────────────────────────────────────────────────
describe("TimeWindowRule", () => {
  it("should instantiate with a name of 'time-window'", () => {
    const rule = new TimeWindowRule({
      timezone: "UTC",
      windows: [{ days: ["mon"], start: "09:00", end: "17:00" }],
    });
    expect(rule.name).toBe("time-window");
  });

  it("should ALLOW during active hours", async () => {
    // Create a date that is definitely a Wednesday at 12:00 UTC
    const wed12pm = new Date("2026-01-14T12:00:00Z"); // Wednesday
    const rule = new TimeWindowRule({
      timezone: "UTC",
      windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" }],
    });
    const result = await rule.evaluate(
      makeIntent(),
      makeContext({ now: wed12pm.getTime() }),
    );
    expect(result.decision).toBe("ALLOW");
  });

  it("should DENY outside active hours", async () => {
    // Saturday at 12:00 UTC (not in the mon-fri window)
    const sat12pm = new Date("2026-01-17T12:00:00Z"); // Saturday
    const rule = new TimeWindowRule({
      timezone: "UTC",
      windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" }],
    });
    const result = await rule.evaluate(
      makeIntent(),
      makeContext({ now: sat12pm.getTime() }),
    );
    expect(result.decision).toBe("DENY");
  });

  it("should DENY outside time range on correct day", async () => {
    // Wednesday at 20:00 UTC (after 17:00)
    const wed8pm = new Date("2026-01-14T20:00:00Z");
    const rule = new TimeWindowRule({
      timezone: "UTC",
      windows: [{ days: ["wed"], start: "09:00", end: "17:00" }],
    });
    const result = await rule.evaluate(
      makeIntent(),
      makeContext({ now: wed8pm.getTime() }),
    );
    expect(result.decision).toBe("DENY");
  });

  it("should support overnight ranges", async () => {
    // Tuesday at 23:00 UTC (within 22:00-06:00 overnight range)
    const tue11pm = new Date("2026-01-13T23:00:00Z");
    const rule = new TimeWindowRule({
      timezone: "UTC",
      windows: [{ days: ["tue"], start: "22:00", end: "06:00" }],
    });
    const result = await rule.evaluate(
      makeIntent(),
      makeContext({ now: tue11pm.getTime() }),
    );
    expect(result.decision).toBe("ALLOW");
  });

  it("should include require_approval reason when configured", async () => {
    const sat12pm = new Date("2026-01-17T12:00:00Z");
    const rule = new TimeWindowRule({
      timezone: "UTC",
      windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" }],
      outsideHoursPolicy: "require_approval",
    });
    const result = await rule.evaluate(
      makeIntent(),
      makeContext({ now: sat12pm.getTime() }),
    );
    expect(result.decision).toBe("DENY");
    if (result.decision === "DENY") {
      expect(result.reason).toContain("requires approval");
    }
  });

  it("should throw on invalid timezone in constructor", () => {
    // TimeWindowRule now validates timezone in constructor and throws for invalid values
    expect(() => new TimeWindowRule({
      timezone: "Invalid/Timezone",
      windows: [{ days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], start: "00:00", end: "23:59" }],
    })).toThrow("invalid timezone");
  });

  it("should support timezone-aware evaluation", async () => {
    // Wednesday at 04:00 UTC = Wednesday at 12:00 Asia/Tokyo (UTC+8 approximation, actually UTC+9)
    // 04:00 UTC is 13:00 JST (UTC+9)
    const wed4amUTC = new Date("2026-01-14T04:00:00Z");
    const rule = new TimeWindowRule({
      timezone: "Asia/Tokyo",
      windows: [{ days: ["wed"], start: "12:00", end: "18:00" }],
    });
    const result = await rule.evaluate(
      makeIntent(),
      makeContext({ now: wed4amUTC.getTime() }),
    );
    expect(result.decision).toBe("ALLOW");
  });
});

// ─────────────────────────────────────────────────
// ApprovalGateRule
// ─────────────────────────────────────────────────
describe("ApprovalGateRule", () => {
  it("should instantiate with a name of 'approval-gate'", () => {
    const rule = new ApprovalGateRule({
      above: { amount: "5", token: "SOL" },
    });
    expect(rule.name).toBe("approval-gate");
  });

  it("should ALLOW when amount is below threshold", async () => {
    const rule = new ApprovalGateRule({
      above: { amount: "5", token: "SOL" },
    });
    const result = await rule.evaluate(makeIntent(), makeContext());
    expect(result.decision).toBe("ALLOW");
  });

  it("should ALLOW when amount equals threshold", async () => {
    const rule = new ApprovalGateRule({
      above: { amount: "1", token: "SOL" },
    });
    const result = await rule.evaluate(makeIntent(), makeContext());
    expect(result.decision).toBe("ALLOW");
  });

  it("should DENY when amount exceeds threshold and no approval channel", async () => {
    const rule = new ApprovalGateRule({
      above: { amount: "0.5", token: "SOL" },
    });
    const result = await rule.evaluate(makeIntent(), makeContext());
    expect(result.decision).toBe("DENY");
    if (result.decision === "DENY") {
      expect(result.reason).toContain("no approval channel is configured");
    }
  });

  it("should ALLOW when approved by channel", async () => {
    const rule = new ApprovalGateRule({
      above: { amount: "0.5", token: "SOL" },
    });
    const result = await rule.evaluate(
      makeIntent(),
      makeContext({ approval: makeApprovalChannel("approved") }),
    );
    expect(result.decision).toBe("ALLOW");
  });

  it("should DENY when rejected by channel", async () => {
    const rule = new ApprovalGateRule({
      above: { amount: "0.5", token: "SOL" },
    });
    const result = await rule.evaluate(
      makeIntent(),
      makeContext({ approval: makeApprovalChannel("rejected") }),
    );
    expect(result.decision).toBe("DENY");
    if (result.decision === "DENY") {
      expect(result.reason).toContain("rejected");
    }
  });

  it("should DENY when approval times out", async () => {
    const rule = new ApprovalGateRule({
      above: { amount: "0.5", token: "SOL" },
    });
    const result = await rule.evaluate(
      makeIntent(),
      makeContext({ approval: makeApprovalChannel("timeout") }),
    );
    expect(result.decision).toBe("DENY");
    if (result.decision === "DENY") {
      expect(result.reason).toContain("timed out");
    }
  });

  it("should DENY when approval channel throws (fail closed)", async () => {
    const rule = new ApprovalGateRule({
      above: { amount: "0.5", token: "SOL" },
    });
    const failChannel: ApprovalChannel = {
      name: "broken",
      requestApproval: async () => { throw new Error("channel offline"); },
    };
    const result = await rule.evaluate(
      makeIntent(),
      makeContext({ approval: failChannel }),
    );
    expect(result.decision).toBe("DENY");
    if (result.decision === "DENY") {
      expect(result.reason).toContain("Approval channel error");
    }
  });

  it("should DENY when token doesn't match threshold token (POLICY-001 fix)", async () => {
    const rule = new ApprovalGateRule({
      above: { amount: "0.5", token: "USDC" },
    });
    // POLICY-001: Unmatched tokens now DENY instead of silently ALLOW
    const result = await rule.evaluate(makeIntent(), makeContext());
    expect(result.decision).toBe("DENY");
  });

  it("should DENY custom intents with no amount when no approval channel (CRIT-01 fail-closed)", async () => {
    const rule = new ApprovalGateRule({
      above: { amount: "0.5", token: "SOL" },
    });
    const intent = makeIntent({
      type: "custom",
      params: { programId: "prog", data: "abc", accounts: [] } as any,
    });
    const result = await rule.evaluate(intent, makeContext());
    // CRIT-01 fix: can't determine amount → DENY (no approval channel)
    expect(result.decision).toBe("DENY");
  });

  it("should include decidedBy in rejection reason", async () => {
    const rule = new ApprovalGateRule({
      above: { amount: "0.5", token: "SOL" },
    });
    const channel: ApprovalChannel = {
      name: "mock",
      requestApproval: async (req) => ({
        requestId: req.id,
        decision: "rejected" as const,
        decidedBy: "admin@example.com",
        decidedAt: Date.now(),
      }),
    };
    const result = await rule.evaluate(
      makeIntent(),
      makeContext({ approval: channel }),
    );
    expect(result.decision).toBe("DENY");
    if (result.decision === "DENY") {
      expect(result.reason).toContain("admin@example.com");
    }
  });
});

// ─────────────────────────────────────────────────
// Sprint 2 — Comprehensive Edge Case Tests
// ─────────────────────────────────────────────────

// ─────────────────────────────────────────────────
// SpendingLimitRule — Edge Cases
// ─────────────────────────────────────────────────
describe("SpendingLimitRule — Edge Cases", () => {
  it("should DENY when amount is zero (CRIT-01: extractAmount returns null for non-positive)", async () => {
    const rule = new SpendingLimitRule({
      perTransaction: { amount: "5", token: "SOL" },
    });
    const intent = makeIntent({ params: { to: "addr", amount: "0", token: "SOL" } });
    const result = await rule.evaluate(intent, makeContext());
    // CRIT-01 fix: extractAmount returns null for zero → DENY (fail-closed)
    expect(result.decision).toBe("DENY");
  });

  it("should DENY NaN amount (CRIT-01: extractAmount returns null → fail-closed)", async () => {
    const rule = new SpendingLimitRule({
      perTransaction: { amount: "5", token: "SOL" },
    });
    const intent = makeIntent({ params: { to: "addr", amount: "not-a-number", token: "SOL" } });
    const result = await rule.evaluate(intent, makeContext());
    // CRIT-01 fix: extractAmount returns null for NaN → DENY (fail-closed)
    expect(result.decision).toBe("DENY");
  });

  it("should DENY negative amounts (CRIT-01: extractAmount returns null for non-positive)", async () => {
    const rule = new SpendingLimitRule({
      perTransaction: { amount: "5", token: "SOL" },
    });
    const intent = makeIntent({ params: { to: "addr", amount: "-1.0", token: "SOL" } });
    const result = await rule.evaluate(intent, makeContext());
    // CRIT-01 fix: extractAmount returns null for negative → DENY (fail-closed)
    expect(result.decision).toBe("DENY");
  });

  it("should ALLOW when amount exactly equals per-transaction limit", async () => {
    const rule = new SpendingLimitRule({
      perTransaction: { amount: "1.0", token: "SOL" },
    });
    const intent = makeIntent({ params: { to: "addr", amount: "1.0", token: "SOL" } });
    const result = await rule.evaluate(intent, makeContext());
    // 1.0 > 1.0 is false, so ALLOW
    expect(result.decision).toBe("ALLOW");
  });

  it("should DENY when amount is just above per-transaction limit", async () => {
    const rule = new SpendingLimitRule({
      perTransaction: { amount: "1.0", token: "SOL" },
    });
    const intent = makeIntent({ params: { to: "addr", amount: "1.000001", token: "SOL" } });
    const result = await rule.evaluate(intent, makeContext());
    expect(result.decision).toBe("DENY");
  });

  it("should enforce combined daily + weekly + monthly limits", async () => {
    const store = new MemoryStore();
    const rule = new SpendingLimitRule({
      daily: { amount: "10", token: "SOL" },
      weekly: { amount: "50", token: "SOL" },
      monthly: { amount: "100", token: "SOL" },
    });
    const ctx = makeContext({ store });

    // First 9 SOL should ALLOW (within all limits)
    const r1 = await rule.evaluate(
      makeIntent({ params: { to: "addr", amount: "9", token: "SOL" } }),
      ctx,
    );
    expect(r1.decision).toBe("ALLOW");

    // Next 2 SOL should DENY (9 + 2 = 11 > 10 daily limit)
    const r2 = await rule.evaluate(
      makeIntent({ params: { to: "addr", amount: "2", token: "SOL" } }),
      ctx,
    );
    expect(r2.decision).toBe("DENY");
    if (r2.decision === "DENY") {
      expect(r2.reason).toContain("Spending limit exceeded");
    }
  });

  it("should track spending counters across multiple calls", async () => {
    const store = new MemoryStore();
    const rule = new SpendingLimitRule({
      daily: { amount: "10", token: "SOL" },
    });
    const ctx = makeContext({ store });

    // 3 + 3 + 3 = 9 should all ALLOW
    for (let i = 0; i < 3; i++) {
      const r = await rule.evaluate(
        makeIntent({ params: { to: "addr", amount: "3", token: "SOL" } }),
        ctx,
      );
      expect(r.decision).toBe("ALLOW");
    }

    // Next 2 SOL (9 + 2 = 11 > 10) should DENY
    const r4 = await rule.evaluate(
      makeIntent({ params: { to: "addr", amount: "2", token: "SOL" } }),
      ctx,
    );
    expect(r4.decision).toBe("DENY");
  });

  it("should allow exactly remaining daily budget", async () => {
    const store = new MemoryStore();
    const rule = new SpendingLimitRule({
      daily: { amount: "10", token: "SOL" },
    });
    const ctx = makeContext({ store });

    // Spend 7
    await rule.evaluate(
      makeIntent({ params: { to: "addr", amount: "7", token: "SOL" } }),
      ctx,
    );

    // Spend exactly 3 more (7 + 3 = 10, exactly at limit)
    const r2 = await rule.evaluate(
      makeIntent({ params: { to: "addr", amount: "3", token: "SOL" } }),
      ctx,
    );
    expect(r2.decision).toBe("ALLOW");

    // Any further spending should be denied
    const r3 = await rule.evaluate(
      makeIntent({ params: { to: "addr", amount: "0.001", token: "SOL" } }),
      ctx,
    );
    expect(r3.decision).toBe("DENY");
  });

  it("should DENY untracked token when no USD limits exist (AUDIT-CRIT-01)", async () => {
    const store = new MemoryStore();
    const rule = new SpendingLimitRule({
      daily: { amount: "10", token: "SOL" },
    });
    const ctx = makeContext({ store });

    // Spend 9 SOL — within limit
    await rule.evaluate(
      makeIntent({ params: { to: "addr", amount: "9", token: "SOL" } }),
      ctx,
    );

    // AUDIT-CRIT-01: USDC has no configured limit and no USD limits exist,
    // so cross-token bypass prevention kicks in and denies
    const r2 = await rule.evaluate(
      makeIntent({ params: { to: "addr", amount: "100", token: "USDC" } }),
      ctx,
    );
    expect(r2.decision).toBe("DENY");
    expect(r2.reason).toContain("no configured spending limit");
  });

  it("should handle very large amounts", async () => {
    const rule = new SpendingLimitRule({
      perTransaction: { amount: "1000000", token: "SOL" },
    });
    const intent = makeIntent({ params: { to: "addr", amount: "999999.99", token: "SOL" } });
    const result = await rule.evaluate(intent, makeContext());
    expect(result.decision).toBe("ALLOW");
  });

  it("should handle floating-point precision at boundary", async () => {
    const rule = new SpendingLimitRule({
      perTransaction: { amount: "0.1", token: "SOL" },
    });
    // 0.1 > 0.1 is false
    const intent = makeIntent({ params: { to: "addr", amount: "0.1", token: "SOL" } });
    const result = await rule.evaluate(intent, makeContext());
    expect(result.decision).toBe("ALLOW");
  });
});

// ─────────────────────────────────────────────────
// AllowlistRule — Edge Cases
// ─────────────────────────────────────────────────
describe("AllowlistRule — Edge Cases", () => {
  it("should DENY swap intent when allowAddresses is configured but no token checks cover swaps (CRIT-05)", async () => {
    const rule = new AllowlistRule({
      allowAddresses: ["SomeAddress"],
    });
    // A swap intent has no 'to' field — extractTargetAddress returns null
    const intent = makeIntent({
      type: "swap",
      params: { fromToken: "SOL", toToken: "USDC", amount: "1.0" },
    });
    const result = await rule.evaluate(intent, makeContext());
    // CRIT-05 fix: swap with no verifiable target + address allowlist configured → DENY
    expect(result.decision).toBe("DENY");
  });

  it("should DENY swap intent when address allowlist is configured but swap tokens are not addresses in the list (M-03 fix)", async () => {
    const rule = new AllowlistRule({
      allowAddresses: ["SomeAddress"],
      allowTokens: ["SOL", "USDC"],
    });
    const intent = makeIntent({
      type: "swap",
      params: { fromToken: "SOL", toToken: "USDC", amount: "1.0" },
    });
    const result = await rule.evaluate(intent, makeContext());
    // M-03 fix: checkSwapAddresses runs before token checks. Since swap token symbols
    // (SOL, USDC) are not in the address allowlist, this is denied.
    expect(result.decision).toBe("DENY");
  });

  it("should DENY when target address is empty string (POLICY-005 fix rejects empty addresses)", async () => {
    // POLICY-005: Empty/whitespace-only addresses are now rejected
    const rule = new AllowlistRule({
      denyAddresses: [""],
    });
    const intent = makeIntent({ params: { to: "", amount: "1", token: "SOL" } });
    const result = await rule.evaluate(intent, makeContext());
    expect(result.decision).toBe("DENY");
  });

  it("should handle empty allowAddresses array (no whitelist restriction)", async () => {
    const rule = new AllowlistRule({
      allowAddresses: [],
    });
    const result = await rule.evaluate(makeIntent(), makeContext());
    // hasAllowAddresses is false (empty set), so no whitelist check
    expect(result.decision).toBe("ALLOW");
  });

  it("should deny when both allow and deny have the same address (deny takes precedence)", async () => {
    const addr = "SharedAddr123";
    const rule = new AllowlistRule({
      allowAddresses: [addr],
      denyAddresses: [addr],
    });
    const intent = makeIntent({ params: { to: addr, amount: "1", token: "SOL" } });
    const result = await rule.evaluate(intent, makeContext());
    expect(result.decision).toBe("DENY");
    if (result.decision === "DENY") {
      // H-38 fix: generic denial message, no longer says "denylisted"
      expect(result.reason).toContain("not permitted");
    }
  });

  it("should check address case-sensitively", async () => {
    const rule = new AllowlistRule({
      allowAddresses: ["AbCdEf"],
    });
    const intent = makeIntent({ params: { to: "abcdef", amount: "1", token: "SOL" } });
    const result = await rule.evaluate(intent, makeContext());
    // Address comparison is case-sensitive (Set.has)
    expect(result.decision).toBe("DENY");
  });

  it("should extract programId as both target address and programId for custom intents", async () => {
    const rule = new AllowlistRule({
      denyAddresses: ["Prog123"],
      denyPrograms: ["Prog123"],
    });
    const intent = makeIntent({
      type: "custom",
      params: { programId: "Prog123", data: "abc", accounts: [] } as any,
    });
    const result = await rule.evaluate(intent, makeContext());
    // denyAddresses catches it first via extractTargetAddress (which checks programId)
    expect(result.decision).toBe("DENY");
  });

  it("should ALLOW non-custom intents even when allowPrograms is configured", async () => {
    const rule = new AllowlistRule({
      allowPrograms: ["OnlyThisProgram"],
    });
    // Transfer intent — extractProgramId returns null for non-custom
    const result = await rule.evaluate(makeIntent(), makeContext());
    expect(result.decision).toBe("ALLOW");
  });

  it("should handle multiple addresses in allow list", async () => {
    const rule = new AllowlistRule({
      allowAddresses: ["Addr1", "Addr2", "Addr3"],
    });
    const i1 = makeIntent({ params: { to: "Addr1", amount: "1", token: "SOL" } });
    const i2 = makeIntent({ params: { to: "Addr2", amount: "1", token: "SOL" } });
    const i3 = makeIntent({ params: { to: "Unknown", amount: "1", token: "SOL" } });

    expect((await rule.evaluate(i1, makeContext())).decision).toBe("ALLOW");
    expect((await rule.evaluate(i2, makeContext())).decision).toBe("ALLOW");
    expect((await rule.evaluate(i3, makeContext())).decision).toBe("DENY");
  });
});

// ─────────────────────────────────────────────────
// RateLimitRule — Edge Cases
// ─────────────────────────────────────────────────
describe("RateLimitRule — Edge Cases", () => {
  it("should throw on construction with limit of 0 per minute (MED-30 fix)", () => {
    expect(() => new RateLimitRule({ maxTransactionsPerMinute: 0 })).toThrow(
      "maxTransactionsPerMinute must be a positive finite integer",
    );
  });

  it("should throw on construction with limit of 0 per hour (MED-30 fix)", () => {
    expect(() => new RateLimitRule({ maxTransactionsPerHour: 0 })).toThrow(
      "maxTransactionsPerHour must be a positive finite integer",
    );
  });

  it("should ALLOW exactly 1 transaction with limit of 1 per minute", async () => {
    const store = new MemoryStore();
    const rule = new RateLimitRule({ maxTransactionsPerMinute: 1 });
    const ctx = makeContext({ store });

    const r1 = await rule.evaluate(makeIntent(), ctx);
    expect(r1.decision).toBe("ALLOW");

    const r2 = await rule.evaluate(makeIntent(), ctx);
    expect(r2.decision).toBe("DENY");
  });

  it("should ALLOW exactly 1 transaction with limit of 1 per hour", async () => {
    const store = new MemoryStore();
    const rule = new RateLimitRule({ maxTransactionsPerHour: 1 });
    const ctx = makeContext({ store });

    const r1 = await rule.evaluate(makeIntent(), ctx);
    expect(r1.decision).toBe("ALLOW");

    const r2 = await rule.evaluate(makeIntent(), ctx);
    expect(r2.decision).toBe("DENY");
  });

  it("should only increment counters on ALLOW, not on DENY", async () => {
    const store = new MemoryStore();
    const rule = new RateLimitRule({ maxTransactionsPerMinute: 2 });
    const ctx = makeContext({ store });

    // First two ALLOWs
    await rule.evaluate(makeIntent(), ctx);
    await rule.evaluate(makeIntent(), ctx);

    // These DENYs should NOT increment counter
    await rule.evaluate(makeIntent(), ctx);
    await rule.evaluate(makeIntent(), ctx);
    await rule.evaluate(makeIntent(), ctx);

    // Counter should still be 2
    const val = await store.get("ratelimit:minute");
    expect(parseFloat(val!)).toBe(2);
  });

  it("should throw on construction with both minute and hour limits of 0 (MED-30 fix)", () => {
    expect(
      () => new RateLimitRule({ maxTransactionsPerMinute: 0, maxTransactionsPerHour: 0 }),
    ).toThrow("maxTransactionsPerMinute must be a positive finite integer");
  });

  it("should handle high-volume traffic within limits", async () => {
    const store = new MemoryStore();
    const rule = new RateLimitRule({ maxTransactionsPerMinute: 100 });
    const ctx = makeContext({ store });

    for (let i = 0; i < 100; i++) {
      const r = await rule.evaluate(makeIntent(), ctx);
      expect(r.decision).toBe("ALLOW");
    }

    // 101st should DENY
    const r101 = await rule.evaluate(makeIntent(), ctx);
    expect(r101.decision).toBe("DENY");
  });
});

// ─────────────────────────────────────────────────
// TimeWindowRule — Edge Cases
// ─────────────────────────────────────────────────
describe("TimeWindowRule — Edge Cases", () => {
  it("should DENY at exactly the end time (end time is exclusive)", async () => {
    // Wednesday at exactly 17:00 UTC — the end is exclusive (currentMinutes < endMinutes)
    const wed5pm = new Date("2026-01-14T17:00:00Z");
    const rule = new TimeWindowRule({
      timezone: "UTC",
      windows: [{ days: ["wed"], start: "09:00", end: "17:00" }],
    });
    const result = await rule.evaluate(
      makeIntent(),
      makeContext({ now: wed5pm.getTime() }),
    );
    expect(result.decision).toBe("DENY");
  });

  it("should ALLOW at exactly the start time (start is inclusive)", async () => {
    // Wednesday at exactly 09:00 UTC
    const wed9am = new Date("2026-01-14T09:00:00Z");
    const rule = new TimeWindowRule({
      timezone: "UTC",
      windows: [{ days: ["wed"], start: "09:00", end: "17:00" }],
    });
    const result = await rule.evaluate(
      makeIntent(),
      makeContext({ now: wed9am.getTime() }),
    );
    expect(result.decision).toBe("ALLOW");
  });

  it("should handle midnight boundary (00:00) correctly", async () => {
    // Wednesday at midnight UTC
    const wedMidnight = new Date("2026-01-14T00:00:00Z");
    const rule = new TimeWindowRule({
      timezone: "UTC",
      windows: [{ days: ["wed"], start: "00:00", end: "06:00" }],
    });
    const result = await rule.evaluate(
      makeIntent(),
      makeContext({ now: wedMidnight.getTime() }),
    );
    expect(result.decision).toBe("ALLOW");
  });

  it("should handle multiple windows for the same day", async () => {
    // Wednesday at 14:00 UTC — falls in the second window
    const wed2pm = new Date("2026-01-14T14:00:00Z");
    const rule = new TimeWindowRule({
      timezone: "UTC",
      windows: [
        { days: ["wed"], start: "08:00", end: "12:00" },
        { days: ["wed"], start: "13:00", end: "17:00" },
      ],
    });
    const result = await rule.evaluate(
      makeIntent(),
      makeContext({ now: wed2pm.getTime() }),
    );
    expect(result.decision).toBe("ALLOW");
  });

  it("should DENY when time falls in gap between windows", async () => {
    // Wednesday at 12:30 UTC — between the two windows
    const wed1230 = new Date("2026-01-14T12:30:00Z");
    const rule = new TimeWindowRule({
      timezone: "UTC",
      windows: [
        { days: ["wed"], start: "08:00", end: "12:00" },
        { days: ["wed"], start: "13:00", end: "17:00" },
      ],
    });
    const result = await rule.evaluate(
      makeIntent(),
      makeContext({ now: wed1230.getTime() }),
    );
    expect(result.decision).toBe("DENY");
  });

  it("should handle US Eastern timezone correctly", async () => {
    // 2026-01-14 14:00 UTC = 09:00 EST (UTC-5 in January, no DST)
    const utc2pm = new Date("2026-01-14T14:00:00Z");
    const rule = new TimeWindowRule({
      timezone: "America/New_York",
      windows: [{ days: ["wed"], start: "09:00", end: "17:00" }],
    });
    const result = await rule.evaluate(
      makeIntent(),
      makeContext({ now: utc2pm.getTime() }),
    );
    expect(result.decision).toBe("ALLOW");
  });

  it("should handle overnight window that wraps past midnight", async () => {
    // POLICY-004 fix: Tuesday at 02:00 UTC — within 22:00-06:00 overnight range.
    // The window 22:00-06:00 on "mon" covers Mon 22:00 to Tue 06:00.
    // At Tue 02:00, the PREVIOUS day (mon) must be in the days list.
    const tue2am = new Date("2026-01-13T02:00:00Z");
    const rule = new TimeWindowRule({
      timezone: "UTC",
      windows: [{ days: ["mon"], start: "22:00", end: "06:00" }],
    });
    const result = await rule.evaluate(
      makeIntent(),
      makeContext({ now: tue2am.getTime() }),
    );
    expect(result.decision).toBe("ALLOW");
  });

  it("should DENY with require_approval reason outside hours", async () => {
    // Wednesday at 20:00 UTC — outside 09:00-17:00
    const wed8pm = new Date("2026-01-14T20:00:00Z");
    const rule = new TimeWindowRule({
      timezone: "UTC",
      windows: [{ days: ["wed"], start: "09:00", end: "17:00" }],
      outsideHoursPolicy: "require_approval",
    });
    const result = await rule.evaluate(
      makeIntent(),
      makeContext({ now: wed8pm.getTime() }),
    );
    expect(result.decision).toBe("DENY");
    if (result.decision === "DENY") {
      expect(result.reason).toContain("requires approval");
    }
  });

  it("should DENY with deny reason including timezone when outsideHoursPolicy is deny", async () => {
    const sat12pm = new Date("2026-01-17T12:00:00Z");
    const rule = new TimeWindowRule({
      timezone: "UTC",
      windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" }],
      outsideHoursPolicy: "deny",
    });
    const result = await rule.evaluate(
      makeIntent(),
      makeContext({ now: sat12pm.getTime() }),
    );
    expect(result.decision).toBe("DENY");
    if (result.decision === "DENY") {
      expect(result.reason).toContain("UTC");
    }
  });

  it("should handle weekend-only window", async () => {
    // Saturday at 12:00 UTC
    const sat12pm = new Date("2026-01-17T12:00:00Z");
    const rule = new TimeWindowRule({
      timezone: "UTC",
      windows: [{ days: ["sat", "sun"], start: "00:00", end: "23:59" }],
    });
    const result = await rule.evaluate(
      makeIntent(),
      makeContext({ now: sat12pm.getTime() }),
    );
    expect(result.decision).toBe("ALLOW");
  });

  it("should handle empty windows array (always deny)", async () => {
    const rule = new TimeWindowRule({
      timezone: "UTC",
      windows: [],
    });
    const result = await rule.evaluate(makeIntent(), makeContext());
    expect(result.decision).toBe("DENY");
  });
});

// ─────────────────────────────────────────────────
// ApprovalGateRule — Edge Cases
// ─────────────────────────────────────────────────
describe("ApprovalGateRule — Edge Cases", () => {
  it("should ALLOW when amount exactly equals threshold (threshold is strict >)", async () => {
    const rule = new ApprovalGateRule({
      above: { amount: "1.0", token: "SOL" },
    });
    // Intent amount is 1.0, threshold is 1.0 — "above" means > not >=
    const result = await rule.evaluate(makeIntent(), makeContext());
    expect(result.decision).toBe("ALLOW");
  });

  it("should DENY when amount is just above threshold (e.g., 1.000001 > 1.0)", async () => {
    const rule = new ApprovalGateRule({
      above: { amount: "1.0", token: "SOL" },
    });
    const intent = makeIntent({ params: { to: "addr", amount: "1.000001", token: "SOL" } });
    const result = await rule.evaluate(intent, makeContext());
    // No approval channel configured, so should DENY
    expect(result.decision).toBe("DENY");
    if (result.decision === "DENY") {
      expect(result.reason).toContain("no approval channel");
    }
  });

  it("should build correct approval request fields", async () => {
    let capturedRequest: any = null;
    const channel: ApprovalChannel = {
      name: "capture",
      requestApproval: async (req) => {
        capturedRequest = req;
        return {
          requestId: req.id,
          decision: "approved" as const,
          decidedAt: Date.now(),
        };
      },
    };

    const rule = new ApprovalGateRule({
      above: { amount: "0.5", token: "SOL" },
      timeout: 60_000,
    });

    const intent = makeIntent({
      id: "test-intent-42",
      params: { to: "RecipientAddr", amount: "10.5", token: "SOL" },
      metadata: { agentId: "agent-1", reason: "payment" },
    });

    await rule.evaluate(intent, makeContext({ approval: channel }));

    expect(capturedRequest).toBeDefined();
    // Approval request ID is a random UUID (not the intent ID)
    expect(typeof capturedRequest.id).toBe("string");
    expect(capturedRequest.id.length).toBeGreaterThan(0);
    expect(capturedRequest.summary).toBe("transfer 10.5 SOL");
    expect(capturedRequest.amount).toBe("10.5");
    expect(capturedRequest.token).toBe("SOL");
    expect(capturedRequest.target).toBe("RecipientAddr");
    expect(capturedRequest.expiresAt).toBeGreaterThan(Date.now());
  });

  it("should handle case-insensitive token comparison (sol vs SOL)", async () => {
    const rule = new ApprovalGateRule({
      above: { amount: "0.5", token: "sol" },
    });
    // Intent token is "SOL" (uppercase), threshold token is "sol" (lowercase)
    const result = await rule.evaluate(makeIntent(), makeContext());
    // Should match via toUpperCase comparison, amount 1.0 > 0.5 -> DENY (no channel)
    expect(result.decision).toBe("DENY");
  });

  it("should use default timeout of 5 minutes when not configured", async () => {
    let capturedRequest: any = null;
    const channel: ApprovalChannel = {
      name: "capture",
      requestApproval: async (req) => {
        capturedRequest = req;
        return {
          requestId: req.id,
          decision: "approved" as const,
          decidedAt: Date.now(),
        };
      },
    };

    const rule = new ApprovalGateRule({
      above: { amount: "0.5", token: "SOL" },
      // No timeout configured
    });

    await rule.evaluate(makeIntent(), makeContext({ approval: channel }));

    expect(capturedRequest).toBeDefined();
    // Default is 300_000ms (5 min)
    const expectedMinExpiry = Date.now() + 299_000; // allow 1s buffer
    expect(capturedRequest.expiresAt).toBeGreaterThan(expectedMinExpiry);
  });

  it("should extract reason from metadata when params has no reason", async () => {
    let capturedRequest: any = null;
    const channel: ApprovalChannel = {
      name: "capture",
      requestApproval: async (req) => {
        capturedRequest = req;
        return { requestId: req.id, decision: "approved" as const, decidedAt: Date.now() };
      },
    };

    const rule = new ApprovalGateRule({
      above: { amount: "0.5", token: "SOL" },
    });

    const intent = makeIntent({
      metadata: { reason: "monthly payroll" },
    });

    await rule.evaluate(intent, makeContext({ approval: channel }));

    // HIGH-T4-01: Agent-provided reason is now tagged as untrusted
    expect(capturedRequest.reason).toContain("monthly payroll");
    expect(capturedRequest.reason).toContain("[AGENT-PROVIDED");

  });

  it("should extract agentId from intent metadata in approval request", async () => {
    let capturedRequest: any = null;
    const channel: ApprovalChannel = {
      name: "capture",
      requestApproval: async (req) => {
        capturedRequest = req;
        return { requestId: req.id, decision: "approved" as const, decidedAt: Date.now() };
      },
    };

    const rule = new ApprovalGateRule({
      above: { amount: "0.5", token: "SOL" },
    });

    const intent = makeIntent({
      metadata: { agentId: "agent-99" },
    });

    await rule.evaluate(intent, makeContext({ approval: channel }));

    expect(capturedRequest.agentId).toBe("agent-99");
  });

  it("should generate UUID for approval request when intent has no id", async () => {
    let capturedRequest: any = null;
    const channel: ApprovalChannel = {
      name: "capture",
      requestApproval: async (req) => {
        capturedRequest = req;
        return { requestId: req.id, decision: "approved" as const, decidedAt: Date.now() };
      },
    };

    const rule = new ApprovalGateRule({
      above: { amount: "0.5", token: "SOL" },
    });

    const intent = makeIntent(); // has id: "test-intent-1" from makeIntent
    // Override to remove id
    delete (intent as any).id;

    await rule.evaluate(intent, makeContext({ approval: channel }));

    // Should have generated a UUID
    expect(capturedRequest.id).toBeDefined();
    expect(capturedRequest.id.length).toBeGreaterThan(0);
  });

  it("should extract target from swap intent (no 'to' field, falls back to 'unknown')", async () => {
    let capturedRequest: any = null;
    const channel: ApprovalChannel = {
      name: "capture",
      requestApproval: async (req) => {
        capturedRequest = req;
        return { requestId: req.id, decision: "approved" as const, decidedAt: Date.now() };
      },
    };

    const rule = new ApprovalGateRule({
      above: { amount: "0.5", token: "SOL" },
    });

    const intent = makeIntent({
      type: "swap",
      params: { fromToken: "SOL", toToken: "USDC", amount: "10.0" },
    });

    await rule.evaluate(intent, makeContext({ approval: channel }));

    // Swap has no to/programId/collection/validator, so target is "unknown"
    expect(capturedRequest.target).toBe("unknown");
  });

  it("should extract fromToken for swap intents when checking threshold", async () => {
    const rule = new ApprovalGateRule({
      above: { amount: "5", token: "SOL" },
    });
    // Swap intent with fromToken "SOL" and amount above threshold
    const intent = makeIntent({
      type: "swap",
      params: { fromToken: "SOL", toToken: "USDC", amount: "10.0" },
    });
    // No approval channel — should DENY
    const result = await rule.evaluate(intent, makeContext());
    expect(result.decision).toBe("DENY");
    if (result.decision === "DENY") {
      expect(result.reason).toContain("no approval channel");
    }
  });

  it("should ALLOW swap intent with fromToken below threshold", async () => {
    const rule = new ApprovalGateRule({
      above: { amount: "5", token: "SOL" },
    });
    const intent = makeIntent({
      type: "swap",
      params: { fromToken: "SOL", toToken: "USDC", amount: "3.0" },
    });
    const result = await rule.evaluate(intent, makeContext());
    expect(result.decision).toBe("ALLOW");
  });

  it("should DENY intent with negative amount when no approval channel (CRIT-01 fail-closed)", async () => {
    const rule = new ApprovalGateRule({
      above: { amount: "0.5", token: "SOL" },
    });
    const intent = makeIntent({
      params: { to: "addr", amount: "-5", token: "SOL" },
    });
    const result = await rule.evaluate(intent, makeContext());
    // CRIT-01 fix: extractAmount returns null for negative → DENY (no approval channel)
    expect(result.decision).toBe("DENY");
  });

  it("should DENY intent with zero amount when no approval channel (CRIT-01 fail-closed)", async () => {
    const rule = new ApprovalGateRule({
      above: { amount: "0.5", token: "SOL" },
    });
    const intent = makeIntent({
      params: { to: "addr", amount: "0", token: "SOL" },
    });
    const result = await rule.evaluate(intent, makeContext());
    // CRIT-01 fix: extractAmount returns null for zero → DENY (no approval channel)
    expect(result.decision).toBe("DENY");
  });

  it("should DENY intent with NaN amount when no approval channel (CRIT-01 fail-closed)", async () => {
    const rule = new ApprovalGateRule({
      above: { amount: "0.5", token: "SOL" },
    });
    const intent = makeIntent({
      params: { to: "addr", amount: "not-a-number", token: "SOL" },
    });
    const result = await rule.evaluate(intent, makeContext());
    // CRIT-01 fix: extractAmount returns null for NaN → DENY (no approval channel)
    expect(result.decision).toBe("DENY");
  });

  it("should extract target from stake intent (validator field) in approval request", async () => {
    let capturedRequest: any = null;
    const channel: ApprovalChannel = {
      name: "capture",
      requestApproval: async (req) => {
        capturedRequest = req;
        return { requestId: req.id, decision: "approved" as const, decidedAt: Date.now() };
      },
    };

    const rule = new ApprovalGateRule({
      above: { amount: "5", token: "SOL" },
    });

    const intent = makeIntent({
      type: "stake",
      params: { amount: "10", token: "SOL", validator: "ValidatorAddr123" },
    });

    await rule.evaluate(intent, makeContext({ approval: channel }));

    expect(capturedRequest).toBeDefined();
    expect(capturedRequest.target).toBe("ValidatorAddr123");
  });

  it("should DENY mint intent with no amount when no approval channel (CRIT-01 fail-closed)", async () => {
    // Mint intents don't have an amount field. CRIT-01 fix: DENY when
    // amount can't be determined and no approval channel is configured.
    const rule = new ApprovalGateRule({
      above: { amount: "5", token: "SOL" },
    });

    const intent = makeIntent({
      type: "mint",
      params: { collection: "Collection123", metadataUri: "https://example.com/meta.json" },
    });

    const result = await rule.evaluate(intent, makeContext());
    // CRIT-01 fix: no extractable amount + no approval channel → DENY
    expect(result.decision).toBe("DENY");
  });

  it("should request approval for mint intent when channel is configured (CRIT-01)", async () => {
    const rule = new ApprovalGateRule({
      above: { amount: "5", token: "SOL" },
    });
    const channel = makeApprovalChannel("approved");

    const intent = makeIntent({
      type: "mint",
      params: { collection: "Collection123", metadataUri: "https://example.com/meta.json" },
    });

    const result = await rule.evaluate(intent, makeContext({ approval: channel }));
    // CRIT-01 fix: with approval channel, requests approval → ALLOW if approved
    expect(result.decision).toBe("ALLOW");
  });

  it("should use configured timeout value in approval request expiresAt", async () => {
    let capturedRequest: any = null;
    const channel: ApprovalChannel = {
      name: "capture",
      requestApproval: async (req) => {
        capturedRequest = req;
        return { requestId: req.id, decision: "approved" as const, decidedAt: Date.now() };
      },
    };

    const rule = new ApprovalGateRule({
      above: { amount: "0.5", token: "SOL" },
      timeout: 10_000, // 10 seconds
    });

    const before = Date.now();
    await rule.evaluate(makeIntent(), makeContext({ approval: channel }));

    expect(capturedRequest).toBeDefined();
    // expiresAt should be approximately now + 10_000
    expect(capturedRequest.expiresAt).toBeGreaterThanOrEqual(before + 9_000);
    expect(capturedRequest.expiresAt).toBeLessThanOrEqual(before + 11_000);
  });

  it("should handle timeout config of 0 (immediate expiry in approval request)", async () => {
    let capturedRequest: any = null;
    const channel: ApprovalChannel = {
      name: "capture",
      requestApproval: async (req) => {
        capturedRequest = req;
        return { requestId: req.id, decision: "approved" as const, decidedAt: Date.now() };
      },
    };

    const rule = new ApprovalGateRule({
      above: { amount: "0.5", token: "SOL" },
      timeout: 0,
    });

    const before = Date.now();
    await rule.evaluate(makeIntent(), makeContext({ approval: channel }));

    expect(capturedRequest).toBeDefined();
    // expiresAt should be approximately now + 0
    expect(capturedRequest.expiresAt).toBeGreaterThanOrEqual(before);
    expect(capturedRequest.expiresAt).toBeLessThanOrEqual(before + 100);
  });

  it("should extract token as UNKNOWN when intent has no token or fromToken", async () => {
    const rule = new ApprovalGateRule({
      above: { amount: "0.5", token: "UNKNOWN" },
    });
    const intent = makeIntent({
      params: { to: "addr", amount: "10" } as any,
    });
    // Token is "UNKNOWN", threshold is also "UNKNOWN", so they match
    // Amount 10 > 0.5 -> needs approval -> DENY (no channel)
    const result = await rule.evaluate(intent, makeContext());
    expect(result.decision).toBe("DENY");
    if (result.decision === "DENY") {
      expect(result.reason).toContain("no approval channel");
    }
  });
});
