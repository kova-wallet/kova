/**
 * LocalSigner — Holds a Solana Keypair in memory.
 *
 * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 * CRIT-T1-01 / CRIT-T1-02: DEVELOPMENT AND TESTING ONLY — DO NOT USE IN PRODUCTION
 * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 *
 * This signer holds private key material in plaintext V8 heap memory. Two fundamental
 * limitations make it unsuitable for production use:
 *
 * 1. V8 GC defeats key zeroization (CRIT-T1-01):
 *    destroy() zeroes the primary TypedArray buffer, but V8's garbage collector may
 *    have created copies of the key material during:
 *    - Keypair construction (fromSecretKey clones internally)
 *    - TypedArray operations (slice, subarray create views or copies)
 *    - JIT compilation (optimized code may cache values in registers/stack)
 *    - GC compaction (live objects may be copied to new heap pages)
 *    These copies persist in freed heap pages until overwritten by new allocations.
 *    There is NO way to guarantee key erasure in V8 without native addons (sodium-native
 *    with mlock/mprotect, or a custom N-API module using secure_memzero).
 *
 * 2. Private key plaintext in memory (CRIT-T1-02):
 *    The key exists unencrypted in process memory with no envelope encryption,
 *    no OS keychain integration, and no hardware-backed storage. Any process with
 *    read access to the Node.js process memory (debugger attach, /proc/[pid]/mem,
 *    core dumps, heap snapshots) can extract the full Ed25519 private key.
 *
 * MANDATORY FOR PRODUCTION: Use MpcSigner with a hardware-backed signing provider
 * (Turnkey, Fireblocks, Lit Protocol) that never exposes raw key material to the
 * application process. The CRIT-T1-04 runtime guard enforces this by throwing an
 * error when LocalSigner is instantiated outside of test environments.
 */

import { Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
import { createPublicKey, verify as cryptoVerify } from "crypto";
import type { Signer, UnsignedTransaction, SignedTransaction } from "./interface.js";

const ED25519_SIGNATURE_LENGTH = 64;

/**
 * HIGH-T1-04 fix: Ed25519 SubjectPublicKeyInfo DER prefix.
 * Structure: SEQUENCE (0x30, 0x2a = 42 bytes total)
 *   AlgorithmIdentifier: SEQUENCE (0x30, 0x05)
 *     OID 1.3.101.112 (Ed25519): 0x06, 0x03, 0x2b, 0x65, 0x70
 *   BIT STRING header: 0x03, 0x21, 0x00 (33 bytes, 0 unused bits)
 * Followed by 32-byte raw Ed25519 public key.
 */
const ED25519_DER_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * CRYPTO-012: KEY-AT-REST LIMITATION — The private key is held in plaintext
 * in process memory with no encryption at rest. There is no passphrase-based
 * envelope, no OS keychain integration, and no hardware-backed storage.
 * For production deployments, use MpcSigner with a hardware-backed signing
 * provider (e.g., Turnkey, Fireblocks) or an external key management service
 * (e.g., AWS KMS, HashiCorp Vault) that never exposes raw key material to
 * the application process.
 */
/** CRIT-T1-04 fix: Configuration for LocalSigner production opt-in */
export interface LocalSignerConfig {
  /**
   * When true, allows LocalSigner to be used outside of test environments.
   * This is dangerous: the private key is held in plaintext in process memory
   * and can be extracted via heap dumps, core files, or debugger access.
   * Only set this if you fully understand the risks.
   * For production deployments, use MpcSigner with a hardware-backed provider.
   */
  dangerouslyAllowInProduction?: boolean;
}

export class LocalSigner implements Signer {
  /** HIGH-01 fix: Nullable so we can fully release the reference on destroy(). */
  private keypair: Keypair | null;
  private destroyed = false;

  constructor(keypair: Keypair, config?: LocalSignerConfig) {
    // CRIT-T1-04 fix: Block LocalSigner in production unless explicitly opted in.
    // Mirrors the MemoryStore pattern. LocalSigner holds private keys in plaintext
    // process memory which is unsafe for production use with real funds.
    if (typeof process !== "undefined" && process.env.NODE_ENV !== "test") {
      if (!config?.dangerouslyAllowInProduction) {
        throw new Error(
          "LocalSigner is not safe for production use (private key in plaintext memory). " +
          "Use MpcSigner with a hardware-backed provider instead, or pass " +
          "{ dangerouslyAllowInProduction: true } to override.",
        );
      }
      process.emitWarning(
        "LocalSigner is being used outside of test environment with dangerouslyAllowInProduction flag. " +
        "Private key material is held in plaintext process memory. Use MpcSigner for production.",
        "SecurityWarning",
      );
    }
    // MED-04 fix: Validate the keypair is structurally valid before accepting it.
    // A zero or short secret key would pass Keypair construction but fail at signing
    // time with a confusing error, or produce invalid signatures.
    // CRYPTO-015 fix: Do not disclose actual key length or expected length in error
    // messages to prevent information leakage about the key material structure.
    if (!keypair.secretKey || keypair.secretKey.length !== 64) {
      throw new Error(
        "LocalSigner: invalid secret key",
      );
    }
    // Check for all-zero secret key (indicates uninitialized or wiped key material)
    if (keypair.secretKey.every((b) => b === 0)) {
      throw new Error("LocalSigner: key material has been securely disposed or is invalid");
    }
    // HIGH-01 fix: Clone the keypair so external callers cannot mutate our copy.
    // We copy the secret key into a new buffer and construct a fresh Keypair from it.
    //
    // H-10: SECURITY LIMITATION — Keypair.fromSecretKey() creates internal copies of the
    // secret key within the Keypair object that cannot be zeroed by our destroy() method.
    // While we zero the intermediate `clonedSecret` buffer below, the Keypair's own internal
    // copy persists until garbage collected. This is an inherent limitation of the
    // @solana/web3.js Keypair implementation. For production use, prefer MpcSigner with a
    // hardware-backed signing provider (e.g., Turnkey, Fireblocks) that never exposes raw
    // key material to the application process.
    const clonedSecret = new Uint8Array(keypair.secretKey);
    this.keypair = Keypair.fromSecretKey(clonedSecret);

    // CRYPTO-010 fix: Verify that the reconstructed keypair has the same public key.
    // Detects corruption in the clone/reconstruction process.
    if (this.keypair.publicKey.toBase58() !== keypair.publicKey.toBase58()) {
      this.keypair = null as any;
      this.destroyed = true;
      throw new Error("LocalSigner: reconstructed keypair has different public key (possible corruption)");
    }

    // CRYPTO-004 fix: Zero the intermediate buffer after keypair reconstruction
    // to minimize the window where key material exists in an extra copy.
    clonedSecret.fill(0);
  }

  /**
   * Zero out the secret key from memory. After calling destroy(),
   * the signer can no longer sign transactions.
   *
   * MED-05: This zeroes the primary TypedArray buffer but cannot guarantee
   * that V8 hasn't created copies during Keypair construction or internal
   * optimizations. See class-level documentation for full security limitations.
   */
  async destroy(): Promise<void> {
    if (!this.destroyed) {
      // Zero out the secret key bytes
      if (this.keypair) {
        this.keypair.secretKey.fill(0);
      }
      // HIGH-01 fix: Null out the keypair reference so no one can access the object.
      this.keypair = null;
      this.destroyed = true;
    }
  }

  /**
   * LOW-01 fix: Prevent accidental key leakage via JSON.stringify().
   * Returns only the public address, never the secret key.
   */
  toJSON(): Record<string, unknown> {
    if (this.destroyed || !this.keypair) {
      return { address: null, destroyed: true };
    }
    return { address: this.keypair.publicKey.toBase58() };
  }

  /**
   * MED-05 fix: Prevent key leakage via util.inspect() and console.log().
   * Without this, Node.js default inspection would display all object properties
   * including the keypair's secret key bytes.
   */
  [Symbol.for("nodejs.util.inspect.custom")](): { address: string | null; destroyed: boolean } {
    return {
      address: this.keypair ? this.keypair.publicKey.toBase58() : null,
      destroyed: this.destroyed,
    };
  }

  /** Get the wallet's public address (base58-encoded Solana public key). */
  async getAddress(): Promise<string> {
    // LOW-01 fix: Destroyed signers must not expose any address.
    if (this.destroyed || !this.keypair) {
      throw new Error("LocalSigner has been destroyed");
    }
    return this.keypair.publicKey.toBase58();
  }

  /** Sign a transaction using the local keypair. Supports both legacy and versioned Solana transactions. */
  async sign(transaction: UnsignedTransaction): Promise<SignedTransaction> {
    if (this.destroyed || !this.keypair) {
      throw new Error("LocalSigner has been destroyed and can no longer sign transactions");
    }
    if (transaction.chain !== "solana") {
      throw new Error(`LocalSigner only supports Solana, got: ${transaction.chain}`);
    }

    // CRIT-02 fix: Defensive copy of transaction.data to prevent TOCTOU attacks.
    // The caller could mutate the original Uint8Array between deserialization and signing.
    const txData = new Uint8Array(transaction.data);

    let signedData: Uint8Array;
    let signature: Uint8Array;
    let messageBytes: Uint8Array;

    // CRIT-02 fix: Single deserialization — reuse the result of the first try/catch.
    let versionedTx: VersionedTransaction | null = null;
    try {
      versionedTx = VersionedTransaction.deserialize(txData);
    } catch {
      // Not a versioned transaction — will try legacy below
    }

    if (versionedTx) {
      versionedTx.sign([this.keypair]);
      signedData = versionedTx.serialize();
      const sig = versionedTx.signatures[0];
      if (!sig || sig.length !== ED25519_SIGNATURE_LENGTH) {
        throw new Error("Signing failed: versioned transaction produced no valid signature");
      }
      signature = sig;
      // CRIT-01 fix: Extract the message bytes that were actually signed.
      messageBytes = versionedTx.message.serialize();
    } else {
      const legacyTx = Transaction.from(txData);
      legacyTx.sign(this.keypair);
      signedData = legacyTx.serialize();
      const sig = legacyTx.signature;
      if (!sig || sig.length !== ED25519_SIGNATURE_LENGTH) {
        throw new Error("Signing failed: legacy transaction produced no valid signature");
      }
      signature = sig;
      // CRIT-01 fix: Extract the message bytes that were actually signed.
      messageBytes = legacyTx.serializeMessage();
    }

    // CRIT-01 fix: Post-sign signature verification.
    // Verify the produced signature against the public key and message bytes
    // to catch signing faults, corrupted keys, or tampered transactions.
    const pubKeyBytes = this.keypair.publicKey.toBytes();
    const verified = await verifyEd25519Signature(signature, messageBytes, pubKeyBytes);
    if (!verified) {
      throw new Error(
        "Post-sign verification failed: the produced signature does not verify against the public key. " +
        "This indicates a signing fault or corrupted key material.",
      );
    }

    return {
      chain: "solana",
      data: signedData,
      signature,
    };
  }

  /** HIGH-02 fix: Returns false after destroy() to prevent use of a destroyed signer.
   *  LOW-T1-01 fix: Performs a cryptographic self-test to detect corrupted keypairs,
   *  not just destroyed state. */
  async healthCheck(): Promise<boolean> {
    if (this.destroyed || !this.keypair) return false;
    // LOW-T1-01 fix: Cryptographic self-test — validate the public key and, when the
    // private key seed is available, perform a full sign+verify round-trip.
    try {
      const pubKeyBytes = this.keypair.publicKey.toBytes();
      const { ed25519 } = await import("@noble/curves/ed25519");

      // Step 1: Verify the stored public key is a valid point on the Ed25519 curve.
      // Throws if the bytes do not represent a valid curve point (detects corruption).
      ed25519.Point.fromHex(pubKeyBytes);

      // Step 2: If the private key seed is available (not zeroed by CRYPTO-004 fix),
      // perform a full sign+verify round-trip to detect key corruption or mismatch.
      const seed = this.keypair.secretKey.slice(0, 32);
      const seedAvailable = !seed.every((b: number) => b === 0);
      if (seedAvailable) {
        const testMessage = new Uint8Array(Buffer.from("kova:healthcheck:selftest"));
        const signature = ed25519.sign(testMessage, seed);
        if (!ed25519.verify(signature, testMessage, pubKeyBytes)) {
          return false;
        }
      }

      // Step 3: Verify the public key can be imported as a Node.js crypto KeyObject
      // (validates the DER/SPKI encoding is well-formed for downstream use).
      createPublicKey({
        key: Buffer.concat([ED25519_DER_SPKI_PREFIX, Buffer.from(pubKeyBytes)]),
        format: "der",
        type: "spki",
      });

      return true;
    } catch {
      // LOW-T1-01 fix: Any error during self-test means the keypair is unusable
      return false;
    }
  }

  /**
   * MED-T1-01 fix: Create a new LocalSigner with a different keypair, effectively
   * rotating the key. The old signer is destroyed as part of the rotation.
   * Returns a new LocalSigner instance with the new key.
   *
   * This is the recommended way to rotate keys for LocalSigner. The caller
   * must update any references to the signer and any derived state (e.g.,
   * PrefixedStore prefix, allowlist entries) after rotation.
   *
   * @param newKeypair - The new keypair to rotate to
   * @param config - Optional configuration (same as constructor)
   * @returns A new LocalSigner instance with the new keypair
   */
  async rotateKey(newKeypair: Keypair, config?: LocalSignerConfig): Promise<LocalSigner> {
    const newSigner = new LocalSigner(newKeypair, config);
    await this.destroy();
    return newSigner;
  }
}

/**
 * CRIT-01 helper: Verify an Ed25519 signature using Node.js built-in crypto.
 * Uses the 'ed25519' named curve available in Node.js >= 18.
 */
function verifyEd25519Signature(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    try {
      // Node.js crypto.verify with Ed25519 expects a raw 32-byte public key
      // wrapped in a KeyObject. We import the raw key as 'ed25519' type.
      const keyObject = createPublicKey({
        key: Buffer.concat([
          // HIGH-T1-04 fix: Use named constant for the DER SPKI prefix
          ED25519_DER_SPKI_PREFIX,
          Buffer.from(publicKey),
        ]),
        format: "der",
        type: "spki",
      });
      const result = cryptoVerify(
        null, // Ed25519 doesn't use a separate hash algorithm
        Buffer.from(message),
        keyObject,
        Buffer.from(signature),
      );
      resolve(result);
    // CRYPTO-009 fix: Differentiate infrastructure errors (key import failures,
    // algorithm unavailability) from actual verification failures (returning false).
    } catch (err) {
      reject(new Error(`Ed25519 verification infrastructure error: ${err instanceof Error ? err.message : String(err)}`));
    }
  });
}
