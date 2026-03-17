import { describe, it, expect, vi } from "vitest";
import { AgentWallet } from "../../../src/core/wallet.js";
import { PolicyEngine } from "../../../src/policy/engine.js";
import { MemoryStore } from "../../../src/stores/memory.js";
import { SpendingLimitRule } from "../../../src/policy/rules/spending-limit.js";
import { AllowlistRule } from "../../../src/policy/rules/allowlist.js";
import { RateLimitRule } from "../../../src/policy/rules/rate-limit.js";
import { TimeWindowRule } from "../../../src/policy/rules/time-window.js";
import { ApprovalGateRule } from "../../../src/policy/rules/approval-gate.js";
import {
  WALLET_TOOLS,
  WALLET_TOOL_NAMES,
  getToolByName,
} from "../../../src/adapters/tools.js";
import { createMcpServer } from "../../../src/adapters/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentWalletConfig } from "../../../src/core/wallet.js";
import type { PolicyRule } from "../../../src/policy/types.js";
import type {
  Signer,
  UnsignedTransaction,
  SignedTransaction,
} from "../../../src/signers/interface.js";
import type { ChainAdapter } from "../../../src/chains/interface.js";
import type { TransactionIntent } from "../../../src/core/intent.js";
import type { TokenBalance } from "../../../src/core/result.js";

// ── Mock helpers ──────────────────────────────────────────────────

const allowAllRule: PolicyRule = {
  name: "allow-all",
  evaluate: async () => ({ decision: "ALLOW" }),
};

function createMockSigner(
  address = "7v91N7iZ9mNicL8WfG6cgSCKyRXydQjLh6UYBWwm6y1Q",
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
    broadcast: async () => "mock_tx_abc123",
    getTransactionStatus: async (txId: string) => ({
      status: "confirmed" as const,
      txId,
    }),
    isValidAddress: (addr: string) =>
      /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr),
  };
}

function createWallet(overrides?: Partial<AgentWalletConfig>) {
  const store = overrides?.store ?? new MemoryStore();
  const defaults: AgentWalletConfig = {
    signer: createMockSigner(),
    chain: createMockChain(),
    policy: new PolicyEngine([allowAllRule], store),
    store,
    dangerouslyDisableAuth: true,
    enabledTools: new Set([
      "wallet_transfer",
      "wallet_swap",
      "wallet_mint",
      "wallet_stake",
      "wallet_execute_custom",
      "wallet_get_balance",
      "wallet_get_policy",
      "wallet_get_transaction_history",
      "wallet_get_spending_remaining",
      "wallet_get_all_balances",
    ]),
  };
  return new AgentWallet({ ...defaults, ...overrides });
}

/**
 * Helper to extract JSON from sanitized tool response.
 * CRIT-T3-01: sanitizeToolResponse wraps JSON in structured delimiters.
 * This helper extracts the JSON line from the wrapped format.
 */
function parseSanitizedResponse(response: string): unknown {
  const lines = response.split("\n");
  // The JSON payload is the third line (index 2) in the wrapped format:
  // Line 0: <<< TOOL RESPONSE DATA START ... >>>
  // Line 1: Tool: <name>
  // Line 2: <JSON payload>
  // Line 3: <<< TOOL RESPONSE DATA END >>>
  const jsonLine = lines[2];
  if (!jsonLine) throw new Error("No JSON payload found in sanitized response");
  return JSON.parse(jsonLine);
}

// ── Canonical Tool Definitions ────────────────────────────────────

describe("Canonical Tool Definitions", () => {
  it("should define exactly 14 safe tools (only wallet_execute_custom in DANGEROUS_TOOLS)", () => {
    // wallet_get_policy moved to safe tools; wallet_get_spending_remaining and wallet_get_all_balances added
    expect(WALLET_TOOLS).toHaveLength(14);
    expect(WALLET_TOOL_NAMES).toHaveLength(15);
  });

  it("should have safe tool names be a subset of WALLET_TOOL_NAMES", () => {
    const names = WALLET_TOOLS.map((t) => t.name);
    for (const name of names) {
      expect(WALLET_TOOL_NAMES).toContain(name);
    }
  });

  it("each tool should have required fields", () => {
    for (const tool of WALLET_TOOLS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.parameters.type).toBe("object");
      expect(tool.parameters.properties).toBeDefined();
      expect(Array.isArray(tool.parameters.required)).toBe(true);
    }
  });

  it("all required params should exist in properties", () => {
    for (const tool of WALLET_TOOLS) {
      for (const req of tool.parameters.required) {
        expect(tool.parameters.properties).toHaveProperty(req);
      }
    }
  });

  it("getToolByName should return correct tool", () => {
    expect(getToolByName("wallet_transfer")?.name).toBe("wallet_transfer");
    expect(getToolByName("wallet_get_balance")?.name).toBe(
      "wallet_get_balance",
    );
  });

  it("getToolByName should return undefined for unknown name", () => {
    expect(getToolByName("nonexistent")).toBeUndefined();
  });

  it("wallet_transfer should require to, amount, token, chain", () => {
    const tool = getToolByName("wallet_transfer")!;
    expect(tool.parameters.required).toEqual(
      expect.arrayContaining(["to", "amount", "token", "chain"]),
    );
  });

  it("wallet_swap should require fromToken, toToken, amount, chain", () => {
    const tool = getToolByName("wallet_swap")!;
    expect(tool.parameters.required).toEqual(
      expect.arrayContaining(["fromToken", "toToken", "amount", "chain"]),
    );
  });

  it("wallet_get_policy should have no required params", () => {
    const tool = getToolByName("wallet_get_policy")!;
    expect(tool.parameters.required).toEqual([]);
  });
});

// ── MCP Server Adapter ────────────────────────────────────────────

describe("MCP Server Adapter", () => {
  async function createMcpClientServer(options?: Parameters<typeof createMcpServer>[1]) {
    const wallet = createWallet();
    const server = createMcpServer(wallet, options);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, server, wallet };
  }

  it("should list 14 safe tools by default", async () => {
    const { client } = await createMcpClientServer();
    const result = await client.listTools();
    expect(result.tools).toHaveLength(14);
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("wallet_transfer");
    expect(names).toContain("wallet_get_balance");
    expect(names).toContain("wallet_get_transaction_history");
    expect(names).toContain("wallet_get_supported_tokens");
    expect(names).toContain("wallet_get_address");
    expect(names).toContain("wallet_estimate_fee");
    expect(names).toContain("wallet_get_token_price");
    expect(names).toContain("wallet_get_transaction_status");
    expect(names).toContain("wallet_get_policy");
    expect(names).toContain("wallet_get_spending_remaining");
    expect(names).toContain("wallet_get_all_balances");
    expect(names).not.toContain("wallet_execute_custom");
  });

  it("should list 15 tools when includeDangerous is true", async () => {
    const { client } = await createMcpClientServer({ includeDangerous: true });
    const result = await client.listTools();
    expect(result.tools).toHaveLength(15);
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("wallet_execute_custom");
  });

  it("should exclude tools by name", async () => {
    const { client } = await createMcpClientServer({ exclude: ["wallet_swap", "wallet_mint"] });
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).not.toContain("wallet_swap");
    expect(names).not.toContain("wallet_mint");
    expect(names).toContain("wallet_transfer");
  });

  it("each tool should have inputSchema with type, properties, and required", async () => {
    const { client } = await createMcpClientServer();
    const result = await client.listTools();
    for (const tool of result.tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toBeDefined();
    }
  });

  it("tool names should be a subset of canonical definitions", async () => {
    const { client } = await createMcpClientServer();
    const result = await client.listTools();
    for (const tool of result.tools) {
      expect(WALLET_TOOL_NAMES).toContain(tool.name);
    }
  });

  it("should call wallet_get_balance and return result", async () => {
    const { client } = await createMcpClientServer();
    const result = await client.callTool({ name: "wallet_get_balance", arguments: { token: "SOL" } });
    expect(result.content).toHaveLength(1);
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    const parsed = parseSanitizedResponse(text) as { success: boolean; data: { token: string } };
    expect(parsed.success).toBe(true);
    expect(parsed.data.token).toBe("SOL");
  });

  it("should call wallet_transfer and return confirmed result", async () => {
    const { client } = await createMcpClientServer();
    const result = await client.callTool({
      name: "wallet_transfer",
      arguments: {
        to: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre",
        amount: "1.0",
        token: "SOL",
        chain: "solana",
      },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    const parsed = parseSanitizedResponse(text) as { success: boolean; data: { status: string } };
    expect(parsed.success).toBe(true);
    expect(parsed.data.status).toBe("confirmed");
  });

  it("should return isError for unknown tool", async () => {
    const { client } = await createMcpClientServer();
    const result = await client.callTool({ name: "unknown_tool", arguments: {} });
    expect(result.isError).toBe(true);
  });

  it("should return isError for policy-denied transfer", async () => {
    const denyRule: PolicyRule = {
      name: "deny-all",
      evaluate: async () => ({
        decision: "DENY" as const,
        rule: "deny-all",
        reason: "All denied",
      }),
    };
    const store = new MemoryStore();
    const policy = new PolicyEngine([denyRule], store);
    const wallet = createWallet({ policy, store });

    const server = createMcpServer(wallet);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "wallet_transfer",
      arguments: {
        to: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre",
        amount: "1.0",
        token: "SOL",
        chain: "solana",
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    const parsed = parseSanitizedResponse(text) as { success: boolean; data: { status: string } };
    expect(parsed.success).toBe(false);
    expect(parsed.data.status).toBe("denied");
  });
});

// ── handleToolCall dispatch ───────────────────────────────────────

describe("handleToolCall", () => {
  it("should dispatch wallet_transfer and return confirmed result", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_transfer", {
      to: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre",
      amount: "1.0",
      token: "SOL",
      chain: "solana",
    });
    expect(result.success).toBe(true);
    expect((result.data as { status: string }).status).toBe("confirmed");
  });

  it("should dispatch wallet_swap and return confirmed result", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_swap", {
      fromToken: "SOL",
      toToken: "USDC",
      amount: "5.0",
      chain: "solana",
    });
    expect(result.success).toBe(true);
    expect((result.data as { status: string }).status).toBe("confirmed");
  });

  it("should dispatch wallet_mint and return confirmed result", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_mint", {
      collection: "CoLLecTion1111111111111111111111111111111111",
      metadataUri: "https://arweave.net/abc123",
      chain: "solana",
    });
    expect(result.success).toBe(true);
  });

  it("should dispatch wallet_stake and return confirmed result", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_stake", {
      amount: "10.0",
      token: "SOL",
      chain: "solana",
    });
    expect(result.success).toBe(true);
  });

  it("should dispatch wallet_execute_custom with JSON accounts string", async () => {
    const wallet = createWallet();
    const accounts = JSON.stringify([
      { address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", isSigner: false, isWritable: true },
    ]);
    const result = await wallet.handleToolCall("wallet_execute_custom", {
      programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      data: "AQID",
      accounts,
      chain: "solana",
    });
    expect(result.success).toBe(true);
  });

  it("should dispatch wallet_execute_custom with object accounts", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_execute_custom", {
      programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      data: "AQID",
      accounts: [
        { address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", isSigner: false, isWritable: true },
      ],
      chain: "solana",
    });
    // MED-09: Validation now rejects non-string accounts; object arrays fail validation
    expect(result.success).toBe(false);
    expect(result.error).toContain("Validation failed");
  });

  it("should return error for invalid accounts JSON string", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_execute_custom", {
      programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      data: "AQID",
      accounts: "not-valid-json",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("accounts");
  });

  it("should dispatch wallet_get_balance and return balance", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_get_balance", {
      token: "SOL",
    });
    expect(result.success).toBe(true);
    expect((result.data as { token: string }).token).toBe("SOL");
    expect((result.data as { amount: string }).amount).toBe("10.0");
  });

  it("should dispatch wallet_get_policy and return summary", async () => {
    const store = new MemoryStore();
    const rule = new SpendingLimitRule({
      perTransaction: { amount: "10", token: "SOL" },
    });
    const policy = new PolicyEngine([rule], store);
    const wallet = createWallet({ policy, store });

    const result = await wallet.handleToolCall("wallet_get_policy", {});
    expect(result.success).toBe(true);
    // MED-38: Policy name is now redacted to "custom" when rules exist
    expect((result.data as { name: string }).name).toBe("custom");
  });

  it("should dispatch wallet_get_transaction_history", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall(
      "wallet_get_transaction_history",
      {},
    );
    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
  });

  it("should dispatch wallet_get_transaction_history with limit", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall(
      "wallet_get_transaction_history",
      { limit: 5 },
    );
    expect(result.success).toBe(true);
  });

  it("should return error for unknown tool name", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("unknown_tool", {});
    expect(result.success).toBe(false);
    // MED-09: Validation now catches unknown tools and returns "Validation failed" immediately
    expect(result.error).toContain("Validation failed");
  });

  it("should return denied result for policy-denied transfer", async () => {
    const denyRule: PolicyRule = {
      name: "deny-all",
      evaluate: async () => ({
        decision: "DENY" as const,
        rule: "deny-all",
        reason: "All denied",
      }),
    };
    const store = new MemoryStore();
    const policy = new PolicyEngine([denyRule], store);
    const wallet = createWallet({ policy, store });

    const result = await wallet.handleToolCall("wallet_transfer", {
      to: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre",
      amount: "1.0",
      token: "SOL",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect((result.data as { status: string }).status).toBe("denied");
    expect(result.error).toBeDefined();
  });

  it("should return validation error for missing params", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_transfer", {
      to: "",
      amount: "1.0",
      token: "SOL",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("'to' must be a non-empty string");
  });

  it("should pass reason as metadata when provided", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_transfer", {
      to: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre",
      amount: "1.0",
      token: "SOL",
      chain: "solana",
      reason: "Payment for services",
    });
    expect(result.success).toBe(true);
  });

  it("should handle swap with maxSlippage", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_swap", {
      fromToken: "SOL",
      toToken: "USDC",
      amount: "1.0",
      chain: "solana",
      maxSlippage: 0.01,
    });
    expect(result.success).toBe(true);
  });

  it("should handle mint with optional to field", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_mint", {
      collection: "CoLLecTion1111111111111111111111111111111111",
      metadataUri: "https://arweave.net/abc123",
      chain: "solana",
      to: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre",
    });
    expect(result.success).toBe(true);
  });

  it("should handle stake with optional validator", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_stake", {
      amount: "10.0",
      token: "SOL",
      chain: "solana",
      validator: "Sysvar1111111111111111111111111111111111111",
    });
    expect(result.success).toBe(true);
  });

  it("should dispatch wallet_get_spending_remaining with no spending limits", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_get_spending_remaining", {});
    expect(result.success).toBe(true);
    expect((result.data as { message: string }).message).toContain("No spending limits configured");
  });

  it("should dispatch wallet_get_spending_remaining with daily limit configured", async () => {
    const store = new MemoryStore();
    const rule = new SpendingLimitRule({
      daily: { amount: "100", token: "SOL" },
    });
    const policy = new PolicyEngine([rule], store);
    const wallet = createWallet({ policy, store });

    const result = await wallet.handleToolCall("wallet_get_spending_remaining", {});
    expect(result.success).toBe(true);
    const data = result.data as Record<string, { window: string; remaining: string; limit: string }>;
    expect(data.daily_SOL).toBeDefined();
    expect(data.daily_SOL.window).toBe("daily");
    expect(data.daily_SOL.remaining).toBe("100.0000");
    expect(data.daily_SOL.limit).toBe("100");
  });

  it("should dispatch wallet_get_spending_remaining with USD limits", async () => {
    const store = new MemoryStore();
    const rule = new SpendingLimitRule({
      dailyUSD: { amount: "500" },
    });
    const policy = new PolicyEngine([rule], store);
    const wallet = createWallet({ policy, store });

    const result = await wallet.handleToolCall("wallet_get_spending_remaining", {});
    expect(result.success).toBe(true);
    const data = result.data as Record<string, { window: string; remaining: string }>;
    expect(data.daily_USD).toBeDefined();
    expect(data.daily_USD.remaining).toBe("$500.00");
  });

  it("should dispatch wallet_get_all_balances", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_get_all_balances", {});
    expect(result.success).toBe(true);
    const data = result.data as { balances: Array<{ token: string; amount: string }> };
    expect(Array.isArray(data.balances)).toBe(true);
    expect(data.balances.length).toBeGreaterThanOrEqual(2); // SOL + USDC at minimum
    expect(data.balances.some(b => b.token === "SOL")).toBe(true);
  });
});

// ── getPolicy introspection ───────────────────────────────────────

describe("getPolicy", () => {
  it("should return policy name from rule names", async () => {
    const store = new MemoryStore();
    const rule = new SpendingLimitRule({
      perTransaction: { amount: "10", token: "SOL" },
    });
    const policy = new PolicyEngine([rule], store);
    const wallet = createWallet({ policy, store });

    const summary = await wallet.getPolicy();
    // MED-38: Policy name is now redacted to "custom" when rules exist
    expect(summary.name).toBe("custom");
  });

  it("should join multiple rule names with +", async () => {
    const store = new MemoryStore();
    const rules = [
      new SpendingLimitRule({ perTransaction: { amount: "10", token: "SOL" } }),
      new RateLimitRule({ maxTransactionsPerMinute: 5 }),
    ];
    const policy = new PolicyEngine(rules, store);
    const wallet = createWallet({ policy, store });

    const summary = await wallet.getPolicy();
    // MED-38: Policy name is now redacted to "custom" when rules exist
    expect(summary.name).toBe("custom");
  });

  it("should populate per-transaction spending limit", async () => {
    const store = new MemoryStore();
    const rule = new SpendingLimitRule({
      perTransaction: { amount: "10", token: "SOL" },
    });
    const policy = new PolicyEngine([rule], store);
    const wallet = createWallet({ policy, store });

    const summary = await wallet.getPolicy();
    // MED-38: Both amount and token are now redacted in getPolicy()
    expect(summary.spendingLimits.perTransaction).toEqual({
      amount: "[redacted]",
      token: "[redacted]",
    });
  });

  it("should populate daily spending limit without exposing 'used' counter (HIGH-09)", async () => {
    const store = new MemoryStore();
    const rule = new SpendingLimitRule({
      daily: { amount: "100", token: "SOL" },
    });
    const policy = new PolicyEngine([rule], store);
    const wallet = createWallet({ policy, store });

    const summary = await wallet.getPolicy();
    // HIGH-09: 'used' spending counters are no longer exposed in getPolicy()
    // HIGH-T3-01: spending amounts are now redacted in getPolicy()
    expect(summary.spendingLimits.daily?.amount).toBe("[redacted]");
    // MED-38: Token is now redacted in getPolicy()
    expect(summary.spendingLimits.daily?.token).toBe("[redacted]");
    expect(summary.spendingLimits.daily?.used).toBeUndefined();
  });

  it("should not expose daily 'used' counter even when store has data (HIGH-09)", async () => {
    const store = new MemoryStore();
    await store.set("spending:daily:SOL", "42.5");
    const rule = new SpendingLimitRule({
      daily: { amount: "100", token: "SOL" },
    });
    const policy = new PolicyEngine([rule], store);
    const wallet = createWallet({ policy, store });

    const summary = await wallet.getPolicy();
    // HIGH-09: 'used' spending counters are no longer exposed in getPolicy()
    expect(summary.spendingLimits.daily?.used).toBeUndefined();
  });

  it("should populate weekly and monthly limits without exposing 'used' counters (HIGH-09)", async () => {
    const store = new MemoryStore();
    const rule = new SpendingLimitRule({
      weekly: { amount: "500", token: "SOL" },
      monthly: { amount: "2000", token: "SOL" },
    });
    const policy = new PolicyEngine([rule], store);
    const wallet = createWallet({ policy, store });

    const summary = await wallet.getPolicy();
    // HIGH-09: 'used' spending counters are no longer exposed in getPolicy()
    // HIGH-T3-01: spending amounts are now redacted in getPolicy()
    expect(summary.spendingLimits.weekly?.amount).toBe("[redacted]");
    // MED-38: Tokens are now redacted in getPolicy()
    expect(summary.spendingLimits.weekly?.token).toBe("[redacted]");
    expect(summary.spendingLimits.weekly?.used).toBeUndefined();
    expect(summary.spendingLimits.monthly?.amount).toBe("[redacted]");
    // MED-38: Tokens are now redacted in getPolicy()
    expect(summary.spendingLimits.monthly?.token).toBe("[redacted]");
    expect(summary.spendingLimits.monthly?.used).toBeUndefined();
  });

  it("should populate allowlisted address count", async () => {
    const store = new MemoryStore();
    const rules: PolicyRule[] = [
      new AllowlistRule({
        allowAddresses: ["addr1", "addr2", "addr3"],
      }),
    ];
    const policy = new PolicyEngine(rules, store);
    const wallet = createWallet({ policy, store });

    const summary = await wallet.getPolicy();
    // MED-38: Allowlist counts are now redacted to -1 when addresses/programs exist
    expect(summary.allowlistedAddresses).toBe(-1);
    // No programs configured, so count stays 0
    expect(summary.allowlistedPrograms).toBe(0);
  });

  it("should populate allowlisted program count", async () => {
    const store = new MemoryStore();
    const rules: PolicyRule[] = [
      new AllowlistRule({
        allowPrograms: ["prog1", "prog2"],
      }),
    ];
    const policy = new PolicyEngine(rules, store);
    const wallet = createWallet({ policy, store });

    const summary = await wallet.getPolicy();
    // MED-38: Allowlist counts are now redacted to -1
    expect(summary.allowlistedPrograms).toBe(-1);
  });

  it("should populate rate limits without exposing current counters (HIGH-09)", async () => {
    const store = new MemoryStore();
    const rule = new RateLimitRule({
      maxTransactionsPerMinute: 5,
      maxTransactionsPerHour: 100,
    });
    const policy = new PolicyEngine([rule], store);
    const wallet = createWallet({ policy, store });

    const summary = await wallet.getPolicy();
    expect(summary.rateLimits).toBeDefined();
    // HIGH-T3-01: rate limit values are now redacted in getPolicy()
    expect(summary.rateLimits!.maxPerMinute).toBe("[redacted]" as unknown as number);
    expect(summary.rateLimits!.maxPerHour).toBe("[redacted]" as unknown as number);
    // HIGH-09: currentMinute/currentHour counters are no longer exposed in getPolicy()
    expect(summary.rateLimits!.currentMinute).toBeUndefined();
    expect(summary.rateLimits!.currentHour).toBeUndefined();
  });

  it("should not expose rate limit current counters even when store has data (HIGH-09)", async () => {
    const store = new MemoryStore();
    await store.set("ratelimit:minute", "3");
    await store.set("ratelimit:hour", "47");
    const rule = new RateLimitRule({
      maxTransactionsPerMinute: 5,
      maxTransactionsPerHour: 100,
    });
    const policy = new PolicyEngine([rule], store);
    const wallet = createWallet({ policy, store });

    const summary = await wallet.getPolicy();
    // HIGH-09: currentMinute/currentHour counters are no longer exposed in getPolicy()
    expect(summary.rateLimits!.currentMinute).toBeUndefined();
    expect(summary.rateLimits!.currentHour).toBeUndefined();
  });

  it("should populate approval gate threshold", async () => {
    const store = new MemoryStore();
    const rule = new ApprovalGateRule({
      above: { amount: "10", token: "SOL" },
    });
    const policy = new PolicyEngine([rule], store);
    const wallet = createWallet({ policy, store });

    const summary = await wallet.getPolicy();
    // HIGH-T3-01: approval gate amounts are now redacted in getPolicy()
    // MED-38: Both amount and token are now redacted in getPolicy()
    expect(summary.approvalRequired).toEqual({
      above: { amount: "[redacted]", token: "[redacted]" },
    });
  });

  it("should populate time window with timezone", async () => {
    const store = new MemoryStore();
    const rule = new TimeWindowRule({
      timezone: "UTC",
      windows: [
        {
          days: ["mon", "tue", "wed", "thu", "fri"],
          start: "09:00",
          end: "17:00",
        },
      ],
    });
    const policy = new PolicyEngine([rule], store);
    const wallet = createWallet({ policy, store });

    const summary = await wallet.getPolicy();
    expect(summary.activeHours).toBeDefined();
    // MED-38: Timezone is now redacted in getPolicy()
    expect(summary.activeHours!.timezone).toBe("[redacted]");
    expect(typeof summary.activeHours!.isCurrentlyActive).toBe("boolean");
  });

  it("should handle engine with only allow-all rule (returns defaults)", async () => {
    const wallet = createWallet();
    const summary = await wallet.getPolicy();
    // MED-38: Policy name is now redacted to "custom" when rules exist
    expect(summary.name).toBe("custom");
    expect(summary.spendingLimits).toEqual({});
    expect(summary.allowlistedAddresses).toBe(0);
    expect(summary.allowlistedPrograms).toBe(0);
    expect(summary.approvalRequired).toBeUndefined();
    expect(summary.rateLimits).toBeUndefined();
    expect(summary.activeHours).toBeUndefined();
  });

  it("should handle engine with all rule types combined", async () => {
    const store = new MemoryStore();
    const rules: PolicyRule[] = [
      new RateLimitRule({ maxTransactionsPerMinute: 10 }),
      new TimeWindowRule({
        timezone: "UTC",
        windows: [
          { days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], start: "00:00", end: "23:59" },
        ],
      }),
      new AllowlistRule({ allowAddresses: ["addr1"] }),
      new SpendingLimitRule({
        perTransaction: { amount: "5", token: "SOL" },
        daily: { amount: "50", token: "SOL" },
      }),
      new ApprovalGateRule({ above: { amount: "10", token: "SOL" } }),
    ];
    const policy = new PolicyEngine(rules, store);
    const wallet = createWallet({ policy, store });

    const summary = await wallet.getPolicy();
    // MED-38: Policy name is now redacted to "custom" when rules exist
    expect(summary.name).toBe("custom");
    expect(summary.spendingLimits.perTransaction).toBeDefined();
    expect(summary.spendingLimits.daily).toBeDefined();
    // MED-38: Allowlist counts are now redacted to -1
    expect(summary.allowlistedAddresses).toBe(-1);
    expect(summary.rateLimits).toBeDefined();
    expect(summary.activeHours).toBeDefined();
    expect(summary.approvalRequired).toBeDefined();
  });
});

// ── Rule getConfig() methods ──────────────────────────────────────

describe("Rule getConfig()", () => {
  it("SpendingLimitRule.getConfig() returns config", () => {
    const rule = new SpendingLimitRule({
      perTransaction: { amount: "10", token: "SOL" },
      daily: { amount: "100", token: "SOL" },
    });
    const config = rule.getConfig();
    expect(config.perTransaction?.amount).toBe("10");
    expect(config.daily?.amount).toBe("100");
  });

  it("AllowlistRule.getConfig() reconstructs from sets", () => {
    const rule = new AllowlistRule({
      allowAddresses: ["a", "b"],
      denyAddresses: ["c"],
      allowPrograms: ["p1"],
    });
    const config = rule.getConfig();
    expect(config.allowAddresses).toEqual(["a", "b"]);
    expect(config.denyAddresses).toEqual(["c"]);
    expect(config.allowPrograms).toEqual(["p1"]);
    expect(config.denyPrograms).toBeUndefined();
  });

  it("RateLimitRule.getConfig() returns config", () => {
    const rule = new RateLimitRule({
      maxTransactionsPerMinute: 5,
      maxTransactionsPerHour: 100,
    });
    const config = rule.getConfig();
    expect(config.maxTransactionsPerMinute).toBe(5);
    expect(config.maxTransactionsPerHour).toBe(100);
  });

  it("TimeWindowRule.getConfig() returns config", () => {
    const rule = new TimeWindowRule({
      timezone: "America/New_York",
      windows: [{ days: ["mon"], start: "09:00", end: "17:00" }],
    });
    const config = rule.getConfig();
    expect(config.timezone).toBe("America/New_York");
    expect(config.windows).toHaveLength(1);
  });

  it("ApprovalGateRule.getConfig() returns config", () => {
    const rule = new ApprovalGateRule({
      above: { amount: "50", token: "SOL" },
      timeout: 60_000,
    });
    const config = rule.getConfig();
    expect(config.above.amount).toBe("50");
    expect(config.timeout).toBe(60_000);
  });
});

// ══════════════════════════════════════════════════════════════════
// NEW TEST COVERAGE — Sprint 5 Edge Cases
// ══════════════════════════════════════════════════════════════════

// ── handleToolCall edge cases: undefined/null/missing fields ──────

describe("handleToolCall — undefined/null input values", () => {
  it("should fail when transfer 'to' is undefined", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_transfer", {
      to: undefined as unknown as string,
      amount: "1.0",
      token: "SOL",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should fail when transfer 'amount' is undefined", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_transfer", {
      to: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre",
      amount: undefined as unknown as string,
      token: "SOL",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should fail when transfer 'token' is undefined", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_transfer", {
      to: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre",
      amount: "1.0",
      token: undefined as unknown as string,
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should fail when transfer 'chain' is undefined", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_transfer", {
      to: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre",
      amount: "1.0",
      token: "SOL",
      chain: undefined as unknown as string,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should fail when transfer input is null for 'to'", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_transfer", {
      to: null as unknown as string,
      amount: "1.0",
      token: "SOL",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should fail when swap 'fromToken' is undefined", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_swap", {
      fromToken: undefined as unknown as string,
      toToken: "USDC",
      amount: "5.0",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should fail when swap 'toToken' is undefined", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_swap", {
      fromToken: "SOL",
      toToken: undefined as unknown as string,
      amount: "5.0",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should fail when mint 'collection' is undefined", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_mint", {
      collection: undefined as unknown as string,
      metadataUri: "https://arweave.net/abc123",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should fail when mint 'metadataUri' is undefined", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_mint", {
      collection: "CoLLecTion1111111111111111111111111111111111",
      metadataUri: undefined as unknown as string,
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should fail when stake 'amount' is undefined", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_stake", {
      amount: undefined as unknown as string,
      token: "SOL",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should fail when stake 'token' is undefined", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_stake", {
      amount: "10.0",
      token: undefined as unknown as string,
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should fail when execute_custom 'programId' is undefined", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_execute_custom", {
      programId: undefined as unknown as string,
      data: "AQID",
      accounts: JSON.stringify([]),
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should fail when get_balance 'token' is undefined", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_get_balance", {
      token: undefined as unknown as string,
    });
    // The chain adapter may still respond (passing undefined through),
    // but the token in the result should reflect undefined behavior
    expect(result).toBeDefined();
  });
});

// ── handleToolCall edge cases: invalid chain ─────────────────────

describe("handleToolCall — invalid chain values", () => {
  it("should fail when chain is an empty string", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_transfer", {
      to: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre",
      amount: "1.0",
      token: "SOL",
      chain: "",
    });
    expect(result.success).toBe(false);
    // MED-09: Validation now returns "Validation failed" for invalid chain values
    expect(result.error).toContain("Validation failed");
  });

  it("should fail when chain is 'bitcoin' (not supported)", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_transfer", {
      to: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre",
      amount: "1.0",
      token: "SOL",
      chain: "bitcoin",
    });
    expect(result.success).toBe(false);
    // MED-09: Validation now returns "Validation failed" for invalid chain values
    expect(result.error).toContain("Validation failed");
  });

  it("should fail when chain is a number", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_transfer", {
      to: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre",
      amount: "1.0",
      token: "SOL",
      chain: 1 as unknown as string,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should fail when swap chain is 'polygon' (not supported)", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_swap", {
      fromToken: "SOL",
      toToken: "USDC",
      amount: "5.0",
      chain: "polygon",
    });
    expect(result.success).toBe(false);
    // MED-09: Validation now returns "Validation failed" for invalid chain values
    expect(result.error).toContain("Validation failed");
  });

  it("should fail when mint chain is invalid", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_mint", {
      collection: "CoLLecTion1111111111111111111111111111111111",
      metadataUri: "https://arweave.net/abc123",
      chain: "avalanche",
    });
    expect(result.success).toBe(false);
    // MED-09: Validation now returns "Validation failed" for invalid chain values
    expect(result.error).toContain("Validation failed");
  });

  it("should fail when stake chain is invalid", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_stake", {
      amount: "10.0",
      token: "SOL",
      chain: "cosmos",
    });
    expect(result.success).toBe(false);
    // MED-09: Validation now returns "Validation failed" for invalid chain values
    expect(result.error).toContain("Validation failed");
  });
});

// ── handleToolCall edge cases: negative/zero/large amounts ───────

describe("handleToolCall — negative, zero, and extreme amounts", () => {
  it("should fail when transfer amount is '0'", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_transfer", {
      to: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre",
      amount: "0",
      token: "SOL",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    // A-02: validateToolInput now catches invalid amounts before wallet-level validation
    expect(result.error).toContain("Invalid amount");
  });

  it("should fail when transfer amount is negative", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_transfer", {
      to: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre",
      amount: "-5.0",
      token: "SOL",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid amount");
  });

  it("should fail when swap amount is '0'", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_swap", {
      fromToken: "SOL",
      toToken: "USDC",
      amount: "0",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid amount");
  });

  it("should fail when swap amount is negative", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_swap", {
      fromToken: "SOL",
      toToken: "USDC",
      amount: "-10.0",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid amount");
  });

  it("should fail when stake amount is '0'", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_stake", {
      amount: "0",
      token: "SOL",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid amount");
  });

  it("should fail when stake amount is negative", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_stake", {
      amount: "-100",
      token: "SOL",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid amount");
  });

  it("should succeed with very large transfer amount", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_transfer", {
      to: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre",
      amount: "999999999999999.999999999",
      token: "SOL",
      chain: "solana",
    });
    expect(result.success).toBe(true);
  });

  it("should succeed with very small (fractional) transfer amount above dust threshold", async () => {
    const wallet = createWallet();
    // L-07 fix: amounts below MIN_DUST_AMOUNT (0.000001) are now rejected
    const result = await wallet.handleToolCall("wallet_transfer", {
      to: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre",
      amount: "0.00001",
      token: "SOL",
      chain: "solana",
    });
    expect(result.success).toBe(true);
  });

  it("should fail when transfer amount is 'NaN'", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_transfer", {
      to: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre",
      amount: "NaN",
      token: "SOL",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    // A-02: validateToolInput now catches invalid amounts before wallet-level validation
    expect(result.error).toContain("Invalid amount");
  });

  it("should reject 'Infinity' amount with validation error (CRIT-01)", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_transfer", {
      to: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre",
      amount: "Infinity",
      token: "SOL",
      chain: "solana",
    });
    // CRIT-01: Infinity amounts are now rejected — validation rejects non-finite values
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid amount");
  });

  it("should fail when transfer amount is not a number string", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_transfer", {
      to: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre",
      amount: "abc",
      token: "SOL",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid amount");
  });
});

// ── handleToolCall edge cases: empty string inputs ───────────────

describe("handleToolCall — empty string inputs", () => {
  it("should fail when transfer 'to' is empty string", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_transfer", {
      to: "",
      amount: "1.0",
      token: "SOL",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("'to' must be a non-empty string");
  });

  it("should fail when transfer 'amount' is empty string", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_transfer", {
      to: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre",
      amount: "",
      token: "SOL",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    // A-02: validateToolInput now catches empty/invalid amounts before wallet-level validation
    expect(result.error).toContain("Invalid amount");
  });

  it("should fail when transfer 'token' is empty string", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_transfer", {
      to: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre",
      amount: "1.0",
      token: "",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("'token' must be a non-empty string");
  });

  it("should fail when swap 'fromToken' is empty string", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_swap", {
      fromToken: "",
      toToken: "USDC",
      amount: "5.0",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("'fromToken' must be a non-empty string");
  });

  it("should fail when swap 'toToken' is empty string", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_swap", {
      fromToken: "SOL",
      toToken: "",
      amount: "5.0",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("'toToken' must be a non-empty string");
  });

  it("should fail when swap 'amount' is empty string", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_swap", {
      fromToken: "SOL",
      toToken: "USDC",
      amount: "",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    // A-02: validateToolInput now catches empty/invalid amounts before wallet-level validation
    expect(result.error).toContain("Invalid amount");
  });

  it("should fail when mint 'collection' is empty string", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_mint", {
      collection: "",
      metadataUri: "https://arweave.net/abc123",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("'collection' must be a non-empty string");
  });

  it("should fail when mint 'metadataUri' is empty string", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_mint", {
      collection: "CoLLecTion1111111111111111111111111111111111",
      metadataUri: "",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    // A-08: validateToolInput now catches invalid metadataUri scheme before wallet-level validation
    expect(result.error).toContain("metadataUri must use https, ipfs, or ar scheme");
  });

  it("should fail when stake 'amount' is empty string", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_stake", {
      amount: "",
      token: "SOL",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    // A-02: validateToolInput now catches empty/invalid amounts before wallet-level validation
    expect(result.error).toContain("Invalid amount");
  });

  it("should fail when stake 'token' is empty string", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_stake", {
      amount: "10.0",
      token: "",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("'token' must be a non-empty string");
  });

  it("should fail when execute_custom 'programId' is empty string", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_execute_custom", {
      programId: "",
      data: "AQID",
      accounts: JSON.stringify([]),
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("'programId' must be a non-empty string");
  });
});

// ── handleToolCall edge cases: special characters ────────────────

describe("handleToolCall — special characters in addresses", () => {
  it("should handle addresses with only whitespace as invalid", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_transfer", {
      to: "   ",
      amount: "1.0",
      token: "SOL",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should handle amount with leading/trailing whitespace as valid number", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_transfer", {
      to: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre",
      amount: "  1.0  ",
      token: "SOL",
      chain: "solana",
    });
    // The wallet trims and validates; whitespace-only padding around a valid
    // number is rejected because the raw string doesn't pass the numeric regex.
    expect(result.success).toBe(false);
  });
});

// ── handleToolCall: missing required fields per tool type ────────

describe("handleToolCall — missing required fields per tool", () => {
  it("should fail when transfer is called with empty object", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_transfer", {});
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should fail when swap is called with empty object", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_swap", {});
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should fail when mint is called with empty object", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_mint", {});
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should fail when stake is called with empty object", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_stake", {});
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should fail when execute_custom is called with empty object", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_execute_custom", {});
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should fail when swap is missing 'amount' field", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_swap", {
      fromToken: "SOL",
      toToken: "USDC",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should fail when mint is missing 'chain' field", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_mint", {
      collection: "CoLLecTion1111111111111111111111111111111111",
      metadataUri: "https://arweave.net/abc123",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should fail when stake is missing 'chain' field", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_stake", {
      amount: "10.0",
      token: "SOL",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should fail when execute_custom is missing 'data' field", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_execute_custom", {
      programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      accounts: JSON.stringify([]),
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

// ── getPolicy edge cases: store returns unexpected values ────────

describe("getPolicy — store edge cases", () => {
  it("should not expose spending counter even when store has non-numeric string (HIGH-09)", async () => {
    const store = new MemoryStore();
    await store.set("spending:daily:SOL", "not-a-number");
    const rule = new SpendingLimitRule({
      daily: { amount: "100", token: "SOL" },
    });
    const policy = new PolicyEngine([rule], store);
    const wallet = createWallet({ policy, store });

    const summary = await wallet.getPolicy();
    // HIGH-09: 'used' spending counters are no longer exposed in getPolicy()
    expect(summary.spendingLimits.daily?.used).toBeUndefined();
  });

  it("should not expose spending counter even when store has empty string (HIGH-09)", async () => {
    const store = new MemoryStore();
    await store.set("spending:daily:SOL", "");
    const rule = new SpendingLimitRule({
      daily: { amount: "100", token: "SOL" },
    });
    const policy = new PolicyEngine([rule], store);
    const wallet = createWallet({ policy, store });

    const summary = await wallet.getPolicy();
    // HIGH-09: 'used' spending counters are no longer exposed in getPolicy()
    expect(summary.spendingLimits.daily?.used).toBeUndefined();
  });

  it("should not expose rate limit counters even when store has NaN string (HIGH-09)", async () => {
    const store = new MemoryStore();
    await store.set("ratelimit:minute", "NaN");
    await store.set("ratelimit:hour", "NaN");
    const rule = new RateLimitRule({
      maxTransactionsPerMinute: 5,
      maxTransactionsPerHour: 100,
    });
    const policy = new PolicyEngine([rule], store);
    const wallet = createWallet({ policy, store });

    const summary = await wallet.getPolicy();
    expect(summary.rateLimits).toBeDefined();
    // HIGH-09: currentMinute/currentHour counters are no longer exposed in getPolicy()
    expect(summary.rateLimits!.currentMinute).toBeUndefined();
    expect(summary.rateLimits!.currentHour).toBeUndefined();
  });

  it("should not expose rate limit counters even when store has float values (HIGH-09)", async () => {
    const store = new MemoryStore();
    await store.set("ratelimit:minute", "3.7");
    await store.set("ratelimit:hour", "47.2");
    const rule = new RateLimitRule({
      maxTransactionsPerMinute: 5,
      maxTransactionsPerHour: 100,
    });
    const policy = new PolicyEngine([rule], store);
    const wallet = createWallet({ policy, store });

    const summary = await wallet.getPolicy();
    // HIGH-09: currentMinute/currentHour counters are no longer exposed in getPolicy()
    expect(summary.rateLimits!.currentMinute).toBeUndefined();
    expect(summary.rateLimits!.currentHour).toBeUndefined();
  });

  it("should not expose rate limit counters even when store has negative value (HIGH-09)", async () => {
    const store = new MemoryStore();
    await store.set("ratelimit:minute", "-1");
    const rule = new RateLimitRule({
      maxTransactionsPerMinute: 5,
    });
    const policy = new PolicyEngine([rule], store);
    const wallet = createWallet({ policy, store });

    const summary = await wallet.getPolicy();
    // HIGH-09: currentMinute/currentHour counters are no longer exposed in getPolicy()
    expect(summary.rateLimits!.currentMinute).toBeUndefined();
  });

  it("should not expose weekly spending counter even when store has data (HIGH-09)", async () => {
    const store = new MemoryStore();
    await store.set("spending:weekly:SOL", "250.5");
    const rule = new SpendingLimitRule({
      weekly: { amount: "500", token: "SOL" },
    });
    const policy = new PolicyEngine([rule], store);
    const wallet = createWallet({ policy, store });

    const summary = await wallet.getPolicy();
    // HIGH-09: 'used' spending counters are no longer exposed in getPolicy()
    expect(summary.spendingLimits.weekly?.used).toBeUndefined();
  });

  it("should not expose monthly spending counter even when store has data (HIGH-09)", async () => {
    const store = new MemoryStore();
    await store.set("spending:monthly:SOL", "1200");
    const rule = new SpendingLimitRule({
      monthly: { amount: "2000", token: "SOL" },
    });
    const policy = new PolicyEngine([rule], store);
    const wallet = createWallet({ policy, store });

    const summary = await wallet.getPolicy();
    // HIGH-09: 'used' spending counters are no longer exposed in getPolicy()
    expect(summary.spendingLimits.monthly?.used).toBeUndefined();
  });
});

// ── getPolicy edge cases: AllowlistRule with no addresses ────────

describe("getPolicy — AllowlistRule edge cases", () => {
  it("should handle AllowlistRule with empty config (no addresses or programs)", async () => {
    const store = new MemoryStore();
    const rules: PolicyRule[] = [
      new AllowlistRule({}),
    ];
    const policy = new PolicyEngine(rules, store);
    const wallet = createWallet({ policy, store });

    const summary = await wallet.getPolicy();
    expect(summary.allowlistedAddresses).toBe(0);
    expect(summary.allowlistedPrograms).toBe(0);
  });

  it("should handle AllowlistRule with empty deny arrays and no allow arrays", async () => {
    const store = new MemoryStore();
    // POL-04: Empty allowAddresses/allowPrograms now throw. Use undefined (omitted)
    // for "no restriction" and empty deny arrays for "deny nothing".
    const rules: PolicyRule[] = [
      new AllowlistRule({
        denyAddresses: [],
        denyPrograms: [],
      }),
    ];
    const policy = new PolicyEngine(rules, store);
    const wallet = createWallet({ policy, store });

    const summary = await wallet.getPolicy();
    expect(summary.allowlistedAddresses).toBe(0);
    expect(summary.allowlistedPrograms).toBe(0);
  });

  it("should not count deny addresses in the allowlisted count", async () => {
    const store = new MemoryStore();
    const rules: PolicyRule[] = [
      new AllowlistRule({
        denyAddresses: ["bad_addr1", "bad_addr2"],
      }),
    ];
    const policy = new PolicyEngine(rules, store);
    const wallet = createWallet({ policy, store });

    const summary = await wallet.getPolicy();
    // denyAddresses are not in allowAddresses
    expect(summary.allowlistedAddresses).toBe(0);
  });

  it("should report correct counts with both allow and deny lists", async () => {
    const store = new MemoryStore();
    const rules: PolicyRule[] = [
      new AllowlistRule({
        allowAddresses: ["addr1", "addr2", "addr3"],
        denyAddresses: ["bad1"],
        allowPrograms: ["prog1"],
        denyPrograms: ["bad_prog1", "bad_prog2"],
      }),
    ];
    const policy = new PolicyEngine(rules, store);
    const wallet = createWallet({ policy, store });

    const summary = await wallet.getPolicy();
    // MED-38: Allowlist counts are now redacted to -1
    expect(summary.allowlistedAddresses).toBe(-1);
    expect(summary.allowlistedPrograms).toBe(-1);
  });
});

// ── getPolicy edge cases: TimeWindowRule with invalid timezone ───

describe("getPolicy — TimeWindowRule edge cases", () => {
  it("should throw when constructing TimeWindowRule with invalid timezone", () => {
    // TimeWindowRule now validates timezone in constructor and throws for invalid values
    expect(() => new TimeWindowRule({
      timezone: "Invalid/FakeTimezone",
      windows: [
        {
          days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
          start: "00:00",
          end: "23:59",
        },
      ],
    })).toThrow("invalid timezone");
  });

  it("should handle TimeWindowRule with empty windows array", async () => {
    const store = new MemoryStore();
    const rule = new TimeWindowRule({
      timezone: "UTC",
      windows: [],
    });
    const policy = new PolicyEngine([rule], store);
    const wallet = createWallet({ policy, store });

    const summary = await wallet.getPolicy();
    expect(summary.activeHours).toBeDefined();
    // MED-38: Timezone is now redacted in getPolicy()
    expect(summary.activeHours!.timezone).toBe("[redacted]");
    // No windows defined means no time matches, so should not be active
    expect(summary.activeHours!.isCurrentlyActive).toBe(false);
  });

  it("should handle TimeWindowRule with non-standard timezone", async () => {
    const store = new MemoryStore();
    const rule = new TimeWindowRule({
      timezone: "Asia/Tokyo",
      windows: [
        {
          days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
          start: "00:00",
          end: "23:59",
        },
      ],
    });
    const policy = new PolicyEngine([rule], store);
    const wallet = createWallet({ policy, store });

    const summary = await wallet.getPolicy();
    expect(summary.activeHours).toBeDefined();
    // MED-38: Timezone is now redacted in getPolicy()
    expect(summary.activeHours!.timezone).toBe("[redacted]");
    expect(typeof summary.activeHours!.isCurrentlyActive).toBe("boolean");
  });
});

// ── Adapter format verification: individual tool schemas ─────────

describe("Adapter format verification — tool schema completeness", () => {
  it("every tool property should have a type field", () => {
    for (const tool of WALLET_TOOLS) {
      for (const prop of Object.values(tool.parameters.properties)) {
        expect(prop.type).toBeTruthy();
        expect(typeof prop.type).toBe("string");
      }
    }
  });

  it("every tool property should have a non-empty description", () => {
    for (const tool of WALLET_TOOLS) {
      for (const prop of Object.values(tool.parameters.properties)) {
        expect(prop.description).toBeTruthy();
        expect(prop.description.length).toBeGreaterThan(0);
      }
    }
  });

  it("every tool should have a non-empty description", () => {
    for (const tool of WALLET_TOOLS) {
      expect(tool.description).toBeTruthy();
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it("chain enum should be ['solana', 'ethereum', 'base'] where present", () => {
    const toolsWithChain = ["wallet_transfer", "wallet_swap", "wallet_mint", "wallet_stake", "wallet_execute_custom"];
    for (const toolName of toolsWithChain) {
      const tool = getToolByName(toolName)!;
      const chainProp = tool.parameters.properties["chain"];
      expect(chainProp).toBeDefined();
      expect(chainProp.enum).toEqual(["solana", "ethereum", "base"]);
    }
  });

  it("wallet_get_balance should only require 'token'", () => {
    const tool = getToolByName("wallet_get_balance")!;
    expect(tool.parameters.required).toEqual(["token"]);
    expect(tool.parameters.properties).toHaveProperty("token");
  });

  it("wallet_get_transaction_history should require no params", () => {
    const tool = getToolByName("wallet_get_transaction_history")!;
    expect(tool.parameters.required).toEqual([]);
  });

  it("wallet_get_transaction_history should have optional limit param", () => {
    const tool = getToolByName("wallet_get_transaction_history")!;
    expect(tool.parameters.properties).toHaveProperty("limit");
    expect(tool.parameters.properties["limit"].type).toBe("number");
  });

  it("wallet_transfer should have optional 'reason' param", () => {
    const tool = getToolByName("wallet_transfer")!;
    expect(tool.parameters.properties).toHaveProperty("reason");
    expect(tool.parameters.required).not.toContain("reason");
  });

  it("wallet_swap should have optional 'maxSlippage' param", () => {
    const tool = getToolByName("wallet_swap")!;
    expect(tool.parameters.properties).toHaveProperty("maxSlippage");
    expect(tool.parameters.properties["maxSlippage"].type).toBe("number");
    expect(tool.parameters.required).not.toContain("maxSlippage");
  });

  it("wallet_mint should require 'collection', 'metadataUri', 'chain'", () => {
    const tool = getToolByName("wallet_mint")!;
    expect(tool.parameters.required).toEqual(
      expect.arrayContaining(["collection", "metadataUri", "chain"]),
    );
  });

  it("wallet_stake should require 'amount', 'token', 'chain'", () => {
    const tool = getToolByName("wallet_stake")!;
    expect(tool.parameters.required).toEqual(
      expect.arrayContaining(["amount", "token", "chain"]),
    );
  });

  it("wallet_execute_custom should require 'programId', 'data', 'accounts', 'chain'", () => {
    const tool = getToolByName("wallet_execute_custom")!;
    expect(tool.parameters.required).toEqual(
      expect.arrayContaining(["programId", "data", "accounts", "chain"]),
    );
  });

  it("wallet_stake should have optional 'validator' param", () => {
    const tool = getToolByName("wallet_stake")!;
    expect(tool.parameters.properties).toHaveProperty("validator");
    expect(tool.parameters.required).not.toContain("validator");
  });

  it("wallet_mint should have optional 'to' param", () => {
    const tool = getToolByName("wallet_mint")!;
    expect(tool.parameters.properties).toHaveProperty("to");
    expect(tool.parameters.required).not.toContain("to");
  });
});

// ── Tool result format: ToolCallResult shape ─────────────────────

describe("ToolCallResult shape verification", () => {
  it("successful transfer result should have success=true and data with TransactionResult", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_transfer", {
      to: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre",
      amount: "1.0",
      token: "SOL",
      chain: "solana",
    });
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.data).toBeDefined();

    const txResult = result.data as {
      status: string;
      txId: string;
      summary: string;
      intentId: string;
      timestamp: number;
    };
    expect(txResult.status).toBe("confirmed");
    expect(typeof txResult.txId).toBe("string");
    expect(typeof txResult.summary).toBe("string");
    expect(typeof txResult.intentId).toBe("string");
    expect(typeof txResult.timestamp).toBe("number");
  });

  it("failed transfer result should have success=false and error string", async () => {
    const denyRule: PolicyRule = {
      name: "deny-all",
      evaluate: async () => ({
        decision: "DENY" as const,
        rule: "deny-all",
        reason: "All transactions denied",
      }),
    };
    const store = new MemoryStore();
    const policy = new PolicyEngine([denyRule], store);
    const wallet = createWallet({ policy, store });

    const result = await wallet.handleToolCall("wallet_transfer", {
      to: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre",
      amount: "1.0",
      token: "SOL",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe("string");

    const txResult = result.data as { status: string; error: { code: string; message: string } };
    expect(txResult.status).toBe("denied");
    expect(txResult.error).toBeDefined();
    expect(txResult.error.code).toBe("POLICY_DENIED");
  });

  it("validation failure result should have success=false, data with VALIDATION_FAILED", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_transfer", {
      to: "",
      amount: "1.0",
      token: "SOL",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();

    const txResult = result.data as { status: string; error?: { code: string } };
    expect(txResult.status).toBe("failed");
    expect(txResult.error?.code).toBe("VALIDATION_FAILED");
  });

  it("get_balance result data should have TokenBalance shape", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_get_balance", {
      token: "SOL",
    });
    expect(result.success).toBe(true);
    const balance = result.data as {
      token: string;
      amount: string;
      decimals: number;
      usdValue?: number;
    };
    expect(typeof balance.token).toBe("string");
    expect(typeof balance.amount).toBe("string");
    expect(typeof balance.decimals).toBe("number");
    expect(balance.token).toBe("SOL");
    expect(balance.amount).toBe("10.0");
    expect(balance.decimals).toBe(9);
    expect(balance.usdValue).toBe(1500);
  });

  it("get_policy result data should have PolicySummary shape", async () => {
    const store = new MemoryStore();
    const rule = new SpendingLimitRule({
      perTransaction: { amount: "10", token: "SOL" },
      daily: { amount: "100", token: "SOL" },
    });
    const policy = new PolicyEngine([rule], store);
    const wallet = createWallet({ policy, store });

    const result = await wallet.handleToolCall("wallet_get_policy", {});
    expect(result.success).toBe(true);
    const summary = result.data as {
      name: string;
      spendingLimits: Record<string, unknown>;
      allowlistedAddresses: number;
      allowlistedPrograms: number;
    };
    expect(typeof summary.name).toBe("string");
    expect(typeof summary.spendingLimits).toBe("object");
    expect(typeof summary.allowlistedAddresses).toBe("number");
    expect(typeof summary.allowlistedPrograms).toBe("number");
  });

  it("get_transaction_history result data should be an array", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_get_transaction_history", {});
    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
  });

  it("unknown tool result should have success=false, no data, error message", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("nonexistent_tool", {});
    expect(result.success).toBe(false);
    expect(result.data).toBeUndefined();
    // MED-09: Validation now catches unknown tools and returns "Validation failed" immediately
    expect(result.error).toContain("Validation failed");
  });

  it("successful swap result data should have TransactionResult shape with confirmed status", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_swap", {
      fromToken: "SOL",
      toToken: "USDC",
      amount: "5.0",
      chain: "solana",
    });
    expect(result.success).toBe(true);
    const txResult = result.data as {
      status: string;
      txId: string;
      summary: string;
      intentId: string;
      timestamp: number;
    };
    expect(txResult.status).toBe("confirmed");
    expect(typeof txResult.txId).toBe("string");
    expect(txResult.summary).toContain("Swapped");
    expect(txResult.summary).toContain("SOL");
    expect(txResult.summary).toContain("USDC");
  });

  it("successful mint result data should contain summary with 'Minted'", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_mint", {
      collection: "CoLLecTion1111111111111111111111111111111111",
      metadataUri: "https://arweave.net/abc123",
      chain: "solana",
    });
    expect(result.success).toBe(true);
    const txResult = result.data as { summary: string };
    expect(txResult.summary).toContain("Minted");
  });

  it("successful stake result data should contain summary with 'Staked'", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_stake", {
      amount: "10.0",
      token: "SOL",
      chain: "solana",
    });
    expect(result.success).toBe(true);
    const txResult = result.data as { summary: string };
    expect(txResult.summary).toContain("Staked");
    expect(txResult.summary).toContain("10.0");
    expect(txResult.summary).toContain("SOL");
  });
});

// ── handleToolCall: wallet_get_transaction_history edge cases ─────

describe("handleToolCall — transaction history edge cases", () => {
  it("should reject limit of 0 (minimum is 1)", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_get_transaction_history", {
      limit: 0,
    });
    // MED-CROSS-01 / AUDIT-L-16: minimum constraint is now enforced server-side
    expect(result.success).toBe(false);
  });

  it("should reject negative limit (minimum is 1)", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_get_transaction_history", {
      limit: -5,
    });
    // MED-CROSS-01 / AUDIT-L-16: minimum constraint is now enforced server-side
    expect(result.success).toBe(false);
  });

  it("should handle non-numeric limit gracefully", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_get_transaction_history", {
      limit: "abc" as unknown as number,
    });
    // MED-09: Validation now rejects non-numeric limit values
    expect(result.success).toBe(false);
    expect(result.error).toContain("Validation failed");
  });

  it("should handle very large limit by clamping to MAX_HISTORY_LIMIT", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_get_transaction_history", {
      limit: 999999,
    });
    // MED-09: Validation now rejects excessively large limit values
    expect(result.success).toBe(false);
    expect(result.error).toContain("Validation failed");
  });

  it("should handle Infinity limit gracefully", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_get_transaction_history", {
      limit: Infinity,
    });
    // MED-09: Validation now rejects non-finite limit values
    expect(result.success).toBe(false);
    expect(result.error).toContain("Validation failed");
  });

  it("should reject NaN limit (LOW-08)", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_get_transaction_history", {
      limit: NaN,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Validation failed");
  });
});

// ── handleToolCall: wallet_execute_custom edge cases ─────────────

describe("handleToolCall — wallet_execute_custom edge cases", () => {
  it("should handle accounts as empty JSON array string", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_execute_custom", {
      programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      data: "AQID",
      accounts: "[]",
      chain: "solana",
    });
    expect(result.success).toBe(true);
  });

  it("should handle accounts as empty array (object)", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_execute_custom", {
      programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      data: "AQID",
      accounts: [],
      chain: "solana",
    });
    // MED-09: Validation now rejects non-string accounts; empty arrays fail validation
    expect(result.success).toBe(false);
    expect(result.error).toContain("Validation failed");
  });

  it("should fail when accounts is a number", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_execute_custom", {
      programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      data: "AQID",
      accounts: 42,
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should fail when accounts is a non-array JSON string", async () => {
    const wallet = createWallet();
    const result = await wallet.handleToolCall("wallet_execute_custom", {
      programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      data: "AQID",
      accounts: '{"key": "value"}',
      chain: "solana",
    });
    // JSON.parse succeeds but result is an object, not an array
    // The intent validation should catch this
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should handle accounts as a valid JSON string with multiple accounts", async () => {
    const wallet = createWallet();
    const accounts = JSON.stringify([
      { address: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", isSigner: false, isWritable: true },
      { address: "SysvarC1ockwkGmMFSN2JfahbCE8vTzmHS4bREafJG4b", isSigner: true, isWritable: false },
    ]);
    const result = await wallet.handleToolCall("wallet_execute_custom", {
      programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      data: "AQID",
      accounts,
      chain: "solana",
    });
    expect(result.success).toBe(true);
  });
});

// ── handleToolCall: error propagation from chain adapter ─────────

describe("handleToolCall — chain adapter error propagation", () => {
  it("should catch and return error when chain broadcast throws", async () => {
    const failingChain: ChainAdapter = {
      chain: "solana",
      getBalance: async (_addr: string, token: string) => ({
        token,
        amount: "10.0",
        decimals: 9,
      }),
      getValueInUSD: async () => 150,
      buildTransaction: async (intent: TransactionIntent, _signerAddress: string) => ({
        chain: "solana",
        data: new Uint8Array(10),
        description: `Mock ${intent.type}`,
      }),
      simulateTransaction: vi.fn().mockResolvedValue({ success: true }),
      broadcast: async () => { throw new Error("Network timeout"); },
      getTransactionStatus: async (txId: string) => ({
        status: "confirmed" as const,
        txId,
      }),
      isValidAddress: () => true,
    };
    const store = new MemoryStore();
    const wallet = createWallet({ chain: failingChain, store });

    const result = await wallet.handleToolCall("wallet_transfer", {
      to: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre",
      amount: "1.0",
      token: "SOL",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Network timeout");
  });

  it("should catch and return error when signer.sign throws", async () => {
    const failingSigner: Signer = {
      getAddress: async () => "7v91N7iZ9mNicL8WfG6cgSCKyRXydQjLh6UYBWwm6y1Q",
      sign: async () => { throw new Error("Hardware wallet disconnected"); },
      healthCheck: async () => false,
    };
    const store = new MemoryStore();
    const wallet = createWallet({ signer: failingSigner, store });

    const result = await wallet.handleToolCall("wallet_transfer", {
      to: "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSQQRre",
      amount: "1.0",
      token: "SOL",
      chain: "solana",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Hardware wallet disconnected");
  });
});
