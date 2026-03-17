# Building a DeFi Agent

::: info What you'll learn
- How to build an AI agent that executes token swaps on Solana using Jupiter (the largest DEX aggregator on Solana) via custom implementation
- How to create a `swap` TransactionIntent and configure policy rules for DeFi operations
- How to check multiple token balances (SOL and SPL tokens like USDC)
- How to handle swap errors gracefully (slippage, insufficient liquidity, failed routes)
- How to maintain a tamper-evident audit trail for every swap executed
:::

This tutorial walks you through building an agent that can execute <Term id="token-swap">token swaps</Term> on Solana using Jupiter, check multiple token balances, and maintain a full audit trail. By the end you will have a working DeFi agent that can swap between SOL and <Term id="usdc">USDC</Term> with proper policy guardrails.

::: tip New to DeFi?
**DeFi** (Decentralized Finance) refers to financial services built on blockchain networks that operate without traditional intermediaries like banks. A **token swap** is the DeFi equivalent of exchanging one currency for another -- for example, trading SOL for USDC. **Jupiter** is a swap aggregator on Solana that automatically finds the best price across dozens of liquidity pools, similar to how a travel site finds the cheapest flight across multiple airlines.
:::

## Prerequisites

- **Node.js 18 or later** ([download here](https://nodejs.org/))
- **A funded Solana wallet** -- mainnet-beta with real SOL, or devnet (note: most devnet tokens have no Jupiter liquidity)
- **kova installed** in your project
- **Completed the [Your First Agent Wallet](/tutorials/first-wallet) tutorial** -- this tutorial builds on those concepts
- **About 30 minutes** to complete this tutorial

```bash
# Install kova (agent wallet SDK) and @solana/web3.js (Solana client library).
# Note: Jupiter swap integration requires custom implementation — it is not built into SolanaAdapter.
npm install @kova-sdk/wallet @solana/web3.js
```

::: warning
Jupiter swaps require mainnet or a devnet environment with sufficient liquidity. Most devnet tokens have no Jupiter liquidity. For production swaps, use mainnet-beta with real funds and appropriate policy limits.
:::

## Step 1: Set Up the Wallet with DeFi-Friendly Policy

Create a policy that permits swaps, has moderate spending limits, and allows interaction with DeFi programs.

```typescript
import { Keypair } from "@solana/web3.js";
import {
  AgentWallet,        // Top-level wallet for the DeFi agent
  LocalSigner,        // Signs transactions using an in-memory Solana Keypair
  MemoryStore,        // In-memory state store (use SqliteStore in production)
  SolanaAdapter,      // Chain adapter for Solana (Jupiter swap routing requires custom implementation)
  Policy,             // Fluent builder for policy configuration
} from "@kova-sdk/wallet";

// ⚠️ SECURITY WARNING: Environment variables are NOT safe for private keys in production.
// Keys in env vars are exposed via /proc/[pid]/environ, `ps e`, shell history, and logging systems.
// Use MpcSigner with a hardware-backed provider (e.g., Turnkey, Fireblocks) or a secrets manager instead.
// See the MPC Signing tutorial: /tutorials/turnkey-mpc
// This pattern is acceptable ONLY for local development and testing.
const keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(process.env.SOLANA_SECRET_KEY!))
);

const signer = new LocalSigner(keypair, { network: "devnet" });  // Dev-only; requires network option
const store = new MemoryStore({ dangerouslyAllowInProduction: true });  // Dev-only; not for production use

// Configure SolanaAdapter for the Solana network.
// Note: Jupiter swap routing is NOT built into SolanaAdapter. To execute swaps,
// you need to implement Jupiter API calls yourself or use a custom ChainAdapter.
// See the Jupiter API docs at https://station.jup.ag/docs for integration details.
const chain = new SolanaAdapter({
  rpcUrl: process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
    // Use mainnet-beta for real Jupiter swaps (devnet has no liquidity).
    // A custom RPC URL (e.g., Helius, QuickNode) is recommended for production
    // to avoid rate limits on the public endpoint.
  commitment: "confirmed",           // Wait for supermajority confirmation
});

// Build a DeFi-friendly policy with moderate limits and program allowlist.
const policy = Policy.create("defi-trader-policy")
  .spendingLimit({
    perTransaction: { amount: "10.0", token: "SOL" },  // Max 10 SOL per individual swap
    daily: { amount: "100.0", token: "SOL" },           // Max 100 SOL per day for active trading
  })
  .allowPrograms([
    // Restrict the agent to interacting only with the Jupiter v6 program.
    // This prevents the agent from calling arbitrary on-chain programs.
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", // Jupiter v6 aggregator
  ])
  .rateLimit({
    maxTransactionsPerMinute: 10,  // 10 swaps per minute for rapid trading
  })
  .build();

// Assemble the DeFi agent wallet.
// The wallet creates the audit logger internally — no need to instantiate it yourself.
const wallet = new AgentWallet({
  signer,         // Signs swap transactions before broadcast
  chain,          // Builds Jupiter swap transactions and broadcasts to Solana
  policy,         // Policy built via Policy.create().build() — evaluates spending and rate limits
  store,          // Shared state for counters and audit log
  dangerouslyDisableAuth: true,  // Tutorial only — disable auth for local development
});
```

## Step 2: Check SOL Balance

Before executing any swaps, verify the wallet has sufficient SOL.

```typescript
async function main() {
  // Get and display the wallet's public address.
  const address = await wallet.getAddress();
  console.log("Wallet address:", address);

  // Query the native SOL balance from the Solana blockchain.
  // getBalance("SOL") returns amount (human-readable), token name,
  // decimals (9 for SOL), and optionally a USD value if a priceProvider is configured in SolanaAdapterConfig.
  const solBalance = await wallet.getBalance("SOL");
  console.log(`SOL balance: ${solBalance.amount} ${solBalance.token}`);
  console.log(`  Decimals: ${solBalance.decimals}`);  // SOL has 9 decimal places (1 SOL = 1e9 lamports)
  if (solBalance.usdValue) {
    // USD value is provided when a priceProvider is configured in SolanaAdapterConfig.
    // This is useful for displaying portfolio value to users.
    console.log(`  USD value: $${solBalance.usdValue}`);
  }
  // Output:
  //   SOL balance: 12.5 SOL
  //   Decimals: 9
  //   USD value: $2500.00
```

**Expected output** (your values will differ based on your wallet balance and current SOL price):

```
Wallet address: 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
SOL balance: 12.5 SOL
  Decimals: 9
  USD value: $2500.00
```

::: details What just happened?
The `getBalance("SOL")` call queries behind the scenes:

1. An RPC call to your Solana node to get the native SOL balance (returned in lamports -- the smallest unit of SOL, where 1 SOL = 1,000,000,000 lamports).
2. If a `priceProvider` is configured in `SolanaAdapterConfig`, the SDK also fetches the current SOL/USD price to compute the USD value.

The SDK converted the lamport balance to a human-readable decimal number and multiplied by the current price to give you the USD value. Read operations like `getBalance` bypass the policy engine entirely -- they go directly to the chain adapter.
:::

## Step 3: Check USDC Balance

Check the USDC balance using the <Term id="spl-token">SPL token</Term> <Term id="token-mint">mint address</Term>.

```typescript
  // USDC on Solana mainnet -- identified by its SPL token mint address.
  // SPL tokens are Solana's token standard (similar to ERC-20 on Ethereum).
  // Each SPL token has a unique mint address that identifies it on-chain.
  const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  // Query the USDC balance by passing the mint address to getBalance().
  // The chain adapter looks up the associated token account for this mint
  // and returns the balance in human-readable format.
  const usdcBalance = await wallet.getBalance(USDC_MINT);
  console.log(`\nUSDC balance: ${usdcBalance.amount} ${usdcBalance.token}`);
  console.log(`  Decimals: ${usdcBalance.decimals}`);  // USDC has 6 decimal places
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
  // Execute a swap: convert 1 SOL to USDC via Jupiter.
  // The swap intent goes through the full pipeline:
  //   1. Policy engine checks spending limit (1 SOL <= 10 SOL per-tx cap)
  //   2. Policy engine checks rate limit
  //   3. Your custom implementation calls the Jupiter quote API to find the best route
  //   4. The swap transaction is built with the optimal route
  //   5. LocalSigner signs the transaction
  //   6. SolanaAdapter broadcasts to Solana and waits for confirmation
  console.log("\n--- Swapping 1 SOL -> USDC ---");
  const swapResult = await wallet.execute({
    type: "swap",       // Swap intent type (routed through Jupiter by the SolanaAdapter)
    chain: "solana",
    params: {
      fromToken: "SOL",                                           // Source: native SOL
      toToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  // Destination: USDC mint address
      amount: "1.0",         // Swap 1 SOL worth of tokens
      maxSlippage: 0.01,     // Accept up to 1% price slippage. If the price moves more than
                             // 1% between quote and execution, the swap will fail on-chain.
    },
  });

  // Log the complete swap result.
  console.log("Swap status:", swapResult.status);      // "confirmed" | "denied" | "failed"
  console.log("Transaction ID:", swapResult.txId);      // Solana transaction signature
  console.log("Summary:", swapResult.summary);           // Human-readable description of the swap
  console.log("Intent ID:", swapResult.intentId);        // UUID for idempotency and tracing
  console.log("Timestamp:", new Date(swapResult.timestamp).toISOString());  // timestamp is ms since epoch
  // Output:
  //   Swap status: confirmed
  //   Transaction ID: 2nKz8...def
  //   Summary: Swapped 1.0 SOL for ~200.50 USDC via Jupiter
  //   Intent ID: a1b2c3d4-e5f6-7890-abcd-ef1234567890
  //   Timestamp: 2025-01-15T14:30:00.000Z
```

**Expected output:**

```
--- Swapping 1 SOL -> USDC ---
Swap status: confirmed
Transaction ID: 2nKz8...def
Summary: Swapped 1.0 SOL for ~200.50 USDC via Jupiter
Intent ID: a1b2c3d4-e5f6-7890-abcd-ef1234567890
Timestamp: 2025-01-15T14:30:00.000Z
```

::: details What just happened?
Here is the full pipeline that your swap went through:

1. **Policy evaluation:** The policy checked spending limits (1 SOL is under the 10 SOL cap) and rate limits (not exceeded). Both rules returned ALLOW.
2. **Jupiter quote:** Your custom implementation called the Jupiter quote API to find the best swap route. Jupiter compared prices across all available liquidity pools (Raydium, Orca, etc.) and returned the route with the best price.
3. **Transaction building:** The Jupiter swap API was used to build a Solana transaction containing the swap instructions.
4. **Signing:** The `LocalSigner` signed the transaction with your wallet's private key.
5. **Broadcasting:** The adapter submitted the signed transaction to the Solana network via your RPC endpoint.
6. **Confirmation:** The adapter waited for the transaction to reach "confirmed" status (supermajority of validators have seen it).
7. **Audit logging:** The wallet internally recorded the entire operation in the tamper-evident hash chain.

The `~200.50 USDC` in the summary is approximate because the exact amount depends on the real-time price at the moment the swap executed.
:::

The swap intent structure in detail:

```typescript
// TransactionIntent for a swap -- anatomy of each field:
{
  type: "swap",              // IntentType: tells the SDK this is a token swap (not a transfer)
  chain: "solana",           // ChainId: the SolanaAdapter handles this intent
  params: {                  // SwapParams: swap-specific parameters
    fromToken: "SOL",        // Source token -- can be a symbol ("SOL") or mint address
    toToken: "EPjFWdd5...",  // Destination token -- can be a symbol or mint address
                             // Using the mint address is more reliable for SPL tokens
    amount: "1.0",           // Amount of the SOURCE token to swap (human-readable, not lamports)
    maxSlippage: 0.01,       // Optional: max acceptable price slippage as a decimal
                             // 0.01 = 1%, 0.005 = 0.5%. If omitted, a default is used.
                             // Tighter slippage = more likely to fail if price moves.
  },
}
```

## Step 5: Check Updated Balances

Verify the balances changed after the swap.

```typescript
  // Verify balances changed after the swap.
  // SOL should decrease by ~1 SOL (plus transaction fees of ~0.0005 SOL).
  // USDC should increase by the amount received from the swap.
  console.log("\n--- Updated Balances ---");
  const updatedSol = await wallet.getBalance("SOL");
  console.log(`SOL: ${updatedSol.amount} (was ${solBalance.amount})`);
  // Output: SOL: 11.4995 (was 12.5) -- 1 SOL swapped + ~0.0005 SOL in transaction fees

  const updatedUsdc = await wallet.getBalance(USDC_MINT);
  console.log(`USDC: ${updatedUsdc.amount} (was ${usdcBalance.amount})`);
  // Output: USDC: 350.50 (was 150.00) -- received ~200.50 USDC from the swap
```

## Step 6: Execute Another Swap -- USDC Back to SOL

Swap some USDC back to SOL. Note that when swapping from a token, the `amount` refers to the `fromToken`.

```typescript
  // Swap in the reverse direction: 100 USDC back to SOL.
  // When swapping from an SPL token, use the mint address as fromToken
  // and the `amount` refers to the source token (100 USDC in this case).
  console.log("\n--- Swapping 100 USDC -> SOL ---");
  const reverseSwapResult = await wallet.execute({
    type: "swap",
    chain: "solana",
    params: {
      fromToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  // Source: USDC mint address
      toToken: "SOL",       // Destination: native SOL
      amount: "100.0",      // Swap 100 USDC (the fromToken amount)
      maxSlippage: 0.01,    // 1% max slippage
    },
  });

  console.log("Swap status:", reverseSwapResult.status);
  console.log("Transaction ID:", reverseSwapResult.txId);
  console.log("Summary:", reverseSwapResult.summary);
  // Output:
  //   Swap status: confirmed
  //   Transaction ID: 7pLm3...ghi
  //   Summary: Swapped 100.0 USDC for ~0.498 SOL via Jupiter

  // Check for policy denial -- useful for debugging when swaps are rejected.
  if (reverseSwapResult.status === "denied") {
    console.log("Denied reason:", reverseSwapResult.error?.message);
    // Possible denial reasons:
    //   SPENDING_LIMIT_EXCEEDED  - Amount exceeds per-tx or daily cap
    //   RATE_LIMIT_EXCEEDED      - Too many swaps in the time window
    //   PROGRAM_NOT_ALLOWED      - Jupiter not in the allowPrograms list
  }
```

## Step 7: View Full Transaction History

Retrieve and display all transactions the agent has executed.

```typescript
  // Retrieve and display the full transaction history from the audit log.
  // This includes all swap attempts -- confirmed, denied, and failed.
  const history = await wallet.getTransactionHistory(20);
  console.log(`\n=== Transaction History (${history.length} entries) ===`);

  for (const tx of history) {
    console.log(`\n[${tx.status.toUpperCase()}] ${tx.summary}`);
    console.log(`  Intent ID:  ${tx.intentId}`);    // UUID for tracing and idempotency
    console.log(`  Timestamp:  ${new Date(tx.timestamp).toISOString()}`);  // timestamp is ms since epoch
    if (tx.txId) {
      // Provide the Solana transaction signature and a link to the block explorer.
      // Solscan is a popular Solana block explorer for viewing transaction details.
      console.log(`  Tx ID:      ${tx.txId}`);
      console.log(`  Explorer:   https://solscan.io/tx/${tx.txId}`);
    }
    if (tx.error) {
      console.log(`  Error:      ${tx.error?.message}`);  // TransactionError object with .code and .message
    }
  }
  // Output:
  //   === Transaction History (2 entries) ===
  //
  //   [CONFIRMED] Swapped 1.0 SOL for ~200.50 USDC via Jupiter
  //     Intent ID:  a1b2c3d4-e5f6-7890-abcd-ef1234567890
  //     Timestamp:  2025-01-15T14:30:00.000Z
  //     Tx ID:      2nKz8...def
  //     Explorer:   https://solscan.io/tx/2nKz8...def
  //
  //   [CONFIRMED] Swapped 100.0 USDC for ~0.498 SOL via Jupiter
  //     Intent ID:  b2c3d4e5-f6a7-8901-bcde-f12345678901
  //     Timestamp:  2025-01-15T14:31:00.000Z
  //     Tx ID:      7pLm3...ghi
  //     Explorer:   https://solscan.io/tx/7pLm3...ghi
```

## Step 8: Verify Audit Log Integrity

The audit logger maintains a tamper-evident chain of entries. Verify that no entries have been modified or deleted.

```typescript
  // Verify the tamper-evident SHA-256 hash chain of the audit log.
  // The wallet manages the AuditLogger internally — use wallet.verifyAuditIntegrity()
  // to check that no entries have been modified, deleted, or inserted.
  const integrity = await wallet.verifyAuditIntegrity(20);
  console.log("\n=== Audit Integrity Report ===");
  console.log("Valid:", integrity.valid);              // true if entire chain is intact
  console.log("Entries checked:", integrity.entriesChecked);

  if (!integrity.valid) {
    // ALERT: the audit chain has been tampered with or corrupted.
    // firstBrokenAt indicates the index of the first corrupted entry.
    // In production, this should trigger an alert (Slack, PagerDuty, etc.)
    // and potentially pause the agent until the issue is investigated.
    console.error("ALERT: Audit chain broken at entry:", integrity.firstBrokenAt);
  } else {
    console.log("All audit entries are intact and unmodified.");
  }
  // Output:
  //   === Audit Integrity Report ===
  //   Valid: true
  //   Entries checked: 2
  //   All audit entries are intact and unmodified.
}

// Run the async main function; log any unhandled errors.
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
} from "@kova-sdk/wallet";

// USDC SPL token mint address on Solana mainnet.
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

async function main() {
  // --- Setup: create signer, store, and chain adapter ---
  // ⚠️ SECURITY WARNING: Environment variables are NOT safe for private keys in production.
  // Use MpcSigner with a hardware-backed provider or a secrets manager instead.
  const keypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.SOLANA_SECRET_KEY!))
  );
  const signer = new LocalSigner(keypair, { network: "devnet" });  // Dev-only; requires network option
  const store = new MemoryStore({ dangerouslyAllowInProduction: true });  // Dev-only; not for production use
  // Note: Jupiter swap routing requires custom implementation — it is not built into SolanaAdapter.
  // See https://station.jup.ag/docs for Jupiter API integration details.
  const chain = new SolanaAdapter({
    rpcUrl: process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
    commitment: "confirmed",
  });

  // --- Policy: DeFi trader with spending limits and program allowlist ---
  const policy = Policy.create("defi-trader-policy")
    .spendingLimit({
    perTransaction: { amount: "10.0", token: "SOL" },  // Max 10 SOL per swap
    daily: { amount: "100.0", token: "SOL" },           // Max 100 SOL per day
  })
    .allowPrograms([
      "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",  // Jupiter v6 only
    ])
    .rateLimit({
    maxTransactionsPerMinute: 10,  // 10 swaps per minute
  })
    .build();

  // Create the wallet — audit logger is created internally by the wallet.
  const wallet = new AgentWallet({
    signer, chain, policy, store,
    dangerouslyDisableAuth: true,  // Tutorial only — disable auth for local development
  });

  // --- Check initial balances ---
  const address = await wallet.getAddress();
  console.log("Wallet address:", address);

  const solBalance = await wallet.getBalance("SOL");
  console.log(`SOL balance: ${solBalance.amount}`);

  const usdcBalance = await wallet.getBalance(USDC_MINT);
  console.log(`USDC balance: ${usdcBalance.amount}`);

  // --- Swap 1: SOL -> USDC ---
  console.log("\n--- Swap: 1 SOL -> USDC ---");
  const swap1 = await wallet.execute({
    type: "swap", chain: "solana",
    params: { fromToken: "SOL", toToken: USDC_MINT, amount: "1.0", maxSlippage: 0.01 },
  });
  console.log(`Status: ${swap1.status}`);
  console.log(`Summary: ${swap1.summary}`);
  if (swap1.status === "confirmed") {
    console.log(`Tx: ${swap1.txId}`);
  }

  // Verify balances changed after the swap.
  const updatedSol = await wallet.getBalance("SOL");
  const updatedUsdc = await wallet.getBalance(USDC_MINT);
  console.log(`\nSOL: ${updatedSol.amount} | USDC: ${updatedUsdc.amount}`);

  // --- Swap 2: 100 USDC -> SOL ---
  console.log("\n--- Swap: 100 USDC -> SOL ---");
  const swap2 = await wallet.execute({
    type: "swap", chain: "solana",
    params: { fromToken: USDC_MINT, toToken: "SOL", amount: "100.0", maxSlippage: 0.01 },
  });
  console.log(`Status: ${swap2.status}`);
  console.log(`Summary: ${swap2.summary}`);
  if (swap2.status === "confirmed") {
    console.log(`Tx: ${swap2.txId}`);
  }

  // --- Transaction history with explorer links ---
  const history = await wallet.getTransactionHistory(20);
  console.log(`\n=== History (${history.length} entries) ===`);
  for (const tx of history) {
    console.log(`[${tx.status}] ${tx.summary}`);
    if (tx.txId) console.log(`  https://solscan.io/tx/${tx.txId}`);
  }

  // --- Verify audit log integrity ---
  const integrity = await wallet.verifyAuditIntegrity(20);
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
// Execute a swap with very tight slippage to demonstrate error handling.
// Tight slippage (0.5%) increases the chance of on-chain failure if the
// price moves between the quote and execution.
const result = await wallet.execute({
  type: "swap",
  chain: "solana",
  params: {
    fromToken: "SOL",
    toToken: USDC_MINT,
    amount: "5.0",
    maxSlippage: 0.005, // Very tight 0.5% slippage -- may fail if price is volatile
  },
});

// Handle each possible outcome using a switch statement.
// This pattern covers all four status values in the TransactionResult.
switch (result.status) {
  case "confirmed":
    // SUCCESS: The swap was allowed by policy, routed through Jupiter,
    // signed, broadcast, and confirmed on the Solana network.
    console.log("Swap completed:", result.summary);
    break;

  case "denied":
    // DENIED: The policy engine rejected the swap BEFORE it was submitted.
    // No transaction was broadcast; no funds were spent.
    console.log("Swap denied:", result.error?.message);
    console.log("Error code:", result.error?.code);
    // Possible denial reasons (error.code):
    //   SPENDING_LIMIT_EXCEEDED - Swap amount exceeds per-tx or daily cap
    //   RATE_LIMIT_EXCEEDED     - Too many swaps in the rolling time window
    //   PROGRAM_NOT_ALLOWED     - Jupiter program ID not in allowPrograms list
    break;

  case "failed":
    // FAILED: The policy allowed the swap, but it failed during execution.
    // The transaction may or may not have been broadcast.
    console.log("Swap failed:", result.error?.message);
    console.log("Error code:", result.error?.code);
    // Possible failure reasons:
    //   INSUFFICIENT_BALANCE   - Wallet does not have enough tokens to swap
    //   TRANSACTION_FAILED     - On-chain error (slippage exceeded, no liquidity)
    //   CHAIN_ERROR            - RPC connection issue or network timeout
    break;

  case "pending":
    // PENDING: Only occurs when an ApprovalGateRule is active and the
    // transaction is waiting for human approval. Should not happen for
    // swaps without an approval gate configured.
    console.log("Swap pending (unexpected)");
    break;
}
```

## Common Mistakes

1. **Trying to swap on devnet.** Most SPL tokens (including USDC) have no liquidity on Solana devnet. Jupiter cannot find a swap route if there are no liquidity pools. For real swap testing, you need mainnet-beta with real funds. If you want to test the policy logic without real swaps, use the transfer intent type instead.

2. **Using token symbols instead of mint addresses for SPL tokens.** While `"SOL"` works as a shorthand for the native token, SPL tokens should be identified by their mint address (e.g., `"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"` for USDC). Using `"USDC"` as a string may fail if the token registry is not available.

3. **Setting `maxSlippage` too tight.** A slippage of `0.001` (0.1%) will cause many swaps to fail in volatile markets because the price moves between the quote and execution. Start with `0.01` (1%) and tighten only after you understand your token pair's typical volatility.

## Troubleshooting

### Jupiter swap failing

- **"No route found"**: The token pair has no liquidity on Jupiter. This is common on devnet. Verify the token has active liquidity pools by checking [jup.ag](https://jup.ag/).
- **"Slippage exceeded"**: The price moved more than your `maxSlippage` between the quote and execution. Increase `maxSlippage` (e.g., from `0.01` to `0.03`) or retry -- the price may have stabilized.
- **"Insufficient balance"**: Your wallet does not have enough of the source token. Check balances with `wallet.getBalance("SOL")` before attempting the swap.
- **Transaction times out**: The Solana network may be congested. Retry after a few seconds. If using the public RPC endpoint (`api.mainnet-beta.solana.com`), consider switching to a private RPC provider like Helius or QuickNode for better reliability.

### Jupiter swap failing on devnet

This is expected. Jupiter liquidity pools exist primarily on mainnet-beta. Most devnet tokens have no trading pairs. If you need to test on devnet, test with transfer intents instead of swap intents, or set up your own devnet liquidity pool (advanced).

### Balance shows 0 for a token you know you have

- Make sure you are using the correct mint address. Each SPL token has a unique mint address on each network (mainnet vs. devnet).
- Verify you are connected to the correct network. If your tokens are on mainnet but your RPC URL points to devnet, balances will show 0.

## What to Try Next

- **Build a simple arbitrage detector.** Check the price of SOL/USDC on Jupiter, compare it to a different source, and execute a swap when the price difference exceeds a threshold.
- **Add approval gates for large swaps.** Add a `CallbackApprovalChannel` or `WebhookApprovalChannel` so swaps above 5 SOL require your manual approval. See the [Approval Gate guide](/guide/rules/approval-gate) for details.
- **Track portfolio value over time.** Write a script that calls `wallet.getBalance("SOL")` and `wallet.getBalance("USDC")` every hour, logs the USD values, and plots a simple chart.

## Next Steps

- [Policy Cookbook](/tutorials/policy-cookbook) -- More DeFi-specific policy configurations
- [Approval Gate](/guide/rules/approval-gate) -- Add human oversight for large swaps with CallbackApprovalChannel or WebhookApprovalChannel
- [Production Deployment](/tutorials/production) -- Persistent storage and monitoring for DeFi agents
- [API Reference](/api/reference) -- Full SwapParams and TransactionResult documentation
