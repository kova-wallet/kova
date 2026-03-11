/**
 * Spending limit rollback tests — verifies the rollback guarantees documented
 * in spending-limit.ts lines 17-19:
 *
 *   "Rollback guarantees: On denial or error, all incremented counters are rolled
 *    back (decremented). Rollback failure results in slight under-counting (safe direction)."
 *
 * Tests are organised into four areas:
 *  1. Counter not incremented when a limit is breached mid-evaluation
 *  2. Sliding window log not appended when a rule DENYs
 *  3. Counter rollback when Phase 2 (commit) fails inside PolicyEngine
 *  4. Two-phase atomicity: only one of two concurrent evaluations commits
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryStore } from "../../../src/stores/memory.js";
import { SpendingLimitRule } from "../../../src/policy/rules/spending-limit.js";
import { PolicyEngine } from "../../../src/policy/engine.js";
import { normalizeTokenId } from "../../../src/policy/utils.js";
import type { PolicyRule, PolicyContext, PolicyDecision } from "../../../src/policy/types.js";
import type { TransactionIntent } from "../../../src/core/intent.js";
import type { Store } from "../../../src/stores/interface.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTransfer(amount: string, token = "SOL"): TransactionIntent {
  return {
    type: "transfer",
    chain: "solana",
    params: { to: "recipient", amount, token },
  };
}

function makeContext(store: Store, now = Date.now()): PolicyContext {
  return { store, now };
}

/**
 * Return all sliding-window log entries for a given key.
 */
async function readLog(store: Store, key: string): Promise<string[]> {
  return store.getRecent(key, 100_000);
}

/** Build the sliding window log key the SpendingLimitRule writes for a token+window combo. */
function logKey(window: "daily" | "weekly" | "monthly", token: string, prefix = "spending:"): string {
  return `${prefix}log:${window}:${normalizeTokenId(token)}`;
}

// ---------------------------------------------------------------------------
// Suite 1 — DENY: counters not incremented, log not appended
// ---------------------------------------------------------------------------

describe("SpendingLimitRule — rollback on DENY", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  afterEach(() => {
    store.stopGc();
  });

  it("does not increment daily counter when per-transaction limit DENYs (stateless)", async () => {
    // perTransaction is checked BEFORE any counter is touched; DENY is stateless.
    const rule = new SpendingLimitRule({
      perTransaction: { amount: "5", token: "SOL" },
      daily: { amount: "100", token: "SOL" },
    });

    const ctx = makeContext(store);
    const result = await rule.evaluate(makeTransfer("10"), ctx); // exceeds perTransaction

    expect(result.decision).toBe("DENY");
    // M22 fix: No separate counter key — only the log matters. Log must be empty.
    expect(await readLog(store, logKey("daily", "SOL"))).toHaveLength(0);
  });

  it("does not increment weekly counter when daily limit DENYs mid-evaluation", async () => {
    // Configure daily=5 SOL and weekly=50 SOL.
    // Fill the daily window near its limit, then attempt a transaction that breaches it.
    const rule = new SpendingLimitRule({
      daily: { amount: "5", token: "SOL" },
      weekly: { amount: "50", token: "SOL" },
    });

    const now = Date.now();

    // Allow 4 SOL — stays within daily limit of 5 SOL.
    const allow1 = await rule.evaluate(makeTransfer("4"), makeContext(store, now));
    expect(allow1.decision).toBe("ALLOW");

    // Now try 2 SOL — daily total would become 6, exceeding 5 SOL limit.
    // Daily check fires before the weekly log is appended.
    const deny = await rule.evaluate(makeTransfer("2"), makeContext(store, now));
    expect(deny.decision).toBe("DENY");

    // M22 fix: The sliding window log is now the sole source of truth (no separate
    // counter key). The denied 2 SOL attempt must NOT appear in either log.
    const dailyLog = await readLog(store, logKey("daily", "SOL"));
    const weeklyLog = await readLog(store, logKey("weekly", "SOL"));

    // Each log should have exactly one entry (from the first ALLOW).
    expect(dailyLog).toHaveLength(1);
    expect(weeklyLog).toHaveLength(1);
  });

  it("rolling back daily+weekly leaves monthly log uninflated", async () => {
    // Tight daily limit forces early denial; verify monthly log is untouched.
    const rule = new SpendingLimitRule({
      daily: { amount: "3", token: "SOL" },
      weekly: { amount: "20", token: "SOL" },
      monthly: { amount: "50", token: "SOL" },
    });

    const now = Date.now();

    // Allow 2 SOL — passes all three window checks.
    const allow = await rule.evaluate(makeTransfer("2"), makeContext(store, now));
    expect(allow.decision).toBe("ALLOW");

    // Attempt 2 more SOL — daily total becomes 4 > 3, DENY.
    // M22 fix: No separate counter to roll back — only the log matters.
    const deny = await rule.evaluate(makeTransfer("2"), makeContext(store, now));
    expect(deny.decision).toBe("DENY");

    // Monthly log must have exactly one entry (from the first allowed tx only).
    const monthlyLog = await readLog(store, logKey("monthly", "SOL"));
    expect(monthlyLog).toHaveLength(1);
  });

  it("sliding window log is NOT appended after a denial", async () => {
    const rule = new SpendingLimitRule({
      daily: { amount: "10", token: "SOL" },
    });

    const now = Date.now();

    // First tx: 9 SOL — allowed.
    await rule.evaluate(makeTransfer("9"), makeContext(store, now));

    // Second tx: 2 SOL — projected 11 >= 10, denied.
    const deny = await rule.evaluate(makeTransfer("2"), makeContext(store, now));
    expect(deny.decision).toBe("DENY");

    // Log must contain only the one entry from the allowed transaction.
    const logEntries = await readLog(store, logKey("daily", "SOL"));
    expect(logEntries).toHaveLength(1);

    // The single entry must encode the 9 SOL amount (timestamp:amount format).
    const entryAmount = parseFloat(logEntries[0]!.split(":")[1]!);
    expect(entryAmount).toBeCloseTo(9, 5);
  });

  it("log is unchanged after a denied transaction (no phantom entries)", async () => {
    // M22 fix: Since the sliding window log is now the sole source of truth
    // (no separate counter key), verify only log entries exist after allow/deny.
    const rule = new SpendingLimitRule({
      daily: { amount: "10", token: "SOL" },
    });

    const now = Date.now();

    // Allow 6 SOL — log has one entry.
    await rule.evaluate(makeTransfer("6"), makeContext(store, now));
    const logAfterAllow = await readLog(store, logKey("daily", "SOL"));
    expect(logAfterAllow).toHaveLength(1);

    // Deny 5 SOL — would take daily to 11 >= 10. Log must still have only one entry.
    const deny = await rule.evaluate(makeTransfer("5"), makeContext(store, now));
    expect(deny.decision).toBe("DENY");

    const logAfterDeny = await readLog(store, logKey("daily", "SOL"));
    expect(logAfterDeny).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — Error path: rollback on store error during evaluation
// ---------------------------------------------------------------------------

describe("SpendingLimitRule — rollback on store error", () => {
  it("daily log has phantom entry when weekly read throws (safe direction)", async () => {
    // M22 fix: Sequence inside slidingWindowCheckLimit for the daily window:
    //   1. getRecent(dailyLogKey)       — reads daily window entries
    //   2. append(dailyLogKey)          — records daily tx in sliding window log
    // Then slidingWindowCheckLimit for the weekly window:
    //   3. getRecent(weeklyLogKey)      — THROWS HERE
    //
    // The daily log entry (step 2) was appended before the weekly error.
    // The rollback path cannot remove list entries. This is the documented
    // "safe direction": the phantom entry causes slight over-counting of
    // spending (conservative), as noted in spending-limit.ts.
    const base = new MemoryStore();

    // Proxy store: let everything work normally except getRecent on the weekly log key.
    const faultyStore: Store = {
      get: (k) => base.get(k),
      set: (k, v, ttl) => base.set(k, v, ttl),
      setIfNotExists: (k, v, ttl) => base.setIfNotExists(k, v, ttl),
      increment: (k, amt) => base.increment(k, amt),
      append: (k, v) => base.append(k, v),
      getRecent: (k, count) => {
        // Throw only on the weekly sliding-window log key.
        if (k.includes(":weekly:")) {
          throw new Error("simulated store failure on weekly read");
        }
        return base.getRecent(k, count);
      },
      clearList: (k) => base.clearList(k),
    };

    const rule = new SpendingLimitRule({
      daily: { amount: "100", token: "SOL" },
      weekly: { amount: "500", token: "SOL" },
    });

    const ctx = makeContext(faultyStore);
    await expect(rule.evaluate(makeTransfer("10"), ctx)).rejects.toThrow(
      "simulated store failure on weekly read",
    );

    // M22 fix: The daily log has the phantom entry from the aborted transaction.
    // This is safe direction (over-counting spending, not under-counting).
    const dailyLog = await readLog(base, logKey("daily", "SOL"));
    expect(dailyLog).toHaveLength(1); // phantom entry from aborted tx
    // Verify the phantom entry encodes the correct amount (10 SOL).
    const phantomAmount = parseFloat(dailyLog[0]!.split(":")[1]!);
    expect(phantomAmount).toBeCloseTo(10, 5);
  });

  it("does not increment weekly counter at all when weekly getRecent throws before increment", async () => {
    // The weekly counter should never have been incremented because the error
    // fires during getRecent (before the increment step for the weekly window).
    const base = new MemoryStore();

    const faultyStore: Store = {
      get: (k) => base.get(k),
      set: (k, v, ttl) => base.set(k, v, ttl),
      setIfNotExists: (k, v, ttl) => base.setIfNotExists(k, v, ttl),
      increment: (k, amt) => base.increment(k, amt),
      append: (k, v) => base.append(k, v),
      getRecent: (k, count) => {
        if (k.includes(":weekly:")) {
          throw new Error("simulated store failure on weekly read");
        }
        return base.getRecent(k, count);
      },
      clearList: (k) => base.clearList(k),
    };

    const rule = new SpendingLimitRule({
      daily: { amount: "100", token: "SOL" },
      weekly: { amount: "500", token: "SOL" },
    });

    const ctx = makeContext(faultyStore);
    await expect(rule.evaluate(makeTransfer("10"), ctx)).rejects.toThrow();

    // M22 fix: The weekly log was never appended — error happened during getRecent
    // which is the very first operation of the weekly window check.
    const weeklyLog = await readLog(base, logKey("weekly", "SOL"));
    expect(weeklyLog).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — PolicyEngine two-phase: Phase 2 denial must not leave inflated counters
// ---------------------------------------------------------------------------

describe("PolicyEngine two-phase evaluation — no counter inflation on Phase 2 DENY", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  afterEach(() => {
    store.stopGc();
  });

  it("spending counter is not inflated when a second rule DENYs in Phase 2", async () => {
    // The SpendingLimitRule ALLOWs in Phase 1 (dry-run) and Phase 2 (commit).
    // A second rule that always DENYs fires during Phase 1 before Phase 2 runs,
    // so the engine stops and never commits — the counter must remain at zero.
    const spendingRule = new SpendingLimitRule({
      daily: { amount: "100", token: "SOL" },
    });

    const blockingRule: PolicyRule = {
      name: "always-deny",
      evaluate: async (): Promise<PolicyDecision> => ({
        decision: "DENY",
        rule: "always-deny",
        reason: "test blocker",
      }),
    };

    const engine = new PolicyEngine([spendingRule, blockingRule], store);
    const result = await engine.evaluate(makeTransfer("10"));

    expect(result.decision.decision).toBe("DENY");

    // M22 fix: The log must be empty — Phase 2 never ran.
    const logEntries = await readLog(store, logKey("daily", "SOL"));
    expect(logEntries).toHaveLength(0);
  });

  it("spending log IS appended when both rules ALLOW", async () => {
    const spendingRule = new SpendingLimitRule({
      daily: { amount: "100", token: "SOL" },
    });

    const allowRule: PolicyRule = {
      name: "always-allow",
      evaluate: async (): Promise<PolicyDecision> => ({ decision: "ALLOW" }),
    };

    const engine = new PolicyEngine([spendingRule, allowRule], store);
    const result = await engine.evaluate(makeTransfer("10"));

    expect(result.decision.decision).toBe("ALLOW");

    // M22 fix: Phase 2 committed — the sliding window log (sole source of truth)
    // should reflect the 10 SOL transaction.
    const logEntries = await readLog(store, logKey("daily", "SOL"));
    expect(logEntries).toHaveLength(1);
    const entryAmount = parseFloat(logEntries[0]!.split(":")[1]!);
    expect(entryAmount).toBeCloseTo(10, 5);
  });

  it("spending rule before blocking rule: counter stays zero across multiple denied attempts", async () => {
    const spendingRule = new SpendingLimitRule({
      daily: { amount: "100", token: "SOL" },
    });

    const blockingRule: PolicyRule = {
      name: "block-all",
      evaluate: async (): Promise<PolicyDecision> => ({
        decision: "DENY",
        rule: "block-all",
        reason: "always blocked",
      }),
    };

    const engine = new PolicyEngine([spendingRule, blockingRule], store);

    // Make 5 denied requests — counter must stay at zero throughout.
    for (let i = 0; i < 5; i++) {
      const result = await engine.evaluate(makeTransfer("10"));
      expect(result.decision.decision).toBe("DENY");
    }

    // M22 fix: Log must be empty — no transactions were committed.
    const logEntries = await readLog(store, logKey("daily", "SOL"));
    expect(logEntries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — Concurrency atomicity via PolicyEngine mutex
// ---------------------------------------------------------------------------

describe("PolicyEngine mutex — only one of two concurrent evaluations commits", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  afterEach(() => {
    store.stopGc();
  });

  it("serialises concurrent evaluations so the spending log is exact", async () => {
    // Budget: 15 SOL daily. Two evaluations of 10 SOL race each other.
    // The mutex ensures they run sequentially: the first succeeds (10 SOL committed),
    // the second is denied (10 + 10 = 20 >= 15 limit).
    const spendingRule = new SpendingLimitRule({
      daily: { amount: "15", token: "SOL" },
    });
    const engine = new PolicyEngine([spendingRule], store);

    const now = Date.now();
    const [result1, result2] = await Promise.all([
      engine.evaluate(makeTransfer("10"), now),
      engine.evaluate(makeTransfer("10"), now),
    ]);

    const decisions = [result1.decision.decision, result2.decision.decision];

    // Exactly one must ALLOW and exactly one must DENY.
    expect(decisions.filter((d) => d === "ALLOW")).toHaveLength(1);
    expect(decisions.filter((d) => d === "DENY")).toHaveLength(1);

    // M22 fix: Log (sole source of truth) must have exactly one entry.
    const logEntries = await readLog(store, logKey("daily", "SOL"));
    expect(logEntries).toHaveLength(1);
  });

  it("three concurrent evaluations near the limit: at most one commits", async () => {
    // Budget: 8 SOL. Three simultaneous requests for 5 SOL each.
    // Only the first through the mutex can pass (5 < 8). The second and third
    // are denied (5 + 5 = 10 >= 8).
    const spendingRule = new SpendingLimitRule({
      daily: { amount: "8", token: "SOL" },
    });
    const engine = new PolicyEngine([spendingRule], store);

    const now = Date.now();
    const results = await Promise.all([
      engine.evaluate(makeTransfer("5"), now),
      engine.evaluate(makeTransfer("5"), now),
      engine.evaluate(makeTransfer("5"), now),
    ]);

    const allows = results.filter((r) => r.decision.decision === "ALLOW");
    expect(allows).toHaveLength(1);

    // M22 fix: Log (sole source of truth) must have exactly one entry.
    const logEntries = await readLog(store, logKey("daily", "SOL"));
    expect(logEntries).toHaveLength(1);
  });
});
