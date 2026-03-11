import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { SolanaAdapter } from "../../../src/chains/solana/adapter.js";

/**
 * SolanaAdapter unit tests.
 *
 * Tests here cover constructor behavior, address validation, and error paths
 * that don't require a live RPC connection.
 *
 * Methods requiring RPC (getBalance for valid addresses, buildTransaction
 * for transfers, broadcast, getTransactionStatus) are tested via:
 * - Helper module unit tests (utils.test.ts)
 * - Devnet integration tests (tests/integration/)
 */
describe("SolanaAdapter", () => {
  const defaultConfig = { rpcUrl: "https://api.devnet.solana.com" };

  // ── Constructor ──────────────────────────────────────────────────

  it("should instantiate without errors", () => {
    const adapter = new SolanaAdapter(defaultConfig);
    expect(adapter).toBeDefined();
  });

  it("should report chain as 'solana'", () => {
    const adapter = new SolanaAdapter(defaultConfig);
    expect(adapter.chain).toBe("solana");
  });

  it("should accept config with commitment level", () => {
    const adapter = new SolanaAdapter({
      rpcUrl: "https://api.mainnet-beta.solana.com",
      commitment: "finalized",
    });
    expect(adapter).toBeDefined();
  });

  it("should accept config with price provider", () => {
    const adapter = new SolanaAdapter({
      ...defaultConfig,
      priceProvider: async () => 100,
    });
    expect(adapter).toBeDefined();
  });

  it("should accept all config options at once", () => {
    const adapter = new SolanaAdapter({
      rpcUrl: "https://api.devnet.solana.com",
      commitment: "confirmed",
      priceProvider: async () => 100,
    });
    expect(adapter).toBeDefined();
    expect(adapter.chain).toBe("solana");
  });

  // ── isValidAddress ──────────────────────────────────────────────────

  describe("isValidAddress", () => {
    const adapter = new SolanaAdapter(defaultConfig);

    it("should validate the System Program address", () => {
      expect(adapter.isValidAddress("11111111111111111111111111111111")).toBe(true);
    });

    it("should validate a 44-character base58 address", () => {
      expect(adapter.isValidAddress("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU")).toBe(true);
    });

    it("should validate a generated keypair address", () => {
      const kp = Keypair.generate();
      expect(adapter.isValidAddress(kp.publicKey.toBase58())).toBe(true);
    });

    it("should validate the Token Program address", () => {
      expect(adapter.isValidAddress("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")).toBe(true);
    });

    it("should reject empty string", () => {
      expect(adapter.isValidAddress("")).toBe(false);
    });

    it("should reject Ethereum-style addresses", () => {
      expect(adapter.isValidAddress("0x742d35Cc6634C0532925a3b844Bc9e7595f2bD08")).toBe(false);
    });

    it("should reject addresses with special characters", () => {
      expect(adapter.isValidAddress("abc+def/ghi=jklmnopqrstuvwxyz1234")).toBe(false);
    });

    it("should reject very short strings", () => {
      expect(adapter.isValidAddress("abc")).toBe(false);
    });

    it("should reject null-like values", () => {
      expect(adapter.isValidAddress("null")).toBe(false);
      expect(adapter.isValidAddress("undefined")).toBe(false);
    });

    it("should validate multiple generated addresses", () => {
      for (let i = 0; i < 10; i++) {
        const kp = Keypair.generate();
        expect(adapter.isValidAddress(kp.publicKey.toBase58())).toBe(true);
      }
    });

    it("should reject Bitcoin-style addresses", () => {
      expect(adapter.isValidAddress("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).toBe(false);
    });

    it("should reject whitespace-only strings", () => {
      expect(adapter.isValidAddress("   ")).toBe(false);
      expect(adapter.isValidAddress("\t\n")).toBe(false);
    });

    it("should reject strings with leading/trailing spaces around valid address", () => {
      const kp = Keypair.generate();
      const paddedAddr = ` ${kp.publicKey.toBase58()} `;
      expect(adapter.isValidAddress(paddedAddr)).toBe(false);
    });

    it("should reject addresses containing invalid base58 characters (0, O, I, l)", () => {
      // Base58 excludes 0, O, I, l — craft a string with those
      expect(adapter.isValidAddress("0OIl" + "1".repeat(28))).toBe(false);
    });

    it("should reject very long random strings", () => {
      const longString = "A".repeat(200);
      expect(adapter.isValidAddress(longString)).toBe(false);
    });

    it("should reject numeric-only non-address string", () => {
      expect(adapter.isValidAddress("12345")).toBe(false);
    });
  });

  // ── getValueInUSD stablecoin fallback ──────────────────────────────────

  // CRIT-CROSS-02 fix: Stablecoin fallback removed. All tokens now fail-closed
  // when the price oracle is unavailable, including USDC/USDT.
  describe("getValueInUSD fail-closed behavior", () => {
    it("should throw for USDC when price API is down (no stablecoin fallback)", async () => {
      const adapter = new SolanaAdapter(defaultConfig);
      await expect(adapter.getValueInUSD("USDC", "50.0")).rejects.toThrow(
        "No price provider configured",
      );
    });

    it("should throw for USDT when price API is down (no stablecoin fallback)", async () => {
      const adapter = new SolanaAdapter(defaultConfig);
      await expect(adapter.getValueInUSD("USDT", "25.0")).rejects.toThrow(
        "No price provider configured",
      );
    });

    it("should throw for case-insensitive stablecoin names when price API is down", async () => {
      const adapter = new SolanaAdapter(defaultConfig);
      await expect(adapter.getValueInUSD("usdc", "100.0")).rejects.toThrow(
        "No price provider configured",
      );
    });

    it("should throw for non-stablecoin when price API is down", async () => {
      const adapter = new SolanaAdapter(defaultConfig);
      await expect(adapter.getValueInUSD("SOL", "1.0")).rejects.toThrow(
        "No price provider configured",
      );
    });

    it("should throw for unknown token", async () => {
      const adapter = new SolanaAdapter(defaultConfig);
      await expect(adapter.getValueInUSD("UNKNOWN_TOKEN", "1.0")).rejects.toThrow();
    });

    it("should throw for USDC with zero amount when price API is down", async () => {
      const adapter = new SolanaAdapter(defaultConfig);
      await expect(adapter.getValueInUSD("USDC", "0")).rejects.toThrow(
        "No price provider configured",
      );
    });

    it("should throw for USDT with zero amount when price API is down", async () => {
      const adapter = new SolanaAdapter(defaultConfig);
      await expect(adapter.getValueInUSD("USDT", "0")).rejects.toThrow(
        "No price provider configured",
      );
    });

    it("should throw for large USDC amount when price API is down", async () => {
      const adapter = new SolanaAdapter(defaultConfig);
      await expect(adapter.getValueInUSD("USDC", "999999999.99")).rejects.toThrow(
        "No price provider configured",
      );
    });

    it("should throw for empty string amount with stablecoin when price API is down", async () => {
      const adapter = new SolanaAdapter(defaultConfig);
      await expect(adapter.getValueInUSD("USDC", "")).rejects.toThrow(
        "No price provider configured",
      );
    });

    it("should throw for fractional stablecoin amounts when price API is down", async () => {
      const adapter = new SolanaAdapter(defaultConfig);
      await expect(adapter.getValueInUSD("USDC", "0.01")).rejects.toThrow(
        "No price provider configured",
      );
    });
  });

  // ── buildTransaction error cases ──────────────────────────────────

  describe("buildTransaction unsupported types", () => {
    const adapter = new SolanaAdapter(defaultConfig);

    it("should throw for mint intent type", async () => {
      const intent = {
        type: "mint" as const,
        chain: "solana" as const,
        params: { collection: "Col123", metadataUri: "https://example.com/meta.json" },
      };
      await expect(
        adapter.buildTransaction(intent, Keypair.generate().publicKey.toBase58()),
      ).rejects.toThrow("not supported");
    });

    it("should throw for stake intent type", async () => {
      const intent = {
        type: "stake" as const,
        chain: "solana" as const,
        params: { amount: "10", token: "SOL" },
      };
      await expect(
        adapter.buildTransaction(intent, Keypair.generate().publicKey.toBase58()),
      ).rejects.toThrow("not supported");
    });

    it("should throw for custom intent type", async () => {
      const intent = {
        type: "custom" as const,
        chain: "solana" as const,
        params: { programId: "Prog123", data: "base64", accounts: [] },
      };
      await expect(
        adapter.buildTransaction(intent, Keypair.generate().publicKey.toBase58()),
      ).rejects.toThrow("not supported");
    });

    it("should include supported types in error message", async () => {
      const intent = {
        type: "mint" as const,
        chain: "solana" as const,
        params: { collection: "Col123", metadataUri: "https://example.com/meta.json" },
      };
      await expect(
        adapter.buildTransaction(intent, Keypair.generate().publicKey.toBase58()),
      ).rejects.toThrow("Supported: transfer");
    });
  });

  // ── getBalance error cases ──────────────────────────────────

  describe("getBalance error cases", () => {
    const adapter = new SolanaAdapter(defaultConfig);

    it("should throw for invalid address", async () => {
      await expect(adapter.getBalance("invalid", "SOL")).rejects.toThrow(
        "Invalid Solana address",
      );
    });

    it("should throw for empty address", async () => {
      await expect(adapter.getBalance("", "SOL")).rejects.toThrow(
        "Invalid Solana address",
      );
    });

    it("should throw for unknown SPL token", async () => {
      const kp = Keypair.generate();
      await expect(
        adapter.getBalance(kp.publicKey.toBase58(), "UNKNOWN_TOKEN"),
      ).rejects.toThrow("Unknown token");
    });
  });
});
