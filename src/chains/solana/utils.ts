/**
 * Solana utility functions — token registry, amount conversion, address validation, ATA helpers.
 *
 * CHAIN-019: HARDCODED TOKEN REGISTRY — TOKEN_MINTS and DEVNET_TOKEN_MINTS are static
 * registries with a small number of well-known tokens (SOL, USDC, USDT). Adding support
 * for new tokens requires code changes. For production deployments needing broad token
 * support, consider fetching token metadata from an on-chain registry (e.g., Metaplex
 * Token Metadata, Jupiter token list API) and caching it with a TTL.
 *
 * CHAIN-020: DEVNET/MAINNET TOKEN MISMATCH — The devnet and mainnet registries may have
 * different mint addresses for the same token symbol (e.g., USDC). If the wrong registry
 * is used (e.g., devnet mints on mainnet), transfers will silently target the wrong token.
 * The `isDevnet` parameter must be set correctly. The deprecated `isDevnetUrl()` function
 * should not be used for this determination.
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

/**
 * MED-T1-05 fix: Verify that known token mint addresses have not been tampered with.
 * Call this at application startup to detect supply-chain attacks that modify
 * the hardcoded mint addresses in TOKEN_MINTS. Returns true if all mints match
 * their expected values, false if any mismatch is detected.
 */
export function verifyTokenRegistry(): boolean {
  // These are the canonical mainnet mint addresses as of 2026-02-14
  const expectedMints: Record<string, string> = {
    SOL: "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  };

  for (const [symbol, expectedMint] of Object.entries(expectedMints)) {
    const entry = TOKEN_MINTS[symbol];
    if (!entry || entry.mint !== expectedMint) {
      console.error(
        `[KOVA CRITICAL] Token registry integrity check failed for ${symbol}. ` +
        `Expected mint: ${expectedMint}, got: ${entry?.mint ?? "missing"}. ` +
        `This may indicate a supply-chain attack. DO NOT execute transactions.`,
      );
      return false;
    }
  }
  return true;
}

// ── Token Helpers ──────────────────────────────────────────────────

/**
 * M-17 fix: Normalize a token symbol to uppercase for consistent comparison
 * between the policy layer and chain layer. Both layers must use the same
 * normalization to prevent policy bypasses (e.g., policy allows "USDC" but
 * chain layer receives "usdc" and treats it as a different token).
 *
 * All token symbol comparisons in this module use this function to ensure
 * consistent behavior. The policy layer should also normalize symbols using
 * the same approach (uppercase).
 */
export function normalizeTokenSymbol(token: string): string {
  return token.toUpperCase();
}

/** Check if a token symbol refers to native SOL */
export function isNativeSOL(token: string): boolean {
  return normalizeTokenSymbol(token) === "SOL";
}

/**
 * Resolve a token symbol or mint address to a PublicKey.
 * Accepts both "USDC" (symbol lookup) and raw base58 mint addresses.
 *
 * MED-13 note: When a raw base58 string is provided, this function only validates
 * that it is a valid PublicKey format. It does NOT verify on-chain that the address
 * is actually a valid SPL Token mint account. Callers interacting with arbitrary
 * mint addresses should verify the account owner is the Token Program on-chain.
 */
/**
 * Base58 alphabet used by Solana (Bitcoin-style base58check without the checksum).
 * Used for CHAIN-006 validation of raw mint address strings.
 */
const BASE58_REGEX = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;

// LOW-T2-03 fix: Edge case documentation for base58 validation.
// The all-zeros public key (11111111111111111111111111111111) is a valid base58 string
// and passes both the regex and PublicKey parsing. This address is the Solana System
// Program. It IS a valid address in some contexts (e.g., program invocations, swap
// allowlists). This validation intentionally does NOT reject it, because:
// 1. resolveTokenMint() is used for token mint lookups, where the System Program address
//    is not a valid mint but will fail at a later stage (getAccountInfo / getMint).
// 2. isValidSolanaAddress() is used for general address validation, where rejecting the
//    System Program would break legitimate use cases.
// Callers that want to reject the System Program address as a transfer recipient should
// use isSystemProgramAddress() or the REJECTED_RECIPIENT_PUBKEYS check in transfers.ts.
// See also: PublicKey.default (all-zeros 32-byte key) maps to "11111111111111111111111111111111".

export function resolveTokenMint(token: string, isDevnet?: boolean): PublicKey | null {
  const registry = isDevnet ? DEVNET_TOKEN_MINTS : TOKEN_MINTS;
  const entry = registry[normalizeTokenSymbol(token)];
  if (entry) return new PublicKey(entry.mint);

  // CHAIN-006: When a raw address is provided (not in the registry), perform basic
  // validation before attempting PublicKey parsing. A valid Solana address is a base58-
  // encoded string of 32-44 characters (a 32-byte public key encodes to 32-44 base58 chars).
  // This catches obviously invalid inputs early with a clear error path.
  //
  // NOTE: This validates the FORMAT only. Full on-chain mint verification (confirming the
  // address is actually a valid SPL Token mint account owned by the Token Program) would
  // require an RPC call to getAccountInfo() and checking the account owner. Callers that
  // accept arbitrary mint addresses should perform on-chain verification separately.
  if (token.length < 32 || token.length > 44) {
    return null;
  }
  if (!BASE58_REGEX.test(token)) {
    return null;
  }

  // Try to parse as a raw mint address
  try {
    return new PublicKey(token);
  } catch {
    return null;
  }
}

/**
 * Get decimals for a well-known token. Returns null for unknown tokens.
 *
 * MED-11 note: Only returns decimals for tokens in the hardcoded registry (SOL, USDC, USDT).
 * For arbitrary mint addresses, returns null. Callers should query the mint account's
 * decimals field on-chain via getMint() as a fallback for unknown tokens.
 */
export function getTokenDecimals(token: string, isDevnet?: boolean): number | null {
  const registry = isDevnet ? DEVNET_TOKEN_MINTS : TOKEN_MINTS;
  const entry = registry[normalizeTokenSymbol(token)];
  return entry?.decimals ?? null;
}

// ── Mint Address Validation ──────────────────────────────────────────

/**
 * CHAIN-006 fix: Result of mint address validation.
 * Indicates whether the address is in the known registry, has valid format,
 * or failed validation entirely.
 */
export interface MintValidationResult {
  /** Whether the address is valid (format-only or registry-confirmed) */
  valid: boolean;
  /** Whether this mint is in the known token registry (SOL, USDC, USDT, etc.) */
  inRegistry: boolean;
  /** Warning message if the address is valid but not in the registry */
  warning?: string;
  /** Error message if the address is invalid */
  error?: string;
}

/**
 * CHAIN-006 fix: Validate a token mint address with registry awareness.
 *
 * This function provides layered validation for mint addresses:
 * 1. If the token symbol is in the known registry (SOL, USDC, USDT), it is considered
 *    fully verified and returned with inRegistry=true.
 * 2. If a raw base58 address is provided, the FORMAT is validated (length, character set,
 *    PublicKey parse) and a warning is emitted that the address is not in the known registry.
 * 3. If the address fails format validation, an error is returned.
 *
 * CHAIN-006 limitation: This does NOT perform on-chain verification. Full on-chain mint
 * verification would require an RPC call to getAccountInfo() to confirm:
 * - The account exists on-chain
 * - The account owner is the SPL Token Program (TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA)
 *   or Token-2022 Program (TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb)
 * - The account data parses as a valid Mint struct (supply, decimals, etc.)
 * This is out of scope for a synchronous utility function but SHOULD be performed by
 * callers that accept arbitrary mint addresses before executing transfers or swaps.
 *
 * @param token - Token symbol (e.g., "USDC") or raw base58 mint address
 * @param isDevnet - Whether to use the devnet token registry
 */
export function validateMintAddress(token: string, isDevnet?: boolean): MintValidationResult {
  const registry = isDevnet ? DEVNET_TOKEN_MINTS : TOKEN_MINTS;
  const entry = registry[normalizeTokenSymbol(token)];

  // Known token in registry -- fully trusted
  if (entry) {
    return { valid: true, inRegistry: true };
  }

  // Raw address: validate format
  if (token.length < 32 || token.length > 44) {
    return {
      valid: false,
      inRegistry: false,
      error: `Invalid mint address format: expected 32-44 characters, got ${token.length}. ` +
        `Provide a known token symbol (SOL, USDC, USDT) or a valid base58 mint address.`,
    };
  }

  if (!BASE58_REGEX.test(token)) {
    return {
      valid: false,
      inRegistry: false,
      error: `Invalid mint address format: contains non-base58 characters. ` +
        `Solana addresses use base58 encoding (no 0, O, I, l characters).`,
    };
  }

  try {
    new PublicKey(token);
  } catch {
    return {
      valid: false,
      inRegistry: false,
      error: `Invalid mint address: failed to parse as a Solana PublicKey.`,
    };
  }

  // Valid format but not in registry -- warn
  process.emitWarning(
    `Mint address ${token} is not in the known token registry. ` +
    `On-chain verification has NOT been performed. The address format is valid but ` +
    `it may not be an actual SPL Token mint account. Callers should verify the ` +
    `account on-chain via getAccountInfo() before executing transfers or swaps.`,
    "KovaMintValidationWarning",
  );

  return {
    valid: true,
    inRegistry: false,
    warning: `Mint address ${token} is not in the known token registry (SOL, USDC, USDT). ` +
      `Format is valid but on-chain verification has not been performed. ` +
      `This address may not be a valid SPL Token mint.`,
  };
}

// ── Amount Conversion (BigInt-safe) ──────────────────────────────────

/**
 * Convert a human-readable amount (e.g., "1.5") to the smallest unit (e.g., lamports).
 * Uses string-based arithmetic to avoid floating-point precision issues.
 */
export function toSmallestUnit(amount: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(amount)) {
    // LOW-T1-05 fix: Redact exact input value from error message to prevent information leakage
    throw new SolanaAdapterError(
      "INVALID_AMOUNT",
      "Invalid amount format. Must be a non-negative decimal number.",
    );
  }
  const parts = amount.split(".");
  const whole = parts[0] ?? "0";
  const rawFractional = parts[1] ?? "";
  // CHAIN-019 fix: Warn when excess decimal precision is truncated.
  // If the input has more decimal places than the token supports, the excess
  // digits are silently dropped. This is correct behavior (round-down), but
  // callers should be aware that precision was lost.
  if (rawFractional.length > decimals && rawFractional.slice(decimals).replace(/0+$/, "").length > 0) {
    process.emitWarning(
      `Amount has ${rawFractional.length} decimal places but token supports ${decimals}. ` +
      `Excess precision truncated (round-down). Use exact precision to avoid this warning.`,
      "KovaPrecisionWarning",
    );
  }
  const fractional = rawFractional.padEnd(decimals, "0").slice(0, decimals);
  const result = BigInt(whole + fractional);

  // CHAIN-003 fix: Reject amounts exceeding Solana's u64 maximum.
  // Solana uses u64 for lamport amounts; values above 2^64 - 1 would produce
  // malformed transaction data that would be signed before failing at simulation.
  const U64_MAX = BigInt("18446744073709551615");
  if (result > U64_MAX) {
    throw new SolanaAdapterError(
      "INVALID_AMOUNT",
      "Amount exceeds maximum u64 value (2^64 - 1)",
    );
  }

  // M-25 fix: Detect sub-precision amounts that would silently truncate to zero.
  // If the input is non-zero (e.g., "0.0000000001" with 6 decimals) but the
  // smallest-unit result is 0, this means the amount has more decimal places
  // than the token supports and was silently truncated. This is dangerous because
  // the user intended to send a non-zero amount but the transaction would send nothing.
  if (result === 0n && parseFloat(amount) > 0) {
    // LOW-T1-05 fix: Redact exact input value from error message to prevent information leakage
    throw new SolanaAdapterError(
      "INVALID_AMOUNT",
      `Amount is too small for ${decimals} decimal places and would truncate to zero. ` +
      `The minimum representable amount is ${"0.".padEnd(decimals + 1, "0")}1.`,
    );
  }

  if (result <= 0n) {
    // MED-T2-01 fix: Do not leak the input amount in the error message.
    // Previously echoed the exact input value, aiding validation probing.
    throw new SolanaAdapterError(
      "INVALID_AMOUNT",
      "Amount must be positive",
    );
  }

  // HIGH-22 fix: Warn about dust amounts that are too small to be economically meaningful.
  // Transactions with dust amounts (< 1000 lamports for SOL, i.e., < 0.000001 SOL) cost
  // more in fees than the value transferred, which could be exploited for fee drain attacks
  // where an attacker tricks the wallet into sending many tiny transactions.
  //
  // LOW-T2-02 fix: This is the chain-layer dust threshold (1000 smallest units). It operates
  // at the raw token unit level and emits a warning for any token. The wallet layer
  // (src/core/wallet.ts) has a separate, higher-level dust threshold (MIN_DUST_AMOUNT =
  // 0.000001 in human-readable units) that rejects intents outright during validation.
  // The two thresholds are intentionally different:
  // - Wallet layer: human-readable, applies uniformly to all intent amounts, hard rejection.
  // - Chain layer: smallest-unit, token-aware, advisory warning only.
  // Do not unify them — they protect against different attack vectors at different layers.
  if (result > 0n && result < 1000n) {
    process.emitWarning(
      `Dust amount detected: ${result} smallest units (${amount} with ${decimals} decimals). ` +
      `This amount may be smaller than the transaction fee, risking a fee drain attack.`,
      "SolanaWalletWarning",
    );
  }

  return result;
}

/**
 * Convert a smallest-unit amount (e.g., lamports) back to a human-readable string.
 *
 * L-18: Floating-point precision note for USD calculations.
 * This function returns a string representation that preserves the full precision
 * of the BigInt amount. However, callers that convert the result to a JavaScript
 * number via parseFloat() for USD multiplication should be aware that IEEE 754
 * double-precision floats have ~15-17 significant decimal digits. For amounts
 * exceeding 2^53 (9,007,199,254,740,992) or amounts with more than 15 significant
 * digits, parseFloat() will introduce rounding errors. For high-precision USD
 * calculations (e.g., DeFi accounting, tax reporting), use a BigNumber library
 * (e.g., decimal.js, bignumber.js) instead of native JavaScript numbers.
 */
export function fromSmallestUnit(amount: bigint, decimals: number): string {
  const str = amount.toString().padStart(decimals + 1, "0");
  const whole = str.slice(0, str.length - decimals);
  const frac = str.slice(str.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

// ── Address Validation ──────────────────────────────────────────────

/**
 * M-13 fix: Well-known system program addresses that should not be accepted as
 * transfer recipients. These are Solana runtime programs — sending funds to them
 * results in permanent loss since no private key controls these addresses.
 */
const SYSTEM_PROGRAM_ADDRESSES = new Set([
  "11111111111111111111111111111111",                // System Program
  "11111111111111111111111111111112",                // Native Loader (note: this is a valid system address)
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",    // Token Program
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",    // Token-2022 Program
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",    // Associated Token Account
  "ComputeBudget111111111111111111111111111111",       // Compute Budget
  "SysvarRent111111111111111111111111111111111",       // Sysvar Rent
  "SysvarC1ock11111111111111111111111111111111",       // Sysvar Clock
  "SysvarS1otHashes111111111111111111111111111",       // Sysvar Slot Hashes
  "Vote111111111111111111111111111111111111111",        // Vote Program
  "Stake11111111111111111111111111111111111111",        // Stake Program
  "BPFLoaderUpgradeab1e11111111111111111111111",       // BPF Loader
  "Ed25519SigVerify111111111111111111111111111",       // Ed25519 Signature Verification
  "KeccakSecp256k11111111111111111111111111111",       // Secp256k1 Signature Verification
  "Config1111111111111111111111111111111111111",        // Config Program
  "AddressLookupTab1e1111111111111111111111111",       // Address Lookup Table
]);

/**
 * M-13 fix: Check if an address is a well-known system program address.
 * These addresses should generally not be used as transfer recipients.
 */
export function isSystemProgramAddress(address: string): boolean {
  return SYSTEM_PROGRAM_ADDRESSES.has(address);
}

/**
 * Validate a Solana address using actual PublicKey parsing.
 *
 * L-19 fix: Adds a minimum length check (32-44 characters) to reject
 * dangerously short inputs that might pass PublicKey parsing but are not
 * valid Solana addresses.
 *
 * LOW-06 limitation: This function accepts Program Derived Addresses (PDAs) as valid.
 * PDAs are valid PublicKeys but do not lie on the ed25519 curve and cannot sign
 * transactions. Sending SOL to a PDA is valid (it can hold lamports), but sending
 * SPL tokens to a PDA as if it were a wallet (deriving an ATA for it) may result in
 * tokens being locked if no program can authorize transfers from that PDA's ATA.
 * To distinguish PDAs from regular keypair addresses, use PublicKey.isOnCurve(),
 * but note that some legitimate use cases involve sending to PDAs (e.g., program
 * vaults), so rejecting PDAs outright may be too restrictive.
 */
export function isValidSolanaAddress(address: string): boolean {
  if (!address || typeof address !== "string") return false;
  // L-19 fix: Valid base58-encoded Solana public keys (32 bytes) are 32-44 characters long.
  // Reject inputs outside this range early — very short strings may technically parse as
  // valid PublicKeys but represent dangerously small key spaces or padding artifacts.
  if (address.length < 32 || address.length > 44) return false;
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

// ── String Sanitization ──────────────────────────────────────────

/**
 * LOW-T2-08 fix: Strip control characters (C0: U+0000-U+001F, DEL: U+007F,
 * C1: U+0080-U+009F) from strings before interpolating into descriptions or logs.
 * Prevents log injection, terminal escape sequences, and invisible characters
 * that could mislead operators reviewing audit logs or transaction descriptions.
 */
export function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1F\x7F-\x9F]/g, "");
}

/**
 * MED-18 fix: Sanitize token names/symbols by restricting to ASCII printable characters.
 * Token names from on-chain data or user input may contain Unicode control characters,
 * RTL override characters (U+202E), zero-width joiners, or homoglyph characters that
 * could mislead approvers in swap descriptions/summaries. This replaces any character
 * outside the ASCII printable range (0x20-0x7E) with "?" to make manipulation visible.
 */
export function sanitizeTokenName(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, "?");
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

/**
 * Detect if an RPC URL points to devnet.
 * @deprecated MED-T1-06: Use `SolanaAdapterConfig.network` instead.
 * URL sniffing is fragile — a URL like "https://rpc.mainnet.com/devnet-proxy"
 * would falsely trigger devnet mode, causing wrong token mints.
 * @internal This function should not be used in new code. It is retained only
 * for backward compatibility with existing callers. It will be removed in the
 * next major version.
 */
export function isDevnetUrl(rpcUrl: string): boolean {
  process.emitWarning(
    "isDevnetUrl() is deprecated and fragile. Use SolanaAdapterConfig.network instead.",
    "DeprecationWarning",
  );
  return rpcUrl.includes("devnet");
}

// ── SSRF Protection — Shared IP Validation ────────────────────────────

/**
 * CHAIN-005 fix: Shared IPv4 private range check used by both validateRpcUrl()
 * (adapter.ts) and validateFetchTarget() (swaps.ts). Consolidating into a single
 * function prevents divergence where one location blocks a range but the other doesn't.
 *
 * Blocked ranges: RFC 1918, link-local (169.254), CGNAT (100.64/10), loopback (127), unspecified (0).
 */
export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return false;
  const octets = parts.map(Number);
  const [o0, o1] = octets;
  return (
    o0 === 10 ||
    (o0 === 172 && o1! >= 16 && o1! <= 31) ||
    (o0 === 192 && o1 === 168) ||
    (o0 === 169 && o1 === 254) ||
    (o0 === 100 && o1! >= 64 && o1! <= 127) ||
    o0 === 127 || o0 === 0
  );
}

/**
 * CHAIN-005 fix: Shared IPv6 private/reserved range check. Covers:
 * - Unspecified (::), Loopback (::1)
 * - ULA (fc00::/7), Link-local (fe80::/10)
 * - IPv4-mapped (::ffff:), 6to4 (2002::/16), Teredo (2001:0000::/32)
 * - Documentation (2001:db8::/32), Discard (100::/64)
 */
export function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "0:0:0:0:0:0:0:0") return true;
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (/^fe[89ab]/i.test(lower)) return true;
  if (lower.startsWith("::ffff:")) return true;
  if (lower.startsWith("100:")) return true;
  if (lower.startsWith("2001:db8:") || lower.startsWith("2001:0db8:")) return true;
  if (lower.startsWith("2002:")) return true;
  if (lower.startsWith("2001:0000:") || lower.startsWith("2001:0:") || lower.startsWith("2001::")) return true;
  return false;
}
