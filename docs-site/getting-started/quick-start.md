# Quick Start

::: info What you'll learn
- How to create a fully working policy-constrained wallet from scratch
- How to define spending limits, allowlists, and rate limits
- How to execute a transaction and interpret the result
- How to inspect transaction history and policy summaries
:::

This guide walks you through creating a policy-constrained wallet and executing your first transaction, from zero to a confirmed transfer. By the end, you'll have a working wallet that an AI agent could use -- complete with spending limits, an address allowlist (a pre-approved list of recipients), and rate limiting.

::: tip No blockchain experience needed
Every step below is explained in plain terms. You'll be writing TypeScript, not raw blockchain code. If you've ever set up an Express server or configured a database connection, this will feel familiar.
:::

## Complete Working Example

```typescript
// Import all kova components needed to create and run a policy-constrained wallet.
import {
  AgentWallet,        // Orchestrates the full execute() pipeline: validate → policy → sign → broadcast
  Policy,             // Fluent builder for declaratively defining policy configurations
  PolicyEngine,       // Evaluates an ordered list of rules against each transaction intent
  MemoryStore,        // In-memory Store implementation for dev/testing (state lost on restart)
  LocalSigner,        // Wraps a Solana Keypair and signs transactions locally
  SolanaAdapter,      // Handles Solana-specific operations: build tx, broadcast, check balance
  SpendingLimitRule,  // Enforces per-transaction and periodic (daily/weekly/monthly) spending caps
  RateLimitRule,      // Enforces max transactions per minute and per hour using rolling windows
  AllowlistRule,      // Restricts which destination addresses the agent can send funds to
} from "kova";
// Keypair from Solana's web3.js library generates and holds a public/private key pair.
import { Keypair } from "@solana/web3.js";

async function main() {
  // ── 1. Create a keypair and signer ──────────────────────────────────
  // Generate a random Solana keypair. In production, load an existing key
  // from a secure store (e.g., environment variable or secrets manager).
  const keypair = Keypair.generate();
  // LocalSigner wraps the keypair so the wallet can sign transactions.
  // It implements the Signer interface: getAddress(), sign(), healthCheck().
  const signer = new LocalSigner(keypair);
  // Print the wallet's public address (base58-encoded) for reference.
  console.log("Wallet address:", await signer.getAddress());

  // ── 2. Create a store for spending counters and audit logs ──────────
  // MemoryStore implements the Store interface with get/set/increment/append/getRecent.
  // It holds all policy state (spending counters, rate limit windows, audit entries)
  // in memory. Data is lost when the process exits -- use SqliteStore in production.
  const store = new MemoryStore();

  // ── 3. Create a chain adapter for Solana ────────────────────────────
  // SolanaAdapter connects to a Solana RPC endpoint and handles all chain-specific
  // operations: building unsigned transactions, broadcasting signed transactions,
  // querying balances, and validating addresses.
  const chain = new SolanaAdapter({
    rpcUrl: "https://api.devnet.solana.com",  // Solana devnet RPC endpoint (free, rate-limited)
    commitment: "confirmed",                   // Wait for supermajority confirmation (~400ms)
  });

  // ── 4. Build a policy using the fluent builder ──────────────────────
  // Policy.create() returns a builder. Each chained method adds a constraint.
  // The result is a serializable PolicyConfig object describing what the agent can do.
  const policy = Policy.create("trading-agent")
    .spendingLimit({
      perTransaction: { amount: "1", token: "SOL" },  // No single transaction can exceed 1 SOL
      daily: { amount: "5", token: "SOL" },            // Total spending cannot exceed 5 SOL per day
    })
    .allowAddresses([
      // Only these two addresses can receive funds from this wallet.
      // Any transfer to an address not on this list will be denied.
      "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH",
    ])
    .rateLimit({
      maxTransactionsPerMinute: 3,  // Max 3 transactions in any rolling 60-second window
      maxTransactionsPerHour: 20,   // Max 20 transactions in any rolling 60-minute window
    })
    .build();  // Finalize and return the immutable Policy object

  // ── 5. Extract config and create individual rules ───────────────────
  // toJSON() serializes the policy to a plain object so we can extract
  // config for each rule type. This separation keeps policy definition
  // (declarative builder) separate from policy execution (rule instances).
  const config = policy.toJSON();

  // Create concrete rule instances in evaluation order.
  // Rules are evaluated sequentially; the cheapest checks go first to
  // short-circuit early and avoid unnecessary work.
  const rules = [
    new RateLimitRule(config.rateLimit!),        // Cheapest: simple counter check
    new AllowlistRule({                           // Next: address lookup (fast hash check)
      allowAddresses: config.allowAddresses,
    }),
    new SpendingLimitRule(config.spendingLimit!), // Last: requires amount parsing and aggregation
  ];

  // ── 6. Create the policy engine ─────────────────────────────────────
  // PolicyEngine takes the ordered rules and a store (for stateful rules like
  // spending limits). It evaluates every intent against all rules sequentially.
  // If any rule returns DENY, the engine stops and returns DENY immediately.
  const engine = new PolicyEngine(rules, store);

  // ── 7. Create the wallet ────────────────────────────────────────────
  // AgentWallet wires together the signer, chain adapter, policy engine, and store
  // into a single object that AI agents interact with. It exposes execute(),
  // getBalance(), getAddress(), getPolicy(), and getTransactionHistory().
  const wallet = new AgentWallet({
    signer,         // Signs transactions before broadcast
    chain,          // Builds and broadcasts transactions to Solana
    policy: engine, // Evaluates policy rules before allowing any transaction
    store,          // Shared store for spending counters, audit logs, idempotency cache
  });

  // ── 8. Execute a transfer ───────────────────────────────────────────
  // wallet.execute() runs the full 10-step pipeline: validate → normalize →
  // idempotency check → audit circuit check → transaction circuit breaker →
  // policy evaluation → build tx → sign → broadcast → audit log + return result.
  const result = await wallet.execute({
    type: "transfer",   // Intent type: a simple token transfer (other types: swap, mint, stake, custom)
    chain: "solana",    // Target blockchain (currently only "solana" is supported)
    params: {
      to: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",  // Recipient address (must be on allowlist)
      amount: "0.5",    // Amount in SOL (human-readable, not lamports)
      token: "SOL",     // Token to transfer (native SOL in this case)
    },
    metadata: {
      reason: "Payment for completed task",  // Optional: stored in audit log for context
      agentId: "trading-bot-01",             // Optional: identifies which agent made the request
    },
  });

  // ── 9. Log the result ───────────────────────────────────────────────
  // TransactionResult contains the outcome of the execute() pipeline.
  console.log("Transaction result:", {
    status: result.status,     // "confirmed" | "denied" | "failed" | "pending"
    txId: result.txId,         // Solana transaction signature (only if submitted)
    summary: result.summary,   // Human-readable summary of what happened
    intentId: result.intentId, // Unique ID assigned to this intent (UUID)
  });

  // ── 10. Check the wallet's policy summary ───────────────────────────
  // getPolicy() returns a human-readable summary of the active policy,
  // including spending limits, rate limits, allowlist, and other constraints.
  const policySummary = await wallet.getPolicy();
  console.log("Policy summary:", JSON.stringify(policySummary, null, 2));

  // ── 11. View transaction history ────────────────────────────────────
  // getTransactionHistory(n) retrieves the last n entries from the audit log.
  // Each entry includes status, summary, timestamp, txId, and intentId.
  const history = await wallet.getTransactionHistory(5);
  console.log("Recent transactions:", history.length);
}

// Run the async main function and catch any unhandled errors.
main().catch(console.error);
```

## Expected Output

If the transfer succeeds (requires a funded devnet wallet):

```
Wallet address: 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
Transaction result: {
  status: 'confirmed',
  txId: '5UfgJ3vN...',
  summary: 'Sent 0.5 SOL to 9WzD...AWWM',
  intentId: 'a1b2c3d4-...'
}
```

If the wallet is unfunded (common on first devnet run):

```
Transaction result: {
  status: 'failed',
  txId: undefined,
  summary: 'Transaction failed: ...',
  intentId: 'a1b2c3d4-...'
}
```

::: tip
To fund your devnet wallet, use the [Solana Faucet](https://faucet.solana.com/) or run:
```bash
# Request 2 SOL from the Solana devnet faucet.
# Replace <your-wallet-address> with the base58 public key printed by the script.
# The --url flag tells the Solana CLI to target devnet instead of mainnet.
# Devnet SOL has no monetary value and is free for testing.
solana airdrop 2 <your-wallet-address> --url devnet
```
:::

::: info What are lamports?
You'll see "lamports" mentioned in Solana documentation. A lamport is the smallest unit of SOL, like cents to dollars. 1 SOL = 1,000,000,000 lamports. You don't need to worry about lamports when using kova -- the SDK accepts human-readable amounts like `"0.5"` and converts them internally.
:::

## What Just Happened?

Here's a step-by-step breakdown of what the code above did. If you're coming from web development, the analogies in parentheses may help.

1. **Keypair** -- A new Solana keypair (a public/private key pair, like a username and password for the blockchain) was generated in memory
2. **Signer** -- The `LocalSigner` wraps the keypair and can sign transactions (like adding your signature to a check before it can be cashed)
3. **Store** -- The `MemoryStore` tracks spending counters and audit logs in memory (like an in-memory cache such as Redis, but simpler)
4. **Chain adapter** -- The `SolanaAdapter` connects to Solana devnet (a free test network) via RPC (a URL used to talk to the blockchain, similar to a REST API endpoint)
5. **Policy** -- The fluent builder created a policy config with spending limits, an allowlist (a pre-approved list of recipient addresses), and rate limits
6. **Rules** -- Individual rule instances were created from the policy config (each rule is like a middleware function that checks one condition)
7. **Engine** -- The `PolicyEngine` evaluates rules sequentially (cheapest rules first, to fail fast -- just like you'd put your lightest validation middleware first in Express)
8. **Wallet** -- The `AgentWallet` wires everything together (this is the main entry point, like an Express `app` object that ties routes, middleware, and database together)
9. **Execute** -- The `execute()` pipeline validated the intent, checked all policy rules, built the transaction, signed it, and broadcast it to Solana
10. **Result** -- A structured `TransactionResult` with status, transaction ID, and summary

### Why this matters

You just built a complete, policy-protected wallet in a single file. In production, this exact same pattern -- with `SqliteStore` instead of `MemoryStore` and a funded wallet -- is all you need to let an AI agent safely transact on the blockchain. The policy rules you defined are not suggestions; they are hard limits enforced on every single transaction.

::: warning Don't forget to fund your wallet
A newly generated keypair has zero SOL. On devnet (the free test network), you can get free test SOL using the airdrop command shown above. On mainnet (the real Solana network where SOL has monetary value), you'd need to transfer real SOL to the wallet address.
:::

## Next Steps

- Read the [Concepts](/getting-started/concepts) page to understand the architecture in depth
- Learn about the full [AgentWallet API](/guide/wallet)
- Explore all five [Intent Types](/guide/intents) -- transfers, swaps, mints, staking, and custom operations
- Dive into the [Policy Engine](/guide/policy-engine) and individual [rules](/guide/rules/spending-limit)

## Common Questions

**Q: Do I need to fund the wallet before running this example?**
For the transaction to actually succeed on devnet, yes. But the code will still run without funding -- you'll just get a `"failed"` status instead of `"confirmed"`. This is useful for testing your policy setup without needing devnet SOL.

**Q: What happens if I try to send to an address not on the allowlist?**
The `AllowlistRule` will deny the transaction before it ever reaches the blockchain. You'll get a result with `status: "denied"` and a human-readable explanation like "Address not in allowlist." The agent would see this denial and could explain it to the user.

**Q: Why are rules ordered (RateLimit, then Allowlist, then SpendingLimit)?**
Performance. Rules are checked in order, and evaluation stops at the first denial. The cheapest checks go first -- counting recent transactions (rate limit) is faster than aggregating spending amounts. This is the same pattern as putting lightweight middleware before expensive middleware in a web framework.

**Q: What is the difference between `Policy.create()` and creating rules manually?**
`Policy.create()` is a convenient builder that generates a configuration object. You still need to create individual rule instances from that configuration for the `PolicyEngine`. Think of the builder as a form that collects settings, and the rules as the actual validators that enforce them.

**Q: Can I add my own custom policy rules?**
Yes. Any class that implements the `PolicyRule` interface (with an `evaluate()` method) can be added to the `PolicyEngine`. See the [Policy Engine guide](/guide/policy-engine) for details on creating custom rules.
