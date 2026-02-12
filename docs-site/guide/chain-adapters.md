# Chain Adapters

A Chain Adapter is the SDK's connection to a specific blockchain -- it translates high-level instructions like "send 1 SOL to Alice" into the low-level operations that the blockchain actually understands.

Chain adapters encapsulate all blockchain-specific logic: building transactions, broadcasting, checking balances, and validating addresses. The SDK interacts with blockchains exclusively through the `ChainAdapter` interface.

## Which Chain Adapter Should I Use?

Currently, the SDK ships with one built-in adapter:

| Blockchain | Adapter | Status |
|---|---|---|
| **Solana** | `SolanaAdapter` | Fully implemented (transfers, swaps) |
| **Ethereum / EVM** | Not yet available | Planned for a future release |
| **Other chains** | Implement `ChainAdapter` yourself | See the interface below |

::: tip
If you are building on Solana, use `SolanaAdapter` -- it handles SOL transfers, SPL token transfers (USDC, USDT, etc.), and Jupiter-powered token swaps out of the box. For other blockchains, implement the `ChainAdapter` interface with your chain's specific SDK.
:::

## How Chain Adapters Work (Plain English)

A chain adapter does four things:

1. **Checks balances**: "How much SOL does this wallet have?"
2. **Builds transactions**: Takes a simple instruction ("send 1 SOL to address X") and constructs the complex, chain-specific data structure the blockchain requires.
3. **Broadcasts transactions**: Sends the signed transaction to the blockchain network and waits for confirmation.
4. **Checks transaction status**: Verifies whether a previously submitted transaction succeeded or failed.

The chain adapter abstracts away all blockchain-specific complexity. The rest of the SDK (wallet, policy engine, rules) does not need to know anything about Solana, Ethereum, or any other chain -- it just talks to the adapter.

::: tip WHAT IS AN RPC ENDPOINT?
An RPC (Remote Procedure Call) endpoint is a URL that lets your application communicate with a blockchain node. Think of it as an API server for the blockchain. When the SDK needs to check a balance or submit a transaction, it sends an HTTP request to this URL. Public endpoints (like `https://api.devnet.solana.com`) are free but rate-limited. For production, you typically use a paid provider (like Helius, QuickNode, or Alchemy) for higher reliability and throughput.
:::

## ChainAdapter Interface

```typescript
// Import the core chain adapter types from kova.
// - ChainAdapter: the interface all blockchain integrations must implement
// - TransactionStatusResult: describes the on-chain status of a submitted transaction
// - ChainTransactionStatus: a union type of possible transaction states
import type { ChainAdapter, TransactionStatusResult, ChainTransactionStatus } from "kova";
```

```typescript
// The ChainAdapter interface abstracts away all blockchain-specific details.
// By coding against this interface, the rest of the SDK (AgentWallet, PolicyEngine)
// is completely blockchain-agnostic -- you can swap Solana for Ethereum (or any
// future chain) without changing the wallet or policy logic.
interface ChainAdapter {
  /** Chain identifier (e.g., "solana", "ethereum") */
  // A readonly string that identifies which blockchain this adapter targets.
  // Used in audit logs, policy rules, and transaction routing.
  readonly chain: string;

  /** Get the wallet's balance for a specific token */
  // Queries the blockchain for the current balance of the given token at the
  // specified address. For Solana, "SOL" queries native lamports; SPL token
  // symbols like "USDC" query the Associated Token Account.
  getBalance(address: string, token: string): Promise<TokenBalance>;

  /** Get the current USD value of a token amount (for policy evaluation) */
  // Converts a token amount to its USD equivalent using a price oracle (e.g., Jupiter).
  // The PolicyEngine calls this to evaluate spending limits denominated in USD.
  getValueInUSD(token: string, amount: string): Promise<number>;

  /** Build an unsigned transaction from a TransactionIntent */
  // Takes a high-level intent (e.g., "transfer 1 SOL to address X") and the
  // signer's address, and constructs the chain-specific transaction bytes.
  // The returned UnsignedTransaction is then passed to the Signer for signing.
  buildTransaction(
    intent: TransactionIntent,
    signerAddress: string,
  ): Promise<UnsignedTransaction>;

  /** Broadcast a signed transaction to the network. Returns the transaction ID. */
  // Submits a fully signed transaction to the blockchain's RPC node.
  // Returns the transaction ID (signature) which can be used to track confirmation.
  broadcast(signedTxData: Uint8Array): Promise<string>;

  /** Get the status of a previously submitted transaction */
  // Polls the blockchain to check whether a transaction has been confirmed,
  // finalized, failed, or is not found. Used by AgentWallet to verify execution.
  getTransactionStatus(txId: string): Promise<TransactionStatusResult>;

  /** Validate an address for this chain */
  // Checks whether a string is a syntactically valid address for this blockchain.
  // For Solana, this verifies that the string is a valid base58-encoded public key.
  // Used by the SDK to catch invalid recipient addresses before building transactions.
  isValidAddress(address: string): boolean;
}
```

### TransactionStatusResult

```typescript
// The possible states of a transaction after submission.
// - "confirmed": The transaction has been confirmed by the cluster (not yet finalized).
// - "finalized": The transaction is finalized and cannot be rolled back.
// - "failed": The transaction was processed but failed (e.g., insufficient funds).
// - "not_found": The transaction ID was not found on-chain (may still be propagating).
type ChainTransactionStatus = "confirmed" | "finalized" | "failed" | "not_found";

// Detailed status information about a submitted transaction.
interface TransactionStatusResult {
  // The current confirmation state of the transaction.
  status: ChainTransactionStatus;
  // The on-chain transaction ID (on Solana, this is the base58-encoded signature).
  txId: string;
  // Unix timestamp (seconds) of the block that included this transaction.
  // Undefined if the transaction hasn't been included in a block yet.
  blockTime?: number;
  // The transaction fee paid (in the chain's native unit, e.g., lamports for Solana).
  fee?: number;
  // Human-readable error message if the transaction failed.
  error?: string;
}
```

::: tip WHAT IS TRANSACTION CONFIRMATION?
When you submit a transaction to a blockchain, it does not execute instantly. It goes through stages of confirmation:
- **confirmed**: A supermajority of validators (blockchain nodes) have acknowledged the transaction. It is very likely to succeed but could theoretically be rolled back.
- **finalized**: The transaction is permanently recorded and can never be reversed. This is the strongest guarantee.
- **failed**: The transaction was processed but something went wrong (e.g., insufficient funds, invalid instruction).
- **not_found**: The blockchain has not seen this transaction yet -- it may still be propagating through the network.

For most use cases, "confirmed" is sufficient. Use "finalized" when irreversibility is critical (e.g., high-value transfers).
:::

## SolanaAdapter

The `SolanaAdapter` is the production chain adapter for Solana. It uses `@solana/web3.js` for RPC communication and the Jupiter API for token swaps and USD price lookups.

```typescript
// Import the SolanaAdapter, which is the built-in ChainAdapter implementation for Solana.
// This is the only chain adapter currently shipped with kova.
import { SolanaAdapter } from "kova";
```

::: tip WHAT IS SOLANA?
Solana is a high-performance blockchain known for fast transactions (sub-second finality) and low fees (typically under $0.01 per transaction). Its native currency is SOL. The Solana ecosystem includes popular tokens like USDC (a stablecoin pegged to the US dollar) and a large DeFi (decentralized finance) ecosystem. The Kova SDK currently supports Solana as its primary chain.
:::

### Configuration

```typescript
// Create a SolanaAdapter with full configuration.
const chain = new SolanaAdapter({
  // The Solana RPC endpoint URL. This is the JSON-RPC server the adapter
  // uses for all on-chain queries (getBalance, getTransaction) and submissions.
  // Use devnet for testing, mainnet-beta for production.
  rpcUrl: "https://api.devnet.solana.com",
  // The commitment level for transaction confirmation.
  // "processed" = optimistic (fastest, least safe),
  // "confirmed" = supermajority voted (good default),
  // "finalized" = rooted and irreversible (safest, slowest).
  commitment: "confirmed",
  // The Jupiter Quote API endpoint for fetching swap quotes and routes.
  // Jupiter is the leading DEX aggregator on Solana.
  jupiterApiUrl: "https://quote-api.jup.ag/v6",
  // The Jupiter Price API endpoint for fetching token USD prices.
  // Used by getValueInUSD() which the PolicyEngine relies on for spending limits.
  jupiterPriceApiUrl: "https://price.jup.ag/v6",
});
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `rpcUrl` | `string` | Yes | -- | Solana RPC endpoint URL |
| `commitment` | `"processed" \| "confirmed" \| "finalized"` | No | `"confirmed"` | Transaction confirmation level |
| `jupiterApiUrl` | `string` | No | Jupiter default | Jupiter Quote API endpoint for swaps |
| `jupiterPriceApiUrl` | `string` | No | Jupiter default | Jupiter Price API endpoint for USD valuation |

::: tip WHAT IS COMMITMENT LEVEL?
Commitment level controls how "sure" you want to be that a transaction has succeeded before the SDK considers it done. Think of it like mail delivery confirmation:
- **"processed"** = "The post office received it" (fastest, but could be returned)
- **"confirmed"** = "The recipient's building accepted it" (good balance of speed and safety)
- **"finalized"** = "The recipient signed for it" (slowest, but guaranteed delivered)

The default `"confirmed"` is appropriate for most use cases. Use `"finalized"` for high-value transactions where you need absolute certainty.
:::

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

::: tip WHAT ARE LAMPORTS AND SPL TOKENS?
**Lamports** are the smallest unit of SOL, like cents to dollars. 1 SOL = 1,000,000,000 lamports. The SDK automatically converts between lamports and human-readable SOL amounts. **SPL tokens** are tokens built on the Solana blockchain (like USDC, USDT). Each SPL token has an "Associated Token Account" (ATA) -- a special account that holds your balance of that specific token.
:::

```typescript
// Create a SolanaAdapter connected to devnet for balance queries.
const chain = new SolanaAdapter({ rpcUrl: "https://api.devnet.solana.com" });

// Query native SOL balance for a specific wallet address.
// Internally, this calls the Solana RPC's getBalance method and converts
// lamports (1 SOL = 1,000,000,000 lamports) to a human-readable string.
// The usdValue field is populated by querying the Jupiter Price API.
const solBalance = await chain.getBalance(
  "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", // Wallet address to query
  "SOL", // Token symbol -- "SOL" means native SOL
);
console.log(`${solBalance.amount} SOL ($${solBalance.usdValue?.toFixed(2)})`);

// Query SPL token balance (USDC in this case).
// Internally, the adapter resolves "USDC" to its mint address, derives the
// Associated Token Account (ATA) for the given wallet, and reads its balance.
const usdcBalance = await chain.getBalance(
  "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", // Same wallet address
  "USDC", // Token symbol -- resolved to the USDC mint address internally
);
console.log(`${usdcBalance.amount} USDC`);
```

::: tip
If the Associated Token Account does not exist (the wallet has never held the token), `getBalance` returns `{ amount: "0", decimals: 6, usdValue: 0 }` instead of throwing.
:::

### buildTransaction

Build an unsigned transaction from a `TransactionIntent`. Dispatches to the appropriate builder based on intent type.

```typescript
// Build an unsigned SOL transfer transaction from a TransactionIntent.
// The first argument is the intent describing what you want to do.
// The second argument is the sender's address (the signer's public key).
const unsignedTx = await chain.buildTransaction(
  {
    type: "transfer",      // Intent type -- tells the adapter to build a transfer
    chain: "solana",       // Chain identifier -- must match this adapter's chain
    params: {
      to: "9WzDXwBb...",  // Recipient's Solana address
      amount: "1.5",       // Amount to send in human-readable units (not lamports)
      token: "SOL",        // Token to transfer -- "SOL" for native SOL
    },
  },
  "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", // The sender's (signer's) address
);
```

### broadcast

Broadcast a signed transaction to the Solana network. Waits for confirmation before returning.

```typescript
// Submit the signed transaction bytes to the Solana RPC node.
// Returns the transaction ID (base58-encoded signature) once confirmed.
// Internally, this uses sendRawTransaction with preflight checks.
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
// Poll the Solana RPC to check the confirmation status of a transaction.
// Useful for monitoring transactions after broadcast, or for verifying
// that a previously submitted transaction has finalized.
const status = await chain.getTransactionStatus(txId);
console.log(status.status); // "confirmed" | "finalized" | "failed" | "not_found"
```

### isValidAddress

Validate a Solana address using `PublicKey` parsing.

```typescript
// Check if a string is a valid Solana address (base58-encoded, 32-byte public key).
// Returns true if the address can be parsed as a valid Solana PublicKey.
chain.isValidAddress("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"); // true

// Returns false for strings that are not valid Solana addresses.
// This catches typos, Ethereum addresses, or other invalid inputs early.
chain.isValidAddress("not-a-valid-address");                              // false
```

## Jupiter Swap Integration

The `SolanaAdapter` integrates with Jupiter for token swaps. When processing a `swap` intent:

1. **Quote**: Fetches a quote from the Jupiter Quote API with the specified input/output tokens and amount
2. **Route**: Selects the best route based on output amount and slippage tolerance
3. **Transaction**: Gets the swap transaction from Jupiter's swap endpoint
4. **Build**: Returns the versioned transaction as an `UnsignedTransaction`

::: tip WHAT IS JUPITER AND WHAT IS SLIPPAGE?
**Jupiter** is a DEX (Decentralized Exchange) aggregator on Solana. Instead of trading on a single exchange, it searches across all Solana exchanges to find the best price for your swap. **Slippage** is the difference between the expected price and the actual price when the swap executes. Because prices change constantly, the `maxSlippage` parameter sets the maximum acceptable price change (e.g., 0.01 = 1%). If the price moves more than this amount between requesting and executing the swap, the transaction fails to protect you from bad pricing.
:::

The `maxSlippage` parameter in `SwapParams` controls the maximum acceptable price impact. If not specified, it defaults to 0.5% (0.005).

```typescript
// Execute a token swap through the AgentWallet.
// This goes through the full pipeline: policy check -> build -> sign -> broadcast.
const result = await wallet.execute({
  type: "swap",        // Intent type -- triggers the Jupiter swap flow
  chain: "solana",     // Chain identifier
  params: {
    fromToken: "SOL",  // The token to sell (input token)
    toToken: "USDC",   // The token to buy (output token)
    amount: "1.0",     // Amount of fromToken to swap (in human-readable units)
    maxSlippage: 0.01, // 1% max slippage -- the transaction will fail if the price
                       // moves more than 1% against you between quote and execution.
                       // Lower values are safer but may cause more failed swaps.
  },
});
```

::: warning
Jupiter swaps produce **versioned transactions** (v0), which require a signer that supports the versioned transaction format. `LocalSigner` handles both formats automatically.
:::

## Manual Transaction Flow

While `AgentWallet.execute()` handles the full pipeline, you can use the chain adapter directly for manual transaction building:

```typescript
// Import the chain adapter and signer for manual transaction construction.
import { SolanaAdapter, LocalSigner } from "kova";
import { Keypair } from "@solana/web3.js";

// Step 0: Set up the chain adapter and signer.
// Create a SolanaAdapter connected to devnet with "confirmed" commitment.
const chain = new SolanaAdapter({
  rpcUrl: "https://api.devnet.solana.com",
  commitment: "confirmed",
});
// Generate a fresh keypair and wrap it in a LocalSigner.
const keypair = Keypair.generate();
const signer = new LocalSigner(keypair);
// Get the wallet's public address (base58-encoded).
const address = await signer.getAddress();

// Step 1: Check the wallet's SOL balance before sending a transaction.
// This is optional but useful to verify the wallet has sufficient funds.
const balance = await chain.getBalance(address, "SOL");
console.log(`Balance: ${balance.amount} SOL`);

// Step 2: Build an unsigned transfer transaction from a TransactionIntent.
// This constructs the Solana transaction instructions and serializes them,
// but does NOT sign or submit the transaction yet.
const unsignedTx = await chain.buildTransaction(
  {
    type: "transfer",   // Build a SOL transfer
    chain: "solana",
    params: {
      to: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", // Recipient address
      amount: "0.1",    // Send 0.1 SOL
      token: "SOL",     // Native SOL transfer
    },
  },
  address, // The sender's address (used as the fee payer and signer)
);

// Step 3: Sign the unsigned transaction using the LocalSigner.
// This applies the Ed25519 signature using the keypair's secret key.
const signedTx = await signer.sign(unsignedTx);

// Step 4: Broadcast the signed transaction to the Solana network.
// Returns the transaction ID (signature) once the transaction is confirmed.
const txId = await chain.broadcast(signedTx.data);
console.log("Transaction ID:", txId);

// Step 5: Optionally check the transaction status after broadcast.
// This verifies the transaction reached the desired confirmation level.
const status = await chain.getTransactionStatus(txId);
console.log("Status:", status.status);
```

::: warning
When using the chain adapter directly, you bypass the policy engine, audit logging, circuit breaker, and idempotency protections. This is only recommended for debugging and testing.
:::

## URL Validation and SSRF Protection

The `SolanaAdapter` validates all configured URLs at construction time to prevent insecure connections and Server-Side Request Forgery (SSRF) attacks.

::: tip WHAT IS SSRF?
SSRF (Server-Side Request Forgery) is a security vulnerability where an attacker tricks your application into making requests to internal services it should not access (e.g., cloud metadata endpoints, internal databases). The `SolanaAdapter` prevents this by blocking URLs that target private network addresses. This is relevant even in non-blockchain applications -- any service that accepts user-provided URLs should validate them.
:::

### HTTPS Enforcement

All non-localhost URLs must use HTTPS. HTTP is only allowed for `localhost`, `127.0.0.1`, and `::1` (for local development with `solana-test-validator`).

```typescript
// OK: HTTPS is always accepted for remote endpoints.
new SolanaAdapter({ rpcUrl: "https://api.devnet.solana.com" });

// OK: HTTP is allowed for localhost only (for local solana-test-validator).
// The adapter recognizes localhost, 127.0.0.1, and ::1 as local addresses.
new SolanaAdapter({ rpcUrl: "http://localhost:8899" });

// REJECTED: HTTP to a non-localhost URL is blocked to prevent
// credentials and transaction data from being sent over unencrypted connections.
new SolanaAdapter({ rpcUrl: "http://api.devnet.solana.com" });
// Error: "RPC must use HTTPS for non-localhost URLs"
```

### Private Network Protection

The adapter rejects URLs targeting RFC 1918 private addresses, link-local addresses, and cloud metadata endpoints to prevent SSRF:

```typescript
// REJECTED: Private network addresses are blocked to prevent SSRF attacks.
// An attacker could trick the adapter into making requests to internal services.
new SolanaAdapter({ rpcUrl: "https://10.0.0.1:8899" });       // RFC 1918 Class A private range
new SolanaAdapter({ rpcUrl: "https://192.168.1.100:8899" });   // RFC 1918 Class C private range
new SolanaAdapter({ rpcUrl: "https://172.16.0.1:8899" });      // RFC 1918 Class B private range
new SolanaAdapter({ rpcUrl: "https://169.254.169.254" });      // AWS/GCP/Azure cloud metadata endpoint
// Error: "RPC cannot target private/internal network addresses"
```

This validation applies to `rpcUrl`, `jupiterApiUrl`, and `jupiterPriceApiUrl`.

## Devnet vs Mainnet

The `SolanaAdapter` automatically detects devnet URLs and adjusts behavior:

- Token mint addresses differ between devnet and mainnet
- Jupiter pricing may return `null` on devnet (prices are not available for devnet tokens)
- Devnet has more lenient rate limits but transactions may be less reliable

::: tip WHAT IS DEVNET VS MAINNET?
Blockchains typically have multiple networks:
- **Devnet** (development network): A test network with free, fake tokens. Use this for development and testing. Transactions cost nothing and you can get free SOL via `solana airdrop`.
- **Mainnet** (main network): The real network with real money. Transactions cost real SOL. This is where production applications run.

Always develop and test on devnet first, then switch to mainnet when you are confident everything works correctly.
:::

```typescript
// Devnet configuration -- suitable for development and testing.
// Devnet SOL is free (use solana airdrop) and transactions cost nothing.
const devnet = new SolanaAdapter({ rpcUrl: "https://api.devnet.solana.com" });

// Mainnet configuration -- for production use with real funds.
// Using "finalized" commitment for maximum safety (transactions are irreversible).
const mainnet = new SolanaAdapter({
  rpcUrl: "https://api.mainnet-beta.solana.com",
  commitment: "finalized", // Strongest confirmation level for production safety
});
```

## See Also

- [Signers](/guide/signers) -- the key-management layer that signs transactions built by the chain adapter
- [Stores](/guide/stores) -- the persistence layer for SDK safety state
- [SpendingLimitRule](/guide/rules/spending-limit) -- spending limits that use `getValueInUSD()` from the chain adapter for price conversion
- [AllowlistRule](/guide/rules/allowlist) -- address restrictions that are checked before the chain adapter builds the transaction
