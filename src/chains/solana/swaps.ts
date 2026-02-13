/**
 * Solana swap operations — Jupiter V6 integration.
 *
 * Flow: GET /quote → POST /swap → decode VersionedTransaction → return as UnsignedTransaction.
 * The LocalSigner handles VersionedTransaction natively.
 */

import { VersionedTransaction, type Connection } from "@solana/web3.js";
import type { SwapParams } from "../../core/intent.js";
import type { UnsignedTransaction } from "../../signers/interface.js";
import {
  resolveTokenMint,
  getTokenDecimals,
  toSmallestUnit,
  SolanaAdapterError,
} from "./utils.js";

const DEFAULT_JUPITER_API = "https://quote-api.jup.ag/v6";
const DEFAULT_JUPITER_PRICE_API = "https://price.jup.ag/v2";
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

/** Wrapped SOL mint address used by Jupiter */
const SOL_MINT = "So11111111111111111111111111111111111111112";

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  routePlan: unknown[];
}

interface JupiterSwapResponse {
  swapTransaction: string; // base64-encoded VersionedTransaction
  lastValidBlockHeight: number;
}

/**
 * Build a Jupiter swap transaction.
 * 1. GET /quote to get a route
 * 2. POST /swap to get a serialized VersionedTransaction
 * 3. Return as UnsignedTransaction (the LocalSigner handles VersionedTransaction natively)
 */
export async function buildJupiterSwap(
  _connection: Connection,
  params: SwapParams,
  signerAddress: string,
  jupiterApiUrl: string = DEFAULT_JUPITER_API,
  isDevnet: boolean = false,
): Promise<UnsignedTransaction> {
  // Resolve token symbols to mint addresses
  const inputMint =
    resolveTokenMint(params.fromToken, isDevnet)?.toBase58() ??
    (params.fromToken.toUpperCase() === "SOL"
      ? SOL_MINT
      : params.fromToken);
  const outputMint =
    resolveTokenMint(params.toToken, isDevnet)?.toBase58() ??
    (params.toToken.toUpperCase() === "SOL" ? SOL_MINT : params.toToken);

  // Calculate input amount in smallest unit
  const fromDecimals = getTokenDecimals(params.fromToken, isDevnet);
  if (fromDecimals === null) {
    throw new SolanaAdapterError(
      "UNKNOWN_DECIMALS",
      `Cannot determine decimals for ${params.fromToken}. Use a known token symbol or provide decimals.`,
    );
  }
  const amountIn = toSmallestUnit(params.amount, fromDecimals);

  // Convert slippage from decimal (0.01 = 1%) to basis points (100 bps)
  const slippageBps = Math.floor((params.maxSlippage ?? 0.005) * 10_000);

  // Step 1: Get quote from Jupiter
  const quoteUrl = new URL(`${jupiterApiUrl}/quote`);
  quoteUrl.searchParams.set("inputMint", inputMint);
  quoteUrl.searchParams.set("outputMint", outputMint);
  quoteUrl.searchParams.set("amount", amountIn.toString());
  quoteUrl.searchParams.set("slippageBps", String(slippageBps));

  const quoteResponse = await fetchWithTimeout(quoteUrl.toString());
  if (!quoteResponse.ok) {
    const body = (await quoteResponse.text()).slice(0, 200);
    throw new SolanaAdapterError(
      "JUPITER_QUOTE_FAILED",
      `Jupiter quote failed (${quoteResponse.status}): ${body}`,
    );
  }
  const quote: JupiterQuote = (await quoteResponse.json()) as JupiterQuote;

  // Step 2: Get swap transaction from Jupiter
  const swapResponse = await fetchWithTimeout(`${jupiterApiUrl}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: signerAddress,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });

  if (!swapResponse.ok) {
    const body = (await swapResponse.text()).slice(0, 200);
    throw new SolanaAdapterError(
      "JUPITER_SWAP_FAILED",
      `Jupiter swap failed (${swapResponse.status}): ${body}`,
    );
  }

  const swapData: JupiterSwapResponse =
    (await swapResponse.json()) as JupiterSwapResponse;

  // Decode the base64 transaction — Jupiter returns a VersionedTransaction
  const swapTransactionBuf = Buffer.from(
    swapData.swapTransaction,
    "base64",
  );

  // Verify it deserializes correctly before returning
  try {
    VersionedTransaction.deserialize(new Uint8Array(swapTransactionBuf));
  } catch (e) {
    throw new SolanaAdapterError(
      "JUPITER_DESERIALIZE_FAILED",
      `Failed to deserialize Jupiter swap transaction: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return {
    chain: "solana",
    data: new Uint8Array(swapTransactionBuf),
    description: `Swap ${params.amount} ${params.fromToken} for ${params.toToken} via Jupiter`,
  };
}

/**
 * Get the USD price of a token via Jupiter Price API v2.
 * Returns null if the token is unknown or the API is unreachable.
 */
export async function getTokenPriceUSD(
  token: string,
  priceApiUrl: string = DEFAULT_JUPITER_PRICE_API,
  isDevnet: boolean = false,
): Promise<number | null> {
  const mint = resolveTokenMint(token, isDevnet)?.toBase58();
  if (!mint) return null;

  const url = new URL(`${priceApiUrl}/price`);
  url.searchParams.set("ids", mint);

  try {
    const response = await fetchWithTimeout(url.toString());
    if (!response.ok) return null;

    const data = (await response.json()) as {
      data?: Record<string, { price?: number }>;
    };
    const priceData = data?.data?.[mint];
    return priceData?.price ?? null;
  } catch {
    return null;
  }
}
