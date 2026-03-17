/**
 * Pyth Oracle Price Provider — reads Pyth on-chain price feeds for USD valuation.
 *
 * Returns a `priceProvider` function compatible with `SolanaAdapterConfig.priceProvider`.
 * Reads Pyth price account data directly from the Solana RPC connection — no external
 * HTTP APIs, no additional dependencies beyond @solana/web3.js.
 *
 * SECURITY:
 * - Fail-closed: returns null on any error (adapter throws PRICE_UNAVAILABLE → DENY)
 * - Staleness: rejects prices older than maxStalenessSeconds (default 30s)
 * - Confidence: rejects prices with confidence interval > maxConfidencePercent (default 2%)
 * - Cache: in-memory TTL cache to reduce RPC load (default 5s)
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { resolveTokenMint, TOKEN_MINTS } from "../chains/solana/utils.js";

// ── Pyth Price Account Layout ──────────────────────────────────────────
//
// Pyth on-chain price accounts use a binary struct layout. We parse the
// fields we need (price, confidence, exponent, publishTime) directly to
// avoid requiring @pythnetwork/client as a dependency.
//
// Reference: https://docs.pyth.network/price-feeds/best-practices
//
// Layout (V2 price account, relevant offsets):
//   Bytes 0-3:    magic (u32, 0xa1b2c3d4)
//   Bytes 4-7:    version (u32)
//   Bytes 8-11:   type (u32, 3 = price)
//   Bytes 12-15:  size (u32)
//   ...
//   Byte 224:     status (u32) — 1 = trading
//   ...
//   Bytes 208-215: aggregate price (i64, little-endian)
//   Bytes 216-223: aggregate confidence (u64, little-endian)
//   Bytes 224-227: status (u32)
//   ...
//   Bytes 232-235: exponent (i32, little-endian)
//   ...
//   Bytes 296-303: publishTime (i64, little-endian — Unix timestamp)

const PYTH_MAGIC = 0xa1b2c3d4;
const PYTH_PRICE_TYPE = 3;
const PYTH_STATUS_TRADING = 1;

interface PythPriceData {
  price: number;
  confidence: number;
  exponent: number;
  publishTime: number;
  status: number;
}

/**
 * Parse a Pyth V2 price account from raw account data.
 * Returns null if the data is invalid or not a price account.
 */
export function parsePythPriceAccount(data: Buffer): PythPriceData | null {
  // Minimum size check — Pyth price accounts are ~3312 bytes
  if (data.length < 304) {
    return null;
  }

  const magic = data.readUInt32LE(0);
  if (magic !== PYTH_MAGIC) {
    return null;
  }

  const type = data.readUInt32LE(8);
  if (type !== PYTH_PRICE_TYPE) {
    return null;
  }

  // Read aggregate price as i64 (little-endian)
  const priceBigInt = data.readBigInt64LE(208);
  // Read aggregate confidence as u64 (little-endian)
  const confidenceBigInt = data.readBigUInt64LE(216);
  // Read status
  const status = data.readUInt32LE(224);
  // Read exponent as i32 (little-endian)
  const exponent = data.readInt32LE(232);
  // Read publishTime as i64
  const publishTimeBigInt = data.readBigInt64LE(296);

  const price = Number(priceBigInt) * Math.pow(10, exponent);
  const confidence = Number(confidenceBigInt) * Math.pow(10, exponent);
  const publishTime = Number(publishTimeBigInt);

  return { price, confidence, exponent, publishTime, status };
}

// ── Default Feed Maps ──────────────────────────────────────────────────

/** Mainnet Pyth price feed accounts (token mint → Pyth feed address) */
export const PYTH_MAINNET_FEEDS: Readonly<Record<string, string>> = Object.freeze({
  // SOL/USD
  "So11111111111111111111111111111111111111112": "H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG",
  // USDC/USD
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD",
  // USDT/USD
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": "3vxLXJqLqF3JG5TCbYycbKWRBbCJQLxOmMGCk7AXnkZZ",
});

/** Devnet Pyth price feed accounts (token mint → Pyth feed address) */
export const PYTH_DEVNET_FEEDS: Readonly<Record<string, string>> = Object.freeze({
  // SOL/USD (devnet)
  "So11111111111111111111111111111111111111112": "J83w4HKfqxwcYvy4GcpTFvGLM3jGUxJaeSPhDqoVDhTH",
  // USDC/USD (devnet — devnet USDC has a different mint)
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": "5SSkXsEKQepHHAewytPVwdej4epN1nxgLVM84L4KXgy7",
});

// ── Reverse Symbol Map ─────────────────────────────────────────────────

/**
 * Build a reverse map from token symbol → mint address for resolving
 * symbols passed to priceProvider (e.g., "SOL" → mint address).
 */
function buildSymbolToMintMap(isDevnet: boolean): Record<string, string> {
  const map: Record<string, string> = {};
  // Use the SDK's token registry for consistency
  const registry = isDevnet
    ? { SOL: "So11111111111111111111111111111111111111112", USDC: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" }
    : Object.fromEntries(Object.entries(TOKEN_MINTS).map(([sym, entry]) => [sym, entry.mint]));
  for (const [symbol, mint] of Object.entries(registry)) {
    map[symbol.toUpperCase()] = mint;
  }
  return map;
}

// ── Configuration ──────────────────────────────────────────────────────

export interface PythPriceProviderConfig {
  /** Custom feed map (token mint → Pyth feed address). Merged with defaults. */
  feedMap?: Record<string, string>;
  /** Maximum price age in seconds before considered stale (default: 30) */
  maxStalenessSeconds?: number;
  /** Maximum confidence interval as a ratio of price (default: 0.02 = 2%) */
  maxConfidencePercent?: number;
  /** Cache TTL in milliseconds (default: 5000) */
  cacheTtlMs?: number;
  /** Network: "mainnet-beta" or "devnet" (default: "mainnet-beta") */
  network?: "mainnet-beta" | "devnet";
}

// ── Price Provider Factory ─────────────────────────────────────────────

export interface PythPriceProvider {
  /** Get the USD price for a token (by symbol or mint address). Returns null if unavailable. */
  (token: string): Promise<number | null>;
  /** Clear the price cache and release resources. */
  destroy: () => void;
}

/**
 * Create a Pyth-backed price provider compatible with SolanaAdapterConfig.priceProvider.
 *
 * @param connection - Solana RPC connection (reuses the adapter's existing connection)
 * @param config - Optional configuration overrides
 * @returns A price provider function with a `destroy()` method for cleanup
 *
 * @example
 * ```typescript
 * import { Connection } from "@solana/web3.js";
 * import { SolanaAdapter } from "@kova-sdk/wallet";
 * import { createPythPriceProvider } from "@kova-sdk/wallet/oracles";
 *
 * const connection = new Connection("https://api.mainnet-beta.solana.com");
 * const adapter = new SolanaAdapter({
 *   rpcUrl: "https://api.mainnet-beta.solana.com",
 *   priceProvider: createPythPriceProvider(connection),
 * });
 * ```
 */
export function createPythPriceProvider(
  connection: Connection,
  config?: PythPriceProviderConfig,
): PythPriceProvider {
  const isDevnet = config?.network === "devnet";
  const defaultFeeds = isDevnet ? PYTH_DEVNET_FEEDS : PYTH_MAINNET_FEEDS;
  const feedMap: Record<string, string> = { ...defaultFeeds, ...config?.feedMap };
  const maxStaleness = config?.maxStalenessSeconds ?? 30;
  const maxConfidence = config?.maxConfidencePercent ?? 0.02;
  const cacheTtl = config?.cacheTtlMs ?? 5000;

  // Symbol → mint reverse map for resolving token symbols
  const symbolToMint = buildSymbolToMintMap(isDevnet);

  // In-memory price cache: mint address → { price, fetchedAt }
  const cache = new Map<string, { price: number; fetchedAt: number }>();

  /**
   * Resolve a token identifier (symbol or mint address) to a mint address.
   * Returns null if the token cannot be resolved.
   */
  function resolveToMint(token: string): string | null {
    // Check if it's a known symbol first
    const upper = token.toUpperCase();
    if (symbolToMint[upper]) {
      return symbolToMint[upper];
    }

    // Try resolving via the SDK's token registry (handles mint addresses)
    const pubkey = resolveTokenMint(token, isDevnet);
    if (pubkey) {
      return pubkey.toBase58();
    }

    return null;
  }

  const provider = async function pythPriceProvider(token: string): Promise<number | null> {
    // Resolve token to mint address
    const mint = resolveToMint(token);
    if (!mint) {
      return null;
    }

    // Check cache
    const cached = cache.get(mint);
    if (cached && Date.now() - cached.fetchedAt < cacheTtl) {
      return cached.price;
    }

    // Look up the Pyth feed address for this mint
    const feedAddress = feedMap[mint];
    if (!feedAddress) {
      return null;
    }

    try {
      // Fetch Pyth price account data from on-chain
      const accountInfo = await connection.getAccountInfo(new PublicKey(feedAddress));
      if (!accountInfo?.data) {
        return null;
      }

      // Parse the Pyth price account binary data
      const priceData = parsePythPriceAccount(accountInfo.data as Buffer);
      if (!priceData) {
        return null;
      }

      // Reject if not in trading status
      if (priceData.status !== PYTH_STATUS_TRADING) {
        return null;
      }

      // Validate staleness using publishTime (Unix timestamp) — avoids extra getSlot() RPC call
      const nowSeconds = Math.floor(Date.now() / 1000);
      const ageSeconds = nowSeconds - priceData.publishTime;
      if (ageSeconds > maxStaleness || ageSeconds < 0) {
        return null;
      }

      // Validate confidence interval
      if (priceData.price > 0 && priceData.confidence / priceData.price > maxConfidence) {
        return null;
      }

      // Validate price is positive and finite
      if (!Number.isFinite(priceData.price) || priceData.price <= 0) {
        return null;
      }

      // Cache the result
      cache.set(mint, { price: priceData.price, fetchedAt: Date.now() });

      return priceData.price;
    } catch {
      // Fail-closed: return null on any error
      return null;
    }
  } as PythPriceProvider;

  provider.destroy = () => {
    cache.clear();
  };

  return provider;
}
