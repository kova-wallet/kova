# Chain Adapters

Chain adapters encapsulate all blockchain-specific logic: building transactions, broadcasting, checking balances, and validating addresses. The SDK interacts with blockchains exclusively through the `ChainAdapter` interface.

## ChainAdapter Interface

```typescript
import type { ChainAdapter, TransactionStatusResult, ChainTransactionStatus } from "kova";
```

```typescript
interface ChainAdapter {
  /** Chain identifier (e.g., "solana", "ethereum") */
  readonly chain: string;

  /** Get the wallet's balance for a specific token */
  getBalance(address: string, token: string): Promise<TokenBalance>;

  /** Get the current USD value of a token amount (for policy evaluation) */
  getValueInUSD(token: string, amount: string): Promise<number>;

  /** Build an unsigned transaction from a TransactionIntent */
  buildTransaction(
    intent: TransactionIntent,
    signerAddress: string,
  ): Promise<UnsignedTransaction>;

  /** Broadcast a signed transaction to the network. Returns the transaction ID. */
  broadcast(signedTxData: Uint8Array): Promise<string>;

  /** Get the status of a previously submitted transaction */
  getTransactionStatus(txId: string): Promise<TransactionStatusResult>;

  /** Validate an address for this chain */
  isValidAddress(address: string): boolean;
}
```

### TransactionStatusResult

```typescript
type ChainTransactionStatus = "confirmed" | "finalized" | "failed" | "not_found";

interface TransactionStatusResult {
  status: ChainTransactionStatus;
  txId: string;
  blockTime?: number;
  fee?: number;
  error?: string;
}
```

## SolanaAdapter

The `SolanaAdapter` is the production chain adapter for Solana. It uses `@solana/web3.js` for RPC communication and the Jupiter API for token swaps and USD price lookups.

```typescript
import { SolanaAdapter } from "kova";
```

### Configuration

```typescript
const chain = new SolanaAdapter({
  rpcUrl: "https://api.devnet.solana.com",
  commitment: "confirmed",
  jupiterApiUrl: "https://quote-api.jup.ag/v6",
  jupiterPriceApiUrl: "https://price.jup.ag/v6",
});
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `rpcUrl` | `string` | Yes | -- | Solana RPC endpoint URL |
| `commitment` | `"processed" \| "confirmed" \| "finalized"` | No | `"confirmed"` | Transaction confirmation level |
| `jupiterApiUrl` | `string` | No | Jupiter default | Jupiter Quote API endpoint for swaps |
| `jupiterPriceApiUrl` | `string` | No | Jupiter default | Jupiter Price API endpoint for USD valuation |

### Supported Operations

| Operation | Intent Type | Status |
|-----------|-------------|--------|
| SOL transfers | `transfer` (token: `"SOL"`) | Fully implemented |
| SPL token transfers | `transfer` (token: `"USDC"`, `"USDT"`, etc.) | Fully implemented |
| Jupiter swaps | `swap` | Fully implemented |
| NFT minting | `mint` | Not yet implemented |
| Staking | `stake` | Not yet implemented |
| Custom instructions | `custom` | Not yet implemented |

### getBalance

Get the wallet's balance for a specific token. For native SOL, queries the lamport balance via `getBalance()`. For SPL tokens, looks up the Associated Token Account.

```typescript
const chain = new SolanaAdapter({ rpcUrl: "https://api.devnet.solana.com" });

// Native SOL balance
const solBalance = await chain.getBalance(
  "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  "SOL",
);
console.log(`${solBalance.amount} SOL ($${solBalance.usdValue?.toFixed(2)})`);

// SPL token balance (USDC)
const usdcBalance = await chain.getBalance(
  "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  "USDC",
);
console.log(`${usdcBalance.amount} USDC`);
```

::: tip
If the Associated Token Account does not exist (the wallet has never held the token), `getBalance` returns `{ amount: "0", decimals: 6, usdValue: 0 }` instead of throwing.
:::

### buildTransaction

Build an unsigned transaction from a `TransactionIntent`. Dispatches to the appropriate builder based on intent type.

```typescript
const unsignedTx = await chain.buildTransaction(
  {
    type: "transfer",
    chain: "solana",
    params: { to: "9WzDXwBb...", amount: "1.5", token: "SOL" },
  },
  "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
);
```

### broadcast

Broadcast a signed transaction to the Solana network. Waits for confirmation before returning.

```typescript
const txId = await chain.broadcast(signedTx.data);
console.log("Transaction confirmed:", txId);
```

The broadcast method:
1. Sends the raw transaction with preflight checks enabled
2. Retries up to 3 times on transient failures
3. Waits for confirmation at the configured commitment level

### getTransactionStatus

Check the status of a previously submitted transaction.

```typescript
const status = await chain.getTransactionStatus(txId);
console.log(status.status); // "confirmed" | "finalized" | "failed" | "not_found"
```

### isValidAddress

Validate a Solana address using `PublicKey` parsing.

```typescript
chain.isValidAddress("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"); // true
chain.isValidAddress("not-a-valid-address");                              // false
```

## Jupiter Swap Integration

The `SolanaAdapter` integrates with Jupiter for token swaps. When processing a `swap` intent:

1. **Quote**: Fetches a quote from the Jupiter Quote API with the specified input/output tokens and amount
2. **Route**: Selects the best route based on output amount and slippage tolerance
3. **Transaction**: Gets the swap transaction from Jupiter's swap endpoint
4. **Build**: Returns the versioned transaction as an `UnsignedTransaction`

The `maxSlippage` parameter in `SwapParams` controls the maximum acceptable price impact. If not specified, it defaults to 0.5% (0.005).

```typescript
const result = await wallet.execute({
  type: "swap",
  chain: "solana",
  params: {
    fromToken: "SOL",
    toToken: "USDC",
    amount: "1.0",
    maxSlippage: 0.01, // 1% max slippage
  },
});
```

::: warning
Jupiter swaps produce **versioned transactions** (v0), which require a signer that supports the versioned transaction format. `LocalSigner` handles both formats automatically.
:::

## Manual Transaction Flow

While `AgentWallet.execute()` handles the full pipeline, you can use the chain adapter directly for manual transaction building:

```typescript
import { SolanaAdapter, LocalSigner } from "kova";
import { Keypair } from "@solana/web3.js";

const chain = new SolanaAdapter({
  rpcUrl: "https://api.devnet.solana.com",
  commitment: "confirmed",
});
const keypair = Keypair.generate();
const signer = new LocalSigner(keypair);
const address = await signer.getAddress();

// 1. Check balance
const balance = await chain.getBalance(address, "SOL");
console.log(`Balance: ${balance.amount} SOL`);

// 2. Build unsigned transaction
const unsignedTx = await chain.buildTransaction(
  {
    type: "transfer",
    chain: "solana",
    params: {
      to: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      amount: "0.1",
      token: "SOL",
    },
  },
  address,
);

// 3. Sign
const signedTx = await signer.sign(unsignedTx);

// 4. Broadcast
const txId = await chain.broadcast(signedTx.data);
console.log("Transaction ID:", txId);

// 5. Check status
const status = await chain.getTransactionStatus(txId);
console.log("Status:", status.status);
```

::: warning
When using the chain adapter directly, you bypass the policy engine, audit logging, circuit breaker, and idempotency protections. This is only recommended for debugging and testing.
:::

## URL Validation and SSRF Protection

The `SolanaAdapter` validates all configured URLs at construction time to prevent insecure connections and Server-Side Request Forgery (SSRF) attacks.

### HTTPS Enforcement

All non-localhost URLs must use HTTPS. HTTP is only allowed for `localhost`, `127.0.0.1`, and `::1` (for local development with `solana-test-validator`).

```typescript
// OK: HTTPS
new SolanaAdapter({ rpcUrl: "https://api.devnet.solana.com" });

// OK: HTTP localhost (for local validator)
new SolanaAdapter({ rpcUrl: "http://localhost:8899" });

// REJECTED: HTTP to non-localhost
new SolanaAdapter({ rpcUrl: "http://api.devnet.solana.com" });
// Error: "RPC must use HTTPS for non-localhost URLs"
```

### Private Network Protection

The adapter rejects URLs targeting RFC 1918 private addresses, link-local addresses, and cloud metadata endpoints to prevent SSRF:

```typescript
// REJECTED: Private network addresses
new SolanaAdapter({ rpcUrl: "https://10.0.0.1:8899" });       // RFC 1918
new SolanaAdapter({ rpcUrl: "https://192.168.1.100:8899" });   // RFC 1918
new SolanaAdapter({ rpcUrl: "https://172.16.0.1:8899" });      // RFC 1918
new SolanaAdapter({ rpcUrl: "https://169.254.169.254" });      // Cloud metadata
// Error: "RPC cannot target private/internal network addresses"
```

This validation applies to `rpcUrl`, `jupiterApiUrl`, and `jupiterPriceApiUrl`.

## Devnet vs Mainnet

The `SolanaAdapter` automatically detects devnet URLs and adjusts behavior:

- Token mint addresses differ between devnet and mainnet
- Jupiter pricing may return `null` on devnet (prices are not available for devnet tokens)
- Devnet has more lenient rate limits but transactions may be less reliable

```typescript
// Devnet
const devnet = new SolanaAdapter({ rpcUrl: "https://api.devnet.solana.com" });

// Mainnet
const mainnet = new SolanaAdapter({
  rpcUrl: "https://api.mainnet-beta.solana.com",
  commitment: "finalized",
});
```
