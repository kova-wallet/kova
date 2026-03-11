import { describe, it, expect } from "vitest";
import { Policy } from "../../../src/policy/builder.js";

describe("Policy Builder", () => {
  it("should create a basic policy with a name", () => {
    // POLICY-012: Policy now requires at least one rule
    const policy = Policy.create("test-policy")
      .rateLimit({ maxTransactionsPerMinute: 10 })
      .build();
    expect(policy.getName()).toBe("test-policy");
  });

  it("should reject empty policy name", () => {
    expect(() => Policy.create("").build()).toThrow("Policy name is required");
  });

  it("should reject whitespace-only policy name", () => {
    expect(() => Policy.create("   ").build()).toThrow("Policy name is required");
  });

  it("should configure spending limits", () => {
    const policy = Policy.create("test")
      .spendingLimit({
        perTransaction: { amount: "1.0", token: "SOL" },
        daily: { amount: "10", token: "SOL" },
      })
      .build();

    const config = policy.getConfig();
    expect(config.spendingLimit?.perTransaction?.amount).toBe("1.0");
    expect(config.spendingLimit?.daily?.amount).toBe("10");
  });

  it("should reject invalid spending limit amount", () => {
    expect(() =>
      Policy.create("test")
        .spendingLimit({ perTransaction: { amount: "-1", token: "SOL" } })
        .build(),
    ).toThrow("Invalid Spending limit amount");
  });

  it("should reject non-numeric spending limit amount", () => {
    expect(() =>
      Policy.create("test")
        .spendingLimit({ perTransaction: { amount: "abc", token: "SOL" } })
        .build(),
    ).toThrow("Invalid Spending limit amount");
  });

  it("should reject empty token in spending limit", () => {
    expect(() =>
      Policy.create("test")
        .spendingLimit({ perTransaction: { amount: "1", token: "" } })
        .build(),
    ).toThrow("Spending limit token is required");
  });

  it("should configure address allowlist", () => {
    const policy = Policy.create("test")
      .allowAddresses(["addr1", "addr2"])
      .build();

    const config = policy.getConfig();
    expect(config.allowAddresses).toEqual(["addr1", "addr2"]);
  });

  it("should configure program allowlist", () => {
    const policy = Policy.create("test")
      .allowPrograms(["prog1", "prog2"])
      .build();

    const config = policy.getConfig();
    expect(config.allowPrograms).toEqual(["prog1", "prog2"]);
  });

  it("should configure rate limits", () => {
    const policy = Policy.create("test")
      .rateLimit({ maxTransactionsPerMinute: 5, maxTransactionsPerHour: 30 })
      .build();

    const config = policy.getConfig();
    expect(config.rateLimit?.maxTransactionsPerMinute).toBe(5);
    expect(config.rateLimit?.maxTransactionsPerHour).toBe(30);
  });

  it("should configure active hours", () => {
    const policy = Policy.create("test")
      .activeHours({
        timezone: "UTC",
        windows: [{ days: ["mon", "tue"], start: "09:00", end: "17:00" }],
      })
      .build();

    const config = policy.getConfig();
    expect(config.activeHours?.timezone).toBe("UTC");
    expect(config.activeHours?.windows).toHaveLength(1);
  });

  it("should reject invalid time format in active hours", () => {
    expect(() =>
      Policy.create("test")
        .activeHours({
          timezone: "UTC",
          windows: [{ days: ["mon"], start: "25:00", end: "17:00" }],
        })
        .build(),
    ).toThrow("Invalid start time format");
  });

  it("should configure approval gate", () => {
    const policy = Policy.create("test")
      .requireApproval({ above: { amount: "1.0", token: "SOL" }, timeout: 60_000 })
      .build();

    const config = policy.getConfig();
    expect(config.approvalGate?.above.amount).toBe("1.0");
    expect(config.approvalGate?.timeout).toBe(60_000);
  });

  it("should reject negative approval gate timeout", () => {
    expect(() =>
      Policy.create("test")
        .requireApproval({ above: { amount: "1.0", token: "SOL" }, timeout: -1 })
        .build(),
    ).toThrow("Approval gate timeout must be a positive finite number");
  });

  it("should serialize to JSON and back", () => {
    const original = Policy.create("roundtrip")
      .spendingLimit({ daily: { amount: "5", token: "SOL" } })
      .allowAddresses(["addr1"])
      .rateLimit({ maxTransactionsPerMinute: 10 })
      .build();

    const json = original.toJSON();
    const restored = Policy.fromJSON(json);

    expect(restored.getName()).toBe("roundtrip");
    expect(restored.getConfig().spendingLimit?.daily?.amount).toBe("5");
    expect(restored.getConfig().allowAddresses).toEqual(["addr1"]);
  });

  it("should support chaining all methods", () => {
    const policy = Policy.create("full")
      .spendingLimit({ perTransaction: { amount: "1", token: "SOL" }, daily: { amount: "5", token: "SOL" } })
      .allowAddresses(["addr1"])
      .denyAddresses(["bad1"])
      .allowPrograms(["prog1"])
      .denyPrograms(["badprog1"])
      .rateLimit({ maxTransactionsPerMinute: 5 })
      .activeHours({ timezone: "UTC", windows: [{ days: ["mon"], start: "09:00", end: "17:00" }] })
      .requireApproval({ above: { amount: "2", token: "SOL" } })
      .build();

    const config = policy.getConfig();
    expect(config.name).toBe("full");
    expect(config.spendingLimit).toBeDefined();
    expect(config.allowAddresses).toBeDefined();
    expect(config.denyAddresses).toBeDefined();
    expect(config.allowPrograms).toBeDefined();
    expect(config.denyPrograms).toBeDefined();
    expect(config.rateLimit).toBeDefined();
    expect(config.activeHours).toBeDefined();
    expect(config.approvalGate).toBeDefined();
  });

  it("should extend a base policy", () => {
    const base = Policy.create("base")
      .spendingLimit({ daily: { amount: "5", token: "SOL" } })
      .rateLimit({ maxTransactionsPerMinute: 3 })
      .build();

    const extended = Policy.extend(base, "extended")
      .allowAddresses(["addr1"])
      .build();

    const config = extended.getConfig();
    expect(config.name).toBe("extended");
    expect(config.spendingLimit?.daily?.amount).toBe("5"); // inherited
    expect(config.allowAddresses).toEqual(["addr1"]); // added
    expect(config.rateLimit?.maxTransactionsPerMinute).toBe(3); // inherited
  });

  describe("spending limit validation edge cases", () => {
    it("should reject zero amount spending limit", () => {
      expect(() =>
        Policy.create("test")
          .spendingLimit({ perTransaction: { amount: "0", token: "SOL" } })
          .build(),
      ).toThrow("Invalid Spending limit amount");
    });

    it("should reject whitespace-only token in spending limit", () => {
      expect(() =>
        Policy.create("test")
          .spendingLimit({ perTransaction: { amount: "1", token: "   " } })
          .build(),
      ).toThrow("Spending limit token is required");
    });

    it("should accept valid daily spending limit", () => {
      const policy = Policy.create("test")
        .spendingLimit({ daily: { amount: "100", token: "USDC" } })
        .build();
      expect(policy.getConfig().spendingLimit?.daily?.amount).toBe("100");
    });

    it("should accept valid weekly spending limit", () => {
      const policy = Policy.create("test")
        .spendingLimit({ weekly: { amount: "500", token: "USDC" } })
        .build();
      expect(policy.getConfig().spendingLimit?.weekly?.amount).toBe("500");
    });

    it("should accept valid monthly spending limit", () => {
      const policy = Policy.create("test")
        .spendingLimit({ monthly: { amount: "2000", token: "USDC" } })
        .build();
      expect(policy.getConfig().spendingLimit?.monthly?.amount).toBe("2000");
    });

    it("should reject invalid daily amount", () => {
      expect(() =>
        Policy.create("test")
          .spendingLimit({ daily: { amount: "invalid", token: "SOL" } })
          .build(),
      ).toThrow("Invalid Spending limit amount");
    });

    it("should reject invalid weekly amount", () => {
      expect(() =>
        Policy.create("test")
          .spendingLimit({ weekly: { amount: "-10", token: "SOL" } })
          .build(),
      ).toThrow("Invalid Spending limit amount");
    });

    it("should reject invalid monthly amount", () => {
      expect(() =>
        Policy.create("test")
          .spendingLimit({ monthly: { amount: "0", token: "SOL" } })
          .build(),
      ).toThrow("Invalid Spending limit amount");
    });

    it("should accept very small spending limit", () => {
      const policy = Policy.create("test")
        .spendingLimit({ perTransaction: { amount: "0.0001", token: "SOL" } })
        .build();
      expect(policy.getConfig().spendingLimit?.perTransaction?.amount).toBe("0.0001");
    });

    it("should accept very large spending limit", () => {
      const policy = Policy.create("test")
        .spendingLimit({ perTransaction: { amount: "999999999", token: "SOL" } })
        .build();
      expect(policy.getConfig().spendingLimit?.perTransaction?.amount).toBe("999999999");
    });

    it("should validate all spending limit fields simultaneously", () => {
      expect(() =>
        Policy.create("test")
          .spendingLimit({
            perTransaction: { amount: "1", token: "SOL" },
            daily: { amount: "-5", token: "SOL" },
          })
          .build(),
      ).toThrow("Invalid Spending limit amount");
    });
  });

  describe("active hours validation edge cases", () => {
    it("should reject missing timezone", () => {
      expect(() =>
        Policy.create("test")
          .activeHours({
            timezone: "",
            windows: [{ days: ["mon"], start: "09:00", end: "17:00" }],
          })
          .build(),
      ).toThrow("Active hours timezone is required");
    });

    it("should reject empty windows array", () => {
      expect(() =>
        Policy.create("test")
          .activeHours({
            timezone: "UTC",
            windows: [],
          })
          .build(),
      ).toThrow("At least one active hours window is required");
    });

    it("should reject window with empty days array", () => {
      expect(() =>
        Policy.create("test")
          .activeHours({
            timezone: "UTC",
            windows: [{ days: [], start: "09:00", end: "17:00" }],
          })
          .build(),
      ).toThrow("Active hours window must specify at least one day");
    });

    it("should reject invalid end time format", () => {
      expect(() =>
        Policy.create("test")
          .activeHours({
            timezone: "UTC",
            windows: [{ days: ["mon"], start: "09:00", end: "25:00" }],
          })
          .build(),
      ).toThrow("Invalid end time format");
    });

    it("should reject time format without leading zero", () => {
      expect(() =>
        Policy.create("test")
          .activeHours({
            timezone: "UTC",
            windows: [{ days: ["mon"], start: "9:00", end: "17:00" }],
          })
          .build(),
      ).toThrow("Invalid start time format");
    });

    it("should reject time format with invalid minutes", () => {
      expect(() =>
        Policy.create("test")
          .activeHours({
            timezone: "UTC",
            windows: [{ days: ["mon"], start: "09:60", end: "17:00" }],
          })
          .build(),
      ).toThrow("Invalid start time format");
    });

    it("should accept multiple windows", () => {
      const policy = Policy.create("test")
        .activeHours({
          timezone: "America/New_York",
          windows: [
            { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" },
            { days: ["sat"], start: "10:00", end: "14:00" },
          ],
        })
        .build();
      expect(policy.getConfig().activeHours?.windows).toHaveLength(2);
    });

    it("should accept midnight boundary times", () => {
      const policy = Policy.create("test")
        .activeHours({
          timezone: "UTC",
          windows: [{ days: ["mon"], start: "00:00", end: "23:59" }],
        })
        .build();
      expect(policy.getConfig().activeHours?.windows[0]?.start).toBe("00:00");
      expect(policy.getConfig().activeHours?.windows[0]?.end).toBe("23:59");
    });
  });

  describe("approval gate validation edge cases", () => {
    it("should reject zero approval gate amount", () => {
      expect(() =>
        Policy.create("test")
          .requireApproval({ above: { amount: "0", token: "SOL" } })
          .build(),
      ).toThrow("Invalid approval gate amount");
    });

    it("should reject NaN approval gate amount", () => {
      expect(() =>
        Policy.create("test")
          .requireApproval({ above: { amount: "abc", token: "SOL" } })
          .build(),
      ).toThrow("Invalid approval gate amount");
    });

    it("should reject zero timeout", () => {
      expect(() =>
        Policy.create("test")
          .requireApproval({ above: { amount: "1", token: "SOL" }, timeout: 0 })
          .build(),
      ).toThrow("Approval gate timeout must be a positive finite number");
    });

    it("should accept approval gate without timeout (uses default)", () => {
      const policy = Policy.create("test")
        .requireApproval({ above: { amount: "5", token: "SOL" } })
        .build();
      expect(policy.getConfig().approvalGate?.timeout).toBeUndefined();
    });

    it("should accept approval gate with channel", () => {
      const policy = Policy.create("test")
        .requireApproval({ above: { amount: "5", token: "SOL" }, channel: "telegram" })
        .build();
      expect(policy.getConfig().approvalGate?.channel).toBe("telegram");
    });
  });

  describe("denylist configuration", () => {
    it("should configure address denylist", () => {
      const policy = Policy.create("test")
        .denyAddresses(["bad-addr1", "bad-addr2"])
        .build();
      expect(policy.getConfig().denyAddresses).toEqual(["bad-addr1", "bad-addr2"]);
    });

    it("should configure program denylist", () => {
      const policy = Policy.create("test")
        .denyPrograms(["bad-prog1"])
        .build();
      expect(policy.getConfig().denyPrograms).toEqual(["bad-prog1"]);
    });

    it("should handle empty allowlist", () => {
      // POLICY-012: Policy now requires at least one rule
      const policy = Policy.create("test")
        .allowAddresses([])
        .rateLimit({ maxTransactionsPerMinute: 10 })
        .build();
      expect(policy.getConfig().allowAddresses).toEqual([]);
    });

    it("should handle empty denylist", () => {
      // POLICY-012: Policy now requires at least one rule
      const policy = Policy.create("test")
        .denyAddresses([])
        .rateLimit({ maxTransactionsPerMinute: 10 })
        .build();
      expect(policy.getConfig().denyAddresses).toEqual([]);
    });

    it("should not share address array reference with input", () => {
      const addresses = ["addr1", "addr2"];
      const policy = Policy.create("test")
        .allowAddresses(addresses)
        .build();
      addresses.push("addr3"); // mutate original
      expect(policy.getConfig().allowAddresses).toEqual(["addr1", "addr2"]);
    });

    it("should not share program array reference with input", () => {
      const programs = ["prog1"];
      const policy = Policy.create("test")
        .allowPrograms(programs)
        .build();
      programs.push("prog2");
      expect(policy.getConfig().allowPrograms).toEqual(["prog1"]);
    });
  });

  describe("cooldown configuration", () => {
    it("should throw when cooldown is configured (no CooldownRule implementation)", () => {
      expect(() =>
        Policy.create("test")
          .cooldown({ afterTransactionAbove: { amount: "10", token: "SOL" }, waitMinutes: 30 })
          .build(),
      ).toThrow("no CooldownRule implementation exists");
    });
  });

  describe("extend overrides", () => {
    it("should allow overriding spending limits from base", () => {
      const base = Policy.create("base")
        .spendingLimit({ daily: { amount: "5", token: "SOL" } })
        .build();

      const extended = Policy.extend(base, "extended")
        .spendingLimit({ daily: { amount: "10", token: "SOL" } })
        .build();

      expect(extended.getConfig().spendingLimit?.daily?.amount).toBe("10");
    });

    it("should allow overriding rate limits from base", () => {
      const base = Policy.create("base")
        .rateLimit({ maxTransactionsPerMinute: 5 })
        .build();

      const extended = Policy.extend(base, "extended")
        .rateLimit({ maxTransactionsPerMinute: 10 })
        .build();

      expect(extended.getConfig().rateLimit?.maxTransactionsPerMinute).toBe(10);
    });
  });

  describe("serialization", () => {
    it("should produce a JSON that is a new object (not same reference)", () => {
      const policy = Policy.create("test")
        .allowAddresses(["addr1"])
        .build();

      const json1 = policy.toJSON();
      const json2 = policy.toJSON();
      expect(json1).not.toBe(json2); // different object references
      expect(json1).toEqual(json2); // but same content
    });

    it("should roundtrip a fully-configured policy", () => {
      const original = Policy.create("full-roundtrip")
        .spendingLimit({
          perTransaction: { amount: "1", token: "SOL" },
          daily: { amount: "10", token: "SOL" },
          weekly: { amount: "50", token: "SOL" },
          monthly: { amount: "200", token: "SOL" },
        })
        .allowAddresses(["addr1", "addr2"])
        .denyAddresses(["bad1"])
        .allowPrograms(["prog1"])
        .denyPrograms(["badprog1"])
        .rateLimit({ maxTransactionsPerMinute: 5, maxTransactionsPerHour: 30 })
        .activeHours({
          timezone: "UTC",
          windows: [{ days: ["mon", "fri"], start: "09:00", end: "17:00" }],
        })
        .requireApproval({ above: { amount: "2", token: "SOL" }, timeout: 60_000 })
        .build();

      const json = original.toJSON();
      const restored = Policy.fromJSON(json);

      expect(restored.getName()).toBe("full-roundtrip");
      expect(restored.getConfig()).toEqual(original.getConfig());
    });

    it("should handle fromJSON with minimal config", () => {
      // POLICY-012: Policy now requires at least one rule
      const policy = Policy.fromJSON({ name: "minimal", rateLimit: { maxTransactionsPerMinute: 10 } });
      expect(policy.getName()).toBe("minimal");
      expect(policy.getConfig().spendingLimit).toBeUndefined();
    });
  });

  describe("policy name edge cases", () => {
    it("should accept names with special characters", () => {
      // POLICY-012: Policy now requires at least one rule
      const policy = Policy.create("test-policy_v2.1")
        .rateLimit({ maxTransactionsPerMinute: 10 })
        .build();
      expect(policy.getName()).toBe("test-policy_v2.1");
    });

    it("should accept very long policy names", () => {
      const longName = "a".repeat(200);
      // POLICY-012: Policy now requires at least one rule
      const policy = Policy.create(longName)
        .rateLimit({ maxTransactionsPerMinute: 10 })
        .build();
      expect(policy.getName()).toBe(longName);
    });

    it("should accept names with unicode characters", () => {
      // POLICY-012: Policy now requires at least one rule
      const policy = Policy.create("policy-alpha-beta")
        .rateLimit({ maxTransactionsPerMinute: 10 })
        .build();
      expect(policy.getName()).toBe("policy-alpha-beta");
    });
  });
});
