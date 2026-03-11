/**
 * TurnkeyProvider — Turnkey MPC signing provider for Kova.
 *
 * Implements the MpcSigningProvider interface using Turnkey's server-side SDK.
 * Turnkey signs transactions inside TEEs (Trusted Execution Environments),
 * meaning private keys never leave secure hardware.
 *
 * Requirements:
 *   - Install: npm install @turnkey/sdk-server @turnkey/api-key-stamper
 *   - A Turnkey organization with an API key pair
 *   - A Solana wallet created in Turnkey
 *
 * @example
 * ```typescript
 * import { TurnkeyProvider } from "kova/signers";
 * import { MpcSigner } from "kova";
 *
 * const provider = new TurnkeyProvider({
 *   apiBaseUrl: "https://api.turnkey.com",
 *   apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY!,
 *   apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY!,
 *   defaultOrganizationId: process.env.TURNKEY_ORGANIZATION_ID!,
 *   signWith: process.env.TURNKEY_WALLET_ADDRESS!, // or private key ID
 * });
 *
 * const signer = new MpcSigner({
 *   provider,
 *   chain: "solana",
 * });
 * ```
 */

import crypto from "node:crypto";
import type { MpcSigningProvider, MpcSignResult } from "./mpc.js";

// ── Configuration ──────────────────────────────────────────────────────────

export interface TurnkeyProviderConfig {
  /** Turnkey API base URL (e.g., "https://api.turnkey.com") */
  apiBaseUrl: string;
  /** API public key from your Turnkey API key pair */
  apiPublicKey: string;
  /** API private key from your Turnkey API key pair */
  apiPrivateKey: string;
  /** Your Turnkey organization ID */
  defaultOrganizationId: string;
  /**
   * The Solana wallet address or Turnkey private key ID to sign with.
   * If this is a Solana address (base58), it will be used directly.
   * If this is a Turnkey private key ID (UUID format), Turnkey resolves it internally.
   */
  signWith: string;
  /**
   * Timeout in milliseconds for external Turnkey API calls.
   * Applies to signTransaction, getAddress, and healthCheck.
   * @default 30000
   */
  timeout?: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

/** S-06 fix: Address cache TTL — revalidate after 10 minutes to detect key rotation */
const ADDRESS_CACHE_TTL_MS = 600_000;

/** M-65 fix: Default timeout for external Turnkey API calls */
const DEFAULT_TIMEOUT_MS = 30_000;

// ── Provider implementation ────────────────────────────────────────────────

export class TurnkeyProvider implements MpcSigningProvider {
  readonly name = "turnkey";

  /** S-02 fix: Store config fields individually instead of by reference */
  private apiBaseUrl: string | null;
  private apiPublicKey: string | null;
  // HIGH-1 fix: Store API private key as Buffer for proper zeroization.
  // JavaScript strings are immutable and cannot be securely zeroed. Buffer.fill(0)
  // provides deterministic memory clearing.
  private apiPrivateKey: Buffer;
  private defaultOrganizationId: string | null;
  private signWith: string | null;
  /** M-65 fix: Configurable timeout for external API calls */
  private timeout: number;
  private client: TurnkeyServerClient | null = null;
  private cachedAddress: string | null = null;
  /** S-06 fix: Timestamp of last address cache refresh */
  private cachedAddressTimestamp: number = 0;
  /** S-01 fix: Track destroyed state to reject operations after cleanup */
  private destroyed = false;

  constructor(config: TurnkeyProviderConfig) {
    if (!config.apiBaseUrl) throw new Error("TurnkeyProvider: apiBaseUrl is required");
    if (!config.apiBaseUrl.startsWith("https://")) {
      throw new Error("TurnkeyProvider: apiBaseUrl must use HTTPS to protect API credentials in transit");
    }
    if (!config.apiPublicKey) throw new Error("TurnkeyProvider: apiPublicKey is required");
    if (!config.apiPrivateKey) throw new Error("TurnkeyProvider: apiPrivateKey is required");
    if (typeof config.apiPrivateKey !== "string" || config.apiPrivateKey.trim().length < 16 || config.apiPrivateKey.length > 4096) {
      throw new Error("TurnkeyProvider: apiPrivateKey has invalid format");
    }
    if (!config.defaultOrganizationId) throw new Error("TurnkeyProvider: defaultOrganizationId is required");
    if (!config.signWith) throw new Error("TurnkeyProvider: signWith is required");

    // S-02 fix: Destructure config into private fields instead of storing by reference.
    // This prevents the caller from mutating config properties after construction.
    this.apiBaseUrl = config.apiBaseUrl;
    this.apiPublicKey = config.apiPublicKey;
    this.apiPrivateKey = Buffer.from(config.apiPrivateKey);
    this.defaultOrganizationId = config.defaultOrganizationId;
    this.signWith = config.signWith;
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
  }

  /** Exclude sensitive fields from JSON serialization. S-12 fix: Truncate sensitive fields. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      apiBaseUrl: this.apiBaseUrl,
      // HIGH-2 fix: Fully redact API public key to prevent partial key leakage
      apiPublicKey: "[REDACTED]",
      defaultOrganizationId: this.defaultOrganizationId,
      signWith: "[REDACTED]",
    };
  }

  /**
   * M76 fix: Prevent accidental credential leakage via string coercion or template literals.
   */
  toString(): string {
    return "[TurnkeyProvider]";
  }

  /** Exclude sensitive fields from console.log / util.inspect */
  [Symbol.for("nodejs.util.inspect.custom")](): Record<string, unknown> {
    return this.toJSON();
  }

  /**
   * Return the Solana address for the configured signing key.
   * If signWith is already a Solana address, returns it directly.
   * Otherwise queries Turnkey to resolve the private key ID to an address.
   */
  async getAddress(): Promise<string> {
    // S-06 fix: Check cache with TTL to detect key rotation
    if (this.cachedAddress && Date.now() - this.cachedAddressTimestamp < ADDRESS_CACHE_TTL_MS) {
      return this.cachedAddress;
    }

    // Reject operations after destroy()
    if (this.destroyed || !this.signWith) {
      throw new Error("TurnkeyProvider has been destroyed and can no longer resolve addresses");
    }

    const signWith = this.signWith;

    // If signWith looks like a Solana base58 address (not a UUID), use it directly
    if (!isUuid(signWith)) {
      this.cachedAddress = signWith;
      this.cachedAddressTimestamp = Date.now();
      return this.cachedAddress;
    }

    // Otherwise, query Turnkey for the address associated with this private key ID
    const client = await this.getClient();
    const response = await this.withTimeout(
      client.getPrivateKey({
        privateKeyId: signWith,
        organizationId: this.defaultOrganizationId ?? "",
      }),
      "getAddress",
    );

    const solanaAddress = response.privateKey.addresses?.find(
      (addr: { format: string }) => addr.format === "ADDRESS_FORMAT_SOLANA",
    );

    if (!solanaAddress) {
      throw new Error(
        `TurnkeyProvider: No Solana address found for private key ID "${signWith}". ` +
        `Ensure the key was created with Solana curve (ED25519).`,
      );
    }

    this.cachedAddress = solanaAddress.address;
    this.cachedAddressTimestamp = Date.now();
    return this.cachedAddress;
  }

  /**
   * Sign a Solana transaction via Turnkey's SIGN_TRANSACTION activity.
   * The transaction bytes are sent to Turnkey, signed inside a TEE,
   * and the fully signed transaction is returned.
   */
  async signTransaction(transactionData: Uint8Array, signal?: AbortSignal): Promise<MpcSignResult> {
    // S-01 fix: Reject operations after destroy()
    if (this.destroyed || !this.defaultOrganizationId || !this.signWith) {
      throw new Error("TurnkeyProvider has been destroyed and can no longer sign transactions");
    }

    const orgId = this.defaultOrganizationId;
    const signWith = this.signWith;

    if (signal?.aborted) {
      throw new Error("TurnkeyProvider: signing aborted before request");
    }

    const client = await this.getClient();

    // Encode transaction as base64 for the Turnkey API
    const unsignedTxBase64 = Buffer.from(transactionData).toString("base64");

    // Use Turnkey's signTransaction activity
    // NOTE: AbortSignal cannot be passed to the Turnkey SDK client. The signal is checked before and after the call.
    const response = await this.withTimeout(
      client.signTransaction({
        type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
        organizationId: orgId,
        parameters: {
          signWith: signWith,
          unsignedTransaction: unsignedTxBase64,
          type: "TRANSACTION_TYPE_SOLANA",
        },
        timestampMs: String(Date.now()),
      }),
      "signTransaction",
    );

    // Check for abort after the API call
    if (signal?.aborted) {
      throw new Error("TurnkeyProvider: signing aborted after request");
    }

    // M75 fix: Validate activity status before trusting the result.
    // Turnkey activities can have statuses like ACTIVITY_STATUS_COMPLETED,
    // ACTIVITY_STATUS_FAILED, ACTIVITY_STATUS_CONSENSUS_NEEDED, etc.
    // Only ACTIVITY_STATUS_COMPLETED indicates a successful signing operation.
    const signActivityStatus = response.activity?.status;
    if (signActivityStatus && signActivityStatus !== "ACTIVITY_STATUS_COMPLETED") {
      throw new Error(
        `TurnkeyProvider: signTransaction activity did not complete successfully. ` +
        `Status: ${signActivityStatus}. Expected ACTIVITY_STATUS_COMPLETED.`,
      );
    }

    const result = response.activity?.result?.signTransactionResult;
    if (!result?.signedTransaction) {
      throw new Error(
        `TurnkeyProvider: Turnkey returned no signed transaction. ` +
        `Activity status: ${signActivityStatus ?? "unknown"}`,
      );
    }

    // Decode the signed transaction from base64
    const signedData = Buffer.from(result.signedTransaction, "base64");

    // Extract the signature from the signed Solana transaction.
    // In a Solana VersionedTransaction, the first bytes are:
    //   - compact-u16 encoding of signature count
    //   - then each signature is 64 bytes
    // For a single-signer tx, byte 0 is 0x01 (count=1), then bytes 1-64 are the signature.
    const { offset: signatureOffset, count: signatureCount } = getSignatureOffset(signedData);
    const signature = signedData.slice(signatureOffset, signatureOffset + 64);

    // Verify signed transaction integrity: message bytes must match the original
    const signedMessageStart = signatureOffset + signatureCount * 64;
    const signedMessageBytes = signedData.slice(signedMessageStart);

    // The original unsigned transaction also has a signature section (with empty/zero signatures)
    const { offset: origSigOffset, count: origSigCount } = getSignatureOffset(transactionData);
    const origMessageStart = origSigOffset + origSigCount * 64;
    const origMessageBytes = transactionData.slice(origMessageStart);

    // S-03 fix: Use constant-time comparison to prevent timing side-channel leakage
    if (
      signedMessageBytes.length !== origMessageBytes.length ||
      !crypto.timingSafeEqual(Buffer.from(signedMessageBytes), Buffer.from(origMessageBytes))
    ) {
      throw new Error(
        "TurnkeyProvider: signed transaction message bytes do not match the original unsigned transaction. " +
        "The transaction may have been tampered with.",
      );
    }

    return {
      signedData: new Uint8Array(signedData),
      signature: new Uint8Array(signature),
    };
  }

  /**
   * Check if Turnkey API is reachable and the signing key is accessible.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const client = await this.getClient();
      // Verify we can fetch the organization (lightweight API call)
      await this.withTimeout(
        client.getWhoami({
          organizationId: this.defaultOrganizationId ?? "",
        }),
        "healthCheck",
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clean up the Turnkey client instance.
   *
   * S-01 fix: V8 GC LIMITATION — JavaScript strings are immutable and managed by V8's
   * garbage collector. Setting apiPrivateKey to "" removes the reference, but the original
   * string content may persist in V8's heap until garbage collected and the memory is
   * overwritten. There is no way to securely zero immutable JS strings from user code.
   * For production use, consider hardware-backed key storage (e.g., Turnkey TEE) where
   * the private key never enters the Node.js process memory.
   */
  async destroy(): Promise<void> {
    this.destroyed = true;
    this.apiPrivateKey.fill(0);
    this.client = null;
    this.cachedAddress = null;
    this.cachedAddressTimestamp = 0;
    // S-01 fix: Null out all config references to aid GC and prevent post-destroy access
    this.apiBaseUrl = null;
    this.apiPublicKey = null;
    this.defaultOrganizationId = null;
    this.signWith = null;
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  /**
   * M-65 fix: Wrap a promise with a timeout to prevent indefinite hangs on external API calls.
   */
  private withTimeout<T>(promise: Promise<T>, operation: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`TurnkeyProvider.${operation} timed out after ${this.timeout}ms`)),
          this.timeout,
        ),
      ),
    ]);
  }

  /**
   * Lazily initialize the Turnkey server client.
   * Uses dynamic import so @turnkey/sdk-server is only loaded when needed.
   */
  private async getClient(): Promise<TurnkeyServerClient> {
    // S-01 fix: Reject operations after destroy()
    if (this.destroyed || !this.apiBaseUrl || !this.apiPublicKey || !this.defaultOrganizationId) {
      throw new Error("TurnkeyProvider has been destroyed");
    }
    if (this.client) return this.client;

    try {
      // Dynamic import — @turnkey/sdk-server is an optional peer dependency.
      const moduleName = "@turnkey/sdk-server";
      const { Turnkey } = await import(/* webpackIgnore: true */ moduleName);

      const turnkey = new Turnkey({
        apiBaseUrl: this.apiBaseUrl,
        apiPublicKey: this.apiPublicKey,
        apiPrivateKey: this.apiPrivateKey.toString(),
        defaultOrganizationId: this.defaultOrganizationId,
      });

      const apiClient = turnkey.apiClient() as TurnkeyServerClient;
      this.client = apiClient;
      return apiClient;
    } catch (err) {
      if (err instanceof Error && err.message.includes("Cannot find module")) {
        throw new Error(
          `TurnkeyProvider requires @turnkey/sdk-server. Install it with:\n` +
          `  npm install @turnkey/sdk-server`,
        );
      }
      throw err;
    }
  }
}

// ── Utility types and functions ────────────────────────────────────────────

/** S-05 fix: Minimal structural interface for the Turnkey API client (avoids requiring the full SDK at compile time) */
interface TurnkeyClientLike {
  signTransaction(params: {
    type: string;
    organizationId: string;
    parameters: { signWith: string; unsignedTransaction: string; type: string };
    timestampMs: string;
  }): Promise<{ activity: { status?: string; result?: { signTransactionResult?: { signedTransaction?: string } } } }>;
  getWhoami(params: { organizationId: string }): Promise<{ organizationId: string; userId: string }>;
  getPrivateKey(params: { privateKeyId: string; organizationId: string }): Promise<{
    privateKey: { addresses?: Array<{ format: string; address: string }> };
  }>;
}
type TurnkeyServerClient = TurnkeyClientLike;

/** Check if a string looks like a UUID (Turnkey private key ID format) */
function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/**
 * Get the offset of the first signature and the signature count
 * in a serialized Solana transaction.
 * Handles compact-u16 encoding (1, 2, or 3 bytes).
 */
function getSignatureOffset(data: Buffer | Uint8Array): { offset: number; count: number } {
  if (data.length < 1) {
    throw new Error("Transaction data is too short to contain a signature count");
  }

  const firstByte = data[0]!;
  let count: number;
  let offset: number;

  if (firstByte <= 0x7f) {
    // Single-byte compact-u16: values 0–127
    count = firstByte;
    offset = 1;
  } else if (data.length < 2) {
    throw new Error("Transaction data is too short for multi-byte compact-u16 signature count");
  } else {
    const secondByte = data[1]!;
    if (secondByte <= 0x7f) {
      // Two-byte compact-u16: values 128–16383
      count = (firstByte & 0x7f) | (secondByte << 7);
      offset = 2;
    } else {
      // Three-byte compact-u16: values 16384–65535
      if (data.length < 3) {
        throw new Error("Transaction data is too short for 3-byte compact-u16 signature count");
      }
      const thirdByte = data[2]!;
      count = (firstByte & 0x7f) | ((secondByte & 0x7f) << 7) | (thirdByte << 14);
      offset = 3;
    }
  }

  if (count <= 0) {
    throw new Error("Transaction must have at least one signature");
  }

  // Validate buffer has enough bytes for at least one signature (64 bytes)
  if (data.length < offset + 64) {
    throw new Error("Transaction data is too short to contain a signature");
  }

  return { offset, count };
}
