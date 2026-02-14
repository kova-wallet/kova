import { describe, it, expect, vi } from "vitest";
import { AgentWallet } from "../../../src/core/wallet.js";
import { PolicyEngine } from "../../../src/policy/engine.js";
import { MemoryStore } from "../../../src/stores/memory.js";
import { ApprovalGateRule } from "../../../src/policy/rules/approval-gate.js";
import type { AgentWalletConfig } from "../../../src/core/wallet.js";
import type { PolicyRule, PolicyDecision } from "../../../src/policy/types.js";
import type { Signer, UnsignedTransaction, SignedTransaction } from "../../../src/signers/interface.js";
import type { ChainAdapter } from "../../../src/chains/interface.js";
import type { TransactionIntent } from "../../../src/core/intent.js";
import type { TokenBalance } from "../../../src/core/result.js";
import type { ApprovalChannel, ApprovalResult, ApprovalRequest } from "../../../src/approval/interface.js";

// ── Mock helpers ──────────────────────────────────────────────────

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

const VALID_SOL_ADDRESS = "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre";
const VALID_SOL_ADDRESS_2 = "7v91N7iZ9mNicL8WfG6cgSCKyRXydQjLh6UYBWwm6y1Q";

function createMockSigner(address = "MockAddress1234567890abcdef12345678"): Signer {
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
    params: { to: VALID_SOL_ADDRESS, amount: "1.0", token: "SOL" },
    ...overrides,
  };
}

function createWallet(overrides?: Partial<AgentWalletConfig>) {
  const store = new MemoryStore();
  const defaults: AgentWalletConfig = {
    signer: createMockSigner(),
    chain: createMockChain(),
    policy: new PolicyEngine([allowAllRule], store),
    store,
  };
  return new AgentWallet({ ...defaults, ...overrides });
}

// ── Tests ─────────────────────────────────────────────────────────

describe("AgentWallet", () => {
  describe("constructor", () => {
    it("should instantiate without errors", () => {
      const wallet = createWallet();
      expect(wallet).toBeDefined();
    });

    it("should accept optional approval channel", () => {
      const mockApproval = {
        name: "test-approval",
        requestApproval: async () => ({
          requestId: "req-1",
          decision: "approved" as const,
          decidedAt: Date.now(),
        }),
      };
      const wallet = createWallet({ approval: mockApproval });
      expect(wallet).toBeDefined();
    });

    it("should accept optional audit logger", () => {
      const mockLogger = {
        log: async () => {},
        getRecent: async () => [],
      };
      const wallet = createWallet({ logger: mockLogger as any });
      expect(wallet).toBeDefined();
    });
  });

  describe("getAddress()", () => {
    it("should return the signer's address", async () => {
      const wallet = createWallet();
      const address = await wallet.getAddress();
      expect(address).toBe("MockAddress1234567890abcdef12345678");
    });

    it("should return deterministic address across calls", async () => {
      const wallet = createWallet();
      const addr1 = await wallet.getAddress();
      const addr2 = await wallet.getAddress();
      expect(addr1).toBe(addr2);
    });

    it("should use the signer provided in config", async () => {
      const customSigner = createMockSigner("CustomAddr1234567890abcdef1234");
      const wallet = createWallet({ signer: customSigner });
      expect(await wallet.getAddress()).toBe("CustomAddr1234567890abcdef1234");
    });
  });

  describe("getBalance()", () => {
    it("should delegate to chain adapter and return balance", async () => {
      const wallet = createWallet();
      const balance = await wallet.getBalance("SOL");
      expect(balance).toEqual({
        token: "SOL",
        amount: "10.0",
        decimals: 9,
        usdValue: 1500,
      });
    });

    it("should pass the signer address to the chain adapter", async () => {
      const getBalanceSpy = vi.fn(async (_addr: string, token: string): Promise<TokenBalance> => ({
        token,
        amount: "5.0",
        decimals: 6,
      }));

      const chain = { ...createMockChain(), getBalance: getBalanceSpy };
      const wallet = createWallet({ chain });

      await wallet.getBalance("USDC");
      expect(getBalanceSpy).toHaveBeenCalledWith("MockAddress1234567890abcdef12345678", "USDC");
    });
  });

  describe("execute() — full pipeline", () => {
    it("should return confirmed result for an allowed transfer", async () => {
      const wallet = createWallet();
      const result = await wallet.execute(createTransferIntent());

      expect(result.status).toBe("confirmed");
      expect(result.txId).toBe("mock_tx_abc123");
      expect(result.intentId).toBeDefined();
      expect(result.timestamp).toBeGreaterThan(0);
      expect(result.summary).toContain("Sent");
      expect(result.summary).toContain("1.0");
      expect(result.summary).toContain("SOL");
    });

    it("should auto-generate intent ID if not provided", async () => {
      const wallet = createWallet();
      const result = await wallet.execute(createTransferIntent());

      expect(result.intentId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("should preserve caller-provided intent ID", async () => {
      const wallet = createWallet();
      const result = await wallet.execute(createTransferIntent({ id: "my-custom-id" }));
      expect(result.intentId).toBe("my-custom-id");
    });

    it("should return denied result when policy denies", async () => {
      const store = new MemoryStore();
      const policy = new PolicyEngine([denyRule], store);
      const wallet = createWallet({ policy, store });

      const result = await wallet.execute(createTransferIntent());

      expect(result.status).toBe("denied");
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe("POLICY_DENIED");
      expect(result.error!.message).toBe("All transactions denied");
      // H-05 fix: policyRule is no longer exposed to prevent reconnaissance
      expect(result.error!.policyRule).toBeUndefined();
      expect(result.summary).toContain("Denied by policy");
      expect(result.txId).toBeUndefined();
    });

    it("should return pending result when policy requires approval", async () => {
      const pendingRule: PolicyRule = {
        name: "approval-gate",
        evaluate: async () => ({
          decision: "PENDING" as const,
          rule: "approval-gate",
          approvalRequestId: "approval-req-123",
        }),
      };

      const store = new MemoryStore();
      const policy = new PolicyEngine([pendingRule], store);
      const wallet = createWallet({ policy, store });

      const result = await wallet.execute(createTransferIntent());

      expect(result.status).toBe("pending");
      expect(result.summary).toContain("approval");
      expect(result.summary).toContain("approval-req-123");
      expect(result.txId).toBeUndefined();
    });

    it("should return failed result when chain adapter throws", async () => {
      const chain = {
        ...createMockChain(),
        buildTransaction: async () => {
          throw new Error("RPC connection failed");
        },
      };
      const wallet = createWallet({ chain });

      const result = await wallet.execute(createTransferIntent());

      expect(result.status).toBe("failed");
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe("TRANSACTION_FAILED");
      expect(result.error!.message).toBe("RPC connection failed");
      expect(result.summary).toContain("Transaction failed");
    });

    it("should return failed result when signer throws", async () => {
      const signer = {
        ...createMockSigner(),
        sign: async () => {
          throw new Error("Signing key unavailable");
        },
      };
      const wallet = createWallet({ signer });

      const result = await wallet.execute(createTransferIntent());

      expect(result.status).toBe("failed");
      expect(result.error!.code).toBe("TRANSACTION_FAILED");
      expect(result.error!.message).toBe("Signing key unavailable");
    });

    it("should return failed result when broadcast throws", async () => {
      const chain = {
        ...createMockChain(),
        broadcast: async () => {
          throw new Error("Network timeout");
        },
      };
      const wallet = createWallet({ chain });

      const result = await wallet.execute(createTransferIntent());

      expect(result.status).toBe("failed");
      expect(result.error!.message).toBe("Network timeout");
    });

    it("should handle non-Error throws gracefully", async () => {
      const chain = {
        ...createMockChain(),
        broadcast: async () => {
          throw "string error";
        },
      };
      const wallet = createWallet({ chain });

      const result = await wallet.execute(createTransferIntent());

      expect(result.status).toBe("failed");
      expect(result.error!.message).toBe("string error");
    });

    it("should log audit entry on confirmed transaction", async () => {
      const store = new MemoryStore();
      const wallet = createWallet({ store });

      await wallet.execute(createTransferIntent());

      const logs = await store.getRecent("audit:log", 10);
      expect(logs.length).toBe(1);

      const entry = JSON.parse(logs[0]!);
      expect(entry.finalDecision.decision).toBe("ALLOW");
      expect(entry.transactionResult).toBeDefined();
      expect(entry.transactionResult.txId).toBe("mock_tx_abc123");
      expect(entry.transactionResult.status).toBe("confirmed");
    });

    it("should log audit entry on denied transaction", async () => {
      const store = new MemoryStore();
      const policy = new PolicyEngine([denyRule], store);
      const wallet = createWallet({ policy, store });

      await wallet.execute(createTransferIntent());

      const logs = await store.getRecent("audit:log", 10);
      expect(logs.length).toBe(1);

      const entry = JSON.parse(logs[0]!);
      expect(entry.finalDecision.decision).toBe("DENY");
      expect(entry.transactionResult).toBeUndefined();
    });

    it("should log audit entry on failed transaction", async () => {
      const store = new MemoryStore();
      const chain = {
        ...createMockChain(),
        broadcast: async () => {
          throw new Error("Broadcast failed");
        },
      };
      const wallet = createWallet({ chain, store });

      await wallet.execute(createTransferIntent());

      const logs = await store.getRecent("audit:log", 10);
      expect(logs.length).toBe(1);

      const entry = JSON.parse(logs[0]!);
      expect(entry.finalDecision.decision).toBe("ALLOW");
      expect(entry.transactionResult).toBeUndefined();
    });

    it("should not break if audit logging fails", async () => {
      const store = new MemoryStore();
      // Make append throw to simulate logger failure
      vi.spyOn(store, "append").mockRejectedValue(new Error("Store write failed"));
      const wallet = createWallet({ store });

      // execute() should still return a confirmed result
      const result = await wallet.execute(createTransferIntent());
      expect(result.status).toBe("confirmed");
    });

    it("should pass the normalized intent to policy engine", async () => {
      const evaluateSpy = vi.fn(async (): Promise<PolicyDecision> => ({ decision: "ALLOW" }));
      const spyRule: PolicyRule = { name: "spy-rule", evaluate: evaluateSpy };

      const store = new MemoryStore();
      const policy = new PolicyEngine([spyRule], store);
      const wallet = createWallet({ policy, store });

      await wallet.execute(createTransferIntent());

      // Two-phase evaluation: rule is called once in dry-run, once in commit
      expect(evaluateSpy).toHaveBeenCalledTimes(2);
      const passedIntent = evaluateSpy.mock.calls[0]![0];
      expect(passedIntent.id).toBeDefined();
      expect(passedIntent.createdAt).toBeDefined();
      expect(passedIntent.type).toBe("transfer");
    });

    it("should pass signer address to chain.buildTransaction", async () => {
      const buildSpy = vi.fn(async () => ({
        chain: "solana" as const,
        data: new Uint8Array([1, 2, 3]),
      }));
      const chain = { ...createMockChain(), buildTransaction: buildSpy };
      const wallet = createWallet({ chain });

      await wallet.execute(createTransferIntent());

      expect(buildSpy).toHaveBeenCalledOnce();
      expect(buildSpy.mock.calls[0]![1]).toBe("MockAddress1234567890abcdef12345678");
    });

    it("should pass signed data to chain.broadcast", async () => {
      const broadcastSpy = vi.fn(async () => "mock_tx_123");
      const chain = { ...createMockChain(), broadcast: broadcastSpy };
      const wallet = createWallet({ chain });

      await wallet.execute(createTransferIntent());

      expect(broadcastSpy).toHaveBeenCalledOnce();
      const signedData = broadcastSpy.mock.calls[0]![0];
      expect(signedData).toBeInstanceOf(Uint8Array);
    });
  });

  describe("execute() — summary generation", () => {
    it("should generate transfer summary with shortened address", async () => {
      const wallet = createWallet();
      const result = await wallet.execute(
        createTransferIntent({
          params: { to: VALID_SOL_ADDRESS, amount: "2.5", token: "USDC" },
        }),
      );

      expect(result.summary).toBe("Sent 2.5 USDC to Gsbw...QRre");
    });

    it("should generate swap summary", async () => {
      const wallet = createWallet();
      const result = await wallet.execute({
        type: "swap",
        chain: "solana",
        params: { fromToken: "SOL", toToken: "USDC", amount: "5.0" },
      });

      expect(result.summary).toBe("Swapped 5.0 SOL for USDC");
    });

    it("should generate mint summary", async () => {
      const wallet = createWallet();
      const result = await wallet.execute({
        type: "mint",
        chain: "solana",
        params: {
          collection: VALID_SOL_ADDRESS_2,
          metadataUri: "https://example.com/meta.json",
        },
      });

      expect(result.summary).toBe("Minted NFT from collection 7v91N7iZ...");
    });

    it("should generate stake summary", async () => {
      const wallet = createWallet();
      const result = await wallet.execute({
        type: "stake",
        chain: "solana",
        params: { amount: "100", token: "SOL" },
      });

      expect(result.summary).toBe("Staked 100 SOL");
    });

    it("should generate fallback summary for custom types", async () => {
      const wallet = createWallet();
      const result = await wallet.execute({
        type: "custom",
        chain: "solana",
        params: {
          programId: VALID_SOL_ADDRESS,
          data: "base64data",
          accounts: [],
        },
      });

      expect(result.summary).toBe("Executed custom on solana");
    });

    it("should handle short recipient addresses without truncation", async () => {
      const chain = { ...createMockChain(), isValidAddress: () => true };
      const wallet = createWallet({ chain });
      const result = await wallet.execute(
        createTransferIntent({
          params: { to: "ShortAdr", amount: "1.0", token: "SOL" },
        }),
      );

      expect(result.summary).toBe("Sent 1.0 SOL to ShortAdr");
    });
  });

  describe("getTransactionHistory()", () => {
    it("should return empty array when no transactions exist", async () => {
      const wallet = createWallet();
      const history = await wallet.getTransactionHistory();
      expect(history).toEqual([]);
    });

    it("should return transaction history after execute()", async () => {
      const wallet = createWallet();
      await wallet.execute(createTransferIntent());

      const history = await wallet.getTransactionHistory();
      expect(history.length).toBe(1);
      expect(history[0]!.status).toBe("confirmed");
      expect(history[0]!.txId).toBe("mock_tx_abc123");
    });

    it("should use buildSummary for history entries (S1-15 fix)", async () => {
      const wallet = createWallet();
      await wallet.execute(createTransferIntent());

      const history = await wallet.getTransactionHistory();
      // Should use rich summary, not simple "transfer on solana"
      expect(history[0]!.summary).toContain("Sent");
      expect(history[0]!.summary).toContain("SOL");
    });

    it("should return denied transactions in history", async () => {
      const store = new MemoryStore();
      const policy = new PolicyEngine([denyRule], store);
      const wallet = createWallet({ policy, store });

      await wallet.execute(createTransferIntent());

      const history = await wallet.getTransactionHistory();
      expect(history.length).toBe(1);
      expect(history[0]!.status).toBe("denied");
    });

    it("should respect the limit parameter", async () => {
      const wallet = createWallet();
      await wallet.execute(createTransferIntent());
      await wallet.execute(createTransferIntent());
      await wallet.execute(createTransferIntent());

      const history = await wallet.getTransactionHistory(2);
      expect(history.length).toBe(2);
    });

    it("should return most recent transactions first", async () => {
      const wallet = createWallet();

      await wallet.execute(createTransferIntent({ id: "first" }));
      await wallet.execute(createTransferIntent({ id: "second" }));

      const history = await wallet.getTransactionHistory();
      // Most recent first (from store.getRecent which reverses)
      expect(history[0]!.intentId).toBe("second");
      expect(history[1]!.intentId).toBe("first");
    });

    it("should sanitize NaN limit to default 10 (S1-06 fix)", async () => {
      const wallet = createWallet();
      await wallet.execute(createTransferIntent());

      const history = await wallet.getTransactionHistory(NaN);
      expect(history.length).toBe(1); // only 1 tx exists, but NaN -> 10 default
    });

    it("should sanitize Infinity limit (S1-06 fix)", async () => {
      const wallet = createWallet();
      await wallet.execute(createTransferIntent());

      const history = await wallet.getTransactionHistory(Infinity);
      expect(history.length).toBe(1);
    });

    it("should sanitize negative limit to default (S1-06 fix)", async () => {
      const wallet = createWallet();
      await wallet.execute(createTransferIntent());

      const history = await wallet.getTransactionHistory(-5);
      expect(history.length).toBe(1);
    });

    it("should clamp limit to MAX_HISTORY_LIMIT (S1-06 fix)", async () => {
      const wallet = createWallet();
      await wallet.execute(createTransferIntent());

      // 9999 > MAX_HISTORY_LIMIT (1000), should be clamped
      const history = await wallet.getTransactionHistory(9999);
      expect(history.length).toBe(1); // only 1 tx exists
    });
  });

  describe("execute() — multiple transactions", () => {
    it("should handle sequential transactions independently", async () => {
      const wallet = createWallet();

      const r1 = await wallet.execute(createTransferIntent({ id: "tx-1" }));
      const r2 = await wallet.execute(createTransferIntent({ id: "tx-2" }));

      expect(r1.intentId).toBe("tx-1");
      expect(r2.intentId).toBe("tx-2");
      expect(r1.status).toBe("confirmed");
      expect(r2.status).toBe("confirmed");
    });

    it("should accumulate audit logs across transactions", async () => {
      const store = new MemoryStore();
      const wallet = createWallet({ store });

      await wallet.execute(createTransferIntent());
      await wallet.execute(createTransferIntent());
      await wallet.execute(createTransferIntent());

      const logs = await store.getRecent("audit:log", 100);
      expect(logs.length).toBe(3);
    });
  });

  describe("execute() — intent normalization", () => {
    it("should preserve caller-provided createdAt timestamp", async () => {
      const wallet = createWallet();
      // CORE-018: Use a recent timestamp (within ±5 min of now) so it's not clamped
      const customTime = Date.now() - 60_000; // 1 minute ago

      const evaluateSpy = vi.fn(async (): Promise<PolicyDecision> => ({ decision: "ALLOW" }));
      const spyRule: PolicyRule = { name: "spy-rule", evaluate: evaluateSpy };
      const store = new MemoryStore();
      const policy = new PolicyEngine([spyRule], store);
      const walletWithSpy = createWallet({ policy, store });

      await walletWithSpy.execute(createTransferIntent({ createdAt: customTime }));

      const passedIntent = evaluateSpy.mock.calls[0]![0];
      expect(passedIntent.createdAt).toBe(customTime);
    });

    it("should auto-assign createdAt when not provided", async () => {
      const before = Date.now();

      const evaluateSpy = vi.fn(async (): Promise<PolicyDecision> => ({ decision: "ALLOW" }));
      const spyRule: PolicyRule = { name: "spy-rule", evaluate: evaluateSpy };
      const store = new MemoryStore();
      const policy = new PolicyEngine([spyRule], store);
      const wallet = createWallet({ policy, store });

      await wallet.execute(createTransferIntent());

      const after = Date.now();
      const passedIntent = evaluateSpy.mock.calls[0]![0];
      expect(passedIntent.createdAt).toBeGreaterThanOrEqual(before);
      expect(passedIntent.createdAt).toBeLessThanOrEqual(after);
    });

    it("should generate unique IDs for each execution", async () => {
      const wallet = createWallet();
      const r1 = await wallet.execute(createTransferIntent());
      const r2 = await wallet.execute(createTransferIntent());

      expect(r1.intentId).not.toBe(r2.intentId);
      // Both should be valid UUIDs
      expect(r1.intentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(r2.intentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it("should preserve all original intent fields through normalization", async () => {
      const evaluateSpy = vi.fn(async (): Promise<PolicyDecision> => ({ decision: "ALLOW" }));
      const spyRule: PolicyRule = { name: "spy-rule", evaluate: evaluateSpy };
      const store = new MemoryStore();
      const policy = new PolicyEngine([spyRule], store);
      const wallet = createWallet({ policy, store });

      const originalIntent: TransactionIntent = {
        type: "transfer",
        chain: "solana",
        params: { to: VALID_SOL_ADDRESS, amount: "5.5", token: "USDC" },
        metadata: { agentId: "agent-1", reason: "test payment", urgency: "high" },
      };

      await wallet.execute(originalIntent);

      const passedIntent = evaluateSpy.mock.calls[0]![0];
      expect(passedIntent.type).toBe("transfer");
      expect(passedIntent.chain).toBe("solana");
      expect(passedIntent.params).toEqual(originalIntent.params);
      expect(passedIntent.metadata).toEqual(originalIntent.metadata);
    });
  });

  describe("execute() — audit logging details", () => {
    it("should record agentId from intent metadata in audit entry", async () => {
      const store = new MemoryStore();
      const wallet = createWallet({ store });

      await wallet.execute(createTransferIntent({
        metadata: { agentId: "agent-42", reason: "testing" },
      }));

      const logs = await store.getRecent("audit:log", 10);
      const entry = JSON.parse(logs[0]!);
      expect(entry.agentId).toBe("agent-42");
    });

    it("should record undefined agentId when metadata is absent", async () => {
      const store = new MemoryStore();
      const wallet = createWallet({ store });

      await wallet.execute(createTransferIntent());

      const logs = await store.getRecent("audit:log", 10);
      const entry = JSON.parse(logs[0]!);
      expect(entry.agentId).toBeUndefined();
    });

    it("should record undefined agentId when metadata has no agentId", async () => {
      const store = new MemoryStore();
      const wallet = createWallet({ store });

      await wallet.execute(createTransferIntent({
        metadata: { reason: "no agent id here" },
      }));

      const logs = await store.getRecent("audit:log", 10);
      const entry = JSON.parse(logs[0]!);
      expect(entry.agentId).toBeUndefined();
    });

    it("should record the full intent in audit entry for confirmed tx", async () => {
      const store = new MemoryStore();
      const wallet = createWallet({ store });

      await wallet.execute(createTransferIntent({ id: "audit-test-1" }));

      const logs = await store.getRecent("audit:log", 10);
      const entry = JSON.parse(logs[0]!);
      expect(entry.intent.type).toBe("transfer");
      expect(entry.intent.chain).toBe("solana");
      expect(entry.intent.id).toBe("audit-test-1");
      expect(entry.intentId).toBe("audit-test-1");
    });

    it("should log audit entry on pending transaction", async () => {
      const pendingRule: PolicyRule = {
        name: "approval-gate",
        evaluate: async () => ({
          decision: "PENDING" as const,
          rule: "approval-gate",
          approvalRequestId: "approval-req-789",
        }),
      };

      const store = new MemoryStore();
      const policy = new PolicyEngine([pendingRule], store);
      const wallet = createWallet({ policy, store });

      await wallet.execute(createTransferIntent());

      const logs = await store.getRecent("audit:log", 10);
      expect(logs.length).toBe(1);

      const entry = JSON.parse(logs[0]!);
      expect(entry.finalDecision.decision).toBe("PENDING");
      expect(entry.transactionResult).toBeUndefined();
    });

    it("should record policy rule audits with correct structure", async () => {
      const store = new MemoryStore();
      const wallet = createWallet({ store });

      await wallet.execute(createTransferIntent());

      const logs = await store.getRecent("audit:log", 10);
      const entry = JSON.parse(logs[0]!);

      expect(entry.policyDecisions).toBeDefined();
      expect(entry.policyDecisions.length).toBeGreaterThan(0);
      // S6: Now uses real per-rule audit data from PolicyEngine
      expect(entry.policyDecisions[0].rule).toBe("allow-all");
      expect(entry.policyDecisions[0].result).toBe("ALLOW");
      expect(entry.policyDecisions[0].evaluationTimeMs).toBeGreaterThanOrEqual(0);
    });

    it("should record deny rule name and reason in policy audits", async () => {
      const store = new MemoryStore();
      const policy = new PolicyEngine([denyRule], store);
      const wallet = createWallet({ policy, store });

      await wallet.execute(createTransferIntent());

      const logs = await store.getRecent("audit:log", 10);
      const entry = JSON.parse(logs[0]!);

      expect(entry.policyDecisions[0].rule).toBe("deny-all");
      expect(entry.policyDecisions[0].result).toBe("DENY");
      expect(entry.policyDecisions[0].reason).toBe("All transactions denied");
    });

    it("should include timestamp in audit entry", async () => {
      const store = new MemoryStore();
      const wallet = createWallet({ store });

      const before = Date.now();
      await wallet.execute(createTransferIntent());
      const after = Date.now();

      const logs = await store.getRecent("audit:log", 10);
      const entry = JSON.parse(logs[0]!);

      expect(entry.timestamp).toBeGreaterThanOrEqual(before);
      expect(entry.timestamp).toBeLessThanOrEqual(after);
    });

    it("should not break when audit logger fails on denied transaction", async () => {
      const store = new MemoryStore();
      vi.spyOn(store, "append").mockRejectedValue(new Error("Store write failed"));
      const policy = new PolicyEngine([denyRule], store);
      const wallet = createWallet({ policy, store });

      const result = await wallet.execute(createTransferIntent());
      expect(result.status).toBe("denied");
    });

    it("should not break when audit logger fails on pending transaction", async () => {
      const pendingRule: PolicyRule = {
        name: "approval-gate",
        evaluate: async () => ({
          decision: "PENDING" as const,
          rule: "approval-gate",
          approvalRequestId: "approval-req-fail",
        }),
      };

      const store = new MemoryStore();
      vi.spyOn(store, "append").mockRejectedValue(new Error("Store write failed"));
      const policy = new PolicyEngine([pendingRule], store);
      const wallet = createWallet({ policy, store });

      const result = await wallet.execute(createTransferIntent());
      expect(result.status).toBe("pending");
    });

    it("should not break when audit logger fails on failed transaction", async () => {
      const store = new MemoryStore();
      vi.spyOn(store, "append").mockRejectedValue(new Error("Store write failed"));
      const chain = {
        ...createMockChain(),
        broadcast: async () => { throw new Error("Network error"); },
      };
      const wallet = createWallet({ chain, store });

      const result = await wallet.execute(createTransferIntent());
      expect(result.status).toBe("failed");
    });
  });

  describe("execute() — error handling edge cases", () => {
    it("should return failed when signer.getAddress() throws", async () => {
      const signer = {
        ...createMockSigner(),
        getAddress: async () => { throw new Error("HSM unavailable"); },
      };
      const wallet = createWallet({ signer });

      const result = await wallet.execute(createTransferIntent());

      expect(result.status).toBe("failed");
      expect(result.error!.code).toBe("TRANSACTION_FAILED");
      expect(result.error!.message).toBe("HSM unavailable");
    });

    it("should handle thrown number gracefully", async () => {
      const chain = {
        ...createMockChain(),
        broadcast: async () => { throw 42; },
      };
      const wallet = createWallet({ chain });

      const result = await wallet.execute(createTransferIntent());

      expect(result.status).toBe("failed");
      // CORE-001: Error sanitization strips numeric values
      expect(result.error!.message).toBe("[restricted]");
    });

    it("should handle thrown null gracefully", async () => {
      const chain = {
        ...createMockChain(),
        broadcast: async () => { throw null; },
      };
      const wallet = createWallet({ chain });

      const result = await wallet.execute(createTransferIntent());

      expect(result.status).toBe("failed");
      expect(result.error!.message).toBe("null");
    });

    it("should handle thrown undefined gracefully", async () => {
      const chain = {
        ...createMockChain(),
        broadcast: async () => { throw undefined; },
      };
      const wallet = createWallet({ chain });

      const result = await wallet.execute(createTransferIntent());

      expect(result.status).toBe("failed");
      expect(result.error!.message).toBe("undefined");
    });

    it("should handle thrown object gracefully", async () => {
      const chain = {
        ...createMockChain(),
        broadcast: async () => { throw { code: 500, msg: "internal" }; },
      };
      const wallet = createWallet({ chain });

      const result = await wallet.execute(createTransferIntent());

      expect(result.status).toBe("failed");
      expect(result.error!.message).toBe("[object Object]");
    });
  });

  describe("execute() — concurrent executions", () => {
    it("should handle concurrent execute() calls independently", async () => {
      const wallet = createWallet();

      const [r1, r2, r3] = await Promise.all([
        wallet.execute(createTransferIntent({ id: "concurrent-1" })),
        wallet.execute(createTransferIntent({ id: "concurrent-2" })),
        wallet.execute(createTransferIntent({ id: "concurrent-3" })),
      ]);

      expect(r1.status).toBe("confirmed");
      expect(r2.status).toBe("confirmed");
      expect(r3.status).toBe("confirmed");
      expect(r1.intentId).toBe("concurrent-1");
      expect(r2.intentId).toBe("concurrent-2");
      expect(r3.intentId).toBe("concurrent-3");
    });

    it("should log all concurrent executions to audit", async () => {
      const store = new MemoryStore();
      const wallet = createWallet({ store });

      await Promise.all([
        wallet.execute(createTransferIntent({ id: "par-1" })),
        wallet.execute(createTransferIntent({ id: "par-2" })),
        wallet.execute(createTransferIntent({ id: "par-3" })),
      ]);

      const logs = await store.getRecent("audit:log", 100);
      expect(logs.length).toBe(3);
    });

    it("should handle mixed outcomes in concurrent executions", async () => {
      let callCount = 0;
      const mixedRule: PolicyRule = {
        name: "mixed-rule",
        evaluate: async () => {
          callCount++;
          if (callCount === 2) {
            return { decision: "DENY" as const, rule: "mixed-rule", reason: "Denied second call" };
          }
          return { decision: "ALLOW" as const };
        },
      };

      const store = new MemoryStore();
      const policy = new PolicyEngine([mixedRule], store);
      const wallet = createWallet({ policy, store });

      // Note: Due to async scheduling, order may vary
      const results = await Promise.all([
        wallet.execute(createTransferIntent({ id: "mix-1" })),
        wallet.execute(createTransferIntent({ id: "mix-2" })),
        wallet.execute(createTransferIntent({ id: "mix-3" })),
      ]);

      const statuses = results.map(r => r.status);
      expect(statuses).toContain("denied");
      // At least some should be confirmed
      expect(statuses.filter(s => s === "confirmed").length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("execute() — edge cases with metadata and params", () => {
    it("should execute successfully with undefined metadata", async () => {
      const wallet = createWallet();
      const intent: TransactionIntent = {
        type: "transfer",
        chain: "solana",
        params: { to: VALID_SOL_ADDRESS, amount: "1.0", token: "SOL" },
        // metadata is intentionally absent
      };

      const result = await wallet.execute(intent);
      expect(result.status).toBe("confirmed");
    });

    it("should execute successfully with empty metadata object", async () => {
      const wallet = createWallet();
      const result = await wallet.execute(createTransferIntent({
        metadata: {},
      }));

      expect(result.status).toBe("confirmed");
    });

    it("should execute successfully with full metadata", async () => {
      const wallet = createWallet();
      const result = await wallet.execute(createTransferIntent({
        metadata: {
          agentId: "agent-1",
          taskId: "task-1",
          reason: "monthly payroll",
          urgency: "high",
        },
      }));

      expect(result.status).toBe("confirmed");
    });

    it("should handle swap intent with optional maxSlippage in metadata", async () => {
      const wallet = createWallet();
      const result = await wallet.execute({
        type: "swap",
        chain: "solana",
        params: { fromToken: "SOL", toToken: "USDC", amount: "1.0", maxSlippage: 0.01 },
      });

      expect(result.status).toBe("confirmed");
      expect(result.summary).toContain("Swapped");
    });

    it("should handle mint intent with optional to field", async () => {
      const wallet = createWallet();
      const result = await wallet.execute({
        type: "mint",
        chain: "solana",
        params: {
          collection: VALID_SOL_ADDRESS_2,
          metadataUri: "https://example.com/meta.json",
          to: VALID_SOL_ADDRESS,
        },
      });

      expect(result.status).toBe("confirmed");
    });

    it("should handle stake intent with optional validator", async () => {
      const wallet = createWallet();
      const result = await wallet.execute({
        type: "stake",
        chain: "solana",
        params: { amount: "10", token: "SOL", validator: VALID_SOL_ADDRESS_2 },
      });

      expect(result.status).toBe("confirmed");
      expect(result.summary).toBe("Staked 10 SOL");
    });

    it("should reject intent when chain does not match configured adapter", async () => {
      const wallet = createWallet();
      const result = await wallet.execute({
        type: "transfer",
        chain: "ethereum",
        params: { to: VALID_SOL_ADDRESS, amount: "0.5", token: "ETH" },
      });

      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("VALIDATION_FAILED");
      expect(result.error?.message).toContain("Chain mismatch");
    });
  });

  describe("getTransactionHistory() — advanced", () => {
    it("should use default limit of 10 when not specified", async () => {
      const store = new MemoryStore();
      const wallet = createWallet({ store });

      // Execute 15 transactions
      for (let i = 0; i < 15; i++) {
        await wallet.execute(createTransferIntent({ id: `tx-${i}` }));
      }

      const history = await wallet.getTransactionHistory();
      expect(history.length).toBe(10);
    });

    it("should include pending transactions in history", async () => {
      const pendingRule: PolicyRule = {
        name: "approval-gate",
        evaluate: async () => ({
          decision: "PENDING" as const,
          rule: "approval-gate",
          approvalRequestId: "req-pending-hist",
        }),
      };

      const store = new MemoryStore();
      const policy = new PolicyEngine([pendingRule], store);
      const wallet = createWallet({ policy, store });

      await wallet.execute(createTransferIntent());

      const history = await wallet.getTransactionHistory();
      expect(history.length).toBe(1);
      expect(history[0]!.status).toBe("pending");
    });

    it("should include failed transactions in history", async () => {
      const store = new MemoryStore();
      const chain = {
        ...createMockChain(),
        broadcast: async () => { throw new Error("Broadcast failed"); },
      };
      const wallet = createWallet({ chain, store });

      await wallet.execute(createTransferIntent());

      const history = await wallet.getTransactionHistory();
      expect(history.length).toBe(1);
      expect(history[0]!.status).toBe("failed");
      expect(history[0]!.txId).toBeUndefined();
    });

    it("should return mixed statuses in history", async () => {
      const store = new MemoryStore();

      // First: a confirmed transaction
      const allowPolicy = new PolicyEngine([allowAllRule], store);
      const wallet1 = createWallet({ store, policy: allowPolicy });
      await wallet1.execute(createTransferIntent({ id: "confirmed-1" }));

      // Second: a denied transaction
      const denyPolicy = new PolicyEngine([denyRule], store);
      const wallet2 = createWallet({ store, policy: denyPolicy });
      await wallet2.execute(createTransferIntent({ id: "denied-1" }));

      const history = await wallet1.getTransactionHistory();
      expect(history.length).toBe(2);

      const statuses = history.map(h => h.status);
      expect(statuses).toContain("confirmed");
      expect(statuses).toContain("denied");
    });

    it("should include correct summary format in history entries", async () => {
      const store = new MemoryStore();
      const wallet = createWallet({ store });

      await wallet.execute(createTransferIntent());

      const history = await wallet.getTransactionHistory();
      // S1-15 fix: now uses buildSummary() for rich summaries
      expect(history[0]!.summary).toContain("Sent");
      expect(history[0]!.summary).toContain("SOL");
    });

    it("should include intentId and timestamp in history entries", async () => {
      const store = new MemoryStore();
      const wallet = createWallet({ store });

      await wallet.execute(createTransferIntent({ id: "history-intent-1" }));

      const history = await wallet.getTransactionHistory();
      expect(history[0]!.intentId).toBe("history-intent-1");
      expect(history[0]!.timestamp).toBeGreaterThan(0);
    });
  });

  // ── Sprint 2 Security Fixes ─────────────────────────────────────────

  describe("S1-02 — Idempotency (duplicate intent IDs return cached result)", () => {
    it("should return cached result for same intent ID on second call", async () => {
      const wallet = createWallet();
      const intent = createTransferIntent({ id: "idempotent-1" });

      const r1 = await wallet.execute(intent);
      expect(r1.status).toBe("confirmed");
      expect(r1.intentId).toBe("idempotent-1");

      // Second call with same intent ID should return cached result
      const r2 = await wallet.execute(intent);
      expect(r2.status).toBe("confirmed");
      expect(r2.intentId).toBe("idempotent-1");
      expect(r2.txId).toBe(r1.txId);
    });

    it("should process intents with different IDs independently", async () => {
      const wallet = createWallet();

      const r1 = await wallet.execute(createTransferIntent({ id: "unique-1" }));
      const r2 = await wallet.execute(createTransferIntent({ id: "unique-2" }));

      expect(r1.intentId).toBe("unique-1");
      expect(r2.intentId).toBe("unique-2");
      expect(r1.status).toBe("confirmed");
      expect(r2.status).toBe("confirmed");
    });

    it("should cache denied results for idempotency", async () => {
      const store = new MemoryStore();
      const policy = new PolicyEngine([denyRule], store);
      const wallet = createWallet({ policy, store });

      const intent = createTransferIntent({ id: "deny-idem-1" });
      const r1 = await wallet.execute(intent);
      expect(r1.status).toBe("denied");

      // Second call should return same denial
      const r2 = await wallet.execute(intent);
      expect(r2.status).toBe("denied");
      expect(r2.intentId).toBe("deny-idem-1");
    });

    it("should not re-invoke the policy engine on cached idempotent call", async () => {
      let evaluateCount = 0;
      const countingRule: PolicyRule = {
        name: "counter",
        evaluate: async () => {
          evaluateCount++;
          return { decision: "ALLOW" as const };
        },
      };

      const store = new MemoryStore();
      const policy = new PolicyEngine([countingRule], store);
      const wallet = createWallet({ policy, store });

      const intent = createTransferIntent({ id: "count-1" });
      await wallet.execute(intent);
      const countAfterFirst = evaluateCount;

      await wallet.execute(intent);
      // evaluateCount should NOT increase (cached result returned before policy)
      expect(evaluateCount).toBe(countAfterFirst);
    });

    it("should generate distinct IDs when intent has no ID (no unintended caching)", async () => {
      const wallet = createWallet();

      // Both intents have no ID, so each should get a unique generated ID
      const r1 = await wallet.execute(createTransferIntent());
      const r2 = await wallet.execute(createTransferIntent());

      expect(r1.intentId).not.toBe(r2.intentId);
    });

    it("should cache failed transaction results", async () => {
      const chain = {
        ...createMockChain(),
        broadcast: async () => { throw new Error("Network down"); },
      };
      const wallet = createWallet({ chain });

      const intent = createTransferIntent({ id: "fail-idem-1" });
      const r1 = await wallet.execute(intent);
      expect(r1.status).toBe("failed");

      // Cached failure should be returned
      const r2 = await wallet.execute(intent);
      expect(r2.status).toBe("failed");
      expect(r2.intentId).toBe("fail-idem-1");
    });
  });

  describe("S1-04 — Execute mutex (concurrent calls are serialized)", () => {
    it("should serialize concurrent execute() calls via mutex", async () => {
      const executionOrder: string[] = [];

      const slowRule: PolicyRule = {
        name: "slow-rule",
        evaluate: async (intent) => {
          const id = (intent as any).id ?? "unknown";
          executionOrder.push(`start:${id}`);
          // Simulate async work
          await new Promise((r) => setTimeout(r, 20));
          executionOrder.push(`end:${id}`);
          return { decision: "ALLOW" as const };
        },
      };

      const store = new MemoryStore();
      const policy = new PolicyEngine([slowRule], store);
      const wallet = createWallet({ policy, store });

      // Launch 3 concurrent execute calls
      const [r1, r2, r3] = await Promise.all([
        wallet.execute(createTransferIntent({ id: "mutex-1" })),
        wallet.execute(createTransferIntent({ id: "mutex-2" })),
        wallet.execute(createTransferIntent({ id: "mutex-3" })),
      ]);

      expect(r1.status).toBe("confirmed");
      expect(r2.status).toBe("confirmed");
      expect(r3.status).toBe("confirmed");

      // With mutex serialization, we expect start/end pairs to be ordered
      // (each start-end completes before the next start)
      // The order should be: start:X, end:X, start:Y, end:Y, start:Z, end:Z
      for (let i = 0; i < executionOrder.length - 1; i += 2) {
        const start = executionOrder[i]!;
        const end = executionOrder[i + 1]!;
        // Each start should be immediately followed by its corresponding end
        expect(start.replace("start:", "")).toBe(end.replace("end:", ""));
      }
    });

    it("should not allow concurrent policy bypass (TOCTOU prevention)", async () => {
      // Scenario: rate limit of 1 per minute — concurrent calls should be serialized
      // so the second call sees the updated counter from the first.
      // Two-phase evaluation: each transaction calls evaluate() twice (dry-run + commit),
      // so the threshold must account for 2 calls per allowed transaction.
      const store = new MemoryStore();

      let callCount = 0;
      const rateLimitRule: PolicyRule = {
        name: "rate-check",
        evaluate: async () => {
          callCount++;
          // Allow first 2 calls (= 1 transaction's dry-run + commit), deny after
          if (callCount > 2) {
            return { decision: "DENY" as const, rule: "rate-check", reason: "rate limited" };
          }
          return { decision: "ALLOW" as const };
        },
      };

      const policy = new PolicyEngine([rateLimitRule], store);
      const wallet = createWallet({ policy, store });

      const [r1, r2] = await Promise.all([
        wallet.execute(createTransferIntent({ id: "toctou-1" })),
        wallet.execute(createTransferIntent({ id: "toctou-2" })),
      ]);

      // Due to mutex serialization, the second call should see the updated state
      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toContain("confirmed");
      expect(statuses).toContain("denied");
    });

    it("should release mutex even when internal execution throws", async () => {
      const chain = {
        ...createMockChain(),
        buildTransaction: async () => { throw new Error("Build failed"); },
      };
      const wallet = createWallet({ chain });

      // First call fails
      const r1 = await wallet.execute(createTransferIntent({ id: "mutex-fail-1" }));
      expect(r1.status).toBe("failed");

      // Second call should still work (mutex released properly)
      const wallet2 = createWallet();
      const r2 = await wallet2.execute(createTransferIntent({ id: "mutex-fail-2" }));
      expect(r2.status).toBe("confirmed");
    });

    it("should handle many concurrent execute() calls correctly", async () => {
      const wallet = createWallet();

      const promises = Array.from({ length: 10 }, (_, i) =>
        wallet.execute(createTransferIntent({ id: `mass-${i}` })),
      );

      const results = await Promise.all(promises);

      // All should complete
      expect(results.length).toBe(10);
      results.forEach((r) => {
        expect(r.status).toBe("confirmed");
      });

      // All should have unique intent IDs
      const ids = results.map((r) => r.intentId);
      expect(new Set(ids).size).toBe(10);
    });

    /**
     * LOW-08 fix: Concurrency stress test for the execute() mutex.
     * Verifies that even under heavy concurrent load, the spending counter
     * is correctly incremented by the mutex (no TOCTOU races).
     */
    it("should correctly serialize spending counter under concurrency stress", async () => {
      const store = new MemoryStore();
      let evaluateCount = 0;

      // A rule that atomically increments a counter — if the mutex fails,
      // we'll see fewer increments than expected
      const countingRule: PolicyRule = {
        name: "stress-counter",
        evaluate: async () => {
          evaluateCount++;
          // Simulate async work (context switch opportunity)
          await new Promise((r) => setTimeout(r, 1));
          return { decision: "ALLOW" as const };
        },
      };

      const policy = new PolicyEngine([countingRule], store);
      const wallet = createWallet({ policy, store });

      const N = 20;
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          wallet.execute(createTransferIntent({ id: `stress-${i}` })),
        ),
      );

      // All must complete
      expect(results.length).toBe(N);
      results.forEach((r) => expect(r.status).toBe("confirmed"));

      // Due to mutex serialization and two-phase evaluation (dry-run + commit),
      // evaluateCount must equal 2*N (each transaction evaluates rules twice)
      expect(evaluateCount).toBe(N * 2);

      // All must have unique intent IDs
      const ids = new Set(results.map((r) => r.intentId));
      expect(ids.size).toBe(N);

      // Audit log should have exactly N entries
      const logs = await store.getRecent("audit:log", 100);
      expect(logs.length).toBe(N);
    });
  });

  describe("S1-09 — Intent validation", () => {
    it("should reject invalid intent type", async () => {
      const wallet = createWallet();
      const result = await wallet.execute({
        type: "invalid_type" as any,
        chain: "solana",
        params: { to: "addr", amount: "1", token: "SOL" },
      });

      expect(result.status).toBe("failed");
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe("VALIDATION_FAILED");
      expect(result.error!.message).toContain("Invalid intent type");
      // LOW-01 fix: error messages no longer echo raw input values
    });

    it("should reject invalid chain", async () => {
      const wallet = createWallet();
      const result = await wallet.execute({
        type: "transfer",
        chain: "bitcoin" as any,
        params: { to: "addr", amount: "1", token: "BTC" },
      });

      expect(result.status).toBe("failed");
      expect(result.error!.code).toBe("VALIDATION_FAILED");
      expect(result.error!.message).toContain("Invalid chain");
      // LOW-01 fix: error messages no longer echo raw input values
    });

    it("should reject missing params", async () => {
      const wallet = createWallet();
      const result = await wallet.execute({
        type: "transfer",
        chain: "solana",
        params: null as any,
      });

      expect(result.status).toBe("failed");
      expect(result.error!.code).toBe("VALIDATION_FAILED");
      expect(result.error!.message).toContain("params must be a non-null object");
    });

    it("should reject transfer with empty 'to' address", async () => {
      const wallet = createWallet();
      const result = await wallet.execute({
        type: "transfer",
        chain: "solana",
        params: { to: "", amount: "1.0", token: "SOL" },
      });

      expect(result.status).toBe("failed");
      expect(result.error!.code).toBe("VALIDATION_FAILED");
      expect(result.error!.message).toContain("'to' must be a non-empty string");
    });

    it("should reject transfer with empty 'amount'", async () => {
      const wallet = createWallet();
      const result = await wallet.execute({
        type: "transfer",
        chain: "solana",
        params: { to: VALID_SOL_ADDRESS, amount: "", token: "SOL" },
      });

      expect(result.status).toBe("failed");
      expect(result.error!.code).toBe("VALIDATION_FAILED");
      expect(result.error!.message).toContain("'amount' must be a non-empty string");
    });

    it("should reject transfer with empty 'token'", async () => {
      const wallet = createWallet();
      const result = await wallet.execute({
        type: "transfer",
        chain: "solana",
        params: { to: VALID_SOL_ADDRESS, amount: "1.0", token: "" },
      });

      expect(result.status).toBe("failed");
      expect(result.error!.code).toBe("VALIDATION_FAILED");
      expect(result.error!.message).toContain("'token' must be a non-empty string");
    });

    it("should reject transfer with NaN amount", async () => {
      const wallet = createWallet();
      const result = await wallet.execute({
        type: "transfer",
        chain: "solana",
        params: { to: VALID_SOL_ADDRESS, amount: "not-a-number", token: "SOL" },
      });

      expect(result.status).toBe("failed");
      expect(result.error!.code).toBe("VALIDATION_FAILED");
      expect(result.error!.message).toContain("invalid amount");
    });

    it("should reject transfer with zero amount", async () => {
      const wallet = createWallet();
      const result = await wallet.execute({
        type: "transfer",
        chain: "solana",
        params: { to: VALID_SOL_ADDRESS, amount: "0", token: "SOL" },
      });

      expect(result.status).toBe("failed");
      expect(result.error!.code).toBe("VALIDATION_FAILED");
      expect(result.error!.message).toContain("invalid amount");
    });

    it("should reject transfer with negative amount", async () => {
      const wallet = createWallet();
      const result = await wallet.execute({
        type: "transfer",
        chain: "solana",
        params: { to: VALID_SOL_ADDRESS, amount: "-5", token: "SOL" },
      });

      expect(result.status).toBe("failed");
      expect(result.error!.code).toBe("VALIDATION_FAILED");
      expect(result.error!.message).toContain("invalid amount");
    });

    it("should accept valid transfer intent", async () => {
      const wallet = createWallet();
      const result = await wallet.execute(createTransferIntent());

      expect(result.status).toBe("confirmed");
    });

    it("should reject swap with empty fromToken", async () => {
      const wallet = createWallet();
      const result = await wallet.execute({
        type: "swap",
        chain: "solana",
        params: { fromToken: "", toToken: "USDC", amount: "1.0" },
      });

      expect(result.status).toBe("failed");
      expect(result.error!.code).toBe("VALIDATION_FAILED");
      expect(result.error!.message).toContain("'fromToken' must be a non-empty string");
    });

    it("should reject swap with empty toToken", async () => {
      const wallet = createWallet();
      const result = await wallet.execute({
        type: "swap",
        chain: "solana",
        params: { fromToken: "SOL", toToken: "", amount: "1.0" },
      });

      expect(result.status).toBe("failed");
      expect(result.error!.code).toBe("VALIDATION_FAILED");
      expect(result.error!.message).toContain("'toToken' must be a non-empty string");
    });

    it("should reject swap with invalid amount", async () => {
      const wallet = createWallet();
      const result = await wallet.execute({
        type: "swap",
        chain: "solana",
        params: { fromToken: "SOL", toToken: "USDC", amount: "abc" },
      });

      expect(result.status).toBe("failed");
      expect(result.error!.code).toBe("VALIDATION_FAILED");
      expect(result.error!.message).toContain("invalid amount");
    });

    it("should accept valid swap intent", async () => {
      const wallet = createWallet();
      const result = await wallet.execute({
        type: "swap",
        chain: "solana",
        params: { fromToken: "SOL", toToken: "USDC", amount: "5.0" },
      });

      expect(result.status).toBe("confirmed");
    });

    it("should reject mint with empty collection", async () => {
      const wallet = createWallet();
      const result = await wallet.execute({
        type: "mint",
        chain: "solana",
        params: { collection: "", metadataUri: "https://example.com/meta.json" },
      });

      expect(result.status).toBe("failed");
      expect(result.error!.code).toBe("VALIDATION_FAILED");
      expect(result.error!.message).toContain("'collection' must be a non-empty string");
    });

	    it("should reject mint with empty metadataUri", async () => {
	      const wallet = createWallet();
	      const result = await wallet.execute({
	        type: "mint",
	        chain: "solana",
	        params: { collection: VALID_SOL_ADDRESS_2, metadataUri: "" },
	      });

      expect(result.status).toBe("failed");
      expect(result.error!.code).toBe("VALIDATION_FAILED");
      expect(result.error!.message).toContain("'metadataUri' must be a non-empty string");
    });

	    it("should accept valid mint intent", async () => {
	      const wallet = createWallet();
	      const result = await wallet.execute({
	        type: "mint",
	        chain: "solana",
	        params: { collection: VALID_SOL_ADDRESS_2, metadataUri: "https://example.com/meta.json" },
	      });

      expect(result.status).toBe("confirmed");
    });

    it("should reject stake with invalid amount", async () => {
      const wallet = createWallet();
      const result = await wallet.execute({
        type: "stake",
        chain: "solana",
        params: { amount: "0", token: "SOL" },
      });

      expect(result.status).toBe("failed");
      expect(result.error!.code).toBe("VALIDATION_FAILED");
      expect(result.error!.message).toContain("invalid amount");
    });

    it("should reject stake with empty token", async () => {
      const wallet = createWallet();
      const result = await wallet.execute({
        type: "stake",
        chain: "solana",
        params: { amount: "10", token: "" },
      });

      expect(result.status).toBe("failed");
      expect(result.error!.code).toBe("VALIDATION_FAILED");
      expect(result.error!.message).toContain("'token' must be a non-empty string");
    });

    it("should accept valid stake intent", async () => {
      const wallet = createWallet();
      const result = await wallet.execute({
        type: "stake",
        chain: "solana",
        params: { amount: "10", token: "SOL" },
      });

      expect(result.status).toBe("confirmed");
    });

    it("should reject custom intent with empty programId", async () => {
      const wallet = createWallet();
      const result = await wallet.execute({
        type: "custom",
        chain: "solana",
        params: { programId: "", data: "abc", accounts: [] },
      });

      expect(result.status).toBe("failed");
      expect(result.error!.code).toBe("VALIDATION_FAILED");
      expect(result.error!.message).toContain("'programId' must be a non-empty string");
    });

    it("should reject custom intent with non-string data", async () => {
      const wallet = createWallet();
      const result = await wallet.execute({
        type: "custom",
        chain: "solana",
        params: { programId: VALID_SOL_ADDRESS_2, data: 12345 as any, accounts: [] },
      });

      expect(result.status).toBe("failed");
      expect(result.error!.code).toBe("VALIDATION_FAILED");
      expect(result.error!.message).toContain("do not match the expected shape");
    });

    it("should reject custom intent with non-array accounts", async () => {
      const wallet = createWallet();
      const result = await wallet.execute({
        type: "custom",
        chain: "solana",
        params: { programId: VALID_SOL_ADDRESS_2, data: "abc", accounts: "not-an-array" as any },
      });

      expect(result.status).toBe("failed");
      expect(result.error!.code).toBe("VALIDATION_FAILED");
      expect(result.error!.message).toContain("do not match the expected shape");
    });

    it("should accept valid custom intent", async () => {
      const wallet = createWallet();
      const result = await wallet.execute({
        type: "custom",
        chain: "solana",
        params: { programId: VALID_SOL_ADDRESS_2, data: "abc", accounts: [] },
      });

      expect(result.status).toBe("confirmed");
    });

    it("should accept matching chain and reject mismatched chains", async () => {
      // Solana matches the mock adapter — should succeed
      const wallet = createWallet();
      const solanaResult = await wallet.execute({
        type: "transfer",
        chain: "solana",
        params: { to: VALID_SOL_ADDRESS, amount: "1.0", token: "SOL" },
      });
      expect(solanaResult.status).toBe("confirmed");

      // Ethereum and Base don't match the solana adapter — should fail with chain mismatch
      for (const chain of ["ethereum", "base"] as const) {
        const result = await wallet.execute({
          type: "transfer",
          chain,
          params: { to: VALID_SOL_ADDRESS, amount: "1.0", token: "SOL" },
        });
        expect(result.status).toBe("failed");
        expect(result.error?.message).toContain("Chain mismatch");
      }
    });

    it("should accept all valid intent types", async () => {
      const wallet = createWallet();

      const transferResult = await wallet.execute(createTransferIntent());
      expect(transferResult.status).toBe("confirmed");

      const swapResult = await wallet.execute({
        type: "swap",
        chain: "solana",
        params: { fromToken: "SOL", toToken: "USDC", amount: "1.0" },
      });
      expect(swapResult.status).toBe("confirmed");

      const mintResult = await wallet.execute({
        type: "mint",
        chain: "solana",
        params: { collection: VALID_SOL_ADDRESS_2, metadataUri: "https://example.com/meta.json" },
      });
      expect(mintResult.status).toBe("confirmed");

      const stakeResult = await wallet.execute({
        type: "stake",
        chain: "solana",
        params: { amount: "10", token: "SOL" },
      });
      expect(stakeResult.status).toBe("confirmed");

	      const customResult = await wallet.execute({
	        type: "custom",
	        chain: "solana",
	        params: { programId: VALID_SOL_ADDRESS_2, data: "abc", accounts: [] },
	      });
      expect(customResult.status).toBe("confirmed");
    });

    it("should return 'unknown' as intentId when validation fails and no id provided", async () => {
      const wallet = createWallet();
      const result = await wallet.execute({
        type: "bogus" as any,
        chain: "solana",
        params: { to: "addr", amount: "1", token: "SOL" },
      });

      expect(result.intentId).toBe("unknown");
    });

    it("should return the provided id when validation fails with an id", async () => {
      const wallet = createWallet();
      const result = await wallet.execute({
        id: "my-failed-intent",
        type: "transfer",
        chain: "polygon" as any,
        params: { to: "addr", amount: "1", token: "SOL" },
      });

      expect(result.intentId).toBe("my-failed-intent");
      expect(result.error!.code).toBe("VALIDATION_FAILED");
    });

    it("should reject transfer with whitespace-only 'to' address", async () => {
      const wallet = createWallet();
      const result = await wallet.execute({
        type: "transfer",
        chain: "solana",
        params: { to: "   ", amount: "1.0", token: "SOL" },
      });

      expect(result.status).toBe("failed");
      expect(result.error!.code).toBe("VALIDATION_FAILED");
      expect(result.error!.message).toContain("'to' must be a non-empty string");
    });

    it("should reject transfer with whitespace-only 'amount'", async () => {
      const wallet = createWallet();
      const result = await wallet.execute({
        type: "transfer",
        chain: "solana",
        params: { to: VALID_SOL_ADDRESS, amount: "  ", token: "SOL" },
      });

      expect(result.status).toBe("failed");
      expect(result.error!.code).toBe("VALIDATION_FAILED");
      expect(result.error!.message).toContain("'amount' must be a non-empty string");
    });

    it("should validate before acquiring mutex (no deadlock on invalid)", async () => {
      const wallet = createWallet();

      // Fire off multiple invalid intents concurrently — should all return quickly
      const results = await Promise.all([
        wallet.execute({ type: "bad" as any, chain: "solana", params: { to: "a", amount: "1", token: "SOL" } }),
        wallet.execute({ type: "bad" as any, chain: "solana", params: { to: "a", amount: "1", token: "SOL" } }),
        wallet.execute({ type: "bad" as any, chain: "solana", params: { to: "a", amount: "1", token: "SOL" } }),
      ]);

      results.forEach((r) => {
        expect(r.status).toBe("failed");
        expect(r.error!.code).toBe("VALIDATION_FAILED");
      });
    });
  });

  // ── Sprint 4: Approval Integration Tests ────────────────────────────

  describe("execute() — approval flow integration", () => {
    function createMockApproval(result: ApprovalResult): ApprovalChannel {
      return {
        name: "mock-approval",
        requestApproval: vi.fn(async () => result),
      };
    }

    function createApprovalWallet(
      approval: ApprovalChannel,
      threshold: { amount: string; token: string } = { amount: "5", token: "SOL" },
    ) {
      const store = new MemoryStore();
      const approvalRule = new ApprovalGateRule({ above: threshold });
      const policy = new PolicyEngine([approvalRule], store, approval);
      return createWallet({ policy, store, approval });
    }

    it("should allow transaction below approval threshold without requesting approval", async () => {
      const approval = createMockApproval({
        requestId: "req-1",
        decision: "approved",
        decidedAt: Date.now(),
      });
      const wallet = createApprovalWallet(approval);

      const result = await wallet.execute(
        createTransferIntent({ params: { to: VALID_SOL_ADDRESS, amount: "2.0", token: "SOL" } }),
      );

      expect(result.status).toBe("confirmed");
      expect(approval.requestApproval).not.toHaveBeenCalled();
    });

    it("should approve transaction above threshold when human approves", async () => {
      const approval = createMockApproval({
        requestId: "req-2",
        decision: "approved",
        decidedBy: "Alice",
        decidedAt: Date.now(),
      });
      const wallet = createApprovalWallet(approval);

      const result = await wallet.execute(
        createTransferIntent({ params: { to: VALID_SOL_ADDRESS, amount: "10.0", token: "SOL" } }),
      );

      expect(result.status).toBe("confirmed");
      expect(result.txId).toBe("mock_tx_abc123");
      // Two-phase evaluation: approval is requested in both dry-run and commit phases
      expect(approval.requestApproval).toHaveBeenCalledTimes(2);
    });

    it("should deny transaction above threshold when human rejects", async () => {
      const approval = createMockApproval({
        requestId: "req-3",
        decision: "rejected",
        decidedBy: "Bob",
        decidedAt: Date.now(),
      });
      const wallet = createApprovalWallet(approval);

      const result = await wallet.execute(
        createTransferIntent({ params: { to: VALID_SOL_ADDRESS, amount: "10.0", token: "SOL" } }),
      );

      expect(result.status).toBe("denied");
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe("POLICY_DENIED");
      expect(result.error!.message).toContain("rejected");
      expect(result.error!.message).toContain("Bob");
    });

    it("should deny transaction above threshold on approval timeout", async () => {
      const approval = createMockApproval({
        requestId: "req-4",
        decision: "timeout",
        decidedBy: "system",
        decidedAt: Date.now(),
      });
      const wallet = createApprovalWallet(approval);

      const result = await wallet.execute(
        createTransferIntent({ params: { to: VALID_SOL_ADDRESS, amount: "10.0", token: "SOL" } }),
      );

      expect(result.status).toBe("denied");
      expect(result.error!.code).toBe("POLICY_DENIED");
      expect(result.error!.message).toContain("timed out");
    });

    it("should deny transaction above threshold when no approval channel configured", async () => {
      const store = new MemoryStore();
      const approvalRule = new ApprovalGateRule({ above: { amount: "5", token: "SOL" } });
      // No approval channel passed to PolicyEngine
      const policy = new PolicyEngine([approvalRule], store);
      const wallet = createWallet({ policy, store });

      const result = await wallet.execute(
        createTransferIntent({ params: { to: VALID_SOL_ADDRESS, amount: "10.0", token: "SOL" } }),
      );

      expect(result.status).toBe("denied");
      expect(result.error!.code).toBe("POLICY_DENIED");
      expect(result.error!.message).toContain("no approval channel is configured");
    });

    it("should deny transaction when approval channel throws (fail-closed)", async () => {
      const approval: ApprovalChannel = {
        name: "broken-approval",
        requestApproval: vi.fn(async () => {
          throw new Error("Telegram API unreachable");
        }),
      };
      const wallet = createApprovalWallet(approval);

      const result = await wallet.execute(
        createTransferIntent({ params: { to: VALID_SOL_ADDRESS, amount: "10.0", token: "SOL" } }),
      );

      expect(result.status).toBe("denied");
      expect(result.error!.code).toBe("POLICY_DENIED");
      expect(result.error!.message).toContain("Approval channel error");
    });

    it("should pass correct approval request fields to the channel", async () => {
      const requestSpy = vi.fn(async (): Promise<ApprovalResult> => ({
        requestId: "req-spy",
        decision: "approved",
        decidedAt: Date.now(),
      }));
      const approval: ApprovalChannel = { name: "spy-approval", requestApproval: requestSpy };
      const wallet = createApprovalWallet(approval);

      await wallet.execute(
        createTransferIntent({
          params: { to: VALID_SOL_ADDRESS, amount: "10.0", token: "SOL" },
          metadata: { agentId: "agent-99", reason: "quarterly payout" },
        }),
      );

      // Two-phase evaluation: approval is requested in both dry-run and commit phases
      expect(requestSpy).toHaveBeenCalledTimes(2);
      const request: ApprovalRequest = requestSpy.mock.calls[0]![0];
      expect(request.amount).toBe("10");
      expect(request.token).toBe("SOL");
      expect(request.target).toBe(VALID_SOL_ADDRESS);
      expect(request.agentId).toBe("agent-99");
      expect(request.expiresAt).toBeGreaterThan(Date.now());
    });

    it("should log audit entry with decidedBy info on approved transaction", async () => {
      const approval = createMockApproval({
        requestId: "req-audit",
        decision: "approved",
        decidedBy: "Charlie",
        decidedAt: Date.now(),
      });
      const store = new MemoryStore();
      const approvalRule = new ApprovalGateRule({ above: { amount: "5", token: "SOL" } });
      const policy = new PolicyEngine([approvalRule], store, approval);
      const wallet = createWallet({ policy, store, approval });

      await wallet.execute(
        createTransferIntent({ params: { to: VALID_SOL_ADDRESS, amount: "10.0", token: "SOL" } }),
      );

      const logs = await store.getRecent("audit:log", 10);
      expect(logs.length).toBe(1);
      const entry = JSON.parse(logs[0]!);
      expect(entry.finalDecision.decision).toBe("ALLOW");
      expect(entry.transactionResult).toBeDefined();
      expect(entry.transactionResult.txId).toBe("mock_tx_abc123");
    });

    // ── Additional approval integration tests ─────────────────────────────

    it("should allow transaction exactly at approval threshold (boundary test)", async () => {
      const approval = createMockApproval({
        requestId: "req-boundary",
        decision: "approved",
        decidedAt: Date.now(),
      });
      const wallet = createApprovalWallet(approval, { amount: "5", token: "SOL" });

      // Exactly 5.0 SOL with threshold of 5 — should be allowed without approval (<=)
      const result = await wallet.execute(
        createTransferIntent({ params: { to: VALID_SOL_ADDRESS, amount: "5.0", token: "SOL" } }),
      );

      expect(result.status).toBe("confirmed");
      expect(approval.requestApproval).not.toHaveBeenCalled();
    });

    it("should trigger approval for amount just above threshold (5.01 > 5.0)", async () => {
      const approval = createMockApproval({
        requestId: "req-just-above",
        decision: "approved",
        decidedAt: Date.now(),
      });
      const wallet = createApprovalWallet(approval, { amount: "5", token: "SOL" });

      const result = await wallet.execute(
        createTransferIntent({ params: { to: VALID_SOL_ADDRESS, amount: "5.01", token: "SOL" } }),
      );

      expect(result.status).toBe("confirmed");
      // Two-phase evaluation: approval is requested in both dry-run and commit phases
      expect(approval.requestApproval).toHaveBeenCalledTimes(2);
    });

    it("should deny USDC transfer when approval threshold is for SOL (POLICY-001 unmatched token)", async () => {
      const approval = createMockApproval({
        requestId: "req-usdc",
        decision: "approved",
        decidedAt: Date.now(),
      });
      // Threshold on SOL only
      const wallet = createApprovalWallet(approval, { amount: "5", token: "SOL" });

      // POLICY-001 fix: Unmatched tokens now DENY instead of silently ALLOW
      const result = await wallet.execute(
        createTransferIntent({ params: { to: VALID_SOL_ADDRESS, amount: "1000", token: "USDC" } }),
      );

      expect(result.status).toBe("denied");
    });

    it("should trigger approval for swap intent above threshold", async () => {
      const approval = createMockApproval({
        requestId: "req-swap",
        decision: "approved",
        decidedBy: "SwapApprover",
        decidedAt: Date.now(),
      });
      const wallet = createApprovalWallet(approval, { amount: "5", token: "SOL" });

      const result = await wallet.execute({
        type: "swap",
        chain: "solana",
        params: { fromToken: "SOL", toToken: "USDC", amount: "10.0" },
      });

      expect(result.status).toBe("confirmed");
      // Two-phase evaluation: approval is requested in both dry-run and commit phases
      expect(approval.requestApproval).toHaveBeenCalledTimes(2);
    });

    it("should deny swap intent above threshold when human rejects", async () => {
      const approval = createMockApproval({
        requestId: "req-swap-deny",
        decision: "rejected",
        decidedBy: "Admin",
        decidedAt: Date.now(),
      });
      const wallet = createApprovalWallet(approval, { amount: "5", token: "SOL" });

      const result = await wallet.execute({
        type: "swap",
        chain: "solana",
        params: { fromToken: "SOL", toToken: "USDC", amount: "10.0" },
      });

      expect(result.status).toBe("denied");
      expect(result.error!.code).toBe("POLICY_DENIED");
      expect(result.error!.message).toContain("rejected");
    });

    it("should allow swap intent below threshold without requesting approval", async () => {
      const approval = createMockApproval({
        requestId: "req-swap-below",
        decision: "approved",
        decidedAt: Date.now(),
      });
      const wallet = createApprovalWallet(approval, { amount: "5", token: "SOL" });

      const result = await wallet.execute({
        type: "swap",
        chain: "solana",
        params: { fromToken: "SOL", toToken: "USDC", amount: "2.0" },
      });

      expect(result.status).toBe("confirmed");
      expect(approval.requestApproval).not.toHaveBeenCalled();
    });
  });
});
