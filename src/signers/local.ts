/**
 * LocalSigner — Holds a Solana Keypair in memory.
 *
 * WARNING: For development and testing only. The private key exists in process memory
 * and can be extracted via heap dumps. Use MPCSigner or EnclaveSigner for production.
 */

import { Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
import type { Signer, UnsignedTransaction, SignedTransaction } from "./interface.js";

const ED25519_SIGNATURE_LENGTH = 64;

export class LocalSigner implements Signer {
  private keypair: Keypair;
  private destroyed = false;

  constructor(keypair: Keypair) {
    this.keypair = keypair;
  }

  /**
   * MED-01 fix: Zero out the secret key from memory. After calling destroy(),
   * the signer can no longer sign transactions.
   */
  destroy(): void {
    if (!this.destroyed) {
      // Zero out the secret key bytes
      this.keypair.secretKey.fill(0);
      this.destroyed = true;
    }
  }

  /**
   * LOW-01 fix: Prevent accidental key leakage via JSON.stringify().
   * Returns only the public address, never the secret key.
   */
  toJSON(): { address: string } {
    return { address: this.keypair.publicKey.toBase58() };
  }

  /** Get the wallet's public address (base58-encoded Solana public key). */
  async getAddress(): Promise<string> {
    return this.keypair.publicKey.toBase58();
  }

  /** Sign a transaction using the local keypair. Supports both legacy and versioned Solana transactions. */
  async sign(transaction: UnsignedTransaction): Promise<SignedTransaction> {
    if (this.destroyed) {
      throw new Error("LocalSigner has been destroyed and can no longer sign transactions");
    }
    if (transaction.chain !== "solana") {
      throw new Error(`LocalSigner only supports Solana, got: ${transaction.chain}`);
    }

    let signedData: Uint8Array;
    let signature: Uint8Array;

    // Attempt versioned transaction deserialization first
    let isVersioned = false;
    try {
      VersionedTransaction.deserialize(transaction.data);
      isVersioned = true;
    } catch {
      // Not a versioned transaction — will try legacy below
    }

    if (isVersioned) {
      const versionedTx = VersionedTransaction.deserialize(transaction.data);
      versionedTx.sign([this.keypair]);
      signedData = versionedTx.serialize();
      const sig = versionedTx.signatures[0];
      if (!sig || sig.length !== ED25519_SIGNATURE_LENGTH) {
        throw new Error("Signing failed: versioned transaction produced no valid signature");
      }
      signature = sig;
    } else {
      const legacyTx = Transaction.from(transaction.data);
      legacyTx.sign(this.keypair);
      signedData = legacyTx.serialize();
      const sig = legacyTx.signature;
      if (!sig || sig.length !== ED25519_SIGNATURE_LENGTH) {
        throw new Error("Signing failed: legacy transaction produced no valid signature");
      }
      signature = sig;
    }

    return {
      chain: "solana",
      data: signedData,
      signature,
    };
  }

  /** Always returns true — local signer is always available. */
  async healthCheck(): Promise<boolean> {
    return true;
  }
}
