import { describe, it, expect, beforeEach, vi } from "vitest";
import { AuditLogger } from "../../../src/logging/audit.js";
import { MemoryStore } from "../../../src/stores/memory.js";
import type { AuditEntry } from "../../../src/logging/types.js";

describe("AuditLogger", () => {
  let store: MemoryStore;
  let logger: AuditLogger;

  beforeEach(() => {
    store = new MemoryStore();
    logger = new AuditLogger(store);
  });

  function makeAuditEntry(overrides?: Partial<AuditEntry>): AuditEntry {
    return {
      timestamp: Date.now(),
      intentId: "intent-123",
      intent: {
        type: "transfer",
        chain: "solana",
        params: { to: "recipient", amount: "1.0", token: "SOL" },
      },
      policyDecisions: [
        {
          rule: "spending-limit",
          result: "ALLOW",
          evaluationTimeMs: 2,
        },
      ],
      finalDecision: { decision: "ALLOW" },
      ...overrides,
    };
  }

  it("should log an audit entry", async () => {
    const entry = makeAuditEntry();
    await logger.log(entry);

    const recent = await logger.getRecent(10);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.intentId).toBe("intent-123");
  });

  it("should log multiple entries and retrieve them in reverse order", async () => {
    await logger.log(makeAuditEntry({ intentId: "intent-1" }));
    await logger.log(makeAuditEntry({ intentId: "intent-2" }));
    await logger.log(makeAuditEntry({ intentId: "intent-3" }));

    const recent = await logger.getRecent(10);
    expect(recent).toHaveLength(3);
    expect(recent[0]?.intentId).toBe("intent-3");
    expect(recent[2]?.intentId).toBe("intent-1");
  });

  it("should respect the count parameter in getRecent", async () => {
    await logger.log(makeAuditEntry({ intentId: "intent-1" }));
    await logger.log(makeAuditEntry({ intentId: "intent-2" }));
    await logger.log(makeAuditEntry({ intentId: "intent-3" }));

    const recent = await logger.getRecent(2);
    expect(recent).toHaveLength(2);
    expect(recent[0]?.intentId).toBe("intent-3");
    expect(recent[1]?.intentId).toBe("intent-2");
  });

  it("should use default count of 10 when not specified", async () => {
    for (let i = 0; i < 15; i++) {
      await logger.log(makeAuditEntry({ intentId: `intent-${i}` }));
    }

    const recent = await logger.getRecent();
    expect(recent).toHaveLength(10);
  });

  it("should return empty array when no entries exist", async () => {
    const recent = await logger.getRecent();
    expect(recent).toEqual([]);
  });

  it("should preserve full audit entry structure through serialization", async () => {
    const entry = makeAuditEntry({
      agentId: "agent-42",
      transactionResult: {
        txId: "tx-abc123",
        status: "confirmed",
        blockTime: 1700000000,
      },
    });

    await logger.log(entry);
    const recent = await logger.getRecent(1);

    expect(recent[0]?.agentId).toBe("agent-42");
    expect(recent[0]?.transactionResult?.txId).toBe("tx-abc123");
    expect(recent[0]?.transactionResult?.status).toBe("confirmed");
    expect(recent[0]?.transactionResult?.blockTime).toBe(1700000000);
  });

  it("should preserve policy decision details", async () => {
    const entry = makeAuditEntry({
      policyDecisions: [
        { rule: "rate-limit", result: "ALLOW", evaluationTimeMs: 1 },
        { rule: "spending-limit", result: "DENY", reason: "Exceeded daily limit", evaluationTimeMs: 3 },
      ],
      finalDecision: { decision: "DENY", rule: "spending-limit", reason: "Exceeded daily limit" },
    });

    await logger.log(entry);
    const recent = await logger.getRecent(1);

    expect(recent[0]?.policyDecisions).toHaveLength(2);
    expect(recent[0]?.policyDecisions[1]?.result).toBe("DENY");
    expect(recent[0]?.policyDecisions[1]?.reason).toBe("Exceeded daily limit");
    expect(recent[0]?.finalDecision.decision).toBe("DENY");
  });

  it("should handle entries with PENDING decision", async () => {
    const entry = makeAuditEntry({
      finalDecision: {
        decision: "PENDING",
        rule: "approval-gate",
        approvalRequestId: "approval-req-1",
      },
    });

    await logger.log(entry);
    const recent = await logger.getRecent(1);

    expect(recent[0]?.finalDecision.decision).toBe("PENDING");
  });

  describe("corrupted entry handling", () => {
    it("should skip corrupted JSON entries gracefully", async () => {
      // Directly inject a corrupted entry into the store
      await store.append("audit:log", "this is not valid JSON{{{");
      await store.append("audit:log", JSON.stringify(makeAuditEntry({ intentId: "valid-1" })));
      await store.append("audit:log", "another corrupted entry");
      await store.append("audit:log", JSON.stringify(makeAuditEntry({ intentId: "valid-2" })));

      const recent = await logger.getRecent(10);

      // Should only return the 2 valid entries, skipping corrupted ones
      expect(recent).toHaveLength(2);
      expect(recent[0]?.intentId).toBe("valid-2");
      expect(recent[1]?.intentId).toBe("valid-1");
    });

    it("should return empty array when all entries are corrupted", async () => {
      await store.append("audit:log", "corrupted-1");
      await store.append("audit:log", "corrupted-2");
      await store.append("audit:log", "{not json}");

      const recent = await logger.getRecent(10);
      expect(recent).toEqual([]);
    });

    it("should handle empty string as corrupted entry", async () => {
      await store.append("audit:log", "");
      await store.append("audit:log", JSON.stringify(makeAuditEntry({ intentId: "after-empty" })));

      const recent = await logger.getRecent(10);
      expect(recent).toHaveLength(1);
      expect(recent[0]?.intentId).toBe("after-empty");
    });
  });

  describe("store key isolation", () => {
    it("should use the audit:log key consistently", async () => {
      await logger.log(makeAuditEntry({ intentId: "key-test" }));

      // Verify it went to the correct store key
      const raw = await store.getRecent("audit:log", 10);
      expect(raw).toHaveLength(1);

      const parsed = JSON.parse(raw[0]!);
      expect(parsed.intentId).toBe("key-test");
    });

    it("should not interfere with other store keys", async () => {
      await logger.log(makeAuditEntry({ intentId: "isolated" }));
      await store.append("other:key", "other-data");

      const auditLogs = await store.getRecent("audit:log", 10);
      const otherLogs = await store.getRecent("other:key", 10);

      expect(auditLogs).toHaveLength(1);
      expect(otherLogs).toHaveLength(1);
    });
  });

  describe("entry with various intent types", () => {
    it("should preserve swap intent through serialization", async () => {
      const entry = makeAuditEntry({
        intentId: "swap-test",
        intent: {
          type: "swap",
          chain: "solana",
          params: { fromToken: "SOL", toToken: "USDC", amount: "5.0", maxSlippage: 0.01 },
        },
      });

      await logger.log(entry);
      const recent = await logger.getRecent(1);

      expect(recent[0]?.intent.type).toBe("swap");
      const params = recent[0]?.intent.params as { fromToken: string; toToken: string; amount: string; maxSlippage: number };
      expect(params.fromToken).toBe("SOL");
      expect(params.maxSlippage).toBe(0.01);
    });

    it("should preserve mint intent through serialization", async () => {
      const entry = makeAuditEntry({
        intentId: "mint-test",
        intent: {
          type: "mint",
          chain: "solana",
          params: { collection: "DeGods123", metadataUri: "https://example.com/meta.json" },
        },
      });

      await logger.log(entry);
      const recent = await logger.getRecent(1);

      expect(recent[0]?.intent.type).toBe("mint");
    });

    it("should preserve intent metadata through serialization", async () => {
      const entry = makeAuditEntry({
        intentId: "meta-test",
        intent: {
          type: "transfer",
          chain: "solana",
          params: { to: "recipient", amount: "1.0", token: "SOL" },
          metadata: { agentId: "agent-1", taskId: "task-1", reason: "payment", urgency: "high" },
        },
      });

      await logger.log(entry);
      const recent = await logger.getRecent(1);

      expect(recent[0]?.intent.metadata?.agentId).toBe("agent-1");
      expect(recent[0]?.intent.metadata?.urgency).toBe("high");
    });
  });

  describe("entry with failed transaction result", () => {
    it("should preserve failed transaction result", async () => {
      const entry = makeAuditEntry({
        transactionResult: {
          txId: "failed-tx-123",
          status: "failed",
        },
      });

      await logger.log(entry);
      const recent = await logger.getRecent(1);

      expect(recent[0]?.transactionResult?.status).toBe("failed");
      expect(recent[0]?.transactionResult?.txId).toBe("failed-tx-123");
    });

    it("should handle entry without transactionResult", async () => {
      const entry = makeAuditEntry();
      // Default makeAuditEntry does not include transactionResult

      await logger.log(entry);
      const recent = await logger.getRecent(1);

      expect(recent[0]?.transactionResult).toBeUndefined();
    });
  });

  describe("concurrent logging", () => {
    it("should handle concurrent log calls", async () => {
      const entries = Array.from({ length: 10 }, (_, i) =>
        makeAuditEntry({ intentId: `concurrent-${i}` }),
      );

      await Promise.all(entries.map(e => logger.log(e)));

      const recent = await logger.getRecent(20);
      expect(recent).toHaveLength(10);
    });
  });
});
