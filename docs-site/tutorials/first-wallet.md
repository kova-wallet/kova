# Your First Agent Wallet

This tutorial walks you through creating your first agent wallet from scratch. By the end, you will have a working wallet that can check balances, enforce spending policies, and execute transfers on Solana <Term id="devnet" />.

## Prerequisites

- Node.js 18 or later
- TypeScript 5.0 or later
- A terminal with npm or yarn

## Step 1: Install kova

Create a new project directory and install the SDK:

```bash
mkdir my-agent-wallet
cd my-agent-wallet
npm init -y
npm install kova @solana/web3.js
npm install -D typescript ts-node @types/node
npx tsc --init
```

## Step 2: Create the TypeScript File

Create a file called `first-wallet.ts` in your project root. This will contain all of our code.

```bash
touch first-wallet.ts
```

## Step 3: Import Everything Needed

Open `first-wallet.ts` and add the following imports:

```typescript
import { Keypair } from "@solana/web3.js";
import {
  AgentWallet,
  LocalSigner,
  MemoryStore,
  SolanaAdapter,
  Policy,
  SpendingLimitRule,
  RateLimitRule,
  PolicyEngine,
  AuditLogger,
} from "kova";
```

These imports cover:

- **Keypair** -- Solana <Term id="keypair" /> generation from `@solana/web3.js`
- **AgentWallet** -- The main wallet class your agent interacts with
- **LocalSigner** -- Signs transactions using a local <Term id="private-key">private key</Term>
- **MemoryStore** -- In-memory state storage (good for development)
- **SolanaAdapter** -- Connects to the Solana blockchain
- **Policy, SpendingLimitRule, RateLimitRule, PolicyEngine** -- Policy enforcement components
- **AuditLogger** -- Tamper-evident transaction logging

## Step 4: Generate a Solana Keypair

Generate a fresh keypair for your agent. In production you would load an existing key from a secure store.

```typescript
const keypair = Keypair.generate();
console.log("Agent public key:", keypair.publicKey.toBase58());
```

::: warning
Never commit private keys to source control. In production, load keys from environment variables or a secrets manager. This tutorial generates an ephemeral keypair for demonstration purposes only.
:::

## Step 5: Create a LocalSigner

The <Term id="signer" /> is responsible for cryptographically signing transactions before they are submitted to the network.

```typescript
const signer = new LocalSigner(keypair);
```

## Step 6: Create a MemoryStore

The <Term id="store" /> holds policy state such as spending counters, rate limit windows, and <Term id="audit-log">audit logs</Term>. `MemoryStore` keeps everything in memory and is ideal for development and testing.

```typescript
const store = new MemoryStore();
```

## Step 7: Create a SolanaAdapter

The <Term id="chain-adapter">chain adapter</Term> handles all blockchain-specific operations: submitting transactions, querying balances, and checking transaction status.

```typescript
const chain = new SolanaAdapter({
  rpcUrl: "https://api.devnet.solana.com",
  commitment: "confirmed",
});
```

::: tip
For local development, you can also use `http://localhost:8899` if you have a local Solana test validator running via `solana-test-validator`.
:::

## Step 8: Build a Policy

Use the `Policy.create()` builder to define what your agent is allowed to do. Here we set a per-transaction spending limit, a daily spending limit, and a rate limit.

```typescript
const policy = Policy.create("first-wallet-policy")
  .spendingLimit({
    perTransaction: { amount: "1.0", token: "SOL" },
    daily: { amount: "5.0", token: "SOL" },
  })
  .rateLimit({
    maxTransactionsPerMinute: 5,
  })
  .build();

console.log("Policy name:", policy.getName());
console.log("Policy config:", JSON.stringify(policy.toJSON(), null, 2));
```

This policy enforces:
- Maximum 1 <Term id="sol">SOL</Term> per transaction
- Maximum 5 SOL per day
- Maximum 5 transactions per minute

## Step 9: Create Rule Instances and PolicyEngine

Extract the policy configuration and create concrete <Term id="policy-rule">rule instances</Term>. Then assemble them into a <Term id="policy-engine">`PolicyEngine`</Term> that evaluates every transaction against all rules.

```typescript
const config = policy.toJSON();

const rules = [
  new SpendingLimitRule(config.spendingLimit!),
  new RateLimitRule(config.rateLimit!),
];

const engine = new PolicyEngine(rules, store);
```

## Step 10: Create the AgentWallet

Now combine all the pieces into an `AgentWallet`. This is the single object your AI agent interacts with.

```typescript
const logger = new AuditLogger(store);

const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  logger,
});
```

## Step 11: Check the Balance

Let us verify the wallet is working by checking the SOL balance.

```typescript
async function main() {
  // Check balance
  const balance = await wallet.getBalance("SOL");
  console.log("SOL balance:", balance.amount, balance.token);
  // Expected output: SOL balance: 0 SOL
  // (New devnet wallets start with 0 SOL. Use `solana airdrop 2` to fund it.)

  const address = await wallet.getAddress();
  console.log("Wallet address:", address);
```

::: tip
To fund your devnet wallet, run:
```bash
solana airdrop 2 <YOUR_WALLET_ADDRESS> --url devnet
```
:::

## Step 12: View Policy Summary

Inspect what the active policy allows.

```typescript
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

## Step 13: Execute a Transfer

Send a small SOL transfer. The policy engine will evaluate the <Term id="transaction-intent">intent</Term> before the transaction is signed and submitted.

```typescript
  const result = await wallet.execute({
    type: "transfer",
    chain: "solana",
    params: {
      to: "11111111111111111111111111111111",
      amount: "0.01",
      token: "SOL",
    },
  });

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

## Step 14: Check the Result

The `TransactionResult` object contains everything you need.

```typescript
  if (result.status === "confirmed") {
    console.log("Transaction confirmed at:", result.timestamp);
    console.log("Intent ID:", result.intentId);
  } else if (result.status === "denied") {
    console.log("Policy denied the transaction:", result.error);
  } else if (result.status === "failed") {
    console.log("Transaction failed:", result.error);
  }
```

## Step 15: View Transaction History

Retrieve recent transactions from the audit log.

```typescript
  const history = await wallet.getTransactionHistory(10);
  console.log(`\nTransaction history (${history.length} entries):`);
  for (const tx of history) {
    console.log(`  [${tx.status}] ${tx.summary} (${tx.timestamp})`);
  }
  // Expected output:
  //   Transaction history (1 entries):
  //     [confirmed] Transferred 0.01 SOL to 1111...1111 (2025-01-15T10:30:00.000Z)
}

main().catch(console.error);
```

## Full Working Code

Here is the complete `first-wallet.ts` file:

```typescript
import { Keypair } from "@solana/web3.js";
import {
  AgentWallet,
  LocalSigner,
  MemoryStore,
  SolanaAdapter,
  Policy,
  SpendingLimitRule,
  RateLimitRule,
  PolicyEngine,
  AuditLogger,
} from "kova";

async function main() {
  // 1. Generate a keypair (use a stored key in production)
  const keypair = Keypair.generate();
  console.log("Agent public key:", keypair.publicKey.toBase58());

  // 2. Create core components
  const signer = new LocalSigner(keypair);
  const store = new MemoryStore();
  const chain = new SolanaAdapter({
    rpcUrl: "https://api.devnet.solana.com",
    commitment: "confirmed",
  });

  // 3. Build a policy
  const policy = Policy.create("first-wallet-policy")
    .spendingLimit({
      perTransaction: { amount: "1.0", token: "SOL" },
      daily: { amount: "5.0", token: "SOL" },
    })
    .rateLimit({
      maxTransactionsPerMinute: 5,
    })
    .build();

  console.log("Policy:", policy.getName());

  // 4. Create rule instances and engine
  const config = policy.toJSON();
  const rules = [
    new SpendingLimitRule(config.spendingLimit!),
    new RateLimitRule(config.rateLimit!),
  ];
  const engine = new PolicyEngine(rules, store);

  // 5. Create the wallet
  const logger = new AuditLogger(store);
  const wallet = new AgentWallet({
    signer,
    chain,
    policy: engine,
    store,
    logger,
  });

  // 6. Check balance
  const balance = await wallet.getBalance("SOL");
  console.log("SOL balance:", balance.amount, balance.token);
  // Output: SOL balance: 0 SOL

  // 7. View wallet address
  const address = await wallet.getAddress();
  console.log("Wallet address:", address);

  // 8. View policy summary
  const policySummary = await wallet.getPolicy();
  console.log("Active policy:", JSON.stringify(policySummary, null, 2));

  // 9. Execute a transfer
  const result = await wallet.execute({
    type: "transfer",
    chain: "solana",
    params: {
      to: "11111111111111111111111111111111",
      amount: "0.01",
      token: "SOL",
    },
  });

  console.log("Transfer status:", result.status);
  console.log("Transaction ID:", result.txId);
  console.log("Summary:", result.summary);

  // 10. Handle result
  if (result.status === "confirmed") {
    console.log("Confirmed at:", result.timestamp);
  } else if (result.status === "denied") {
    console.log("Denied:", result.error);
  } else if (result.status === "failed") {
    console.log("Failed:", result.error);
  }

  // 11. View transaction history
  const history = await wallet.getTransactionHistory(10);
  console.log(`\nTransaction history (${history.length} entries):`);
  for (const tx of history) {
    console.log(`  [${tx.status}] ${tx.summary} (${tx.timestamp})`);
  }
}

main().catch(console.error);
```

## Next Steps

Now that you have a working wallet, you can:

- [Build a Payment Agent with Claude](/tutorials/payment-agent) -- Connect your wallet to an AI assistant
- [Explore the Policy Cookbook](/tutorials/policy-cookbook) -- Learn advanced policy configurations
- [Add Telegram Approval](/tutorials/telegram-approval) -- Add human-in-the-loop oversight
- [Deploy to Production](/tutorials/production) -- Harden your setup for real use
