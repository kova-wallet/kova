# MPC Signing with Turnkey (End-to-End)

---

## What You'll Build

In this tutorial, you'll build a fully working `MpcSigningProvider` for [Turnkey](https://www.turnkey.com/) and execute a real Solana devnet transaction using MPC signing. By the end, your agent wallet will sign transactions without the private key ever existing in your application's memory.

This tutorial uses Turnkey as the MPC backend, but the same `MpcSigningProvider` pattern works with any provider -- Lit Protocol, Fireblocks, Capsule, or your own infrastructure. The interface is the same; only the API calls change.

---

## Prerequisites

| Tool | Minimum Version | Check with |
|------|----------------|------------|
| **Node.js** | 18.0 or later | `node --version` |
| **npm** | 9.0 or later | `npm --version` |
| **TypeScript** | 5.0 or later | `npx tsc --version` |
| **Turnkey account** | Free tier | Sign up at [app.turnkey.com](https://app.turnkey.com) |

You should have completed the [Your First Agent Wallet](/tutorials/first-wallet) tutorial and understand the core components (signer, store, chain adapter, policy engine).

---

## How MPC Signing Works

In a traditional wallet (like `LocalSigner`), the private key lives in your application's memory. If your server is compromised, the key is stolen and funds are gone.

MPC signing eliminates this risk:

1. **Key generation**: Turnkey generates the private key inside a secure enclave. The key is immediately split into cryptographic shares. No single share is the full key.
2. **Signing request**: Your application sends the unsigned transaction bytes to Turnkey's API.
3. **MPC protocol**: Turnkey's secure infrastructure combines the shares to produce a valid signature -- without ever reconstructing the full key in memory.
4. **Signature returned**: Your application receives the signature bytes and assembles the signed transaction.

The private key never leaves Turnkey's infrastructure. Your application only sees the public address and signatures.

```
Your App                        Turnkey Secure Enclave
────────                        ──────────────────────
  │                                      │
  │── getAddress() ─────────────────────►│
  │◄── "7xKXtg..." ────────────────────│
  │                                      │
  │── signTransaction(unsignedTx) ─────►│
  │                           ┌──────────┤
  │                           │ MPC      │
  │                           │ Protocol │
  │                           │ (key     │
  │                           │  shares  │
  │                           │  combine)│
  │                           └──────────┤
  │◄── { signedData, signature } ───────│
  │                                      │
```

---

## Step 1: Set Up a Turnkey Account

1. Go to [app.turnkey.com](https://app.turnkey.com) and create an account
2. Create an **Organization** (this is your top-level container)
3. Create an **API key** for server-side access:
   - Navigate to **Settings** > **API Keys**
   - Create a new key pair
   - Save the **API public key** and **API private key** securely
4. Create a **Private Key** resource:
   - Navigate to **Wallets & Keys** > **Private Keys**
   - Create a new Ed25519 key (Solana uses Ed25519)
   - Note the **Private Key ID** from the dashboard

After setup, you should have these values:

```bash
TURNKEY_API_PUBLIC_KEY="your-api-public-key"
TURNKEY_API_PRIVATE_KEY="your-api-private-key"
TURNKEY_ORGANIZATION_ID="your-org-id"
TURNKEY_PRIVATE_KEY_ID="your-private-key-id"
```

::: warning
Store these credentials securely. The API private key grants signing authority over your Turnkey-managed keys. Never commit it to source control. Use environment variables or a secrets manager.
:::

---

## Step 2: Install Dependencies

```bash
# Install the Turnkey SDK packages alongside kova.
npm install @turnkey/sdk-server @turnkey/api-key-stamper
```

| Package | Purpose |
|---------|---------|
| `@turnkey/sdk-server` | Server-side Turnkey client for Node.js |
| `@turnkey/api-key-stamper` | Signs Turnkey API requests with your API key |

---

## Step 3: Create the Turnkey Provider

Create a new file `turnkey-provider.ts`:

```typescript
import type { MpcSigningProvider, MpcSignResult } from "kova";
import { Turnkey } from "@turnkey/sdk-server";
import { ApiKeyStamper } from "@turnkey/api-key-stamper";

/** Configuration for the Turnkey MPC provider */
export interface TurnkeyProviderConfig {
  /** Your Turnkey API public key */
  apiPublicKey: string;
  /** Your Turnkey API private key */
  apiPrivateKey: string;
  /** Your Turnkey organization ID */
  organizationId: string;
  /** The Turnkey private key ID to sign with */
  privateKeyId: string;
}

/**
 * MPC signing provider backed by Turnkey.
 * Implements the 3 methods that MpcSigner delegates to:
 *   - getAddress(): fetch the Solana public address from Turnkey
 *   - signTransaction(): send unsigned bytes to Turnkey for MPC signing
 *   - healthCheck(): verify the Turnkey API is reachable
 */
export class TurnkeyProvider implements MpcSigningProvider {
  // Human-readable name used in MpcSignerError messages and audit logs.
  readonly name = "turnkey";

  private readonly client: Turnkey;
  private readonly organizationId: string;
  private readonly privateKeyId: string;

  constructor(config: TurnkeyProviderConfig) {
    this.organizationId = config.organizationId;
    this.privateKeyId = config.privateKeyId;

    // Initialize the Turnkey server-side client.
    // The ApiKeyStamper signs each API request with your Turnkey API key,
    // proving your identity to the Turnkey backend.
    this.client = new Turnkey({
      apiBaseUrl: "https://api.turnkey.com",
      defaultOrganizationId: config.organizationId,
      stamper: new ApiKeyStamper({
        apiPublicKey: config.apiPublicKey,
        apiPrivateKey: config.apiPrivateKey,
      }),
    });
  }

  async getAddress(): Promise<string> {
    // Fetch the private key resource from Turnkey.
    // The response includes the derived public addresses for all supported curves.
    const response = await this.client.apiClient().getPrivateKey({
      organizationId: this.organizationId,
      privateKeyId: this.privateKeyId,
    });

    // Find the Solana address (Ed25519 curve, Solana address format).
    const solanaAddress = response.privateKey.addresses.find(
      (addr) => addr.format === "ADDRESS_FORMAT_SOLANA",
    );

    if (!solanaAddress) {
      throw new Error(
        `Turnkey private key ${this.privateKeyId} does not have a Solana address. ` +
        `Make sure the key was created with curve "CURVE_ED25519".`,
      );
    }

    return solanaAddress.address;
  }

  async signTransaction(transactionData: Uint8Array): Promise<MpcSignResult> {
    // Send the unsigned transaction bytes to Turnkey for MPC signing.
    // Turnkey's secure enclave will use the distributed key shares to
    // produce an Ed25519 signature without ever reconstructing the full key.
    const response = await this.client.apiClient().signRawPayload({
      organizationId: this.organizationId,
      signWith: this.privateKeyId,
      payload: this.toHex(transactionData),
      encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
      hashFunction: "HASH_FUNCTION_NOT_APPLICABLE",
      // Solana signs the raw transaction message -- no hashing needed.
      // The hashFunction is set to NOT_APPLICABLE because Solana's
      // Ed25519 signing already handles its own message formatting.
    });

    // Turnkey returns r and s components of the Ed25519 signature.
    // Concatenate them to form the 64-byte signature that Solana expects.
    const r = this.fromHex(response.activity.result.signRawPayloadResult!.r);
    const s = this.fromHex(response.activity.result.signRawPayloadResult!.s);
    const signature = new Uint8Array(64);
    signature.set(r, 0);
    signature.set(s, 32);

    // For Solana, the "signed data" is the original transaction bytes
    // with the signature inserted at the correct position.
    // The chain adapter handles this assembly, so we return the
    // original data alongside the raw signature.
    return {
      signedData: transactionData,
      signature,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      // "Who am I?" -- a lightweight API call that verifies:
      // 1. The API key is valid
      // 2. The Turnkey API is reachable
      // 3. The organization exists
      await this.client.apiClient().getWhoami({
        organizationId: this.organizationId,
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Convert Uint8Array to hex string (for Turnkey API) */
  private toHex(data: Uint8Array): string {
    return Array.from(data)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /** Convert hex string to Uint8Array (for parsing Turnkey response) */
  private fromHex(hex: string): Uint8Array {
    const cleaned = hex.startsWith("0x") ? hex.slice(2) : hex;
    const bytes = new Uint8Array(cleaned.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
}
```

::: details What does each method do?

| Method | Turnkey API call | What happens |
|--------|-----------------|--------------|
| `getAddress()` | `getPrivateKey()` | Fetches the key metadata including derived Solana address. No key material leaves Turnkey. |
| `signTransaction()` | `signRawPayload()` | Sends unsigned bytes. Turnkey's enclave runs the MPC protocol and returns the signature components (r, s). |
| `healthCheck()` | `getWhoami()` | Lightweight auth check. Verifies API key and org are valid. |

:::

---

## Step 4: Wire It Into the SDK

Create your main file (`turnkey-wallet.ts`):

```typescript
import {
  AgentWallet,
  MpcSigner,
  SqliteStore,
  SolanaAdapter,
  PolicyEngine,
  Policy,
  SpendingLimitRule,
  RateLimitRule,
  AuditLogger,
} from "kova";
import { TurnkeyProvider } from "./turnkey-provider";

async function main() {
  // ── 1. Create the Turnkey provider ──────────────────────────────────────
  // Load credentials from environment variables (never hardcode these).
  // ⚠️ SECURITY WARNING: For production, use a dedicated secrets manager (e.g., AWS Secrets Manager,
  // HashiCorp Vault, GCP Secret Manager) instead of environment variables. Env vars are readable
  // via /proc/[pid]/environ, `ps e`, and may leak into logging systems. The TURNKEY_API_PRIVATE_KEY
  // grants signing authority over your Turnkey-managed keys and must be protected accordingly.
  const provider = new TurnkeyProvider({
    apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY!,
    apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY!,
    organizationId: process.env.TURNKEY_ORGANIZATION_ID!,
    privateKeyId: process.env.TURNKEY_PRIVATE_KEY_ID!,
  });

  // ── 2. Wrap in MpcSigner ───────────────────────────────────────────────
  // MpcSigner adds chain validation, address caching, retries, and timeouts
  // on top of the raw provider. You configure it once; the wallet uses it
  // exactly like any other Signer implementation.
  const signer = new MpcSigner({
    provider,
    chain: "solana",
    maxRetries: 3,       // Retry transient Turnkey API errors up to 3 times
    timeoutMs: 15_000,   // Fail if a Turnkey call takes longer than 15 seconds
  });

  // ── 3. Health check ────────────────────────────────────────────────────
  // Verify Turnkey is reachable before proceeding.
  const healthy = await signer.healthCheck();
  if (!healthy) {
    console.error("Turnkey health check failed. Check your API credentials.");
    process.exit(1);
  }
  console.log("Turnkey provider is healthy.");

  // ── 4. Get the wallet address ──────────────────────────────────────────
  // This calls provider.getAddress() once, then caches the result.
  const address = await signer.getAddress();
  console.log("Wallet address (from Turnkey):", address);

  // ── 5. Set up the rest of the wallet ───────────────────────────────────
  const store = new SqliteStore({ path: "./turnkey-wallet.db" });

  const chain = new SolanaAdapter({
    rpcUrl: "https://api.devnet.solana.com",
    commitment: "confirmed",
  });

  const policy = Policy.create("turnkey-production")
    .spendingLimit({
      perTransaction: { amount: "1", token: "SOL" },
      daily: { amount: "5", token: "SOL" },
    })
    .rateLimit({ maxTransactionsPerMinute: 10 })
    .build();

  const config = policy.toJSON();
  const engine = new PolicyEngine(
    [
      new RateLimitRule(config.rateLimit!),
      new SpendingLimitRule(config.spendingLimit!),
    ],
    store,
  );

  const logger = new AuditLogger(store);

  const wallet = new AgentWallet({
    signer,          // MpcSigner backed by Turnkey -- no key in memory
    chain,
    policy: engine,
    store,
    logger,
  });

  // ── 6. Execute a transaction ───────────────────────────────────────────
  console.log("\nExecuting transfer via Turnkey MPC signing...");

  const result = await wallet.execute({
    type: "transfer",
    chain: "solana",
    params: {
      to: "11111111111111111111111111111111",
      amount: "0.001",
      token: "SOL",
    },
    metadata: {
      reason: "Testing Turnkey MPC signer integration",
      agentId: "turnkey-demo",
    },
  });

  console.log("Status:", result.status);
  console.log("Transaction ID:", result.txId);
  console.log("Summary:", result.summary);

  // ── 7. Verify in audit log ─────────────────────────────────────────────
  const history = await wallet.getTransactionHistory(5);
  console.log(`\nAudit log (${history.length} entries):`);
  for (const tx of history) {
    console.log(`  [${tx.status}] ${tx.summary}`);
  }

  // ── Cleanup ────────────────────────────────────────────────────────────
  store.close();
}

main().catch(console.error);
```

---

## Step 5: Run It

```bash
# Set your Turnkey credentials as environment variables.
export TURNKEY_API_PUBLIC_KEY="your-api-public-key"
export TURNKEY_API_PRIVATE_KEY="your-api-private-key"
export TURNKEY_ORGANIZATION_ID="your-org-id"
export TURNKEY_PRIVATE_KEY_ID="your-private-key-id"

# Run the script.
npx ts-node turnkey-wallet.ts
```

**Expected output:**

```
Turnkey provider is healthy.
Wallet address (from Turnkey): 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU

Executing transfer via Turnkey MPC signing...
Status: confirmed
Transaction ID: 5Uj7Kx...abc
Summary: Transferred 0.001 SOL to 1111...1111

Audit log (1 entries):
  [confirmed] Transferred 0.001 SOL to 1111...1111
```

::: tip FUNDING YOUR WALLET
Your Turnkey-managed wallet starts with 0 SOL on devnet. Fund it with:
```bash
solana airdrop 2 <YOUR_TURNKEY_WALLET_ADDRESS> --url devnet
```
Or use the [web faucet](https://faucet.solana.com).
:::

---

## Step 6: Test the Provider

Here is a test suite for your `TurnkeyProvider` using mocks (no live API needed):

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MpcSigner, MpcSignerError } from "kova";
import type { MpcSigningProvider, MpcSignResult } from "kova";

// Mock provider that simulates Turnkey behavior without API calls.
function createMockTurnkeyProvider(
  overrides?: Partial<MpcSigningProvider>,
): MpcSigningProvider {
  return {
    name: "turnkey",
    getAddress: vi.fn(async () => "TurnkeyAddr123456789abcdef1234567"),
    signTransaction: vi.fn(async (data: Uint8Array) => ({
      signedData: data,
      signature: new Uint8Array(64).fill(0xab),
    })),
    healthCheck: vi.fn(async () => true),
    ...overrides,
  };
}

describe("TurnkeyProvider via MpcSigner", () => {
  it("should get address from Turnkey", async () => {
    const provider = createMockTurnkeyProvider();
    const signer = new MpcSigner({ provider, chain: "solana" });

    const address = await signer.getAddress();
    expect(address).toBe("TurnkeyAddr123456789abcdef1234567");
    expect(provider.getAddress).toHaveBeenCalledOnce();
  });

  it("should cache address after first call", async () => {
    const provider = createMockTurnkeyProvider();
    const signer = new MpcSigner({ provider, chain: "solana" });

    await signer.getAddress();
    await signer.getAddress();
    // Turnkey API should only be called once.
    expect(provider.getAddress).toHaveBeenCalledOnce();
  });

  it("should sign a transaction via Turnkey", async () => {
    const provider = createMockTurnkeyProvider();
    const signer = new MpcSigner({ provider, chain: "solana" });

    const result = await signer.sign({
      chain: "solana",
      data: new Uint8Array([1, 2, 3]),
    });

    expect(result.chain).toBe("solana");
    expect(result.signature).toBeInstanceOf(Uint8Array);
    expect(result.signature.length).toBe(64);
  });

  it("should reject chain mismatch without calling Turnkey", async () => {
    const provider = createMockTurnkeyProvider();
    const signer = new MpcSigner({ provider, chain: "solana" });

    await expect(
      signer.sign({ chain: "ethereum", data: new Uint8Array([1]) }),
    ).rejects.toThrow(MpcSignerError);

    // Turnkey should never be called for a mismatched chain.
    expect(provider.signTransaction).not.toHaveBeenCalled();
  });

  it("should retry on transient Turnkey failure", async () => {
    let attempt = 0;
    const provider = createMockTurnkeyProvider({
      signTransaction: vi.fn(async (data: Uint8Array) => {
        if (attempt++ === 0) throw new Error("Turnkey 503: Service Unavailable");
        return { signedData: data, signature: new Uint8Array(64).fill(1) };
      }),
    });
    const signer = new MpcSigner({ provider, chain: "solana", maxRetries: 2 });

    const result = await signer.sign({
      chain: "solana",
      data: new Uint8Array([1, 2, 3]),
    });
    expect(result.chain).toBe("solana");
    expect(provider.signTransaction).toHaveBeenCalledTimes(2);
  });

  it("should return false from healthCheck when Turnkey is down", async () => {
    const provider = createMockTurnkeyProvider({
      healthCheck: vi.fn(async () => false),
    });
    const signer = new MpcSigner({ provider, chain: "solana" });

    expect(await signer.healthCheck()).toBe(false);
  });
});
```

---

## Adapting to Other MPC Providers

The `MpcSigningProvider` interface is the same regardless of backend. Here is a quick comparison of what changes:

| | Turnkey | Lit Protocol | Fireblocks |
|---|---|---|---|
| **SDK package** | `@turnkey/sdk-server` | `@lit-protocol/lit-node-client` | `fireblocks-sdk` |
| **`getAddress()`** | `getPrivateKey()` → extract Solana address | `getPkpAddress()` | `getVaultAccountAssetAddress()` |
| **`signTransaction()`** | `signRawPayload()` → parse r, s | `pkpSign()` → extract sig | `createTransaction()` → wait for completion |
| **`healthCheck()`** | `getWhoami()` | `connect()` | `getVaultAccounts()` |
| **Key model** | API keys + private key resources | PKPs (Programmable Key Pairs) via NFTs | Vault accounts + asset wallets |

To switch providers, you only change the class that implements `MpcSigningProvider`. The `MpcSigner` wrapper, the `AgentWallet`, and all policy rules remain untouched.

```typescript
// Turnkey
const signer = new MpcSigner({ provider: new TurnkeyProvider(config), chain: "solana" });

// Lit Protocol (same interface, different implementation)
const signer = new MpcSigner({ provider: new LitProvider(config), chain: "solana" });

// Fireblocks (same interface, different implementation)
const signer = new MpcSigner({ provider: new FireblocksProvider(config), chain: "solana" });
```

---

## Security Checklist

Before deploying your Turnkey-backed wallet to production:

- [ ] API credentials are loaded from environment variables or a secrets manager (never hardcoded)
- [ ] Turnkey API private key is stored with restricted file permissions (`chmod 600`)
- [ ] Turnkey organization has IP allowlisting enabled for API access
- [ ] The Turnkey private key resource uses Ed25519 curve (required for Solana)
- [ ] `maxRetries` is set to avoid infinite retry loops (default: 2)
- [ ] `timeoutMs` is set to avoid hanging on slow Turnkey responses (default: 30s)
- [ ] Health check is called at startup to verify connectivity before accepting transactions
- [ ] Audit logging is enabled to record every signing request and its outcome
- [ ] Store is persistent (`SqliteStore` or custom) so spending limits survive restarts

---

## See Also

- [Signers](/guide/signers) -- full reference for `MpcSigner`, `MpcSigningProvider`, and `LocalSigner`
- [Your First Agent Wallet](/tutorials/first-wallet) -- single-agent setup with `LocalSigner`
- [Production Deployment](/tutorials/production) -- hardening, monitoring, and shutdown patterns
- [Custom Store Adapter](/tutorials/custom-store) -- build a Redis store for production persistence
