/**
 * SolanaAdapter — Chain adapter for Solana.
 *
 * Sprint 3: Real RPC integration via @solana/web3.js.
 * Delegates to transfers.ts, swaps.ts, and utils.ts for specific operations.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { ChainAdapter, TransactionStatusResult } from "../interface.js";
import type { TransactionIntent } from "../../core/intent.js";
import type { UnsignedTransaction } from "../../signers/interface.js";
import type { TokenBalance } from "../../core/result.js";
import { isTransferIntent, isSwapIntent } from "../../core/intent.js";
import { buildSOLTransfer, buildSPLTransfer } from "./transfers.js";
import { buildJupiterSwap, getTokenPriceUSD } from "./swaps.js";
import {
  isNativeSOL,
  isValidSolanaAddress,
  resolveTokenMint,
  getTokenDecimals,
  fromSmallestUnit,
  SolanaAdapterError,
  isDevnetUrl,
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

export class SolanaAdapter implements ChainAdapter {
  readonly chain = "solana";
  private readonly connection: Connection;
  private readonly config: SolanaAdapterConfig;
  private readonly isDevnet: boolean;

  constructor(config: SolanaAdapterConfig) {
    // HIGH-07/08 fix: Validate all URLs before using them
    validateRpcUrl(config.rpcUrl, "RPC");
    if (config.jupiterApiUrl) validateRpcUrl(config.jupiterApiUrl, "Jupiter API");
    if (config.jupiterPriceApiUrl) validateRpcUrl(config.jupiterPriceApiUrl, "Jupiter Price API");

    this.config = config;
    this.connection = new Connection(
      config.rpcUrl,
      config.commitment ?? "confirmed",
    );
    this.isDevnet = isDevnetUrl(config.rpcUrl);
  }

  /**
   * Get the wallet's balance for a specific token.
   * SOL: queries native lamport balance via getBalance().
   * SPL: looks up the Associated Token Account.
   */
  async getBalance(address: string, token: string): Promise<TokenBalance> {
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

      let usdValue: number | undefined;
      try {
        const price = await getTokenPriceUSD(
          "SOL",
          this.config.jupiterPriceApiUrl,
          this.isDevnet,
        );
        if (price !== null) {
          usdValue = parseFloat(amount) * price;
        }
      } catch {
        // Price fetch failure is non-fatal
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
        );
        if (price !== null) {
          usdValue = parseFloat(amount) * price;
        }
      } catch {
        /* non-fatal */
      }

      return { token, amount, decimals, usdValue };
    } catch {
      // ATA doesn't exist — balance is zero
      return { token, amount: "0", decimals, usdValue: 0 };
    }
  }

  /**
   * Get the USD value of a token amount via Jupiter Price API.
   * Falls back to $1 for stablecoins. Throws for unknown tokens (fail-closed).
   */
  async getValueInUSD(token: string, amount: string): Promise<number> {
    const price = await getTokenPriceUSD(
      token,
      this.config.jupiterPriceApiUrl,
      this.isDevnet,
    );

    if (price === null) {
      // Fail-closed: for stablecoins, assume $1; otherwise throw
      const upper = token.toUpperCase();
      if (upper === "USDC" || upper === "USDT") {
        return parseFloat(amount);
      }
      throw new SolanaAdapterError(
        "PRICE_UNAVAILABLE",
        `Cannot determine USD price for ${token}. Price oracle unavailable.`,
      );
    }

    return parseFloat(amount) * price;
  }

  /**
   * Build an unsigned transaction from a TransactionIntent.
   * Dispatches to the appropriate builder based on intent type.
   */
  async buildTransaction(
    intent: TransactionIntent,
    signerAddress: string,
  ): Promise<UnsignedTransaction> {
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
      );
    }

    throw new SolanaAdapterError(
      "UNSUPPORTED_INTENT",
      `Intent type "${intent.type}" is not yet supported on Solana. Supported: transfer, swap.`,
    );
  }

  /**
   * Broadcast a signed transaction to the Solana network.
   * Waits for confirmation before returning.
   */
  async broadcast(signedTxData: Uint8Array): Promise<string> {
    try {
      const txId = await this.connection.sendRawTransaction(signedTxData, {
        skipPreflight: false,
        preflightCommitment: this.config.commitment ?? "confirmed",
        maxRetries: 3,
      });

      // Wait for confirmation
      const { blockhash, lastValidBlockHeight } =
        await this.connection.getLatestBlockhash();
      await this.connection.confirmTransaction(
        { signature: txId, blockhash, lastValidBlockHeight },
        this.config.commitment ?? "confirmed",
      );

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
   */
  async getTransactionStatus(txId: string): Promise<TransactionStatusResult> {
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

      return { status: "confirmed", txId };
    } catch (err) {
      throw new SolanaAdapterError(
        "STATUS_CHECK_FAILED",
        `Failed to check transaction status: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Validate a Solana address using PublicKey parsing.
   */
  isValidAddress(address: string): boolean {
    return isValidSolanaAddress(address);
  }
}
