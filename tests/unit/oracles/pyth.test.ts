import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createPythPriceProvider,
  parsePythPriceAccount,
  PYTH_MAINNET_FEEDS,
  PYTH_DEVNET_FEEDS,
} from "../../../src/oracles/pyth.js";
import type { PythPriceProvider } from "../../../src/oracles/pyth.js";
import type { Connection } from "@solana/web3.js";

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Build a mock Pyth V2 price account buffer with the given parameters.
 * Matches the binary layout parsed by parsePythPriceAccount.
 */
function buildPythPriceBuffer(opts: {
  price: bigint;
  confidence: bigint;
  exponent: number;
  publishTime: bigint;
  status?: number;
  magic?: number;
  type?: number;
}): Buffer {
  // Allocate a buffer large enough for the fields we read (min 304 bytes)
  const buf = Buffer.alloc(320, 0);

  // magic (u32 LE at offset 0)
  buf.writeUInt32LE(opts.magic ?? 0xa1b2c3d4, 0);
  // version (u32 LE at offset 4)
  buf.writeUInt32LE(2, 4);
  // type (u32 LE at offset 8) — 3 = price
  buf.writeUInt32LE(opts.type ?? 3, 8);
  // size (u32 LE at offset 12)
  buf.writeUInt32LE(320, 12);

  // aggregate price (i64 LE at offset 208)
  buf.writeBigInt64LE(opts.price, 208);
  // aggregate confidence (u64 LE at offset 216)
  buf.writeBigUInt64LE(opts.confidence, 216);
  // status (u32 LE at offset 224)
  buf.writeUInt32LE(opts.status ?? 1, 224);
  // exponent (i32 LE at offset 232)
  buf.writeInt32LE(opts.exponent, 232);

  // publishTime (i64 LE at offset 296)
  buf.writeBigInt64LE(opts.publishTime, 296);

  return buf;
}

function createMockConnection(accountData: Buffer | null): Connection {
  return {
    getAccountInfo: vi.fn().mockResolvedValue(
      accountData ? { data: accountData, executable: false, owner: {}, lamports: 0 } : null,
    ),
  } as unknown as Connection;
}

// ── parsePythPriceAccount ──────────────────────────────────────────────

describe("parsePythPriceAccount", () => {
  it("should parse a valid Pyth price account", () => {
    const buf = buildPythPriceBuffer({
      price: 15000000000n,   // 150.00 with exponent -8
      confidence: 5000000n,  // 0.05 with exponent -8
      exponent: -8,
      publishTime: BigInt(Math.floor(Date.now() / 1000)),
      status: 1,
    });

    const result = parsePythPriceAccount(buf);
    expect(result).not.toBeNull();
    expect(result!.price).toBeCloseTo(150.0, 2);
    expect(result!.confidence).toBeCloseTo(0.05, 4);
    expect(result!.status).toBe(1);
  });

  it("should return null for buffer too small", () => {
    const buf = Buffer.alloc(100, 0);
    expect(parsePythPriceAccount(buf)).toBeNull();
  });

  it("should return null for wrong magic number", () => {
    const buf = buildPythPriceBuffer({
      price: 15000000000n,
      confidence: 5000000n,
      exponent: -8,
      publishTime: BigInt(Math.floor(Date.now() / 1000)),
      magic: 0xdeadbeef,
    });
    expect(parsePythPriceAccount(buf)).toBeNull();
  });

  it("should return null for non-price account type", () => {
    const buf = buildPythPriceBuffer({
      price: 15000000000n,
      confidence: 5000000n,
      exponent: -8,
      publishTime: BigInt(Math.floor(Date.now() / 1000)),
      type: 1, // not a price type
    });
    expect(parsePythPriceAccount(buf)).toBeNull();
  });
});

// ── createPythPriceProvider ────────────────────────────────────────────

describe("createPythPriceProvider", () => {
  let provider: PythPriceProvider;

  afterEach(() => {
    if (provider) provider.destroy();
  });

  it("should return price for a known token by mint address", async () => {
    const buf = buildPythPriceBuffer({
      price: 15000000000n,   // 150.00
      confidence: 1000000n,  // 0.01 (well within 2%)
      exponent: -8,
      publishTime: BigInt(Math.floor(Date.now() / 1000)),
    });
    const conn = createMockConnection(buf);
    provider = createPythPriceProvider(conn);

    // Use SOL mint address directly
    const price = await provider("So11111111111111111111111111111111111111112");
    expect(price).toBeCloseTo(150.0, 2);
  });

  it("should resolve token symbols to mint addresses", async () => {
    const buf = buildPythPriceBuffer({
      price: 15000000000n,
      confidence: 1000000n,
      exponent: -8,
      publishTime: BigInt(Math.floor(Date.now() / 1000)),
    });
    const conn = createMockConnection(buf);
    provider = createPythPriceProvider(conn);

    // Pass "SOL" symbol instead of mint address
    const price = await provider("SOL");
    expect(price).toBeCloseTo(150.0, 2);
    expect(conn.getAccountInfo).toHaveBeenCalled();
  });

  it("should resolve lowercase token symbols", async () => {
    const buf = buildPythPriceBuffer({
      price: 15000000000n,
      confidence: 1000000n,
      exponent: -8,
      publishTime: BigInt(Math.floor(Date.now() / 1000)),
    });
    const conn = createMockConnection(buf);
    provider = createPythPriceProvider(conn);

    const price = await provider("sol");
    expect(price).toBeCloseTo(150.0, 2);
  });

  it("should return null for unknown token", async () => {
    const conn = createMockConnection(null);
    provider = createPythPriceProvider(conn);

    const price = await provider("UNKNOWN_TOKEN_XYZ");
    expect(price).toBeNull();
  });

  it("should return null when account info is null", async () => {
    const conn = createMockConnection(null);
    provider = createPythPriceProvider(conn);

    const price = await provider("SOL");
    expect(price).toBeNull();
  });

  it("should return null for stale prices", async () => {
    const staleTime = Math.floor(Date.now() / 1000) - 60; // 60 seconds ago
    const buf = buildPythPriceBuffer({
      price: 15000000000n,
      confidence: 1000000n,
      exponent: -8,
      publishTime: BigInt(staleTime),
    });
    const conn = createMockConnection(buf);
    provider = createPythPriceProvider(conn, { maxStalenessSeconds: 30 });

    const price = await provider("SOL");
    expect(price).toBeNull();
  });

  it("should accept prices within staleness window", async () => {
    const freshTime = Math.floor(Date.now() / 1000) - 5; // 5 seconds ago
    const buf = buildPythPriceBuffer({
      price: 15000000000n,
      confidence: 1000000n,
      exponent: -8,
      publishTime: BigInt(freshTime),
    });
    const conn = createMockConnection(buf);
    provider = createPythPriceProvider(conn, { maxStalenessSeconds: 30 });

    const price = await provider("SOL");
    expect(price).toBeCloseTo(150.0, 2);
  });

  it("should return null for wide confidence interval", async () => {
    // Confidence is 5% of price — exceeds the 2% default threshold
    const buf = buildPythPriceBuffer({
      price: 10000000000n,   // 100.00
      confidence: 500000000n, // 5.00 (5% of price)
      exponent: -8,
      publishTime: BigInt(Math.floor(Date.now() / 1000)),
    });
    const conn = createMockConnection(buf);
    provider = createPythPriceProvider(conn, { maxConfidencePercent: 0.02 });

    const price = await provider("SOL");
    expect(price).toBeNull();
  });

  it("should accept prices with tight confidence interval", async () => {
    // Confidence is 0.5% of price — within the 2% threshold
    const buf = buildPythPriceBuffer({
      price: 10000000000n,  // 100.00
      confidence: 5000000n, // 0.05 (0.05% of price)
      exponent: -8,
      publishTime: BigInt(Math.floor(Date.now() / 1000)),
    });
    const conn = createMockConnection(buf);
    provider = createPythPriceProvider(conn, { maxConfidencePercent: 0.02 });

    const price = await provider("SOL");
    expect(price).toBeCloseTo(100.0, 2);
  });

  it("should return null for non-trading status", async () => {
    const buf = buildPythPriceBuffer({
      price: 15000000000n,
      confidence: 1000000n,
      exponent: -8,
      publishTime: BigInt(Math.floor(Date.now() / 1000)),
      status: 0, // not trading
    });
    const conn = createMockConnection(buf);
    provider = createPythPriceProvider(conn);

    const price = await provider("SOL");
    expect(price).toBeNull();
  });

  it("should return null for negative prices", async () => {
    const buf = buildPythPriceBuffer({
      price: -15000000000n,
      confidence: 1000000n,
      exponent: -8,
      publishTime: BigInt(Math.floor(Date.now() / 1000)),
    });
    const conn = createMockConnection(buf);
    provider = createPythPriceProvider(conn);

    const price = await provider("SOL");
    expect(price).toBeNull();
  });

  it("should cache prices within TTL", async () => {
    const buf = buildPythPriceBuffer({
      price: 15000000000n,
      confidence: 1000000n,
      exponent: -8,
      publishTime: BigInt(Math.floor(Date.now() / 1000)),
    });
    const conn = createMockConnection(buf);
    provider = createPythPriceProvider(conn, { cacheTtlMs: 10000 });

    // First call fetches from RPC
    const price1 = await provider("SOL");
    expect(price1).toBeCloseTo(150.0, 2);
    expect(conn.getAccountInfo).toHaveBeenCalledTimes(1);

    // Second call should use cache — no additional RPC call
    const price2 = await provider("SOL");
    expect(price2).toBeCloseTo(150.0, 2);
    expect(conn.getAccountInfo).toHaveBeenCalledTimes(1);
  });

  it("should re-fetch after cache TTL expires", async () => {
    const buf = buildPythPriceBuffer({
      price: 15000000000n,
      confidence: 1000000n,
      exponent: -8,
      publishTime: BigInt(Math.floor(Date.now() / 1000)),
    });
    const conn = createMockConnection(buf);
    // Very short TTL so we can test expiration
    provider = createPythPriceProvider(conn, { cacheTtlMs: 1 });

    await provider("SOL");
    expect(conn.getAccountInfo).toHaveBeenCalledTimes(1);

    // Wait for cache to expire
    await new Promise((r) => setTimeout(r, 10));

    await provider("SOL");
    expect(conn.getAccountInfo).toHaveBeenCalledTimes(2);
  });

  it("should return null when RPC throws", async () => {
    const conn = {
      getAccountInfo: vi.fn().mockRejectedValue(new Error("RPC timeout")),
    } as unknown as Connection;
    provider = createPythPriceProvider(conn);

    const price = await provider("SOL");
    expect(price).toBeNull();
  });

  it("should use devnet feeds when network is devnet", async () => {
    const buf = buildPythPriceBuffer({
      price: 15000000000n,
      confidence: 1000000n,
      exponent: -8,
      publishTime: BigInt(Math.floor(Date.now() / 1000)),
    });
    const conn = createMockConnection(buf);
    provider = createPythPriceProvider(conn, { network: "devnet" });

    await provider("SOL");
    // Should call with devnet feed address
    const calledWith = (conn.getAccountInfo as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(calledWith?.toBase58()).toBe(PYTH_DEVNET_FEEDS["So11111111111111111111111111111111111111112"]);
  });

  it("should use mainnet feeds by default", async () => {
    const buf = buildPythPriceBuffer({
      price: 15000000000n,
      confidence: 1000000n,
      exponent: -8,
      publishTime: BigInt(Math.floor(Date.now() / 1000)),
    });
    const conn = createMockConnection(buf);
    provider = createPythPriceProvider(conn);

    await provider("SOL");
    const calledWith = (conn.getAccountInfo as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(calledWith?.toBase58()).toBe(PYTH_MAINNET_FEEDS["So11111111111111111111111111111111111111112"]);
  });

  it("should support custom feed map", async () => {
    const customMint = "CustomMint111111111111111111111111111111111";
    const customFeed = "CustomFeed111111111111111111111111111111111";
    const buf = buildPythPriceBuffer({
      price: 5000000000n, // 50.00
      confidence: 1000000n,
      exponent: -8,
      publishTime: BigInt(Math.floor(Date.now() / 1000)),
    });
    const conn = createMockConnection(buf);
    provider = createPythPriceProvider(conn, {
      feedMap: { [customMint]: customFeed },
    });

    const price = await provider(customMint);
    expect(price).toBeCloseTo(50.0, 2);
  });

  it("should clear cache on destroy", async () => {
    const buf = buildPythPriceBuffer({
      price: 15000000000n,
      confidence: 1000000n,
      exponent: -8,
      publishTime: BigInt(Math.floor(Date.now() / 1000)),
    });
    const conn = createMockConnection(buf);
    provider = createPythPriceProvider(conn, { cacheTtlMs: 60000 });

    await provider("SOL");
    expect(conn.getAccountInfo).toHaveBeenCalledTimes(1);

    // Destroy clears cache
    provider.destroy();

    // Next call should fetch from RPC again
    await provider("SOL");
    expect(conn.getAccountInfo).toHaveBeenCalledTimes(2);
  });

  it("should reject future publishTime (negative age)", async () => {
    const futureTime = Math.floor(Date.now() / 1000) + 3600; // 1 hour in the future
    const buf = buildPythPriceBuffer({
      price: 15000000000n,
      confidence: 1000000n,
      exponent: -8,
      publishTime: BigInt(futureTime),
    });
    const conn = createMockConnection(buf);
    provider = createPythPriceProvider(conn);

    const price = await provider("SOL");
    expect(price).toBeNull();
  });
});

// ── Feed Maps ──────────────────────────────────────────────────────────

describe("Pyth feed maps", () => {
  it("should have mainnet feeds for SOL, USDC, USDT", () => {
    expect(PYTH_MAINNET_FEEDS["So11111111111111111111111111111111111111112"]).toBeDefined();
    expect(PYTH_MAINNET_FEEDS["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"]).toBeDefined();
    expect(PYTH_MAINNET_FEEDS["Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]).toBeDefined();
  });

  it("should have devnet feeds for SOL and USDC", () => {
    expect(PYTH_DEVNET_FEEDS["So11111111111111111111111111111111111111112"]).toBeDefined();
    expect(PYTH_DEVNET_FEEDS["4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"]).toBeDefined();
  });

  it("mainnet and devnet feeds should be frozen", () => {
    expect(Object.isFrozen(PYTH_MAINNET_FEEDS)).toBe(true);
    expect(Object.isFrozen(PYTH_DEVNET_FEEDS)).toBe(true);
  });
});
