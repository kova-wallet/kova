# Signers

::: info What you'll learn
- How signing works and why every transaction needs a cryptographic signature
- The 3-method Signer interface that all key-management backends implement
- When to use `LocalSigner` (dev) vs `MpcSigner` (production)
- How to implement a custom Signer for Fireblocks, AWS KMS, or other services
- Security best practices for key management in production
:::

A Signer holds your agent's private key and uses it to authorize transactions -- like the signature on a check that proves you approved the payment.

Signers are responsible for holding private keys and signing transactions. The `Signer` interface is minimal -- all signing backends implement three methods.

## Which Signer Should I Use?

| Scenario | Recommended Signer | Why |
|---|---|---|
| **Local development / testing** | `LocalSigner` | Simple setup, key lives in memory. No external dependencies. |
| **Production with MPC** | `MpcSigner` + `TurnkeyProvider` (built-in) or your own provider | Key is split across multiple parties via MPC. Use the built-in Turnkey provider or wire any backend (Lit Protocol, Fireblocks). |
| **Production with KMS** | Custom signer (e.g., AWS KMS) | Private key managed by a cloud key management service. See the custom signer example below. |
| **Production (institutional)** | `MpcSigner` or custom signer | Hardware-backed signing with audit trails, multi-party approvals, and compliance features. |

::: tip QUICK RULE OF THUMB
Use `LocalSigner` for development and testing. For production, use `MpcSigner` with a provider adapter for your MPC backend, or implement a custom `Signer` for KMS/HSM services. The private key should never exist in your application's memory.
:::

## How Signing Works (Plain English)

Every blockchain transaction must be "signed" before it can be executed -- this is how the blockchain knows the transaction was authorized by the wallet owner. Here is the process:

1. **Build**: The chain adapter constructs a transaction (e.g., "send 1 SOL to address X").
2. **Sign**: The signer applies a cryptographic signature using the private key. This is like stamping a document with a unique seal that only you possess.
3. **Broadcast**: The signed transaction is sent to the blockchain network, which verifies the signature and executes the transaction.

The signer never sends the private key anywhere -- it only produces signatures. The blockchain can verify the signature using the corresponding public key (the wallet address).

::: tip WHAT IS A PRIVATE KEY?
A private key is a secret number (usually 32-64 bytes) that proves ownership of a blockchain wallet. Think of it as the master password to a bank account. Anyone who has the private key can authorize transactions from that wallet. The corresponding "public key" (or "address") is like the account number -- safe to share publicly. The private key must be kept secret at all times.
:::

## Signer Interface

```typescript
// Import the core signer-related types from the kova SDK.
// - Signer: the interface that all signing backends must implement
// - UnsignedTransaction: represents a transaction before it has been signed
// - SignedTransaction: represents a transaction after signing, including the signature bytes
import type { Signer, UnsignedTransaction, SignedTransaction } from "kova";
```

```typescript
// The Signer interface defines the contract that all key-management backends
// must fulfill. Whether you use an in-memory keypair, an MPC provider like
// Fireblocks, or a hardware security module, your signer must implement
// these three methods.
interface Signer {
  /** Get the public key / address of this signer */
  // Returns the on-chain address (e.g., a Solana base58 public key).
  // This is used by the SDK to set the "from" address on transactions
  // and to query the wallet's token balances.
  getAddress(): Promise<string>;

  /** Sign a transaction */
  // Takes an UnsignedTransaction (containing chain-specific serialized bytes)
  // and returns a SignedTransaction with the cryptographic signature attached.
  // For Solana, this produces a 64-byte Ed25519 signature.
  sign(transaction: UnsignedTransaction): Promise<SignedTransaction>;

  /** Verify that the signer is operational and can sign */
  // A liveness check for the signing backend. Returns true if the signer
  // is ready (e.g., the key material is loaded, the remote API is reachable).
  // The AgentWallet can call this before attempting a transaction.
  healthCheck(): Promise<boolean>;
}
```

## Transaction Types

### UnsignedTransaction

The output of a chain adapter's `buildTransaction()` method. Contains chain-specific serialized transaction data before signing.

```typescript
// Represents a transaction that has been constructed but not yet signed.
// This is the intermediate format between the chain adapter (which builds
// the transaction) and the signer (which signs it).
interface UnsignedTransaction {
  /** Chain identifier (e.g., "solana") */
  // Tells the signer which chain this transaction belongs to, so it can
  // apply the correct signing algorithm (e.g., Ed25519 for Solana).
  chain: string;
  /** Chain-specific serialized transaction (before signing) */
  // The raw transaction bytes. On Solana, this is the serialized message
  // portion of a Transaction or VersionedTransaction that needs to be signed.
  data: Uint8Array;
  /** Human-readable description for logging */
  // Optional text included in audit logs and debug output to describe
  // what this transaction does (e.g., "Transfer 1.5 SOL to Alice").
  description?: string;
}
```

### SignedTransaction

The output of a signer's `sign()` method. Contains the signed transaction data and signature bytes.

```typescript
// Represents a fully signed transaction, ready to be submitted to the blockchain.
// Produced by a Signer and consumed by a chain adapter's submitTransaction() method.
interface SignedTransaction {
  /** Chain identifier */
  // Same chain identifier as the UnsignedTransaction; used by the chain
  // adapter to know which network to submit the transaction to.
  chain: string;
  /** Chain-specific serialized transaction (after signing) */
  // The complete transaction bytes with the signature(s) embedded.
  // On Solana, this is the fully serialized Transaction ready for RPC submission.
  data: Uint8Array;
  /** The signature bytes */
  // The raw cryptographic signature. On Solana, this is a 64-byte Ed25519
  // signature that can be used as the transaction ID after base58 encoding.
  signature: Uint8Array;
}
```

## LocalSigner

Holds a Solana `Keypair` in memory. Supports both legacy and versioned Solana transactions.

```typescript
// Import LocalSigner from kova -- the simplest signer for development use.
import { LocalSigner } from "kova";
// Import Keypair from the Solana web3.js library.
// A Keypair contains both the 32-byte secret key and the 32-byte public key.
import { Keypair } from "@solana/web3.js";
```

### Constructor

```typescript
// Generate a brand-new random Solana keypair (secret key + public key).
// This creates a new wallet address that has never been used on-chain.
const keypair = Keypair.generate();

// Wrap the Keypair in a LocalSigner so it implements the Signer interface.
// The LocalSigner holds the keypair in process memory for signing transactions.
const signer = new LocalSigner(keypair);
```

Or from an existing secret key:

```typescript
// Load a secret key from an existing byte array (64 bytes: 32-byte secret + 32-byte public).
// In practice, you would load this from a secure source like an environment variable
// or a secrets manager -- never hardcode real keys in source code.
const secretKey = Uint8Array.from([/* 64 bytes */]);

// Reconstruct a Keypair from the secret key bytes.
const keypair = Keypair.fromSecretKey(secretKey);

// Wrap it in a LocalSigner for use with the Kova SDK.
const signer = new LocalSigner(keypair);
```

### Production Guard

`LocalSigner` throws an error at construction time in production environments:

```typescript
// In production without opt-in:
const signer = new LocalSigner(keypair);
// Error: "LocalSigner is not safe for production use..."

// Explicit opt-in (devnet testing only -- NOT for real funds):
const signer = new LocalSigner(keypair, { dangerouslyAllowInProduction: true });
```

::: danger
The `dangerouslyAllowInProduction` flag exists for devnet testing in production Node.js environments. Do NOT use it with real funds. The private key is held in plaintext process memory.
:::

### Usage

```typescript
// Get the wallet address (Solana base58-encoded public key).
// This is the address you would fund with SOL and tokens.
const address = await signer.getAddress();
console.log("Address:", address);
// Output: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"

// Health check verifies the signer is operational.
// For LocalSigner, this always returns true since the key is in memory.
// For remote signers (e.g., Fireblocks), this would check API connectivity.
const healthy = await signer.healthCheck();
console.log("Healthy:", healthy);
// Output: true

// Sign an unsigned transaction. In normal usage, you do not call this directly --
// the AgentWallet calls signer.sign() internally as part of its execute() flow.
// The returned SignedTransaction contains both the signed bytes and the raw signature.
const signed = await signer.sign(unsignedTx);
console.log("Signature length:", signed.signature.length);
// Output: 64 (Ed25519 signature -- standard for Solana)
```

### Security Methods

#### destroy()

Zero out the secret key from memory. After calling `destroy()`, the signer can no longer sign transactions. Any attempt to call `sign()` will throw an error.

```typescript
// When you are done with the signer, destroy the key material.
// This overwrites the secret key bytes in memory with zeros, reducing
// the window during which the key could be extracted via heap dumps.
signer.destroy();

// Subsequent sign() calls will throw because the key has been zeroed out.
// This is a safety mechanism to prevent accidental use of a retired signer.
await signer.sign(unsignedTx);
// Error: "LocalSigner has been destroyed and can no longer sign transactions"
```

::: tip
Call `destroy()` when shutting down your wallet to minimize the window during which the private key exists in memory. This is especially important in long-running processes.
:::

#### toJSON()

Returns only the public address, never the secret key. This prevents accidental key leakage via `JSON.stringify()`.

```typescript
// JSON.stringify() on a LocalSigner only includes the public address.
// This is a deliberate safety measure -- if the signer accidentally ends up
// in a log statement or error report, the secret key will NOT be exposed.
console.log(JSON.stringify(signer));
// Output: { "address": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" }

// The secret key is NEVER included in JSON serialization
```

::: danger SECURITY WARNING
`LocalSigner` stores the private key in process memory as a plain `Keypair`. The key can be extracted via heap dumps, core dumps, or memory inspection tools. **Do not use `LocalSigner` in production with real funds.** Use `MpcSigner` with a secure provider or a custom hardware-backed signer for production deployments.
:::

#### rotateKey(newKeypair, config?)

Create a new LocalSigner with a different keypair and destroy the old one. Returns the new signer instance.

```typescript
import { Keypair } from "@solana/web3.js";

// Rotate to a new keypair. The old key material is zeroed out.
const newKeypair = Keypair.generate();
const newSigner = await signer.rotateKey(newKeypair);
// signer is now destroyed. newSigner is the active signer.
```

### Supported Transaction Formats

`LocalSigner` automatically detects the Solana transaction format:

- **Versioned transactions** (v0): Used by Jupiter swaps and modern Solana programs
- **Legacy transactions**: Used by simple SOL transfers and older programs

The detection is transparent -- you do not need to specify the format.

::: tip WHAT ARE VERSIONED VS LEGACY TRANSACTIONS?
Solana has two transaction formats. **Legacy transactions** are the original format, used for simple operations like transferring SOL. **Versioned transactions** (v0) are a newer format that supports "address lookup tables," allowing more complex operations (like multi-hop token swaps) to fit within Solana's transaction size limits. `LocalSigner` handles both automatically -- you do not need to worry about which format is being used.
:::

## MpcSigner

Provider-agnostic MPC signer for production use. You implement the `MpcSigningProvider` interface for your MPC backend (Turnkey, Lit Protocol, Fireblocks, etc.), and `MpcSigner` handles the rest -- chain validation, address caching, retries, and timeouts.

```typescript
// Import MpcSigner and the provider interface from kova.
import { MpcSigner } from "kova";
import type { MpcSigningProvider } from "kova";
```

::: tip WHAT IS MPC (MULTI-PARTY COMPUTATION)?
MPC is a cryptographic technique where a private key is split into multiple "shares" distributed across different servers or parties. To sign a transaction, a threshold number of shares must cooperate (e.g., 2 out of 3). No single party ever has the full key, which means a breach of any single server cannot compromise the wallet. This is similar in concept to requiring multiple signatures on a corporate bank account.
:::

### MpcSigningProvider Interface

This is what you implement for your specific MPC backend:

```typescript
// The MpcSigningProvider interface defines the 3 methods your backend adapter
// must implement. MpcSigner delegates all cryptographic operations to your provider.
interface MpcSigningProvider {
  /** Human-readable provider name (for logging/errors) */
  // Used in error messages and logs to identify which backend failed.
  // Example values: "turnkey", "lit-protocol", "fireblocks"
  readonly name: string;

  /** Return the public address for the configured signing key */
  // Called once on first use, then cached by MpcSigner.
  getAddress(): Promise<string>;

  /** Sign raw transaction bytes using MPC */
  // Receives the unsigned transaction bytes and must return:
  //   - signedData: the fully assembled signed transaction (ready to broadcast)
  //   - signature: the raw signature bytes (64 bytes for Ed25519 on Solana)
  signTransaction(transactionData: Uint8Array): Promise<MpcSignResult>;

  /** Check if the provider is reachable and the signing key is available */
  // A health probe. Return true if your MPC backend is operational.
  healthCheck(): Promise<boolean>;
}
```

### MpcSignerConfig

```typescript
// Configuration for initializing an MPC signer.
interface MpcSignerConfig {
  /** The MPC signing provider implementation */
  // Your adapter class that implements MpcSigningProvider.
  provider: MpcSigningProvider;
  /** Chain this signer operates on (e.g., "solana") */
  // Validated against incoming transactions -- rejects mismatched chains.
  chain: string;
  /** Max retries for transient provider failures (default: 2) */
  // If the provider throws a transient error (network blip, temporary 503),
  // MpcSigner will retry up to this many additional times before failing.
  maxRetries?: number;
  /** Timeout in ms for individual provider calls (default: 30000) */
  // If a provider call takes longer than this, it throws a TIMEOUT error.
  timeoutMs?: number;
}
```

### Built-in Provider: Turnkey

Kova ships with a ready-made `TurnkeyProvider` that implements `MpcSigningProvider` using [Turnkey](https://turnkey.com)'s server-side SDK. Turnkey signs transactions inside TEEs (Trusted Execution Environments), meaning private keys never leave secure hardware.

#### Install

```bash
npm install @turnkey/sdk-server
```

`@turnkey/sdk-server` is an optional peer dependency -- it is only loaded when you use `TurnkeyProvider`.

#### Configuration

```typescript
import { TurnkeyProvider } from "kova";
import type { TurnkeyProviderConfig } from "kova";
```

```typescript
// TurnkeyProvider configuration.
// All fields are required.
interface TurnkeyProviderConfig {
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
   * If this is a Turnkey private key ID (UUID), Turnkey resolves it internally.
   */
  signWith: string;
}
```

#### Usage

```typescript
import { TurnkeyProvider, MpcSigner, AgentWallet, SolanaAdapter } from "kova";

// 1. Create the Turnkey provider with your API credentials
const provider = new TurnkeyProvider({
  apiBaseUrl: "https://api.turnkey.com",
  apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY!,
  apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY!,
  defaultOrganizationId: process.env.TURNKEY_ORGANIZATION_ID!,
  signWith: process.env.TURNKEY_WALLET_ADDRESS!, // Solana address or private key ID
});

// 2. Wrap it in MpcSigner for retry/timeout/validation
const signer = new MpcSigner({
  provider,
  chain: "solana",
  maxRetries: 3,
  timeoutMs: 15_000,
});

// 3. Use it in an AgentWallet -- works exactly like LocalSigner
const wallet = new AgentWallet({
  signer,
  chain: new SolanaAdapter({ rpcUrl: "https://api.mainnet-beta.solana.com" }),
  policy: engine,
  store: new SqliteStore({ path: "./wallet.db" }),
});
```

#### Turnkey Setup Steps

1. **Create a Turnkey account** at [app.turnkey.com](https://app.turnkey.com)
2. **Create an API key pair** in your organization settings. Save the public and private keys.
3. **Create a Solana wallet** in Turnkey (uses Ed25519 curve). Copy the wallet address.
4. **Set environment variables**:
   ```bash
   TURNKEY_API_PUBLIC_KEY="your-api-public-key"
   TURNKEY_API_PRIVATE_KEY="your-api-private-key"
   TURNKEY_ORGANIZATION_ID="your-org-id"
   TURNKEY_WALLET_ADDRESS="your-solana-wallet-address"
   ```

::: tip
The `TurnkeyProvider` lazily initializes the Turnkey SDK client on first use. If `@turnkey/sdk-server` is not installed, you will get a clear error message telling you to install it.
:::

### Example: Implementing a Custom Provider

If your MPC backend is not Turnkey, implement `MpcSigningProvider` directly:

```typescript
// Example: A custom MPC provider adapter for Lit Protocol.
import type { MpcSigningProvider, MpcSignResult } from "kova";

class LitProtocolProvider implements MpcSigningProvider {
  readonly name = "lit-protocol";

  async getAddress(): Promise<string> {
    // Call your MPC backend to get the public address
    return "your-wallet-address";
  }

  async signTransaction(transactionData: Uint8Array): Promise<MpcSignResult> {
    // Submit unsigned transaction bytes to your MPC backend for signing
    const result = await yourMpcBackend.sign(transactionData);
    return {
      signedData: result.signedTransaction,  // Full signed transaction bytes
      signature: result.signature,            // Raw 64-byte Ed25519 signature
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      await yourMpcBackend.ping();
      return true;
    } catch {
      return false;
    }
  }
}
```

### Using MpcSigner

```typescript
// Create the provider (your backend adapter or the built-in TurnkeyProvider)
const provider = new TurnkeyProvider({
  apiBaseUrl: "https://api.turnkey.com",
  apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY!,
  apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY!,
  defaultOrganizationId: process.env.TURNKEY_ORGANIZATION_ID!,
  signWith: process.env.TURNKEY_WALLET_ADDRESS!,
});

// Wrap it in MpcSigner with chain validation and retry configuration
const signer = new MpcSigner({
  provider,
  chain: "solana",        // Only signs Solana transactions
  maxRetries: 3,          // Retry transient failures up to 3 times
  timeoutMs: 15_000,      // Fail if a provider call takes > 15 seconds
});

// Use it exactly like LocalSigner -- the wallet doesn't care
const wallet = new AgentWallet({
  signer,
  chain: new SolanaAdapter({ rpcUrl: "https://api.mainnet-beta.solana.com" }),
  policy: engine,
  store: new SqliteStore({ path: "./wallet.db" }),
});
```

### Built-in Features

| Feature | Behavior |
|---------|----------|
| **Address caching** | `getAddress()` calls the provider once, then returns the cached result |
| **Chain validation** | Rejects transactions with a chain that doesn't match the configured `chain` |
| **Retry** | Retries transient provider errors up to `maxRetries` times. Non-transient errors (chain mismatch) are never retried |
| **Timeout** | Each provider call is wrapped in a timeout. Slow providers throw `TIMEOUT` |
| **Health check** | Delegates to provider with timeout. Returns `false` on any error (no retry) |

::: tip Security note
In error messages returned to callers, the MPC provider name is hashed and truncated (e.g., `provider-9fd6`) to prevent leaking infrastructure details. The full provider name is available in internal audit logs.
:::

### Error Handling

`MpcSigner` throws `MpcSignerError` with typed error codes:

```typescript
import { MpcSignerError } from "kova";

try {
  await wallet.execute(intent);
} catch (err) {
  if (err instanceof MpcSignerError) {
    console.log(err.code);     // "PROVIDER_ERROR" | "TIMEOUT" | "CHAIN_MISMATCH"
    console.log(err.provider); // "turnkey"
    console.log(err.message);  // Human-readable description
  }
}
```

| Error Code | When | Retried? |
|---|---|---|
| `CHAIN_MISMATCH` | Transaction chain doesn't match signer's configured chain | No |
| `TIMEOUT` | Provider call exceeded `timeoutMs` | Yes (counts as an attempt) |
| `PROVIDER_ERROR` | Provider threw an error after all retries exhausted | N/A (final) |

## Implementing a Custom Signer

For production use with services like Fireblocks, AWS KMS, or hardware wallets, implement the `Signer` interface:

```typescript
// Import the Signer interface and transaction types from kova.
import type { Signer, UnsignedTransaction, SignedTransaction } from "kova";

// Example: A production-grade signer that delegates signing to Fireblocks,
// an institutional-grade key management and custody platform.
// Fireblocks never exposes the raw private key -- signing happens on their
// secure infrastructure, and only the signature is returned.
export class FireblocksSigner implements Signer {
  // The Fireblocks vault account ID that holds the signing key.
  private readonly vaultId: string;
  // The asset identifier within Fireblocks (e.g., "SOL" for Solana).
  private readonly assetId: string;
  // Cache the wallet address after the first API call to avoid redundant requests.
  // The address never changes, so caching is safe.
  private cachedAddress: string | null = null;

  // Accept Fireblocks-specific configuration: which vault and asset to use.
  constructor(config: { vaultId: string; assetId: string }) {
    this.vaultId = config.vaultId;
    this.assetId = config.assetId;
  }

  // Retrieve the on-chain deposit address from Fireblocks.
  // Uses caching to avoid repeated API calls since the address is immutable.
  async getAddress(): Promise<string> {
    // Return the cached address if we've already fetched it.
    if (this.cachedAddress) return this.cachedAddress;

    // Call Fireblocks API to get the deposit address for this vault + asset combo.
    // The response is an array of addresses; we take the first (primary) one.
    const response = await fireblocks.getDepositAddresses(
      this.vaultId,
      this.assetId,
    );
    // Cache the address so future calls skip the API round-trip.
    this.cachedAddress = response[0].address;
    return this.cachedAddress;
  }

  // Sign a transaction by sending the raw bytes to Fireblocks for signing.
  // Fireblocks performs the signing on their HSM-backed infrastructure,
  // so the private key never leaves their secure environment.
  async sign(transaction: UnsignedTransaction): Promise<SignedTransaction> {
    // Submit raw transaction to Fireblocks for signing.
    // "RAW" operation means we are passing pre-built transaction bytes
    // rather than having Fireblocks construct the transaction for us.
    const result = await fireblocks.createTransaction({
      operation: "RAW",
      rawMessageData: {
        messages: [
          {
            // Convert the binary transaction data to a hex string for the API.
            content: Buffer.from(transaction.data).toString("hex"),
          },
        ],
      },
      // Specify which vault account holds the signing key.
      source: { type: "VAULT_ACCOUNT", id: this.vaultId },
    });

    // Wait for Fireblocks to complete the signing process.
    // Fireblocks signing is asynchronous -- it may require multiple approvals
    // depending on your policy configuration. This polls until completion.
    const signed = await waitForCompletion(result.id);

    // Return the signed transaction in the format expected by the Kova SDK.
    return {
      chain: transaction.chain,                       // Pass through the chain identifier
      data: Buffer.from(signed.signedMessage, "hex"), // The fully signed transaction bytes
      signature: Buffer.from(signed.signature, "hex"),// The raw signature bytes
    };
  }

  // Check whether the Fireblocks vault is accessible and operational.
  // This verifies API connectivity and that the vault account exists.
  async healthCheck(): Promise<boolean> {
    try {
      // Attempt to fetch the vault account details from Fireblocks.
      // If this succeeds, the signing infrastructure is reachable.
      await fireblocks.getVaultAccountById(this.vaultId);
      return true;
    } catch {
      // If the API call fails (network error, auth error, etc.), report unhealthy.
      return false;
    }
  }
}
```

::: tip
Cache the address in `getAddress()` to avoid repeated API calls. The wallet address does not change between calls, so caching is safe and recommended.
:::

### Using a Custom Signer

```typescript
// Import the core Kova components for assembling a production wallet.
import { AgentWallet, PolicyEngine, SqliteStore, SolanaAdapter } from "kova";
// Import the custom Fireblocks signer we defined above.
import { FireblocksSigner } from "./fireblocks-signer";

// Create a Fireblocks signer pointing to a specific vault and asset.
// "vault-001" is the Fireblocks vault ID, "SOL" is the Solana asset.
const signer = new FireblocksSigner({
  vaultId: "vault-001",
  assetId: "SOL",
});

// Assemble the AgentWallet with all four required components:
const wallet = new AgentWallet({
  signer,  // The Fireblocks signer handles all cryptographic signing remotely
  chain: new SolanaAdapter({ rpcUrl: "https://api.mainnet-beta.solana.com" }), // Solana mainnet RPC endpoint for building and submitting transactions
  policy: engine,  // The PolicyEngine that enforces spending limits, rate limits, etc.
  store: new SqliteStore({ path: "./wallet.db" }), // Persistent store for SDK state (counters, audit logs)
});
```

## Common Mistakes

**1. Using `LocalSigner` in production.**
`LocalSigner` holds the private key in process memory as a plain `Keypair`. The key can be extracted via heap dumps, core dumps, or memory inspection tools. Always use `MpcSigner` or a custom hardware-backed signer for production deployments with real funds.

**2. Hardcoding private keys in source code.**
Never include private keys in your code, even for testing. Use environment variables, a secrets manager (AWS Secrets Manager, HashiCorp Vault), or an MPC provider. If a key leaks in your Git history, any funds in that wallet are at risk.

**3. Forgetting to call `destroy()` on `LocalSigner`.**
For long-running processes, call `destroy()` when you are done with the signer to zero out the secret key from memory. This minimizes the window during which the key could be extracted.

## See Also

- [Chain Adapters](/guide/chain-adapters) -- the blockchain communication layer that builds and broadcasts signed transactions
- [Stores](/guide/stores) -- the persistence layer for SDK safety state (pairs with signers to form the wallet)
- [SpendingLimitRule](/guide/rules/spending-limit) -- spending limits that protect the funds the signer controls
- [ApprovalGateRule](/guide/rules/approval-gate) -- human approval for high-value transactions before they are signed
