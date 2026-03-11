# Pyth Oracle Integration Plan

## Where the Oracle Will Be Used

### Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│  1. USER configures SolanaAdapter with a priceProvider          │
│     ┌──────────────────────────────────────────────────┐        │
│     │ new SolanaAdapter({                              │        │
│     │   rpcUrl: "...",                                 │        │
│     │   priceProvider: createPythPriceProvider(conn)    │        │
│     │ })                                               │        │
│     └──────────────────────────────────────────────────┘        │
│                                                                 │
│  2. WALLET calls adapter.getValueInUSD(token, amount)           │
│     at src/chains/solana/adapter.ts:635                         │
│     → calls priceProvider(token) → returns price per token      │
│     → returns amount × price                                    │
│                                                                 │
│  3. POLICY ENGINE receives getValueInUSD as a callback          │
│     at src/policy/types.ts:47 (PolicyContext.getValueInUSD)     │
│     │                                                           │
│     ├──→ 4a. SPENDING LIMIT RULE                                │
│     │    Uses USD price to enforce:                              │
│     │    • perTransactionUSD (e.g., max $500/tx)                │
│     │    • dailyUSD (e.g., max $5,000/day)                      │
│     │    • weeklyUSD / monthlyUSD                               │
│     │    Prevents cross-token evasion (swap SOL→USDC to dodge)  │
│     │                                                           │
│     └──→ 4b. APPROVAL GATE RULE                                 │
│          Uses USD price to trigger human approval:              │
│          • aboveUSD (e.g., require approval if > $1,000)        │
│          • Shows usdValue in the approval request               │
└─────────────────────────────────────────────────────────────────┘
```

### Integration Point

The adapter already has a pluggable `priceProvider` at `src/chains/solana/adapter.ts:73`:

```typescript
priceProvider?: (token: string) => Promise<number | null>;
```

No core SDK code needs to be modified. We just need to create a Pyth-backed function that matches this signature.

## Implementation Steps

### Step 1: Create `src/oracles/pyth.ts`

A factory function that returns a `priceProvider`-compatible function:

```typescript
import { Connection, PublicKey } from "@solana/web3.js";

// Maps Solana token mint → Pyth price feed account
const PYTH_FEED_MAP: Record<string, string> = {
  "So11111111111111111111111111111111111111112": "H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG",   // SOL/USD
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD", // USDC/USD
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": "3vxLXJqLqF3JG5TCbYycbKWRBbCJQLxOmMGCk7AXnkZZ",  // USDT/USD
};

interface PythPriceProviderConfig {
  /** Custom feed map (token mint → Pyth feed address) */
  feedMap?: Record<string, string>;
  /** Maximum age in seconds before price is considered stale (default: 30) */
  maxStalenessSeconds?: number;
  /** Maximum confidence interval as a percentage of price (default: 0.02 = 2%) */
  maxConfidencePercent?: number;
  /** Cache TTL in milliseconds (default: 5000) */
  cacheTtlMs?: number;
}

export function createPythPriceProvider(
  connection: Connection,
  config?: PythPriceProviderConfig,
): (token: string) => Promise<number | null> {
  const feedMap = { ...PYTH_FEED_MAP, ...config?.feedMap };
  const maxStaleness = config?.maxStalenessSeconds ?? 30;
  const maxConfidence = config?.maxConfidencePercent ?? 0.02;
  const cacheTtl = config?.cacheTtlMs ?? 5000;

  // In-memory price cache
  const cache = new Map<string, { price: number; fetchedAt: number }>();

  return async (token: string): Promise<number | null> => {
    // Check cache first
    const cached = cache.get(token);
    if (cached && Date.now() - cached.fetchedAt < cacheTtl) {
      return cached.price;
    }

    // Look up the Pyth feed address for this token
    const feedAddress = feedMap[token];
    if (!feedAddress) {
      return null; // No feed configured for this token
    }

    try {
      // Fetch the Pyth price account data from on-chain
      const accountInfo = await connection.getAccountInfo(new PublicKey(feedAddress));
      if (!accountInfo?.data) {
        return null;
      }

      // Deserialize Pyth price account data
      // (Uses Pyth's on-chain data layout — see Pyth SDK for struct format)
      const priceData = parsePythPriceAccount(accountInfo.data);

      // Validate staleness
      const currentSlot = await connection.getSlot();
      const slotAge = currentSlot - priceData.lastUpdatedSlot;
      // Approximate: ~400ms per slot on Solana
      const ageSeconds = slotAge * 0.4;
      if (ageSeconds > maxStaleness) {
        return null; // Price too stale
      }

      // Validate confidence interval
      if (priceData.confidence / priceData.price > maxConfidence) {
        return null; // Price too uncertain
      }

      // Validate price is positive and finite
      if (!Number.isFinite(priceData.price) || priceData.price <= 0) {
        return null;
      }

      // Cache the result
      cache.set(token, { price: priceData.price, fetchedAt: Date.now() });

      return priceData.price;
    } catch {
      return null; // Fail-closed: return null on any error
    }
  };
}
```

### Step 2: Wire into SolanaAdapter (zero SDK changes)

```typescript
import { Connection } from "@solana/web3.js";
import { SolanaAdapter } from "kova-wallet";
import { createPythPriceProvider } from "kova-wallet/oracles/pyth";

const connection = new Connection("https://api.mainnet-beta.solana.com");

const adapter = new SolanaAdapter({
  rpcUrl: "https://api.mainnet-beta.solana.com",
  priceProvider: createPythPriceProvider(connection),
});
```

The spending limits and approval gates use it automatically — no further wiring needed.

### Step 3 (Optional): Multi-Oracle Consensus

```typescript
// src/oracles/consensus.ts

export function createConsensusProvider(
  providers: Array<(token: string) => Promise<number | null>>,
  strategy: "median" | "first-success" = "median",
): (token: string) => Promise<number | null> {
  return async (token: string): Promise<number | null> => {
    if (strategy === "first-success") {
      for (const provider of providers) {
        try {
          const price = await provider(token);
          if (price !== null) return price;
        } catch {
          continue;
        }
      }
      return null;
    }

    // Median strategy
    const results = await Promise.allSettled(providers.map((p) => p(token)));
    const prices = results
      .filter((r): r is PromiseFulfilledResult<number | null> => r.status === "fulfilled")
      .map((r) => r.value)
      .filter((v): v is number => v !== null && v > 0);

    if (prices.length === 0) return null;

    prices.sort((a, b) => a - b);
    const mid = Math.floor(prices.length / 2);
    return prices.length % 2 === 0
      ? (prices[mid - 1]! + prices[mid]!) / 2
      : prices[mid]!;
  };
}
```

Usage:

```typescript
import { createPythPriceProvider } from "kova-wallet/oracles/pyth";
import { createConsensusProvider } from "kova-wallet/oracles/consensus";

const priceProvider = createConsensusProvider([
  createPythPriceProvider(connection),
  jupiterPriceProvider,  // existing Jupiter as fallback
], "median");

const adapter = new SolanaAdapter({
  rpcUrl: "https://api.mainnet-beta.solana.com",
  priceProvider,
});
```

### Step 4: Tests

- Unit test `createPythPriceProvider` with mocked `connection.getAccountInfo`
- Test staleness rejection (old `lastUpdatedSlot`)
- Test confidence interval filtering (reject wide spreads)
- Test null return when feed is unavailable
- Test cache behavior (returns cached price within TTL, re-fetches after TTL)
- Integration test with spending limit rule using Pyth prices
- Test consensus provider with mixed oracle results

### Step 5: Export from package

Add to `src/index.ts`:

```typescript
export { createPythPriceProvider } from "./oracles/pyth.js";
export { createConsensusProvider } from "./oracles/consensus.js";
```

## Files to Create

| File | Purpose |
|------|---------|
| `src/oracles/pyth.ts` | Pyth price provider factory |
| `src/oracles/consensus.ts` | Multi-oracle consensus (optional) |
| `src/oracles/index.ts` | Barrel export |
| `tests/unit/oracles/pyth.test.ts` | Unit tests |
| `tests/unit/oracles/consensus.test.ts` | Consensus tests |

## Files to Modify

| File | Change |
|------|--------|
| `src/index.ts` | Add oracle exports |
| `package.json` | Add `@pythnetwork/client` as optional peer dep (if using their SDK) |

## Files That Need No Changes

| File | Why |
|------|-----|
| `src/core/wallet.ts` | Already passes `getValueInUSD` to policy context |
| `src/policy/rules/spending-limit.ts` | Already consumes USD prices |
| `src/policy/rules/approval-gate.ts` | Already consumes USD prices |
| `src/chains/interface.ts` | `getValueInUSD` already defined |
| `src/chains/solana/adapter.ts` | `priceProvider` hook already exists |
| `src/policy/types.ts` | `PolicyContext.getValueInUSD` already exists |

## Security Considerations

1. **Fail-closed**: Returns `null` on any error → spending limits DENY the transaction
2. **Staleness check**: Rejects prices older than 30s (configurable)
3. **Confidence interval**: Rejects prices with >2% uncertainty (configurable)
4. **Cache TTL**: 5s default to reduce RPC load without stale data risk
5. **No new RPC endpoint**: Uses the same `Connection` already configured
6. **SSRF protection**: N/A — reads from on-chain accounts, not external HTTP APIs

## Gaps & Missing Items

### 1. Token Input Format Mismatch

The `priceProvider` receives the `token` parameter as-is from `getValueInUSD(token, amount)`. In the SDK, `token` can be either:
- A **mint address** (e.g., `"So11111111111111111111111111111111111111112"`)
- A **symbol** (e.g., `"SOL"`)

The Pyth feed map keys use mint addresses, but the adapter's `getBalance()` calls `priceProvider("SOL")` with the **symbol** (see `adapter.ts:565`). The Pyth provider must handle **both** formats — resolve symbols to mints using the SDK's existing `resolveTokenMint()` from `src/chains/solana/utils.ts`, then look up the feed.

### 2. Missing `parsePythPriceAccount()` Implementation

The plan references `parsePythPriceAccount()` but doesn't implement it. You need to either:
- **Option A**: Write a manual deserializer for Pyth's on-chain price account struct (binary layout: magic, version, type, size, price, confidence, exponent, etc.)
- **Option B**: Use `@pythnetwork/client` which provides `parsePriceData()`

Option A avoids a dependency but requires maintaining compatibility with Pyth's data layout. Option B is safer but adds a peer dependency.

### 3. Two-Phase Evaluation: Price Fetched Twice

The SDK's policy engine uses two-phase evaluation (dry-run then commit). `getValueInUSD` is called in **both phases**. The 5s cache handles this fine (same price for both phases), but the plan should note this explicitly — if cache TTL is too short, phase 1 and phase 2 could get different prices, causing inconsistent decisions.

### 4. `getSlot()` Adds a Second RPC Call

The staleness check calls `connection.getSlot()` on every price fetch, doubling the RPC cost. Consider:
- Caching the slot number with a short TTL (e.g., 2s)
- Or using Pyth's `publishTime` (Unix timestamp) instead of slot-based staleness, which avoids the extra RPC call entirely

### 5. Devnet Pyth Feed Addresses

The `PYTH_FEED_MAP` only has mainnet feed addresses. Pyth has different program IDs and feed addresses on devnet. The provider needs a `network` parameter (or detect from the `Connection`) to use the correct feeds. Without this, devnet testing won't work.

### 6. `destroy()` / Cleanup

The `SolanaAdapter` has an optional `destroy()` method for resource cleanup. The Pyth provider holds a cache `Map` in closure — if the adapter is destroyed and recreated, the old cache remains in memory. Consider exposing a `destroy()` hook on the provider, or documenting that the provider should be recreated with the adapter.

### 7. Audit Logging

The SDK has comprehensive audit logging (`src/logging/audit.ts`). Price decisions (which oracle was used, what price was returned, whether it was cached) are currently not logged. Consider adding optional logging callbacks to the Pyth provider so price sources appear in the audit trail — especially important for the consensus provider where knowing *which* oracles agreed matters.

### 8. `package.json` Exports Map

The SDK uses `package.json` exports to define entry points. Adding `kova-wallet/oracles/pyth` as an import path (shown in Step 2) requires adding it to the `exports` field in `package.json`, not just `src/index.ts`. Otherwise the import path won't resolve for consumers.

## Cost

- **Pyth price feeds**: Free to read on-chain
- **RPC calls**: 1-2 extra RPC calls per price lookup (cached for 5s) — `getAccountInfo` + optionally `getSlot`
- **Dependencies**: Zero required if manually parsing Pyth data; `@pythnetwork/client` as optional peer dep if using their SDK
