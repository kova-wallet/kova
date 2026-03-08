/**
 * Environment-based configuration for the Kova Dashboard.
 *
 * All config is read from process.env with sensible defaults.
 * For local development, create a .env.local file.
 * For production, set environment variables directly.
 */

export type NetworkId = "mainnet-beta" | "devnet" | "testnet" | "localnet";
export type StoreType = "memory" | "sqlite";
export type SignerType = "local" | "turnkey" | "env-keypair";

export interface DashboardConfig {
  // ── Network ──────────────────────────────────────────────────────────
  /** Human-readable network label shown in the sidebar */
  networkLabel: string;
  /** Solana network identifier */
  network: NetworkId;
  /** Solana JSON-RPC URL */
  rpcUrl: string;
  /** Whether airdrop is available (devnet/testnet/localnet only) */
  airdropEnabled: boolean;

  // ── Store ────────────────────────────────────────────────────────────
  /** Store backend: "memory" (dev) or "sqlite" (production) */
  storeType: StoreType;
  /** SQLite database path (only used when storeType is "sqlite") */
  sqlitePath: string;

  // ── Signer ───────────────────────────────────────────────────────────
  /** Default signer type for auto-loading wallets */
  signerType: SignerType;
  /** Directory for local wallet keyfiles (JSON arrays or Solana CLI format) */
  walletsDir: string;

  // ── Turnkey (optional) ───────────────────────────────────────────────
  turnkeyApiBaseUrl?: string;
  turnkeyApiPublicKey?: string;
  turnkeyApiPrivateKey?: string;
  turnkeyOrganizationId?: string;
  turnkeyWalletAddress?: string;

  // ── Auth ──────────────────────────────────────────────────────────────
  /** Dashboard password. If set, login is required. */
  dashboardPassword?: string;
  /** Session secret for signing auth cookies */
  sessionSecret: string;

  // ── Misc ──────────────────────────────────────────────────────────────
  /** Airdrop amount in SOL */
  airdropAmountSol: number;
  /** Default polling interval in ms */
  pollIntervalMs: number;
  /** Approval timeout in ms */
  approvalTimeoutMs: number;
  /** Port the dashboard runs on */
  port: number;
}

function resolveNetwork(raw: string | undefined): NetworkId {
  const valid: NetworkId[] = ["mainnet-beta", "devnet", "testnet", "localnet"];
  const value = raw?.toLowerCase() as NetworkId;
  return valid.includes(value) ? value : "localnet";
}

function resolveRpcUrl(network: NetworkId, envUrl: string | undefined): string {
  if (envUrl) return envUrl;
  switch (network) {
    case "mainnet-beta":
      return "https://api.mainnet-beta.solana.com";
    case "devnet":
      return "https://api.devnet.solana.com";
    case "testnet":
      return "https://api.testnet.solana.com";
    case "localnet":
      return "http://localhost:8899";
  }
}

function resolveNetworkLabel(network: NetworkId, envLabel: string | undefined): string {
  if (envLabel) return envLabel;
  switch (network) {
    case "mainnet-beta":
      return "Mainnet";
    case "devnet":
      return "Devnet";
    case "testnet":
      return "Testnet";
    case "localnet":
      return "Localnet";
  }
}

function isAirdropEnabled(network: NetworkId): boolean {
  return network !== "mainnet-beta";
}

/**
 * Load configuration from environment variables.
 * Call once at startup; the result is cached.
 */
function loadConfig(): DashboardConfig {
  const network = resolveNetwork(process.env.KOVA_NETWORK);

  return {
    network,
    networkLabel: resolveNetworkLabel(network, process.env.KOVA_NETWORK_LABEL),
    rpcUrl: resolveRpcUrl(network, process.env.KOVA_RPC_URL),
    airdropEnabled: isAirdropEnabled(network),

    storeType: (process.env.KOVA_STORE_TYPE as StoreType) || "memory",
    sqlitePath: process.env.KOVA_SQLITE_PATH || "./data/kova.db",

    signerType: (process.env.KOVA_SIGNER_TYPE as SignerType) || "local",
    walletsDir: process.env.KOVA_WALLETS_DIR || "../dashboard-demo-helpers/local/wallets",

    turnkeyApiBaseUrl: process.env.TURNKEY_API_BASE_URL,
    turnkeyApiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY,
    turnkeyApiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY,
    turnkeyOrganizationId: process.env.TURNKEY_ORGANIZATION_ID,
    turnkeyWalletAddress: process.env.TURNKEY_WALLET_ADDRESS,

    dashboardPassword: process.env.KOVA_DASHBOARD_PASSWORD,
    sessionSecret: process.env.KOVA_SESSION_SECRET || "kova-dev-secret-change-me",

    airdropAmountSol: Number(process.env.KOVA_AIRDROP_SOL) || 1,
    pollIntervalMs: Number(process.env.KOVA_POLL_INTERVAL_MS) || 10_000,
    approvalTimeoutMs: Number(process.env.KOVA_APPROVAL_TIMEOUT_MS) || 120_000,
    port: Number(process.env.PORT) || 3000,
  };
}

// Singleton — loaded once, cached for the process lifetime.
// Uses globalThis to survive Next.js dev-mode module re-evaluation.
const CONFIG_KEY = "__kova_dashboard_config__" as const;

export function getConfig(): DashboardConfig {
  const g = globalThis as unknown as Record<string, DashboardConfig>;
  if (!g[CONFIG_KEY]) {
    g[CONFIG_KEY] = loadConfig();
  }
  return g[CONFIG_KEY];
}

/**
 * Solana network param for SolanaAdapter.
 * Localnet uses "devnet" since solana-test-validator emulates devnet.
 */
export function getSolanaNetwork(network: NetworkId): "mainnet-beta" | "devnet" | "testnet" {
  return network === "localnet" ? "devnet" : network;
}
