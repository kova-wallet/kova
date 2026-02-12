# Building a DeFi Agent

This tutorial walks you through building an agent that can execute <Term id="token-swap">token swaps</Term> on Solana using Jupiter, check multiple token balances, and maintain a full audit trail. By the end you will have a working DeFi agent that can swap between SOL and <Term id="usdc">USDC</Term> with proper policy guardrails.

## Prerequisites

- Node.js 18 or later
- A funded Solana wallet (<Term id="mainnet" /> or devnet with liquidity)
- kova installed

```bash
npm install kova @solana/web3.js
```

::: warning
Jupiter swaps require mainnet or a devnet environment with sufficient liquidity. Most devnet tokens have no Jupiter liquidity. For production swaps, use mainnet-beta with real funds and appropriate policy limits.
:::

## Step 1: Set Up the Wallet with DeFi-Friendly Policy

Create a policy that permits swaps, has moderate spending limits, and allows interaction with DeFi programs.

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

// Load keypair from environment
const keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(process.env.SOLANA_SECRET_KEY!))
);

const signer = new LocalSigner(keypair);
const store = new MemoryStore();

// Use mainnet for real Jupiter swaps
const chain = new SolanaAdapter({
  rpcUrl: process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
  commitment: "confirmed",
  jupiterApiUrl: "https://quote-api.jup.ag/v6",
  jupiterPriceApiUrl: "https://price.jup.ag/v6",
});

const policy = Policy.create("defi-trader-policy")
  .spendingLimit({
    perTransaction: { amount: "10.0", token: "SOL" },
    daily: { amount: "100.0", token: "SOL" },
  })
  .allowPrograms([
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", // Jupiter v6
  ])
  .rateLimit({
    maxTransactionsPerMinute: 10,
  })
  .build();

const config = policy.toJSON();
const rules = [
  new SpendingLimitRule(config.spendingLimit!),
  new RateLimitRule(config.rateLimit!),
];
const engine = new PolicyEngine(rules, store);
const logger = new AuditLogger(store);

const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  logger,
});
```

## Step 2: Check SOL Balance

Before executing any swaps, verify the wallet has sufficient SOL.

```typescript
async function main() {
  const address = await wallet.getAddress();
  console.log("Wallet address:", address);

  // Check SOL balance
  const solBalance = await wallet.getBalance("SOL");
  console.log(`SOL balance: ${solBalance.amount} ${solBalance.token}`);
  console.log(`  Decimals: ${solBalance.decimals}`);
  if (solBalance.usdValue) {
    console.log(`  USD value: $${solBalance.usdValue}`);
  }
  // Output:
  //   SOL balance: 12.5 SOL
  //   Decimals: 9
  //   USD value: $2500.00
```

## Step 3: Check USDC Balance

Check the USDC balance using the <Term id="spl-token">SPL token</Term> <Term id="token-mint">mint address</Term>.

```typescript
  // USDC on Solana mainnet
  const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  const usdcBalance = await wallet.getBalance(USDC_MINT);
  console.log(`\nUSDC balance: ${usdcBalance.amount} ${usdcBalance.token}`);
  console.log(`  Decimals: ${usdcBalance.decimals}`);
  if (usdcBalance.usdValue) {
    console.log(`  USD value: $${usdcBalance.usdValue}`);
  }
  // Output:
  //   USDC balance: 150.00 USDC
  //   Decimals: 6
  //   USD value: $150.00
```

::: tip
You can pass either a token symbol (like `"SOL"`) or a mint address (like the USDC address above) to `getBalance()`. For SPL tokens, using the mint address is more reliable as symbol resolution depends on token registry availability.
:::

## Step 4: Execute a Swap -- SOL to USDC

Now execute a swap of 1 SOL to USDC via Jupiter. The swap intent uses the `"swap"` type with `fromToken`, `toToken`, `amount`, and an optional <Term id="slippage">`maxSlippage`</Term>.

```typescript
  // Swap 1 SOL to USDC
  console.log("\n--- Swapping 1 SOL -> USDC ---");
  const swapResult = await wallet.execute({
    type: "swap",
    chain: "solana",
    params: {
      fromToken: "SOL",
      toToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amount: "1.0",
      maxSlippage: 0.01, // 1% max slippage
    },
  });

  console.log("Swap status:", swapResult.status);
  console.log("Transaction ID:", swapResult.txId);
  console.log("Summary:", swapResult.summary);
  console.log("Intent ID:", swapResult.intentId);
  console.log("Timestamp:", swapResult.timestamp);
  // Output:
  //   Swap status: confirmed
  //   Transaction ID: 2nKz8...def
  //   Summary: Swapped 1.0 SOL for ~200.50 USDC via Jupiter
  //   Intent ID: intent_abc123
  //   Timestamp: 2025-01-15T14:30:00.000Z
```

The swap intent structure in detail:

```typescript
// TransactionIntent for a swap
{
  type: "swap",              // IntentType
  chain: "solana",           // ChainId
  params: {                  // SwapParams
    fromToken: "SOL",        // Source token (symbol or mint address)
    toToken: "EPjFWdd5...",  // Destination token (symbol or mint address)
    amount: "1.0",           // Amount of source token to swap
    maxSlippage: 0.01,       // Optional: max acceptable slippage (0.01 = 1%)
  },
}
```

## Step 5: Check Updated Balances

Verify the balances changed after the swap.

```typescript
  // Check updated balances
  console.log("\n--- Updated Balances ---");
  const updatedSol = await wallet.getBalance("SOL");
  console.log(`SOL: ${updatedSol.amount} (was ${solBalance.amount})`);
  // Output: SOL: 11.4995 (was 12.5) -- 1 SOL swapped + fees

  const updatedUsdc = await wallet.getBalance(USDC_MINT);
  console.log(`USDC: ${updatedUsdc.amount} (was ${usdcBalance.amount})`);
  // Output: USDC: 350.50 (was 150.00) -- received ~200.50 USDC
```

## Step 6: Execute Another Swap -- USDC Back to SOL

Swap some USDC back to SOL. Note that when swapping from a token, the `amount` refers to the `fromToken`.

```typescript
  // Swap 100 USDC back to SOL
  console.log("\n--- Swapping 100 USDC -> SOL ---");
  const reverseSwapResult = await wallet.execute({
    type: "swap",
    chain: "solana",
    params: {
      fromToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      toToken: "SOL",
      amount: "100.0",
      maxSlippage: 0.01,
    },
  });

  console.log("Swap status:", reverseSwapResult.status);
  console.log("Transaction ID:", reverseSwapResult.txId);
  console.log("Summary:", reverseSwapResult.summary);
  // Output:
  //   Swap status: confirmed
  //   Transaction ID: 7pLm3...ghi
  //   Summary: Swapped 100.0 USDC for ~0.498 SOL via Jupiter

  if (reverseSwapResult.status === "denied") {
    console.log("Denied reason:", reverseSwapResult.error);
    // Could be SPENDING_LIMIT_EXCEEDED, RATE_LIMIT_EXCEEDED,
    // PROGRAM_NOT_ALLOWED, etc.
  }
```

## Step 7: View Full Transaction History

Retrieve and display all transactions the agent has executed.

```typescript
  // View full transaction history
  const history = await wallet.getTransactionHistory(20);
  console.log(`\n=== Transaction History (${history.length} entries) ===`);

  for (const tx of history) {
    console.log(`\n[${tx.status.toUpperCase()}] ${tx.summary}`);
    console.log(`  Intent ID:  ${tx.intentId}`);
    console.log(`  Timestamp:  ${tx.timestamp}`);
    if (tx.txId) {
      console.log(`  Tx ID:      ${tx.txId}`);
      console.log(`  Explorer:   https://solscan.io/tx/${tx.txId}`);
    }
    if (tx.error) {
      console.log(`  Error:      ${tx.error}`);
    }
  }
  // Output:
  //   === Transaction History (2 entries) ===
  //
  //   [CONFIRMED] Swapped 1.0 SOL for ~200.50 USDC via Jupiter
  //     Intent ID:  intent_abc123
  //     Timestamp:  2025-01-15T14:30:00.000Z
  //     Tx ID:      2nKz8...def
  //     Explorer:   https://solscan.io/tx/2nKz8...def
  //
  //   [CONFIRMED] Swapped 100.0 USDC for ~0.498 SOL via Jupiter
  //     Intent ID:  intent_def456
  //     Timestamp:  2025-01-15T14:31:00.000Z
  //     Tx ID:      7pLm3...ghi
  //     Explorer:   https://solscan.io/tx/7pLm3...ghi
```

## Step 8: Verify Audit Log Integrity

The audit logger maintains a tamper-evident chain of entries. Verify that no entries have been modified or deleted.

```typescript
  // Verify audit log integrity
  const integrity = await logger.verifyIntegrity(20);
  console.log("\n=== Audit Integrity Report ===");
  console.log("Valid:", integrity.valid);
  console.log("Entries checked:", integrity.entriesChecked);

  if (!integrity.valid) {
    console.error("ALERT: Audit chain broken at entry:", integrity.firstBrokenAt);
    // In production, trigger an alert here
  } else {
    console.log("All audit entries are intact and unmodified.");
  }
  // Output:
  //   === Audit Integrity Report ===
  //   Valid: true
  //   Entries checked: 2
  //   All audit entries are intact and unmodified.
}

main().catch(console.error);
```

## Full Working Code

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

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

async function main() {
  // Setup
  const keypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.SOLANA_SECRET_KEY!))
  );
  const signer = new LocalSigner(keypair);
  const store = new MemoryStore();
  const chain = new SolanaAdapter({
    rpcUrl: process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
    commitment: "confirmed",
    jupiterApiUrl: "https://quote-api.jup.ag/v6",
    jupiterPriceApiUrl: "https://price.jup.ag/v6",
  });

  // Policy
  const policy = Policy.create("defi-trader-policy")
    .spendingLimit({
    perTransaction: { amount: "10.0", token: "SOL" },
    daily: { amount: "100.0", token: "SOL" },
  })
    .allowPrograms([
      "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    ])
    .rateLimit({
    maxTransactionsPerMinute: 10,
  })
    .build();

  const config = policy.toJSON();
  const rules = [
    new SpendingLimitRule(config.spendingLimit!),
    new RateLimitRule(config.rateLimit!),
  ];
  const engine = new PolicyEngine(rules, store);
  const logger = new AuditLogger(store);

  const wallet = new AgentWallet({
    signer,
    chain,
    policy: engine,
    store,
    logger,
  });

  // Check initial balances
  const address = await wallet.getAddress();
  console.log("Wallet address:", address);

  const solBalance = await wallet.getBalance("SOL");
  console.log(`SOL balance: ${solBalance.amount}`);

  const usdcBalance = await wallet.getBalance(USDC_MINT);
  console.log(`USDC balance: ${usdcBalance.amount}`);

  // Swap 1 SOL -> USDC
  console.log("\n--- Swap: 1 SOL -> USDC ---");
  const swap1 = await wallet.execute({
    type: "swap",
    chain: "solana",
    params: {
      fromToken: "SOL",
      toToken: USDC_MINT,
      amount: "1.0",
      maxSlippage: 0.01,
    },
  });
  console.log(`Status: ${swap1.status} | Tx: ${swap1.txId}`);
  console.log(`Summary: ${swap1.summary}`);

  // Check updated balances
  const updatedSol = await wallet.getBalance("SOL");
  const updatedUsdc = await wallet.getBalance(USDC_MINT);
  console.log(`\nSOL: ${updatedSol.amount} | USDC: ${updatedUsdc.amount}`);

  // Swap 100 USDC -> SOL
  console.log("\n--- Swap: 100 USDC -> SOL ---");
  const swap2 = await wallet.execute({
    type: "swap",
    chain: "solana",
    params: {
      fromToken: USDC_MINT,
      toToken: "SOL",
      amount: "100.0",
      maxSlippage: 0.01,
    },
  });
  console.log(`Status: ${swap2.status} | Tx: ${swap2.txId}`);
  console.log(`Summary: ${swap2.summary}`);

  // Transaction history
  const history = await wallet.getTransactionHistory(20);
  console.log(`\n=== History (${history.length} entries) ===`);
  for (const tx of history) {
    console.log(`[${tx.status}] ${tx.summary}`);
    if (tx.txId) console.log(`  https://solscan.io/tx/${tx.txId}`);
  }

  // Audit integrity
  const integrity = await logger.verifyIntegrity(20);
  console.log(`\nAudit integrity: ${integrity.valid ? "VALID" : "BROKEN"}`);
  console.log(`Entries checked: ${integrity.entriesChecked}`);
  if (!integrity.valid) {
    console.error(`Chain broken at entry: ${integrity.firstBrokenAt}`);
  }
}

main().catch(console.error);
```

## Error Handling for Swaps

Swaps can fail for several reasons. Here is how to handle each case:

```typescript
const result = await wallet.execute({
  type: "swap",
  chain: "solana",
  params: {
    fromToken: "SOL",
    toToken: USDC_MINT,
    amount: "5.0",
    maxSlippage: 0.005, // Very tight 0.5% slippage
  },
});

switch (result.status) {
  case "confirmed":
    console.log("Swap completed:", result.summary);
    break;

  case "denied":
    // Policy denied the swap
    console.log("Swap denied:", result.error);
    // Possible errors:
    //   SPENDING_LIMIT_EXCEEDED - Amount too high
    //   RATE_LIMIT_EXCEEDED     - Too many swaps recently
    //   PROGRAM_NOT_ALLOWED     - Jupiter not in allowPrograms
    break;

  case "failed":
    // Swap was allowed by policy but failed on-chain
    console.log("Swap failed:", result.error);
    // Possible errors:
    //   INSUFFICIENT_BALANCE   - Not enough tokens
    //   TRANSACTION_FAILED     - On-chain error (slippage, liquidity)
    //   CHAIN_ERROR            - RPC or network issue
    break;

  case "pending":
    // Should not happen for swaps without approval gates
    console.log("Swap pending (unexpected)");
    break;
}
```

## Next Steps

- [Policy Cookbook](/tutorials/policy-cookbook) -- More DeFi-specific policy configurations
- [Telegram Approval](/tutorials/telegram-approval) -- Add human oversight for large swaps
- [Production Deployment](/tutorials/production) -- Persistent storage and monitoring for DeFi agents
- [API Reference](/api/reference) -- Full SwapParams and TransactionResult documentation
