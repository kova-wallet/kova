import { describe, it, expect, beforeEach, vi } from "vitest";
import { CircuitBreaker } from "../../../src/core/circuit-breaker.js";
import { AgentWallet } from "../../../src/core/wallet.js";
import { PolicyEngine } from "../../../src/policy/engine.js";
import { MemoryStore } from "../../../src/stores/memory.js";
import type { AgentWalletConfig } from "../../../src/core/wallet.js";
import type { PolicyRule } from "../../../src/policy/types.js";
import type { Signer, UnsignedTransaction, SignedTransaction } from "../../../src/signers/interface.js";
import type { ChainAdapter } from "../../../src/chains/interface.js";
import type { TransactionIntent } from "../../../src/core/intent.js";
import type { TokenBalance } from "../../../src/core/result.js";

// ── Mock helpers (mirroring wallet.test.ts patterns) ──────────────────

const allowAllRule: PolicyRule = {
  name: "allow-all",
  evaluate: async () => ({ decision: "ALLOW" }),
};

const denyRule: PolicyRule = {
  name: "deny-all",
  evaluate: async () => ({
    decision: "DENY" as const,
    rule: "deny-all",
    reason: "All transactions denied",
  }),
};

function createMockSigner(address = "7v91N7iZ9mNicL8WfG6cgSCKyRXydQjLh6UYBWwm6y1Q"): Signer {
  return {
    getAddress: async () => address,
    sign: async (tx: UnsignedTransaction): Promise<SignedTransaction> => ({
      chain: tx.chain,
      data: tx.data,
      signature: new Uint8Array(64).fill(1),
    }),
    healthCheck: async () => true,
    destroy: async () => {},
    toJSON: () => ({ address }),
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
    simulateTransaction: vi.fn().mockResolvedValue({ success: true }),
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
    params: { to: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre", amount: "1.0", token: "SOL" },
    ...overrides,
  };
}

function createWallet(overrides?: Partial<AgentWalletConfig>) {
  const store = overrides?.store ?? new MemoryStore();
  const defaults: AgentWalletConfig = {
    signer: createMockSigner(),
    chain: createMockChain(),
    policy: new PolicyEngine([allowAllRule], store as MemoryStore),
    store,
  };
  return new AgentWallet({ ...defaults, ...overrides });
}

// ── Unit tests for CircuitBreaker class ───────────────────────────────

describe("CircuitBreaker", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  // ── Construction ──────────────────────────────────────────────────

  describe("constructor", () => {
    it("should use default config (threshold=5, cooldownMs=300000) when no config provided", () => {
      const cb = new CircuitBreaker(store);
      const config = cb.getConfig();
      expect(config.threshold).toBe(5);
      expect(config.cooldownMs).toBe(300_000);
    });

    it("should accept custom config values", () => {
      const cb = new CircuitBreaker(store, { threshold: 3, cooldownMs: 60_000 });
      const config = cb.getConfig();
      expect(config.threshold).toBe(3);
      expect(config.cooldownMs).toBe(60_000);
    });

    it("should throw when threshold < 1", () => {
      expect(() => new CircuitBreaker(store, { threshold: 0 })).toThrow(
        "CircuitBreaker threshold must be at least 1",
      );
      expect(() => new CircuitBreaker(store, { threshold: -5 })).toThrow(
        "CircuitBreaker threshold must be at least 1",
      );
    });

    it("should throw when cooldownMs < 0", () => {
      expect(() => new CircuitBreaker(store, { cooldownMs: -1 })).toThrow(
        "CircuitBreaker cooldownMs must be >= 0",
      );
    });
  });

  // ── check() method ────────────────────────────────────────────────

  describe("check()", () => {
    it("should return null initially (no denials recorded)", async () => {
      const cb = new CircuitBreaker(store);
      const result = await cb.check();
      expect(result).toBeNull();
    });

    it("should return null when denial count is below threshold", async () => {
      const cb = new CircuitBreaker(store, { threshold: 5 });

      // Record 4 denials (below threshold of 5)
      await cb.recordOutcome("DENY");
      await cb.recordOutcome("DENY");
      await cb.recordOutcome("DENY");
      await cb.recordOutcome("DENY");

      const result = await cb.check();
      expect(result).toBeNull();
    });

    it("should return a reason string during cooldown period", async () => {
      const now = Date.now();
      const cb = new CircuitBreaker(store, { threshold: 2, cooldownMs: 60_000 });

      // Trigger cooldown by recording 2 consecutive denials
      await cb.recordOutcome("DENY", now);
      await cb.recordOutcome("DENY", now);

      // Check while still in cooldown
      const result = await cb.check(now + 10_000);
      expect(result).not.toBeNull();
      expect(result).toContain("Circuit breaker open");
      expect(result).toContain("cooldown remaining");
      expect(result).toContain("2 consecutive denials");
    });

    it("should return null after cooldown expires (using injectable now)", async () => {
      const now = Date.now();
      const cooldownMs = 60_000;
      const cb = new CircuitBreaker(store, { threshold: 2, cooldownMs });

      // Trigger cooldown
      await cb.recordOutcome("DENY", now);
      await cb.recordOutcome("DENY", now);

      // Check after cooldown has expired
      const result = await cb.check(now + cooldownMs + 1);
      expect(result).toBeNull();
    });

    it("should auto-reset counter and cooldown after cooldown expiry", async () => {
      const now = Date.now();
      const cooldownMs = 60_000;
      const cb = new CircuitBreaker(store, { threshold: 2, cooldownMs });

      // Trigger cooldown
      await cb.recordOutcome("DENY", now);
      await cb.recordOutcome("DENY", now);

      // Verify circuit is open
      expect(await cb.check(now + 1_000)).not.toBeNull();

      // Check after cooldown — should auto-reset
      const result = await cb.check(now + cooldownMs + 1);
      expect(result).toBeNull();

      // After auto-reset, a single deny should not re-open the circuit
      await cb.recordOutcome("DENY", now + cooldownMs + 2);
      expect(await cb.check(now + cooldownMs + 3)).toBeNull();
    });
  });

  // ── recordOutcome() method ────────────────────────────────────────

  describe("recordOutcome()", () => {
    it("should reset counter to 0 on ALLOW", async () => {
      const cb = new CircuitBreaker(store, { threshold: 5 });

      // Record 3 denials
      await cb.recordOutcome("DENY");
      await cb.recordOutcome("DENY");
      await cb.recordOutcome("DENY");

      // ALLOW resets the counter
      await cb.recordOutcome("ALLOW");

      // Now record 4 more denials — should still be below threshold of 5
      await cb.recordOutcome("DENY");
      await cb.recordOutcome("DENY");
      await cb.recordOutcome("DENY");
      await cb.recordOutcome("DENY");

      const result = await cb.check();
      expect(result).toBeNull();
    });

    it("should increment counter on DENY", async () => {
      const now = Date.now();
      const cb = new CircuitBreaker(store, { threshold: 3, cooldownMs: 60_000 });

      await cb.recordOutcome("DENY", now);
      expect(await cb.check(now)).toBeNull();

      await cb.recordOutcome("DENY", now);
      expect(await cb.check(now)).toBeNull();

      // Third denial triggers cooldown
      await cb.recordOutcome("DENY", now);
      expect(await cb.check(now + 1)).not.toBeNull();
    });

    it("should treat PENDING as a no-op (counter does not change)", async () => {
      const now = Date.now();
      const cb = new CircuitBreaker(store, { threshold: 3, cooldownMs: 60_000 });

      // Record 2 denials (one below threshold)
      await cb.recordOutcome("DENY", now);
      await cb.recordOutcome("DENY", now);

      // PENDING should not affect the counter
      await cb.recordOutcome("PENDING", now);
      await cb.recordOutcome("PENDING", now);
      await cb.recordOutcome("PENDING", now);

      // Still below threshold — circuit should be closed
      expect(await cb.check(now)).toBeNull();

      // One more DENY should trigger cooldown (count was 2, now becomes 3)
      await cb.recordOutcome("DENY", now);
      expect(await cb.check(now + 1)).not.toBeNull();
    });

    it("should trigger cooldown when N denials reach the threshold", async () => {
      const now = Date.now();
      const cb = new CircuitBreaker(store, { threshold: 3, cooldownMs: 120_000 });

      await cb.recordOutcome("DENY", now);
      await cb.recordOutcome("DENY", now);
      await cb.recordOutcome("DENY", now);

      // Circuit should now be open
      const reason = await cb.check(now + 100);
      expect(reason).not.toBeNull();
      expect(reason).toContain("Circuit breaker open");
      expect(reason).toContain("120"); // ~120s cooldown remaining
    });

    it("should reset counter when ALLOW comes after N-1 denials", async () => {
      const now = Date.now();
      const cb = new CircuitBreaker(store, { threshold: 5, cooldownMs: 60_000 });

      // 4 denials (one below threshold)
      await cb.recordOutcome("DENY", now);
      await cb.recordOutcome("DENY", now);
      await cb.recordOutcome("DENY", now);
      await cb.recordOutcome("DENY", now);

      // ALLOW resets
      await cb.recordOutcome("ALLOW", now);

      // Circuit should still be closed
      expect(await cb.check(now)).toBeNull();

      // Need 5 more denials to trigger, not 1
      await cb.recordOutcome("DENY", now);
      expect(await cb.check(now)).toBeNull();
    });

    it("should reset counter when ALLOW follows multiple consecutive DENYs", async () => {
      const now = Date.now();
      const cb = new CircuitBreaker(store, { threshold: 10, cooldownMs: 60_000 });

      // 8 consecutive denials
      for (let i = 0; i < 8; i++) {
        await cb.recordOutcome("DENY", now);
      }

      // ALLOW resets
      await cb.recordOutcome("ALLOW", now);

      // Verify counter is reset: 9 denials should not trigger (threshold=10)
      for (let i = 0; i < 9; i++) {
        await cb.recordOutcome("DENY", now);
      }

      expect(await cb.check(now)).toBeNull();

      // 10th denial triggers
      await cb.recordOutcome("DENY", now);
      expect(await cb.check(now + 1)).not.toBeNull();
    });
  });

  // ── reset via cooldown expiry (CRIT-04: reset() is now private) ──

  describe("auto-reset via cooldown expiry", () => {
    it("should clear counter and cooldown after cooldown expires", async () => {
      const now = Date.now();
      const cooldownMs = 60_000;
      const cb = new CircuitBreaker(store, { threshold: 2, cooldownMs });

      // Trigger cooldown
      await cb.recordOutcome("DENY", now);
      await cb.recordOutcome("DENY", now);

      // Verify circuit is open
      expect(await cb.check(now + 100)).not.toBeNull();

      // Auto-reset via cooldown expiry
      expect(await cb.check(now + cooldownMs + 1)).toBeNull();
    });

    it("should allow fresh denials to re-trigger after cooldown expiry", async () => {
      const now = Date.now();
      const cooldownMs = 10_000;
      const cb = new CircuitBreaker(store, { threshold: 1, cooldownMs });

      // Single denial triggers cooldown (threshold=1)
      await cb.recordOutcome("DENY", now);
      expect(await cb.check(now + 1)).not.toBeNull();

      // After cooldown, circuit should be closed
      expect(await cb.check(now + cooldownMs + 1)).toBeNull();

      // After auto-reset, need fresh denials to re-trigger
      await cb.recordOutcome("DENY", now + cooldownMs + 2);
      expect(await cb.check(now + cooldownMs + 3)).not.toBeNull();
    });
  });

  // ── getConfig() ───────────────────────────────────────────────────

  describe("getConfig()", () => {
    it("should return a frozen config object", () => {
      const cb = new CircuitBreaker(store, { threshold: 7, cooldownMs: 10_000 });
      const config = cb.getConfig();

      expect(Object.isFrozen(config)).toBe(true);

      // Attempting to mutate should throw in strict mode / be silently ignored
      expect(() => {
        (config as unknown as Record<string, unknown>).threshold = 999;
      }).toThrow();
    });

    it("should return correct values matching constructor input", () => {
      const cb = new CircuitBreaker(store, { threshold: 8, cooldownMs: 45_000 });
      const config = cb.getConfig();

      expect(config.threshold).toBe(8);
      expect(config.cooldownMs).toBe(45_000);
    });
  });
});

// ── Wallet integration tests for CircuitBreaker ─────────────────────

describe("CircuitBreaker — Wallet integration", () => {
  it("should return CIRCUIT_BREAKER_OPEN after N consecutive denials", async () => {
    const store = new MemoryStore();
    const policy = new PolicyEngine([denyRule], store);

    const wallet = createWallet({
      policy,
      store,
      circuitBreaker: { threshold: 3, cooldownMs: 300_000 },
    });

    // Execute 3 transactions that get denied by policy — triggers circuit breaker
    for (let i = 0; i < 3; i++) {
      const result = await wallet.execute(createTransferIntent({ id: `deny-${i}` }));
      expect(result.status).toBe("denied");
      expect(result.error!.code).toBe("POLICY_DENIED");
    }

    // 4th attempt should be blocked by circuit breaker (not policy)
    const blocked = await wallet.execute(createTransferIntent({ id: "blocked" }));
    expect(blocked.status).toBe("denied");
    expect(blocked.error).toBeDefined();
    expect(blocked.error!.code).toBe("CIRCUIT_BREAKER_OPEN");
    expect(blocked.error!.message).toContain("Circuit breaker open");
    expect(blocked.summary).toContain("circuit breaker");
  });

  it("should reset circuit breaker on successful transaction (ALLOW)", async () => {
    const store = new MemoryStore();
    let callCount = 0;
    const sometimesDenyRule: PolicyRule = {
      name: "sometimes-deny",
      evaluate: async () => {
        callCount++;
        // Deny the first 2 calls, allow everything after
        if (callCount <= 2) {
          return { decision: "DENY" as const, rule: "sometimes-deny", reason: "Denied" };
        }
        return { decision: "ALLOW" as const };
      },
    };

    const policy = new PolicyEngine([sometimesDenyRule], store);
    const wallet = createWallet({
      policy,
      store,
      circuitBreaker: { threshold: 5, cooldownMs: 300_000 },
    });

    // 2 denials (below threshold of 5)
    await wallet.execute(createTransferIntent({ id: "d1" }));
    await wallet.execute(createTransferIntent({ id: "d2" }));

    // Successful transaction should reset the counter
    const success = await wallet.execute(createTransferIntent({ id: "s1" }));
    expect(success.status).toBe("confirmed");

    // Now 4 more denials should not trigger circuit breaker (counter was reset)
    callCount = 0; // reset the mock counter so it denies again
    const denyPolicy = new PolicyEngine([denyRule], store);
    const wallet2 = createWallet({
      policy: denyPolicy,
      store,
      circuitBreaker: { threshold: 5, cooldownMs: 300_000 },
    });

    for (let i = 0; i < 5; i++) {
      const result = await wallet2.execute(createTransferIntent({ id: `d-after-reset-${i}` }));
      expect(result.status).toBe("denied");
      expect(result.error!.code).toBe("POLICY_DENIED");
    }

    // 6th denial is blocked by circuit breaker (5th denial set the cooldown)
    const blocked = await wallet2.execute(createTransferIntent({ id: "should-trigger" }));
    expect(blocked.status).toBe("denied");
    expect(blocked.error!.code).toBe("CIRCUIT_BREAKER_OPEN");
  });

  it("should disable circuit breaker when circuitBreaker is set to false", async () => {
    const store = new MemoryStore();
    const policy = new PolicyEngine([denyRule], store);

    const wallet = createWallet({
      policy,
      store,
      circuitBreaker: false,
    });

    // Even after many denials, there should be no circuit breaker error
    for (let i = 0; i < 10; i++) {
      const result = await wallet.execute(createTransferIntent({ id: `no-cb-${i}` }));
      expect(result.status).toBe("denied");
      expect(result.error!.code).toBe("POLICY_DENIED");
    }
  });

  it("should include circuitBreaker info in getPolicy() result", async () => {
    const store = new MemoryStore();
    const policy = new PolicyEngine([allowAllRule], store);

    const wallet = createWallet({
      policy,
      store,
      circuitBreaker: { threshold: 7, cooldownMs: 120_000 },
    });

    const policySummary = await wallet.getPolicy();
    expect(policySummary.circuitBreaker).toBeDefined();
    // HIGH-T3-01: circuitBreaker threshold and cooldown are now redacted in getPolicy()
    expect(policySummary.circuitBreaker!.threshold).toBe("[redacted]" as unknown as number);
    expect(policySummary.circuitBreaker!.cooldownMs).toBe("[redacted]" as unknown as number);
    expect(policySummary.circuitBreaker!.isOpen).toBe(false);
  });

  it("should show isOpen: true in getPolicy() when circuit is open", async () => {
    const store = new MemoryStore();
    const policy = new PolicyEngine([denyRule], store);

    const wallet = createWallet({
      policy,
      store,
      circuitBreaker: { threshold: 2, cooldownMs: 300_000 },
    });

    // Trigger 2 denials to open the circuit
    await wallet.execute(createTransferIntent({ id: "open-1" }));
    await wallet.execute(createTransferIntent({ id: "open-2" }));

    const policySummary = await wallet.getPolicy();
    expect(policySummary.circuitBreaker).toBeDefined();
    expect(policySummary.circuitBreaker!.isOpen).toBe(true);
  });

  it("should use the correct CIRCUIT_BREAKER_OPEN error code", async () => {
    const store = new MemoryStore();
    const policy = new PolicyEngine([denyRule], store);

    const wallet = createWallet({
      policy,
      store,
      circuitBreaker: { threshold: 1, cooldownMs: 300_000 },
    });

    // 1 denial triggers the circuit breaker (threshold=1)
    const denied = await wallet.execute(createTransferIntent({ id: "trigger" }));
    expect(denied.status).toBe("denied");
    expect(denied.error!.code).toBe("POLICY_DENIED");

    // Next attempt should be blocked by circuit breaker
    const blocked = await wallet.execute(createTransferIntent({ id: "blocked" }));
    expect(blocked.status).toBe("denied");
    expect(blocked.error).toBeDefined();
    expect(blocked.error!.code).toBe("CIRCUIT_BREAKER_OPEN");
    expect(blocked.error!.message).toContain("Circuit breaker open");
    expect(blocked.error!.message).toContain("cooldown remaining");
    expect(blocked.error!.message).toContain("1 consecutive denials");
  });
});
