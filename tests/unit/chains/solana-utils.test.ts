import { describe, it, expect } from "vitest";
import { PublicKey, Keypair } from "@solana/web3.js";
import {
  isNativeSOL,
  resolveTokenMint,
  getTokenDecimals,
  toSmallestUnit,
  fromSmallestUnit,
  isValidSolanaAddress,
  deriveATA,
  SolanaAdapterError,
  isDevnetUrl,
  TOKEN_MINTS,
  DEVNET_TOKEN_MINTS,
} from "../../../src/chains/solana/utils.js";

describe("Solana Utils", () => {
  // ── isNativeSOL ──────────────────────────────────────────────────

  describe("isNativeSOL", () => {
    it("should return true for 'SOL'", () => {
      expect(isNativeSOL("SOL")).toBe(true);
    });

    it("should be case-insensitive", () => {
      expect(isNativeSOL("sol")).toBe(true);
      expect(isNativeSOL("Sol")).toBe(true);
      expect(isNativeSOL("sOl")).toBe(true);
    });

    it("should return false for other tokens", () => {
      expect(isNativeSOL("USDC")).toBe(false);
      expect(isNativeSOL("USDT")).toBe(false);
      expect(isNativeSOL("")).toBe(false);
    });
  });

  // ── resolveTokenMint ──────────────────────────────────────────────────

  describe("resolveTokenMint", () => {
    it("should resolve SOL to the wrapped SOL mint", () => {
      const mint = resolveTokenMint("SOL");
      expect(mint).not.toBeNull();
      expect(mint!.toBase58()).toBe("So11111111111111111111111111111111111111112");
    });

    it("should resolve USDC to mainnet mint by default", () => {
      const mint = resolveTokenMint("USDC");
      expect(mint).not.toBeNull();
      expect(mint!.toBase58()).toBe(TOKEN_MINTS["USDC"]!.mint);
    });

    it("should resolve USDC to devnet mint when isDevnet is true", () => {
      const mint = resolveTokenMint("USDC", true);
      expect(mint).not.toBeNull();
      expect(mint!.toBase58()).toBe(DEVNET_TOKEN_MINTS["USDC"]!.mint);
    });

    it("should be case-insensitive for symbol lookup", () => {
      const upper = resolveTokenMint("SOL");
      const lower = resolveTokenMint("sol");
      expect(upper!.toBase58()).toBe(lower!.toBase58());
    });

    it("should parse raw base58 mint addresses", () => {
      const kp = Keypair.generate();
      const mint = resolveTokenMint(kp.publicKey.toBase58());
      expect(mint).not.toBeNull();
      expect(mint!.toBase58()).toBe(kp.publicKey.toBase58());
    });

    it("should return null for invalid strings", () => {
      expect(resolveTokenMint("INVALID_TOKEN_NAME_1234")).toBeNull();
      expect(resolveTokenMint("")).toBeNull();
    });

    it("should return null for whitespace-only string", () => {
      expect(resolveTokenMint("   ")).toBeNull();
      expect(resolveTokenMint("\t")).toBeNull();
      expect(resolveTokenMint("\n")).toBeNull();
    });

    it("should return null for empty string", () => {
      // Already tested above, but explicitly testing the empty-string path
      expect(resolveTokenMint("")).toBeNull();
    });
  });

  // ── getTokenDecimals ──────────────────────────────────────────────────

  describe("getTokenDecimals", () => {
    it("should return 9 for SOL", () => {
      expect(getTokenDecimals("SOL")).toBe(9);
    });

    it("should return 6 for USDC", () => {
      expect(getTokenDecimals("USDC")).toBe(6);
    });

    it("should return 6 for USDT", () => {
      expect(getTokenDecimals("USDT")).toBe(6);
    });

    it("should return null for unknown tokens", () => {
      expect(getTokenDecimals("UNKNOWN")).toBeNull();
    });

    it("should be case-insensitive", () => {
      expect(getTokenDecimals("sol")).toBe(9);
      expect(getTokenDecimals("usdc")).toBe(6);
    });

    it("should use devnet registry when specified", () => {
      expect(getTokenDecimals("USDC", true)).toBe(6);
      // USDT is not in devnet registry
      expect(getTokenDecimals("USDT", true)).toBeNull();
    });
  });

  // ── toSmallestUnit ──────────────────────────────────────────────────

  describe("toSmallestUnit", () => {
    it("should convert whole numbers", () => {
      expect(toSmallestUnit("1", 9)).toBe(1_000_000_000n);
      expect(toSmallestUnit("5", 6)).toBe(5_000_000n);
    });

    it("should convert decimal amounts", () => {
      expect(toSmallestUnit("1.5", 9)).toBe(1_500_000_000n);
      expect(toSmallestUnit("0.1", 9)).toBe(100_000_000n);
    });

    it("should handle precision correctly (no floating point errors)", () => {
      // This is the critical test: 0.1 * 1e9 = 99999999.99999999 in float
      // But string-based conversion should give exactly 100000000
      expect(toSmallestUnit("0.1", 9)).toBe(100_000_000n);
      expect(toSmallestUnit("0.000001", 6)).toBe(1n);
    });

    it("should reject zero amounts", () => {
      expect(() => toSmallestUnit("0", 9)).toThrow("Amount must be positive");
      expect(() => toSmallestUnit("0.0", 6)).toThrow("Amount must be positive");
    });

    it("should truncate excess decimal places", () => {
      // "1.123456789012" with 9 decimals should truncate to 1.123456789
      expect(toSmallestUnit("1.123456789012", 9)).toBe(1_123_456_789n);
    });

    it("should pad short decimal places", () => {
      expect(toSmallestUnit("1.5", 6)).toBe(1_500_000n);
    });

    it("should handle very large amounts", () => {
      // 1 billion SOL in lamports
      expect(toSmallestUnit("1000000000", 9)).toBe(1_000_000_000_000_000_000n);
    });

    it("should reject amounts with no whole part (leading dot)", () => {
      expect(() => toSmallestUnit(".5", 9)).toThrow("Invalid amount");
      expect(() => toSmallestUnit(".1", 6)).toThrow("Invalid amount");
    });

    it("should reject negative string amounts", () => {
      expect(() => toSmallestUnit("-1", 9)).toThrow("Invalid amount");
    });

    it("should handle amount with zero decimals", () => {
      // When decimals = 0, no fractional part is appended
      expect(toSmallestUnit("42", 0)).toBe(42n);
      expect(toSmallestUnit("42.99", 0)).toBe(42n);
    });

    it("should handle very precise fractional amounts for USDC (6 decimals)", () => {
      expect(toSmallestUnit("0.000001", 6)).toBe(1n);
      expect(toSmallestUnit("999999.999999", 6)).toBe(999_999_999_999n);
    });
  });

  // ── fromSmallestUnit ──────────────────────────────────────────────────

  describe("fromSmallestUnit", () => {
    it("should convert whole SOL amounts", () => {
      expect(fromSmallestUnit(5_000_000_000n, 9)).toBe("5");
    });

    it("should convert fractional amounts", () => {
      expect(fromSmallestUnit(1_500_000_000n, 9)).toBe("1.5");
    });

    it("should handle zero", () => {
      expect(fromSmallestUnit(0n, 9)).toBe("0");
    });

    it("should strip trailing zeros", () => {
      expect(fromSmallestUnit(1_000_000n, 6)).toBe("1");
      expect(fromSmallestUnit(1_100_000n, 6)).toBe("1.1");
    });

    it("should round-trip with toSmallestUnit", () => {
      const original = "3.14159";
      const smallest = toSmallestUnit(original, 9);
      // The round-trip might not be exact for all decimals but should work for this
      const back = fromSmallestUnit(smallest, 9);
      expect(back).toBe("3.14159");
    });

    it("should handle amounts less than 1", () => {
      expect(fromSmallestUnit(100_000_000n, 9)).toBe("0.1");
      expect(fromSmallestUnit(1n, 6)).toBe("0.000001");
    });

    it("should handle very large bigint values", () => {
      // 1 billion SOL = 1e18 lamports
      expect(fromSmallestUnit(1_000_000_000_000_000_000n, 9)).toBe("1000000000");
    });

    it("should handle 1 lamport (smallest SOL unit)", () => {
      expect(fromSmallestUnit(1n, 9)).toBe("0.000000001");
    });

    it("should handle zero decimals", () => {
      expect(fromSmallestUnit(42n, 0)).toBe("42");
    });

    it("should round-trip for edge-case amounts", () => {
      // max precision for 6 decimals
      const original = "0.000001";
      const smallest = toSmallestUnit(original, 6);
      expect(smallest).toBe(1n);
      const back = fromSmallestUnit(smallest, 6);
      expect(back).toBe("0.000001");
    });
  });

  // ── isValidSolanaAddress ──────────────────────────────────────────────────

  describe("isValidSolanaAddress", () => {
    it("should accept a generated keypair address", () => {
      const kp = Keypair.generate();
      expect(isValidSolanaAddress(kp.publicKey.toBase58())).toBe(true);
    });

    it("should accept the System Program address", () => {
      expect(isValidSolanaAddress("11111111111111111111111111111111")).toBe(true);
    });

    it("should reject empty string", () => {
      expect(isValidSolanaAddress("")).toBe(false);
    });

    it("should reject non-string inputs", () => {
      expect(isValidSolanaAddress(null as unknown as string)).toBe(false);
      expect(isValidSolanaAddress(undefined as unknown as string)).toBe(false);
    });

    it("should reject invalid base58", () => {
      expect(isValidSolanaAddress("0xInvalidAddress")).toBe(false);
    });
  });

  // ── deriveATA ──────────────────────────────────────────────────

  describe("deriveATA", () => {
    it("should derive a deterministic ATA address", () => {
      const wallet = Keypair.generate().publicKey;
      const mint = new PublicKey(TOKEN_MINTS["USDC"]!.mint);

      const ata1 = deriveATA(wallet, mint);
      const ata2 = deriveATA(wallet, mint);

      expect(ata1.toBase58()).toBe(ata2.toBase58());
    });

    it("should derive different ATAs for different wallets", () => {
      const wallet1 = Keypair.generate().publicKey;
      const wallet2 = Keypair.generate().publicKey;
      const mint = new PublicKey(TOKEN_MINTS["USDC"]!.mint);

      const ata1 = deriveATA(wallet1, mint);
      const ata2 = deriveATA(wallet2, mint);

      expect(ata1.toBase58()).not.toBe(ata2.toBase58());
    });
  });

  // ── SolanaAdapterError ──────────────────────────────────────────────────

  describe("SolanaAdapterError", () => {
    it("should have name, code, and message", () => {
      const err = new SolanaAdapterError("TEST_CODE", "test message");
      expect(err.name).toBe("SolanaAdapterError");
      expect(err.code).toBe("TEST_CODE");
      expect(err.message).toBe("test message");
    });

    it("should be an instance of Error", () => {
      const err = new SolanaAdapterError("CODE", "msg");
      expect(err).toBeInstanceOf(Error);
    });
  });

  // ── isDevnetUrl ──────────────────────────────────────────────────

  describe("isDevnetUrl", () => {
    it("should detect devnet URLs", () => {
      expect(isDevnetUrl("https://api.devnet.solana.com")).toBe(true);
    });

    it("should not detect mainnet URLs", () => {
      expect(isDevnetUrl("https://api.mainnet-beta.solana.com")).toBe(false);
    });

    it("should detect devnet in custom RPC URLs", () => {
      expect(isDevnetUrl("https://my-rpc.example.com/devnet")).toBe(true);
    });
  });

  // ── Token Registry Consistency ──────────────────────────────────

  describe("Token Registry Consistency", () => {
    it("should have the same SOL mint in DEVNET and mainnet registries", () => {
      expect(DEVNET_TOKEN_MINTS["SOL"]!.mint).toBe(TOKEN_MINTS["SOL"]!.mint);
    });

    it("should have the same SOL decimals in DEVNET and mainnet registries", () => {
      expect(DEVNET_TOKEN_MINTS["SOL"]!.decimals).toBe(TOKEN_MINTS["SOL"]!.decimals);
    });

    it("should have USDC in both registries", () => {
      expect(TOKEN_MINTS["USDC"]).toBeDefined();
      expect(DEVNET_TOKEN_MINTS["USDC"]).toBeDefined();
    });

    it("should have different USDC mints for mainnet and devnet", () => {
      // Devnet USDC has a different mint address than mainnet USDC
      expect(TOKEN_MINTS["USDC"]!.mint).not.toBe(DEVNET_TOKEN_MINTS["USDC"]!.mint);
    });

    it("should have valid PublicKey strings for all mainnet mints", () => {
      for (const [symbol, entry] of Object.entries(TOKEN_MINTS)) {
        expect(() => new PublicKey(entry.mint), `Invalid mint for ${symbol}`).not.toThrow();
      }
    });

    it("should have valid PublicKey strings for all devnet mints", () => {
      for (const [symbol, entry] of Object.entries(DEVNET_TOKEN_MINTS)) {
        expect(() => new PublicKey(entry.mint), `Invalid devnet mint for ${symbol}`).not.toThrow();
      }
    });

    it("should have non-negative decimals for all tokens", () => {
      for (const [symbol, entry] of Object.entries(TOKEN_MINTS)) {
        expect(entry.decimals, `Negative decimals for ${symbol}`).toBeGreaterThanOrEqual(0);
      }
      for (const [symbol, entry] of Object.entries(DEVNET_TOKEN_MINTS)) {
        expect(entry.decimals, `Negative devnet decimals for ${symbol}`).toBeGreaterThanOrEqual(0);
      }
    });
  });
});
