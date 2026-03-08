/**
 * Server-side wallet singleton. All API routes share this state.
 *
 * Supports multiple store backends (MemoryStore, SqliteStore) and
 * multiple signer types (LocalSigner, TurnkeyProvider via MpcSigner).
 *
 * Configuration is driven by environment variables via getConfig().
 * Wallet creation is handled by the WalletSourceRegistry.
 *
 * Uses globalThis to persist state across Next.js dev-mode module
 * re-evaluations, which create separate compilation contexts for
 * each API route.
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { AgentWallet } from "@kova/core/wallet.js";
import { PolicyEngine } from "@kova/policy/engine.js";
import { Policy } from "@kova/policy/builder.js";
import { LocalSigner } from "@kova/signers/local.js";
import { SolanaAdapter } from "@kova/chains/solana/adapter.js";
import { MemoryStore } from "@kova/stores/memory.js";
import { SqliteStore } from "@kova/stores/sqlite.js";
import { PrefixedStore } from "@kova/stores/prefixed.js";
import type { Store } from "@kova/stores/interface.js";
import type { Signer } from "@kova/signers/interface.js";
import type { PolicyConfig } from "@kova/policy/types.js";
import { existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { DashboardApprovalChannel } from "./approval-channel";
import { policyConfigToRules } from "./policy-helpers";
import { getConfig, getSolanaNetwork } from "./config";
import { getWalletSourceRegistry } from "./wallet-sources";
import type { WalletSourceConfig, WalletSourceType } from "./wallet-sources";

/** Metadata for a loaded wallet — stored per wallet for multi-wallet support. */
export interface LoadedWallet {
  wallet: AgentWallet;
  store: Store;
  approvalChannel: DashboardApprovalChannel;
  address: string;
  policyConfig: PolicyConfig;
  keypairBytes: Uint8Array | null;
  sourceLabel: string;
  sourceType: WalletSourceType;
}

interface WalletManagerState {
  /** All loaded wallets, keyed by address */
  wallets: Map<string, LoadedWallet>;
  /** Currently active wallet address */
  activeAddress: string | null;
  /** Shared base store — all wallets use PrefixedStore wrappers around this */
  baseStore: Store | null;
}

// Persist state on globalThis so it survives Next.js dev-mode module re-evaluation
const GLOBAL_KEY = "__kova_wallet_state_v2__" as const;

function getManagerState(): WalletManagerState {
  const g = globalThis as unknown as Record<string, WalletManagerState>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      wallets: new Map(),
      activeAddress: null,
      baseStore: null,
    };
  }
  return g[GLOBAL_KEY];
}

function getConnection(): Connection {
  const config = getConfig();
  return new Connection(config.rpcUrl, "confirmed");
}

/**
 * Create the shared base Store instance (singleton).
 * All wallets share this backend but use PrefixedStore for isolation.
 */
function getBaseStore(): Store {
  const mgr = getManagerState();
  if (!mgr.baseStore) {
    const config = getConfig();
    if (config.storeType === "sqlite") {
      const dbPath = resolve(process.cwd(), config.sqlitePath);
      const dbDir = dirname(dbPath);
      if (!existsSync(dbDir)) {
        mkdirSync(dbDir, { recursive: true });
      }
      mgr.baseStore = new SqliteStore({ path: dbPath });
    } else {
      mgr.baseStore = new MemoryStore({ dangerouslyAllowInProduction: true });
    }
  }
  return mgr.baseStore;
}

/**
 * Create a PrefixedStore for a specific wallet address.
 * Uses the shared base store with wallet address as prefix for isolation.
 */
export function createStore(walletAddress?: string): Store {
  const base = getBaseStore();
  if (walletAddress) {
    // Use first 16 chars of address as prefix (safe for PrefixedStore's 64-char limit)
    const prefix = `wallet:${walletAddress.slice(0, 16)}`;
    return new PrefixedStore(base, prefix);
  }
  return base;
}

/**
 * Auto-load wallet on startup based on environment configuration.
 */
function autoLoadWallet(): void {
  const mgrState = getManagerState();
  if (mgrState.wallets.size > 0) return;

  const registry = getWalletSourceRegistry();

  registry.resolveFromEnv().then(async (resolved) => {
    const policyConfig = buildDefaultPolicyConfig();
    const store = createStore(resolved.address);
    const approvalChannel = new DashboardApprovalChannel();

    const wallet = buildWalletFromSigner(resolved.signer, policyConfig, store, approvalChannel);

    const loaded: LoadedWallet = {
      wallet,
      store,
      approvalChannel,
      address: resolved.address,
      policyConfig,
      keypairBytes: resolved.keypairBytes,
      sourceLabel: resolved.sourceLabel,
      sourceType: resolved.sourceType,
    };

    mgrState.wallets.set(resolved.address, loaded);
    mgrState.activeAddress = resolved.address;

    const config = getConfig();
    console.log(`[kova] Auto-loaded wallet (${resolved.sourceLabel}) on ${config.networkLabel}: ${resolved.address}`);
  }).catch((e) => {
    // Non-fatal — user can create wallet from UI
    console.log("[kova] No wallet auto-loaded:", (e as Error).message);
  });
}

autoLoadWallet();

function buildDefaultPolicyConfig(): PolicyConfig {
  const config = getConfig();
  return Policy.create("default")
    .spendingLimit({
      perTransaction: { amount: "10", token: "SOL" },
      daily: { amount: "10", token: "SOL" },
    })
    .requireApproval({
      above: { amount: "0.01", token: "SOL" },
      timeout: config.approvalTimeoutMs,
    })
    .rateLimit({ maxTransactionsPerMinute: 5 })
    .build()
    .toJSON();
}

function buildWalletFromSigner(
  signer: Signer,
  policyConfig: PolicyConfig,
  store: Store,
  approvalChannel: DashboardApprovalChannel
): AgentWallet {
  const rules = policyConfigToRules(policyConfig);
  if (rules.length === 0) {
    throw new Error("Policy must have at least one rule configured");
  }

  const config = getConfig();
  const engine = new PolicyEngine(rules, store, approvalChannel);

  return new AgentWallet({
    signer,
    chain: new SolanaAdapter({
      rpcUrl: config.rpcUrl,
      network: getSolanaNetwork(config.network),
    }),
    policy: engine,
    store,
    approval: approvalChannel,
    dangerouslyAllowAutoHmacKey: true,
    verboseErrors: true,
  });
}

// ── Active wallet helper ───────────────────────────────────────────────────

function getActiveLoaded(): LoadedWallet | null {
  const mgr = getManagerState();
  if (!mgr.activeAddress) return null;
  return mgr.wallets.get(mgr.activeAddress) ?? null;
}

// ---------------------------------------------------------------------------
// Wallet listing / switching
// ---------------------------------------------------------------------------

/** List all loaded wallets with their metadata. */
export function listLoadedWallets(): {
  address: string;
  sourceLabel: string;
  sourceType: string;
  isActive: boolean;
}[] {
  const mgr = getManagerState();
  return Array.from(mgr.wallets.values()).map((w) => ({
    address: w.address,
    sourceLabel: w.sourceLabel,
    sourceType: w.sourceType,
    isActive: w.address === mgr.activeAddress,
  }));
}

/** Switch the active wallet to a different loaded wallet. */
export function switchWallet(address: string): void {
  const mgr = getManagerState();
  if (!mgr.wallets.has(address)) {
    throw new Error(`No loaded wallet with address: ${address}`);
  }
  mgr.activeAddress = address;
}

export function getActiveWalletName(): string | null {
  const loaded = getActiveLoaded();
  return loaded?.sourceLabel ?? null;
}

export function getSignerType(): string | null {
  const loaded = getActiveLoaded();
  return loaded?.sourceType ?? null;
}

// ---------------------------------------------------------------------------
// Wallet creation via WalletSourceRegistry
// ---------------------------------------------------------------------------

/**
 * Create (or load) a wallet from a WalletSourceConfig.
 * The wallet is added to the loaded wallets map and set as active.
 */
export async function createWalletFromSource(sourceConfig: WalletSourceConfig): Promise<string> {
  const registry = getWalletSourceRegistry();
  const resolved = await registry.resolve(sourceConfig);

  const policyConfig = buildDefaultPolicyConfig();
  const store = createStore(resolved.address);
  const approvalChannel = new DashboardApprovalChannel();

  const wallet = buildWalletFromSigner(resolved.signer, policyConfig, store, approvalChannel);

  const loaded: LoadedWallet = {
    wallet,
    store,
    approvalChannel,
    address: resolved.address,
    policyConfig,
    keypairBytes: resolved.keypairBytes,
    sourceLabel: resolved.sourceLabel,
    sourceType: resolved.sourceType,
  };

  const mgr = getManagerState();
  mgr.wallets.set(resolved.address, loaded);
  mgr.activeAddress = resolved.address;

  return resolved.address;
}

/**
 * Backwards-compatible createWallet — wraps createWalletFromSource.
 */
export async function createWallet(options?: {
  importedSecretKey?: number[];
  signerType?: "local" | "turnkey";
  turnkeyConfig?: {
    apiBaseUrl: string;
    apiPublicKey: string;
    apiPrivateKey: string;
    organizationId: string;
    walletAddress: string;
  };
}): Promise<string> {
  if (options?.signerType === "turnkey" && options.turnkeyConfig) {
    return createWalletFromSource({ type: "turnkey", turnkey: options.turnkeyConfig });
  }
  if (options?.importedSecretKey) {
    return createWalletFromSource({
      type: "secret-key",
      secretKey: JSON.stringify(options.importedSecretKey),
    });
  }
  return createWalletFromSource({ type: "generate" });
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export async function applyPolicy(policyConf: PolicyConfig): Promise<void> {
  const loaded = getActiveLoaded();
  if (!loaded) {
    throw new Error("No wallet created yet");
  }

  Policy.fromJSON(policyConf);

  await loaded.wallet.destroy();

  const store = createStore(loaded.address);
  const approvalChannel = loaded.approvalChannel ?? new DashboardApprovalChannel();

  let signer: Signer;
  if (loaded.keypairBytes) {
    signer = new LocalSigner(
      Keypair.fromSecretKey(loaded.keypairBytes),
      { dangerouslyAllowInProduction: true }
    );
  } else if (loaded.sourceType === "turnkey") {
    // Re-resolve from env for Turnkey signers
    const registry = getWalletSourceRegistry();
    const resolved = await registry.resolve({ type: "env" });
    signer = resolved.signer;
  } else {
    throw new Error("Cannot rebuild wallet: no signer available");
  }

  const wallet = buildWalletFromSigner(signer, policyConf, store, approvalChannel);

  loaded.wallet = wallet;
  loaded.store = store;
  loaded.approvalChannel = approvalChannel;
  loaded.policyConfig = policyConf;
}

// ---------------------------------------------------------------------------
// Airdrop
// ---------------------------------------------------------------------------

export async function requestAirdrop(): Promise<string> {
  const config = getConfig();
  const loaded = getActiveLoaded();
  if (!loaded) {
    throw new Error("No wallet created yet");
  }
  if (!config.airdropEnabled) {
    throw new Error("Airdrop is not available on this network");
  }

  const connection = getConnection();
  const pubkey = new PublicKey(loaded.address);
  const lamports = config.airdropAmountSol * 1_000_000_000;
  const signature = await connection.requestAirdrop(pubkey, lamports);
  await connection.confirmTransaction(signature, "confirmed");
  return signature;
}

// ---------------------------------------------------------------------------
// Accessors (for active wallet)
// ---------------------------------------------------------------------------

export function getWallet(): AgentWallet | null {
  return getActiveLoaded()?.wallet ?? null;
}

export function getApprovalChannel(): DashboardApprovalChannel | null {
  return getActiveLoaded()?.approvalChannel ?? null;
}

export function getPolicyConfig(): PolicyConfig | null {
  return getActiveLoaded()?.policyConfig ?? null;
}

export function getAddress(): string | null {
  return getActiveLoaded()?.address ?? null;
}

export function isInitialized(): boolean {
  return getActiveLoaded() !== null;
}

// ---------------------------------------------------------------------------
// Destroy
// ---------------------------------------------------------------------------

/** Destroy the active wallet and remove it from loaded wallets. */
export async function destroyWallet(): Promise<void> {
  const mgr = getManagerState();
  const loaded = getActiveLoaded();
  if (!loaded) return;

  await loaded.wallet.destroy();
  loaded.approvalChannel.destroy();
  mgr.wallets.delete(loaded.address);

  // Switch to another wallet if available, or set to null
  const remaining = Array.from(mgr.wallets.keys());
  mgr.activeAddress = remaining.length > 0 ? remaining[0]! : null;
}

/** Destroy all loaded wallets. */
export async function destroyAllWallets(): Promise<void> {
  const mgr = getManagerState();
  for (const loaded of mgr.wallets.values()) {
    await loaded.wallet.destroy();
    loaded.approvalChannel.destroy();
  }
  mgr.wallets.clear();
  mgr.activeAddress = null;
}
