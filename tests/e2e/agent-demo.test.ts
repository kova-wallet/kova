import { describe, it, expect, vi } from "vitest";
import { AgentWallet } from "../../src/core/wallet.js";
import { PolicyEngine } from "../../src/policy/engine.js";
import { MemoryStore } from "../../src/stores/memory.js";
import { Policy } from "../../src/policy/builder.js";
import { AuditLogger } from "../../src/logging/audit.js";
import { SpendingLimitRule } from "../../src/policy/rules/spending-limit.js";
import { AllowlistRule } from "../../src/policy/rules/allowlist.js";
import { RateLimitRule } from "../../src/policy/rules/rate-limit.js";
import { ApprovalGateRule } from "../../src/policy/rules/approval-gate.js";
import type { PolicyRule } from "../../src/policy/types.js";
import type {
  Signer,
  UnsignedTransaction,
  SignedTransaction,
} from "../../src/signers/interface.js";
import type { ChainAdapter } from "../../src/chains/interface.js";
import type { TransactionIntent } from "../../src/core/intent.js";
import type { TokenBalance } from "../../src/core/result.js";
import type {
  ApprovalChannel,
  ApprovalResult,
  ApprovalRequest,
} from "../../src/approval/interface.js";

// ── Mock helpers ──────────────────────────────────────────────────

const MOCK_ADDRESS = "7v91N7iZ9mNicL8WfG6cgSCKyRXydQjLh6UYBWwm6y1Q";
const ALLOWLISTED_RECIPIENT = "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre";

function createMockSigner(
  address = MOCK_ADDRESS,
): Signer {
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
    getBalance: async (
      _addr: string,
      token: string,
    ): Promise<TokenBalance> => ({
      token,
      amount: "10.0",
      decimals: 9,
      usdValue: 1500,
    }),
    getValueInUSD: async (_token: string, amount: string) =>
      parseFloat(amount) * 150,
    buildTransaction: async (
      intent: TransactionIntent,
      _signerAddress: string,
    ) => ({
      chain: "solana",
      data: new TextEncoder().encode(
        JSON.stringify({ type: intent.type, mock: true }),
      ),
      description: `Mock ${intent.type}`,
    }),
    simulateTransaction: vi.fn().mockResolvedValue({ success: true }),
    broadcast: async () =>
      "mock_tx_" + Math.random().toString(36).slice(2, 10),
    getTransactionStatus: async (txId: string) => ({
      status: "confirmed" as const,
      txId,
    }),
    isValidAddress: (addr: string) =>
      /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr),
  };
}

function createTransferIntent(
  overrides?: Partial<TransactionIntent>,
): TransactionIntent {
  return {
    type: "transfer",
    chain: "solana",
    params: {
      to: ALLOWLISTED_RECIPIENT,
      amount: "0.1",
      token: "SOL",
    },
    ...overrides,
  };
}

/**
 * Build a realistic policy engine with spending limits, rate limits, and an allowlist.
 * This mirrors how a real agent deployment would configure the wallet.
 */
function buildStandardPolicy(store: MemoryStore, approval?: ApprovalChannel) {
  const rules: PolicyRule[] = [
    new RateLimitRule({ maxTransactionsPerMinute: 5, maxTransactionsPerHour: 20 }),
    new AllowlistRule({
      allowAddresses: [ALLOWLISTED_RECIPIENT, "CoLLecTion1111111111111111111111111111111111"],
    }),
    new SpendingLimitRule({
      perTransaction: { amount: "1", token: "SOL" },
      daily: { amount: "5", token: "SOL" },
    }),
  ];
  return new PolicyEngine(rules, store, approval);
}

// ── E2E Test Suite ───────────────────────────────────────────────

describe("Agent Demo — E2E Workflow", () => {
  // ────────────────────────────────────────────────────────────────
  // 1. Policy introspection
  // ────────────────────────────────────────────────────────────────

  describe("Policy introspection", () => {
    it("getPolicy() returns a summary with spending limits, rate limits, and allowlist count", async () => {
      const store = new MemoryStore();
      const policy = buildStandardPolicy(store);
      const wallet = new AgentWallet({
        signer: createMockSigner(),
        chain: createMockChain(),
        policy,
        store,
      });

      const summary = await wallet.getPolicy();

      // Spending limits — HIGH-T3-01 + MED-38: amounts and tokens are redacted
      expect(summary.spendingLimits.perTransaction).toEqual({
        amount: "[redacted]",
        token: "[redacted]",
      });
      expect(summary.spendingLimits.daily).toBeDefined();
      expect(summary.spendingLimits.daily!.amount).toBe("[redacted]");
      expect(summary.spendingLimits.daily!.token).toBe("[redacted]");

      // Rate limits — HIGH-T3-01: thresholds are redacted
      expect(summary.rateLimits).toBeDefined();
      expect(summary.rateLimits!.maxPerMinute).toBe("[redacted]" as unknown as number);
      expect(summary.rateLimits!.maxPerHour).toBe("[redacted]" as unknown as number);

      // Allowlist count — MED-38: counts are redacted to -1
      expect(summary.allowlistedAddresses).toBe(-1);
    });

    it("getAddress() returns the mock signer address", async () => {
      const store = new MemoryStore();
      const policy = buildStandardPolicy(store);
      const wallet = new AgentWallet({
        signer: createMockSigner(),
        chain: createMockChain(),
        policy,
        store,
      });

      const address = await wallet.getAddress();
      expect(address).toBe(MOCK_ADDRESS);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 2. Successful transfer within limits
  // ────────────────────────────────────────────────────────────────

  describe("Successful transfer within limits", () => {
    it("transfers 0.1 SOL to an allowlisted address and returns confirmed with txId", async () => {
      const store = new MemoryStore();
      const policy = buildStandardPolicy(store);
      const wallet = new AgentWallet({
        signer: createMockSigner(),
        chain: createMockChain(),
        policy,
        store,
      });

      const result = await wallet.execute(createTransferIntent());

      expect(result.status).toBe("confirmed");
      expect(result.txId).toBeDefined();
      expect(result.txId!.startsWith("mock_tx_")).toBe(true);
      expect(result.intentId).toBeDefined();
      expect(result.timestamp).toBeGreaterThan(0);
    });

    it("creates an audit log entry with hash chain fields", async () => {
      const store = new MemoryStore();
      const logger = new AuditLogger(store);
      const policy = buildStandardPolicy(store);
      const wallet = new AgentWallet({
        signer: createMockSigner(),
        chain: createMockChain(),
        policy,
        store,
        logger,
      });

      await wallet.execute(createTransferIntent());

      const entries = await logger.getRecent(10);
      expect(entries.length).toBe(1);

      const entry = entries[0]!;
      expect(entry.hash).toBeDefined();
      expect(typeof entry.hash).toBe("string");
      expect(entry.hash!.length).toBe(64); // SHA-256 hex string
      // First entry has no previousHash
      expect(entry.previousHash).toBeUndefined();
    });

    it("includes per-rule audit data in the audit log entry", async () => {
      const store = new MemoryStore();
      const logger = new AuditLogger(store);
      const policy = buildStandardPolicy(store);
      const wallet = new AgentWallet({
        signer: createMockSigner(),
        chain: createMockChain(),
        policy,
        store,
        logger,
      });

      await wallet.execute(createTransferIntent());

      const entries = await logger.getRecent(10);
      const entry = entries[0]!;

      expect(entry.policyDecisions).toBeDefined();
      expect(entry.policyDecisions.length).toBe(3); // rate-limit, allowlist, spending-limit

      // Each rule audit should have a name and result
      const ruleNames = entry.policyDecisions.map((d) => d.rule);
      expect(ruleNames).toContain("rate-limit");
      expect(ruleNames).toContain("allowlist");
      expect(ruleNames).toContain("spending-limit");

      for (const audit of entry.policyDecisions) {
        expect(audit.result).toBe("ALLOW");
        expect(audit.evaluationTimeMs).toBeGreaterThanOrEqual(0);
      }
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 3. Policy denial scenarios
  // ────────────────────────────────────────────────────────────────

  describe("Policy denial scenarios", () => {
    it("denies a transfer exceeding the per-transaction spending limit", async () => {
      const store = new MemoryStore();
      const policy = buildStandardPolicy(store);
      const wallet = new AgentWallet({
        signer: createMockSigner(),
        chain: createMockChain(),
        policy,
        store,
      });

      const result = await wallet.execute(
        createTransferIntent({
          params: {
            to: ALLOWLISTED_RECIPIENT,
            amount: "2.0", // exceeds perTransaction limit of 1 SOL
            token: "SOL",
          },
        }),
      );

      expect(result.status).toBe("denied");
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe("POLICY_DENIED");
      expect(result.error!.message).toContain("Per-transaction spending limit exceeded");
    });

    it("denies a transfer to a non-allowlisted address", async () => {
      const store = new MemoryStore();
      const policy = buildStandardPolicy(store);
      const wallet = new AgentWallet({
        signer: createMockSigner(),
        chain: createMockChain(),
        policy,
        store,
      });

      const result = await wallet.execute(
        createTransferIntent({
          params: {
            to: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            amount: "0.1",
            token: "SOL",
          },
        }),
      );

      expect(result.status).toBe("denied");
      expect(result.error!.code).toBe("POLICY_DENIED");
      // H-05: "allowlist" is sanitized to "policy rule" in error messages
      expect(result.error!.message).toContain("not in");
      expect(result.error!.message).toContain("policy rule");
    });

    it("denies after rate limit is exceeded by rapid transfers", async () => {
      const store = new MemoryStore();
      // Rate limit of 3 per minute to make test faster
      const rules: PolicyRule[] = [
        new RateLimitRule({ maxTransactionsPerMinute: 3 }),
        new AllowlistRule({ allowAddresses: [ALLOWLISTED_RECIPIENT] }),
        new SpendingLimitRule({
          perTransaction: { amount: "1", token: "SOL" },
          daily: { amount: "50", token: "SOL" },
        }),
      ];
      const policy = new PolicyEngine(rules, store);
      const wallet = new AgentWallet({
        signer: createMockSigner(),
        chain: createMockChain(),
        policy,
        store,
      });

      // Execute 3 transfers (should all succeed)
      for (let i = 0; i < 3; i++) {
        const r = await wallet.execute(createTransferIntent());
        expect(r.status).toBe("confirmed");
      }

      // The 4th should be denied by rate limit
      const result = await wallet.execute(createTransferIntent());
      expect(result.status).toBe("denied");
      expect(result.error!.code).toBe("POLICY_DENIED");
      expect(result.error!.message).toContain("Rate limit exceeded");
    });

    it("denies after daily spending limit accumulation is exhausted", async () => {
      const store = new MemoryStore();
      const rules: PolicyRule[] = [
        new AllowlistRule({ allowAddresses: [ALLOWLISTED_RECIPIENT] }),
        new SpendingLimitRule({
          perTransaction: { amount: "1", token: "SOL" },
          daily: { amount: "0.5", token: "SOL" },
        }),
      ];
      const policy = new PolicyEngine(rules, store);
      const wallet = new AgentWallet({
        signer: createMockSigner(),
        chain: createMockChain(),
        policy,
        store,
      });

      // First transfer of 0.4 SOL -- within daily limit of 0.5
      const r1 = await wallet.execute(
        createTransferIntent({
          params: { to: ALLOWLISTED_RECIPIENT, amount: "0.4", token: "SOL" },
        }),
      );
      expect(r1.status).toBe("confirmed");

      // Second transfer of 0.2 SOL -- would push daily total to 0.6 > 0.5
      const r2 = await wallet.execute(
        createTransferIntent({
          params: { to: ALLOWLISTED_RECIPIENT, amount: "0.2", token: "SOL" },
        }),
      );
      expect(r2.status).toBe("denied");
      expect(r2.error!.code).toBe("POLICY_DENIED");
      expect(r2.error!.message).toContain("spending limit exceeded");
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 4. Approval flow
  // ────────────────────────────────────────────────────────────────

  describe("Approval flow", () => {
    it("triggers approval for amounts above threshold and proceeds when approved", async () => {
      const mockApproval: ApprovalChannel = {
        name: "mock-approval",
        requestApproval: vi.fn(
          async (req: ApprovalRequest): Promise<ApprovalResult> => ({
            requestId: req.id,
            decision: "approved",
            decidedBy: "test-user",
            decidedAt: Date.now(),
          }),
        ),
      };

      const store = new MemoryStore();
      const rules: PolicyRule[] = [
        new SpendingLimitRule(
          { perTransaction: { amount: "1", token: "SOL" } },
        ),
        new ApprovalGateRule(
          { above: { amount: "0.3", token: "SOL" }, timeout: 5000 },
        ),
      ];
      const engine = new PolicyEngine(rules, store, mockApproval);
      const wallet = new AgentWallet({
        signer: createMockSigner(),
        chain: createMockChain(),
        policy: engine,
        store,
        approval: mockApproval,
      });

      // 0.5 SOL > 0.3 threshold, should trigger approval
      const result = await wallet.execute(
        createTransferIntent({
          params: { to: ALLOWLISTED_RECIPIENT, amount: "0.5", token: "SOL" },
        }),
      );

      expect(result.status).toBe("confirmed");
      expect(result.txId).toBeDefined();
      // CRIT-10 fix: Approval is now only requested in Phase 2 (commit), not Phase 1 (dry-run)
      expect(mockApproval.requestApproval).toHaveBeenCalledTimes(1);
    });

    it("denies when the approval channel returns rejected", async () => {
      const mockApproval: ApprovalChannel = {
        name: "mock-approval",
        requestApproval: vi.fn(
          async (req: ApprovalRequest): Promise<ApprovalResult> => ({
            requestId: req.id,
            decision: "rejected",
            decidedBy: "admin-user",
            decidedAt: Date.now(),
          }),
        ),
      };

      const store = new MemoryStore();
      const rules: PolicyRule[] = [
        new SpendingLimitRule(
          { perTransaction: { amount: "1", token: "SOL" } },
        ),
        new ApprovalGateRule(
          { above: { amount: "0.3", token: "SOL" }, timeout: 5000 },
        ),
      ];
      const engine = new PolicyEngine(rules, store, mockApproval);
      const wallet = new AgentWallet({
        signer: createMockSigner(),
        chain: createMockChain(),
        policy: engine,
        store,
        approval: mockApproval,
      });

      const result = await wallet.execute(
        createTransferIntent({
          params: { to: ALLOWLISTED_RECIPIENT, amount: "0.5", token: "SOL" },
        }),
      );

      expect(result.status).toBe("denied");
      expect(result.error!.code).toBe("POLICY_DENIED");
      expect(result.error!.message).toContain("rejected");
      // H-05: Error messages are sanitized, but "admin-user" should still be present
      // as it's not a rule name or number
      expect(result.error!.message).toContain("admin-user");
      // Phase 1 dry-run gets rejection -> DENY, Phase 2 never runs
      expect(mockApproval.requestApproval).toHaveBeenCalledOnce();
    });

    it("skips approval for amounts at or below the threshold", async () => {
      const mockApproval: ApprovalChannel = {
        name: "mock-approval",
        requestApproval: vi.fn(
          async (req: ApprovalRequest): Promise<ApprovalResult> => ({
            requestId: req.id,
            decision: "approved",
            decidedBy: "test-user",
            decidedAt: Date.now(),
          }),
        ),
      };

      const store = new MemoryStore();
      const rules: PolicyRule[] = [
        new SpendingLimitRule(
          { perTransaction: { amount: "1", token: "SOL" } },
        ),
        new ApprovalGateRule(
          { above: { amount: "0.3", token: "SOL" }, timeout: 5000 },
        ),
      ];
      const engine = new PolicyEngine(rules, store, mockApproval);
      const wallet = new AgentWallet({
        signer: createMockSigner(),
        chain: createMockChain(),
        policy: engine,
        store,
        approval: mockApproval,
      });

      // 0.2 SOL <= 0.3 threshold, should NOT trigger approval
      const result = await wallet.execute(
        createTransferIntent({
          params: { to: ALLOWLISTED_RECIPIENT, amount: "0.2", token: "SOL" },
        }),
      );

      expect(result.status).toBe("confirmed");
      expect(mockApproval.requestApproval).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 5. Circuit breaker
  // ────────────────────────────────────────────────────────────────

  describe("Circuit breaker", () => {
    it("opens after 5 consecutive policy denials and returns CIRCUIT_BREAKER_OPEN on the 6th", async () => {
      const store = new MemoryStore();
      // A policy that always denies
      const denyRule: PolicyRule = {
        name: "always-deny",
        evaluate: async () => ({
          decision: "DENY" as const,
          rule: "always-deny",
          reason: "Denied for circuit breaker test",
        }),
      };
      const policy = new PolicyEngine([denyRule], store);
      const wallet = new AgentWallet({
        signer: createMockSigner(),
        chain: createMockChain(),
        policy,
        store,
        circuitBreaker: { threshold: 5, cooldownMs: 60_000 },
      });

      // 5 denials through the policy engine
      for (let i = 0; i < 5; i++) {
        const r = await wallet.execute(createTransferIntent());
        expect(r.status).toBe("denied");
        expect(r.error!.code).toBe("POLICY_DENIED");
      }

      // 6th call should be blocked by circuit breaker BEFORE reaching policy
      const r6 = await wallet.execute(createTransferIntent());
      expect(r6.status).toBe("denied");
      expect(r6.error!.code).toBe("CIRCUIT_BREAKER_OPEN");
      expect(r6.summary).toContain("circuit breaker");
    });

    it("resets after cooldown period expires", async () => {
      const store = new MemoryStore();
      const denyRule: PolicyRule = {
        name: "always-deny",
        evaluate: async () => ({
          decision: "DENY" as const,
          rule: "always-deny",
          reason: "Denied for circuit breaker test",
        }),
      };
      const policy = new PolicyEngine([denyRule], store);
      const wallet = new AgentWallet({
        signer: createMockSigner(),
        chain: createMockChain(),
        policy,
        store,
        circuitBreaker: { threshold: 5, cooldownMs: 1000 },
      });

      // Trigger circuit breaker
      for (let i = 0; i < 5; i++) {
        await wallet.execute(createTransferIntent());
      }

      // Circuit should be open now
      const blocked = await wallet.execute(createTransferIntent());
      expect(blocked.error!.code).toBe("CIRCUIT_BREAKER_OPEN");

      // Wait for cooldown to expire
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // After cooldown, the circuit resets. Next call reaches the policy again.
      const afterCooldown = await wallet.execute(createTransferIntent());
      // It will be POLICY_DENIED (the policy still denies), not CIRCUIT_BREAKER_OPEN
      expect(afterCooldown.status).toBe("denied");
      expect(afterCooldown.error!.code).toBe("POLICY_DENIED");
    });

    it("resets denial counter when a transaction is allowed", async () => {
      const store = new MemoryStore();
      let denyCount = 0;
      const sometimesDenyRule: PolicyRule = {
        name: "sometimes-deny",
        evaluate: async () => {
          denyCount++;
          // Two-phase evaluation: DENY calls evaluate once (Phase 1 only),
          // ALLOW calls evaluate twice (Phase 1 + Phase 2).
          // Deny the first 3 calls (= 3 transactions), allow the 4th+5th calls
          // (= 1 transaction: Phase 1 dry-run + Phase 2 commit), then deny again.
          if (denyCount <= 3 || denyCount >= 6) {
            return {
              decision: "DENY" as const,
              rule: "sometimes-deny",
              reason: "Denied",
            };
          }
          return { decision: "ALLOW" as const };
        },
      };
      const policy = new PolicyEngine([sometimesDenyRule], store);
      const wallet = new AgentWallet({
        signer: createMockSigner(),
        chain: createMockChain(),
        policy,
        store,
        circuitBreaker: { threshold: 5, cooldownMs: 60_000 },
      });

      // 3 denials (denyCount goes to 1, 2, 3)
      for (let i = 0; i < 3; i++) {
        const r = await wallet.execute(createTransferIntent());
        expect(r.status).toBe("denied");
      }

      // 4th call is allowed -- resets the denial counter
      // (denyCount=4 Phase 1 ALLOW, denyCount=5 Phase 2 ALLOW)
      const allowed = await wallet.execute(createTransferIntent());
      expect(allowed.status).toBe("confirmed");

      // Next 4 denials should NOT trip the circuit breaker (counter was reset)
      for (let i = 0; i < 4; i++) {
        const r = await wallet.execute(createTransferIntent());
        expect(r.status).toBe("denied");
        expect(r.error!.code).toBe("POLICY_DENIED");
      }
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 6. Tool call dispatch
  // ────────────────────────────────────────────────────────────────

  describe("Tool call dispatch", () => {
    function createToolWallet() {
      const store = new MemoryStore();
      const policy = buildStandardPolicy(store);
      return new AgentWallet({
        signer: createMockSigner(),
        chain: createMockChain(),
        policy,
        store,
        // H-06: enabledTools must explicitly include write tools and wallet_get_policy
        enabledTools: new Set([
          "wallet_transfer", "wallet_swap", "wallet_mint", "wallet_stake",
          "wallet_execute_custom", "wallet_get_balance", "wallet_get_policy",
          "wallet_get_transaction_history",
        ]),
      });
    }

    it("wallet_transfer executes and returns a ToolCallResult", async () => {
      const wallet = createToolWallet();

      const result = await wallet.handleToolCall("wallet_transfer", {
        to: ALLOWLISTED_RECIPIENT,
        amount: "0.1",
        token: "SOL",
        chain: "solana",
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      const txResult = result.data as { status: string; txId: string };
      expect(txResult.status).toBe("confirmed");
      expect(txResult.txId).toBeDefined();
    });

    it("wallet_get_balance returns balance data", async () => {
      const wallet = createToolWallet();

      const result = await wallet.handleToolCall("wallet_get_balance", {
        token: "SOL",
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      const balance = result.data as TokenBalance;
      expect(balance.token).toBe("SOL");
      expect(balance.amount).toBe("10.0");
      expect(balance.decimals).toBe(9);
    });

    it("wallet_get_policy returns policy summary", async () => {
      const wallet = createToolWallet();

      const result = await wallet.handleToolCall("wallet_get_policy", {});

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      const summary = result.data as { spendingLimits: unknown; rateLimits: unknown };
      expect(summary.spendingLimits).toBeDefined();
      expect(summary.rateLimits).toBeDefined();
    });

    it("toAnthropicTools() returns array with expected tool names", () => {
      const wallet = createToolWallet();
      const tools = wallet.toAnthropicTools();

      expect(Array.isArray(tools)).toBe(true);
      // API-002/API-003: Default safe tools are 6 (dangerous tools opt-in only)
      expect(tools.length).toBeGreaterThanOrEqual(6);

      const names = tools.map((t) => t.name);
      expect(names).toContain("wallet_transfer");
      expect(names).toContain("wallet_get_balance");
      expect(names).toContain("wallet_get_transaction_history");

      // Anthropic format uses input_schema
      for (const tool of tools) {
        expect(tool.input_schema).toBeDefined();
        expect(tool.input_schema.type).toBe("object");
      }
    });

    it("toOpenAITools() returns array with expected structure", () => {
      const wallet = createToolWallet();
      const tools = wallet.toOpenAITools();

      expect(Array.isArray(tools)).toBe(true);
      // API-002/API-003: Default safe tools are 6 (dangerous tools opt-in only)
      expect(tools.length).toBeGreaterThanOrEqual(6);

      for (const tool of tools) {
        expect(tool.type).toBe("function");
        expect(tool.function).toBeDefined();
        expect(tool.function.name).toBeDefined();
        expect(tool.function.parameters).toBeDefined();
        expect(tool.function.parameters.type).toBe("object");
      }

      const names = tools.map((t) => t.function.name);
      expect(names).toContain("wallet_transfer");
      expect(names).toContain("wallet_swap");
      expect(names).toContain("wallet_get_balance");
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 7. Transaction history
  // ────────────────────────────────────────────────────────────────

  describe("Transaction history", () => {
    it("reflects a mix of confirmed and denied entries", async () => {
      const store = new MemoryStore();
      const policy = buildStandardPolicy(store);
      const wallet = new AgentWallet({
        signer: createMockSigner(),
        chain: createMockChain(),
        policy,
        store,
      });

      // 1. Confirmed transfer
      await wallet.execute(createTransferIntent({ id: "hist-ok" }));

      // 2. Denied transfer (exceeds per-tx limit)
      await wallet.execute(
        createTransferIntent({
          id: "hist-denied",
          params: {
            to: ALLOWLISTED_RECIPIENT,
            amount: "2.0",
            token: "SOL",
          },
        }),
      );

      const history = await wallet.getTransactionHistory(10);
      expect(history.length).toBe(2);

      const statuses = history.map((h) => h.status);
      expect(statuses).toContain("confirmed");
      expect(statuses).toContain("denied");
    });

    it("history entries have correct intentId and timestamp", async () => {
      const store = new MemoryStore();
      const policy = buildStandardPolicy(store);
      const wallet = new AgentWallet({
        signer: createMockSigner(),
        chain: createMockChain(),
        policy,
        store,
      });

      await wallet.execute(createTransferIntent({ id: "hist-check-1" }));

      const history = await wallet.getTransactionHistory();
      expect(history.length).toBe(1);
      expect(history[0]!.intentId).toBe("hist-check-1");
      expect(history[0]!.timestamp).toBeGreaterThan(0);
      expect(history[0]!.status).toBe("confirmed");
      expect(history[0]!.summary).toContain("Sent");
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 8. Idempotency
  // ────────────────────────────────────────────────────────────────

  describe("Idempotency", () => {
    it("returns identical cached result when sending the same intent ID twice", async () => {
      const store = new MemoryStore();
      const broadcastSpy = vi.fn(async () => "mock_tx_idempotent_abc");
      const chain: ChainAdapter = {
        ...createMockChain(),
        broadcast: broadcastSpy,
      };
      const policy = buildStandardPolicy(store);
      const wallet = new AgentWallet({
        signer: createMockSigner(),
        chain,
        policy,
        store,
      });

      const intent = createTransferIntent({ id: "idempotent-e2e-1" });

      const r1 = await wallet.execute(intent);
      expect(r1.status).toBe("confirmed");
      expect(r1.txId).toBe("mock_tx_idempotent_abc");

      // Second call with same ID -- should return cached result
      const r2 = await wallet.execute(intent);
      expect(r2.status).toBe("confirmed");
      expect(r2.txId).toBe("mock_tx_idempotent_abc");
      expect(r2.intentId).toBe("idempotent-e2e-1");

      // broadcast should only have been called once
      expect(broadcastSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 9. Policy serialization
  // ────────────────────────────────────────────────────────────────

  describe("Policy serialization", () => {
    it("policy.toJSON() -> Policy.fromJSON() roundtrip produces same config", () => {
      const policy = Policy.create("agent-policy")
        .spendingLimit({
          perTransaction: { amount: "1", token: "SOL" },
          daily: { amount: "10", token: "SOL" },
        })
        .allowAddresses([ALLOWLISTED_RECIPIENT, "CoLLecTion1111111111111111111111111111111111"])
        .rateLimit({ maxTransactionsPerMinute: 5, maxTransactionsPerHour: 20 })
        .requireApproval({ above: { amount: "5", token: "SOL" }, timeout: 30000 })
        .build();

      const json = policy.toJSON();
      const restored = Policy.fromJSON(json);
      const restoredJson = restored.toJSON();

      expect(restoredJson).toEqual(json);
      expect(restoredJson.name).toBe("agent-policy");
      expect(restoredJson.spendingLimit!.perTransaction!.amount).toBe("1");
      expect(restoredJson.allowAddresses!.length).toBe(2);
      expect(restoredJson.rateLimit!.maxTransactionsPerMinute).toBe(5);
      expect(restoredJson.approvalGate!.above.amount).toBe("5");
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 10. Audit integrity
  // ────────────────────────────────────────────────────────────────

  describe("Audit integrity", () => {
    it("verifyIntegrity() returns valid after several transactions", async () => {
      const store = new MemoryStore();
      const logger = new AuditLogger(store);
      const policy = buildStandardPolicy(store);
      const wallet = new AgentWallet({
        signer: createMockSigner(),
        chain: createMockChain(),
        policy,
        store,
        logger,
      });

      // Execute several transactions to build a hash chain
      await wallet.execute(createTransferIntent({ id: "audit-1" }));
      await wallet.execute(createTransferIntent({ id: "audit-2" }));
      await wallet.execute(createTransferIntent({ id: "audit-3" }));

      // Also a denied one (exceeds per-tx limit)
      await wallet.execute(
        createTransferIntent({
          id: "audit-denied",
          params: { to: ALLOWLISTED_RECIPIENT, amount: "2.0", token: "SOL" },
        }),
      );

      const integrity = await logger.verifyIntegrity();
      expect(integrity.valid).toBe(true);
      expect(integrity.entriesChecked).toBe(4);
      expect(integrity.firstBrokenAt).toBe(-1);
    });

    it("each audit entry has hash and previousHash fields linked correctly", async () => {
      const store = new MemoryStore();
      const logger = new AuditLogger(store);
      const policy = buildStandardPolicy(store);
      const wallet = new AgentWallet({
        signer: createMockSigner(),
        chain: createMockChain(),
        policy,
        store,
        logger,
      });

      await wallet.execute(createTransferIntent({ id: "chain-1" }));
      await wallet.execute(createTransferIntent({ id: "chain-2" }));
      await wallet.execute(createTransferIntent({ id: "chain-3" }));

      // getRecent returns newest-first
      const entries = await logger.getRecent(10);
      expect(entries.length).toBe(3);

      // Reverse to get oldest-first for chain validation
      const sorted = [...entries].reverse();

      // First entry should have no previousHash
      expect(sorted[0]!.hash).toBeDefined();
      expect(sorted[0]!.previousHash).toBeUndefined();

      // Each subsequent entry's previousHash should match the prior entry's hash
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i]!.hash).toBeDefined();
        expect(sorted[i]!.previousHash).toBe(sorted[i - 1]!.hash);
      }
    });
  });
});
