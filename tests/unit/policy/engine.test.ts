import { describe, it, expect } from "vitest";
import { PolicyEngine } from "../../../src/policy/engine.js";
import { MemoryStore } from "../../../src/stores/memory.js";
import type { PolicyRule, PolicyDecision, PolicyContext } from "../../../src/policy/types.js";
import type { TransactionIntent } from "../../../src/core/intent.js";

function makeIntent(overrides?: Partial<TransactionIntent>): TransactionIntent {
  return {
    type: "transfer",
    chain: "solana",
    params: { to: "recipient", amount: "1.0", token: "SOL" },
    ...overrides,
  };
}

function makeRule(name: string, decision: PolicyDecision): PolicyRule {
  return {
    name,
    evaluate: async (_intent: TransactionIntent, _ctx: PolicyContext) => decision,
  };
}

describe("PolicyEngine", () => {
  it("should throw when no rules are configured", () => {
    expect(() => new PolicyEngine([], new MemoryStore())).toThrow(
      "PolicyEngine requires at least one rule",
    );
  });

  it("should ALLOW when all rules allow", async () => {
    const engine = new PolicyEngine(
      [
        makeRule("rule1", { decision: "ALLOW" }),
        makeRule("rule2", { decision: "ALLOW" }),
        makeRule("rule3", { decision: "ALLOW" }),
      ],
      new MemoryStore(),
    );
    const result = await engine.evaluate(makeIntent());
    expect(result.decision.decision).toBe("ALLOW");
  });

  it("should DENY when any rule denies", async () => {
    const engine = new PolicyEngine(
      [
        makeRule("rule1", { decision: "ALLOW" }),
        makeRule("rule2", { decision: "DENY", rule: "rule2", reason: "blocked" }),
        makeRule("rule3", { decision: "ALLOW" }),
      ],
      new MemoryStore(),
    );
    const result = await engine.evaluate(makeIntent());
    expect(result.decision.decision).toBe("DENY");
    if (result.decision.decision === "DENY") {
      expect(result.decision.reason).toBe("blocked");
    }
  });

  it("should stop evaluation at first DENY", async () => {
    let rule3Called = false;
    const rule3: PolicyRule = {
      name: "rule3",
      evaluate: async () => {
        rule3Called = true;
        return { decision: "ALLOW" };
      },
    };

    const engine = new PolicyEngine(
      [
        makeRule("rule1", { decision: "ALLOW" }),
        makeRule("rule2", { decision: "DENY", rule: "rule2", reason: "blocked" }),
        rule3,
      ],
      new MemoryStore(),
    );

    await engine.evaluate(makeIntent());
    expect(rule3Called).toBe(false);
  });

  it("should return PENDING for approval gates", async () => {
    const engine = new PolicyEngine(
      [
        makeRule("rule1", { decision: "ALLOW" }),
        makeRule("approval", {
          decision: "PENDING",
          rule: "approval",
          approvalRequestId: "req-123",
        }),
      ],
      new MemoryStore(),
    );

    const result = await engine.evaluate(makeIntent());
    expect(result.decision.decision).toBe("PENDING");
  });

  it("should list rule names", () => {
    const engine = new PolicyEngine(
      [makeRule("rate-limit", { decision: "ALLOW" }), makeRule("spending", { decision: "ALLOW" })],
      new MemoryStore(),
    );
    expect(engine.getRuleNames()).toEqual(["rate-limit", "spending"]);
  });

  it("should throw when constructing with no rules (getRuleNames never reached)", () => {
    expect(() => new PolicyEngine([], new MemoryStore())).toThrow(
      "PolicyEngine requires at least one rule",
    );
  });

  it("should stop evaluation at first PENDING (not just DENY)", async () => {
    let rule3Called = false;
    const rule3: PolicyRule = {
      name: "rule3",
      evaluate: async () => {
        rule3Called = true;
        return { decision: "ALLOW" };
      },
    };

    const engine = new PolicyEngine(
      [
        makeRule("rule1", { decision: "ALLOW" }),
        makeRule("approval", { decision: "PENDING", rule: "approval", approvalRequestId: "req-1" }),
        rule3,
      ],
      new MemoryStore(),
    );

    await engine.evaluate(makeIntent());
    expect(rule3Called).toBe(false);
  });

  it("should pass the store to rule context", async () => {
    const store = new MemoryStore();
    let receivedStore: unknown = null;

    const inspectRule: PolicyRule = {
      name: "inspector",
      evaluate: async (_intent: TransactionIntent, ctx: PolicyContext) => {
        receivedStore = ctx.store;
        return { decision: "ALLOW" };
      },
    };

    const engine = new PolicyEngine([inspectRule], store);
    await engine.evaluate(makeIntent());
    expect(receivedStore).toBe(store);
  });

  it("should pass injectable now timestamp to context", async () => {
    const fixedNow = 1700000000000;
    let receivedNow: number | null = null;

    const inspectRule: PolicyRule = {
      name: "inspector",
      evaluate: async (_intent: TransactionIntent, ctx: PolicyContext) => {
        receivedNow = ctx.now;
        return { decision: "ALLOW" };
      },
    };

    const engine = new PolicyEngine([inspectRule], new MemoryStore());
    await engine.evaluate(makeIntent(), fixedNow);
    expect(receivedNow).toBe(fixedNow);
  });

  it("should use Date.now() when no timestamp is provided", async () => {
    let receivedNow: number | null = null;
    const beforeEval = Date.now();

    const inspectRule: PolicyRule = {
      name: "inspector",
      evaluate: async (_intent: TransactionIntent, ctx: PolicyContext) => {
        receivedNow = ctx.now;
        return { decision: "ALLOW" };
      },
    };

    const engine = new PolicyEngine([inspectRule], new MemoryStore());
    await engine.evaluate(makeIntent());
    const afterEval = Date.now();

    expect(receivedNow).toBeGreaterThanOrEqual(beforeEval);
    expect(receivedNow).toBeLessThanOrEqual(afterEval);
  });

  it("should pass the intent to each rule", async () => {
    const receivedIntents: TransactionIntent[] = [];

    const captureRule: PolicyRule = {
      name: "capture",
      evaluate: async (intent: TransactionIntent) => {
        receivedIntents.push(intent);
        return { decision: "ALLOW" };
      },
    };

    const engine = new PolicyEngine([captureRule, captureRule], new MemoryStore());
    const testIntent = makeIntent({ type: "swap" });
    await engine.evaluate(testIntent);

    expect(receivedIntents).toHaveLength(2);
    expect(receivedIntents[0]).toBe(testIntent);
    expect(receivedIntents[1]).toBe(testIntent);
  });

  it("should handle when first rule of multiple denies", async () => {
    const engine = new PolicyEngine(
      [
        makeRule("first", { decision: "DENY", rule: "first", reason: "denied by first" }),
        makeRule("second", { decision: "ALLOW" }),
      ],
      new MemoryStore(),
    );
    const result = await engine.evaluate(makeIntent());
    expect(result.decision.decision).toBe("DENY");
    if (result.decision.decision === "DENY") {
      expect(result.decision.rule).toBe("first");
      expect(result.decision.reason).toBe("denied by first");
    }
  });

  it("should handle rule that returns DENY with detailed reason", async () => {
    const engine = new PolicyEngine(
      [
        makeRule("spending", {
          decision: "DENY",
          rule: "spending-limit",
          reason: "Daily spending limit of 10 SOL exceeded (current: 12 SOL)",
        }),
      ],
      new MemoryStore(),
    );
    const result = await engine.evaluate(makeIntent());
    expect(result.decision.decision).toBe("DENY");
    if (result.decision.decision === "DENY") {
      expect(result.decision.reason).toContain("Daily spending limit");
    }
  });

  it("should pass approval channel to context when provided", async () => {
    let receivedApproval: unknown = null;
    const mockApproval = {
      name: "test-approval",
      requestApproval: async () => ({
        requestId: "req-1",
        decision: "approved" as const,
        decidedAt: Date.now(),
      }),
    };

    const inspectRule: PolicyRule = {
      name: "inspector",
      evaluate: async (_intent: TransactionIntent, ctx: PolicyContext) => {
        receivedApproval = ctx.approval;
        return { decision: "ALLOW" };
      },
    };

    const engine = new PolicyEngine([inspectRule], new MemoryStore(), mockApproval);
    await engine.evaluate(makeIntent());
    expect(receivedApproval).toBe(mockApproval);
  });

  it("should have undefined approval in context when not provided", async () => {
    let receivedApproval: unknown = "not-set";

    const inspectRule: PolicyRule = {
      name: "inspector",
      evaluate: async (_intent: TransactionIntent, ctx: PolicyContext) => {
        receivedApproval = ctx.approval;
        return { decision: "ALLOW" };
      },
    };

    const engine = new PolicyEngine([inspectRule], new MemoryStore());
    await engine.evaluate(makeIntent());
    expect(receivedApproval).toBeUndefined();
  });

  it("should evaluate rules sequentially (not in parallel)", async () => {
    const callOrder: string[] = [];

    const rule1: PolicyRule = {
      name: "rule1",
      evaluate: async () => {
        callOrder.push("rule1-start");
        await new Promise((r) => setTimeout(r, 5));
        callOrder.push("rule1-end");
        return { decision: "ALLOW" };
      },
    };

    const rule2: PolicyRule = {
      name: "rule2",
      evaluate: async () => {
        callOrder.push("rule2-start");
        return { decision: "ALLOW" };
      },
    };

    const engine = new PolicyEngine([rule1, rule2], new MemoryStore());
    await engine.evaluate(makeIntent());

    expect(callOrder).toEqual(["rule1-start", "rule1-end", "rule2-start"]);
  });

  it("should handle evaluation with different intent types", async () => {
    const engine = new PolicyEngine(
      [makeRule("rule1", { decision: "ALLOW" })],
      new MemoryStore(),
    );

    const types: Array<"transfer" | "swap" | "mint" | "stake" | "custom"> = [
      "transfer", "swap", "mint", "stake", "custom",
    ];

    for (const type of types) {
      const result = await engine.evaluate(makeIntent({ type }));
      expect(result.decision.decision).toBe("ALLOW");
    }
  });

  // ── S6: Per-rule audit data ──────────────────────────────────────────

  it("should return ruleAudits with per-rule data for all rules", async () => {
    const engine = new PolicyEngine(
      [
        makeRule("rule1", { decision: "ALLOW" }),
        makeRule("rule2", { decision: "ALLOW" }),
        makeRule("rule3", { decision: "ALLOW" }),
      ],
      new MemoryStore(),
    );
    const result = await engine.evaluate(makeIntent());

    expect(result.ruleAudits).toHaveLength(3);
    expect(result.ruleAudits[0]!.rule).toBe("rule1");
    expect(result.ruleAudits[0]!.result).toBe("ALLOW");
    expect(result.ruleAudits[1]!.rule).toBe("rule2");
    expect(result.ruleAudits[2]!.rule).toBe("rule3");
    expect(result.ruleAudits.every(a => a.evaluationTimeMs >= 0)).toBe(true);
  });

  it("should return ruleAudits up to the denying rule", async () => {
    const engine = new PolicyEngine(
      [
        makeRule("rule1", { decision: "ALLOW" }),
        makeRule("rule2", { decision: "DENY", rule: "rule2", reason: "blocked" }),
        makeRule("rule3", { decision: "ALLOW" }),
      ],
      new MemoryStore(),
    );
    const result = await engine.evaluate(makeIntent());

    // Only 2 audits — rule3 was never evaluated
    expect(result.ruleAudits).toHaveLength(2);
    expect(result.ruleAudits[0]!.rule).toBe("rule1");
    expect(result.ruleAudits[0]!.result).toBe("ALLOW");
    expect(result.ruleAudits[1]!.rule).toBe("rule2");
    expect(result.ruleAudits[1]!.result).toBe("DENY");
    expect(result.ruleAudits[1]!.reason).toBe("blocked");
  });

  it("should include totalEvaluationTimeMs", async () => {
    const engine = new PolicyEngine(
      [makeRule("rule1", { decision: "ALLOW" })],
      new MemoryStore(),
    );
    const result = await engine.evaluate(makeIntent());
    expect(result.totalEvaluationTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("should include per-rule evaluationTimeMs", async () => {
    const slowRule: PolicyRule = {
      name: "slow",
      evaluate: async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { decision: "ALLOW" };
      },
    };

    const engine = new PolicyEngine([slowRule], new MemoryStore());
    const result = await engine.evaluate(makeIntent());
    expect(result.ruleAudits[0]!.evaluationTimeMs).toBeGreaterThan(0);
  });

  // ── S6: Fail-closed on rule errors ──────────────────────────────────

  it("should DENY when a rule throws (fail-closed)", async () => {
    const throwingRule: PolicyRule = {
      name: "broken-rule",
      evaluate: async () => {
        throw new Error("Store connection lost");
      },
    };

    const engine = new PolicyEngine(
      [makeRule("rule1", { decision: "ALLOW" }), throwingRule],
      new MemoryStore(),
    );
    const result = await engine.evaluate(makeIntent());

    expect(result.decision.decision).toBe("DENY");
    if (result.decision.decision === "DENY") {
      expect(result.decision.rule).toBe("broken-rule");
      expect(result.decision.reason).toContain("Rule evaluation error");
      expect(result.decision.reason).toContain("Store connection lost");
    }
  });

  it("should include audit trail when rule throws", async () => {
    const throwingRule: PolicyRule = {
      name: "broken-rule",
      evaluate: async () => {
        throw new Error("DB failure");
      },
    };

    const engine = new PolicyEngine(
      [makeRule("rule1", { decision: "ALLOW" }), throwingRule],
      new MemoryStore(),
    );
    const result = await engine.evaluate(makeIntent());

    expect(result.ruleAudits).toHaveLength(2);
    expect(result.ruleAudits[0]!.rule).toBe("rule1");
    expect(result.ruleAudits[0]!.result).toBe("ALLOW");
    expect(result.ruleAudits[1]!.rule).toBe("broken-rule");
    expect(result.ruleAudits[1]!.result).toBe("DENY");
    expect(result.ruleAudits[1]!.reason).toContain("Rule evaluation error");
    expect(result.ruleAudits[1]!.evaluationTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("should handle non-Error throws in rules (fail-closed)", async () => {
    const throwingRule: PolicyRule = {
      name: "string-thrower",
      evaluate: async () => {
        throw "string error";
      },
    };

    const engine = new PolicyEngine([throwingRule], new MemoryStore());
    const result = await engine.evaluate(makeIntent());

    expect(result.decision.decision).toBe("DENY");
    if (result.decision.decision === "DENY") {
      expect(result.decision.reason).toContain("string error");
    }
  });

  it("should stop evaluating subsequent rules after a throw", async () => {
    let rule3Called = false;
    const throwingRule: PolicyRule = {
      name: "throwing",
      evaluate: async () => { throw new Error("crash"); },
    };
    const rule3: PolicyRule = {
      name: "rule3",
      evaluate: async () => {
        rule3Called = true;
        return { decision: "ALLOW" };
      },
    };

    const engine = new PolicyEngine([throwingRule, rule3], new MemoryStore());
    await engine.evaluate(makeIntent());
    expect(rule3Called).toBe(false);
  });
});
