/**
 * MpcSigner — Provider-agnostic MPC signing for production use.
 *
 * Developers implement the MpcSigningProvider interface for their MPC backend
 * (Lit Protocol, Turnkey, Fireblocks, etc.) and pass it to MpcSigner.
 * MpcSigner handles chain validation, address caching, retries, and timeouts.
 */

import { VersionedTransaction, PublicKey } from "@solana/web3.js";
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
 * **Security: TLS Required for Production Use**
 * All MPC provider implementations MUST communicate with their backend over TLS (HTTPS).
 * MPC signing involves sending transaction data to a remote service; using plaintext HTTP
 * exposes transaction contents, API credentials, and signed results to network attackers.
 * Implementations that accept a URL or endpoint configuration should validate that the
 * URL scheme is "https://" and reject or warn on non-HTTPS URLs.
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
   * NET-11 fix: Accepts an optional AbortSignal for cooperative cancellation on timeout.
   * Providers should check signal.aborted and abort in-flight HTTP requests when signalled.
   */
  signTransaction(transactionData: Uint8Array, signal?: AbortSignal): Promise<MpcSignResult>;

  /** Check if the provider is reachable and the signing key is available */
  healthCheck(): Promise<boolean>;

  /**
   * LOW-03 fix: Optional cleanup method for provider resources.
   * Called by MpcSigner.destroy() to allow the provider to release connections,
   * clear caches, or perform other cleanup. Providers should be idempotent
   * (calling destroy multiple times should be safe).
   */
  destroy?(): Promise<void>;
}

// ── Configuration ───────────────────────────────────────────────────────────

export interface MpcSignerConfig {
  /** The MPC signing provider implementation */
  provider: MpcSigningProvider;
  /** Chain this signer operates on (e.g., "solana") — validated against incoming transactions */
  chain: string;
  /** Max retries for transient provider failures (default: 2) */
  maxRetries?: number;
  /** Timeout in ms for individual provider calls (default: 30000, max: 120000) */
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

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      provider: "[REDACTED]",
    };
  }
}

// ── Signer implementation ───────────────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 2;
/** MED-03 fix: Prevent effectively-infinite retries from misconfiguration */
const MAX_RETRIES_UPPER_BOUND = 10;
const DEFAULT_TIMEOUT_MS = 30_000;
/** MED-09 fix: Cap timeout to prevent effectively-infinite waits (e.g., Infinity, Number.MAX_SAFE_INTEGER) */
const MAX_TIMEOUT_MS = 120_000;
/** MED-02 fix: Address cache TTL — revalidate after 10 minutes to detect key rotation */
const ADDRESS_CACHE_TTL_MS = 600_000;
/** L-17 fix: Maximum total duration for all retry attempts combined (prevents unbounded retry chains) */
const MAX_TOTAL_RETRY_DURATION_MS = 60_000;

// ── CRIT-T1-03 fix: Minimal RLP decoder for EVM transaction verification ────

/**
 * CRIT-T1-03 fix: Decoded EVM transaction fields for integrity verification.
 * Only the security-critical fields are extracted; chain-specific fields
 * (chainId, accessList) are not compared.
 */
interface RlpTransactionFields {
  nonce: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  gasLimit: string;
  to: string;
  value: string;
  data: string;
}

/**
 * CRIT-T1-03 fix: Minimal RLP decoder — decodes a single RLP item from a buffer.
 * Returns the decoded bytes and the number of bytes consumed.
 * Supports both short (<56 bytes) and long (>=56 bytes) strings/lists.
 */
function rlpDecodeItem(buf: Uint8Array, offset: number): { data: Uint8Array; consumed: number; isList: boolean } {
  if (offset >= buf.length) {
    throw new Error(`RLP decode error: buffer overflow at offset ${offset}`);
  }
  const prefix = buf[offset]!;

  if (prefix <= 0x7f) {
    // Single byte
    return { data: buf.slice(offset, offset + 1), consumed: 1, isList: false };
  }
  if (prefix <= 0xb7) {
    // Short string (0-55 bytes)
    const len = prefix - 0x80;
    if (offset + 1 + len > buf.length) {
      throw new Error(`RLP decode error: buffer overflow at offset ${offset}`);
    }
    return { data: buf.slice(offset + 1, offset + 1 + len), consumed: 1 + len, isList: false };
  }
  if (prefix <= 0xbf) {
    // Long string (>55 bytes)
    const lenOfLen = prefix - 0xb7;
    if (offset + 1 + lenOfLen > buf.length) {
      throw new Error(`RLP decode error: buffer overflow at offset ${offset}`);
    }
    let len = 0;
    for (let i = 0; i < lenOfLen; i++) {
      len = len * 256 + buf[offset + 1 + i]!;
    }
    if (offset + 1 + lenOfLen + len > buf.length) {
      throw new Error(`RLP decode error: buffer overflow at offset ${offset}`);
    }
    return { data: buf.slice(offset + 1 + lenOfLen, offset + 1 + lenOfLen + len), consumed: 1 + lenOfLen + len, isList: false };
  }
  if (prefix <= 0xf7) {
    // Short list (0-55 bytes total payload)
    const len = prefix - 0xc0;
    if (offset + 1 + len > buf.length) {
      throw new Error(`RLP decode error: buffer overflow at offset ${offset}`);
    }
    return { data: buf.slice(offset + 1, offset + 1 + len), consumed: 1 + len, isList: true };
  }
  // Long list (>55 bytes total payload)
  const lenOfLen = prefix - 0xf7;
  if (offset + 1 + lenOfLen > buf.length) {
    throw new Error(`RLP decode error: buffer overflow at offset ${offset}`);
  }
  let len = 0;
  for (let i = 0; i < lenOfLen; i++) {
    len = len * 256 + buf[offset + 1 + i]!;
  }
  if (offset + 1 + lenOfLen + len > buf.length) {
    throw new Error(`RLP decode error: buffer overflow at offset ${offset}`);
  }
  return { data: buf.slice(offset + 1 + lenOfLen, offset + 1 + lenOfLen + len), consumed: 1 + lenOfLen + len, isList: true };
}

/**
 * CRIT-T1-03 fix: Decode all items within an RLP list payload.
 */
function rlpDecodeList(payload: Uint8Array): Uint8Array[] {
  const items: Uint8Array[] = [];
  let offset = 0;
  while (offset < payload.length) {
    const { data, consumed } = rlpDecodeItem(payload, offset);
    items.push(data);
    offset += consumed;
  }
  return items;
}

/**
 * CRIT-T1-03 fix: Convert RLP-decoded bytes to a hex string for comparison.
 */
function bytesToHex(bytes: Uint8Array): string {
  return "0x" + Buffer.from(bytes).toString("hex");
}

/**
 * CRIT-T1-03 fix: Decode an RLP-encoded EVM transaction into its fields.
 * Supports legacy (type 0), EIP-2930 (type 1), and EIP-1559 (type 2) transactions.
 * For signed transactions, the signature fields (v, r, s) are ignored —
 * only the critical transaction body fields are extracted for comparison.
 */
function decodeRlpTransaction(raw: Uint8Array): RlpTransactionFields {
  let txType = 0;
  let payload = raw;

  // EIP-2718 typed transactions start with a byte < 0x80
  if (raw[0]! < 0x80) {
    txType = raw[0]!;
    payload = raw.slice(1);
  }

  const outer = rlpDecodeItem(payload, 0);
  if (!outer.isList) {
    throw new Error("RLP transaction is not a list");
  }
  const items = rlpDecodeList(outer.data);

  if (txType === 0) {
    // Legacy: [nonce, gasPrice, gasLimit, to, value, data, v, r, s]
    // Unsigned legacy: [nonce, gasPrice, gasLimit, to, value, data] (6 items)
    // Signed legacy: 9 items
    if (items.length < 6) {
      throw new Error(`Legacy transaction has ${items.length} fields, expected >= 6`);
    }
    return {
      nonce: bytesToHex(items[0]!),
      gasPrice: bytesToHex(items[1]!),
      gasLimit: bytesToHex(items[2]!),
      to: bytesToHex(items[3]!),
      value: bytesToHex(items[4]!),
      data: bytesToHex(items[5]!),
    };
  }
  if (txType === 1) {
    // EIP-2930: [chainId, nonce, gasPrice, gasLimit, to, value, data, accessList, ...]
    if (items.length < 7) {
      throw new Error(`EIP-2930 transaction has ${items.length} fields, expected >= 7`);
    }
    return {
      nonce: bytesToHex(items[1]!),
      gasPrice: bytesToHex(items[2]!),
      gasLimit: bytesToHex(items[3]!),
      to: bytesToHex(items[4]!),
      value: bytesToHex(items[5]!),
      data: bytesToHex(items[6]!),
    };
  }
  if (txType === 2) {
    // EIP-1559: [chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, accessList, ...]
    if (items.length < 8) {
      throw new Error(`EIP-1559 transaction has ${items.length} fields, expected >= 8`);
    }
    return {
      nonce: bytesToHex(items[1]!),
      maxFeePerGas: bytesToHex(items[3]!),
      gasLimit: bytesToHex(items[4]!),
      to: bytesToHex(items[5]!),
      value: bytesToHex(items[6]!),
      data: bytesToHex(items[7]!),
    };
  }

  throw new Error(`Unsupported EVM transaction type: ${txType}`);
}

/** HIGH-03 fix: Expected signature lengths per chain algorithm */
// AUDIT-H15 fix: Freeze to prevent runtime mutation that could bypass signature length validation.
const EXPECTED_SIGNATURE_LENGTHS: Readonly<Record<string, number>> = Object.freeze({
  solana: 64,    // Ed25519
  ethereum: 65,  // ECDSA secp256k1 (r + s + v)
  base: 65,      // ECDSA secp256k1 (r + s + v)
});

export class MpcSigner implements Signer {
  private readonly provider: MpcSigningProvider;
  private readonly chain: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private cachedAddress: string | null = null;
  /** MED-02 fix: Timestamp of last address cache refresh */
  private addressCachedAt = 0;
  private destroyed = false;

  constructor(config: MpcSignerConfig) {
    this.provider = config.provider;
    this.chain = config.chain;
    // MED-03 fix: Clamp maxRetries to [0, MAX_RETRIES_UPPER_BOUND] to prevent infinite retry loops
    const rawRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.maxRetries = Math.max(0, Math.min(rawRetries, MAX_RETRIES_UPPER_BOUND));
    // MED-09 fix: Clamp timeout to [1, MAX_TIMEOUT_MS] to prevent unbounded waits
    const rawTimeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.timeoutMs = Math.max(1, Math.min(rawTimeout, MAX_TIMEOUT_MS));
  }

  // LOW-T1-03 fix: All error messages thrown by MpcSigner redact the provider name
  // (this.provider.name) to prevent leaking internal infrastructure details to callers.
  // The provider name is still stored in MpcSignerError.provider for internal logging.

  /**
   * Get the public address from the MPC provider.
   * MED-02 fix: Cached with TTL — revalidates after ADDRESS_CACHE_TTL_MS
   * to detect key rotations from the MPC provider.
   */
  async getAddress(): Promise<string> {
    const now = Date.now();
    if (this.cachedAddress && (now - this.addressCachedAt) < ADDRESS_CACHE_TTL_MS) {
      return this.cachedAddress;
    }

    const address = await this.withRetry(() =>
      this.withTimeout(this.provider.getAddress()),
    );

    // HIGH-02 fix: Validate address format from the provider.
    // The provider could return garbage, empty strings, or excessively long values.
    if (typeof address !== "string" || address.length === 0 || address.length > 64) {
      throw new MpcSignerError(
        "PROVIDER_ERROR",
        this.provider.name,
        `MPC provider returned invalid address: ` +
        `expected non-empty string with 1-64 chars, got ${typeof address === "string" ? `"${address}" (${address.length} chars)` : typeof address}`,
      );
    }

    // HIGH-02 fix: For Solana chain, validate the address is a valid base58-encoded public key.
    if (this.chain === "solana") {
      try {
        new PublicKey(address);
      } catch {
        throw new MpcSignerError(
          "PROVIDER_ERROR",
          this.provider.name,
          `MPC provider returned invalid Solana address: "${address}" is not a valid base58-encoded public key`,
        );
      }
    // CRYPTO-011 fix: Validate Ethereum/Base address format (0x-prefixed 40-char hex).
    } else if (this.chain === "ethereum" || this.chain === "base") {
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
        throw new MpcSignerError(
          "PROVIDER_ERROR",
          this.provider.name,
          `Invalid ${this.chain} address format: expected 0x-prefixed 40-character hex string`,
        );
      }
    }

    this.cachedAddress = address;
    this.addressCachedAt = now;
    return address;
  }

  /**
   * MED-02 fix: Clear the cached address, forcing the next getAddress() call
   * to query the MPC provider. Use after key rotation events.
   */
  clearAddressCache(): void {
    this.cachedAddress = null;
    this.addressCachedAt = 0;
  }

  /**
   * LOW-02 fix: Prevent accidental key leakage via JSON.stringify().
   * MPC signers don't hold key material, but we still provide a safe representation.
   * CRYPTO-014 fix: Exclude cachedAddress from serialization to avoid leaking
   * the wallet address through JSON.stringify() or logging pipelines.
   */
  toJSON(): Record<string, unknown> {
    return {
      provider: this.provider.name,
      chain: this.chain,
      destroyed: this.destroyed,
    };
  }

  /**
   * Sign a transaction via the MPC provider.
   * Validates the chain matches, then delegates to the provider with retry + timeout.
   */
  async sign(transaction: UnsignedTransaction): Promise<SignedTransaction> {
    // CRYPTO-005 fix: Check destroyed state FIRST, before chain validation,
    // so that error messages don't leak chain configuration to callers.
    if (this.destroyed) {
      throw new MpcSignerError(
        "PROVIDER_ERROR",
        this.provider.name,
        "MpcSigner has been destroyed and can no longer sign transactions",
      );
    }

    // LOW-T1-02 fix: This chain comparison uses standard string equality (===), not
    // constant-time comparison. This is intentional and not security-sensitive: the chain
    // value (e.g., "solana", "ethereum") is a non-secret configuration identifier visible
    // in logs, error messages, and API responses. No secret material is compared here,
    // so timing side-channel resistance is unnecessary.
    if (transaction.chain !== this.chain) {
      throw new MpcSignerError(
        "CHAIN_MISMATCH",
        this.provider.name,
        `MpcSigner is configured for "${this.chain}" but received transaction for "${transaction.chain}"`,
      );
    }

    // CRYPTO-001 fix: Defensive copy of transaction data before passing to provider
    // to prevent the provider from mutating the original buffer (TOCTOU prevention).
    const dataCopy = new Uint8Array(transaction.data);
    // NET-11 fix: Each retry attempt gets a fresh AbortController so the provider
    // can be signalled to cancel in-flight HTTP requests on timeout.
    const result = await this.withRetry(() => {
      const ctrl = new AbortController();
      return this.withTimeout(this.provider.signTransaction(dataCopy, ctrl.signal), ctrl);
    });

    // HIGH-T1-05 fix: Re-check destroyed state after the async signing call.
    // Between the initial check and the provider response, another caller may
    // have called destroy(), invalidating the signer. Using a destroyed signer's
    // results could lead to returning stale or inconsistent signed data.
    if (this.destroyed) {
      throw new MpcSignerError(
        "PROVIDER_ERROR",
        this.provider.name,
        "MpcSigner was destroyed during signing operation — result discarded",
      );
    }

    // HIGH-03 fix: Validate provider output before trusting it
    if (!(result.signedData instanceof Uint8Array) || result.signedData.length === 0) {
      throw new MpcSignerError(
        "PROVIDER_ERROR",
        this.provider.name,
        `MPC provider returned empty or invalid signedData`,
      );
    }
    if (!(result.signature instanceof Uint8Array) || result.signature.length === 0) {
      throw new MpcSignerError(
        "PROVIDER_ERROR",
        this.provider.name,
        `MPC provider returned empty or invalid signature`,
      );
    }

    // HIGH-03 fix: Validate signature length — fail-closed.
    // If the chain is not in EXPECTED_SIGNATURE_LENGTHS, we reject rather than
    // silently skipping validation (fail-closed principle).
    const expectedLen = EXPECTED_SIGNATURE_LENGTHS[this.chain];
    if (expectedLen === undefined) {
      throw new MpcSignerError(
        "PROVIDER_ERROR",
        this.provider.name,
        `No expected signature length configured for chain "${this.chain}". ` +
        `Add the chain to EXPECTED_SIGNATURE_LENGTHS before use.`,
      );
    }
    if (result.signature.length !== expectedLen) {
      throw new MpcSignerError(
        "PROVIDER_ERROR",
        this.provider.name,
        `MPC provider returned signature of ${result.signature.length} bytes, ` +
        `expected ${expectedLen} bytes for chain "${this.chain}"`,
      );
    }

    // CRIT-01 fix: Verify that the signed transaction's message bytes match
    // the original transaction data. For Solana, deserialize both the original
    // and signed transactions and compare their serialized message bytes.
    if (this.chain === "solana") {
      try {
        const originalTx = VersionedTransaction.deserialize(new Uint8Array(transaction.data));
        const signedTx = VersionedTransaction.deserialize(result.signedData);
        const originalMessageBytes = originalTx.message.serialize();
        const signedMessageBytes = signedTx.message.serialize();

        // CRYPTO-003 fix: Use timingSafeEqual to prevent timing side-channel leakage
        const { timingSafeEqual } = await import("crypto");
        if (originalMessageBytes.length !== signedMessageBytes.length ||
            !timingSafeEqual(Buffer.from(originalMessageBytes), Buffer.from(signedMessageBytes))) {
          throw new MpcSignerError(
            "PROVIDER_ERROR",
            this.provider.name,
            `CRIT-01: MPC provider returned a signed transaction whose message bytes ` +
            `differ from the original transaction. This indicates transaction tampering.`,
          );
        }
      } catch (err) {
        // If the error is already an MpcSignerError (from the comparison above), rethrow it.
        if (err instanceof MpcSignerError) throw err;
        // For non-Solana-versioned formats (e.g., legacy), attempt legacy deserialization.
        // If both fail, we cannot verify — treat as an error to fail-closed.
        try {
          const { Transaction } = await import("@solana/web3.js");
          const originalTx = Transaction.from(Buffer.from(transaction.data));
          const signedTx = Transaction.from(Buffer.from(result.signedData));
          const originalMessageBytes = originalTx.serializeMessage();
          const signedMessageBytes = signedTx.serializeMessage();

          // CRYPTO-003 fix: Use timingSafeEqual for legacy comparison as well
          const { timingSafeEqual: timingSafeEqualLegacy } = await import("crypto");
          if (originalMessageBytes.length !== signedMessageBytes.length ||
              !timingSafeEqualLegacy(Buffer.from(originalMessageBytes), Buffer.from(signedMessageBytes))) {
            throw new MpcSignerError(
              "PROVIDER_ERROR",
              this.provider.name,
              `CRIT-01: MPC provider returned a signed transaction whose message bytes ` +
              `differ from the original transaction. This indicates transaction tampering.`,
            );
          }
        } catch (innerErr) {
          if (innerErr instanceof MpcSignerError) throw innerErr;
          throw new MpcSignerError(
            "PROVIDER_ERROR",
            this.provider.name,
            `CRIT-01: Could not verify signed transaction message bytes from MPC provider: ` +
            `deserialization failed for both versioned and legacy transaction formats.`,
          );
        }
      }

      // CRYPTO-002 fix: Cryptographically verify the Ed25519 signature returned by the
      // MPC provider against the transaction message bytes and the signer's public key.
      // This ensures the provider actually produced a valid signature, not garbage or a
      // signature from a different key. Uses Node.js crypto (Ed25519 support in Node >= 18).
      try {
        const signerAddress = await this.getAddress();
        const signerPubkey = new PublicKey(signerAddress);
        const signedTxForVerify = VersionedTransaction.deserialize(result.signedData);
        const messageToVerify = signedTxForVerify.message.serialize();

        const { createPublicKey, verify: cryptoVerify } = await import("crypto");
        const keyObject = createPublicKey({
          key: Buffer.concat([
            // Ed25519 DER/SPKI prefix for a 32-byte public key
            Buffer.from("302a300506032b6570032100", "hex"),
            Buffer.from(signerPubkey.toBytes()),
          ]),
          format: "der",
          type: "spki",
        });
        const valid = cryptoVerify(
          null, // Ed25519 doesn't use a separate hash algorithm
          Buffer.from(messageToVerify),
          keyObject,
          Buffer.from(result.signature),
        );
        if (!valid) {
          // MED-T1-02 fix: Auto-retry with cleared address cache on key mismatch.
          // After provider-side key rotation, the cached address may be stale (up to
          // 10-minute TTL). Clear the cache and re-verify with the fresh address before
          // reporting a key mismatch error.
          this.clearAddressCache();
          const freshAddress = await this.getAddress();
          const freshPubkey = new PublicKey(freshAddress);
          const freshKeyObject = createPublicKey({
            key: Buffer.concat([
              Buffer.from("302a300506032b6570032100", "hex"),
              Buffer.from(freshPubkey.toBytes()),
            ]),
            format: "der",
            type: "spki",
          });
          const retryValid = cryptoVerify(null, Buffer.from(messageToVerify), freshKeyObject, Buffer.from(result.signature));
          if (!retryValid) {
            // AUDIT-M-10 fix: Clear address cache on final verification failure to prevent
            // stale cached addresses from persisting across subsequent signing attempts.
            this.clearAddressCache();
            throw new MpcSignerError(
              "PROVIDER_ERROR",
              this.provider.name,
              `CRYPTO-002: MPC provider returned an Ed25519 signature that does not verify ` +
              `against the signer's public key. This indicates a signing fault or key mismatch.`,
            );
          }
        }
      } catch (err) {
        if (err instanceof MpcSignerError) throw err;
        // Versioned deserialization failed — try legacy transaction format
        try {
          const signerAddress = await this.getAddress();
          const signerPubkey = new PublicKey(signerAddress);
          const { Transaction: LegacyTransaction } = await import("@solana/web3.js");
          const legacyTxForVerify = LegacyTransaction.from(Buffer.from(result.signedData));
          const legacyMessageToVerify = legacyTxForVerify.serializeMessage();

          const { createPublicKey: createPubKey, verify: legacyCryptoVerify } = await import("crypto");
          const keyObj = createPubKey({
            key: Buffer.concat([
              Buffer.from("302a300506032b6570032100", "hex"),
              Buffer.from(signerPubkey.toBytes()),
            ]),
            format: "der",
            type: "spki",
          });
          const valid = legacyCryptoVerify(
            null,
            Buffer.from(legacyMessageToVerify),
            keyObj,
            Buffer.from(result.signature),
          );
          if (!valid) {
            // MED-T1-02 fix: Auto-retry with cleared address cache on key mismatch
            this.clearAddressCache();
            const freshAddr = await this.getAddress();
            const freshPub = new PublicKey(freshAddr);
            const freshKey = createPubKey({
              key: Buffer.concat([
                Buffer.from("302a300506032b6570032100", "hex"),
                Buffer.from(freshPub.toBytes()),
              ]),
              format: "der",
              type: "spki",
            });
            const retryValid = legacyCryptoVerify(null, Buffer.from(legacyMessageToVerify), freshKey, Buffer.from(result.signature));
            if (!retryValid) {
              // AUDIT-M-10 fix: Clear address cache on final verification failure to prevent
              // stale cached addresses from persisting across subsequent signing attempts.
              this.clearAddressCache();
              throw new MpcSignerError(
                "PROVIDER_ERROR",
                this.provider.name,
                `CRYPTO-002: MPC provider returned an Ed25519 signature that does not verify ` +
                `against the signer's public key. This indicates a signing fault or key mismatch.`,
              );
            }
          }
        } catch (innerErr) {
          if (innerErr instanceof MpcSignerError) throw innerErr;
          throw new MpcSignerError(
            "PROVIDER_ERROR",
            this.provider.name,
            `CRYPTO-002: Could not verify Ed25519 signature from MPC provider: ` +
            `verification infrastructure unavailable.`,
          );
        }
      }
    } else if (this.chain === "ethereum" || this.chain === "base") {
      // CRYPTO-006 fix: Message integrity verification for EVM chains.
      // Compare pre-signing transaction bytes (the defensive copy we passed to the provider)
      // against the original transaction data to detect provider-side mutation of the input buffer.
      const { timingSafeEqual: tsEqual } = await import("crypto");
      const originalData = new Uint8Array(transaction.data);
      if (dataCopy.length !== originalData.length ||
          !tsEqual(Buffer.from(dataCopy), Buffer.from(originalData))) {
        throw new MpcSignerError(
          "PROVIDER_ERROR",
          this.provider.name,
          `CRYPTO-006: Transaction data was mutated during MPC signing for chain "${this.chain}". ` +
          `This indicates transaction tampering.`,
        );
      }

      // CRIT-T1-03 fix: RLP-decode the signed transaction and compare critical fields
      // (nonce, gasPrice/maxFeePerGas, gasLimit, to, value, data) against the original
      // unsigned transaction. This closes the gap where a malicious MPC provider could
      // return a completely different signed transaction body while keeping the input
      // buffer unchanged.
      try {
        const originalFields = decodeRlpTransaction(dataCopy);
        const signedFields = decodeRlpTransaction(result.signedData);

        // Compare critical transaction fields
        const fieldsToCompare = ["nonce", "to", "value", "data"] as const;
        // CRIT-5 fix: Import timingSafeEqual for constant-time field comparison
        const { timingSafeEqual: tsEqualFields } = await import("crypto");
        for (const field of fieldsToCompare) {
          const origVal = originalFields[field];
          const signedVal = signedFields[field];
          // CRIT-5 fix: Use constant-time comparison to prevent timing side-channel leakage
          const origBuf = Buffer.from(String(origVal), "utf8");
          const signedBuf = Buffer.from(String(signedVal), "utf8");
          if (origBuf.length !== signedBuf.length || !tsEqualFields(origBuf, signedBuf)) {
            throw new MpcSignerError(
              "PROVIDER_ERROR",
              this.provider.name,
              `CRIT-T1-03: MPC provider returned a signed EVM transaction with ` +
              `different "${String(field)}" field. Original: ${String(origVal)}, Signed: ${String(signedVal)}. ` +
              `This indicates transaction tampering by the MPC provider.`,
            );
          }
        }
        // Gas fields may vary (provider may adjust gas), but verify they're not wildly different
        if (originalFields.gasLimit !== signedFields.gasLimit) {
          const origGas = BigInt(originalFields.gasLimit || "0");
          const signedGas = BigInt(signedFields.gasLimit || "0");
          // Allow up to 2x gas increase (provider may add safety margin) but not decrease
          if (signedGas < origGas || signedGas > origGas * 2n) {
            throw new MpcSignerError(
              "PROVIDER_ERROR",
              this.provider.name,
              `CRIT-T1-03: MPC provider returned a signed EVM transaction with ` +
              `suspicious gasLimit change. Original: ${origGas}, Signed: ${signedGas}.`,
            );
          }
        }
        // AUDIT-M-9 fix: Also compare gas price fields to prevent fee inflation attacks
        const gasPriceField = originalFields.gasPrice || originalFields.maxFeePerGas;
        const signedGasPriceField = signedFields.gasPrice || signedFields.maxFeePerGas;
        if (gasPriceField && signedGasPriceField && gasPriceField !== signedGasPriceField) {
          const origPrice = BigInt(gasPriceField || "0");
          const signedPrice = BigInt(signedGasPriceField || "0");
          // S-07 fix: Tightened from 2x to 1.5x. A 2x multiplier allows up to 1.99x inflation,
          // which is excessive for gas price changes. 1.5x provides a reasonable buffer for
          // network fee fluctuations while limiting fee inflation attack surface.
          if (signedPrice > origPrice * 3n / 2n) {
            throw new MpcSignerError(
              "PROVIDER_ERROR",
              this.provider.name,
              `AUDIT-M-9: MPC provider returned a signed EVM transaction with ` +
              `suspicious gas price change. Original: ${origPrice}, Signed: ${signedPrice}.`,
            );
          }
        }
      } catch (err) {
        if (err instanceof MpcSignerError) throw err;
        // RLP decoding failed — this is a critical verification, so fail-closed
        throw new MpcSignerError(
          "PROVIDER_ERROR",
          this.provider.name,
          `CRIT-T1-03: Could not RLP-decode EVM transaction for field-level verification: ` +
          `${err instanceof Error ? err.message : String(err)}. Failing closed.`,
        );
      }

      // M-41 fix: EVM signature verification — recover the signer address from
      // the ECDSA secp256k1 signature and compare against the expected address.
      // Uses ecrecover: keccak256(unsigned tx) + (v, r, s) → recovered address.
      try {
        const { secp256k1 } = await import("@noble/curves/secp256k1");
        const { keccak_256 } = await import("@noble/hashes/sha3");

        const sig = result.signature;
        // EVM ECDSA signatures are 65 bytes: r (32) + s (32) + v (1)
        const r = sig.slice(0, 32);
        const s = sig.slice(32, 64);
        const v = sig[64] as number;

        // Recovery bit: EVM uses v=27/28 (legacy), v=0/1 (modern), or EIP-155 (v >= 35)
        let recoveryBit: number;
        if (v === 0 || v === 1) {
          recoveryBit = v;
        } else if (v === 27 || v === 28) {
          recoveryBit = v - 27;
        } else if (v >= 35) {
          // EIP-155: v = chainId * 2 + 35 + recoveryBit
          recoveryBit = (v - 35) % 2;
        } else {
          throw new MpcSignerError(
            "PROVIDER_ERROR",
            this.provider.name,
            `CRYPTO-002: Invalid EVM signature recovery parameter v=${v}. ` +
            `Expected 0, 1, 27, 28, or EIP-155 value (>= 35).`,
          );
        }

        // The message hash is keccak256 of the unsigned transaction bytes
        const txHash = keccak_256(dataCopy);

        // Recover the public key from the signature
        const compactSig = new Uint8Array(64);
        compactSig.set(r, 0);
        compactSig.set(s, 32);
        const sigObj = secp256k1.Signature.fromCompact(compactSig).addRecoveryBit(recoveryBit);
        const recoveredPubKey = sigObj.recoverPublicKey(txHash);

        // Derive Ethereum address: keccak256(uncompressed pubkey without 0x04 prefix), last 20 bytes
        const uncompressedKey = recoveredPubKey.toRawBytes(false).slice(1);
        const addressHash = keccak_256(uncompressedKey);
        const recoveredAddress = "0x" + Buffer.from(addressHash.slice(-20)).toString("hex");

        // Compare against expected signer address (case-insensitive per EIP-55)
        const expectedAddress = await this.getAddress();
        if (recoveredAddress.toLowerCase() !== expectedAddress.toLowerCase()) {
          throw new MpcSignerError(
            "PROVIDER_ERROR",
            this.provider.name,
            `CRYPTO-002: MPC provider returned an ECDSA signature that recovers to ` +
            `a different address than expected. This indicates a signing fault or key mismatch.`,
          );
        }
      } catch (innerErr) {
        if (innerErr instanceof MpcSignerError) throw innerErr;
        throw new MpcSignerError(
          "PROVIDER_ERROR",
          this.provider.name,
          `CRYPTO-002: Could not verify ECDSA signature from MPC provider: ` +
          `verification infrastructure unavailable.`,
        );
      }
    }

    // CRYPTO-007 fix: Re-check destroyed state after signing completes.
    // Another async operation (e.g., destroy()) could have run during the await.
    if (this.destroyed) {
      throw new MpcSignerError(
        "PROVIDER_ERROR",
        this.provider.name,
        "MpcSigner was destroyed during signing operation",
      );
    }

    return {
      chain: this.chain,
      data: result.signedData,
      signature: result.signature,
    };
  }

  /**
   * HIGH-01 fix: Clean up cached state. MPC signers don't hold key material
   * locally, but we clear cached address and mark as destroyed.
   * LOW-03 fix: Also calls the provider's destroy() method if available,
   * allowing the provider to release connections and clear its own state.
   */
  async destroy(): Promise<void> {
    this.destroyed = true;
    this.cachedAddress = null;
    // MED-02 fix: Reset the address cache timestamp so stale timing data
    // doesn't persist if the object is somehow referenced after destruction.
    this.addressCachedAt = 0;
    // LOW-03 fix: Call the provider's optional destroy method.
    if (this.provider.destroy) {
      try {
        await this.provider.destroy();
      } catch {
        // Provider cleanup failure should not prevent signer destruction.
        // The signer is already marked as destroyed above.
      }
    }
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
    // L-17 fix: Track total elapsed time to prevent unbounded retry+timeout chains.
    // Even with clamped maxRetries and timeoutMs, the total duration can be
    // maxRetries * timeoutMs + backoff delays, which could be excessively long.
    const retryStartTime = Date.now();
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // L-17 fix: Check total elapsed time before each attempt
      if (attempt > 0 && Date.now() - retryStartTime > MAX_TOTAL_RETRY_DURATION_MS) {
        throw new MpcSignerError(
          "TIMEOUT",
          this.provider.name,
          `MPC signing exceeded maximum total retry duration of ${MAX_TOTAL_RETRY_DURATION_MS}ms`,
        );
      }
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        // Don't retry chain mismatch or other non-transient errors
        if (err instanceof MpcSignerError) throw err;
        // Last attempt — don't retry
        if (attempt === this.maxRetries) break;
        // CRYPTO-016 fix: Exponential backoff between retries (1s, 2s, 4s, ... capped at 10s)
        if (attempt < this.maxRetries) {
          // S-09 fix: Use cryptographically secure randomness for retry jitter instead of Math.random()
          const jitterRandom = globalThis.crypto.getRandomValues(new Uint32Array(1))[0]! / 0xFFFFFFFF;
          const delay = Math.min(1000 * Math.pow(2, attempt), 10000) * (0.5 + jitterRandom * 0.5);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    // CRYPTO-017 fix: Sanitize provider error details before including in thrown errors.
    // Strip URLs and specific numeric values to prevent information leakage.
    const rawMessage = lastError instanceof Error ? lastError.message : String(lastError);
    const sanitized = rawMessage
      .replace(/https?:\/\/[^\s)}\]"']+/gi, "[URL_REDACTED]")
      .replace(/\b\d{4,}\b/g, "[NUM_REDACTED]")
      // S-13 fix: Additional regex patterns to sanitize UUIDs, long hex strings, and base64 blobs
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "[UUID_REDACTED]")
      .replace(/[0-9a-f]{32,}/gi, "[HEX_REDACTED]")
      .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, "[BASE64_REDACTED]");
    throw new MpcSignerError(
      "PROVIDER_ERROR",
      this.provider.name,
      // LOW-T1-03 fix: provider name redacted from error messages
`MPC provider failed after ${this.maxRetries + 1} attempts: ${sanitized}`,
    );
  }

  /**
   * Wrap a promise with a timeout.
   *
   * MED-02 NOTE: Timeout limitation — when the timeout fires, the reject callback
   * runs immediately but the underlying provider promise remains in-flight. The
   * provider's eventual resolution/rejection will be silently ignored (the handlers
   * clear the timer and call resolve/reject on an already-settled promise, which
   * is a no-op). This means:
   * - The provider may continue consuming resources (network, CPU) after timeout.
   * - If the provider has side-effects (e.g., nonce consumption), those may still
   *   complete even though MpcSigner reports a timeout.
   * - Providers should be designed to be idempotent so that retries after timeouts
   *   do not cause duplicate operations or state corruption.
   */
  /**
   * CRYPTO-008 fix: Use .finally() to guarantee the timer is always cleared,
   * preventing timer and promise reference leaks regardless of resolution path.
   *
   * NET-11 fix: Accepts an optional AbortController. When the timeout fires,
   * controller.abort() is called to signal cooperative cancellation to the
   * underlying provider call (e.g., aborting in-flight HTTP requests). Providers
   * that accept an AbortSignal in signTransaction() can use it to cancel work
   * and release resources immediately instead of running to completion in the background.
   */
  private withTimeout<T>(promise: Promise<T>, abortController?: AbortController): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        // NET-11 fix: Signal the provider to abort in-flight work on timeout
        abortController?.abort();
        reject(
          new MpcSignerError(
            "TIMEOUT",
            this.provider.name,
            `MPC provider timed out after ${this.timeoutMs}ms`,
          ),
        );
      }, this.timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    });
  }
}
