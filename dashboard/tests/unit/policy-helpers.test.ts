import { describe, it, expect } from "vitest";
import { policyConfigToRules } from "@/lib/policy-helpers";
import type { PolicyConfig } from "@kova/policy/types.js";

describe("policyConfigToRules", () => {
  it("returns empty array for empty config", () => {
    const rules = policyConfigToRules({} as unknown as PolicyConfig);
    expect(rules).toEqual([]);
  });

  it("creates RateLimitRule when rateLimit is configured", () => {
    const rules = policyConfigToRules({
      rateLimit: { maxTransactionsPerMinute: 5 },
    } as unknown as PolicyConfig);
    expect(rules).toHaveLength(1);
    expect(rules[0].constructor.name).toBe("RateLimitRule");
  });

  it("creates SpendingLimitRule when spendingLimit is configured", () => {
    const rules = policyConfigToRules({
      spendingLimit: {
        perTransaction: { amount: "1", token: "SOL" },
      },
    } as unknown as PolicyConfig);
    expect(rules).toHaveLength(1);
    expect(rules[0].constructor.name).toBe("SpendingLimitRule");
  });

  it("creates ApprovalGateRule when approvalGate is configured", () => {
    const rules = policyConfigToRules({
      approvalGate: {
        above: { amount: "1", token: "SOL" },
        timeout: 60_000,
      },
    } as unknown as PolicyConfig);
    expect(rules).toHaveLength(1);
    expect(rules[0].constructor.name).toBe("ApprovalGateRule");
  });

  it("creates AllowlistRule when addresses are configured", () => {
    const rules = policyConfigToRules({
      allowAddresses: ["addr1", "addr2"],
    } as unknown as PolicyConfig);
    expect(rules).toHaveLength(1);
    expect(rules[0].constructor.name).toBe("AllowlistRule");
  });

  it("orders rules: RateLimit -> TimeWindow -> Allowlist -> SpendingLimit -> ApprovalGate", () => {
    const rules = policyConfigToRules({
      rateLimit: { maxTransactionsPerMinute: 5 },
      activeHours: {
        monday: { start: "09:00", end: "17:00" },
      },
      allowAddresses: ["addr1"],
      spendingLimit: {
        daily: { amount: "10", token: "SOL" },
      },
      approvalGate: {
        above: { amount: "1", token: "SOL" },
        timeout: 60_000,
      },
    } as unknown as PolicyConfig);

    expect(rules).toHaveLength(5);
    expect(rules[0].constructor.name).toBe("RateLimitRule");
    expect(rules[1].constructor.name).toBe("TimeWindowRule");
    expect(rules[2].constructor.name).toBe("AllowlistRule");
    expect(rules[3].constructor.name).toBe("SpendingLimitRule");
    expect(rules[4].constructor.name).toBe("ApprovalGateRule");
  });

  it("does not create AllowlistRule when no addresses or programs configured", () => {
    const rules = policyConfigToRules({
      allowAddresses: [],
      denyAddresses: [],
    } as unknown as PolicyConfig);
    expect(rules).toHaveLength(0);
  });
});
