/**
 * Consensus Oracle — aggregates multiple price providers for resilience and manipulation resistance.
 *
 * Strategies:
 * - "median": Fetches from all providers in parallel, returns the median price.
 *   Best for production — resistant to single-source manipulation.
 * - "first-success": Tries providers in order, returns the first non-null result.
 *   Best for fallback chains (e.g., Pyth → Jupiter).
 */

export type PriceProviderFn = (token: string) => Promise<number | null>;

export interface ConsensusProviderConfig {
  /** Aggregation strategy (default: "median") */
  strategy?: "median" | "first-success";
  /** Minimum number of providers that must return a valid price for median strategy (default: 1) */
  minProviders?: number;
}

export interface ConsensusProvider {
  /** Get the consensus USD price for a token. Returns null if unavailable. */
  (token: string): Promise<number | null>;
  /** Clean up all underlying providers (if they have destroy methods). */
  destroy: () => void;
}

/**
 * Create a consensus price provider that aggregates multiple oracle sources.
 *
 * @param providers - Array of price provider functions (e.g., Pyth, Jupiter)
 * @param config - Optional configuration for aggregation strategy
 * @returns A price provider function compatible with SolanaAdapterConfig.priceProvider
 *
 * @example
 * ```typescript
 * import { createPythPriceProvider } from "@kova-sdk/wallet/oracles";
 * import { createConsensusProvider } from "@kova-sdk/wallet/oracles";
 *
 * const provider = createConsensusProvider([
 *   createPythPriceProvider(connection),
 *   myJupiterProvider,
 * ], { strategy: "median" });
 *
 * const adapter = new SolanaAdapter({
 *   rpcUrl: "https://api.mainnet-beta.solana.com",
 *   priceProvider: provider,
 * });
 * ```
 */
export function createConsensusProvider(
  providers: PriceProviderFn[],
  config?: ConsensusProviderConfig,
): ConsensusProvider {
  if (providers.length === 0) {
    throw new Error("createConsensusProvider requires at least one provider");
  }

  const strategy = config?.strategy ?? "median";
  const minProviders = config?.minProviders ?? 1;

  const provider = async function consensusProvider(token: string): Promise<number | null> {
    if (strategy === "first-success") {
      for (const p of providers) {
        try {
          const price = await p(token);
          if (price !== null && Number.isFinite(price) && price > 0) {
            return price;
          }
        } catch {
          continue;
        }
      }
      return null;
    }

    // Median strategy: fetch all in parallel
    const results = await Promise.allSettled(providers.map((p) => p(token)));
    const prices = results
      .filter((r): r is PromiseFulfilledResult<number | null> => r.status === "fulfilled")
      .map((r) => r.value)
      .filter((v): v is number => v !== null && Number.isFinite(v) && v > 0);

    if (prices.length < minProviders) {
      return null;
    }

    return median(prices);
  } as ConsensusProvider;

  provider.destroy = () => {
    for (const p of providers) {
      if (typeof (p as PriceProviderFn & { destroy?: () => void }).destroy === "function") {
        (p as PriceProviderFn & { destroy: () => void }).destroy();
      }
    }
  };

  return provider;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}
