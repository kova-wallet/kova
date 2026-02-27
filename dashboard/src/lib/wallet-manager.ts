/**
 * Server-side wallet singleton. All API routes share this state.
 * Devnet only — uses LocalSigner + MemoryStore.
 */

import { Connection, Keypair } from "@solana/web3.js";
import { AgentWallet } from "@kova/core/wallet.js";
import { PolicyEngine } from "@kova/policy/engine.js";
import { Policy } from "@kova/policy/builder.js";
import { LocalSigner } from "@kova/signers/local.js";
import { SolanaAdapter } from "@kova/chains/solana/adapter.js";
import { MemoryStore } from "@kova/stores/memory.js";
import type { PolicyConfig } from "@kova/policy/types.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { DashboardApprovalChannel } from "./approval-channel";
import { policyConfigToRules } from "./policy-helpers";
import { DEVNET_RPC_URL, AIRDROP_AMOUNT_LAMPORTS } from "./constants";

const KEYPAIR_PATH = resolve(process.cwd(), "wallet", "keypair.json");

interface WalletState {
  wallet: AgentWallet | null;
  store: MemoryStore | null;
  approvalChannel: DashboardApprovalChannel | null;
  address: string | null;
  policyConfig: PolicyConfig | null;
  // Store secret key bytes for wallet re-creation on policy change.
  // DEVNET DEMO ONLY.
  keypairBytes: Uint8Array | null;
}

const state: WalletState = {
  wallet: null,
  store: null,
  approvalChannel: null,
  address: null,
  policyConfig: null,
  keypairBytes: null,
};

function getConnection(): Connection {
  return new Connection(DEVNET_RPC_URL, "confirmed");
}

/**
 * Load the persisted keypair from wallet/keypair.json on server startup
 * so the dashboard is ready immediately without manual wallet creation.
 */
function autoLoadKeypair(): void {
  if (state.wallet) return; // already initialized
  if (!existsSync(KEYPAIR_PATH)) return;

  try {
    const raw = JSON.parse(readFileSync(KEYPAIR_PATH, "utf-8")) as number[];
    const keypair = Keypair.fromSecretKey(Uint8Array.from(raw));
    const policyConfig = buildDefaultPolicyConfig();
    const store = new MemoryStore({ dangerouslyAllowInProduction: true });
    const approvalChannel = new DashboardApprovalChannel();

    state.wallet = buildWalletFromState(keypair, policyConfig, store, approvalChannel);
    state.store = store;
    state.approvalChannel = approvalChannel;
    state.address = keypair.publicKey.toBase58();
    state.policyConfig = policyConfig;
    state.keypairBytes = keypair.secretKey;

    console.log(`[kova] Auto-loaded wallet: ${state.address}`);
  } catch (e) {
    console.error("[kova] Failed to auto-load keypair:", e);
  }
}

// Auto-load on module initialization (server startup)
autoLoadKeypair();

function buildDefaultPolicyConfig(): PolicyConfig {
  return Policy.create("default")
    .spendingLimit({
      perTransaction: { amount: "10", token: "SOL" },
      daily: { amount: "50", token: "SOL" },
    })
    .rateLimit({ maxTransactionsPerMinute: 5 })
    .build()
    .toJSON();
}

function buildWalletFromState(
  keypair: Keypair,
  config: PolicyConfig,
  store: MemoryStore,
  approvalChannel: DashboardApprovalChannel
): AgentWallet {
  const rules = policyConfigToRules(config);
  if (rules.length === 0) {
    throw new Error("Policy must have at least one rule configured");
  }

  const engine = new PolicyEngine(rules, store, approvalChannel);

  return new AgentWallet({
    signer: new LocalSigner(keypair, { dangerouslyAllowInProduction: true }),
    chain: new SolanaAdapter({ rpcUrl: DEVNET_RPC_URL, network: "devnet" }),
    policy: engine,
    store,
    approval: approvalChannel,
    dangerouslyAllowAutoHmacKey: true,
  });
}

export async function createWallet(options?: {
  importedSecretKey?: number[];
}): Promise<string> {
  // Destroy existing wallet if any
  if (state.wallet) {
    await state.wallet.destroy();
  }

  const keypair = options?.importedSecretKey
    ? Keypair.fromSecretKey(Uint8Array.from(options.importedSecretKey))
    : Keypair.generate();

  const policyConfig = buildDefaultPolicyConfig();
  const store = new MemoryStore({ dangerouslyAllowInProduction: true });
  const approvalChannel = new DashboardApprovalChannel();

  const wallet = buildWalletFromState(
    keypair,
    policyConfig,
    store,
    approvalChannel
  );

  state.wallet = wallet;
  state.store = store;
  state.approvalChannel = approvalChannel;
  state.address = keypair.publicKey.toBase58();
  state.policyConfig = policyConfig;
  state.keypairBytes = keypair.secretKey;

  return state.address;
}

export async function applyPolicy(config: PolicyConfig): Promise<void> {
  if (!state.keypairBytes) {
    throw new Error("No wallet created yet");
  }

  // Validate using the SDK's Policy.fromJSON (runs all validations)
  Policy.fromJSON(config);

  // Destroy current wallet
  if (state.wallet) {
    await state.wallet.destroy();
  }

  const keypair = Keypair.fromSecretKey(state.keypairBytes);
  const store = new MemoryStore({ dangerouslyAllowInProduction: true });
  // Reuse existing approval channel so SSE listeners stay connected
  const approvalChannel =
    state.approvalChannel ?? new DashboardApprovalChannel();

  const wallet = buildWalletFromState(
    keypair,
    config,
    store,
    approvalChannel
  );

  state.wallet = wallet;
  state.store = store;
  state.approvalChannel = approvalChannel;
  state.policyConfig = config;
}

export async function requestAirdrop(): Promise<string> {
  if (!state.address) {
    throw new Error("No wallet created yet");
  }

  const connection = getConnection();
  const pubkey = Keypair.fromSecretKey(state.keypairBytes!).publicKey;
  const signature = await connection.requestAirdrop(
    pubkey,
    AIRDROP_AMOUNT_LAMPORTS
  );
  await connection.confirmTransaction(signature, "confirmed");
  return signature;
}

export function getWallet(): AgentWallet | null {
  return state.wallet;
}

export function getApprovalChannel(): DashboardApprovalChannel | null {
  return state.approvalChannel;
}

export function getPolicyConfig(): PolicyConfig | null {
  return state.policyConfig;
}

export function getAddress(): string | null {
  return state.address;
}

export function isInitialized(): boolean {
  return state.wallet !== null;
}

export async function destroyWallet(): Promise<void> {
  if (state.wallet) {
    await state.wallet.destroy();
  }
  if (state.approvalChannel) {
    state.approvalChannel.destroy();
  }
  if (state.store) {
    state.store.destroy();
  }
  state.wallet = null;
  state.store = null;
  state.approvalChannel = null;
  state.address = null;
  state.policyConfig = null;
  state.keypairBytes = null;
}
