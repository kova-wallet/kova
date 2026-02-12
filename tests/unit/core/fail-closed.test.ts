/**
 * Fail-Closed Behavior Verification Tests
 *
 * Verifies the failure mode table from the whitepaper:
 * Every component failure must result in DENY or a safe degradation,
 * never in an unauthorized transaction proceeding.
 *
 * Failure modes covered:
 * 1. Store unavailable
 * 2. Signer unavailable
 * 3. RPC node (chain adapter) unavailable
 * 4. Approval channel unavailable
 * 5. Policy evaluation errors
 * 6. Audit logger failures & circuit breaker
 * 7. Unknown intent types / invalid chain
 * 8. Combined / cascading failures
 */

import { describe, it, expect, vi } from "vitest";
import { AgentWallet } from "../../../src/core/wallet.js";
import { PolicyEngine } from "../../../src/policy/engine.js";
import { MemoryStore } from "../../../src/stores/memory.js";
import { AuditLogger } from "../../../src/logging/audit.js";
import { ApprovalGateRule } from "../../../src/policy/rules/approval-gate.js";
import type { AgentWalletConfig } from "../../../src/core/wallet.js";
import type { PolicyRule, PolicyDecision, PolicyContext } from "../../../src/policy/types.js";
import type { Signer, UnsignedTransaction, SignedTransaction } from "../../../src/signers/interface.js";
import type { ChainAdapter } from "../../../src/chains/interface.js";
import type { TransactionIntent } from "../../../src/core/intent.js";
import type { TokenBalance } from "../../../src/core/result.js";
import type { ApprovalChannel, ApprovalResult } from "../../../src/approval/interface.js";

// ── Mock helpers (mirroring wallet.test.ts patterns) ──────────────

const allowAllRule: PolicyRule = {
  name: "allow-all",
  evaluate: async () => ({ decision: "ALLOW" }),
};

function createMockSigner(address = "MockAddress1234567890abcdef12345678"): Signer {
  return {
    getAddress: async () => address,
    sign: async (tx: UnsignedTransaction): Promise<SignedTransaction> => ({
      chain: tx.chain,
      data: tx.data,
      signature: new Uint8Array(64).fill(1),
    }),
    healthCheck: async () => true,
  };
}

function createMockChain(): ChainAdapter {
  return {
    chain: "solana",
    getBalance: async (_addr: string, token: string): Promise<TokenBalance> => ({
      token,
      amount: "10.0",
      decimals: 9,
      usdValue: 1500,
    }),
    getValueInUSD: async (_token: string, amount: string) => parseFloat(amount) * 150,
    buildTransaction: async (intent: TransactionIntent, _signerAddress: string) => ({
      chain: "solana",
      data: new TextEncoder().encode(JSON.stringify({ type: intent.type, mock: true })),
      description: `Mock ${intent.type}`,
    }),
    broadcast: async () => "mock_tx_abc123",
    getTransactionStatus: async (txId: string) => ({
      status: "confirmed" as const,
      txId,
    }),
    isValidAddress: (addr: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr),
  };
}

function createTransferIntent(overrides?: Partial<TransactionIntent>): TransactionIntent {
  return {
    type: "transfer",
    chain: "solana",
    params: { to: "RecipientAddr1234567890abcdef1234", amount: "1.0", token: "SOL" },
    ...overrides,
  };
}

function createWallet(overrides?: Partial<AgentWalletConfig>) {
  const store = overrides?.store ?? new MemoryStore();
  const defaults: AgentWalletConfig = {
    signer: createMockSigner(),
    chain: createMockChain(),
    policy: new PolicyEngine([allowAllRule], store),
    store,
    circuitBreaker: false, // disable circuit breaker by default so it does not interfere with fail-closed tests
  };
  return new AgentWallet({ ...defaults, ...overrides });
}

// ── Tests ─────────────────────────────────────────────────────────

describe("Fail-Closed Behavior Verification", () => {
  // ================================================================
  // 1. Store unavailable
  // ================================================================
  describe("Store unavailable", () => {
    it("store.get throws during spending limit check -> DENY (rule throws, engine catches, produces DENY via fail-closed)", async () => {
      const store = new MemoryStore();
      // The spending-limit rule calls store.get to read the daily counter.
      // We create a rule that calls store.get and let it throw.
      const ruleUsingStore: PolicyRule = {
        name: "spending-check",
        evaluate: async (_intent: TransactionIntent, context: PolicyContext) => {
          // This simulates what a spending limit rule does internally
          await context.store.get("spending:daily:SOL");
          return { decision: "ALLOW" as const };
        },
      };

      // Make store.get throw only for non-idempotency keys (the idempotency check
      // happens before policy evaluation and is NOT in a try/catch).
      const originalGet = store.get.bind(store);
      vi.spyOn(store, "get").mockImplementation(async (key: string) => {
        if (!key.startsWith("idempotency:")) {
          throw new Error("Redis connection refused");
        }
        return originalGet(key);
      });

      const policy = new PolicyEngine([ruleUsingStore], store);
      const wallet = createWallet({ policy, store });

      const result = await wallet.execute(createTransferIntent());

      expect(result.status).toBe("denied");
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe("POLICY_DENIED");
      expect(result.error!.message).toContain("Rule evaluation error");
      expect(result.error!.message).toContain("Redis connection refused");
    });

    it("store.increment throws during rate limit -> DENY", async () => {
      const store = new MemoryStore();
      const rateRule: PolicyRule = {
        name: "rate-limit",
        evaluate: async (_intent: TransactionIntent, context: PolicyContext) => {
          await context.store.increment("ratelimit:minute", 1);
          return { decision: "ALLOW" as const };
        },
      };

      vi.spyOn(store, "increment").mockRejectedValue(new Error("Store increment failed"));

      const policy = new PolicyEngine([rateRule], store);
      const wallet = createWallet({ policy, store });

      const result = await wallet.execute(createTransferIntent());

      expect(result.status).toBe("denied");
      expect(result.error!.code).toBe("POLICY_DENIED");
      expect(result.error!.message).toContain("Rule evaluation error");
      expect(result.error!.message).toContain("Store increment failed");
    });

    it("store.get throws during idempotency check -> error propagates to caller (not silently swallowed)", async () => {
      const store = new MemoryStore();
      // store.get is called for the idempotency check at the top of executeInternal().
      // That call is NOT wrapped in try/catch, so the error propagates out of execute().
      const originalGet = store.get.bind(store);
      vi.spyOn(store, "get").mockImplementation(async (key: string) => {
        if (key.startsWith("idempotency:")) {
          throw new Error("Store read failed");
        }
        return originalGet(key);
      });

      const policy = new PolicyEngine([allowAllRule], store);
      const wallet = createWallet({ policy, store });

      // The idempotency store.get is NOT in a try/catch, so it propagates.
      // execute() only has a finally (for lock release), no catch.
      // This means the caller sees a rejected promise -- the wallet does NOT
      // silently proceed with an unauthorized transaction. This is fail-safe behavior.
      await expect(
        wallet.execute(createTransferIntent({ id: "idem-store-fail" })),
      ).rejects.toThrow("Store read failed");
    });

    it("store.set throws during cache write -> transaction still succeeds (cache failure non-fatal)", async () => {
      const store = new MemoryStore();
      // store.set is called in cacheResult() which IS wrapped in try/catch
      vi.spyOn(store, "set").mockRejectedValue(new Error("Store write failed"));

      const policy = new PolicyEngine([allowAllRule], store);
      const wallet = createWallet({ policy, store });

      const result = await wallet.execute(createTransferIntent());

      // cacheResult swallows errors: `catch { // Cache failure must not break the transaction flow }`
      expect(result.status).toBe("confirmed");
      expect(result.txId).toBe("mock_tx_abc123");
    });

    it("store.append throws during audit -> audit failure detected (returns false)", async () => {
      const store = new MemoryStore();
      vi.spyOn(store, "append").mockRejectedValue(new Error("Audit write failed"));

      const logger = new AuditLogger(store);
      const success = await logger.log({
        timestamp: Date.now(),
        intentId: "test-intent",
        intent: createTransferIntent(),
        policyDecisions: [],
        finalDecision: { decision: "ALLOW" },
      });

      // AuditLogger.log() catches errors and returns false
      expect(success).toBe(false);
    });
  });

  // ================================================================
  // 2. Signer unavailable
  // ================================================================
  describe("Signer unavailable", () => {
    it("signer.getAddress throws -> status 'failed', TRANSACTION_FAILED", async () => {
      const signer: Signer = {
        ...createMockSigner(),
        getAddress: async () => { throw new Error("HSM connection lost"); },
      };
      const wallet = createWallet({ signer });

      const result = await wallet.execute(createTransferIntent());

      expect(result.status).toBe("failed");
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe("TRANSACTION_FAILED");
      expect(result.error!.message).toBe("HSM connection lost");
    });

    it("signer.sign throws -> status 'failed', TRANSACTION_FAILED", async () => {
      const signer: Signer = {
        ...createMockSigner(),
        sign: async () => { throw new Error("Signing key corrupted"); },
      };
      const wallet = createWallet({ signer });

      const result = await wallet.execute(createTransferIntent());

      expect(result.status).toBe("failed");
      expect(result.error!.code).toBe("TRANSACTION_FAILED");
      expect(result.error!.message).toBe("Signing key corrupted");
    });

    it("signer.healthCheck throws -> no impact on execute (healthCheck not called during execute)", async () => {
      const signer: Signer = {
        ...createMockSigner(),
        healthCheck: async () => { throw new Error("Health check infrastructure down"); },
      };
      const wallet = createWallet({ signer });

      // healthCheck is NOT called during execute() -- it is a standalone diagnostic method
      const result = await wallet.execute(createTransferIntent());

      expect(result.status).toBe("confirmed");
      expect(result.txId).toBe("mock_tx_abc123");
    });
  });

  // ================================================================
  // 3. RPC node (chain adapter) unavailable
  // ================================================================
  describe("RPC node unavailable", () => {
    it("chain.buildTransaction throws -> status 'failed', TRANSACTION_FAILED", async () => {
      const chain: ChainAdapter = {
        ...createMockChain(),
        buildTransaction: async () => { throw new Error("RPC node unreachable"); },
      };
      const wallet = createWallet({ chain });

      const result = await wallet.execute(createTransferIntent());

      expect(result.status).toBe("failed");
      expect(result.error!.code).toBe("TRANSACTION_FAILED");
      expect(result.error!.message).toBe("RPC node unreachable");
    });

    it("chain.broadcast throws -> status 'failed', TRANSACTION_FAILED", async () => {
      const chain: ChainAdapter = {
        ...createMockChain(),
        broadcast: async () => { throw new Error("Network congestion: broadcast timeout"); },
      };
      const wallet = createWallet({ chain });

      const result = await wallet.execute(createTransferIntent());

      expect(result.status).toBe("failed");
      expect(result.error!.code).toBe("TRANSACTION_FAILED");
      expect(result.error!.message).toBe("Network congestion: broadcast timeout");
    });

    it("chain.getBalance throws -> propagates to caller (not wrapped in execute)", async () => {
      const chain: ChainAdapter = {
        ...createMockChain(),
        getBalance: async () => { throw new Error("RPC getBalance failed"); },
      };
      const wallet = createWallet({ chain });

      // getBalance() is a standalone method, not part of execute() pipeline
      // The error propagates directly to the caller
      await expect(wallet.getBalance("SOL")).rejects.toThrow("RPC getBalance failed");
    });
  });

  // ================================================================
  // 4. Approval channel unavailable
  // ================================================================
  describe("Approval channel unavailable", () => {
    it("approval.requestApproval throws -> DENY (fail-closed)", async () => {
      const approval: ApprovalChannel = {
        name: "broken-channel",
        requestApproval: async () => { throw new Error("Telegram API unreachable"); },
      };
      const store = new MemoryStore();
      const approvalRule = new ApprovalGateRule({ above: { amount: "0.5", token: "SOL" } });
      const policy = new PolicyEngine([approvalRule], store, approval);
      const wallet = createWallet({ policy, store, approval });

      const result = await wallet.execute(createTransferIntent());

      expect(result.status).toBe("denied");
      expect(result.error!.code).toBe("POLICY_DENIED");
      expect(result.error!.message).toContain("Approval channel error");
    });

    it("approval with no channel configured -> DENY", async () => {
      const store = new MemoryStore();
      const approvalRule = new ApprovalGateRule({ above: { amount: "0.5", token: "SOL" } });
      // No approval channel passed to PolicyEngine
      const policy = new PolicyEngine([approvalRule], store);
      const wallet = createWallet({ policy, store });

      const result = await wallet.execute(createTransferIntent());

      expect(result.status).toBe("denied");
      expect(result.error!.code).toBe("POLICY_DENIED");
      expect(result.error!.message).toContain("no approval channel is configured");
    });

    it("approval timeout -> DENY", async () => {
      const approval: ApprovalChannel = {
        name: "timeout-channel",
        requestApproval: async (): Promise<ApprovalResult> => ({
          requestId: "req-timeout",
          decision: "timeout",
          decidedBy: "system",
          decidedAt: Date.now(),
        }),
      };
      const store = new MemoryStore();
      const approvalRule = new ApprovalGateRule({ above: { amount: "0.5", token: "SOL" } });
      const policy = new PolicyEngine([approvalRule], store, approval);
      const wallet = createWallet({ policy, store, approval });

      const result = await wallet.execute(createTransferIntent());

      expect(result.status).toBe("denied");
      expect(result.error!.code).toBe("POLICY_DENIED");
      expect(result.error!.message).toContain("timed out");
    });
  });

  // ================================================================
  // 5. Policy evaluation errors
  // ================================================================
  describe("Policy evaluation error", () => {
    it("single rule throws -> DENY with 'Rule evaluation error' message", async () => {
      const throwingRule: PolicyRule = {
        name: "crashy-rule",
        evaluate: async () => { throw new Error("Unexpected NPE in rule"); },
      };
      const store = new MemoryStore();
      const policy = new PolicyEngine([throwingRule], store);
      const wallet = createWallet({ policy, store });

      const result = await wallet.execute(createTransferIntent());

      expect(result.status).toBe("denied");
      expect(result.error!.code).toBe("POLICY_DENIED");
      expect(result.error!.message).toContain("Rule evaluation error");
      expect(result.error!.message).toContain("Unexpected NPE in rule");
      expect(result.error!.policyRule).toBe("crashy-rule");
    });

    it("first of two rules throws -> DENY, second rule not evaluated", async () => {
      const secondRuleSpy = vi.fn(async (): Promise<PolicyDecision> => ({ decision: "ALLOW" }));

      const throwingFirst: PolicyRule = {
        name: "first-rule",
        evaluate: async () => { throw new Error("First rule exploded"); },
      };
      const secondRule: PolicyRule = {
        name: "second-rule",
        evaluate: secondRuleSpy,
      };

      const store = new MemoryStore();
      const policy = new PolicyEngine([throwingFirst, secondRule], store);
      const wallet = createWallet({ policy, store });

      const result = await wallet.execute(createTransferIntent());

      expect(result.status).toBe("denied");
      expect(result.error!.message).toContain("Rule evaluation error");
      expect(result.error!.policyRule).toBe("first-rule");
      // Second rule should NOT have been called
      expect(secondRuleSpy).not.toHaveBeenCalled();
    });

    it("rule throws non-Error (string) -> DENY with string message", async () => {
      const stringThrowRule: PolicyRule = {
        name: "string-throw-rule",
        evaluate: async () => { throw "plain string error"; },
      };
      const store = new MemoryStore();
      const policy = new PolicyEngine([stringThrowRule], store);
      const wallet = createWallet({ policy, store });

      const result = await wallet.execute(createTransferIntent());

      expect(result.status).toBe("denied");
      expect(result.error!.code).toBe("POLICY_DENIED");
      expect(result.error!.message).toContain("plain string error");
    });

    it("rule throws null -> DENY with 'null' message", async () => {
      const nullThrowRule: PolicyRule = {
        name: "null-throw-rule",
        evaluate: async () => { throw null; },
      };
      const store = new MemoryStore();
      const policy = new PolicyEngine([nullThrowRule], store);
      const wallet = createWallet({ policy, store });

      const result = await wallet.execute(createTransferIntent());

      expect(result.status).toBe("denied");
      expect(result.error!.code).toBe("POLICY_DENIED");
      expect(result.error!.message).toContain("null");
    });

    it("rule throws after another rule allows -> DENY (fail-closed)", async () => {
      const allowFirst: PolicyRule = {
        name: "allows-first",
        evaluate: async () => ({ decision: "ALLOW" as const }),
      };
      const throwsSecond: PolicyRule = {
        name: "throws-second",
        evaluate: async () => { throw new Error("Second rule crashed after first allowed"); },
      };

      const store = new MemoryStore();
      const policy = new PolicyEngine([allowFirst, throwsSecond], store);
      const wallet = createWallet({ policy, store });

      const result = await wallet.execute(createTransferIntent());

      // Even though the first rule ALLOWed, the second rule's error -> DENY
      expect(result.status).toBe("denied");
      expect(result.error!.code).toBe("POLICY_DENIED");
      expect(result.error!.policyRule).toBe("throws-second");
      expect(result.error!.message).toContain("Rule evaluation error");
    });
  });

  // ================================================================
  // 6. Audit logger failures
  // ================================================================
  describe("Audit logger failures", () => {
    it("AuditLogger.log() returns false on store failure (not throws)", async () => {
      const store = new MemoryStore();
      vi.spyOn(store, "append").mockRejectedValue(new Error("Disk full"));

      const logger = new AuditLogger(store);
      const success = await logger.log({
        timestamp: Date.now(),
        intentId: "test-1",
        intent: createTransferIntent(),
        policyDecisions: [],
        finalDecision: { decision: "ALLOW" },
      });

      // log() catches store errors and returns false (does not throw)
      expect(success).toBe(false);
    });

    it("after 3 consecutive audit failures, isCircuitOpen() returns true", async () => {
      const store = new MemoryStore();
      vi.spyOn(store, "append").mockRejectedValue(new Error("Store broken"));
      // store.get also needs to work for the hash chain read -- but append is what triggers the error path
      // Actually, store.get for "audit:last_hash" may also need to work. Let's mock append only.

      const logger = new AuditLogger(store);

      const entry = {
        timestamp: Date.now(),
        intentId: "test",
        intent: createTransferIntent(),
        policyDecisions: [],
        finalDecision: { decision: "ALLOW" as const },
      };

      expect(logger.isCircuitOpen()).toBe(false);

      // Fail 3 times (default maxConsecutiveFailures = 3)
      await logger.log(entry);
      expect(logger.getFailureCount()).toBe(1);
      expect(logger.isCircuitOpen()).toBe(false);

      await logger.log(entry);
      expect(logger.getFailureCount()).toBe(2);
      expect(logger.isCircuitOpen()).toBe(false);

      await logger.log(entry);
      expect(logger.getFailureCount()).toBe(3);
      expect(logger.isCircuitOpen()).toBe(true);
    });

    it("wallet blocks transactions when audit circuit is open (STORE_ERROR)", async () => {
      const store = new MemoryStore();

      // Create a logger with circuit already tripped
      const logger = new AuditLogger({ store, maxConsecutiveFailures: 1 });
      // Trigger one failure to trip the circuit
      vi.spyOn(store, "append").mockRejectedValueOnce(new Error("Store broken"));
      await logger.log({
        timestamp: Date.now(),
        intentId: "trip-it",
        intent: createTransferIntent(),
        policyDecisions: [],
        finalDecision: { decision: "ALLOW" },
      });
      expect(logger.isCircuitOpen()).toBe(true);

      // Restore append so the store works for everything else
      vi.restoreAllMocks();

      // Now create a wallet with this tripped logger
      const policy = new PolicyEngine([allowAllRule], store);
      const wallet = createWallet({ policy, store, logger });

      const result = await wallet.execute(createTransferIntent());

      expect(result.status).toBe("failed");
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe("STORE_ERROR");
      expect(result.error!.message).toContain("Audit logging circuit breaker is open");
    });

    it("audit circuit does not block when below failure threshold", async () => {
      const store = new MemoryStore();

      // Create a logger with threshold of 3 and only 2 failures
      const logger = new AuditLogger({ store, maxConsecutiveFailures: 3 });

      // Cause 2 failures (below threshold of 3)
      const origAppend = store.append.bind(store);
      let appendCallCount = 0;
      vi.spyOn(store, "append").mockImplementation(async (key: string, value: string) => {
        appendCallCount++;
        if (appendCallCount <= 2) {
          throw new Error("Temporary store issue");
        }
        return origAppend(key, value);
      });

      const entry = {
        timestamp: Date.now(),
        intentId: "partial-fail",
        intent: createTransferIntent(),
        policyDecisions: [],
        finalDecision: { decision: "ALLOW" as const },
      };

      await logger.log(entry); // fail 1
      await logger.log(entry); // fail 2
      expect(logger.getFailureCount()).toBe(2);
      expect(logger.isCircuitOpen()).toBe(false);

      // Wallet should still process transactions
      vi.restoreAllMocks();
      const policy = new PolicyEngine([allowAllRule], store);
      const wallet = createWallet({ policy, store, logger });

      const result = await wallet.execute(createTransferIntent());
      expect(result.status).toBe("confirmed");
    });

    it("resetFailureCount() re-enables audit logging", async () => {
      const store = new MemoryStore();
      const logger = new AuditLogger({ store, maxConsecutiveFailures: 1 });

      // Trip the circuit
      vi.spyOn(store, "append").mockRejectedValueOnce(new Error("Store broken"));
      await logger.log({
        timestamp: Date.now(),
        intentId: "trip",
        intent: createTransferIntent(),
        policyDecisions: [],
        finalDecision: { decision: "ALLOW" },
      });
      expect(logger.isCircuitOpen()).toBe(true);

      // Reset the failure count
      logger.resetFailureCount();
      expect(logger.isCircuitOpen()).toBe(false);
      expect(logger.getFailureCount()).toBe(0);

      // Now wallet should allow transactions again
      vi.restoreAllMocks();
      const policy = new PolicyEngine([allowAllRule], store);
      const wallet = createWallet({ policy, store, logger });

      const result = await wallet.execute(createTransferIntent());
      expect(result.status).toBe("confirmed");
    });

    it("onAuditFailure callback is invoked with error and count", async () => {
      const store = new MemoryStore();
      const callbackSpy = vi.fn();

      vi.spyOn(store, "append").mockRejectedValue(new Error("Disk full"));

      const logger = new AuditLogger({
        store,
        onAuditFailure: callbackSpy,
        maxConsecutiveFailures: 5,
      });

      await logger.log({
        timestamp: Date.now(),
        intentId: "callback-test-1",
        intent: createTransferIntent(),
        policyDecisions: [],
        finalDecision: { decision: "ALLOW" },
      });

      expect(callbackSpy).toHaveBeenCalledOnce();
      const [error, count] = callbackSpy.mock.calls[0]!;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Disk full");
      expect(count).toBe(1);

      // Second failure
      await logger.log({
        timestamp: Date.now(),
        intentId: "callback-test-2",
        intent: createTransferIntent(),
        policyDecisions: [],
        finalDecision: { decision: "ALLOW" },
      });

      expect(callbackSpy).toHaveBeenCalledTimes(2);
      const [error2, count2] = callbackSpy.mock.calls[1]!;
      expect((error2 as Error).message).toBe("Disk full");
      expect(count2).toBe(2);
    });
  });

  // ================================================================
  // 7. Unknown intent type / invalid chain
  // ================================================================
  describe("Unknown intent type", () => {
    it("invalid intent type -> VALIDATION_FAILED (before policy evaluation)", async () => {
      const evaluateSpy = vi.fn(async (): Promise<PolicyDecision> => ({ decision: "ALLOW" }));
      const spyRule: PolicyRule = { name: "spy-rule", evaluate: evaluateSpy };
      const store = new MemoryStore();
      const policy = new PolicyEngine([spyRule], store);
      const wallet = createWallet({ policy, store });

      const result = await wallet.execute({
        type: "delete_everything" as any,
        chain: "solana",
        params: { to: "addr", amount: "1", token: "SOL" },
      });

      expect(result.status).toBe("failed");
      expect(result.error!.code).toBe("VALIDATION_FAILED");
      expect(result.error!.message).toContain("Invalid intent type");
      expect(result.error!.message).toContain("delete_everything");
      // Policy engine should NOT have been called
      expect(evaluateSpy).not.toHaveBeenCalled();
    });

    it("invalid chain -> VALIDATION_FAILED", async () => {
      const evaluateSpy = vi.fn(async (): Promise<PolicyDecision> => ({ decision: "ALLOW" }));
      const spyRule: PolicyRule = { name: "spy-rule", evaluate: evaluateSpy };
      const store = new MemoryStore();
      const policy = new PolicyEngine([spyRule], store);
      const wallet = createWallet({ policy, store });

      const result = await wallet.execute({
        type: "transfer",
        chain: "dogecoin" as any,
        params: { to: "DAddr123", amount: "1000", token: "DOGE" },
      });

      expect(result.status).toBe("failed");
      expect(result.error!.code).toBe("VALIDATION_FAILED");
      expect(result.error!.message).toContain("Invalid chain");
      expect(result.error!.message).toContain("dogecoin");
      // Policy engine should NOT have been called
      expect(evaluateSpy).not.toHaveBeenCalled();
    });
  });

  // ================================================================
  // 8. Combined / cascading failures
  // ================================================================
  describe("Combined failures", () => {
    it("store failure during policy + audit failure -> DENY (not crash)", async () => {
      const store = new MemoryStore();

      // Make the store broken for everything except the idempotency check
      // (which is not in a try/catch and would propagate to the caller).
      const originalGet = store.get.bind(store);
      vi.spyOn(store, "get").mockImplementation(async (key: string) => {
        if (key.startsWith("idempotency:")) {
          return originalGet(key);
        }
        throw new Error("Store totally down");
      });
      vi.spyOn(store, "append").mockRejectedValue(new Error("Store totally down"));
      vi.spyOn(store, "increment").mockRejectedValue(new Error("Store totally down"));

      const storeRule: PolicyRule = {
        name: "needs-store",
        evaluate: async (_intent: TransactionIntent, context: PolicyContext) => {
          await context.store.get("some-key");
          return { decision: "ALLOW" as const };
        },
      };

      const policy = new PolicyEngine([storeRule], store);
      const wallet = createWallet({ policy, store });

      // Even though both policy evaluation and audit logging fail,
      // the wallet should return a DENY result, not crash
      const result = await wallet.execute(createTransferIntent());

      expect(result.status).toBe("denied");
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe("POLICY_DENIED");
      expect(result.error!.message).toContain("Rule evaluation error");
    });

    it("chain failure after policy ALLOW -> 'failed' (not 'denied')", async () => {
      const chain: ChainAdapter = {
        ...createMockChain(),
        buildTransaction: async () => { throw new Error("Chain node crashed mid-build"); },
      };
      const store = new MemoryStore();
      const policy = new PolicyEngine([allowAllRule], store);
      const wallet = createWallet({ policy, store, chain });

      const result = await wallet.execute(createTransferIntent());

      // Policy allowed it, so it's not "denied" -- it's "failed" because the chain broke
      expect(result.status).toBe("failed");
      expect(result.error!.code).toBe("TRANSACTION_FAILED");
      expect(result.error!.message).toBe("Chain node crashed mid-build");
      // Critically: NOT "denied" -- the policy decision was ALLOW
    });

    it("multiple failures in sequence don't leave wallet in broken state", async () => {
      const store = new MemoryStore();
      const policy = new PolicyEngine([allowAllRule], store);

      // First: chain failure
      const brokenChain: ChainAdapter = {
        ...createMockChain(),
        broadcast: async () => { throw new Error("Temporary network outage"); },
      };
      const wallet = createWallet({ policy, store, chain: brokenChain });

      const r1 = await wallet.execute(createTransferIntent({ id: "seq-fail-1" }));
      expect(r1.status).toBe("failed");

      // Second: signer failure (create a new wallet with same store but broken signer)
      const brokenSigner: Signer = {
        ...createMockSigner(),
        sign: async () => { throw new Error("Key rotation in progress"); },
      };
      const wallet2 = createWallet({ policy, store, signer: brokenSigner });

      const r2 = await wallet2.execute(createTransferIntent({ id: "seq-fail-2" }));
      expect(r2.status).toBe("failed");

      // Third: everything works again -- wallet should recover
      const healthyWallet = createWallet({ policy, store });
      const r3 = await healthyWallet.execute(createTransferIntent({ id: "seq-recover-3" }));

      expect(r3.status).toBe("confirmed");
      expect(r3.txId).toBe("mock_tx_abc123");

      // Verify audit logs accumulated across all attempts (for non-broken store scenarios)
      const logs = await store.getRecent("audit:log", 100);
      // All three transactions should have audit entries
      expect(logs.length).toBeGreaterThanOrEqual(3);
    });
  });
});
