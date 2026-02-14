/**
 * Solana swap operations — Jupiter V6 integration.
 *
 * Flow: GET /quote → POST /swap → decode VersionedTransaction → return as UnsignedTransaction.
 * The LocalSigner handles VersionedTransaction natively.
 *
 * CHAIN-021: JUPITER API TRUST BOUNDARY — The swap flow trusts the Jupiter API to return
 * valid, non-malicious transaction data. While we validate program allowlists, fee payer,
 * and minimum output amounts, the Jupiter API is an external dependency. A compromised
 * Jupiter API could return transactions that:
 * - Route through manipulated liquidity pools (sandwich attack)
 * - Set unnecessarily high priority fees (fee drain)
 * - Include legitimate but disadvantageous routing
 * Mitigations include slippage caps, otherAmountThreshold validation, and the program
 * allowlist. For high-value swaps, consider using on-chain order books or limit orders
 * instead of API-based routing.
 *
 * HIGH-T2-02: JUPITER API TRUST ASSUMPTIONS — This module assumes:
 * 1. The Jupiter API returns honest, non-malicious quotes and swap transactions
 * 2. Jupiter's routing algorithm selects optimal routes without front-running
 * 3. Jupiter's program allowlist (SWAP_PROGRAM_ALLOWLIST) covers only legitimate DEXes
 * 4. The API's otherAmountThreshold field accurately reflects minimum output
 * 5. The API is not subject to man-in-the-middle attacks (HTTPS + DNS validation)
 * If any of these assumptions are violated, the swap may result in:
 * - Worse execution price than expected (but still within slippage tolerance)
 * - Routing through pools with low liquidity (higher price impact)
 * - Front-running or sandwich attacks by the API operator
 * For high-value swaps (>$10,000 USD equivalent), consider:
 * - Using multiple quote sources and comparing prices
 * - Setting tighter slippage (0.1-0.3% instead of default 0.5%)
 * - Using the post-swap verification (verifySwapOutput) to detect anomalies
 */

import { PublicKey, VersionedTransaction, type Connection } from "@solana/web3.js";
import { lookup } from "node:dns/promises";
import type { SwapParams } from "../../core/intent.js";
import type { UnsignedTransaction } from "../../signers/interface.js";
import {
  resolveTokenMint,
  getTokenDecimals,
  toSmallestUnit,
  normalizeTokenSymbol,
  SolanaAdapterError,
} from "./utils.js";

const DEFAULT_JUPITER_API = "https://quote-api.jup.ag/v6";
const DEFAULT_JUPITER_PRICE_API = "https://price.jup.ag/v2";
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

/**
 * H-29 fix / MED-T2-03 fix: Per-instance rate limiter for Jupiter API calls.
 * Previously this was a module-global variable (`lastJupiterCallMs`) shared across
 * all adapter instances, causing cross-instance interference in multi-tenant or
 * multi-wallet scenarios. Now encapsulated in a class that can be instantiated
 * per SolanaAdapter.
 *
 * Uses a sliding window approach with a minimum interval between requests
 * (200ms = 5 req/sec max).
 */
export class JupiterRateLimiter {
  private lastCallMs = 0;
  private readonly minIntervalMs: number;

  constructor(minIntervalMs: number = 200) {
    this.minIntervalMs = minIntervalMs;
  }

  /**
   * H-29 fix: Enforce rate limiting before making a Jupiter API call.
   * If the minimum interval has not elapsed since the last call, waits
   * for the remaining time before proceeding.
   */
  async enforce(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastCallMs;
    if (elapsed < this.minIntervalMs) {
      const waitMs = this.minIntervalMs - elapsed;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    this.lastCallMs = Date.now();
  }
}

/**
 * MED-T2-03: Default module-level rate limiter for backward compatibility.
 * New code should use per-instance rate limiters via JupiterRateLimiter class.
 */
const defaultRateLimiter = new JupiterRateLimiter();

/** Wrapped SOL mint address used by Jupiter */
const SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * CRIT-04 fix: Known Jupiter program IDs.
 * After deserializing a Jupiter swap transaction, we verify that at least one
 * instruction targets a known Jupiter program. This prevents a compromised API
 * from returning a transaction that drains the wallet via an unrelated program.
 *
 * MED-13 limitation: These program IDs are hardcoded and may need updating when
 * Jupiter releases new program versions. Monitor Jupiter's official announcements
 * and update this set accordingly. A future improvement could fetch the current
 * program IDs from a trusted on-chain registry.
 *
 * LOW-09 note: The Jupiter program IDs are duplicated between KNOWN_JUPITER_PROGRAMS
 * and ALLOWED_SWAP_PROGRAMS below. This is intentional — KNOWN_JUPITER_PROGRAMS is
 * used for the "at least one Jupiter program present" check, while ALLOWED_SWAP_PROGRAMS
 * is the full allowlist for all instructions. Keeping them separate allows different
 * update cadences, but maintainers should ensure KNOWN_JUPITER_PROGRAMS is always a
 * subset of ALLOWED_SWAP_PROGRAMS.
 */
// LOW-T2-06 fix: These Jupiter program IDs were last verified on 2025-05-01 against
// Jupiter's official documentation and on-chain deployments. Jupiter periodically
// releases new program versions (e.g., v7, v8). Maintainers should check for updates
// at https://station.jup.ag/docs and https://github.com/jup-ag/jupiter-core at least
// quarterly. If a new version is released, add its program ID here and to
// DEFAULT_ALLOWED_SWAP_PROGRAMS below. Stale program IDs may cause legitimate swaps
// to be rejected if Jupiter deprecates older versions.
const KNOWN_JUPITER_PROGRAMS = new Set([
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", // Jupiter v6
  "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB", // Jupiter v4
  "JUP3jqKShLv8zuCgKGp3VJbC4vaSpsssuVKqBiGW7bRe", // Jupiter v3
]);

/**
 * AUDIT-CRIT-02 fix: Default allowlist of programs that may appear in Jupiter swap transactions.
 * Every instruction in the transaction must target one of these programs.
 * Any unknown program causes the transaction to be rejected.
 *
 * CHAIN-014 fix: This allowlist is now configurable via JupiterSwapOptions.additionalSwapPrograms
 * to accommodate new Jupiter versions or DEX protocol integrations without code changes.
 * The defaults below cover Jupiter v3-v6 and standard Solana system programs.
 * Last updated 2025-05-01 (Jupiter v6 era).
 */
const DEFAULT_ALLOWED_SWAP_PROGRAMS: ReadonlyArray<string> = [
  // Jupiter programs
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", // Jupiter v6
  "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB", // Jupiter v4
  "JUP3jqKShLv8zuCgKGp3VJbC4vaSpsssuVKqBiGW7bRe", // Jupiter v3
  // System programs commonly used in swaps
  "11111111111111111111111111111111",               // System Program
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",   // Token Program
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",   // Token-2022 Program
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",   // Associated Token Account
  "ComputeBudget111111111111111111111111111111",      // Compute Budget
  "AddressLookupTab1e1111111111111111111111111",      // Address Lookup Table
  // H-21 fix: AMM/DEX program IDs that Jupiter routes through.
  // Without these, legitimate Jupiter swap transactions that route through
  // these DEX programs would be rejected by the program allowlist check.
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM v4
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", // Raydium CLMM
  "5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h", // Raydium AMM Routing
  "routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS",  // Raydium Route
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",  // Orca Whirlpool
  "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP", // Orca Token Swap v2
  "DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1", // Orca Token Swap
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",  // Meteora DLMM
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB", // Meteora Pools
  "SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ",  // Saber Stable Swap
  "MERLuDFBMmsHnsBPZw2sDQZHvXFMwp8EdjudcU2HKky",  // Mercurial Stable Swap
  "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", // Serum DEX v3 (OpenBook)
  "srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX",  // Serum DEX v3 (alt)
  "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY",  // Phoenix DEX
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",  // Pump.fun AMM
  "opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb",  // OpenBook v2
  "2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c", // Lifinity V2
  "EewxydAPCCVuNEyrVN68PuSYdQ7wKn27V9Gjeoi8dy3S", // Lifinity V1
  "Dooar9JkhdZ7J3LHN3A7YCuoGRULKtbLKbHsjFrEC6ke", // Stepn DEX (DOOAR)
  "SSwapUtytfBdBn1b9NUGG6foMVPtcWgpRU32HToDUZr",  // Saros AMM
];

/**
 * M-49 / MED-T2-02: Maximum allowed response body size from Jupiter API calls (10 MB).
 * Prevents memory exhaustion from malicious or erroneously large responses.
 * Raised from 1 MB to 10 MB to accommodate large Jupiter swap responses with
 * complex routing, while still providing meaningful protection against DoS.
 */
const MAX_RESPONSE_SIZE = 10_485_760; // 10 MB

/**
 * CRIT-T2-01 fix: Validate that a URL's hostname does not resolve to a private/internal IP.
 * This is called before each Jupiter API fetch to prevent SSRF via DNS rebinding.
 * The Jupiter API URL is validated at construction time, but DNS can change between
 * construction and the actual request. This per-request validation closes that gap.
 */
async function validateFetchTarget(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SolanaAdapterError("INVALID_URL", `Invalid URL: ${url}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // Skip validation for localhost (dev only)
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return;
  }

  // Skip validation for IP literals (already validated at construction)
  const ipv4Parts = hostname.split(".");
  if (ipv4Parts.length === 4 && ipv4Parts.every((p) => /^\d{1,3}$/.test(p))) {
    const octets = ipv4Parts.map(Number);
    const [o0, o1] = octets;
    const isPrivate =
      o0 === 10 ||
      (o0 === 172 && o1! >= 16 && o1! <= 31) ||
      (o0 === 192 && o1 === 168) ||
      (o0 === 169 && o1 === 254) ||
      (o0 === 100 && o1! >= 64 && o1! <= 127) ||
      o0 === 127 || o0 === 0;
    if (isPrivate) {
      throw new SolanaAdapterError("SSRF_BLOCKED", `Jupiter API URL resolves to private IP: ${hostname}`);
    }
    return;
  }

  // Resolve DNS and validate the resolved IP
  try {
    const result = await lookup(hostname, { family: 4 }).catch(() => lookup(hostname, { family: 6 }));
    const ip = result.address;
    const family = result.family;

    if (family === 4) {
      const octets = ip.split(".").map(Number);
      const [o0, o1] = octets;
      const isPrivate =
        o0 === 10 ||
        (o0 === 172 && o1! >= 16 && o1! <= 31) ||
        (o0 === 192 && o1 === 168) ||
        (o0 === 169 && o1 === 254) ||
        (o0 === 100 && o1! >= 64 && o1! <= 127) ||
        o0 === 127 || o0 === 0;
      if (isPrivate) {
        throw new SolanaAdapterError(
          "SSRF_BLOCKED",
          `Jupiter API hostname "${hostname}" resolved to private IPv4 address. DNS rebinding attack suspected.`,
        );
      }
    } else {
      const lower = ip.toLowerCase();
      const isPrivateV6 =
        lower === "::" || lower === "::1" ||
        lower.startsWith("fc") || lower.startsWith("fd") ||
        /^fe[89ab]/i.test(lower) ||
        lower.startsWith("::ffff:");
      if (isPrivateV6) {
        throw new SolanaAdapterError(
          "SSRF_BLOCKED",
          `Jupiter API hostname "${hostname}" resolved to private IPv6 address. DNS rebinding attack suspected.`,
        );
      }
    }
  } catch (err) {
    if (err instanceof SolanaAdapterError) throw err;
    // LOW-T2-05 fix: Sanitize DNS error to remove hostname details that could
    // leak infrastructure information. Do not include err.message verbatim.
    throw new SolanaAdapterError(
      "VALIDATION_ERROR",
      `DNS resolution failed for Jupiter API URL (fail-closed): unable to resolve hostname`,
    );
  }
}

/**
 * M-51 fix: fetchWithTimeout that covers both the fetch and body consumption phase.
 * The timeout wraps the entire operation (connection + headers + body read) so that
 * a slow-drip response body cannot keep the connection open indefinitely.
 *
 * M-49 fix: Enforces a response body size limit via Content-Length header check
 * and streaming body read with a byte counter.
 *
 * L-25 fix: Adds a User-Agent header to all outbound requests.
 *
 * H-29 fix: Enforces Jupiter API rate limiting before each request.
 *
 * CRIT-T2-01 fix: Validates the target URL's resolved IP against private IP ranges
 * before each request to prevent SSRF via DNS rebinding. The Jupiter API URL is
 * validated at construction time, but DNS can change between construction and the
 * actual request. This per-request validation closes that TOCTOU gap.
 *
 * Returns the response body as a string (not a Response object) to ensure
 * the body is fully consumed within the timeout window.
 */
async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
  rateLimiter?: JupiterRateLimiter,
): Promise<{ ok: boolean; status: number; body: string }> {
  // CRIT-T2-01 fix: Validate DNS before each fetch to prevent SSRF via DNS rebinding
  await validateFetchTarget(url);
  // H-29 / MED-T2-03 fix: Enforce rate limiting using per-instance limiter if provided,
  // otherwise fall back to the default module-level limiter for backward compatibility.
  await (rateLimiter ?? defaultRateLimiter).enforce();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // L-25 fix: Add User-Agent header to identify this SDK
    const headers = new Headers(init?.headers);
    if (!headers.has("User-Agent")) {
      headers.set("User-Agent", "kova-wallet-sdk/0.1.0");
    }

    const response = await fetch(url, {
      ...init,
      headers,
      signal: controller.signal,
    });

    // M-49 fix: Check Content-Length header before reading body
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
      throw new SolanaAdapterError(
        "JUPITER_RESPONSE_TOO_LARGE",
        `Jupiter API response Content-Length (${contentLength}) exceeds maximum allowed size (${MAX_RESPONSE_SIZE} bytes).`,
      );
    }

    // M-51 fix: Read body within the same timeout window.
    // M-49 fix: Stream body with size limit to prevent memory exhaustion.
    const reader = response.body?.getReader();
    if (!reader) {
      return { ok: response.ok, status: response.status, body: "" };
    }

    const chunks: Uint8Array[] = [];
    let totalSize = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.byteLength;
      if (totalSize > MAX_RESPONSE_SIZE) {
        reader.cancel();
        throw new SolanaAdapterError(
          "JUPITER_RESPONSE_TOO_LARGE",
          `Jupiter API response body exceeds maximum allowed size (${MAX_RESPONSE_SIZE} bytes). Read ${totalSize} bytes so far.`,
        );
      }
      chunks.push(value);
    }

    // MED-T2-02 fix: Use efficient Uint8Array concatenation instead of spread operator.
    // The previous implementation used `acc.push(...c)` which creates ~8x memory amplification
    // by converting each Uint8Array chunk to individual number arguments on the call stack.
    // This pre-allocates a single buffer of the exact required size and copies chunks into it.
    let merged: Uint8Array;
    if (chunks.length === 1) {
      merged = chunks[0]!;
    } else {
      merged = new Uint8Array(totalSize);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
    const body = new TextDecoder().decode(merged);
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timeoutId);
  }
}

interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  routePlan: unknown[];
}

interface JupiterSwapResponse {
  swapTransaction: string; // base64-encoded VersionedTransaction
  lastValidBlockHeight: number;
}

/**
 * CRIT-04 fix: Runtime validation for Jupiter quote responses.
 * Ensures all required fields exist with correct types before trusting the data.
 */
function validateJupiterQuote(data: unknown, expectedInputMint: string, expectedOutputMint: string, requestedSlippageBps: number, requestedAmountIn?: bigint): JupiterQuote {
  if (!data || typeof data !== "object") {
    throw new SolanaAdapterError("JUPITER_INVALID_RESPONSE", "Jupiter quote response is not an object");
  }
  const obj = data as Record<string, unknown>;

  if (typeof obj.inputMint !== "string" || obj.inputMint.length === 0) {
    throw new SolanaAdapterError("JUPITER_INVALID_RESPONSE", "Jupiter quote missing or invalid 'inputMint'");
  }
  if (typeof obj.outputMint !== "string" || obj.outputMint.length === 0) {
    throw new SolanaAdapterError("JUPITER_INVALID_RESPONSE", "Jupiter quote missing or invalid 'outputMint'");
  }
  if (typeof obj.inAmount !== "string" || obj.inAmount.length === 0) {
    throw new SolanaAdapterError("JUPITER_INVALID_RESPONSE", "Jupiter quote missing or invalid 'inAmount'");
  }
  if (typeof obj.outAmount !== "string" || obj.outAmount.length === 0) {
    throw new SolanaAdapterError("JUPITER_INVALID_RESPONSE", "Jupiter quote missing or invalid 'outAmount'");
  }
  if (typeof obj.slippageBps !== "number") {
    throw new SolanaAdapterError("JUPITER_INVALID_RESPONSE", "Jupiter quote missing or invalid 'slippageBps'");
  }
  // HIGH-07 fix: Validate otherAmountThreshold exists for output verification
  if (typeof obj.otherAmountThreshold !== "string" || obj.otherAmountThreshold.length === 0) {
    throw new SolanaAdapterError("JUPITER_INVALID_RESPONSE", "Jupiter quote missing or invalid 'otherAmountThreshold'");
  }

  // Verify the quote matches what we requested — prevents response tampering
  if (obj.inputMint !== expectedInputMint) {
    throw new SolanaAdapterError(
      "JUPITER_MINT_MISMATCH",
      `Jupiter quote inputMint mismatch: expected ${expectedInputMint}, got ${obj.inputMint}`,
    );
  }
  if (obj.outputMint !== expectedOutputMint) {
    throw new SolanaAdapterError(
      "JUPITER_MINT_MISMATCH",
      `Jupiter quote outputMint mismatch: expected ${expectedOutputMint}, got ${obj.outputMint}`,
    );
  }

  // H-24 fix: Validate that the quote inAmount matches the requested amount.
  // A compromised Jupiter API could return a quote for a different (larger) amount,
  // causing the wallet to spend more tokens than the user intended.
  if (requestedAmountIn !== undefined) {
    const quoteInAmount = BigInt(obj.inAmount as string);
    const difference = quoteInAmount > requestedAmountIn
      ? quoteInAmount - requestedAmountIn
      : requestedAmountIn - quoteInAmount;
    if (difference > 1n) {
      throw new SolanaAdapterError(
        "JUPITER_AMOUNT_MISMATCH",
        `Jupiter quote inAmount (${obj.inAmount}) does not match requested amount (${requestedAmountIn}). ` +
        `Difference: ${difference}. This may indicate a manipulated quote.`,
      );
    }
  }

  // HIGH-07 fix: Verify slippage in the quote response matches or is tighter than requested.
  // A manipulated response with wider slippage could enable sandwich attacks.
  if (obj.slippageBps > requestedSlippageBps) {
    throw new SolanaAdapterError(
      "JUPITER_SLIPPAGE_MISMATCH",
      `Jupiter quote slippage (${obj.slippageBps} bps) exceeds requested slippage (${requestedSlippageBps} bps)`,
    );
  }

  // HIGH-07 fix: Verify minimum output amount is consistent with quoted output and slippage.
  // otherAmountThreshold should be >= outAmount * (1 - slippageBps/10000) for ExactIn swaps.
  const outAmountNum = BigInt(obj.outAmount as string);
  const thresholdNum = BigInt(obj.otherAmountThreshold as string);
  if (thresholdNum <= 0n) {
    throw new SolanaAdapterError(
      "JUPITER_OUTPUT_TOO_LOW",
      `Jupiter quote otherAmountThreshold is zero or negative — possible value extraction attack`,
    );
  }
  // H-23 fix: Tighten slippage validation from 2x to 1.5x to reduce sandwich attack surface.
  // The previous 2x multiplier was overly generous and allowed the minimum output threshold
  // to be set significantly lower than expected, enabling more profitable sandwich attacks.
  // 1.5x provides sufficient margin for rounding while being meaningfully tighter.
  const maxAcceptableSlipBps = BigInt(Math.min(Math.ceil((obj.slippageBps as number) * 1.5), 10000));
  const minReasonableThreshold = outAmountNum * (10000n - maxAcceptableSlipBps) / 10000n;
  if (thresholdNum < minReasonableThreshold) {
    throw new SolanaAdapterError(
      "JUPITER_OUTPUT_TOO_LOW",
      `Jupiter quote minimum output (${obj.otherAmountThreshold}) is unreasonably low compared to ` +
      `quoted output (${obj.outAmount}) with ${obj.slippageBps} bps slippage. ` +
      `This may indicate a manipulated quote enabling sandwich attacks.`,
    );
  }

  return data as JupiterQuote;
}

/**
 * CRIT-04 fix: Runtime validation for Jupiter swap responses.
 * Ensures swapTransaction is a non-empty base64 string and lastValidBlockHeight is valid.
 */
function validateJupiterSwapResponse(data: unknown): JupiterSwapResponse {
  if (!data || typeof data !== "object") {
    throw new SolanaAdapterError("JUPITER_INVALID_RESPONSE", "Jupiter swap response is not an object");
  }
  const obj = data as Record<string, unknown>;

  if (typeof obj.swapTransaction !== "string" || obj.swapTransaction.length === 0) {
    throw new SolanaAdapterError("JUPITER_INVALID_RESPONSE", "Jupiter swap response missing or invalid 'swapTransaction'");
  }

  // Validate base64 encoding — must be valid base64 characters
  if (!/^[A-Za-z0-9+/]+=*$/.test(obj.swapTransaction)) {
    throw new SolanaAdapterError("JUPITER_INVALID_RESPONSE", "Jupiter swap response 'swapTransaction' is not valid base64");
  }

  if (typeof obj.lastValidBlockHeight !== "number" || !Number.isFinite(obj.lastValidBlockHeight) || obj.lastValidBlockHeight <= 0) {
    throw new SolanaAdapterError("JUPITER_INVALID_RESPONSE", "Jupiter swap response missing or invalid 'lastValidBlockHeight'");
  }

  return data as JupiterSwapResponse;
}

/**
 * Build a Jupiter swap transaction.
 * 1. GET /quote to get a route
 * 2. POST /swap to get a serialized VersionedTransaction
 * 3. Return as UnsignedTransaction (the LocalSigner handles VersionedTransaction natively)
 */
/**
 * CHAIN-002: Configuration for Address Lookup Table (ALT) handling in Jupiter swaps.
 */
export interface JupiterSwapOptions {
  /**
   * CHAIN-002: Whether to allow transactions with Address Lookup Tables (ALTs).
   * When true (default), transactions with ALTs are allowed through with a warning
   * log. Program validation still applies to staticAccountKeys, which is sufficient
   * because program IDs are always in static keys — ALTs only reference data accounts.
   * When false, transactions with ALTs are rejected outright (legacy behavior, more
   * restrictive but may render Jupiter V6 swaps unusable since most routes use ALTs).
   */
  allowAddressLookupTables?: boolean;
  /**
   * CHAIN-014 fix: Additional program IDs to allow in swap transactions.
   * These are merged with the built-in defaults (Jupiter v3-v6, System Program,
   * Token Program, Token-2022, ATA, Compute Budget, Address Lookup Table).
   * Use this to add new Jupiter program versions or DEX protocol programs
   * without waiting for an SDK update.
   *
   * Example: ["JUP7newProgramId..."] to allow a new Jupiter version.
   */
  additionalSwapPrograms?: string[];
}

export async function buildJupiterSwap(
  _connection: Connection,
  params: SwapParams,
  signerAddress: string,
  jupiterApiUrl: string = DEFAULT_JUPITER_API,
  isDevnet: boolean = false,
  options?: JupiterSwapOptions,
  rateLimiter?: JupiterRateLimiter,
): Promise<UnsignedTransaction> {
  // Resolve token symbols to mint addresses
  const inputMint =
    resolveTokenMint(params.fromToken, isDevnet)?.toBase58() ??
    (normalizeTokenSymbol(params.fromToken) === "SOL"
      ? SOL_MINT
      : params.fromToken);
  const outputMint =
    resolveTokenMint(params.toToken, isDevnet)?.toBase58() ??
    (normalizeTokenSymbol(params.toToken) === "SOL" ? SOL_MINT : params.toToken);

  // M-31 fix: Reject swaps where input and output tokens are the same.
  // Swapping a token for itself is wasteful (fees + slippage loss) and may indicate
  // a logic error or attempted exploit to extract fees through unnecessary routing.
  if (inputMint === outputMint) {
    throw new SolanaAdapterError(
      "INVALID_PARAMS",
      `Cannot swap a token for itself: both fromToken (${params.fromToken}) and toToken (${params.toToken}) ` +
      `resolve to the same mint address (${inputMint}).`,
    );
  }

  // Calculate input amount in smallest unit
  const fromDecimals = getTokenDecimals(params.fromToken, isDevnet);
  if (fromDecimals === null) {
    throw new SolanaAdapterError(
      "UNKNOWN_DECIMALS",
      `Cannot determine decimals for ${params.fromToken}. Use a known token symbol or provide decimals.`,
    );
  }
  const amountIn = toSmallestUnit(params.amount, fromDecimals);

  // MED-12 fix: Cap slippage at 5% to prevent excessive value loss.
  // A slippage of 100% (1.0) would allow Jupiter to return zero output tokens.
  const MAX_SLIPPAGE = 0.05; // 5%
  const rawSlippage = params.maxSlippage ?? 0.005;
  if (rawSlippage > MAX_SLIPPAGE) {
    throw new SolanaAdapterError(
      "EXCESSIVE_SLIPPAGE",
      `Slippage ${(rawSlippage * 100).toFixed(1)}% exceeds maximum allowed ${(MAX_SLIPPAGE * 100).toFixed(1)}%. ` +
      `High slippage enables sandwich attacks and excessive value extraction.`,
    );
  }
  // Convert slippage from decimal (0.01 = 1%) to basis points (100 bps)
  const slippageBps = Math.floor(rawSlippage * 10_000);

  // Step 1: Get quote from Jupiter
  const quoteUrl = new URL(`${jupiterApiUrl}/quote`);
  quoteUrl.searchParams.set("inputMint", inputMint);
  quoteUrl.searchParams.set("outputMint", outputMint);
  quoteUrl.searchParams.set("amount", amountIn.toString());
  quoteUrl.searchParams.set("slippageBps", String(slippageBps));

  const quoteResponse = await fetchWithTimeout(quoteUrl.toString(), undefined, DEFAULT_FETCH_TIMEOUT_MS, rateLimiter);
  if (!quoteResponse.ok) {
    throw new SolanaAdapterError(
      "JUPITER_QUOTE_FAILED",
      `Jupiter quote failed (${quoteResponse.status}): ${quoteResponse.body.slice(0, 200)}`,
    );
  }
  // CRIT-04 fix: Validate response structure instead of trusting blind cast
  const quoteRaw: unknown = JSON.parse(quoteResponse.body);
  const quote = validateJupiterQuote(quoteRaw, inputMint, outputMint, slippageBps, amountIn);

  // Step 2: Get swap transaction from Jupiter
  const swapResponse = await fetchWithTimeout(`${jupiterApiUrl}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: signerAddress,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  }, DEFAULT_FETCH_TIMEOUT_MS, rateLimiter);

  if (!swapResponse.ok) {
    throw new SolanaAdapterError(
      "JUPITER_SWAP_FAILED",
      `Jupiter swap failed (${swapResponse.status}): ${swapResponse.body.slice(0, 200)}`,
    );
  }

  // CRIT-04 fix: Validate response structure instead of trusting blind cast
  const swapRaw: unknown = JSON.parse(swapResponse.body);
  const swapData = validateJupiterSwapResponse(swapRaw);

  // Decode the base64 transaction — Jupiter returns a VersionedTransaction
  const swapTransactionBuf = Buffer.from(
    swapData.swapTransaction,
    "base64",
  );

  // Verify it deserializes correctly and contains expected Jupiter programs
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(new Uint8Array(swapTransactionBuf));
  } catch (e) {
    throw new SolanaAdapterError(
      "JUPITER_DESERIALIZE_FAILED",
      `Failed to deserialize Jupiter swap transaction: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // CRIT-07 fix: Validate that the fee payer (staticAccountKeys[0]) matches the signer.
  // A compromised Jupiter API could return a transaction where the fee payer is a different
  // wallet, tricking the signer into paying fees for someone else's transaction or enabling
  // the API to substitute a drain transaction with an attacker-controlled fee payer.
  const feePayer = tx.message.staticAccountKeys[0]?.toBase58();
  if (feePayer !== signerAddress) {
    throw new SolanaAdapterError(
      "JUPITER_FEE_PAYER_MISMATCH",
      `Jupiter swap transaction fee payer mismatch: expected ${signerAddress}, got ${feePayer ?? "undefined"}. ` +
      `This may indicate a compromised API response attempting to substitute a different transaction.`,
    );
  }

  // CHAIN-002: Handle Address Table Lookups (ALTs).
  // Jupiter V6 API returns transactions with ALTs for most swap routes.
  // ALTs add additional account keys (token accounts, etc.) but do NOT change
  // which programs are invoked — program IDs are always in staticAccountKeys.
  // Therefore, validating staticAccountKeys against the program allowlist is
  // sufficient for security, and we do not need to resolve ALTs from the chain.
  const addressTableLookups = tx.message.addressTableLookups;
  const allowALTs = options?.allowAddressLookupTables ?? true;

  if (addressTableLookups && addressTableLookups.length > 0) {
    if (!allowALTs) {
      throw new SolanaAdapterError(
        "JUPITER_ALT_REJECTED",
        `Jupiter swap transaction contains ${addressTableLookups.length} Address Table Lookup(s). ` +
        `ALT resolution is disabled (allowAddressLookupTables=false). ` +
        `Enable ALT resolution or request a non-ALT transaction from Jupiter.`,
      );
    }

    // CHAIN-002: ALTs are present but allowed. Program IDs are always in
    // staticAccountKeys, so our program allowlist validation below remains
    // effective. The ALT-referenced accounts are data accounts (token accounts,
    // AMM pool accounts, etc.) that do not affect which programs are invoked.
    //
    // TODO(CHAIN-002): In a future version, implement full ALT resolution to
    // validate that ALT-referenced accounts match expected patterns (e.g.,
    // known AMM pools, token accounts owned by the signer). This would provide
    // defense-in-depth against a compromised Jupiter API injecting unexpected
    // account references. Resolution requires fetching ALT account data from
    // the chain via connection.getAddressLookupTable().
    console.warn(
      `[kova-wallet] CHAIN-002: Jupiter swap transaction contains ${addressTableLookups.length} ` +
      `Address Lookup Table(s). ALTs are allowed; program validation uses static account keys only. ` +
      `ALT-referenced accounts are not individually validated.`,
    );
  }

  // AUDIT-CRIT-02 fix: Validate EVERY instruction targets a known-safe program.
  // The old check only verified that a Jupiter program was *present* in accountKeys,
  // but a malicious transaction could include Jupiter alongside a drain instruction.
  // Now we verify each instruction's programIdIndex resolves to an allowed program.
  //
  // CHAIN-002: We validate against staticAccountKeys only. In Solana V0 messages,
  // program IDs for compiled instructions are always placed in staticAccountKeys.
  // ALT-resolved keys are used for account inputs (token accounts, pool accounts),
  // not for program invocations. This means programIdIndex will always point within
  // the staticAccountKeys range, making this validation sound even when ALTs are present.
  const accountKeys = tx.message.staticAccountKeys.map((k) => k.toBase58());

  // CHAIN-014 fix: Build the effective allowlist from defaults + caller-provided extras.
  // This allows operators to add new Jupiter program versions or DEX protocols at
  // runtime without waiting for an SDK update.
  const allowedSwapPrograms = new Set(DEFAULT_ALLOWED_SWAP_PROGRAMS);
  if (options?.additionalSwapPrograms) {
    for (const program of options.additionalSwapPrograms) {
      // MED-T2-08 fix: Validate that each additional program ID is a valid base58-encoded
      // Solana public key (32 bytes). Without this validation, arbitrary strings could be
      // added to the allowlist, potentially matching malformed programIdIndex lookups or
      // causing unexpected behavior in the Set.has() check.
      try {
        const pubkey = new PublicKey(program);
        // Use the canonical base58 representation to avoid encoding inconsistencies
        allowedSwapPrograms.add(pubkey.toBase58());
      } catch {
        throw new SolanaAdapterError(
          "INVALID_PARAMS",
          `Invalid program ID in additionalSwapPrograms: "${program}". ` +
          `Each entry must be a valid base58-encoded Solana public key (32 bytes).`,
        );
      }
    }
  }

  // First verify at least one Jupiter program is present
  const hasJupiterProgram = accountKeys.some((key) => KNOWN_JUPITER_PROGRAMS.has(key));
  if (!hasJupiterProgram) {
    throw new SolanaAdapterError(
      "JUPITER_PROGRAM_MISSING",
      `Jupiter swap transaction does not contain any known Jupiter program ID. ` +
      `Account keys: ${accountKeys.slice(0, 10).join(", ")}${accountKeys.length > 10 ? "..." : ""}. ` +
      `This may indicate a compromised API response.`,
    );
  }

  // Then verify ALL instructions target allowed programs
  const compiledInstructions = tx.message.compiledInstructions;
  for (let i = 0; i < compiledInstructions.length; i++) {
    const ix = compiledInstructions[i]!;
    const programKey = accountKeys[ix.programIdIndex];
    if (!programKey || !allowedSwapPrograms.has(programKey)) {
      throw new SolanaAdapterError(
        "JUPITER_UNKNOWN_PROGRAM",
        `Jupiter swap transaction instruction #${i} targets unknown program: ${programKey ?? "undefined"} ` +
        `(programIdIndex=${ix.programIdIndex}). Only known-safe programs are allowed in swap transactions. ` +
        `This may indicate a compromised API injecting malicious instructions.`,
      );
    }
  }

  // LOW-T2-07 fix: Validate that ComputeBudgetProgram instructions do not request
  // excessive compute units. Solana's per-transaction compute unit limit is 1,400,000 CU.
  // A compromised Jupiter API could inject a SetComputeUnitLimit instruction with an
  // unreasonably high value, which combined with a high per-CU priority fee could drain
  // the wallet via excessive fees. We check for the ComputeBudget program and validate
  // the requested compute units against the protocol maximum.
  const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
  const MAX_COMPUTE_UNITS = 1_400_000; // Solana per-transaction maximum
  for (let i = 0; i < compiledInstructions.length; i++) {
    const ix = compiledInstructions[i]!;
    const programKey = accountKeys[ix.programIdIndex];
    if (programKey === COMPUTE_BUDGET_PROGRAM_ID && ix.data.length >= 5) {
      // SetComputeUnitLimit instruction has discriminator byte 2, followed by u32 units
      if (ix.data[0] === 2) {
        const requestedUnits = ix.data[1]! | (ix.data[2]! << 8) | (ix.data[3]! << 16) | (ix.data[4]! << 24);
        if (requestedUnits > MAX_COMPUTE_UNITS) {
          throw new SolanaAdapterError(
            "JUPITER_EXCESSIVE_COMPUTE",
            `Jupiter swap transaction requests ${requestedUnits} compute units, exceeding ` +
            `Solana's per-transaction maximum of ${MAX_COMPUTE_UNITS} CU. ` +
            `This may indicate a manipulated transaction designed to inflate fees.`,
          );
        }
      }
    }
  }

  // CRIT-T2-02 fix: Post-swap output verification is now available via SolanaAdapter.
  // Callers should use adapter.getPreSwapSnapshot() before broadcast and
  // adapter.verifySwapOutput() after confirmation to detect:
  // - Sandwich attacks consuming full slippage tolerance
  // - Partial fills below otherAmountThreshold
  // - Zero-output swaps from edge-case AMM pool states
  // - Discrepancies between quoted and actual output for audit/reconciliation
  //
  // Usage:
  //   const snapshot = await adapter.getPreSwapSnapshot(walletAddress, params.toToken);
  //   const txId = await adapter.broadcast(signedTx.data);
  //   // ... wait for confirmation ...
  //   const verification = await adapter.verifySwapOutput(
  //     walletAddress, snapshot,
  //     BigInt(quote.otherAmountThreshold),
  //     BigInt(quote.outAmount),
  //   );
  //   if (!verification.passed) {
  //     logger.warn(verification.warning);
  //   }

  return {
    chain: "solana",
    data: new Uint8Array(swapTransactionBuf),
    description: `Swap ${params.amount} ${params.fromToken} for ${params.toToken} via Jupiter`,
  };
}

/**
 * HIGH-20 fix: Simple in-memory price cache with TTL.
 * Prevents excessive price API calls and provides sanity checking
 * against stale-but-known-good values.
 *
 * MED-09 limitation: Price cache poisoning via gradual manipulation.
 * The MAX_PRICE_DEVIATION_FACTOR (3x) check prevents sudden price jumps, but an
 * attacker controlling the price oracle could gradually shift the price by just under
 * 3x each cache window (30s), eventually reaching an arbitrarily manipulated price.
 * For example: $100 -> $290 -> $840 -> $2,436 over 90 seconds. Mitigations:
 * - Use multiple independent price oracles and take the median
 * - Implement a rolling window deviation check (e.g., max 10x over 5 minutes)
 * - Cross-reference with on-chain oracle programs (Pyth, Switchboard)
 * - Set absolute price bounds for known tokens
 */
interface PriceCacheEntry {
  price: number;
  fetchedAt: number;
}
const priceCache = new Map<string, PriceCacheEntry>();
const PRICE_CACHE_TTL_MS = 30_000; // 30 seconds
/** HIGH-20 fix: Maximum reasonable price change per cache window (300% = 3x) */
const MAX_PRICE_DEVIATION_FACTOR = 3;

/**
 * CHAIN-007 fix: Maximum age for cached prices before they are considered stale.
 * Prices older than this threshold are rejected entirely (return null) rather than
 * being used for spending limit calculations. This prevents using outdated prices
 * that may no longer reflect market conditions, which could allow under-valued
 * transactions to bypass spending limits.
 *
 * Set to 60 seconds -- prices older than this are considered unreliable for
 * financial decisions. The PRICE_CACHE_TTL_MS (30s) controls when a fresh fetch
 * is attempted; MAX_PRICE_AGE_MS controls the absolute maximum age a cached price
 * can be used (even if the refresh fetch fails).
 */
const MAX_PRICE_AGE_MS = 60_000; // 60 seconds

/**
 * CHAIN-007 fix: Absolute price floor/ceiling bounds for known tokens (USD).
 *
 * These bounds provide a safety net against gradual oracle manipulation. Even if
 * an attacker slowly shifts the price within the 3x relative deviation window across
 * multiple cache windows, the price will be rejected if it falls outside these
 * absolute bounds. This complements the relative MAX_PRICE_DEVIATION_FACTOR check.
 *
 * CHAIN-007 limitation: These bounds are hardcoded and need periodic review.
 * They are intentionally wide to accommodate legitimate market volatility while
 * catching obviously manipulated prices. Tokens not in this map have no absolute
 * bounds (only the relative deviation check applies).
 *
 * CHAIN-007 single-oracle limitation: This SDK relies solely on the Jupiter Price
 * API v2 for USD price data. A compromised or manipulated Jupiter Price API could
 * return prices that pass both the relative deviation check (by shifting gradually)
 * and the absolute bounds check (if bounds are wide enough). For production deployments
 * handling significant value, integrate additional independent price oracles (Pyth,
 * Switchboard, CoinGecko) and use a median or consensus-based approach. The absolute
 * bounds below are a best-effort mitigation for the single-oracle architecture.
 */
const ABSOLUTE_PRICE_BOUNDS: Record<string, { min: number; max: number }> = {
  // SOL: historically $1-$300, bounds set with generous margin
  "So11111111111111111111111111111111111111112": { min: 0.1, max: 2000 },
  // USDC: stablecoin, should always be ~$1
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": { min: 0.90, max: 1.10 },
  // USDT: stablecoin, should always be ~$1
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": { min: 0.90, max: 1.10 },
};

/**
 * Get the USD price of a token via Jupiter Price API v2.
 * Returns null if the token is unknown or the API is unreachable.
 *
 * HIGH-07 fix: Validates price responses are finite, positive, and non-zero.
 * HIGH-20 fix: Caches prices with TTL and rejects anomalous price deviations
 * compared to the last known good value (prevents oracle manipulation).
 *
 * MED-14 note: This relies on a single price oracle (Jupiter Price API v2).
 * For production deployments handling significant value, consider:
 * - Adding a secondary oracle (Pyth, Switchboard, CoinGecko)
 * - Using the median of multiple oracles for spending limit calculations
 * - The price cache (30s TTL) provides some resilience against brief outages
 * - The deviation check (3x max) provides protection against price manipulation
 */
export async function getTokenPriceUSD(
  token: string,
  priceApiUrl: string = DEFAULT_JUPITER_PRICE_API,
  isDevnet: boolean = false,
  rateLimiter?: JupiterRateLimiter,
): Promise<number | null> {
  const mint = resolveTokenMint(token, isDevnet)?.toBase58();
  if (!mint) return null;

  // LOW-11 fix: Clean up stale cache entries to prevent unbounded memory growth.
  // Entries older than 5 minutes are removed. Without this, long-running processes
  // accumulate cache entries for every token ever queried.
  const PRICE_CACHE_MAX_AGE_MS = 300_000; // 5 minutes
  const now = Date.now();
  for (const [key, entry] of priceCache) {
    if (now - entry.fetchedAt > PRICE_CACHE_MAX_AGE_MS) {
      priceCache.delete(key);
    }
  }

  // HIGH-20 fix: Return cached price if still fresh
  const cached = priceCache.get(mint);
  if (cached && Date.now() - cached.fetchedAt < PRICE_CACHE_TTL_MS) {
    return cached.price;
  }

  // CHAIN-007 fix: If cached price exists but exceeds MAX_PRICE_AGE_MS, it is stale.
  // We still attempt a fresh fetch below, but if the fetch fails, we will NOT fall back
  // to this stale price — we return null instead of returning potentially outdated data.
  const cachedIsStale = cached ? (Date.now() - cached.fetchedAt > MAX_PRICE_AGE_MS) : false;

  const url = new URL(`${priceApiUrl}/price`);
  url.searchParams.set("ids", mint);

  try {
    const response = await fetchWithTimeout(url.toString(), undefined, DEFAULT_FETCH_TIMEOUT_MS, rateLimiter);
    if (!response.ok) {
      // CHAIN-007 fix: If fetch fails and cached price is stale, reject entirely
      if (cachedIsStale || !cached) return null;
      return cached.price;
    }

    const data = JSON.parse(response.body) as {
      data?: Record<string, { price?: number }>;
    };
    const priceData = data?.data?.[mint];
    const price = priceData?.price;

    // HIGH-07 fix: Validate the price is a finite positive number
    if (price === undefined || price === null || !Number.isFinite(price) || price <= 0) {
      return null;
    }

    // CHAIN-007 fix: Absolute price floor/ceiling check for known tokens.
    // This catches prices that are within the relative deviation window but
    // outside reasonable absolute bounds (e.g., SOL at $0.001 or $50,000,
    // USDC at $0.50 or $2.00). Complements the relative deviation check below.
    const bounds = ABSOLUTE_PRICE_BOUNDS[mint];
    if (bounds) {
      if (price < bounds.min || price > bounds.max) {
        process.emitWarning(
          `Price for ${mint} ($${price}) is outside absolute bounds ` +
          `[$${bounds.min}, $${bounds.max}]. This may indicate oracle manipulation ` +
          `or an extreme market event. Rejecting price and returning cached value if available.`,
          "KovaPriceWarning",
        );
        // Return cached price if available and not stale, otherwise null
        if (cached && !cachedIsStale) return cached.price;
        return null;
      }
    }

    // HIGH-20 fix: Sanity check — reject anomalous deviations from cached price.
    // If a previously known price exists, the new price must be within a reasonable
    // factor. This detects oracle manipulation or compromised API responses.
    if (cached) {
      const deviationFactor = price > cached.price
        ? price / cached.price
        : cached.price / price;
      if (deviationFactor > MAX_PRICE_DEVIATION_FACTOR) {
        // Anomalous deviation — return stale cached price as a safety measure
        // CHAIN-007: But only if the cached price is not itself stale
        if (cachedIsStale) return null;
        return cached.price;
      }
    }

    // Update cache
    priceCache.set(mint, { price, fetchedAt: Date.now() });
    return price;
  } catch {
    // CHAIN-007 fix: On fetch error, only return cached price if not stale
    if (cached && !cachedIsStale) return cached.price;
    return null;
  }
}
