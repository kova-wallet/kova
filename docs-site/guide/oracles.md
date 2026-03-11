# Price Oracles

::: info What you'll learn
- How price oracles feed into the SDK's spending limits and approval gates
- How to configure the Pyth oracle for on-chain price feeds
- How to set up multi-oracle consensus for production deployments
- Staleness, confidence, and caching behavior
:::

Price oracles provide real-time USD valuations that the SDK uses for **USD-denominated spending limits** and **approval gates**. Without a price oracle, the SDK cannot enforce limits like "max $500/day" — it can only enforce token-specific limits like "max 5 SOL/day."

## How Oracles Fit Into the SDK

The `SolanaAdapter` accepts an optional `priceProvider` function that returns the USD price for any token. This function is called by `getValueInUSD()`, which the policy engine uses to evaluate USD-denominated rules.

```
priceProvider(token) → price per token in USD
    ↓
getValueInUSD(token, amount) → amount × price
    ↓
PolicyEngine evaluates:
    ├── SpendingLimitRule (perTransactionUSD, dailyUSD, weeklyUSD, monthlyUSD)
    └── ApprovalGateRule (aboveUSD)
```

If no `priceProvider` is configured and a policy uses USD limits, the SDK **fails closed** — transactions are denied with a `PRICE_UNAVAILABLE` error.

## Pyth Oracle

[Pyth Network](https://pyth.network) provides on-chain price feeds on Solana. The SDK includes a built-in Pyth price provider that reads price data directly from Solana accounts — no external HTTP APIs needed.

### Setup

```typescript
import { Connection } from "@solana/web3.js";
import { SolanaAdapter, createPythPriceProvider } from "@kova/wallet";

// Reuse the same RPC connection — no additional infrastructure needed
const connection = new Connection("https://api.mainnet-beta.solana.com");

const adapter = new SolanaAdapter({
  rpcUrl: "https://api.mainnet-beta.solana.com",
  priceProvider: createPythPriceProvider(connection),
});
```

That's it. The spending limits and approval gates now use Pyth for USD valuation.

::: tip WHAT IS PYTH?
Pyth Network is a decentralized oracle that publishes real-time price data on-chain. Unlike centralized APIs, Pyth prices are written to Solana accounts by a network of data providers (exchanges, market makers). The SDK reads these accounts via the same RPC connection you already use — no API keys, no external services, no cost beyond standard RPC calls.
:::

### Configuration

```typescript
import { createPythPriceProvider } from "@kova/wallet";

const provider = createPythPriceProvider(connection, {
  // Maximum age of a price before it's considered stale.
  // If a Pyth feed hasn't been updated in this many seconds, the price
  // is rejected and the provider returns null (fail-closed).
  maxStalenessSeconds: 30,       // default: 30

  // Maximum confidence interval as a ratio of the price.
  // Pyth provides a confidence interval (±) with each price. If confidence
  // is too wide relative to the price, the data is unreliable.
  // 0.02 = 2%: reject if confidence > 2% of price.
  maxConfidencePercent: 0.02,    // default: 0.02

  // How long to cache a price in memory before re-fetching from RPC.
  // Reduces RPC load. Must be shorter than maxStalenessSeconds.
  cacheTtlMs: 5000,             // default: 5000 (5 seconds)

  // Network selection. Pyth has different feed addresses on devnet vs mainnet.
  network: "mainnet-beta",      // default: "mainnet-beta"

  // Add custom token feeds (token mint address → Pyth feed address).
  // Merged with the built-in feeds for SOL, USDC, and USDT.
  feedMap: {
    "BonkMint111111111111111111111111111111111": "BonkFeed11111111111111111111111111111111",
  },
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxStalenessSeconds` | `number` | `30` | Reject prices older than this |
| `maxConfidencePercent` | `number` | `0.02` | Reject if confidence > this ratio of price |
| `cacheTtlMs` | `number` | `5000` | In-memory cache TTL |
| `network` | `"mainnet-beta" \| "devnet"` | `"mainnet-beta"` | Pyth feed addresses vary by network |
| `feedMap` | `Record<string, string>` | Built-in SOL/USDC/USDT | Custom token mint → Pyth feed mappings |

### Built-in Price Feeds

The provider ships with feed mappings for the most common Solana tokens:

| Token | Network | Feed |
|-------|---------|------|
| SOL/USD | mainnet | `H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG` |
| USDC/USD | mainnet | `Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD` |
| USDT/USD | mainnet | `3vxLXJqLqF3JG5TCbYycbKWRBbCJQLxOmMGCk7AXnkZZ` |
| SOL/USD | devnet | `J83w4HKfqxwcYvy4GcpTFvGLM3jGUxJaeSPhDqoVDhTH` |
| USDC/USD | devnet | `5SSkXsEKQepHHAewytPVwdej4epN1nxgLVM84L4KXgy7` |

For other tokens, add them via the `feedMap` config option. You can find Pyth feed addresses at [pyth.network/price-feeds](https://pyth.network/price-feeds).

### Token Resolution

The price provider accepts both token **symbols** (`"SOL"`, `"USDC"`) and **mint addresses** (`"So11111111111111111111111111111111111111112"`). It resolves symbols to mint addresses using the SDK's built-in token registry, then looks up the Pyth feed for that mint.

### Cleanup

The Pyth provider maintains an in-memory price cache. When you are done with the adapter, call `destroy()` to release resources:

```typescript
const provider = createPythPriceProvider(connection);
// ... use the adapter ...

// Clean up when done
provider.destroy();
```

### Devnet Usage

Pyth has different feed addresses on devnet. Set `network: "devnet"` to use devnet feeds:

```typescript
const provider = createPythPriceProvider(connection, {
  network: "devnet",
});
```

::: warning
Pyth devnet feeds may return stale or zero prices. For devnet testing, you may want to increase `maxStalenessSeconds` or use a mock `priceProvider` instead.
:::

## Multi-Oracle Consensus

For production deployments handling significant value, use `createConsensusProvider` to aggregate multiple oracle sources. This protects against single-source manipulation or downtime.

### Median Strategy

Fetches prices from all providers in parallel and returns the **median** — resistant to any single oracle being compromised:

```typescript
import { createPythPriceProvider, createConsensusProvider } from "@kova/wallet";

const provider = createConsensusProvider([
  createPythPriceProvider(connection),
  myJupiterProvider,          // your own Jupiter API wrapper
  myCoinGeckoProvider,        // your own CoinGecko API wrapper
], {
  strategy: "median",         // default
  minProviders: 2,            // require at least 2 oracles to agree
});

const adapter = new SolanaAdapter({
  rpcUrl: "https://api.mainnet-beta.solana.com",
  priceProvider: provider,
});
```

If fewer than `minProviders` return a valid price, the consensus provider returns `null` — triggering the SDK's fail-closed behavior (transaction denied).

### First-Success Strategy

Tries providers in order and returns the first non-null result — useful for fallback chains:

```typescript
const provider = createConsensusProvider([
  createPythPriceProvider(connection),   // Primary: Pyth on-chain
  myJupiterProvider,                     // Fallback: Jupiter API
], {
  strategy: "first-success",
});
```

### Cleanup

The consensus provider's `destroy()` method calls `destroy()` on all underlying providers that support it:

```typescript
provider.destroy(); // cleans up Pyth cache + any other provider resources
```

## Writing a Custom Price Provider

Any function matching `(token: string) => Promise<number | null>` works as a `priceProvider`. Return `null` when the price is unavailable — the SDK will fail closed.

```typescript
// Example: simple hardcoded provider for testing
const testProvider = async (token: string): Promise<number | null> => {
  const prices: Record<string, number> = {
    SOL: 150,
    USDC: 1,
    USDT: 1,
  };
  return prices[token.toUpperCase()] ?? null;
};

const adapter = new SolanaAdapter({
  rpcUrl: "https://api.devnet.solana.com",
  priceProvider: testProvider,
});
```

## Security Considerations

1. **Fail-closed**: If the oracle returns `null` or throws, the adapter throws `PRICE_UNAVAILABLE` and the spending limit rule denies the transaction.
2. **Staleness protection**: The Pyth provider rejects prices older than `maxStalenessSeconds` to prevent acting on outdated data.
3. **Confidence filtering**: Prices with wide confidence intervals (high uncertainty) are rejected.
4. **No external HTTP**: The Pyth provider reads from on-chain Solana accounts via the existing RPC connection — no new network surface.
5. **Cache consistency**: The default 5s cache TTL ensures that both phases of the SDK's two-phase policy evaluation (dry-run + commit) see the same price.

## Cost

| Component | Cost |
|-----------|------|
| Pyth on-chain price reads | Free (standard RPC `getAccountInfo` call) |
| `@pythnetwork/client` dependency | Not required — the SDK parses Pyth data directly |
| RPC calls | 1 `getAccountInfo` per token per 5s (cached) |

## See Also

- [Chain Adapters](/guide/chain-adapters) — where `priceProvider` is configured
- [Spending Limits](/guide/rules/spending-limit) — USD limits that consume oracle prices
- [Approval Gate](/guide/rules/approval-gate) — USD thresholds that consume oracle prices
- [Security](/guide/security) — the SDK's fail-closed security model
