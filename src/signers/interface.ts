/**
 * Signer interface — all signing backends implement this minimal interface.
 * The consuming code only knows that it can request an address and a signature.
 */

export const nodeInspectSymbol: unique symbol = Symbol.for("nodejs.util.inspect.custom") as unknown as typeof nodeInspectSymbol;

export interface UnsignedTransaction {
  /** Chain identifier */
  chain: string;
  /** Chain-specific serialized transaction (before signing) */
  data: Uint8Array;
  /** Human-readable description for logging */
  description?: string;
}

export interface SignedTransaction {
  /** Chain identifier */
  chain: string;
  /** Chain-specific serialized transaction (after signing) */
  data: Uint8Array;
  /** The signature bytes */
  signature: Uint8Array;
}

/**
 * CRYPTO-013: SIGNING RATE LIMITS — The Signer interface does not enforce signing
 * rate limits. A compromised or runaway agent could request an unlimited number of
 * signatures per second, which for MPC providers may incur costs, exhaust quotas,
 * or trigger provider-side rate limits that degrade availability. Rate limiting is
 * instead enforced at the wallet layer (AgentWallet.execute serialization, policy
 * engine RateLimitRule, and the write rate limit floor in safeHandleToolCall). If
 * signer-level rate limiting is needed (e.g., to protect expensive MPC provider
 * quotas), implement it in the MpcSigningProvider or as a decorator around Signer.
 */
export interface Signer {
  /** Get the public key / address of this signer */
  getAddress(): Promise<string>;

  /** Sign a transaction */
  sign(transaction: UnsignedTransaction): Promise<SignedTransaction>;

  /** Verify that the signer is operational and can sign */
  healthCheck(): Promise<boolean>;

  /**
   * HIGH-01 fix: Clean up key material and sensitive state.
   * After calling destroy(), the signer must refuse to sign new transactions.
   * Implementations should zero key material to the extent the runtime allows.
   */
  destroy(): Promise<void>;

  /**
   * LOW-02 fix: Prevent accidental key leakage via JSON.stringify().
   * Implementations must return a safe representation (e.g., only the public address),
   * never exposing private key material.
   */
  toJSON(): Record<string, unknown>;

  [nodeInspectSymbol]?: () => string;
}
