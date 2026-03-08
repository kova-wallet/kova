/**
 * Wallet Source Registry — maps declarative wallet source configs to concrete Signer instances.
 *
 * Supported sources:
 *   - "generate"   → Generate a new random Solana keypair
 *   - "secret-key" → Import from base58 string or JSON byte array
 *   - "keyfile"    → Load Solana CLI id.json format from a file path or raw bytes
 *   - "turnkey"    → Connect Turnkey MPC signer via API credentials
 *   - "env"        → Auto-detect from environment variables (KOVA_SIGNER_TYPE)
 */

import { Keypair } from "@solana/web3.js";
import { LocalSigner } from "@kova/signers/local.js";
import { MpcSigner } from "@kova/signers/mpc.js";
import { TurnkeyProvider } from "@kova/signers/turnkey-provider.js";
import type { Signer } from "@kova/signers/interface.js";
import { getConfig } from "./config";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────────

export type WalletSourceType = "generate" | "secret-key" | "keyfile" | "turnkey" | "env";

export interface WalletSourceConfig {
  type: WalletSourceType;
  /** base58 or JSON array string — used when type is "secret-key" */
  secretKey?: string;
  /** Path to Solana CLI id.json — used when type is "keyfile" */
  keyfilePath?: string;
  /** Raw keyfile bytes (from file upload) — used when type is "keyfile" */
  keyfileBytes?: number[];
  /** Turnkey credentials — used when type is "turnkey" */
  turnkey?: {
    apiBaseUrl: string;
    apiPublicKey: string;
    apiPrivateKey: string;
    organizationId: string;
    walletAddress: string;
  };
}

export interface ResolvedWallet {
  signer: Signer;
  address: string;
  /** Human-readable label for the wallet source */
  sourceLabel: string;
  /** Which source type created this wallet */
  sourceType: WalletSourceType;
  /** Raw keypair bytes if available (for local signers) */
  keypairBytes: Uint8Array | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseSecretKeyInput(input: string): Uint8Array {
  const trimmed = input.trim();

  // Try JSON array first: [1, 2, 3, ...]
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as number[];
    if (!Array.isArray(parsed) || parsed.length !== 64) {
      throw new Error("Secret key JSON array must contain exactly 64 bytes");
    }
    return Uint8Array.from(parsed);
  }

  // Try base58 — Solana CLI sometimes outputs base58 private keys
  // A base58-encoded 64-byte key is ~88 characters
  if (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(trimmed)) {
    // Use bs58 decoding via Keypair validation
    const bytes = Uint8Array.from(Buffer.from(trimmed, "base64"));
    if (bytes.length === 64) {
      return bytes;
    }
  }

  // Try raw JSON number array without brackets (comma-separated)
  if (/^\d+(\s*,\s*\d+)+$/.test(trimmed)) {
    const parsed = trimmed.split(",").map((n) => Number(n.trim()));
    if (parsed.length === 64) {
      return Uint8Array.from(parsed);
    }
  }

  throw new Error(
    "Invalid secret key format. Provide a JSON array of 64 bytes (e.g., [1, 2, 3, ...]) " +
    "or a comma-separated list of 64 numbers."
  );
}

function parseKeyfileContent(content: string): Uint8Array {
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    throw new Error("Keyfile must contain a JSON array of bytes");
  }
  if (parsed.length !== 64) {
    throw new Error(`Keyfile contains ${parsed.length} bytes, expected 64`);
  }
  return Uint8Array.from(parsed as number[]);
}

// ── Registry ───────────────────────────────────────────────────────────────

export class WalletSourceRegistry {
  /**
   * Resolve a wallet source config into a concrete Signer + address.
   */
  async resolve(config: WalletSourceConfig): Promise<ResolvedWallet> {
    switch (config.type) {
      case "generate":
        return this.resolveGenerate();
      case "secret-key":
        return this.resolveSecretKey(config);
      case "keyfile":
        return this.resolveKeyfile(config);
      case "turnkey":
        return this.resolveTurnkey(config);
      case "env":
        return this.resolveFromEnv();
      default:
        throw new Error(`Unknown wallet source type: ${config.type}`);
    }
  }

  /**
   * Auto-detect wallet source from environment variables.
   * Returns null if no signer type is configured or config is incomplete.
   */
  async resolveFromEnv(): Promise<ResolvedWallet> {
    const appConfig = getConfig();

    switch (appConfig.signerType) {
      case "turnkey":
        return this.resolveTurnkey({
          type: "turnkey",
          turnkey: {
            apiBaseUrl: appConfig.turnkeyApiBaseUrl ?? "",
            apiPublicKey: appConfig.turnkeyApiPublicKey ?? "",
            apiPrivateKey: appConfig.turnkeyApiPrivateKey ?? "",
            organizationId: appConfig.turnkeyOrganizationId ?? "",
            walletAddress: appConfig.turnkeyWalletAddress ?? "",
          },
        });

      case "env-keypair": {
        const envKey = process.env.KOVA_KEYPAIR;
        if (!envKey) {
          throw new Error("KOVA_SIGNER_TYPE=env-keypair requires KOVA_KEYPAIR environment variable");
        }
        return this.resolveSecretKey({ type: "secret-key", secretKey: envKey });
      }

      case "local":
      default: {
        // Load first keyfile from wallets directory
        const walletsDir = resolve(process.cwd(), appConfig.walletsDir);
        if (!existsSync(walletsDir)) {
          throw new Error(`Wallets directory not found: ${walletsDir}`);
        }
        const { readdirSync } = await import("node:fs");
        const files = readdirSync(walletsDir).filter((f) => f.endsWith(".json"));
        if (files.length === 0) {
          throw new Error(`No wallet keyfiles found in: ${walletsDir}`);
        }
        const firstFile = files[0]!;
        return this.resolveKeyfile({
          type: "keyfile",
          keyfilePath: resolve(walletsDir, firstFile),
        });
      }
    }
  }

  // ── Private resolvers ──────────────────────────────────────────────────

  private resolveGenerate(): ResolvedWallet {
    const keypair = Keypair.generate();
    const signer = new LocalSigner(keypair, { dangerouslyAllowInProduction: true });
    return {
      signer,
      address: keypair.publicKey.toBase58(),
      sourceLabel: "Generated",
      sourceType: "generate",
      keypairBytes: keypair.secretKey,
    };
  }

  private resolveSecretKey(config: WalletSourceConfig): ResolvedWallet {
    if (!config.secretKey) {
      throw new Error("Secret key is required for 'secret-key' source");
    }
    const bytes = parseSecretKeyInput(config.secretKey);
    const keypair = Keypair.fromSecretKey(bytes);
    const signer = new LocalSigner(keypair, { dangerouslyAllowInProduction: true });
    return {
      signer,
      address: keypair.publicKey.toBase58(),
      sourceLabel: "Imported (secret key)",
      sourceType: "secret-key",
      keypairBytes: keypair.secretKey,
    };
  }

  private resolveKeyfile(config: WalletSourceConfig): ResolvedWallet {
    let bytes: Uint8Array;

    if (config.keyfileBytes) {
      // From file upload
      if (config.keyfileBytes.length !== 64) {
        throw new Error(`Keyfile contains ${config.keyfileBytes.length} bytes, expected 64`);
      }
      bytes = Uint8Array.from(config.keyfileBytes);
    } else if (config.keyfilePath) {
      // From file path
      const filePath = resolve(config.keyfilePath);
      if (!existsSync(filePath)) {
        throw new Error(`Keyfile not found: ${filePath}`);
      }
      const content = readFileSync(filePath, "utf-8");
      bytes = parseKeyfileContent(content);
    } else {
      throw new Error("Either keyfilePath or keyfileBytes is required for 'keyfile' source");
    }

    const keypair = Keypair.fromSecretKey(bytes);
    const signer = new LocalSigner(keypair, { dangerouslyAllowInProduction: true });
    const label = config.keyfilePath
      ? `Keyfile (${config.keyfilePath.split("/").pop()})`
      : "Keyfile (uploaded)";

    return {
      signer,
      address: keypair.publicKey.toBase58(),
      sourceLabel: label,
      sourceType: "keyfile",
      keypairBytes: keypair.secretKey,
    };
  }

  private async resolveTurnkey(config: WalletSourceConfig): Promise<ResolvedWallet> {
    if (!config.turnkey) {
      throw new Error("Turnkey config is required for 'turnkey' source");
    }

    const { apiBaseUrl, apiPublicKey, apiPrivateKey, organizationId, walletAddress } = config.turnkey;

    if (!apiBaseUrl || !apiPublicKey || !apiPrivateKey || !organizationId || !walletAddress) {
      throw new Error(
        "Turnkey source requires all fields: apiBaseUrl, apiPublicKey, apiPrivateKey, organizationId, walletAddress"
      );
    }

    const provider = new TurnkeyProvider({
      apiBaseUrl,
      apiPublicKey,
      apiPrivateKey,
      defaultOrganizationId: organizationId,
      signWith: walletAddress,
    });

    const signer = new MpcSigner({
      provider,
      chain: "solana",
      maxRetries: 3,
      timeoutMs: 30_000,
    });

    const address = await signer.getAddress();

    return {
      signer,
      address,
      sourceLabel: `Turnkey (${address.slice(0, 8)}...)`,
      sourceType: "turnkey",
      keypairBytes: null,
    };
  }
}

// Singleton instance
const REGISTRY_KEY = "__kova_wallet_source_registry__" as const;

export function getWalletSourceRegistry(): WalletSourceRegistry {
  const g = globalThis as unknown as Record<string, WalletSourceRegistry>;
  if (!g[REGISTRY_KEY]) {
    g[REGISTRY_KEY] = new WalletSourceRegistry();
  }
  return g[REGISTRY_KEY];
}
