import { describe, it, expect, vi } from "vitest";
import { createConsensusProvider } from "../../../src/oracles/consensus.js";
import type { PriceProviderFn } from "../../../src/oracles/consensus.js";

// ── Helpers ────────────────────────────────────────────────────────────

function mockProvider(price: number | null, delay = 0): PriceProviderFn {
  return async () => {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    return price;
  };
}

function throwingProvider(error: string): PriceProviderFn {
  return async () => {
    throw new Error(error);
  };
}

// ── Constructor ────────────────────────────────────────────────────────

describe("createConsensusProvider", () => {
  it("should throw if no providers are given", () => {
    expect(() => createConsensusProvider([])).toThrow("at least one provider");
  });
});

// ── Median Strategy ────────────────────────────────────────────────────

describe("consensus: median strategy", () => {
  it("should return the single price when one provider", async () => {
    const provider = createConsensusProvider([mockProvider(100)]);
    const price = await provider("SOL");
    expect(price).toBe(100);
  });

  it("should return median of odd number of providers", async () => {
    const provider = createConsensusProvider([
      mockProvider(100),
      mockProvider(110),
      mockProvider(105),
    ]);
    const price = await provider("SOL");
    expect(price).toBe(105); // sorted: [100, 105, 110] → middle = 105
  });

  it("should return average of two middle values for even number of providers", async () => {
    const provider = createConsensusProvider([
      mockProvider(100),
      mockProvider(110),
      mockProvider(105),
      mockProvider(115),
    ]);
    const price = await provider("SOL");
    expect(price).toBe(107.5); // sorted: [100, 105, 110, 115] → (105+110)/2
  });

  it("should ignore null results from providers", async () => {
    const provider = createConsensusProvider([
      mockProvider(null),
      mockProvider(100),
      mockProvider(110),
    ]);
    const price = await provider("SOL");
    expect(price).toBe(105); // only [100, 110] → (100+110)/2
  });

  it("should ignore throwing providers", async () => {
    const provider = createConsensusProvider([
      throwingProvider("RPC down"),
      mockProvider(100),
      mockProvider(110),
    ]);
    const price = await provider("SOL");
    expect(price).toBe(105);
  });

  it("should return null when all providers fail", async () => {
    const provider = createConsensusProvider([
      throwingProvider("fail 1"),
      throwingProvider("fail 2"),
      mockProvider(null),
    ]);
    const price = await provider("SOL");
    expect(price).toBeNull();
  });

  it("should return null when all providers return zero or negative", async () => {
    const provider = createConsensusProvider([
      mockProvider(0),
      mockProvider(-5),
    ]);
    const price = await provider("SOL");
    expect(price).toBeNull();
  });

  it("should return null when fewer providers succeed than minProviders", async () => {
    const provider = createConsensusProvider(
      [mockProvider(null), mockProvider(100)],
      { minProviders: 2 },
    );
    const price = await provider("SOL");
    expect(price).toBeNull();
  });

  it("should succeed when enough providers meet minProviders", async () => {
    const provider = createConsensusProvider(
      [mockProvider(100), mockProvider(110), mockProvider(null)],
      { minProviders: 2 },
    );
    const price = await provider("SOL");
    expect(price).toBe(105);
  });

  it("should filter out non-finite values", async () => {
    const provider = createConsensusProvider([
      mockProvider(Infinity),
      mockProvider(NaN),
      mockProvider(100),
    ]);
    const price = await provider("SOL");
    expect(price).toBe(100);
  });
});

// ── First-Success Strategy ─────────────────────────────────────────────

describe("consensus: first-success strategy", () => {
  it("should return the first successful price", async () => {
    const provider = createConsensusProvider(
      [mockProvider(100), mockProvider(200)],
      { strategy: "first-success" },
    );
    const price = await provider("SOL");
    expect(price).toBe(100);
  });

  it("should skip null providers and return next success", async () => {
    const provider = createConsensusProvider(
      [mockProvider(null), mockProvider(200)],
      { strategy: "first-success" },
    );
    const price = await provider("SOL");
    expect(price).toBe(200);
  });

  it("should skip throwing providers", async () => {
    const provider = createConsensusProvider(
      [throwingProvider("down"), mockProvider(200)],
      { strategy: "first-success" },
    );
    const price = await provider("SOL");
    expect(price).toBe(200);
  });

  it("should return null when all providers fail", async () => {
    const provider = createConsensusProvider(
      [throwingProvider("down"), mockProvider(null)],
      { strategy: "first-success" },
    );
    const price = await provider("SOL");
    expect(price).toBeNull();
  });

  it("should skip zero and negative prices", async () => {
    const provider = createConsensusProvider(
      [mockProvider(0), mockProvider(-1), mockProvider(100)],
      { strategy: "first-success" },
    );
    const price = await provider("SOL");
    expect(price).toBe(100);
  });
});

// ── Destroy ────────────────────────────────────────────────────────────

describe("consensus: destroy", () => {
  it("should call destroy on providers that have it", () => {
    const destroyFn = vi.fn();
    const providerWithDestroy = Object.assign(mockProvider(100), { destroy: destroyFn });
    const providerWithout = mockProvider(200);

    const consensus = createConsensusProvider([providerWithDestroy, providerWithout]);
    consensus.destroy();

    expect(destroyFn).toHaveBeenCalledOnce();
  });

  it("should not throw if no providers have destroy", () => {
    const consensus = createConsensusProvider([mockProvider(100)]);
    expect(() => consensus.destroy()).not.toThrow();
  });
});
