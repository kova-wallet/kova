import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Reset the config singleton between tests
const CONFIG_KEY = "__kova_dashboard_config__";

function clearConfig() {
  delete (globalThis as Record<string, unknown>)[CONFIG_KEY];
}

describe("Dashboard Config", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    clearConfig();
    // Reset env to clean slate
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("KOVA_") || key.startsWith("TURNKEY_") || key === "PORT") {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    clearConfig();
    process.env = { ...originalEnv };
  });

  it("returns localnet defaults when no env vars set", async () => {
    const { getConfig } = await import("@/lib/config");
    const config = getConfig();

    expect(config.network).toBe("localnet");
    expect(config.networkLabel).toBe("Localnet");
    expect(config.rpcUrl).toBe("http://localhost:8899");
    expect(config.airdropEnabled).toBe(true);
    expect(config.storeType).toBe("memory");
    expect(config.signerType).toBe("local");
    expect(config.airdropAmountSol).toBe(1);
    expect(config.pollIntervalMs).toBe(10_000);
    expect(config.approvalTimeoutMs).toBe(120_000);
    expect(config.port).toBe(3000);
  });

  it("resolves mainnet-beta config correctly", async () => {
    process.env.KOVA_NETWORK = "mainnet-beta";
    clearConfig();
    const { getConfig } = await import("@/lib/config");
    const config = getConfig();

    expect(config.network).toBe("mainnet-beta");
    expect(config.networkLabel).toBe("Mainnet");
    expect(config.rpcUrl).toBe("https://api.mainnet-beta.solana.com");
    expect(config.airdropEnabled).toBe(false);
  });

  it("resolves devnet config correctly", async () => {
    process.env.KOVA_NETWORK = "devnet";
    clearConfig();
    const { getConfig } = await import("@/lib/config");
    const config = getConfig();

    expect(config.network).toBe("devnet");
    expect(config.networkLabel).toBe("Devnet");
    expect(config.rpcUrl).toBe("https://api.devnet.solana.com");
    expect(config.airdropEnabled).toBe(true);
  });

  it("uses custom RPC URL when provided", async () => {
    process.env.KOVA_RPC_URL = "https://my-custom-rpc.com";
    clearConfig();
    const { getConfig } = await import("@/lib/config");
    const config = getConfig();

    expect(config.rpcUrl).toBe("https://my-custom-rpc.com");
  });

  it("uses custom network label when provided", async () => {
    process.env.KOVA_NETWORK_LABEL = "My Custom Network";
    clearConfig();
    const { getConfig } = await import("@/lib/config");
    const config = getConfig();

    expect(config.networkLabel).toBe("My Custom Network");
  });

  it("reads store type from env", async () => {
    process.env.KOVA_STORE_TYPE = "sqlite";
    clearConfig();
    const { getConfig } = await import("@/lib/config");
    const config = getConfig();

    expect(config.storeType).toBe("sqlite");
  });

  it("reads sqlite path from env", async () => {
    process.env.KOVA_SQLITE_PATH = "/custom/path/db.sqlite";
    clearConfig();
    const { getConfig } = await import("@/lib/config");
    const config = getConfig();

    expect(config.sqlitePath).toBe("/custom/path/db.sqlite");
  });

  it("reads turnkey config from env", async () => {
    process.env.TURNKEY_API_BASE_URL = "https://api.turnkey.com";
    process.env.TURNKEY_API_PUBLIC_KEY = "pub-key";
    process.env.TURNKEY_API_PRIVATE_KEY = "priv-key";
    process.env.TURNKEY_ORGANIZATION_ID = "org-id";
    process.env.TURNKEY_WALLET_ADDRESS = "wallet-addr";
    clearConfig();
    const { getConfig } = await import("@/lib/config");
    const config = getConfig();

    expect(config.turnkeyApiBaseUrl).toBe("https://api.turnkey.com");
    expect(config.turnkeyApiPublicKey).toBe("pub-key");
    expect(config.turnkeyApiPrivateKey).toBe("priv-key");
    expect(config.turnkeyOrganizationId).toBe("org-id");
    expect(config.turnkeyWalletAddress).toBe("wallet-addr");
  });

  it("reads dashboard password from env", async () => {
    process.env.KOVA_DASHBOARD_PASSWORD = "my-secret";
    clearConfig();
    const { getConfig } = await import("@/lib/config");
    const config = getConfig();

    expect(config.dashboardPassword).toBe("my-secret");
  });

  it("reads custom port from env", async () => {
    process.env.PORT = "4000";
    clearConfig();
    const { getConfig } = await import("@/lib/config");
    const config = getConfig();

    expect(config.port).toBe(4000);
  });

  it("falls back to localnet for invalid network values", async () => {
    process.env.KOVA_NETWORK = "invalid-network";
    clearConfig();
    const { getConfig } = await import("@/lib/config");
    const config = getConfig();

    expect(config.network).toBe("localnet");
  });

  it("getSolanaNetwork maps localnet to devnet", async () => {
    const { getSolanaNetwork } = await import("@/lib/config");
    expect(getSolanaNetwork("localnet")).toBe("devnet");
    expect(getSolanaNetwork("mainnet-beta")).toBe("mainnet-beta");
    expect(getSolanaNetwork("devnet")).toBe("devnet");
    expect(getSolanaNetwork("testnet")).toBe("testnet");
  });
});
