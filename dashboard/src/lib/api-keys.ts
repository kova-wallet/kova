/**
 * API key management for agent authentication.
 *
 * The dashboard issues API keys that agents use to authenticate
 * when calling the execute() endpoint. Keys are stored in memory
 * (with globalThis persistence for Next.js dev mode).
 *
 * Key format: "kova_<random-hex>"
 * Keys are scoped to a wallet address — an agent must present a valid
 * key for the wallet it's trying to operate on.
 */

import { randomBytes, createHmac } from "node:crypto";

export interface ApiKey {
  /** The key ID (public, used for identification) */
  id: string;
  /** The hashed key (stored, never the raw key) */
  hash: string;
  /** Human-readable label */
  label: string;
  /** Wallet address this key is scoped to, or "*" for all wallets */
  walletAddress: string;
  /** Creation timestamp */
  createdAt: number;
  /** Last used timestamp */
  lastUsedAt: number | null;
  /** Whether the key is active */
  active: boolean;
}

// Storage
const KEYS_GLOBAL_KEY = "__kova_api_keys__" as const;

function getKeyStore(): Map<string, ApiKey> {
  const g = globalThis as unknown as Record<string, Map<string, ApiKey>>;
  if (!g[KEYS_GLOBAL_KEY]) {
    g[KEYS_GLOBAL_KEY] = new Map();
  }
  return g[KEYS_GLOBAL_KEY];
}

function getSecret(): string {
  return process.env.KOVA_SESSION_SECRET || "kova-dev-secret-change-me";
}

function hashKey(rawKey: string): string {
  return createHmac("sha256", getSecret()).update(rawKey).digest("hex");
}

/**
 * Create a new API key. Returns the raw key (only shown once).
 */
export function createApiKey(label: string, walletAddress: string): { key: string; id: string } {
  const rawKey = `kova_${randomBytes(24).toString("hex")}`;
  const id = `key_${randomBytes(8).toString("hex")}`;
  const hash = hashKey(rawKey);

  const entry: ApiKey = {
    id,
    hash,
    label,
    walletAddress,
    createdAt: Date.now(),
    lastUsedAt: null,
    active: true,
  };

  getKeyStore().set(id, entry);
  return { key: rawKey, id };
}

/**
 * Validate an API key and return its metadata if valid.
 * Updates lastUsedAt on successful validation.
 */
export function validateApiKey(rawKey: string): ApiKey | null {
  if (!rawKey || !rawKey.startsWith("kova_")) return null;

  const hash = hashKey(rawKey);
  const store = getKeyStore();

  for (const entry of store.values()) {
    if (entry.hash === hash && entry.active) {
      entry.lastUsedAt = Date.now();
      return entry;
    }
  }

  return null;
}

/**
 * Check if an API key is authorized for a specific wallet address.
 */
export function isKeyAuthorizedForWallet(key: ApiKey, walletAddress: string): boolean {
  return key.walletAddress === "*" || key.walletAddress === walletAddress;
}

/**
 * List all API keys (without hashes).
 */
export function listApiKeys(): Omit<ApiKey, "hash">[] {
  return Array.from(getKeyStore().values()).map(({ hash: _, ...rest }) => rest);
}

/**
 * Revoke an API key.
 */
export function revokeApiKey(id: string): boolean {
  const store = getKeyStore();
  const entry = store.get(id);
  if (!entry) return false;
  entry.active = false;
  return true;
}

/**
 * Delete an API key permanently.
 */
export function deleteApiKey(id: string): boolean {
  return getKeyStore().delete(id);
}
