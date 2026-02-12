/**
 * Signer interface — all signing backends implement this minimal interface.
 * The consuming code only knows that it can request an address and a signature.
 */

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

export interface Signer {
  /** Get the public key / address of this signer */
  getAddress(): Promise<string>;

  /** Sign a transaction */
  sign(transaction: UnsignedTransaction): Promise<SignedTransaction>;

  /** Verify that the signer is operational and can sign */
  healthCheck(): Promise<boolean>;
}
