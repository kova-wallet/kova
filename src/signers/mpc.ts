/**
 * MpcSigner — Provider-agnostic MPC signing for production use.
 *
 * Developers implement the MpcSigningProvider interface for their MPC backend
 * (Lit Protocol, Turnkey, Fireblocks, etc.) and pass it to MpcSigner.
 * MpcSigner handles chain validation, address caching, retries, and timeouts.
 */

import type { Signer, UnsignedTransaction, SignedTransaction } from "./interface.js";

// ── Provider interface ──────────────────────────────────────────────────────

/** Result of an MPC signing operation */
export interface MpcSignResult {
  /** The full signed transaction bytes (ready to broadcast) */
  signedData: Uint8Array;
  /** The raw signature bytes (e.g. 64 bytes for Ed25519) */
  signature: Uint8Array;
}

/**
 * Interface that MPC backend adapters must implement.
 *
 * Example:
 * ```typescript
 * class TurnkeyProvider implements MpcSigningProvider {
 *   readonly name = "turnkey";
 *   async getAddress() { return "So1ana..."; }
 *   async signTransaction(data) { /* call Turnkey API *\/ }
 *   async healthCheck() { return true; }
 * }
 * ```
 */
export interface MpcSigningProvider {
  /** Human-readable provider name (for logging/errors, e.g. "turnkey", "lit-protocol") */
  readonly name: string;

  /** Return the public address for the configured signing key */
  getAddress(): Promise<string>;

  /**
   * Sign raw transaction bytes using MPC.
   * Must return both the fully-assembled signed transaction and the raw signature.
   */
  signTransaction(transactionData: Uint8Array): Promise<MpcSignResult>;

  /** Check if the provider is reachable and the signing key is available */
  healthCheck(): Promise<boolean>;
}

// ── Configuration ───────────────────────────────────────────────────────────

export interface MpcSignerConfig {
  /** The MPC signing provider implementation */
  provider: MpcSigningProvider;
  /** Chain this signer operates on (e.g., "solana") — validated against incoming transactions */
  chain: string;
  /** Max retries for transient provider failures (default: 2) */
  maxRetries?: number;
  /** Timeout in ms for individual provider calls (default: 30000) */
  timeoutMs?: number;
}

// ── Error types ─────────────────────────────────────────────────────────────

export type MpcSignerErrorCode = "PROVIDER_ERROR" | "TIMEOUT" | "CHAIN_MISMATCH";

export class MpcSignerError extends Error {
  readonly code: MpcSignerErrorCode;
  readonly provider: string;

  constructor(code: MpcSignerErrorCode, provider: string, message: string) {
    super(message);
    this.name = "MpcSignerError";
    this.code = code;
    this.provider = provider;
  }
}

// ── Signer implementation ───────────────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 30_000;

export class MpcSigner implements Signer {
  private readonly provider: MpcSigningProvider;
  private readonly chain: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private cachedAddress: string | null = null;

  constructor(config: MpcSignerConfig) {
    this.provider = config.provider;
    this.chain = config.chain;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Get the public address from the MPC provider.
   * Result is cached after the first successful call (address doesn't change).
   */
  async getAddress(): Promise<string> {
    if (this.cachedAddress) return this.cachedAddress;

    const address = await this.withRetry(() =>
      this.withTimeout(this.provider.getAddress()),
    );
    this.cachedAddress = address;
    return address;
  }

  /**
   * Sign a transaction via the MPC provider.
   * Validates the chain matches, then delegates to the provider with retry + timeout.
   */
  async sign(transaction: UnsignedTransaction): Promise<SignedTransaction> {
    if (transaction.chain !== this.chain) {
      throw new MpcSignerError(
        "CHAIN_MISMATCH",
        this.provider.name,
        `MpcSigner is configured for "${this.chain}" but received transaction for "${transaction.chain}"`,
      );
    }

    const result = await this.withRetry(() =>
      this.withTimeout(this.provider.signTransaction(transaction.data)),
    );

    return {
      chain: this.chain,
      data: result.signedData,
      signature: result.signature,
    };
  }

  /**
   * Delegate health check to the provider.
   * No retry — this is a probe, and retrying masks failures.
   */
  async healthCheck(): Promise<boolean> {
    try {
      return await this.withTimeout(this.provider.healthCheck());
    } catch {
      return false;
    }
  }

  // ── Internal helpers ────────────────────────────────────────────────────

  /** Retry a provider call on transient failure */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        // Don't retry chain mismatch or other non-transient errors
        if (err instanceof MpcSignerError) throw err;
        // Last attempt — don't retry
        if (attempt === this.maxRetries) break;
      }
    }
    throw new MpcSignerError(
      "PROVIDER_ERROR",
      this.provider.name,
      `MPC provider "${this.provider.name}" failed after ${this.maxRetries + 1} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  /** Wrap a promise with a timeout */
  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new MpcSignerError(
            "TIMEOUT",
            this.provider.name,
            `MPC provider "${this.provider.name}" timed out after ${this.timeoutMs}ms`,
          ),
        );
      }, this.timeoutMs);

      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }
}
