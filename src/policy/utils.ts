/**
 * Shared policy utility functions.
 *
 * MED-06 fix: Extracted from spending-limit.ts, allowlist.ts, and approval-gate.ts
 * to prevent normalization mismatches when one copy is updated and others are not.
 */

/**
 * Normalize token identifiers for comparison / keying.
 * - Token symbols (1-20 alphanumeric/hyphen/underscore chars) are case-insensitive ("usdc" == "USDC")
 * - EVM addresses (0x + 40 hex chars) are normalized to lowercase
 * - Address-like identifiers (e.g. Solana base58 mints) remain case-sensitive
 *
 * MED-08 fix: Expanded regex to cover single-char tokens (e.g. "W"),
 * hyphenated tokens (e.g. "W-ETH", "stSOL"), and symbols up to 20 chars.
 *
 * MED-T4-04 NOTE: The 20-character boundary was chosen because the longest widely-used
 * token symbols are under 15 characters (e.g., "SHIBA-INU" at 9 chars, "WBTC" at 4).
 * 20 characters provides headroom for unusually long token names while staying safely
 * below the shortest blockchain address lengths: Solana base58 addresses are 32-44 chars,
 * EVM hex addresses are 42 chars (with 0x prefix). This heuristic means tokens at exactly
 * the boundary (e.g., a hypothetical 20-char alphanumeric string) will be uppercased as a
 * symbol rather than treated as an address. If a deployment uses token identifiers longer
 * than 20 chars that should be case-insensitive, increase this bound accordingly.
 */
// AUDIT-L-2: Heuristic may misclassify short addresses. Consider explicit tokenType field.
export function normalizeTokenId(token: string): string {
  if (token.startsWith("0x") && token.length === 42) return token.toLowerCase();
  if (/^[A-Za-z0-9_-]{1,20}$/.test(token)) return token.toUpperCase();
  return token;
}

/**
 * MED-34 fix: Validate a spending/approval limit amount string at construction time.
 * Rejects NaN, Infinity, negative, and zero values that would silently disable limits.
 * Returns the parsed number or throws with a descriptive error.
 */
export function parseAndValidateLimitAmount(amount: string, context: string): number {
  const parsed = parseFloat(amount);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${context}: limit amount "${amount}" is not a finite number`);
  }
  if (parsed <= 0) {
    throw new Error(`${context}: limit amount must be positive, got ${parsed}`);
  }
  return parsed;
}
