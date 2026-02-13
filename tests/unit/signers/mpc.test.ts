import { describe, it, expect, vi } from "vitest";
import { MpcSigner, MpcSignerError } from "../../../src/signers/mpc.js";
import type { MpcSigningProvider, MpcSignerConfig } from "../../../src/signers/mpc.js";

// ── Mock provider factory ───────────────────────────────────────────────────

function createMockProvider(overrides?: Partial<MpcSigningProvider>): MpcSigningProvider {
  return {
    name: "mock-mpc",
    getAddress: vi.fn(async () => "MockMpcAddress1234567890abcdef1234"),
    signTransaction: vi.fn(async (data: Uint8Array) => ({
      signedData: new Uint8Array([...data, 0xff]),
      signature: new Uint8Array(64).fill(0xab),
    })),
    healthCheck: vi.fn(async () => true),
    ...overrides,
  };
}

function createSigner(
  providerOverrides?: Partial<MpcSigningProvider>,
  configOverrides?: Partial<MpcSignerConfig>,
): MpcSigner {
  const provider = createMockProvider(providerOverrides);
  return new MpcSigner({
    provider,
    chain: "solana",
    ...configOverrides,
    // Allow provider override via configOverrides too
    ...(configOverrides?.provider ? {} : { provider }),
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("MpcSigner", () => {
  describe("constructor", () => {
    it("should instantiate with required config", () => {
      const signer = createSigner();
      expect(signer).toBeDefined();
    });

    it("should accept custom maxRetries and timeoutMs", () => {
      const signer = createSigner({}, { maxRetries: 5, timeoutMs: 60_000 });
      expect(signer).toBeDefined();
    });
  });

  describe("getAddress()", () => {
    it("should delegate to provider and return the address", async () => {
      const provider = createMockProvider();
      const signer = new MpcSigner({ provider, chain: "solana" });

      const address = await signer.getAddress();
      expect(address).toBe("MockMpcAddress1234567890abcdef1234");
      expect(provider.getAddress).toHaveBeenCalledOnce();
    });

    it("should cache the address after first call", async () => {
      const provider = createMockProvider();
      const signer = new MpcSigner({ provider, chain: "solana" });

      const addr1 = await signer.getAddress();
      const addr2 = await signer.getAddress();
      expect(addr1).toBe(addr2);
      expect(provider.getAddress).toHaveBeenCalledOnce();
    });

    it("should retry on transient failure then succeed", async () => {
      let attempt = 0;
      const provider = createMockProvider({
        getAddress: vi.fn(async () => {
          if (attempt++ === 0) throw new Error("network blip");
          return "RecoveredAddress123456789abcdef1234";
        }),
      });
      const signer = new MpcSigner({ provider, chain: "solana", maxRetries: 2 });

      const address = await signer.getAddress();
      expect(address).toBe("RecoveredAddress123456789abcdef1234");
      expect(provider.getAddress).toHaveBeenCalledTimes(2);
    });

    it("should throw MpcSignerError after exhausting retries", async () => {
      const provider = createMockProvider({
        getAddress: vi.fn(async () => { throw new Error("persistent failure"); }),
      });
      const signer = new MpcSigner({ provider, chain: "solana", maxRetries: 1 });

      await expect(signer.getAddress()).rejects.toThrow(MpcSignerError);
      await expect(signer.getAddress()).rejects.toThrow(/failed after 2 attempts/);
    });
  });

  describe("sign()", () => {
    it("should delegate to provider and return SignedTransaction", async () => {
      const provider = createMockProvider();
      const signer = new MpcSigner({ provider, chain: "solana" });

      const result = await signer.sign({
        chain: "solana",
        data: new Uint8Array([1, 2, 3]),
      });

      expect(result.chain).toBe("solana");
      expect(result.data).toBeInstanceOf(Uint8Array);
      expect(result.signature).toBeInstanceOf(Uint8Array);
      expect(result.signature.length).toBe(64);
      expect(provider.signTransaction).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
    });

    it("should reject chain mismatch without calling provider", async () => {
      const provider = createMockProvider();
      const signer = new MpcSigner({ provider, chain: "solana" });

      await expect(
        signer.sign({ chain: "ethereum", data: new Uint8Array([1]) }),
      ).rejects.toThrow(MpcSignerError);

      await expect(
        signer.sign({ chain: "ethereum", data: new Uint8Array([1]) }),
      ).rejects.toThrow(/configured for "solana" but received transaction for "ethereum"/);

      expect(provider.signTransaction).not.toHaveBeenCalled();
    });

    it("should set CHAIN_MISMATCH error code on chain mismatch", async () => {
      const signer = createSigner();
      try {
        await signer.sign({ chain: "base", data: new Uint8Array([1]) });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(MpcSignerError);
        expect((err as MpcSignerError).code).toBe("CHAIN_MISMATCH");
        expect((err as MpcSignerError).provider).toBe("mock-mpc");
      }
    });

    it("should not retry on chain mismatch", async () => {
      const provider = createMockProvider();
      const signer = new MpcSigner({ provider, chain: "solana", maxRetries: 5 });

      await expect(
        signer.sign({ chain: "ethereum", data: new Uint8Array([1]) }),
      ).rejects.toThrow(MpcSignerError);

      // signTransaction should never be called
      expect(provider.signTransaction).not.toHaveBeenCalled();
    });

    it("should retry on transient provider failure", async () => {
      let attempt = 0;
      const provider = createMockProvider({
        signTransaction: vi.fn(async (data: Uint8Array) => {
          if (attempt++ === 0) throw new Error("temporary error");
          return { signedData: data, signature: new Uint8Array(64).fill(1) };
        }),
      });
      const signer = new MpcSigner({ provider, chain: "solana", maxRetries: 2 });

      const result = await signer.sign({
        chain: "solana",
        data: new Uint8Array([1, 2, 3]),
      });
      expect(result.chain).toBe("solana");
      expect(provider.signTransaction).toHaveBeenCalledTimes(2);
    });

    it("should throw PROVIDER_ERROR after exhausting retries", async () => {
      const provider = createMockProvider({
        signTransaction: vi.fn(async () => { throw new Error("always fails"); }),
      });
      const signer = new MpcSigner({ provider, chain: "solana", maxRetries: 1 });

      try {
        await signer.sign({ chain: "solana", data: new Uint8Array([1]) });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(MpcSignerError);
        expect((err as MpcSignerError).code).toBe("PROVIDER_ERROR");
        expect((err as MpcSignerError).message).toContain("failed after 2 attempts");
      }
    });
  });

  describe("healthCheck()", () => {
    it("should delegate to provider and return true when healthy", async () => {
      const provider = createMockProvider();
      const signer = new MpcSigner({ provider, chain: "solana" });

      expect(await signer.healthCheck()).toBe(true);
      expect(provider.healthCheck).toHaveBeenCalledOnce();
    });

    it("should delegate to provider and return false when unhealthy", async () => {
      const provider = createMockProvider({
        healthCheck: vi.fn(async () => false),
      });
      const signer = new MpcSigner({ provider, chain: "solana" });

      expect(await signer.healthCheck()).toBe(false);
    });

    it("should return false when provider throws (no retry)", async () => {
      const provider = createMockProvider({
        healthCheck: vi.fn(async () => { throw new Error("unreachable"); }),
      });
      const signer = new MpcSigner({ provider, chain: "solana" });

      expect(await signer.healthCheck()).toBe(false);
      // Should only be called once — no retry for health checks
      expect(provider.healthCheck).toHaveBeenCalledOnce();
    });
  });

  describe("timeout", () => {
    it("should throw TIMEOUT error when provider is too slow", async () => {
      const provider = createMockProvider({
        getAddress: vi.fn(() => new Promise((resolve) => setTimeout(() => resolve("addr"), 500))),
      });
      const signer = new MpcSigner({ provider, chain: "solana", timeoutMs: 50 });

      try {
        await signer.getAddress();
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(MpcSignerError);
        expect((err as MpcSignerError).code).toBe("TIMEOUT");
        expect((err as MpcSignerError).message).toContain("timed out after 50ms");
      }
    });

    it("should return false from healthCheck on timeout", async () => {
      const provider = createMockProvider({
        healthCheck: vi.fn(() => new Promise((resolve) => setTimeout(() => resolve(true), 500))),
      });
      const signer = new MpcSigner({ provider, chain: "solana", timeoutMs: 50 });

      expect(await signer.healthCheck()).toBe(false);
    });
  });

  describe("MpcSignerError", () => {
    it("should carry code, provider, and message", () => {
      const err = new MpcSignerError("PROVIDER_ERROR", "turnkey", "something broke");
      expect(err.code).toBe("PROVIDER_ERROR");
      expect(err.provider).toBe("turnkey");
      expect(err.message).toBe("something broke");
      expect(err.name).toBe("MpcSignerError");
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("different provider configs", () => {
    it("should work with any provider name", async () => {
      for (const name of ["turnkey", "lit-protocol", "fireblocks", "custom-hsm"]) {
        const provider = createMockProvider({ name });
        const signer = new MpcSigner({ provider, chain: "solana" });
        const address = await signer.getAddress();
        expect(address).toBe("MockMpcAddress1234567890abcdef1234");
      }
    });

    it("should work with different chains", async () => {
      const provider = createMockProvider();
      const signer = new MpcSigner({ provider, chain: "ethereum" });

      const result = await signer.sign({
        chain: "ethereum",
        data: new Uint8Array([0xde, 0xad]),
      });
      expect(result.chain).toBe("ethereum");
    });
  });
});
