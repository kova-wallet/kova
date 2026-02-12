# Signers

A Signer holds your agent's private key and uses it to authorize transactions -- like the signature on a check that proves you approved the payment.

Signers are responsible for holding private keys and signing transactions. The `Signer` interface is minimal -- all signing backends implement three methods.

## Which Signer Should I Use?

| Scenario | Recommended Signer | Why |
|---|---|---|
| **Local development / testing** | `LocalSigner` | Simple setup, key lives in memory. No external dependencies. |
| **Production (small scale)** | Custom signer (e.g., AWS KMS, Fireblocks) | Private key never leaves a secure environment. See the custom signer example below. |
| **Production (institutional)** | Custom signer (e.g., Fireblocks, Fordefi) | Hardware-backed signing with audit trails, multi-party approvals, and compliance features. |
| **Future: distributed key management** | `MPCSigner` (Phase 2) | Key is split across multiple parties so no single party can sign alone. Not yet implemented. |

::: tip QUICK RULE OF THUMB
Use `LocalSigner` for development and testing. For production, implement a custom signer that delegates to a secure key management service (KMS) so that the private key never exists in your application's memory.
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
`LocalSigner` stores the private key in process memory as a plain `Keypair`. The key can be extracted via heap dumps, core dumps, or memory inspection tools. **Do not use `LocalSigner` in production with real funds.** Use `MPCSigner` or a custom hardware-backed signer for production deployments.
:::

### Supported Transaction Formats

`LocalSigner` automatically detects the Solana transaction format:

- **Versioned transactions** (v0): Used by Jupiter swaps and modern Solana programs
- **Legacy transactions**: Used by simple SOL transfers and older programs

The detection is transparent -- you do not need to specify the format.

::: tip WHAT ARE VERSIONED VS LEGACY TRANSACTIONS?
Solana has two transaction formats. **Legacy transactions** are the original format, used for simple operations like transferring SOL. **Versioned transactions** (v0) are a newer format that supports "address lookup tables," allowing more complex operations (like multi-hop token swaps) to fit within Solana's transaction size limits. `LocalSigner` handles both automatically -- you do not need to worry about which format is being used.
:::

## MPCSigner

Multi-Party Computation signer. Currently a stub -- all methods throw an error. Full implementation is planned for Phase 2.

```typescript
// Import MPCSigner -- the placeholder for multi-party computation signing.
// MPC signers distribute the private key across multiple parties so that
// no single party ever holds the full key, greatly improving security.
import { MPCSigner } from "kova";
```

::: tip WHAT IS MPC (MULTI-PARTY COMPUTATION)?
MPC is a cryptographic technique where a private key is split into multiple "shares" distributed across different servers or parties. To sign a transaction, a threshold number of shares must cooperate (e.g., 2 out of 3). No single party ever has the full key, which means a breach of any single server cannot compromise the wallet. This is similar in concept to requiring multiple signatures on a corporate bank account.
:::

### MPCSignerConfig

```typescript
// Configuration for initializing an MPC signer.
// This interface defines the parameters needed to connect to an MPC provider.
interface MPCSignerConfig {
  /** MPC provider (e.g., "lit-protocol", "fireblocks") */
  // Identifies which MPC service to use. Different providers have different
  // key management protocols and SDK integrations.
  provider: string;
  /** Key identifier within the MPC provider */
  // The unique ID of the key shard/share set within the MPC provider's system.
  // This tells the provider which distributed key to use for signing.
  keyId: string;
  /** Number of shares required to sign */
  // The threshold (t) in a t-of-n MPC scheme. For example, threshold: 2 means
  // at least 2 out of n key share holders must participate to produce a signature.
  threshold: number;
}
```

### Current Status

```typescript
// Create an MPCSigner instance with Lit Protocol as the MPC provider.
// Note: This is currently a stub -- the actual MPC integration is not yet implemented.
const signer = new MPCSigner({
  provider: "lit-protocol",  // The MPC provider to use
  keyId: "key-001",          // The key identifier in Lit Protocol's key management
  threshold: 2,              // Require 2 shares to produce a valid signature
});

// All methods throw "not yet implemented" in the current release.
// These calls are shown to illustrate the expected API surface for Phase 2.
await signer.getAddress();    // throws Error
await signer.sign(tx);        // throws Error
await signer.healthCheck();   // returns false
```

::: warning
`MPCSigner` is not functional in the current release. It exists to define the configuration interface and reserve the API surface for Phase 2. Use `LocalSigner` for development and implement a custom `Signer` for production needs.
:::

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

## See Also

- [Chain Adapters](/guide/chain-adapters) -- the blockchain communication layer that builds and broadcasts signed transactions
- [Stores](/guide/stores) -- the persistence layer for SDK safety state (pairs with signers to form the wallet)
- [SpendingLimitRule](/guide/rules/spending-limit) -- spending limits that protect the funds the signer controls
- [ApprovalGateRule](/guide/rules/approval-gate) -- human approval for high-value transactions before they are signed
