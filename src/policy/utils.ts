/**
 * Shared policy utility functions.
 *
 * MED-06 fix: Extracted from spending-limit.ts, allowlist.ts, and approval-gate.ts
 * to prevent normalization mismatches when one copy is updated and others are not.
 */

import { TOKEN_MINTS } from "../chains/solana/utils.js";

/**
 * M3 fix: Reverse lookup table mapping known token mint addresses to their canonical
 * uppercase symbol. Built from TOKEN_MINTS so that both "USDC" and
 * "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" normalize to the same canonical
 * mint address, preventing spending limit bypass via symbol/address mismatch.
 */
const MINT_TO_SYMBOL: ReadonlyMap<string, string> = new Map(
  Object.entries(TOKEN_MINTS).map(([symbol, entry]) => [entry.mint, symbol.toUpperCase()]),
);

/**
 * Normalize token identifiers for comparison / keying.
 * - Known token symbols (e.g. "USDC") are resolved to their canonical mint address
 * - Known mint addresses are returned as-is (case-sensitive, they are base58)
 * - EVM addresses (0x + 40 hex chars) are normalized to lowercase
 * - Unknown short identifiers (1-30 alphanumeric) are uppercased as symbols
 * - Other address-like identifiers remain as-is
 *
 * M3 fix: When the input matches a known token symbol (from TOKEN_MINTS), return
 * the canonical mint address. When the input IS a known mint address, return it
 * directly. This ensures "USDC" and "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
 * both normalize to the same value, preventing spending limit bypass.
 *
 * MED-08 fix: Expanded regex to cover single-char tokens (e.g. "W"),
 * hyphenated tokens (e.g. "W-ETH", "stSOL"), and symbols up to 30 chars.
 *
 * P-05 fix: Increased the symbol detection boundary from 20 to 30 characters to better
 * handle long token symbols (e.g., wrapped/bridged tokens with lengthy names). The
 * heuristic distinguishes token symbols from blockchain addresses by length: symbols
 * are 1-30 alphanumeric/hyphen/underscore characters, while Solana base58 addresses
 * are 32-44 chars and EVM hex addresses are 42 chars (with 0x prefix). This leaves a
 * 2-character gap before the shortest address length (32 chars). Tokens at exactly
 * the boundary will be uppercased as a symbol rather than treated as an address.
 * Limitation: a 30-char alphanumeric string that is actually an address will be
 * misclassified as a symbol. Consider an explicit tokenType field for disambiguation.
 */
// AUDIT-L-2: Heuristic may misclassify short addresses. Consider explicit tokenType field.
// MED-3 KNOWN LIMITATION: Short base58 addresses (<=30 chars) that happen to match
// the alphanumeric/hyphen/underscore pattern will be misclassified as token symbols
// and uppercased. This could cause address comparison failures for short addresses.
// To disambiguate, callers should provide an explicit tokenType field.
export function normalizeTokenId(token: string): string {
  // L22 fix: Trim whitespace to prevent silent mismatches (e.g., " USDC " vs "USDC").
  const trimmed = token.trim();

  // M3 fix: Check if the input is a known mint address — return it directly.
  if (MINT_TO_SYMBOL.has(trimmed)) {
    return trimmed;
  }

  // EVM address normalization
  if (trimmed.startsWith("0x") && trimmed.length === 42) return trimmed.toLowerCase();

  // M3 fix: If the input looks like a token symbol and maps to a known mint, return
  // the canonical mint address so that symbol-based and address-based references match.
  if (/^[A-Za-z0-9_-]{1,30}$/.test(trimmed)) {
    const upper = trimmed.toUpperCase();
    const knownEntry = TOKEN_MINTS[upper];
    if (knownEntry) {
      return knownEntry.mint;
    }
    return upper;
  }

  return trimmed;
}

/**
 * Convert a normalized token ID (which may be a mint address) back to a
 * human-readable symbol for display purposes. If the mint address is known,
 * returns the symbol (e.g. "SOL"); otherwise returns the original value.
 */
export function displayTokenId(token: string): string {
  const symbol = MINT_TO_SYMBOL.get(token);
  return symbol ?? token;
}

/**
 * MED-34 fix: Validate a spending/approval limit amount string at construction time.
 * Rejects NaN, Infinity, negative, and zero values that would silently disable limits.
 * Returns the parsed number or throws with a descriptive error.
 */
export function parseAndValidateLimitAmount(amount: string, context: string): number {
  // MED-24 fix: Strict format check before parseFloat to reject trailing garbage.
  // parseFloat("1.5abc") returns 1.5, silently ignoring "abc". This strict regex
  // ensures the entire string is a valid decimal number.
  if (!/^\d+(\.\d+)?$/.test(amount)) {
    throw new Error(`Invalid limit amount format: "${amount}". Must be a decimal number.`);
  }
  const parsed = parseFloat(amount);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${context}: limit amount "${amount}" is not a finite number`);
  }
  if (parsed <= 0) {
    throw new Error(`${context}: limit amount must be positive, got ${parsed}`);
  }
  return parsed;
}
