import { describe, it, expect } from "vitest";
import { TurnkeyProvider } from "../../../src/signers/turnkey-provider.js";
import type { TurnkeyProviderConfig } from "../../../src/signers/turnkey-provider.js";
import { Keypair, VersionedTransaction, TransactionMessage, SystemProgram, PublicKey } from "@solana/web3.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function validConfig(overrides: Partial<TurnkeyProviderConfig> = {}): TurnkeyProviderConfig {
  return {
    apiBaseUrl: "https://api.turnkey.com",
    apiPublicKey: "test-public-key",
    apiPrivateKey: "test-private-key",
    defaultOrganizationId: "org-id-123",
    signWith: Keypair.generate().publicKey.toBase58(),
    ...overrides,
  };
}

function buildValidSolanaTransaction(feePayer: PublicKey): Uint8Array {
  const message = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [
      SystemProgram.transfer({
        fromPubkey: feePayer,
        toPubkey: feePayer,
        lamports: 0,
      }),
    ],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  return tx.serialize();
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("TurnkeyProvider", () => {
  describe("constructor validation", () => {
    it("throws if apiBaseUrl is missing", () => {
      expect(() => new TurnkeyProvider(validConfig({ apiBaseUrl: "" }))).toThrow(
        "apiBaseUrl is required",
      );
    });

    it("throws if apiPublicKey is missing", () => {
      expect(() => new TurnkeyProvider(validConfig({ apiPublicKey: "" }))).toThrow(
        "apiPublicKey is required",
      );
    });

    it("throws if apiPrivateKey is missing", () => {
      expect(() => new TurnkeyProvider(validConfig({ apiPrivateKey: "" }))).toThrow(
        "apiPrivateKey is required",
      );
    });

    it("throws if defaultOrganizationId is missing", () => {
      expect(() => new TurnkeyProvider(validConfig({ defaultOrganizationId: "" }))).toThrow(
        "defaultOrganizationId is required",
      );
    });

    it("throws if signWith is missing", () => {
      expect(() => new TurnkeyProvider(validConfig({ signWith: "" }))).toThrow(
        "signWith is required",
      );
    });

    it("constructs successfully with valid config", () => {
      const provider = new TurnkeyProvider(validConfig());
      expect(provider.name).toBe("turnkey");
    });
  });

  describe("getAddress", () => {
    it("returns signWith directly when it is a Solana address (not UUID)", async () => {
      const address = Keypair.generate().publicKey.toBase58();
      const provider = new TurnkeyProvider(validConfig({ signWith: address }));
      const result = await provider.getAddress();
      expect(result).toBe(address);
    });

    it("caches the address on subsequent calls", async () => {
      const address = Keypair.generate().publicKey.toBase58();
      const provider = new TurnkeyProvider(validConfig({ signWith: address }));
      const first = await provider.getAddress();
      const second = await provider.getAddress();
      expect(first).toBe(second);
    });
  });

  describe("healthCheck", () => {
    it("returns false when Turnkey SDK is not installed", async () => {
      const provider = new TurnkeyProvider(validConfig());
      // Since @turnkey/sdk-server is not installed in test env,
      // the dynamic import will fail and healthCheck returns false
      const result = await provider.healthCheck();
      expect(result).toBe(false);
    });
  });

  describe("signTransaction", () => {
    it("throws when aborted before request", async () => {
      const provider = new TurnkeyProvider(validConfig());
      const controller = new AbortController();
      controller.abort();

      const kp = Keypair.generate();
      const txData = buildValidSolanaTransaction(kp.publicKey);

      await expect(
        provider.signTransaction(txData, controller.signal),
      ).rejects.toThrow("signing aborted before request");
    });
  });

  describe("destroy", () => {
    it("clears cached state", async () => {
      const address = Keypair.generate().publicKey.toBase58();
      const provider = new TurnkeyProvider(validConfig({ signWith: address }));

      // Populate cache
      await provider.getAddress();

      // Destroy should clear it
      await provider.destroy();

      // After destroy, getAddress still works (re-caches from config)
      const result = await provider.getAddress();
      expect(result).toBe(address);
    });
  });

  describe("MpcSigningProvider interface compliance", () => {
    it("has the required name property", () => {
      const provider = new TurnkeyProvider(validConfig());
      expect(typeof provider.name).toBe("string");
      expect(provider.name).toBe("turnkey");
    });

    it("has the required getAddress method", () => {
      const provider = new TurnkeyProvider(validConfig());
      expect(typeof provider.getAddress).toBe("function");
    });

    it("has the required signTransaction method", () => {
      const provider = new TurnkeyProvider(validConfig());
      expect(typeof provider.signTransaction).toBe("function");
    });

    it("has the required healthCheck method", () => {
      const provider = new TurnkeyProvider(validConfig());
      expect(typeof provider.healthCheck).toBe("function");
    });

    it("has the optional destroy method", () => {
      const provider = new TurnkeyProvider(validConfig());
      expect(typeof provider.destroy).toBe("function");
    });
  });
});
