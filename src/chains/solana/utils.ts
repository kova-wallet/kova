/**
 * Solana utility functions — token registry, amount conversion, address validation, ATA helpers.
 */

import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

// ── Token Registry ──────────────────────────────────────────────────

/** Well-known SPL token mint addresses and decimals (mainnet) */
export const TOKEN_MINTS: Record<string, { mint: string; decimals: number }> = {
  SOL: { mint: "So11111111111111111111111111111111111111112", decimals: 9 },
  USDC: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
  USDT: { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6 },
};

/** Devnet overrides (some tokens have different mint addresses on devnet) */
export const DEVNET_TOKEN_MINTS: Record<string, { mint: string; decimals: number }> = {
  SOL: { mint: "So11111111111111111111111111111111111111112", decimals: 9 },
  USDC: { mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", decimals: 6 },
};

// ── Token Helpers ──────────────────────────────────────────────────

/** Check if a token symbol refers to native SOL */
export function isNativeSOL(token: string): boolean {
  return token.toUpperCase() === "SOL";
}

/**
 * Resolve a token symbol or mint address to a PublicKey.
 * Accepts both "USDC" (symbol lookup) and raw base58 mint addresses.
 */
export function resolveTokenMint(token: string, isDevnet?: boolean): PublicKey | null {
  const registry = isDevnet ? DEVNET_TOKEN_MINTS : TOKEN_MINTS;
  const entry = registry[token.toUpperCase()];
  if (entry) return new PublicKey(entry.mint);

  // Try to parse as a raw mint address
  try {
    return new PublicKey(token);
  } catch {
    return null;
  }
}

/** Get decimals for a well-known token. Returns null for unknown tokens. */
export function getTokenDecimals(token: string, isDevnet?: boolean): number | null {
  const registry = isDevnet ? DEVNET_TOKEN_MINTS : TOKEN_MINTS;
  const entry = registry[token.toUpperCase()];
  return entry?.decimals ?? null;
}

// ── Amount Conversion (BigInt-safe) ──────────────────────────────────

/**
 * Convert a human-readable amount (e.g., "1.5") to the smallest unit (e.g., lamports).
 * Uses string-based arithmetic to avoid floating-point precision issues.
 */
export function toSmallestUnit(amount: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(amount)) {
    throw new SolanaAdapterError(
      "INVALID_AMOUNT",
      `Invalid amount: "${amount}". Must be a non-negative decimal number.`,
    );
  }
  const parts = amount.split(".");
  const whole = parts[0] ?? "0";
  const fractional = (parts[1] ?? "").padEnd(decimals, "0").slice(0, decimals);
  const result = BigInt(whole + fractional);
  if (result <= 0n) {
    throw new SolanaAdapterError(
      "INVALID_AMOUNT",
      `Amount must be positive, got: ${amount}`,
    );
  }
  return result;
}

/**
 * Convert a smallest-unit amount (e.g., lamports) back to a human-readable string.
 */
export function fromSmallestUnit(amount: bigint, decimals: number): string {
  const str = amount.toString().padStart(decimals + 1, "0");
  const whole = str.slice(0, str.length - decimals);
  const frac = str.slice(str.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

// ── Address Validation ──────────────────────────────────────────────

/** Validate a Solana address using actual PublicKey parsing */
export function isValidSolanaAddress(address: string): boolean {
  if (!address || typeof address !== "string") return false;
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

// ── ATA Helpers ──────────────────────────────────────────────────

/** Derive the associated token account address for a wallet + mint pair */
export function deriveATA(wallet: PublicKey, mint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, wallet);
}

// ── Error Types ──────────────────────────────────────────────────

export class SolanaAdapterError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SolanaAdapterError";
    this.code = code;
  }
}

// ── Network Detection ──────────────────────────────────────────────

/** Detect if an RPC URL points to devnet */
export function isDevnetUrl(rpcUrl: string): boolean {
  return rpcUrl.includes("devnet");
}
