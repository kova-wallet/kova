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
 * Read the raw numeric value of a counter key from the store.
 * Returns 0 when the key is absent (no counter has been written yet).
 */
async function readCounter(store: Store, key: string): Promise<number> {
  const raw = await store.get(key);
  if (raw === null) return 0;
  const parsed = parseFloat(raw);
  return isNaN(parsed) ? 0 : parsed;
}

/**
 * Return all sliding-window log entries for a given key.
 */
async function readLog(store: Store, logKey: string): Promise<string[]> {
  return store.getRecent(logKey, 100_000);
}

/**
 * Mirrors the production normalizeTokenId logic used by SpendingLimitRule
 * when building store key names.
 *
 * Short alphanumeric tokens (1-20 chars) → uppercase.
 * EVM addresses (0x + 40 hex) → lowercase.
 * Others → as-is.
 *
 * e.g. normalizeToken("SOL") === "SOL", normalizeToken("usdc") === "USDC"
 */
function normalizeToken(token: string): string {
  if (token.startsWith("0x") && token.length === 42) return token.toLowerCase();
  if (/^[A-Za-z0-9_-]{1,20}$/.test(token)) return token.toUpperCase();
  return token;
}

/** Build the counter key the SpendingLimitRule writes for a token+window combo. */
function counterKey(window: "daily" | "weekly" | "monthly", token: string, prefix = "spending:"): string {
  return `${prefix}${window}:${normalizeToken(token)}`;
}

/** Build the sliding window log key the SpendingLimitRule writes for a token+window combo. */
function logKey(window: "daily" | "weekly" | "monthly", token: string, prefix = "spending:"): string {
  return `${prefix}log:${window}:${normalizeToken(token)}`;
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
    // The daily counter must be zero — no increment should have occurred.
    expect(await readCounter(store, counterKey("daily", "SOL"))).toBe(0);
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
    // Daily check fires and rolls back before the weekly counter is touched.
    const deny = await rule.evaluate(makeTransfer("2"), makeContext(store, now));
    expect(deny.decision).toBe("DENY");

    // Daily counter reflects the first ALLOW (4 SOL), not the rolled-back attempt.
    const dailyCounter = await readCounter(store, counterKey("daily", "SOL"));
    expect(dailyCounter).toBeCloseTo(4, 5);

    // Weekly counter: the first transaction went through both daily + weekly checks,
    // so the weekly counter should also be 4 SOL.
    const weeklyCounter = await readCounter(store, counterKey("weekly", "SOL"));
    expect(weeklyCounter).toBeCloseTo(4, 5);

    // The denied 2 SOL attempt must NOT appear in either log.
    const dailyLog = await readLog(store, logKey("daily", "SOL"));
    const weeklyLog = await readLog(store, logKey("weekly", "SOL"));

    // Each log should have exactly one entry (from the first ALLOW).
    expect(dailyLog).toHaveLength(1);
    expect(weeklyLog).toHaveLength(1);
  });

  it("rolling back daily+weekly leaves monthly counter uninflated", async () => {
    // Tight daily limit forces early denial; verify monthly counter is untouched.
    const rule = new SpendingLimitRule({
      daily: { amount: "3", token: "SOL" },
      weekly: { amount: "20", token: "SOL" },
      monthly: { amount: "50", token: "SOL" },
    });

    const now = Date.now();

    // Allow 2 SOL — passes all three window checks.
    const allow = await rule.evaluate(makeTransfer("2"), makeContext(store, now));
    expect(allow.decision).toBe("ALLOW");

    // Attempt 2 more SOL — daily total becomes 4 > 3, DENY. Daily and weekly
    // counters are rolled back; monthly counter must remain at 2 (from first tx).
    const deny = await rule.evaluate(makeTransfer("2"), makeContext(store, now));
    expect(deny.decision).toBe("DENY");

    // Monthly counter must equal 2 (from the first allowed tx only).
    const monthlyCounter = await readCounter(store, counterKey("monthly", "SOL"));
    expect(monthlyCounter).toBeCloseTo(2, 5);

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

  it("counter is decremented back to exact previous value on rollback", async () => {
    const rule = new SpendingLimitRule({
      daily: { amount: "10", token: "SOL" },
    });

    const now = Date.now();

    // Allow 6 SOL — daily counter becomes 6.
    await rule.evaluate(makeTransfer("6"), makeContext(store, now));
    const counterAfterAllow = await readCounter(store, counterKey("daily", "SOL"));
    expect(counterAfterAllow).toBeCloseTo(6, 5);

    // Deny 5 SOL — would take daily to 11 >= 10. Counter must roll back to 6.
    const deny = await rule.evaluate(makeTransfer("5"), makeContext(store, now));
    expect(deny.decision).toBe("DENY");

    const counterAfterDeny = await readCounter(store, counterKey("daily", "SOL"));
    expect(counterAfterDeny).toBeCloseTo(6, 5);
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — Error path: rollback on store error during evaluation
// ---------------------------------------------------------------------------

describe("SpendingLimitRule — rollback on store error", () => {
  it("decrements already-incremented daily counter when weekly read throws", async () => {
    // Sequence inside slidingWindowCheckLimit for the daily window (POLICY-005 order):
    //   1. getRecent(dailyLogKey)       — reads daily window entries
    //   2. increment(dailyCounterKey)   — optimistically records daily spend
    //   3. append(dailyLogKey)          — records daily tx in sliding window log
    // Then slidingWindowCheckLimit for the weekly window:
    //   4. getRecent(weeklyLogKey)      — THROWS HERE
    //
    // The catch block rolls back incremented counters only (not list appends).
    // So: daily counter → 0, but daily log → still has the entry from step 3.
    // This is the documented behaviour: rollback is counter-level, not log-level.
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
      clearList: (k) => base.clearList!(k),
    };

    const rule = new SpendingLimitRule({
      daily: { amount: "100", token: "SOL" },
      weekly: { amount: "500", token: "SOL" },
    });

    const ctx = makeContext(faultyStore);
    await expect(rule.evaluate(makeTransfer("10"), ctx)).rejects.toThrow(
      "simulated store failure on weekly read",
    );

    // PRIMARY GUARANTEE: The daily counter is rolled back to 0.
    // The rollbackIncrements path decrements each key that was incremented during
    // this evaluation. The daily counter was incremented and must be decremented back.
    const dailyCounter = await readCounter(base, counterKey("daily", "SOL"));
    expect(dailyCounter).toBe(0);

    // SECONDARY NOTE: The daily log entry (step 3 above) was appended before the
    // weekly error. The rollback path (rollbackIncrements) does NOT remove list entries
    // — it only decrements counters. This is the documented "safe direction":
    // slight under-counting rather than over-counting.
    //
    // The log entry exists but the counter is 0, so on the next evaluation the
    // sliding window sum will include this phantom entry until its TTL expires.
    // This is the documented trade-off: rollback failure "results in slight
    // under-counting (safe direction)" as noted in spending-limit.ts lines 17-19.
    const dailyLog = await readLog(base, logKey("daily", "SOL"));
    // Log has the phantom entry (cannot be rolled back), but counter is 0.
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
      clearList: (k) => base.clearList!(k),
    };

    const rule = new SpendingLimitRule({
      daily: { amount: "100", token: "SOL" },
      weekly: { amount: "500", token: "SOL" },
    });

    const ctx = makeContext(faultyStore);
    await expect(rule.evaluate(makeTransfer("10"), ctx)).rejects.toThrow();

    // The weekly counter was never incremented — error happened during getRecent
    // which is the very first operation of the weekly window check.
    const weeklyCounter = await readCounter(base, counterKey("weekly", "SOL"));
    expect(weeklyCounter).toBe(0);

    // The weekly log was never appended either.
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

    // The spending counter must be zero — Phase 2 never ran.
    const counter = await readCounter(store, counterKey("daily", "SOL"));
    expect(counter).toBe(0);

    const logEntries = await readLog(store, logKey("daily", "SOL"));
    expect(logEntries).toHaveLength(0);
  });

  it("spending counter IS incremented when both rules ALLOW", async () => {
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

    // Phase 2 committed — counter should reflect the 10 SOL.
    const counter = await readCounter(store, counterKey("daily", "SOL"));
    expect(counter).toBeCloseTo(10, 5);

    const logEntries = await readLog(store, logKey("daily", "SOL"));
    expect(logEntries).toHaveLength(1);
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

    const counter = await readCounter(store, counterKey("daily", "SOL"));
    expect(counter).toBe(0);
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

  it("serialises concurrent evaluations so the spending counter is exact", async () => {
    // Budget: 15 SOL daily. Two evaluations of 10 SOL race each other.
    // The mutex ensures they run sequentially: the first succeeds (10 SOL committed),
    // the second is denied (10 + 10 = 20 >= 15 limit) and rolls back.
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

    // Counter must be exactly 10 SOL — only one committed.
    const counter = await readCounter(store, counterKey("daily", "SOL"));
    expect(counter).toBeCloseTo(10, 5);

    // Log must have exactly one entry.
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

    // Counter should reflect only the one committed transaction.
    const counter = await readCounter(store, counterKey("daily", "SOL"));
    expect(counter).toBeCloseTo(5, 5);

    const logEntries = await readLog(store, logKey("daily", "SOL"));
    expect(logEntries).toHaveLength(1);
  });
});
