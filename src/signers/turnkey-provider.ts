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
}

// ── Provider implementation ────────────────────────────────────────────────

export class TurnkeyProvider implements MpcSigningProvider {
  readonly name = "turnkey";

  private readonly config: TurnkeyProviderConfig;
  private client: TurnkeyServerClient | null = null;
  private cachedAddress: string | null = null;

  constructor(config: TurnkeyProviderConfig) {
    if (!config.apiBaseUrl) throw new Error("TurnkeyProvider: apiBaseUrl is required");
    if (!config.apiPublicKey) throw new Error("TurnkeyProvider: apiPublicKey is required");
    if (!config.apiPrivateKey) throw new Error("TurnkeyProvider: apiPrivateKey is required");
    if (!config.defaultOrganizationId) throw new Error("TurnkeyProvider: defaultOrganizationId is required");
    if (!config.signWith) throw new Error("TurnkeyProvider: signWith is required");

    this.config = config;
  }

  /**
   * Return the Solana address for the configured signing key.
   * If signWith is already a Solana address, returns it directly.
   * Otherwise queries Turnkey to resolve the private key ID to an address.
   */
  async getAddress(): Promise<string> {
    if (this.cachedAddress) return this.cachedAddress;

    // If signWith looks like a Solana base58 address (not a UUID), use it directly
    if (!isUuid(this.config.signWith)) {
      this.cachedAddress = this.config.signWith;
      return this.cachedAddress;
    }

    // Otherwise, query Turnkey for the address associated with this private key ID
    const client = await this.getClient();
    const response = await client.getPrivateKey({
      privateKeyId: this.config.signWith,
      organizationId: this.config.defaultOrganizationId,
    });

    const solanaAddress = response.privateKey.addresses?.find(
      (addr: { format: string }) => addr.format === "ADDRESS_FORMAT_SOLANA",
    );

    if (!solanaAddress) {
      throw new Error(
        `TurnkeyProvider: No Solana address found for private key ID "${this.config.signWith}". ` +
        `Ensure the key was created with Solana curve (ED25519).`,
      );
    }

    this.cachedAddress = solanaAddress.address;
    return this.cachedAddress!;
  }

  /**
   * Sign a Solana transaction via Turnkey's SIGN_TRANSACTION activity.
   * The transaction bytes are sent to Turnkey, signed inside a TEE,
   * and the fully signed transaction is returned.
   */
  async signTransaction(transactionData: Uint8Array, signal?: AbortSignal): Promise<MpcSignResult> {
    if (signal?.aborted) {
      throw new Error("TurnkeyProvider: signing aborted before request");
    }

    const client = await this.getClient();

    // Encode transaction as base64 for the Turnkey API
    const unsignedTxBase64 = Buffer.from(transactionData).toString("base64");

    // Use Turnkey's signTransaction activity
    const response = await client.signTransaction({
      type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
      organizationId: this.config.defaultOrganizationId,
      parameters: {
        signWith: this.config.signWith,
        unsignedTransaction: unsignedTxBase64,
        type: "TRANSACTION_TYPE_SOLANA",
      },
      timestampMs: String(Date.now()),
    });

    // Check for abort after the API call
    if (signal?.aborted) {
      throw new Error("TurnkeyProvider: signing aborted after request");
    }

    const result = response.activity?.result?.signTransactionResult;
    if (!result?.signedTransaction) {
      throw new Error(
        `TurnkeyProvider: Turnkey returned no signed transaction. ` +
        `Activity status: ${response.activity?.status ?? "unknown"}`,
      );
    }

    // Decode the signed transaction from base64
    const signedData = Buffer.from(result.signedTransaction, "base64");

    // Extract the signature from the signed Solana transaction.
    // In a Solana VersionedTransaction, the first bytes are:
    //   - compact-u16 encoding of signature count
    //   - then each signature is 64 bytes
    // For a single-signer tx, byte 0 is 0x01 (count=1), then bytes 1-64 are the signature.
    const signatureOffset = getSignatureOffset(signedData);
    const signature = signedData.slice(signatureOffset, signatureOffset + 64);

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
      await client.getWhoami({
        organizationId: this.config.defaultOrganizationId,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clean up the Turnkey client instance.
   */
  async destroy(): Promise<void> {
    this.client = null;
    this.cachedAddress = null;
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  /**
   * Lazily initialize the Turnkey server client.
   * Uses dynamic import so @turnkey/sdk-server is only loaded when needed.
   */
  private async getClient(): Promise<TurnkeyServerClient> {
    if (this.client) return this.client;

    try {
      // Dynamic import — @turnkey/sdk-server is an optional peer dependency.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const moduleName = "@turnkey/sdk-server";
      const { Turnkey } = await import(/* webpackIgnore: true */ moduleName);

      const turnkey = new Turnkey({
        apiBaseUrl: this.config.apiBaseUrl,
        apiPublicKey: this.config.apiPublicKey,
        apiPrivateKey: this.config.apiPrivateKey,
        defaultOrganizationId: this.config.defaultOrganizationId,
      });

      this.client = turnkey.apiClient();
      return this.client;
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

/** Minimal type for the Turnkey API client (avoids requiring the full SDK at compile time) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TurnkeyServerClient = any;

/** Check if a string looks like a UUID (Turnkey private key ID format) */
function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/**
 * Get the offset of the first signature in a serialized Solana transaction.
 * Handles compact-u16 encoding of the signature count.
 */
function getSignatureOffset(data: Buffer | Uint8Array): number {
  const firstByte = data[0]!;
  // compact-u16: if high bit is not set, it's a single-byte count
  if (firstByte <= 0x7f) {
    return 1; // 1 byte for count, signature starts at byte 1
  }
  // For >127 signatures (extremely unlikely), the count uses 2-3 bytes
  return 2;
}
