# Your First Agent Wallet

---

## What You'll Build

In this tutorial, you'll build a fully working AI agent wallet on Solana in about 15 minutes. By the end, your wallet will be able to:

- Generate a cryptographic identity on the Solana blockchain
- Enforce spending limits and rate limits through a policy engine
- Execute a SOL transfer on devnet (Solana's free test network)
- Log every transaction in a tamper-evident audit trail

You do not need any prior blockchain experience. Every concept is explained as we go.

---

## Prerequisites

Before you start, make sure you have the following installed:

| Tool | Minimum Version | Check with | Install link |
|------|----------------|------------|--------------|
| **Node.js** | 18.0 or later | `node --version` | [nodejs.org/en/download](https://nodejs.org/en/download) |
| **npm** | 9.0 or later (comes with Node.js) | `npm --version` | Included with Node.js |
| **TypeScript** | 5.0 or later | `npx tsc --version` | Installed in Step 1 below |

You will also need a terminal (Terminal on macOS, PowerShell or WSL on Windows, or any Linux shell).

No Solana CLI tools are required for this tutorial -- the kova SDK handles all blockchain communication for you.

---

## Step 1: Install kova

Create a new project directory and install the SDK:

```bash
# Create a new directory for the project and navigate into it.
mkdir my-agent-wallet
cd my-agent-wallet

# Initialize a new Node.js project with default settings (creates package.json).
npm init -y

# Install runtime dependencies:
#   @kova-sdk/wallet    - The agent wallet SDK (policy engine, signers, chain adapters)
#   @solana/web3.js - Solana's JavaScript client library (also bundled with @kova-sdk/wallet,
#                     but listed explicitly here for direct Keypair usage)
npm install @kova-sdk/wallet @solana/web3.js

# Install development dependencies:
#   typescript     - The TypeScript compiler
#   ts-node        - Runs TypeScript files directly without a separate build step
#   @types/node    - TypeScript type definitions for Node.js built-in modules
npm install -D typescript ts-node @types/node

# Generate a tsconfig.json with sensible defaults for TypeScript compilation.
# You may want to adjust "target", "module", and "moduleResolution" afterward
# (see the Installation guide for recommended settings).
npx tsc --init
```

**Expected output:**

```
Wrote to /path/to/my-agent-wallet/package.json
added 12 packages in 3s
added 3 packages in 1s
Successfully created a tsconfig.json file.
```

::: details Troubleshooting: Installation issues
**If you see `npm ERR! code EACCES`** -- You have a permissions issue. Try running with `sudo` or, better yet, [fix your npm permissions](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally).

**If you see `Cannot find module '@kova-sdk/wallet'` later** -- Make sure you ran `npm install @kova-sdk/wallet` from inside the `my-agent-wallet` directory (not from your home directory). Run `ls node_modules/@kova-sdk/wallet` to verify the package is installed.

**If `npx tsc --init` fails** -- Make sure TypeScript is installed as a dev dependency: `npm install -D typescript`.
:::

## Step 2: Create the TypeScript File

Create a file called `first-wallet.ts` in your project root. This will contain all of our code.

```bash
# Create an empty TypeScript file where we will write all the wallet code.
touch first-wallet.ts
```

Now open `first-wallet.ts` in your favorite code editor (VS Code, Vim, Nano -- whatever you prefer). Let's start building.

## Step 3: Import Everything Needed

Open `first-wallet.ts` and add the following imports:

```typescript
// Keypair: Solana's cryptographic key pair (public key + secret key).
// Used to generate or load the wallet's identity on the Solana blockchain.
import { Keypair } from "@solana/web3.js";

// Import all kova components needed for this tutorial:
import {
  AgentWallet,        // The top-level wallet object that your AI agent interacts with
  LocalSigner,        // Signs transactions using a Solana Keypair stored in local memory
  MemoryStore,        // In-memory implementation of the Store interface (dev/testing only)
  SolanaAdapter,      // Chain adapter for Solana: builds, signs, and broadcasts transactions
  Policy,             // Fluent builder for creating policy configurations declaratively
} from "@kova-sdk/wallet";
```

These imports cover:

- **Keypair** -- Solana <Term id="keypair" /> generation from `@solana/web3.js`
- **AgentWallet** -- The main wallet class your agent interacts with
- **LocalSigner** -- Signs transactions using a local <Term id="private-key">private key</Term>
- **MemoryStore** -- In-memory state storage (good for development)
- **SolanaAdapter** -- Connects to the Solana blockchain
- **Policy** -- Fluent builder for creating policy configurations declaratively

::: details What just happened?
We imported six building blocks from two packages. Think of these as Lego pieces: each one has a single job, and we are going to snap them together into a working wallet. You do not need to memorize every import right now -- each one will be explained when we use it.
:::

## Step 4: Generate a Solana Keypair

Generate a fresh keypair for your agent. In production you would load an existing key from a secure store.

A **keypair** is a pair of cryptographic keys: a **public key** (your wallet's address on the blockchain, like a bank account number -- safe to share) and a **private key** (the secret that lets you authorize transactions -- never share this).

```typescript
// Generate a fresh, random Solana keypair (32-byte secret key + 32-byte public key).
// The public key becomes the wallet's address on the Solana network.
// WARNING: This keypair is ephemeral -- it exists only in memory for this demo.
// In production, load a keypair from a secure store (env var, KMS, HSM).
const keypair = Keypair.generate();

// Print the public key in base58 encoding (Solana's standard address format).
// You will need this address to fund the wallet via airdrop or faucet.
console.log("Agent public key:", keypair.publicKey.toBase58());
```

::: warning
Never commit private keys to source control. In production, load keys from environment variables or a secrets manager. This tutorial generates an ephemeral keypair for demonstration purposes only.
:::

## Step 5: Create a LocalSigner

The <Term id="signer" /> is responsible for cryptographically signing transactions before they are submitted to the network. Signing is how the blockchain knows that *you* authorized a transaction -- it is the digital equivalent of your signature on a check.

```typescript
// Wrap the raw Keypair in a LocalSigner, which implements the Signer interface.
// The Signer interface exposes: getAddress(), sign(transaction), healthCheck(), destroy(), and toJSON().
// LocalSigner holds the private key in memory -- suitable for development only.
// In production, consider an MPC signer or hardware security module (HSM).
const signer = new LocalSigner(keypair, { network: "devnet" }); // Dev-only; throws in production unless KOVA_ALLOW_LOCAL_SIGNER=1
```

## Step 6: Create a MemoryStore

The <Term id="store" /> holds policy state such as spending counters, rate limit windows, and <Term id="audit-log">audit logs</Term>. `MemoryStore` keeps everything in memory and is ideal for development and testing.

```typescript
// MemoryStore implements the Store interface with 7 methods:
//   get(key), set(key, value), setIfNotExists(key, value), increment(key, amount),
//   append(key, entry), getRecent(key, n), clearList(key)
// It holds spending counters, rate limit windows, audit log entries, and idempotency
// caches in JavaScript Maps. All data is lost when the process exits.
// For production, switch to SqliteStore for persistence across restarts.
const store = new MemoryStore({ dangerouslyAllowInProduction: true }); // Dev-only; throws in production unless KOVA_ALLOW_MEMORY_STORE=1
```

::: details Checkpoint -- Steps 3 through 6
At this point, your `first-wallet.ts` file should have:
1. Two import statements at the top (one for `@solana/web3.js`, one for `@kova-sdk/wallet`)
2. A `keypair` variable created by `Keypair.generate()`
3. A `console.log` printing the public key
4. A `signer` variable wrapping the keypair
5. A `store` variable created by `new MemoryStore({ dangerouslyAllowInProduction: true })`

If you see red squiggly lines in your editor, make sure you ran `npm install @kova-sdk/wallet @solana/web3.js` and that your `tsconfig.json` exists. A common fix is to set `"moduleResolution": "node"` in `tsconfig.json`.
:::

## Step 7: Create a SolanaAdapter

The <Term id="chain-adapter">chain adapter</Term> handles all blockchain-specific operations: submitting transactions, querying balances, and checking transaction status. Think of it as the bridge between your code and the Solana network.

**Devnet** is Solana's test network. It works exactly like the real Solana network (called "mainnet"), but the SOL tokens on it have no real-world value. It is free to use and perfect for learning.

```typescript
// SolanaAdapter implements the ChainAdapter interface and handles all
// Solana-specific logic: building transactions, broadcasting them to the
// network, querying account balances, and validating addresses.
const chain = new SolanaAdapter({
  rpcUrl: "https://api.devnet.solana.com",  // The Solana JSON-RPC endpoint to connect to.
                                             // Devnet is a free test network with no real funds.
  network: "devnet",                         // Network identifier used for address validation and logging.
  commitment: "confirmed",                   // Confirmation level to wait for after broadcasting.
                                             // "confirmed" means 2/3+ of validators have confirmed
                                             // the transaction (~400ms). Other options: "finalized"
                                             // (slower but more certain) or "processed" (fastest, less safe).
});
```

::: tip
For local development, you can also use `http://localhost:8899` if you have a local Solana test validator running via `solana-test-validator`.
:::

::: details Troubleshooting: RPC connection issues
**If you see `FetchError` or `ECONNREFUSED` later** -- The Solana devnet RPC endpoint may be temporarily down or rate-limited. Wait a minute and try again, or use an alternative free RPC endpoint like `https://rpc.ankr.com/solana_devnet`.

**If transactions are very slow** -- The public devnet RPC is rate-limited. For faster development, consider running a local test validator with `solana-test-validator` and using `http://localhost:8899` as your `rpcUrl`.
:::

## Step 8: Build a Policy

Use the `Policy.create()` builder to define what your agent is allowed to do. Here we set a per-transaction spending limit, a daily spending limit, and a rate limit.

A **policy** is a set of rules that act as guardrails for your AI agent. Before any transaction goes through, the policy engine checks every rule. If any rule says "no," the transaction is blocked -- even if the agent tries to send it. This is the key safety mechanism in kova.

```typescript
// Use the fluent Policy builder to define the agent's constraints declaratively.
// Each chained method adds a rule configuration. The builder validates inputs
// and produces a serializable PolicyConfig when .build() is called.
const policy = Policy.create("first-wallet-policy")  // Name identifies this policy in logs and UI
  .spendingLimit({
    perTransaction: { amount: "1.0", token: "SOL" },  // No single transaction can exceed 1 SOL
    daily: { amount: "5.0", token: "SOL" },            // Cumulative spending capped at 5 SOL per 24h
  })
  .rateLimit({
    maxTransactionsPerMinute: 5,  // At most 5 transactions in any rolling 60-second window
  })
  .build();  // Finalize the policy -- it is now immutable

// Inspect the policy we just created.
// getName() returns the identifier string passed to Policy.create().
console.log("Policy name:", policy.getName());
// toJSON() serializes the policy to a plain object, useful for storage or inspection.
console.log("Policy config:", JSON.stringify(policy.toJSON(), null, 2));
```

This policy enforces:
- Maximum 1 <Term id="sol">SOL</Term> per transaction
- Maximum 5 SOL per day
- Maximum 5 transactions per minute

::: details What just happened?
You just defined the safety boundaries for your agent. The `Policy.create()` builder uses a "fluent" pattern -- you chain method calls together (`.spendingLimit(...)`, `.rateLimit(...)`, `.build()`), which reads almost like English. Once `.build()` is called, the policy is locked and cannot be changed. This immutability is a deliberate safety feature.
:::

## Step 9: Create the AgentWallet

Now we have all the pieces ready. The `Policy` object built in Step 8 is passed directly to `AgentWallet` -- you do not need to manually create rule instances or a `PolicyEngine`. The wallet handles that internally.

```typescript
// AgentWallet is the single object your AI agent interacts with.
// It wires together all the components and exposes a clean API:
//   execute(intent)          - Run the full transaction pipeline
//   getBalance(token)        - Query token balance on-chain
//   getAddress()             - Get the wallet's public address
//   getPolicy()              - Get a summary of active policy rules
//   getTransactionHistory(n) - Retrieve recent audit log entries
const wallet = new AgentWallet({
  signer,                          // Signs transactions before they are broadcast to the network
  chain,                           // Builds and broadcasts Solana transactions via RPC
  policy,                          // Policy object with spending limits and rate limits
  store,                           // Shared state store used by the engine, logger, and idempotency cache
  dangerouslyDisableAuth: true,    // Disable auth for this tutorial (do NOT use in production)
});
```

::: details Checkpoint -- Steps 7 through 9
You now have all the core components created. Your file should contain:
- `chain` -- a `SolanaAdapter` pointing at devnet
- `policy` -- a built policy with spending and rate limits
- `wallet` -- an `AgentWallet` that ties everything together

If TypeScript shows an error, make sure your `.spendingLimit()` and `.rateLimit()` calls in Step 8 are present and that you called `.build()` at the end.
:::

## Step 11: Check the Balance

Let us verify the wallet is working by checking the SOL balance. Everything from here on goes inside an `async function main()` because we need to `await` blockchain calls.

```typescript
async function main() {
  // Query the wallet's native SOL balance from the Solana blockchain.
  // getBalance() calls the chain adapter, which makes an RPC request to the
  // Solana node. It returns { amount: string, token: string, decimals: number }.
  // This is a read-only operation -- it does NOT go through the policy engine.
  const balance = await wallet.getBalance("SOL");
  console.log("SOL balance:", balance.amount, balance.token);
  // Expected output: SOL balance: 0 SOL
  // (New devnet wallets start with 0 SOL. Use `solana airdrop 2` to fund it.)

  // Retrieve the wallet's Solana public address (base58-encoded).
  // This delegates to signer.getAddress() under the hood.
  const address = await wallet.getAddress();
  console.log("Wallet address:", address);
```

**Expected output:**

```
SOL balance: 0 SOL
Wallet address: 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU   (yours will be different)
```

::: details What just happened?
The `getBalance()` call reached out to the Solana devnet network over the internet and checked how much SOL your wallet address holds. Since we just generated a brand new keypair, the balance is 0. The `getAddress()` call simply returned your wallet's public address in base58 format (Solana's standard address encoding -- a string of letters and numbers).
:::

::: tip
To fund your devnet wallet, run:
```bash
# Request 2 SOL from the Solana devnet faucet to fund your new wallet.
# Replace <YOUR_WALLET_ADDRESS> with the base58 address printed above.
# The --url flag targets devnet (test network with free, valueless SOL).
solana airdrop 2 <YOUR_WALLET_ADDRESS> --url devnet
```
You will need the Solana CLI for this. Install it from [docs.solanalabs.com/cli/install](https://docs.solanalabs.com/cli/install). Alternatively, visit [faucet.solana.com](https://faucet.solana.com), paste your address, and request devnet SOL through the web interface.
:::

::: details Troubleshooting: Balance is always 0
**If your balance is 0 after airdropping** -- Make sure you are airdropping to the correct address (the one printed by `console.log("Wallet address:", address)`). Also make sure you are targeting devnet (use `--url devnet`).

**If the airdrop command fails with "Too many requests"** -- The devnet faucet is rate-limited. Wait 30 seconds and try again, or use the [web faucet](https://faucet.solana.com).

**If you see `Error: connect ECONNREFUSED`** -- Your machine cannot reach the Solana devnet RPC. Check your internet connection and firewall settings.
:::

## Step 12: View Policy Summary

Inspect what the active policy allows.

```typescript
  // getPolicy() returns a structured summary of the active policy rules.
  // It aggregates information from all rules in the PolicyEngine,
  // including spending limits, rate limits, allowlists, and approval gates.
  // This is a read-only operation -- no policy evaluation happens.
  const policySummary = await wallet.getPolicy();
  console.log("Active policy:", JSON.stringify(policySummary, null, 2));
  // Expected output:
  // {
  //   "name": "spending-limit+rate-limit",
  //   "spendingLimits": {
  //     "perTransaction": { "amount": "1.0", "token": "SOL" },
  //     "daily": { "amount": "5.0", "token": "SOL" }
  //   },
  //   "rateLimits": { "maxPerMinute": 5 }
  // }
```

**Expected output:**

```json
Active policy: {
  "name": "spending-limit+rate-limit",
  "spendingLimits": {
    "perTransaction": { "amount": "1.0", "token": "SOL" },
    "daily": { "amount": "5.0", "token": "SOL" }
  },
  "rateLimits": { "maxPerMinute": 5 }
}
```

Great -- the policy is active and matches exactly what we configured in Step 8. The wallet will enforce these rules automatically on every transaction.

## Step 13: Execute a Transfer

Now for the exciting part -- let's send some SOL. The policy engine will evaluate the <Term id="transaction-intent">intent</Term> (a description of what you want to do) before the transaction is signed and submitted.

An **intent** is a plain object that describes *what* you want to happen (send 0.01 SOL to this address), without worrying about *how* the blockchain transaction is constructed. The SDK handles all the low-level details.

::: details Troubleshooting: Before you send
**If your balance is 0** -- You need to fund your wallet first. See the tip in Step 11 for how to airdrop devnet SOL.

**If you skip funding** -- The transfer will go through the policy engine (which will allow it) but fail at the blockchain level with an "Insufficient balance" error. This is expected behavior -- the policy engine checks rules, not your balance.
:::

```typescript
  // Execute a SOL transfer. wallet.execute() runs the full 10-step pipeline:
  // validate → normalize → idempotency → audit circuit → tx circuit breaker →
  // policy evaluation → build tx → sign → broadcast → audit log + return.
  const result = await wallet.execute({
    type: "transfer",   // Intent type: a simple token transfer
    chain: "solana",    // Target blockchain
    params: {
      to: "11111111111111111111111111111111",  // Solana System Program address (used as a test recipient)
      amount: "0.01",                          // Transfer 0.01 SOL (well within our 1 SOL per-tx limit)
      token: "SOL",                            // Native SOL token
    },
    // Note: no metadata provided here, but the audit log will still record
    // the intent with an auto-generated UUID and timestamp.
  });

  // TransactionResult is a discriminated union on the status field:
  //   status   - "confirmed" | "denied" | "failed" | "pending"
  //   txId     - Solana transaction signature (only present when status is "confirmed")
  //   summary  - Human-readable description of what happened
  //   intentId - UUID that uniquely identifies this intent (for idempotency)
  console.log("Transfer status:", result.status);
  console.log("Transaction ID:", result.txId);
  console.log("Summary:", result.summary);
  // Expected output (if funded):
  //   Transfer status: confirmed
  //   Transaction ID: 5Uj7...abc
  //   Summary: Transferred 0.01 SOL to 1111...1111
  //
  // Expected output (if not funded):
  //   Transfer status: failed
  //   Error: Insufficient balance
```

**Expected output (if your wallet is funded):**

```
Transfer status: confirmed
Transaction ID: 5Uj7Kx...abc    (a long base58 string -- yours will be different)
Summary: Transferred 0.01 SOL to 1111...1111
```

**Expected output (if your wallet is NOT funded):**

```
Transfer status: failed
Transaction ID: undefined
Summary: Transfer failed: Insufficient balance
```

Both outcomes are correct. The important thing is that the policy engine evaluated and *allowed* the intent before it reached the blockchain. The failure (if it happens) is a blockchain-level issue, not a policy issue.

::: details What just happened?
When you called `wallet.execute()`, a 10-step pipeline ran behind the scenes:
1. The intent was validated (correct structure, required fields present)
2. The `SpendingLimitRule` checked that 0.01 SOL is under the 1 SOL per-transaction limit -- pass
3. The `SpendingLimitRule` checked that 0.01 SOL is under the 5 SOL daily limit -- pass
4. The `RateLimitRule` checked that you have not exceeded 5 transactions per minute -- pass
5. The `SolanaAdapter` built a raw Solana transaction
6. The `LocalSigner` signed it with your private key
7. The `SolanaAdapter` broadcast the signed transaction to the Solana devnet
8. The network confirmed (or rejected) the transaction
9. The `AuditLogger` recorded the result
10. The result was returned to your code

All of this happened in a single `await wallet.execute()` call.
:::

::: details Checkpoint -- Steps 11 through 13
At this point, you have run your wallet's first transaction. Your terminal should show:
- The SOL balance (likely 0 or 2, depending on whether you airdropped)
- The wallet address
- The active policy as JSON
- The transfer status (either "confirmed" or "failed")

If you see `Transfer status: denied`, that means a policy rule rejected the transaction. Check that your `amount` is under 1 SOL and that you have not exceeded 5 transactions per minute.
:::

## Step 14: Check the Result

The `TransactionResult` object contains everything you need.

```typescript
  // Handle each possible transaction outcome.
  // The status field tells you what happened at a high level:
  if (result.status === "confirmed") {
    // SUCCESS: The transaction was allowed by all policy rules, signed,
    // broadcast to Solana, and confirmed by the network.
    console.log("Transaction confirmed at:", result.timestamp);
    console.log("Intent ID:", result.intentId);
  } else if (result.status === "denied") {
    // DENIED: One of the policy rules (spending limit, rate limit, allowlist,
    // time window, or approval gate) rejected the intent before it was signed.
    // The error field is a TransactionError object with .code and .message properties.
    console.log("Policy denied the transaction:", result.error.code, result.error.message);
  } else if (result.status === "failed") {
    // FAILED: The policy allowed the intent, but the on-chain transaction failed.
    // Common causes: insufficient balance, network error, or transaction timeout.
    console.log("Transaction failed:", result.error.code, result.error.message);
  }
```

**Expected output (if confirmed):**

```
Transaction confirmed at: 1705312200000
Intent ID: a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

::: details Troubleshooting: Transaction failures
**If the transaction is "denied"** -- A policy rule blocked it. The `result.error` field will tell you which rule and why (e.g., `SPENDING_LIMIT_EXCEEDED` or `RATE_LIMIT_EXCEEDED`). Check that your amount is under 1 SOL and that you have not sent more than 5 transactions in the last minute.

**If the transaction "failed"** -- The policy allowed it, but the blockchain rejected it. Common causes:
- **Insufficient balance** -- Airdrop more devnet SOL (see Step 11).
- **Network timeout** -- The Solana devnet can be slow during high traffic. Try again.
- **Invalid recipient address** -- Make sure the `to` address is a valid base58-encoded Solana address (32 bytes).

**If you see `ECONNREFUSED` or `FetchError`** -- Check your `rpcUrl` in Step 7. Make sure it is `https://api.devnet.solana.com` (not `http://`).
:::

## Step 15: View Transaction History

Retrieve recent transactions from the audit log.

```typescript
  // Retrieve the last 10 entries from the audit log.
  // Each entry represents a transaction attempt (confirmed, denied, or failed)
  // and includes status, summary, timestamp, txId, intentId, and error fields.
  // This data comes from the Store, so it persists only as long as the store does
  // (in-memory for MemoryStore, permanent for SqliteStore).
  const history = await wallet.getTransactionHistory(10);
  console.log(`\nTransaction history (${history.length} entries):`);
  for (const tx of history) {
    console.log(`  [${tx.status}] ${tx.summary} (${tx.timestamp})`);
  }
  // Expected output:
  //   Transaction history (1 entries):
  //     [confirmed] Transferred 0.01 SOL to 1111...1111 (1705312200000)
}

// Entry point: run the async main function and log any unhandled errors.
main().catch(console.error);
```

**Expected output:**

```
Transaction history (1 entries):
  [confirmed] Transferred 0.01 SOL to 1111...1111 (1705312200000)
```

If the transfer failed earlier due to insufficient funds, you will see `[failed]` instead of `[confirmed]`. Either way, the audit log recorded the attempt -- this is by design. Every transaction attempt is logged, whether it succeeded or not.

## Running the Complete Tutorial

Now let's run the whole thing. Save your file and execute it:

```bash
npx ts-node first-wallet.ts
```

**Expected output (full run):**

```
Agent public key: 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
Policy name: first-wallet-policy
Policy config: {
  "spendingLimit": {
    "perTransaction": { "amount": "1.0", "token": "SOL" },
    "daily": { "amount": "5.0", "token": "SOL" }
  },
  "rateLimit": {
    "maxTransactionsPerMinute": 5
  }
}
SOL balance: 0 SOL
Wallet address: 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
Active policy: { ... }
Transfer status: failed
Transaction ID: undefined
Summary: Transfer failed: Insufficient balance

Transaction history (1 entries):
  [failed] Transfer failed: Insufficient balance (1705312200000)
```

That is completely normal for a first run with no funding. To see a fully successful transfer, airdrop devnet SOL to the printed wallet address and run again.

::: details Troubleshooting: Runtime errors
**If you see `SyntaxError: Cannot use import statement outside a module`** -- Your `tsconfig.json` may have incompatible settings. Make sure `"module"` is set to `"commonjs"` and `"esModuleInterop"` is set to `true`.

**If you see `TypeError: Cannot read properties of undefined`** -- Check that you called `.build()` on the policy in Step 8. Without `.build()`, the policy object is incomplete.

**If the script hangs without output** -- The RPC connection to Solana devnet might be timing out. Wait 30 seconds. If it is still hanging, press Ctrl+C and try again.
:::

## Full Working Code

Here is the complete `first-wallet.ts` file:

```typescript
// Import Solana's Keypair for wallet identity generation.
import { Keypair } from "@solana/web3.js";
// Import all kova components needed for a complete agent wallet.
import {
  AgentWallet,        // Top-level wallet that orchestrates the full transaction pipeline
  LocalSigner,        // Signs transactions using an in-memory Solana Keypair
  MemoryStore,        // In-memory state store for dev/testing (not persistent)
  SolanaAdapter,      // Chain adapter that builds and broadcasts Solana transactions
  Policy,             // Fluent builder for creating policy configurations
} from "@kova-sdk/wallet";

async function main() {
  // 1. Generate a keypair (use a stored key in production)
  // Creates a new random Solana keypair for this demo session.
  const keypair = Keypair.generate();
  console.log("Agent public key:", keypair.publicKey.toBase58());

  // 2. Create core components
  // LocalSigner wraps the keypair to implement the Signer interface.
  const signer = new LocalSigner(keypair, { network: "devnet" }); // Dev-only; throws in production unless KOVA_ALLOW_LOCAL_SIGNER=1
  // MemoryStore holds spending counters, rate limits, and audit entries in memory.
  const store = new MemoryStore({ dangerouslyAllowInProduction: true }); // Dev-only; throws in production unless KOVA_ALLOW_MEMORY_STORE=1
  // SolanaAdapter connects to devnet for building and broadcasting transactions.
  const chain = new SolanaAdapter({
    rpcUrl: "https://api.devnet.solana.com",  // Devnet RPC endpoint (free, rate-limited)
    network: "devnet",                         // Network identifier used for address validation and logging
    commitment: "confirmed",                   // Wait for supermajority confirmation
  });

  // 3. Build a policy using the fluent builder
  // Defines what the agent is allowed to do: spending caps and rate limits.
  const policy = Policy.create("first-wallet-policy")
    .spendingLimit({
      perTransaction: { amount: "1.0", token: "SOL" },  // Max 1 SOL per transaction
      daily: { amount: "5.0", token: "SOL" },            // Max 5 SOL per 24-hour period
    })
    .rateLimit({
      maxTransactionsPerMinute: 5,  // Max 5 transactions in any rolling 60-second window
    })
    .build();  // Finalize the immutable Policy object

  console.log("Policy:", policy.getName());

  // 4. Create the wallet
  // AgentWallet is the single entry point for your AI agent.
  // It wires together signer, chain, policy, and store internally.
  const wallet = new AgentWallet({
    signer,                          // Signs transactions with the local keypair
    chain,                           // Interacts with Solana via RPC
    policy,                          // Policy object with spending and rate limits
    store,                           // Shared state for counters, logs, and caches
    dangerouslyDisableAuth: true,    // Disable auth for this tutorial (do NOT use in production)
  });

  // 5. Check balance (read-only, does not go through policy engine)
  const balance = await wallet.getBalance("SOL");
  console.log("SOL balance:", balance.amount, balance.token);
  // Output: SOL balance: 0 SOL

  // 6. View wallet address (read-only, delegates to signer.getAddress())
  const address = await wallet.getAddress();
  console.log("Wallet address:", address);

  // 7. View policy summary (read-only, aggregates info from all rules)
  const policySummary = await wallet.getPolicy();
  console.log("Active policy:", JSON.stringify(policySummary, null, 2));

  // 8. Execute a transfer through the full pipeline
  // The intent describes "what" -- the SDK handles "how" (building the Solana tx).
  const result = await wallet.execute({
    type: "transfer",                                  // Operation type
    chain: "solana",                                   // Target blockchain
    params: {
      to: "11111111111111111111111111111111",          // System Program address (test recipient)
      amount: "0.01",                                  // 0.01 SOL (within the 1 SOL per-tx limit)
      token: "SOL",                                    // Native SOL token
    },
  });

  console.log("Transfer status:", result.status);
  console.log("Transaction ID:", result.txId);
  console.log("Summary:", result.summary);

  // 9. Handle result based on status
  if (result.status === "confirmed") {
    console.log("Confirmed at:", result.timestamp);                   // Transaction landed on-chain (number)
  } else if (result.status === "denied") {
    console.log("Denied:", result.error.code, result.error.message);  // Policy rule rejected the intent
  } else if (result.status === "failed") {
    console.log("Failed:", result.error.code, result.error.message);  // Allowed by policy but failed on-chain
  }

  // 10. View transaction history from the audit log
  const history = await wallet.getTransactionHistory(10);
  console.log(`\nTransaction history (${history.length} entries):`);
  for (const tx of history) {
    console.log(`  [${tx.status}] ${tx.summary} (${tx.timestamp})`);
  }
}

// Run the async main function; log any unhandled errors to the console.
main().catch(console.error);
```

## What to Try Next

Congratulations -- you have a working agent wallet. Here are three challenges to deepen your understanding:

1. **Test the spending limit.** Change the `amount` in your transfer to `"2.0"` (above the 1 SOL per-transaction limit) and run the script again. You should see `Transfer status: denied` with `SPENDING_LIMIT_EXCEEDED`. This proves the policy engine is protecting your wallet.

2. **Hit the rate limit.** Add a loop that calls `wallet.execute()` six times in rapid succession (more than the 5-per-minute limit). Watch the sixth transaction get denied with `RATE_LIMIT_EXCEEDED`. Try adding a 15-second delay between batches to see the limit reset.

3. **Switch to persistent storage.** Replace `new MemoryStore({ dangerouslyAllowInProduction: true })` with `new SqliteStore({ path: "./wallet.db" })` (you will need to install the `better-sqlite3` package). Run the script twice and notice that the transaction history persists across runs. This is what you would use in production.

## Next Steps

Now that you have a working wallet, you can:

- [Build a Payment Agent with Claude](/tutorials/payment-agent) -- Connect your wallet to an AI assistant
- [Explore the Policy Cookbook](/tutorials/policy-cookbook) -- Learn advanced policy configurations
- [Add Approval Gates](/guide/rules/approval-gate) -- Add human-in-the-loop oversight with CallbackApprovalChannel or WebhookApprovalChannel
- [Deploy to Production](/tutorials/production) -- Harden your setup for real use
