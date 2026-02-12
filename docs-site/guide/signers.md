# Signers

Signers are responsible for holding private keys and signing transactions. The `Signer` interface is minimal -- all signing backends implement three methods.

## Signer Interface

```typescript
import type { Signer, UnsignedTransaction, SignedTransaction } from "kova";
```

```typescript
interface Signer {
  /** Get the public key / address of this signer */
  getAddress(): Promise<string>;

  /** Sign a transaction */
  sign(transaction: UnsignedTransaction): Promise<SignedTransaction>;

  /** Verify that the signer is operational and can sign */
  healthCheck(): Promise<boolean>;
}
```

## Transaction Types

### UnsignedTransaction

The output of a chain adapter's `buildTransaction()` method. Contains chain-specific serialized transaction data before signing.

```typescript
interface UnsignedTransaction {
  /** Chain identifier (e.g., "solana") */
  chain: string;
  /** Chain-specific serialized transaction (before signing) */
  data: Uint8Array;
  /** Human-readable description for logging */
  description?: string;
}
```

### SignedTransaction

The output of a signer's `sign()` method. Contains the signed transaction data and signature bytes.

```typescript
interface SignedTransaction {
  /** Chain identifier */
  chain: string;
  /** Chain-specific serialized transaction (after signing) */
  data: Uint8Array;
  /** The signature bytes */
  signature: Uint8Array;
}
```

## LocalSigner

Holds a Solana `Keypair` in memory. Supports both legacy and versioned Solana transactions.

```typescript
import { LocalSigner } from "kova";
import { Keypair } from "@solana/web3.js";
```

### Constructor

```typescript
const keypair = Keypair.generate();
const signer = new LocalSigner(keypair);
```

Or from an existing secret key:

```typescript
const secretKey = Uint8Array.from([/* 64 bytes */]);
const keypair = Keypair.fromSecretKey(secretKey);
const signer = new LocalSigner(keypair);
```

### Usage

```typescript
// Get the wallet address
const address = await signer.getAddress();
console.log("Address:", address);
// Output: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"

// Health check (always returns true for LocalSigner)
const healthy = await signer.healthCheck();
console.log("Healthy:", healthy);
// Output: true

// Sign a transaction (typically called by AgentWallet internally)
const signed = await signer.sign(unsignedTx);
console.log("Signature length:", signed.signature.length);
// Output: 64 (Ed25519 signature)
```

### Security Methods

#### destroy()

Zero out the secret key from memory. After calling `destroy()`, the signer can no longer sign transactions. Any attempt to call `sign()` will throw an error.

```typescript
// When you are done with the signer, destroy the key material
signer.destroy();

// Subsequent sign() calls will throw
await signer.sign(unsignedTx);
// Error: "LocalSigner has been destroyed and can no longer sign transactions"
```

::: tip
Call `destroy()` when shutting down your wallet to minimize the window during which the private key exists in memory. This is especially important in long-running processes.
:::

#### toJSON()

Returns only the public address, never the secret key. This prevents accidental key leakage via `JSON.stringify()`.

```typescript
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

## MPCSigner

Multi-Party Computation signer. Currently a stub -- all methods throw an error. Full implementation is planned for Phase 2.

```typescript
import { MPCSigner } from "kova";
```

### MPCSignerConfig

```typescript
interface MPCSignerConfig {
  /** MPC provider (e.g., "lit-protocol", "fireblocks") */
  provider: string;
  /** Key identifier within the MPC provider */
  keyId: string;
  /** Number of shares required to sign */
  threshold: number;
}
```

### Current Status

```typescript
const signer = new MPCSigner({
  provider: "lit-protocol",
  keyId: "key-001",
  threshold: 2,
});

// All methods throw "not yet implemented"
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
import type { Signer, UnsignedTransaction, SignedTransaction } from "kova";

export class FireblocksSigner implements Signer {
  private readonly vaultId: string;
  private readonly assetId: string;
  private cachedAddress: string | null = null;

  constructor(config: { vaultId: string; assetId: string }) {
    this.vaultId = config.vaultId;
    this.assetId = config.assetId;
  }

  async getAddress(): Promise<string> {
    if (this.cachedAddress) return this.cachedAddress;

    // Call Fireblocks API to get the deposit address
    const response = await fireblocks.getDepositAddresses(
      this.vaultId,
      this.assetId,
    );
    this.cachedAddress = response[0].address;
    return this.cachedAddress;
  }

  async sign(transaction: UnsignedTransaction): Promise<SignedTransaction> {
    // Submit raw transaction to Fireblocks for signing
    const result = await fireblocks.createTransaction({
      operation: "RAW",
      rawMessageData: {
        messages: [
          {
            content: Buffer.from(transaction.data).toString("hex"),
          },
        ],
      },
      source: { type: "VAULT_ACCOUNT", id: this.vaultId },
    });

    // Wait for Fireblocks to complete signing
    const signed = await waitForCompletion(result.id);

    return {
      chain: transaction.chain,
      data: Buffer.from(signed.signedMessage, "hex"),
      signature: Buffer.from(signed.signature, "hex"),
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      await fireblocks.getVaultAccountById(this.vaultId);
      return true;
    } catch {
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
import { AgentWallet, PolicyEngine, SqliteStore, SolanaAdapter } from "kova";
import { FireblocksSigner } from "./fireblocks-signer";

const signer = new FireblocksSigner({
  vaultId: "vault-001",
  assetId: "SOL",
});

const wallet = new AgentWallet({
  signer,
  chain: new SolanaAdapter({ rpcUrl: "https://api.mainnet-beta.solana.com" }),
  policy: engine,
  store: new SqliteStore({ path: "./wallet.db" }),
});
```
