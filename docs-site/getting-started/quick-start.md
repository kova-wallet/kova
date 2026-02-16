# Quick Start

::: info What you'll learn
- How to create a fully working policy-constrained wallet from scratch
- How to define spending limits, allowlists, and rate limits using the fluent Policy builder
- How to execute a transaction and interpret the result
- How to inspect transaction history and policy summaries
:::

This guide walks you through creating a policy-constrained wallet and executing your first transaction, from zero to a confirmed transfer. By the end, you'll have a working wallet that an AI agent could use -- complete with spending limits, an address allowlist (a pre-approved list of recipients), and rate limiting.

::: tip No blockchain experience needed
Every step below is explained in plain terms. You'll be writing TypeScript, not raw blockchain code. If you've ever set up an Express server or configured a database connection, this will feel familiar.
:::

## Complete Working Example

```typescript
// ── Imports ─────────────────────────────────────────────────────────────────
// Import all kova components needed to create and run a policy-constrained wallet.
// Each import is a composable building block with a single responsibility.
import {
  AgentWallet,        // The main entry point: orchestrates the full execute() pipeline
                      // (validate -> policy check -> sign -> broadcast -> audit log)
  Policy,             // Fluent builder for declaratively defining policy configurations.
                      // Produces a serializable PolicyConfig object.
  PolicyEngine,       // Evaluates an ordered list of rules against each transaction intent.
                      // Two-phase evaluation (dry-run then commit) prevents counter inflation.
  MemoryStore,        // In-memory Store implementation for dev/testing.
                      // All state (spending counters, rate limits, audit log) is lost on restart.
  LocalSigner,        // Wraps a Solana Keypair and signs transactions locally.
                      // Development only -- key is held in process memory (insecure).
  SolanaAdapter,      // Handles Solana-specific operations: build unsigned transactions,
                      // broadcast signed transactions, query balances, validate addresses.
  SpendingLimitRule,  // Enforces per-transaction and periodic (daily/weekly/monthly) spending caps.
                      // Uses sliding windows (not fixed TTL) to prevent boundary double-spend.
  RateLimitRule,      // Enforces max transactions per minute and per hour using rolling windows.
                      // Has a built-in floor of 30 writes/min to protect against runaway agents.
  AllowlistRule,      // Restricts which destination addresses the agent can send funds to.
                      // Deny entries take precedence over allow entries.
} from "kova";

// Keypair from Solana's web3.js library generates and holds a public/private key pair.
// The public key is the wallet's "address" (visible to everyone, like a bank account number).
// The private key authorizes spending (secret, like a PIN -- never share it).
import { Keypair } from "@solana/web3.js";

async function main() {
  // ── 1. Create a keypair and signer ──────────────────────────────────────
  // Generate a random Solana keypair. In production, you would load an existing
  // key from a secure store (environment variable, AWS Secrets Manager, etc.)
  // or use MpcSigner instead of LocalSigner for hardware-backed key security.
  const keypair = Keypair.generate();

  // LocalSigner wraps the keypair so the wallet can sign transactions.
  // It implements the Signer interface: getAddress(), sign(), healthCheck().
  // WARNING: LocalSigner holds the key in plain text in process memory.
  // Use MpcSigner (Turnkey, Fireblocks, Lit Protocol) for real funds.
  const signer = new LocalSigner(keypair);

  // Print the wallet's public address (base58-encoded) for reference.
  // This is the "account number" -- safe to share publicly.
  console.log("Wallet address:", await signer.getAddress());

  // ── 2. Create a store for spending counters and audit logs ──────────────
  // MemoryStore implements the Store interface with get/set/increment/append/getRecent.
  // It holds all policy state (spending counters, rate limit windows, audit entries)
  // in memory. Data is lost when the process exits -- use SqliteStore in production.
  const store = new MemoryStore();

  // ── 3. Create a chain adapter for Solana ────────────────────────────────
  // SolanaAdapter connects to a Solana RPC endpoint and handles all chain-specific
  // operations: building unsigned transactions from intents, broadcasting signed
  // transactions, querying balances, resolving token addresses, and validating
  // recipient addresses.
  const chain = new SolanaAdapter({
    rpcUrl: "https://api.devnet.solana.com",  // Solana devnet RPC endpoint (free, rate-limited)
    commitment: "confirmed",                   // Wait for supermajority confirmation (~400ms)
  });

  // ── 4. Build a policy using the fluent builder ──────────────────────────
  // Policy.create() returns a chainable builder. Each method adds a constraint.
  // The result is a serializable PolicyConfig object that describes what the
  // agent is allowed to do. This config can be stored in a database, loaded
  // from a file, or passed to an admin dashboard for management.
  const policy = Policy.create("trading-agent")
    .spendingLimit({
      // perTransaction: No single transaction can exceed 1 SOL.
      // This catches accidental large amounts (e.g., agent sends 100 instead of 1).
      perTransaction: { amount: "1", token: "SOL" },
      // daily: Total spending cannot exceed 5 SOL in any rolling 24-hour window.
      // Even many small transactions can't drain the wallet beyond this cap.
      daily: { amount: "5", token: "SOL" },
    })
    .allowAddresses([
      // Only these two addresses can receive funds from this wallet.
      // Any transfer to an address NOT on this list will be immediately denied.
      // This prevents the agent from sending funds to arbitrary addresses,
      // even if tricked by a prompt injection attack.
      "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH",
    ])
    .rateLimit({
      // maxTransactionsPerMinute: At most 3 transactions in any rolling 60-second window.
      // Prevents runaway loops where the agent retries the same operation endlessly.
      maxTransactionsPerMinute: 3,
      // maxTransactionsPerHour: At most 20 transactions in any rolling 60-minute window.
      // Provides a broader cap for sustained activity.
      maxTransactionsPerHour: 20,
    })
    .build();  // Finalize and return the immutable Policy object

  // ── 5. Extract config and create individual rules ───────────────────────
  // toJSON() serializes the policy to a plain object so we can extract
  // config for each rule type. This separation keeps policy definition
  // (declarative builder) separate from policy execution (rule instances).
  const config = policy.toJSON();

  // Create concrete rule instances in evaluation order.
  // Rules are evaluated sequentially; the cheapest checks go first to
  // short-circuit early and avoid unnecessary work on denied transactions.
  const rules = [
    // RateLimitRule first: cheapest check (simple counter lookup).
    // If the agent has exceeded its quota, we don't need to check anything else.
    new RateLimitRule(config.rateLimit!),

    // AllowlistRule second: fast address lookup (hash set membership check).
    // If the recipient isn't on the allowlist, skip the spending calculation.
    new AllowlistRule({
      allowAddresses: config.allowAddresses,
    }),

    // SpendingLimitRule last: most expensive check (aggregates historical spending).
    // Only runs if the rate limit and allowlist both passed.
    new SpendingLimitRule(config.spendingLimit!),
  ];

  // ── 6. Create the policy engine ─────────────────────────────────────────
  // PolicyEngine takes the ordered rules and a store (for stateful rules like
  // spending limits and rate limits). It evaluates every intent against all
  // rules sequentially. If ANY rule returns DENY, the engine stops immediately
  // and returns DENY. The transaction only proceeds if ALL rules return ALLOW.
  const engine = new PolicyEngine(rules, store);

  // ── 7. Create the wallet ────────────────────────────────────────────────
  // AgentWallet wires together the signer, chain adapter, policy engine, and store
  // into a single object. This is the only object that AI agents interact with.
  // It exposes: execute(), getBalance(), getAddress(), getPolicy(), and
  // getTransactionHistory().
  const wallet = new AgentWallet({
    signer,         // Signs transactions with the private key before broadcast
    chain,          // Builds and broadcasts transactions to the Solana blockchain
    policy: engine, // Evaluates policy rules before allowing any transaction
    store,          // Shared store for spending counters, audit logs, idempotency cache
  });

  // ── 8. Execute a transfer ───────────────────────────────────────────────
  // wallet.execute() runs the full 10-step pipeline:
  //   1. Validate intent structure and types
  //   2. Normalize (assign UUID, timestamp)
  //   3. Idempotency check (skip if already processed)
  //   4. Audit circuit check (refuse if audit logging is broken)
  //   5. Transaction circuit breaker (refuse if too many consecutive denials)
  //   6. Policy evaluation (two-phase: dry-run then commit)
  //   7. Build unsigned transaction via chain adapter
  //   8. Sign transaction via signer
  //   9. Broadcast to blockchain and wait for confirmation
  //  10. Record audit log entry and return result
  const result = await wallet.execute({
    type: "transfer",   // Intent type: a simple token transfer
    chain: "solana",    // Target blockchain (currently only "solana" is supported)
    params: {
      // to: Recipient address. Must be on the allowlist, or the AllowlistRule denies it.
      to: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      // amount: Human-readable amount in SOL. The SDK converts to lamports internally.
      // (1 SOL = 1,000,000,000 lamports, but you never need to think about this.)
      amount: "0.5",
      // token: Which token to send. "SOL" for native Solana currency.
      // For SPL tokens (e.g., USDC), use the token's mint address instead.
      token: "SOL",
    },
    metadata: {
      // reason: Stored in the audit log for context. Explains why this payment was made.
      reason: "Payment for completed task",
      // agentId: Identifies which agent initiated this request.
      // Used for per-agent circuit breaker isolation and audit trail filtering.
      agentId: "trading-bot-01",
    },
  });

  // ── 9. Log the result ───────────────────────────────────────────────────
  // TransactionResult is a discriminated union with four possible statuses:
  //   "confirmed" -- transaction was broadcast and confirmed on-chain
  //   "denied"    -- policy engine rejected the transaction (with reason)
  //   "failed"    -- transaction failed during build, sign, or broadcast
  //   "pending"   -- awaiting human approval (ApprovalGateRule triggered)
  console.log("Transaction result:", {
    status: result.status,     // The outcome of the pipeline
    txId: result.txId,         // Solana transaction signature (only if broadcast succeeded)
    summary: result.summary,   // Human-readable description of what happened
    intentId: result.intentId, // Unique ID assigned to this intent (UUID v4)
  });

  // ── 10. Check the wallet's policy summary ───────────────────────────────
  // getPolicy() returns a human-readable summary of the active policy,
  // including all configured limits, allowlists, and thresholds.
  // This is the same information exposed to the AI agent via wallet_get_policy.
  const policySummary = await wallet.getPolicy();
  console.log("Policy summary:", JSON.stringify(policySummary, null, 2));

  // ── 11. View transaction history ────────────────────────────────────────
  // getTransactionHistory(n) retrieves the last n entries from the audit log.
  // Each entry includes: status, summary, timestamp, txId, intentId, and
  // the per-rule policy evaluation results.
  const history = await wallet.getTransactionHistory(5);
  console.log("Recent transactions:", history.length);
}

// Run the async main function and catch any unhandled errors.
// In production, you'd integrate this into your Express/Fastify/Hono server
// rather than running as a standalone script.
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
