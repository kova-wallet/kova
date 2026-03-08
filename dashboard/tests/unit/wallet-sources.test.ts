import { describe, it, expect, vi, beforeEach } from "vitest";
import { WalletSourceRegistry } from "@/lib/wallet-sources";
import type { WalletSourceConfig } from "@/lib/wallet-sources";

// Mock the SDK modules
vi.mock("@solana/web3.js", () => {
  const mockKeypair = {
    publicKey: { toBase58: () => "MockPublicKeyBase58Address1111111111111111111" },
    secretKey: new Uint8Array(64).fill(1),
  };
  return {
    Keypair: {
      generate: () => mockKeypair,
      fromSecretKey: (bytes: Uint8Array) => ({
        publicKey: { toBase58: () => "ImportedPublicKeyBase58Address111111111111111" },
        secretKey: bytes,
      }),
    },
  };
});

vi.mock("@kova/signers/local.js", () => ({
  LocalSigner: class MockLocalSigner {
    constructor(public keypair: unknown, public opts: unknown) {}
  },
}));

vi.mock("@kova/signers/mpc.js", () => ({
  MpcSigner: class MockMpcSigner {
    private provider: { getAddress?: () => Promise<string> };
    constructor(opts: { provider: { getAddress?: () => Promise<string> } }) {
      this.provider = opts.provider;
    }
    async getAddress() {
      return "TurnkeyMpcAddress111111111111111111111111111";
    }
  },
}));

vi.mock("@kova/signers/turnkey-provider.js", () => ({
  TurnkeyProvider: class MockTurnkeyProvider {
    constructor(public config: unknown) {}
    async getAddress() {
      return "TurnkeyMpcAddress111111111111111111111111111";
    }
  },
}));

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    signerType: "local",
    walletsDir: "/tmp/test-wallets",
    turnkeyApiBaseUrl: "",
    turnkeyApiPublicKey: "",
    turnkeyApiPrivateKey: "",
    turnkeyOrganizationId: "",
    turnkeyWalletAddress: "",
  }),
}));

describe("WalletSourceRegistry", () => {
  let registry: WalletSourceRegistry;

  beforeEach(() => {
    registry = new WalletSourceRegistry();
  });

  describe("resolve — generate", () => {
    it("generates a new wallet", async () => {
      const result = await registry.resolve({ type: "generate" });
      expect(result.address).toBe("MockPublicKeyBase58Address1111111111111111111");
      expect(result.sourceType).toBe("generate");
      expect(result.sourceLabel).toBe("Generated");
      expect(result.keypairBytes).toBeInstanceOf(Uint8Array);
      expect(result.signer).toBeDefined();
    });
  });

  describe("resolve — secret-key", () => {
    it("imports from JSON array string", async () => {
      const secretKey = JSON.stringify(Array.from({ length: 64 }, (_, i) => i));
      const result = await registry.resolve({ type: "secret-key", secretKey });
      expect(result.address).toBe("ImportedPublicKeyBase58Address111111111111111");
      expect(result.sourceType).toBe("secret-key");
      expect(result.sourceLabel).toBe("Imported (secret key)");
      expect(result.keypairBytes).toBeInstanceOf(Uint8Array);
    });

    it("imports from comma-separated numbers", async () => {
      const secretKey = Array.from({ length: 64 }, (_, i) => i).join(", ");
      const result = await registry.resolve({ type: "secret-key", secretKey });
      expect(result.address).toBe("ImportedPublicKeyBase58Address111111111111111");
    });

    it("throws for missing secretKey", async () => {
      await expect(
        registry.resolve({ type: "secret-key" })
      ).rejects.toThrow("Secret key is required");
    });

    it("throws for wrong length JSON array", async () => {
      await expect(
        registry.resolve({ type: "secret-key", secretKey: "[1, 2, 3]" })
      ).rejects.toThrow("exactly 64 bytes");
    });

    it("throws for invalid format", async () => {
      await expect(
        registry.resolve({ type: "secret-key", secretKey: "not-a-key" })
      ).rejects.toThrow("Invalid secret key format");
    });
  });

  describe("resolve — keyfile", () => {
    it("loads from keyfileBytes", async () => {
      const bytes = Array.from({ length: 64 }, (_, i) => i);
      const result = await registry.resolve({ type: "keyfile", keyfileBytes: bytes });
      expect(result.address).toBe("ImportedPublicKeyBase58Address111111111111111");
      expect(result.sourceType).toBe("keyfile");
      expect(result.sourceLabel).toBe("Keyfile (uploaded)");
    });

    it("throws for wrong length keyfileBytes", async () => {
      await expect(
        registry.resolve({ type: "keyfile", keyfileBytes: [1, 2, 3] })
      ).rejects.toThrow("expected 64");
    });

    it("throws when neither path nor bytes provided", async () => {
      await expect(
        registry.resolve({ type: "keyfile" })
      ).rejects.toThrow("Either keyfilePath or keyfileBytes is required");
    });

    it("throws for non-existent keyfile path", async () => {
      await expect(
        registry.resolve({ type: "keyfile", keyfilePath: "/nonexistent/id.json" })
      ).rejects.toThrow("Keyfile not found");
    });
  });

  describe("resolve — turnkey", () => {
    it("creates a Turnkey MPC wallet", async () => {
      const config: WalletSourceConfig = {
        type: "turnkey",
        turnkey: {
          apiBaseUrl: "https://api.turnkey.com",
          apiPublicKey: "pub-key",
          apiPrivateKey: "priv-key",
          organizationId: "org-id",
          walletAddress: "wallet-addr",
        },
      };
      const result = await registry.resolve(config);
      expect(result.address).toBe("TurnkeyMpcAddress111111111111111111111111111");
      expect(result.sourceType).toBe("turnkey");
      expect(result.sourceLabel).toContain("Turnkey");
      expect(result.keypairBytes).toBeNull();
    });

    it("throws when turnkey config is missing", async () => {
      await expect(
        registry.resolve({ type: "turnkey" })
      ).rejects.toThrow("Turnkey config is required");
    });

    it("throws when turnkey fields are incomplete", async () => {
      await expect(
        registry.resolve({
          type: "turnkey",
          turnkey: {
            apiBaseUrl: "https://api.turnkey.com",
            apiPublicKey: "",
            apiPrivateKey: "",
            organizationId: "",
            walletAddress: "",
          },
        })
      ).rejects.toThrow("requires all fields");
    });
  });

  describe("resolve — unknown type", () => {
    it("throws for unknown source type", async () => {
      await expect(
        registry.resolve({ type: "unknown" as WalletSourceConfig["type"] })
      ).rejects.toThrow("Unknown wallet source type");
    });
  });
});
