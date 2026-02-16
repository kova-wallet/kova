/**
 * SolanaAdapter — Chain adapter for Solana.
 *
 * Sprint 3: Real RPC integration via @solana/web3.js.
 * Delegates to transfers.ts, swaps.ts, and utils.ts for specific operations.
 */

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { Agent as HttpsAgent } from "node:https";
import { Agent as HttpAgent } from "node:http";
import { Connection, PublicKey, VersionedTransaction, Transaction } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { ChainAdapter, TransactionStatusResult, SimulationResult } from "../interface.js";
import type { TransactionIntent } from "../../core/intent.js";
import type { UnsignedTransaction } from "../../signers/interface.js";
import type { TokenBalance } from "../../core/result.js";
import { isTransferIntent, isSwapIntent } from "../../core/intent.js";
import { buildSOLTransfer, buildSPLTransfer } from "./transfers.js";
import { buildJupiterSwap, getTokenPriceUSD, JupiterRateLimiter } from "./swaps.js";
import {
  isNativeSOL,
  isValidSolanaAddress,
  resolveTokenMint,
  getTokenDecimals,
  fromSmallestUnit,
  SolanaAdapterError,
} from "./utils.js";

export interface SolanaAdapterConfig {
  /** Solana RPC URL */
  rpcUrl: string;
  /** Commitment level for transaction confirmation */
  commitment?: "processed" | "confirmed" | "finalized";
  /** Jupiter API URL for swaps */
  jupiterApiUrl?: string;
  /** Jupiter Price API URL for USD valuation */
  jupiterPriceApiUrl?: string;
  /**
   * MED-01 fix: Explicit network selection instead of URL sniffing.
   * Determines which token registry (mainnet vs devnet mint addresses) is used.
   * Defaults to "mainnet-beta". Previously inferred from URL containing "devnet",
   * which could misidentify URLs like "https://rpc.mainnet.com/devnet-proxy".
   */
  network?: "mainnet-beta" | "devnet" | "testnet" | "auto";
}

/**
 * HIGH-07/08 fix: Validate URL scheme and reject unsafe targets.
 * Enforces HTTPS for all external connections. Allows HTTP only for localhost/127.0.0.1 (dev).
 * Rejects private/internal network addresses to prevent SSRF.
 */
function validateRpcUrl(url: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SolanaAdapterError("INVALID_CONFIG", `Invalid ${label} URL: ${url}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  const ipv4Parts = hostname.split(".");
  const ipv4Octets =
    ipv4Parts.length === 4 && ipv4Parts.every((p) => /^\d{1,3}$/.test(p))
      ? ipv4Parts.map(Number)
      : null;
  const isValidIpv4 = ipv4Octets ? ipv4Octets.every((o) => o >= 0 && o <= 255) : false;
  const isLoopbackIpv4 = isValidIpv4 ? ipv4Octets![0] === 127 : false;

  const isLocalhost = hostname === "localhost" || hostname === "::1" || isLoopbackIpv4;

  // Enforce HTTPS for non-localhost URLs
  if (parsed.protocol !== "https:" && !isLocalhost) {
    throw new SolanaAdapterError(
      "INSECURE_URL",
      `${label} must use HTTPS for non-localhost URLs. Got: ${parsed.protocol}//${parsed.hostname}`,
    );
  }

  // Reject private/internal network addresses (IPv4 + IPv6)
  if (!isLocalhost) {
    // Check IPv4 private ranges (RFC 1918, link-local, loopback)
    if (isValidIpv4) {
      const [o0, o1] = ipv4Octets!;
      const isPrivate =
        o0 === 10 ||
        (o0 === 172 && o1! >= 16 && o1! <= 31) ||
        (o0 === 192 && o1 === 168) ||
        (o0 === 169 && o1 === 254) ||
        (o0 === 100 && o1! >= 64 && o1! <= 127) || // CGNAT (100.64.0.0/10)
        o0 === 0;
      if (isPrivate) {
        throw new SolanaAdapterError(
          "SSRF_BLOCKED",
          `${label} cannot target private/internal network addresses: ${hostname}`,
        );
      }
    }

    // SEC: Check IPv6 private ranges (ULA fc00::/7, link-local fe80::/10, loopback ::1,
    // IPv4-mapped ::ffff:x.x.x.x, and other non-global addresses)
    if (hostname.includes(":")) {
      const lower = hostname.toLowerCase();
      const isPrivateIPv6 =
        lower.startsWith("fc") || lower.startsWith("fd") || // ULA (fc00::/7)
        lower.startsWith("fe80") ||                          // Link-local (fe80::/10)
        lower.startsWith("::ffff:") ||                       // IPv4-mapped IPv6
        lower.startsWith("100:") ||                          // Discard prefix (100::/64)
        lower === "::";                                      // Unspecified address
      if (isPrivateIPv6) {
        throw new SolanaAdapterError(
          "SSRF_BLOCKED",
          `${label} cannot target private/internal IPv6 addresses: ${hostname}`,
        );
      }
    }
  }
}

/**
 * CHAIN-001 fix: IP-pinning DNS cache to eliminate DNS rebinding TOCTOU.
 *
 * Problem: DNS rebinding TOCTOU — previously we resolved DNS for validation, then
 * @solana/web3.js Connection resolved DNS again independently when making HTTP
 * requests. An attacker controlling DNS could return a public IP first (pass
 * validation), then a private IP second (reach internal services).
 *
 * Fix: Resolve the hostname ONCE, validate the resolved IP against the private IP
 * blocklist, cache the validated result, and inject a custom http(s).Agent into the
 * Connection with a `lookup` override that returns the pre-validated, cached IP.
 * This ensures the same validated IP is used for both the security check and the
 * actual HTTP request — eliminating the TOCTOU window entirely.
 *
 * Cache entries have a 60-second TTL. When an entry expires, the next request
 * triggers a fresh DNS resolution + validation cycle before the request proceeds.
 */
interface DnsCacheEntry {
  resolvedIp: string;
  family: 4 | 6;
  resolvedAt: number;
}
/**
 * CONC-02 KNOWN LIMITATION: This DNS cache is module-level and shared across ALL
 * SolanaAdapter instances within the same Node.js process. A compromised DNS
 * response cached by one adapter affects all wallets' SSRF protection. This is
 * acceptable for the primary single-wallet deployment model. For multi-wallet
 * isolation, use separate processes or worker_threads.
 */
const dnsCache = new Map<string, DnsCacheEntry>();
const DNS_CACHE_TTL_MS = 60_000; // 60 seconds
/**
 * M-26 / L-27 fix: Maximum DNS cache size to prevent unbounded memory growth.
 * When the cache exceeds this size, the oldest entries are evicted before adding new ones.
 * This bounds memory usage to at most MAX_DNS_CACHE_SIZE * ~100 bytes per entry.
 */
const MAX_DNS_CACHE_SIZE = 100;
/**
 * M-26 fix: Maximum DNS cache entry lifetime. Entries older than this are evicted
 * during periodic cleanup regardless of TTL. Prevents stale entries from accumulating
 * if hostnames are queried once and never again.
 */
const DNS_CACHE_MAX_AGE_MS = 300_000; // 5 minutes

/**
 * M-26 fix: Evict expired and excess entries from the DNS cache.
 * Called before adding new entries to enforce the MAX_DNS_CACHE_SIZE bound.
 */
function evictDnsCache(): void {
  const now = Date.now();
  // First pass: remove expired entries (older than max age)
  for (const [key, entry] of dnsCache) {
    if (now - entry.resolvedAt > DNS_CACHE_MAX_AGE_MS) {
      dnsCache.delete(key);
    }
  }
  // Second pass: if still over capacity, remove oldest entries
  if (dnsCache.size >= MAX_DNS_CACHE_SIZE) {
    const entries = [...dnsCache.entries()].sort(
      (a, b) => a[1].resolvedAt - b[1].resolvedAt,
    );
    const toRemove = entries.slice(0, dnsCache.size - MAX_DNS_CACHE_SIZE + 1);
    for (const [key] of toRemove) {
      dnsCache.delete(key);
    }
  }
}

/**
 * Check whether an IPv4 address falls within a private/internal range.
 * Covers RFC 1918, loopback, link-local, CGNAT, and unspecified addresses.
 */
function isPrivateIPv4(ip: string): boolean {
  const octets = ip.split(".").map(Number);
  if (octets.length !== 4) return false;
  const [o0, o1] = octets;
  return (
    o0 === 10 ||
    (o0 === 172 && o1! >= 16 && o1! <= 31) ||
    (o0 === 192 && o1 === 168) ||
    (o0 === 169 && o1 === 254) ||
    (o0 === 100 && o1! >= 64 && o1! <= 127) ||
    o0 === 127 ||
    o0 === 0
  );
}

/**
 * M-46 / L-20 fix: Check whether an IPv6 address falls within a private/reserved range.
 * Covers loopback (::1), ULA (fc00::/7), link-local (fe80::/10), IPv4-mapped (::ffff:0:0/96),
 * discard prefix (100::/64), documentation (2001:db8::/32), 6to4 (2002::/16), Teredo (2001::/32),
 * and the unspecified address (::).
 */
function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // Unspecified address
  if (lower === "::" || lower === "0:0:0:0:0:0:0:0") return true;
  // Loopback
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
  // ULA (fc00::/7 — addresses starting with fc or fd)
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // Link-local (fe80::/10 — addresses starting with fe8, fe9, fea, feb)
  if (/^fe[89ab]/i.test(lower)) return true;
  // IPv4-mapped IPv6 (::ffff:x.x.x.x)
  if (lower.startsWith("::ffff:")) return true;
  // Discard prefix (100::/64)
  if (lower.startsWith("100:")) return true;
  // Documentation (2001:db8::/32)
  if (lower.startsWith("2001:db8:") || lower.startsWith("2001:0db8:")) return true;
  // 6to4 (2002::/16) — may embed private IPv4 addresses
  if (lower.startsWith("2002:")) return true;
  // Teredo (2001:0000::/32) — tunneling protocol, may bypass network controls
  if (lower.startsWith("2001:0000:") || lower.startsWith("2001:0:")) return true;
  return false;
}

/**
 * HIGH-01 / CHAIN-001 fix: Resolve DNS, validate the resolved IP is not
 * private/internal, and return the validated IP for pinning.
 *
 * This function is the single point of DNS resolution. The returned IP is
 * cached and injected into the http(s).Agent `lookup` override so that
 * @solana/web3.js Connection uses the exact same IP we validated — no
 * second DNS lookup occurs.
 *
 * Returns the validated IP address string, or null if the hostname is a
 * localhost/IP literal (where pinning is not needed).
 */
async function resolveAndValidateDns(url: string, label: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SolanaAdapterError("INVALID_CONFIG", `Invalid ${label} URL: ${url}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // Skip DNS resolution for localhost and IP literals
  if (hostname === "localhost" || hostname === "::1" || hostname === "127.0.0.1") {
    return null;
  }

  // If hostname is already an IP literal, skip resolution
  const ipv4Parts = hostname.split(".");
  if (ipv4Parts.length === 4 && ipv4Parts.every((p) => /^\d{1,3}$/.test(p))) {
    return null; // IP was already validated by validateRpcUrl
  }

  // Check DNS cache before resolving
  const now = Date.now();
  const cached = dnsCache.get(hostname);
  if (cached && (now - cached.resolvedAt) < DNS_CACHE_TTL_MS) {
    // Cached entry is still valid — IP was already validated when cached
    return cached.resolvedIp;
  }

  // M-46 fix: Try to resolve both IPv4 (A) and IPv6 (AAAA) records.
  // Prefer IPv4 (family: 4) but fall back to IPv6 (family: 6) if unavailable.
  // Validate the resolved IP against the appropriate private range blocklist.
  try {
    let ip: string;
    let family: 4 | 6;
    try {
      const result = await lookup(hostname, { family: 4 });
      ip = result.address;
      family = 4;
    } catch {
      // M-46 fix: IPv4 resolution failed, try IPv6
      const result = await lookup(hostname, { family: 6 });
      ip = result.address;
      family = 6;
    }

    // Validate against appropriate private range blocklist
    const isPrivate = family === 4 ? isPrivateIPv4(ip) : isPrivateIPv6(ip);
    if (isPrivate) {
      // Remove any stale cache entry for this hostname
      dnsCache.delete(hostname);
      throw new SolanaAdapterError(
        "SSRF_BLOCKED",
        `${label} hostname "${hostname}" resolved to private IPv${family} address ${ip}. ` +
        `This may indicate a DNS rebinding attack.`,
      );
    }

    // M-26 fix: Evict expired/excess entries before caching
    evictDnsCache();
    // Cache the validated resolution
    dnsCache.set(hostname, { resolvedIp: ip, family, resolvedAt: Date.now() });
    return ip;
  } catch (err) {
    if (err instanceof SolanaAdapterError) throw err;
    // LOW-T2-05 fix: Sanitize DNS error to remove hostname details that could leak
    // infrastructure information (internal hostnames, DNS server addresses, etc.).
    // Previously, err.message was included verbatim, which could contain the hostname.
    throw new SolanaAdapterError(
      "VALIDATION_ERROR",
      `DNS resolution failed for ${label} (fail-closed): unable to resolve hostname`
    );
  }
}

/**
 * CHAIN-001 fix: Create an http(s).Agent with a custom `lookup` that pins DNS
 * resolution to pre-validated IPs from our cache.
 *
 * The lookup override:
 * 1. Checks the DNS cache for a valid (non-expired) entry
 * 2. If found, returns the cached IP directly (no DNS query)
 * 3. If expired or missing, resolves DNS fresh, validates the IP against the
 *    private IP blocklist, caches the result, and returns it
 *
 * This eliminates the TOCTOU gap: the IP used for the actual TCP connection is
 * guaranteed to be the same IP that passed our SSRF validation.
 */
function createPinnedLookup(
  label: string,
): (
  hostname: string,
  options: { family?: number },
  callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
) => void {
  return (hostname, _options, callback) => {
    const lower = hostname.toLowerCase();

    // Localhost/loopback: allow through without pinning
    if (lower === "localhost" || lower === "::1" || lower === "127.0.0.1") {
      callback(null, lower === "localhost" ? "127.0.0.1" : lower, lower === "::1" ? 6 : 4);
      return;
    }

    // Check cache for a valid entry
    const now = Date.now();
    const cached = dnsCache.get(lower);
    if (cached && (now - cached.resolvedAt) < DNS_CACHE_TTL_MS) {
      callback(null, cached.resolvedIp, cached.family);
      return;
    }

    // Cache miss or expired: resolve, validate, cache, return
    // M-46 fix: Try IPv4 first, fall back to IPv6
    lookup(lower, { family: 4 })
      .catch(() => lookup(lower, { family: 6 }))
      .then((result) => {
        const ip = result.address;
        const resolvedFamily: 4 | 6 = result.family === 6 ? 6 : 4;

        // M-46 / L-20 fix: Validate against appropriate private range blocklist
        const isPrivate = resolvedFamily === 4 ? isPrivateIPv4(ip) : isPrivateIPv6(ip);
        if (isPrivate) {
          dnsCache.delete(lower);
          callback(
            new SolanaAdapterError(
              "SSRF_BLOCKED",
              `${label} hostname "${lower}" resolved to private IPv${resolvedFamily} address ${ip}. ` +
              `This may indicate a DNS rebinding attack.`,
            ) as NodeJS.ErrnoException,
            "",
            resolvedFamily,
          );
          return;
        }

        // M-26 fix: Evict expired/excess entries before caching
        evictDnsCache();
        dnsCache.set(lower, { resolvedIp: ip, family: resolvedFamily, resolvedAt: Date.now() });
        callback(null, ip, resolvedFamily);
      })
      .catch((_err: unknown) => {
        // LOW-T2-05 fix: Sanitize DNS error to remove hostname details that could
        // leak infrastructure information. Do not include err.message verbatim.
        callback(
          new SolanaAdapterError(
            "VALIDATION_ERROR",
            `DNS resolution failed for ${label} (fail-closed): unable to resolve hostname`,
          ) as NodeJS.ErrnoException,
          "",
          4,
        );
      });
  };
}

/**
 * CHAIN-001 fix: Create an HTTP(S) agent with IP-pinned DNS lookup for a given URL.
 * Returns an https.Agent for HTTPS URLs or an http.Agent for HTTP localhost URLs.
 * The agent's `lookup` function returns only pre-validated, cached IP addresses.
 */
function createPinnedAgent(url: string, label: string): HttpsAgent | HttpAgent {
  const parsed = new URL(url);
  const pinnedLookup = createPinnedLookup(label);

  if (parsed.protocol === "https:") {
    // H-28: TLS certificate pinning is NOT implemented in this agent.
    // For production deployments handling significant value, TLS certificate pinning
    // (or public key pinning) is recommended to prevent MITM attacks via compromised
    // Certificate Authorities. Implementation options:
    // - Use the `ca` option on HttpsAgent to restrict trusted CAs to a specific set
    // - Use the `checkServerIdentity` callback to verify the server's certificate
    //   fingerprint against a known-good value
    // - Use a certificate transparency log monitor to detect misissued certificates
    // Implementing cert pinning requires infrastructure changes (certificate rotation
    // procedures, pin list management, backup pins) and is beyond the scope of the SDK.
    // See OWASP Certificate Pinning: https://owasp.org/www-community/controls/Certificate_and_Public_Key_Pinning
    return new HttpsAgent({
      lookup: pinnedLookup as never,
      // Keep connections alive for efficiency, but limit pool size
      keepAlive: true,
      maxSockets: 10,
      // NET-04 fix: Explicitly enforce minimum TLS 1.2 to prevent downgrade attacks
      // (BEAST, POODLE). While Node.js 18+ defaults to TLS 1.2, this could be
      // overridden via NODE_OPTIONS or build flags. Explicit enforcement ensures
      // strong TLS for this financial application regardless of runtime config.
      minVersion: "TLSv1.2",
      // NET-09 fix: Configure socket pool timeouts to prevent idle connection
      // accumulation in long-running processes. Without this, keepalive connections
      // persist indefinitely, pinned to potentially stale IPs.
      // Note: freeSocketTimeout is not in the Node.js AgentOptions type but is
      // supported at runtime. We use the standard `timeout` option instead.
      timeout: 30_000,
    });
  }

  // HTTP is only allowed for localhost (enforced by validateRpcUrl)
  return new HttpAgent({
    lookup: pinnedLookup as never,
    keepAlive: true,
    maxSockets: 10,
    timeout: 30_000,
  });
}

export class SolanaAdapter implements ChainAdapter {
  readonly chain = "solana";
  private readonly connection: Connection;
  private readonly config: SolanaAdapterConfig;
  private readonly isDevnet: boolean;
  /**
   * MED-T2-03 fix: Per-instance Jupiter API rate limiter.
   * Previously, the rate limiter was module-global in swaps.ts, causing all
   * adapter instances to share a single rate limit counter. This could lead
   * to unexpected throttling in multi-wallet or multi-tenant scenarios.
   */
  private readonly jupiterRateLimiter = new JupiterRateLimiter();

  /**
   * CHAIN-001 fix: Track when DNS was last eagerly validated for configured URLs.
   * The pinned agent's lookup function handles per-request IP validation via the
   * DNS cache, but we also eagerly warm the cache before the first request and
   * periodically re-warm it to catch DNS changes proactively.
   */
  private dnsValidatedAt = 0;
  /** NET-09 fix: Reference to the pinned agent for socket pool cleanup in destroy() */
  private pinnedAgent: HttpsAgent | HttpAgent | undefined;
  /**
   * T2-2.2 fix: Track hostnames resolved by this adapter instance.
   * Used by destroy() to clear only this instance's DNS cache entries instead
   * of clearing the entire module-level cache, which would invalidate entries
   * for other SolanaAdapter instances in multi-tenant environments.
   */
  private readonly instanceHostnames = new Set<string>();
  /** DNS revalidation interval (5 minutes) — eagerly re-warms the DNS cache */
  private static readonly DNS_REVALIDATION_TTL_MS = 300_000;

  constructor(config: SolanaAdapterConfig) {
    // HIGH-07/08 fix: Validate all URLs before using them
    validateRpcUrl(config.rpcUrl, "RPC");
    if (config.jupiterApiUrl) validateRpcUrl(config.jupiterApiUrl, "Jupiter API");
    if (config.jupiterPriceApiUrl) validateRpcUrl(config.jupiterPriceApiUrl, "Jupiter Price API");

    this.config = config;

    // T2-2.2 fix: Track hostnames this adapter resolves so destroy() can
    // clear only this instance's DNS cache entries, not the entire cache.
    try { this.instanceHostnames.add(new URL(config.rpcUrl).hostname.toLowerCase()); } catch { /* ignore */ }
    if (config.jupiterApiUrl) {
      try { this.instanceHostnames.add(new URL(config.jupiterApiUrl).hostname.toLowerCase()); } catch { /* ignore */ }
    }
    if (config.jupiterPriceApiUrl) {
      try { this.instanceHostnames.add(new URL(config.jupiterPriceApiUrl).hostname.toLowerCase()); } catch { /* ignore */ }
    }

    // CHAIN-001 fix: Create Connection with an IP-pinning HTTP agent.
    // The agent's custom `lookup` function returns only pre-validated, cached IPs
    // from our DNS cache, ensuring @solana/web3.js Connection uses the exact same
    // IP that passed our SSRF validation. This eliminates the DNS rebinding TOCTOU
    // where an attacker could return a public IP for validation then a private IP
    // for the actual HTTP request.
    // NET-09 fix: Store reference for cleanup in destroy()
    this.pinnedAgent = createPinnedAgent(config.rpcUrl, "RPC");
    const pinnedAgent = this.pinnedAgent;
    this.connection = new Connection(config.rpcUrl, {
      commitment: config.commitment ?? "confirmed",
      httpAgent: pinnedAgent,
    });
    // MED-01 fix: Use explicit network config instead of fragile URL sniffing.
    // CHAIN-013 fix: Default to mainnet-beta when network is not set, instead of URL sniffing.
    // URL-based detection is only used when config.network is explicitly set to "auto".
    //
    // MED-15 recommendation: Always set config.network explicitly rather than relying
    // on URL-based detection. URL sniffing can misidentify the network — e.g.,
    // "https://rpc.mainnet.com/devnet-proxy" would be treated as devnet, causing wrong
    // token mint addresses and potentially sending funds to the wrong tokens.
    if (!config.network) {
      process.emitWarning(
        "SolanaAdapter: config.network not set, defaulting to mainnet-beta. Set config.network explicitly to suppress this warning.",
        "KovaDeprecationWarning"
      );
    }
    if (config.network === "auto") {
      // L-21 WARNING: URL-based network detection is exploitable. An attacker who controls
      // the RPC URL (e.g., via config injection) could include "devnet" in a mainnet URL
      // (e.g., "https://evil.com/devnet-path") to force devnet token mints on mainnet,
      // causing transfers to target wrong tokens. Always prefer explicit network configuration
      // (config.network = "mainnet-beta" | "devnet" | "testnet") over "auto" mode.
      this.isDevnet = config.rpcUrl.includes("devnet");
    } else {
      this.isDevnet = (config.network ?? "mainnet-beta") === "devnet";
    }
  }

  /**
   * CHAIN-001 fix: Eagerly warm the DNS cache for all configured URLs.
   *
   * While the pinned agent's lookup function will resolve and validate DNS
   * on every cache miss (providing fail-closed security), this method eagerly
   * pre-warms the cache before the first request and re-warms it periodically.
   * This ensures that:
   * 1. DNS errors are surfaced early (before a transaction is in-flight)
   * 2. The first request doesn't pay the DNS resolution latency penalty
   * 3. DNS rebinding is detected proactively, not just reactively
   */
  private async ensureDnsValidated(): Promise<void> {
    const now = Date.now();
    if (this.dnsValidatedAt > 0 && (now - this.dnsValidatedAt) < SolanaAdapter.DNS_REVALIDATION_TTL_MS) {
      return;
    }
    await resolveAndValidateDns(this.config.rpcUrl, "RPC");
    if (this.config.jupiterApiUrl) {
      await resolveAndValidateDns(this.config.jupiterApiUrl, "Jupiter API");
    }
    if (this.config.jupiterPriceApiUrl) {
      await resolveAndValidateDns(this.config.jupiterPriceApiUrl, "Jupiter Price API");
    }
    this.dnsValidatedAt = now;
  }

  /**
   * Get the wallet's balance for a specific token.
   * SOL: queries native lamport balance via getBalance().
   * SPL: looks up the Associated Token Account.
   */
  async getBalance(address: string, token: string): Promise<TokenBalance> {
    // HIGH-01 fix: Validate DNS before external requests
    await this.ensureDnsValidated();
    if (!isValidSolanaAddress(address)) {
      throw new SolanaAdapterError(
        "INVALID_ADDRESS",
        `Invalid Solana address: ${address}`,
      );
    }

    const pubkey = new PublicKey(address);

    if (isNativeSOL(token)) {
      const lamports = await this.connection.getBalance(pubkey);
      const amount = fromSmallestUnit(BigInt(lamports), 9);

      // LOW-T2-04 fix: usdValue is undefined when price cannot be determined for a
      // non-zero balance (price API failure or null price). This is distinct from
      // usdValue: 0 which means balance is genuinely zero. Callers should treat
      // undefined as "price unknown" and 0 as "known zero value".
      let usdValue: number | undefined;
      try {
        const price = await getTokenPriceUSD(
          "SOL",
          this.config.jupiterPriceApiUrl,
          this.isDevnet,
          this.jupiterRateLimiter,
        );
        if (price !== null) {
          usdValue = parseFloat(amount) * price;
        }
      } catch {
        // Price fetch failure is non-fatal — usdValue remains undefined
      }

      return { token, amount, decimals: 9, usdValue };
    }

    // SPL token balance
    const mint = resolveTokenMint(token, this.isDevnet);
    if (!mint) {
      throw new SolanaAdapterError(
        "INVALID_TOKEN",
        `Unknown token: ${token}`,
      );
    }

    const ata = getAssociatedTokenAddressSync(mint, pubkey);
    const decimals = getTokenDecimals(token, this.isDevnet) ?? 0;

    try {
      const account = await getAccount(this.connection, ata);
      const amount = fromSmallestUnit(account.amount, decimals);

      let usdValue: number | undefined;
      try {
        const price = await getTokenPriceUSD(
          token,
          this.config.jupiterPriceApiUrl,
          this.isDevnet,
          this.jupiterRateLimiter,
        );
        if (price !== null) {
          usdValue = parseFloat(amount) * price;
        }
      } catch {
        /* non-fatal */
      }

      return { token, amount, decimals, usdValue };
    } catch {
      // LOW-T2-04 fix: ATA doesn't exist — balance is genuinely zero, so usdValue is
      // definitively 0 (not undefined). This is distinct from the case where balance is
      // non-zero but the price API fails (usdValue: undefined means "unknown"). The
      // distinction matters for callers: 0 means "we know the value is zero", undefined
      // means "we could not determine the value".
      return { token, amount: "0", decimals, usdValue: 0 };
    }
  }

  /**
   * Get the USD value of a token amount via Jupiter Price API.
   * Falls back to $1 for stablecoins. Throws for unknown tokens (fail-closed).
   *
   * MED-14 limitation: parseFloat() is used to convert the amount string to a number
   * for multiplication with the price. IEEE 754 double-precision floats have ~15-17
   * significant decimal digits of precision. For very large amounts (> 2^53) or amounts
   * requiring high precision (e.g., "999999999999999.123456789"), the result may have
   * rounding errors. For spending limit enforcement, this is acceptable because the
   * error is negligible relative to typical limit thresholds, but a BigDecimal library
   * (e.g., decimal.js) would be more precise for high-value transactions.
   */
  async getValueInUSD(token: string, amount: string): Promise<number> {
    const price = await getTokenPriceUSD(
      token,
      this.config.jupiterPriceApiUrl,
      this.isDevnet,
      this.jupiterRateLimiter,
    );

    if (price === null) {
      // CRIT-CROSS-02 fix: Fail-closed when price is unavailable for ALL tokens,
      // including stablecoins. Previously, USDC/USDT fell back to a hardcoded $1
      // price, which allowed transactions to bypass USD-denominated spending limits
      // during depeg events (e.g., UST 2022, USDC 2023) or when the price API was
      // unreachable. Now all tokens fail-closed when the oracle is unavailable,
      // ensuring spending limits and approval gates cannot be bypassed.
      throw new SolanaAdapterError(
        "PRICE_UNAVAILABLE",
        `Cannot determine USD price for ${token}. Price oracle unavailable. ` +
        `All USD-denominated limits require a live price feed.`,
      );
    }

    const amountNum = parseFloat(amount);
    // MED-T2-07 fix: Warn at a practical threshold where IEEE 754 precision loss
    // starts to materially affect financial calculations. The previous threshold
    // (Number.MAX_SAFE_INTEGER = 2^53 ~= 9e15) was too high — parseFloat() on
    // decimal strings starts losing sub-cent precision well before that. At 1e12
    // (1 trillion), the multiplication with price can lose precision in the
    // fractional part, which matters for spending limit enforcement.
    // For amounts above this threshold, callers should use a BigDecimal library.
    const PRECISION_WARNING_THRESHOLD = 1e12; // 1 trillion
    if (!Number.isFinite(amountNum) || amountNum < 0) {
      throw new SolanaAdapterError(
        "INVALID_PARAMS",
        `Invalid amount for USD valuation: "${amount}" (parsed as ${amountNum}). ` +
        `Amount must be a finite positive number.`,
      );
    }
    if (amountNum > PRECISION_WARNING_THRESHOLD) {
      process.emitWarning(
        `USD valuation for amount ${amount} may lose precision (exceeds ${PRECISION_WARNING_THRESHOLD}). ` +
        `IEEE 754 double-precision floats have ~15-17 significant digits. ` +
        `For high-value transactions, consider using a BigDecimal library for exact arithmetic.`,
        "KovaPrecisionWarning"
      );
    }
    return amountNum * price;
  }

  /**
   * Build an unsigned transaction from a TransactionIntent.
   * Dispatches to the appropriate builder based on intent type.
   *
   * CHAIN-004 WARNING — Blockhash Staleness Risk:
   * The transaction's recentBlockhash is set during this method call. Solana blockhashes
   * expire after ~60-90 seconds (~150 slots). If there is a delay between building the
   * transaction and broadcasting it (e.g., waiting for human approval via Telegram or
   * policy evaluation), the blockhash may become stale, causing "blockhash not found"
   * errors at broadcast time. The blockhash is baked into the signed transaction and
   * cannot be updated without rebuilding and re-signing.
   *
   * Callers that expect approval delays should use `refreshBlockhash()` to re-fetch
   * a recent blockhash and rebuild the transaction just before broadcast. Alternatively,
   * set approval timeouts shorter than 60 seconds in the policy engine.
   */
  async buildTransaction(
    intent: TransactionIntent,
    signerAddress: string,
  ): Promise<UnsignedTransaction> {
    // HIGH-01 fix: Validate DNS before external requests
    await this.ensureDnsValidated();
    if (isTransferIntent(intent)) {
      const { token } = intent.params;

      if (isNativeSOL(token)) {
        return buildSOLTransfer(this.connection, intent.params, signerAddress);
      }
      return buildSPLTransfer(
        this.connection,
        intent.params,
        signerAddress,
        this.isDevnet,
      );
    }

    if (isSwapIntent(intent)) {
      return buildJupiterSwap(
        this.connection,
        intent.params,
        signerAddress,
        this.config.jupiterApiUrl,
        this.isDevnet,
        undefined, // options
        this.jupiterRateLimiter,
      );
    }

    throw new SolanaAdapterError(
      "UNSUPPORTED_INTENT",
      `Intent type "${intent.type}" is not yet supported on Solana. Supported: transfer, swap.`,
    );
  }

  /**
   * CHAIN-004 fix: Refresh the blockhash on an unsigned transaction to prevent staleness.
   * Call this after approval delays (e.g., Telegram approval) and before signing/broadcast.
   * Returns a new UnsignedTransaction with an updated recentBlockhash and lastValidBlockHeight.
   *
   * Note: This returns a NEW unsigned transaction that must be re-signed. The old signed
   * transaction is invalidated because the blockhash change alters the transaction bytes.
   */
  async refreshBlockhash(unsignedTx: UnsignedTransaction): Promise<UnsignedTransaction> {
    await this.ensureDnsValidated();

    // M-27 fix: Reject already-signed transactions. Refreshing a signed transaction
    // invalidates the signatures because the blockhash is part of the signed message.
    // The caller must refresh BEFORE signing, not after.
    let hasSignatures = false;
    try {
      const checkTx = VersionedTransaction.deserialize(unsignedTx.data);
      hasSignatures = checkTx.signatures.some((sig) =>
        sig.some((byte) => byte !== 0),
      );
    } catch {
      try {
        const legacyCheck = Transaction.from(unsignedTx.data);
        hasSignatures = legacyCheck.signatures.some(
          (sig) => sig.signature !== null && sig.signature.some((byte) => byte !== 0),
        );
      } catch {
        // If we can't parse either format, we'll fail below during deserialization
      }
    }
    if (hasSignatures) {
      throw new SolanaAdapterError(
        "INVALID_PARAMS",
        `Cannot refresh blockhash on a signed transaction. Refreshing the blockhash changes the transaction ` +
        `message, which invalidates existing signatures. Call refreshBlockhash() BEFORE signing.`,
      );
    }

    const latestBlockhash = await this.connection.getLatestBlockhash();

    // CRIT-06 fix: Support both VersionedTransaction and legacy Transaction formats.
    // Transfers create legacy Transaction objects while swaps create VersionedTransaction.
    let serialized: Uint8Array;
    try {
      const tx = VersionedTransaction.deserialize(unsignedTx.data);
      tx.message.recentBlockhash = latestBlockhash.blockhash;
      serialized = tx.serialize();
    } catch {
      try {
        const legacyTx = Transaction.from(unsignedTx.data);
        legacyTx.recentBlockhash = latestBlockhash.blockhash;
        legacyTx.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;
        serialized = legacyTx.serialize({ requireAllSignatures: false, verifySignatures: false });
      } catch (err) {
        throw new SolanaAdapterError(
          "INTEGRITY_CHECK_FAILED",
          `Failed to deserialize transaction for blockhash refresh (tried both VersionedTransaction and legacy Transaction): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return {
      chain: unsignedTx.chain,
      data: serialized,
      description: unsignedTx.description,
    };
  }

  /**
   * CHAIN-005 fix: Compute a SHA-256 hash of the transaction message bytes (excluding
   * signatures) for pre/post-sign integrity verification.
   *
   * After simulation passes, the unsigned transaction is sent to the signer. A compromised
   * or buggy signer could modify the transaction instructions (e.g., change the recipient,
   * alter the amount, add drain instructions) while producing a valid signature. This method
   * provides the "before" hash for comparison after signing.
   *
   * Usage: Call this between sign() and broadcast() in the execution pipeline:
   *   const unsigned = await adapter.buildTransaction(intent, address);
   *   const preSignHash = SolanaAdapter.hashTransactionMessage(unsigned.data);
   *   const signed = await signer.sign(unsigned);
   *   SolanaAdapter.verifyTransactionIntegrity(unsigned.data, signed.data, preSignHash);
   *   await adapter.broadcast(signed.data);
   */
  static hashTransactionMessage(txData: Uint8Array): string {
    // CRIT-06 fix: Support both VersionedTransaction and legacy Transaction formats.
    // Transfers create legacy Transaction objects while swaps create VersionedTransaction.
    // Try VersionedTransaction first; if it fails, fall back to legacy Transaction.
    let messageBytes: Uint8Array;
    try {
      const tx = VersionedTransaction.deserialize(txData);
      messageBytes = tx.message.serialize();
    } catch {
      try {
        const legacyTx = Transaction.from(txData);
        messageBytes = legacyTx.serializeMessage();
      } catch (err) {
        throw new SolanaAdapterError(
          "INTEGRITY_CHECK_FAILED",
          `Failed to deserialize transaction for hashing (tried both VersionedTransaction and legacy Transaction): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return createHash("sha256").update(messageBytes).digest("hex");
  }

  /**
   * CHAIN-005 fix: Compare the transaction message hash before and after signing.
   * Throws SolanaAdapterError if the message was modified during signing, which indicates
   * a compromised signer that altered instructions, accounts, or other transaction data.
   *
   * @param unsignedTxData - The original unsigned transaction bytes (used for context only)
   * @param signedTxData - The signed transaction bytes returned by the signer
   * @param preSignHash - The SHA-256 hash from hashTransactionMessage() before signing
   */
  static verifyTransactionIntegrity(
    _unsignedTxData: Uint8Array,
    signedTxData: Uint8Array,
    preSignHash: string,
  ): void {
    // CRIT-06 fix: Support both VersionedTransaction and legacy Transaction formats.
    // Transfers create legacy Transaction objects while swaps create VersionedTransaction.
    let postSignHash: string;
    try {
      let messageBytes: Uint8Array;
      try {
        const signedTx = VersionedTransaction.deserialize(signedTxData);
        messageBytes = signedTx.message.serialize();
      } catch {
        const legacyTx = Transaction.from(signedTxData);
        messageBytes = legacyTx.serializeMessage();
      }
      postSignHash = createHash("sha256").update(messageBytes).digest("hex");
    } catch (err) {
      throw new SolanaAdapterError(
        "INTEGRITY_CHECK_FAILED",
        `Failed to deserialize signed transaction for integrity check (tried both VersionedTransaction and legacy Transaction): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (preSignHash !== postSignHash) {
      throw new SolanaAdapterError(
        "TRANSACTION_TAMPERED",
        `Transaction message was modified during signing. ` +
        `Pre-sign hash: ${preSignHash}, post-sign hash: ${postSignHash}. ` +
        `This indicates a compromised signer that altered the transaction instructions, ` +
        `accounts, or other data. The transaction has been rejected and will NOT be broadcast.`,
      );
    }
  }

  /**
   * CORE-002 / CHAIN-005 fix: Verify that signed transaction message matches unsigned.
   * Delegates to the static verifyTransactionIntegrity method.
   */
  verifyTransactionIntegrity(unsignedTxData: Uint8Array, signedTxData: Uint8Array): void {
    const preSignHash = SolanaAdapter.hashTransactionMessage(unsignedTxData);
    SolanaAdapter.verifyTransactionIntegrity(unsignedTxData, signedTxData, preSignHash);
  }

  /**
   * CRIT-02 fix: Simulate a transaction before signing to detect on-chain errors early.
   * Uses Solana's simulateTransaction RPC method to dry-run the transaction.
   * This catches insufficient balance, program errors, and other issues without spending fees.
   *
   * HIGH-T2-01: SIMULATION ACCURACY LIMITATION — Simulation results may differ from
   * actual execution because on-chain state (account balances, PDA data, validator
   * slots) can change between simulation and broadcast. Simulation provides a best-effort
   * pre-check but is NOT a guarantee of execution success. Specifically:
   * - Another transaction may spend the same tokens between simulation and confirmation
   * - Program state may be updated by other transactions during the interval
   * - Validator slot leaders may differ, affecting compute budget pricing
   * - Clock-dependent programs may behave differently at actual execution time
   * For critical transactions, verify the on-chain result after broadcast confirmation.
   *
   * HIGH-T2-06: BALANCE CHECK TOCTOU — The balance check in getBalance() is inherently
   * racy: between checking the balance and broadcasting the transaction, the balance may
   * have changed due to incoming/outgoing transfers or fee deductions from other
   * transactions. This is an inherent limitation of account-based blockchains. The
   * simulation step provides a second check, but the same TOCTOU applies.
   */
  async simulateTransaction(txData: Uint8Array): Promise<SimulationResult> {
    try {
      // CRIT-06 fix: Support both VersionedTransaction and legacy Transaction formats.
      let tx: VersionedTransaction;
      try {
        tx = VersionedTransaction.deserialize(txData);
      } catch {
        // Legacy Transaction: convert to VersionedTransaction for simulation
        const legacyTx = Transaction.from(txData);
        const messageV0 = legacyTx.compileMessage();
        tx = new VersionedTransaction(messageV0);
      }
      // H-20 fix: sigVerify is intentionally set to false because simulation occurs
      // BEFORE the transaction is signed. At this point in the pipeline, the transaction
      // has only been built (buildTransaction) but not yet passed to the signer. Setting
      // sigVerify: true would cause simulation to fail with "signature verification failed"
      // for every transaction, since no valid signatures exist yet. The signing step happens
      // after simulation passes, in the wallet execution pipeline:
      //   buildTransaction -> simulateTransaction -> sign -> verifyIntegrity -> broadcast
      // The MED-10 check below (numRequiredSignatures > 1) mitigates the risk of
      // multi-signer transactions slipping through without proper authorization.
      const simulation = await this.connection.simulateTransaction(tx, {
        sigVerify: false,
        commitment: this.config.commitment ?? "confirmed",
      });

      if (simulation.value.err) {
        return {
          success: false,
          error: `Simulation failed: ${JSON.stringify(simulation.value.err)}`,
          logs: simulation.value.logs ?? undefined,
        };
      }

      // MED-10 fix: Reject transactions requiring multiple signers.
      // With sigVerify: false, simulation skips signature verification entirely.
      // If the transaction requires multiple signatures (e.g., multisig), a malicious
      // transaction could pass simulation but fail at broadcast, or worse, the wallet
      // could sign a transaction that requires additional signers it doesn't control.
      // Wallet-initiated transactions should only require a single signer (the wallet).
      const numSignatures = tx.message.header.numRequiredSignatures;
      if (numSignatures > 1) {
        return {
          success: false,
          error: `Transaction requires ${numSignatures} signatures but wallet expects single-signer transactions. ` +
            `Multi-signature transactions are not supported and may indicate a malicious transaction.`,
        };
      }

      // MED-10 fix: Correct fee estimation formula.
      // Solana base fee = 5000 lamports per signature (not per compute unit).
      // Priority fee = computeUnits * microLamportsPerCU (not available from simulation).
      // We estimate: base fee (1 signature) + approximate priority from compute usage.
      const baseFee = numSignatures * 5000; // 5000 lamports per signature
      const estimatedFee = (baseFee / 1e9) + (simulation.value.unitsConsumed
        ? simulation.value.unitsConsumed * 0.000000001 // conservative priority fee estimate
        : 0) || undefined;

      return {
        success: true,
        estimatedFee,
        logs: simulation.value.logs ?? undefined,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: `Simulation error: ${message}`,
      };
    }
  }

  /**
   * Broadcast a signed transaction to the Solana network.
   * Waits for confirmation before returning.
   *
   * MED-07 fix: Fetch blockhash BEFORE sending the transaction. Previously,
   * getLatestBlockhash() was called after sendRawTransaction(), which could
   * race — the transaction might confirm before polling starts, or the blockhash
   * could advance, causing confirmTransaction() to fail or timeout for a
   * transaction that actually succeeded.
   *
   * CHAIN-004 IMPORTANT -- Blockhash Staleness During Approval Delays:
   * The transaction's recentBlockhash is set during buildTransaction(), but broadcast
   * may occur minutes later (e.g., after human approval via Telegram). Solana blockhashes
   * expire after ~60-90 seconds (~150 slots). If the approval takes longer, the
   * transaction WILL fail with "blockhash not found".
   *
   * This is already mitigated by the refreshBlockhash() method on this adapter, which
   * callers should invoke before re-signing and broadcasting if there was any delay
   * between buildTransaction() and broadcast(). The AgentWallet execution pipeline
   * should configure approval timeouts shorter than 60 seconds, or implement a
   * rebuild-and-re-sign cycle when the blockhash approaches expiry.
   */
  async broadcast(signedTxData: Uint8Array): Promise<string> {
    try {
      // MED-07 fix: Get blockhash before sending to avoid confirmation race
      //
      // CRIT-09 limitation: Blockhash staleness risk.
      // The transaction's recentBlockhash was set during buildTransaction(), which may have
      // occurred minutes earlier (e.g., while waiting for human approval via Telegram).
      // Solana blockhashes expire after ~60-90 seconds (~150 slots). If the approval takes
      // longer, the transaction will fail with "blockhash not found" at broadcast time.
      // This is a known limitation of the Solana transaction model — blockhashes are baked
      // into the signed transaction and cannot be updated without re-signing.
      // Mitigation: Configure reasonable approval timeouts (< 60 seconds) in the policy
      // engine, or implement transaction rebuild-and-re-sign on blockhash expiry.
      const { blockhash, lastValidBlockHeight } =
        await this.connection.getLatestBlockhash();

      const txId = await this.connection.sendRawTransaction(signedTxData, {
        skipPreflight: false,
        preflightCommitment: this.config.commitment ?? "confirmed",
        maxRetries: 3,
      });

      // CHAIN-015 fix: Wrap confirmTransaction with a timeout to prevent indefinite blocking.
      // If the timeout fires, return the txId anyway since the transaction may still confirm
      // on-chain — the caller can poll getTransactionStatus() to check.
      const CONFIRM_TIMEOUT_MS = 30_000; // 30 seconds
      const confirmPromise = this.connection.confirmTransaction(
        { signature: txId, blockhash, lastValidBlockHeight },
        this.config.commitment ?? "confirmed",
      );
      // MED-T2-09 fix: Store the timeout timer ID so it can be cleared on success.
      // Previously, the setTimeout created a dangling timer that would persist even
      // after confirmTransaction resolved successfully. In long-running processes with
      // many transactions, these dangling timers accumulate and create resource leaks
      // (each holds a reference to the reject callback and error object in the closure).
      let confirmTimeoutId: ReturnType<typeof setTimeout>;
      const timeoutPromise = new Promise<never>((_, reject) => {
        confirmTimeoutId = setTimeout(
          () => reject(new SolanaAdapterError("BROADCAST_ERROR", "Transaction confirmation timed out after 30 seconds")),
          CONFIRM_TIMEOUT_MS,
        );
      });

      try {
        await Promise.race([confirmPromise, timeoutPromise]);
      } catch (err) {
        if (err instanceof SolanaAdapterError && err.message.includes("timed out")) {
          // Timeout is non-fatal: transaction was sent and may still confirm.
          // Return txId so the caller can poll status.
          process.emitWarning(
            `Transaction ${txId} confirmation timed out after 30s. The transaction was broadcast and may still confirm. Poll getTransactionStatus() to check.`,
            "KovaBroadcastWarning"
          );
          return txId;
        }
        throw err;
      } finally {
        // MED-T2-09 fix: Always clear the timeout timer to prevent resource leaks.
        // This runs whether confirmation succeeded, failed, or timed out.
        clearTimeout(confirmTimeoutId!);
      }

      return txId;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new SolanaAdapterError(
        "BROADCAST_FAILED",
        `Transaction broadcast failed: ${message}`,
      );
    }
  }

  /**
   * Get the status of a previously submitted transaction.
   *
   * MED-T2-10 fix: Validates the transaction ID format before sending to the RPC.
   * Solana transaction IDs are base58-encoded 64-byte Ed25519 signatures, which
   * encode to 86-88 characters in base58. Passing malformed IDs directly to the
   * RPC wastes network resources and could trigger unexpected RPC behavior.
   */
  async getTransactionStatus(txId: string): Promise<TransactionStatusResult> {
    // MED-T2-10 fix: Validate transaction ID format before RPC call.
    // Solana transaction signatures are 64 bytes, which in base58 encoding
    // produces strings of 86-88 characters. We validate both the length range
    // and the character set (base58 alphabet excludes 0, O, I, l).
    if (!txId || typeof txId !== "string") {
      throw new SolanaAdapterError(
        "INVALID_PARAMS",
        `Invalid transaction ID: expected a non-empty string, got ${typeof txId}.`,
      );
    }
    // Base58 character set: 123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz
    const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/;
    if (!BASE58_REGEX.test(txId)) {
      throw new SolanaAdapterError(
        "INVALID_PARAMS",
        `Invalid transaction ID format: "${txId.slice(0, 20)}${txId.length > 20 ? "..." : ""}". ` +
        `Solana transaction IDs must be base58-encoded 64-byte signatures (86-88 characters). ` +
        `Got ${txId.length} characters.`,
      );
    }

    try {
      const statuses = await this.connection.getSignatureStatuses([txId]);
      const status = statuses?.value?.[0];

      if (!status) {
        return { status: "not_found", txId };
      }

      if (status.err) {
        return {
          status: "failed",
          txId,
          error: JSON.stringify(status.err),
        };
      }

      const confirmationStatus = status.confirmationStatus;
      if (confirmationStatus === "finalized") {
        return { status: "finalized", txId };
      }
      if (
        confirmationStatus === "confirmed" ||
        confirmationStatus === "processed"
      ) {
        return { status: "confirmed", txId };
      }

      // M-28 fix: Do not return "confirmed" when the confirmation status is unknown
      // or unrecognized. The transaction may still confirm, but we should not tell
      // the caller it's confirmed when we don't actually know. Using "not_found" as
      // the closest available status to indicate the transaction's confirmation state
      // could not be determined. Callers should poll again to get the actual status.
      // Note: Ideally this would return "pending" but ChainTransactionStatus does not
      // include that value. A future API change should add "pending" to the union type.
      return { status: "not_found", txId };
    } catch (err) {
      throw new SolanaAdapterError(
        "STATUS_CHECK_FAILED",
        `Failed to check transaction status: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * CRIT-T2-02 fix: Capture a pre-swap balance snapshot for post-swap verification.
   * Call this BEFORE broadcasting a swap transaction to record the output token balance.
   * The returned snapshot is passed to verifySwapOutput() after broadcast confirmation.
   *
   * @param ownerAddress - The wallet's public key address
   * @param outputToken  - The token being received (e.g., "USDC", "SOL")
   * @returns A snapshot containing the pre-swap balance and metadata
   */
  async getPreSwapSnapshot(
    ownerAddress: string,
    outputToken: string,
  ): Promise<{ outputToken: string; preBalance: bigint; snapshotTimestamp: number }> {
    await this.ensureDnsValidated();
    const pubkey = new PublicKey(ownerAddress);

    let preBalance: bigint;
    if (isNativeSOL(outputToken)) {
      const lamports = await this.connection.getBalance(pubkey);
      preBalance = BigInt(lamports);
    } else {
      const mint = resolveTokenMint(outputToken, this.isDevnet);
      if (!mint) {
        throw new SolanaAdapterError("INVALID_TOKEN", `Unknown output token for swap verification: ${outputToken}`);
      }
      const ata = getAssociatedTokenAddressSync(mint, pubkey);
      try {
        const account = await getAccount(this.connection, ata);
        preBalance = account.amount;
      } catch {
        // ATA doesn't exist yet — pre-balance is zero
        preBalance = 0n;
      }
    }

    return {
      outputToken,
      preBalance,
      snapshotTimestamp: Date.now(),
    };
  }

  /**
   * CRIT-T2-02 fix: Verify that a swap produced the expected minimum output amount.
   *
   * After broadcasting and confirming a swap transaction, call this method to verify
   * that the output token balance increased by at least the expected minimum amount.
   * This detects:
   * - Sandwich attacks that consume full slippage tolerance
   * - Partial fills where output is less than otherAmountThreshold
   * - Zero-output swaps from edge-case AMM pool states
   * - Discrepancies between quoted and actual output for audit/reconciliation
   *
   * @param ownerAddress       - The wallet's public key address
   * @param preSwapSnapshot    - Snapshot from getPreSwapSnapshot() captured before broadcast
   * @param minimumExpectedOut - Minimum expected output in smallest units (from Jupiter quote's otherAmountThreshold)
   * @param quotedOutAmount    - The quoted output amount (from Jupiter quote's outAmount) for logging
   * @returns Verification result with actual received amount and pass/fail status
   */
  async verifySwapOutput(
    ownerAddress: string,
    preSwapSnapshot: { outputToken: string; preBalance: bigint; snapshotTimestamp: number },
    minimumExpectedOut: bigint,
    quotedOutAmount?: bigint,
  ): Promise<{
    passed: boolean;
    actualReceived: bigint;
    minimumExpected: bigint;
    quotedAmount?: bigint;
    deficit?: bigint;
    warning?: string;
  }> {
    await this.ensureDnsValidated();
    const pubkey = new PublicKey(ownerAddress);
    const { outputToken, preBalance, snapshotTimestamp } = preSwapSnapshot;

    // Guard against stale snapshots (> 5 minutes old)
    const SNAPSHOT_MAX_AGE_MS = 300_000;
    if (Date.now() - snapshotTimestamp > SNAPSHOT_MAX_AGE_MS) {
      throw new SolanaAdapterError(
        "SWAP_VERIFICATION_FAILED",
        `Pre-swap snapshot is too old (${Math.round((Date.now() - snapshotTimestamp) / 1000)}s). ` +
        `Maximum age is ${SNAPSHOT_MAX_AGE_MS / 1000}s. Take a new snapshot before the swap.`,
      );
    }

    let postBalance: bigint;
    if (isNativeSOL(outputToken)) {
      const lamports = await this.connection.getBalance(pubkey);
      postBalance = BigInt(lamports);
    } else {
      const mint = resolveTokenMint(outputToken, this.isDevnet);
      if (!mint) {
        throw new SolanaAdapterError("INVALID_TOKEN", `Unknown output token for swap verification: ${outputToken}`);
      }
      const ata = getAssociatedTokenAddressSync(mint, pubkey);
      try {
        const account = await getAccount(this.connection, ata);
        postBalance = account.amount;
      } catch {
        postBalance = 0n;
      }
    }

    const actualReceived = postBalance - preBalance;

    const result: {
      passed: boolean;
      actualReceived: bigint;
      minimumExpected: bigint;
      quotedAmount?: bigint;
      deficit?: bigint;
      warning?: string;
    } = {
      passed: actualReceived >= minimumExpectedOut,
      actualReceived,
      minimumExpected: minimumExpectedOut,
    };

    if (quotedOutAmount !== undefined) {
      result.quotedAmount = quotedOutAmount;
    }

    if (!result.passed) {
      result.deficit = minimumExpectedOut - actualReceived;
      result.warning =
        `CRIT-T2-02: Swap output verification FAILED. ` +
        `Received ${actualReceived} but expected at least ${minimumExpectedOut}` +
        (quotedOutAmount !== undefined ? ` (quoted: ${quotedOutAmount})` : "") +
        `. Deficit: ${result.deficit}. This may indicate a sandwich attack, partial fill, or malformed swap.`;
    } else if (quotedOutAmount !== undefined && actualReceived < quotedOutAmount) {
      // Passed minimum threshold but received less than quoted — warn about slippage consumption
      const slippageConsumed = quotedOutAmount - actualReceived;
      result.warning =
        `Swap output below quoted amount. Received ${actualReceived}, quoted ${quotedOutAmount}. ` +
        `Slippage consumed: ${slippageConsumed}. This may indicate MEV extraction.`;
    }

    return result;
  }

  /**
   * Validate a Solana address using PublicKey parsing.
   */
  isValidAddress(address: string): boolean {
    return isValidSolanaAddress(address);
  }

  /**
   * MED-T2-06 fix: Clean up resources held by this adapter instance.
   * Clears the module-level DNS cache entries that were created by this adapter's
   * configured URLs. Without this cleanup, DNS cache entries persist for the entire
   * process lifetime, which in long-running server processes could lead to:
   * - Stale DNS entries pointing to decommissioned IPs
   * - Memory accumulation from destroyed adapter instances
   * - Security risk if old DNS entries map to IPs that have been reassigned
   *
   * Call this method when the adapter is no longer needed (e.g., on shutdown,
   * when switching RPC endpoints, or when destroying a wallet instance).
   */
  destroy(): void {
    // T2-2.2 fix: Clear only this instance's DNS cache entries instead of the
    // entire module-level cache. Previously, destroying one adapter invalidated
    // DNS entries for ALL adapter instances, causing unnecessary re-resolution
    // and potential disruption in multi-tenant environments.
    for (const hostname of this.instanceHostnames) {
      dnsCache.delete(hostname);
    }
    this.instanceHostnames.clear();

    // NET-09 fix: Destroy the pinned agent's socket pool to close all keepalive
    // connections. Without this, idle connections persist indefinitely in long-running
    // processes, pinned to potentially stale IPs after DNS changes.
    if (this.pinnedAgent) {
      this.pinnedAgent.destroy();
      this.pinnedAgent = undefined;
    }

    // Reset the DNS validation timestamp so a new adapter won't skip validation
    this.dnsValidatedAt = 0;
  }
}
