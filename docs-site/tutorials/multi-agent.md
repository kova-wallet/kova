# Multi-Agent Wallet Architecture

---

## What You'll Build

In this tutorial, you'll set up **multiple AI agents**, each with its own wallet, policy, and signer, sharing a single persistent store and chain adapter. By the end you will have:

- A **Trading Agent** with a 10 SOL daily limit and access to Jupiter/Orca swap programs
- A **Payments Agent** with a 2 SOL daily limit restricted to SOL transfers
- A **Supervisor** that monitors both agents via the shared audit log

This pattern is for teams running multiple autonomous agents in production where each agent needs different permissions but you want centralized observability.

---

## Prerequisites

| Tool | Minimum Version | Check with |
|------|----------------|------------|
| **Node.js** | 18.0 or later | `node --version` |
| **npm** | 9.0 or later | `npm --version` |
| **TypeScript** | 5.0 or later | `npx tsc --version` |

You should have completed the [Your First Agent Wallet](/tutorials/first-wallet) tutorial and understand the core components (signer, store, chain adapter, policy engine).

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                    Shared Layer                      │
│                                                      │
│   ┌──────────────┐         ┌──────────────────┐     │
│   │ SqliteStore   │         │  SolanaAdapter   │     │
│   │ (shared DB)   │         │  (shared RPC)    │     │
│   └──────┬───────┘         └────────┬─────────┘     │
│          │                          │                │
├──────────┼──────────────────────────┼────────────────┤
│          │                          │                │
│   ┌──────┴──────────────────────────┴──────┐         │
│   │                                        │         │
│   ▼                                        ▼         │
│ ┌─────────────────┐         ┌─────────────────┐     │
│ │  Trading Agent   │         │ Payments Agent   │     │
│ │                  │         │                  │     │
│ │ Signer: keypair1 │         │ Signer: keypair2 │     │
│ │ Policy: 10 SOL/d │         │ Policy: 2 SOL/d  │     │
│ │ Swap + Transfer  │         │ Transfer only    │     │
│ │ Prefix: "trade:" │         │ Prefix: "pay:"   │     │
│ └─────────────────┘         └─────────────────┘     │
│                                                      │
├──────────────────────────────────────────────────────┤
│                    Supervisor                        │
│                                                      │
│   Reads audit logs from both agents via the store    │
│   Monitors spending, alerts on anomalies             │
└──────────────────────────────────────────────────────┘
```

**Key design decisions:**

- **Shared `SqliteStore`**: Both agents write to the same database. Key prefixes (`trade:`, `pay:`) keep their spending counters, rate limits, and audit logs separate.
- **Shared `SolanaAdapter`**: One RPC connection serves all agents. Chain adapters are stateless and safe to share.
- **Separate signers**: Each agent has its own keypair. The trading agent cannot sign with the payments agent's key, and vice versa.
- **Separate policies**: Each agent has its own `PolicyEngine` with different rules. The trading agent can swap; the payments agent cannot.

---

## Step 1: Set Up the Shared Infrastructure

These components are created once and shared across all agents.

```typescript
import {
  AgentWallet,
  LocalSigner,
  SqliteStore,
  SolanaAdapter,
  PolicyEngine,
  Policy,
  SpendingLimitRule,
  RateLimitRule,
  AllowlistRule,
  AuditLogger,
} from "@kova-sdk/wallet";
import { Keypair } from "@solana/web3.js";

// ── Shared Store ────────────────────────────────────────────────────────────
// A single SQLite database file holds state for ALL agents.
// Each agent's data is separated by key prefixes (configured per wallet).
const store = new SqliteStore({ path: "./multi-agent.db" });

// ── Shared Chain Adapter ────────────────────────────────────────────────────
// One RPC connection to Solana. Chain adapters are stateless —
// multiple wallets can share the same adapter safely.
const chain = new SolanaAdapter({
  rpcUrl: "https://api.devnet.solana.com",
  commitment: "confirmed",
});
```

::: tip WHY SHARE THE STORE?
Sharing a single `SqliteStore` means one database file, one backup strategy, and one place to query for audit logs across all agents. The alternative -- one store per agent -- works too, but makes centralized monitoring harder. The key prefix pattern gives you isolation without separate databases.
:::

---

## Step 2: Create the Trading Agent

The trading agent can execute swaps on Jupiter and Orca and transfer SOL, with a 10 SOL daily budget.

```typescript
// ── Trading Agent ───────────────────────────────────────────────────────────

// Each agent gets its own keypair. In production, load these from
// separate environment variables or a secrets manager.
const tradingKeypair = Keypair.generate();
const tradingSigner = new LocalSigner(tradingKeypair); // Dev-only; throws in production unless KOVA_ALLOW_LOCAL_SIGNER=1

// Build the trading policy: generous limits, program-restricted swaps.
const tradingPolicy = Policy.create("trading-agent")
  .spendingLimit({
    perTransaction: { amount: "5", token: "SOL" },
    daily: { amount: "10", token: "SOL" },
  })
  .rateLimit({
    maxTransactionsPerMinute: 20,
  })
  .build();

const tradingConfig = tradingPolicy.toJSON();
const tradingRules = [
  new RateLimitRule(tradingConfig.rateLimit!),
  // Allow swaps only through Jupiter and Orca programs.
  new AllowlistRule({
    allowPrograms: [
      "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", // Jupiter v6
      "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", // Orca Whirlpool
    ],
  }),
  new SpendingLimitRule(tradingConfig.spendingLimit!),
];

const tradingEngine = new PolicyEngine(tradingRules, store);
const tradingLogger = new AuditLogger(store);

const tradingWallet = new AgentWallet({
  signer: tradingSigner,
  chain,
  policy: tradingEngine,
  store,
  logger: tradingLogger,
  // Key prefix isolates this agent's counters and logs in the shared store.
  // All keys written by this wallet will be prefixed with "trade:"
  // e.g., "trade:spending:daily:SOL", "trade:audit:log"
  storePrefix: "trade:",
});
```

---

## Step 3: Create the Payments Agent

The payments agent can only send SOL transfers to a pre-approved list of addresses, with a tight 2 SOL daily budget.

```typescript
// ── Payments Agent ──────────────────────────────────────────────────────────

const paymentsKeypair = Keypair.generate();
const paymentsSigner = new LocalSigner(paymentsKeypair); // Dev-only; throws in production unless KOVA_ALLOW_LOCAL_SIGNER=1

// Build the payments policy: conservative limits, address-restricted.
const paymentsPolicy = Policy.create("payments-agent")
  .spendingLimit({
    perTransaction: { amount: "0.5", token: "SOL" },
    daily: { amount: "2", token: "SOL" },
  })
  .rateLimit({
    maxTransactionsPerMinute: 5,
  })
  .build();

const paymentsConfig = paymentsPolicy.toJSON();
const paymentsRules = [
  new RateLimitRule(paymentsConfig.rateLimit!),
  // Only allow transfers to pre-approved recipient addresses.
  new AllowlistRule({
    allowAddresses: [
      "RecipientAddr111111111111111111111",
      "RecipientAddr222222222222222222222",
      "RecipientAddr333333333333333333333",
    ],
  }),
  new SpendingLimitRule(paymentsConfig.spendingLimit!),
];

const paymentsEngine = new PolicyEngine(paymentsRules, store);
const paymentsLogger = new AuditLogger(store);

const paymentsWallet = new AgentWallet({
  signer: paymentsSigner,
  chain,
  policy: paymentsEngine,
  store,
  logger: paymentsLogger,
  // Different prefix -- keeps this agent's data separate from the trading agent.
  storePrefix: "pay:",
});
```

---

## Step 4: Use Each Wallet Independently

Each wallet is a self-contained `AgentWallet` instance. Your AI agents interact with them exactly like a single-agent setup.

```typescript
async function main() {
  // ── Trading Agent executes a swap ───────────────────────────────────────
  console.log("Trading agent address:", await tradingWallet.getAddress());

  const swapResult = await tradingWallet.execute({
    type: "swap",
    chain: "solana",
    params: {
      fromToken: "SOL",
      toToken: "USDC",
      amount: "2.0",
      maxSlippage: 0.01,
    },
    metadata: { agentId: "trading-agent", reason: "Rebalancing portfolio" },
  });
  console.log("Swap result:", swapResult.status);

  // ── Payments Agent executes a transfer ──────────────────────────────────
  console.log("Payments agent address:", await paymentsWallet.getAddress());

  const payResult = await paymentsWallet.execute({
    type: "transfer",
    chain: "solana",
    params: {
      to: "RecipientAddr111111111111111111111",
      amount: "0.25",
      token: "SOL",
    },
    metadata: { agentId: "payments-agent", reason: "Invoice #1042 payment" },
  });
  console.log("Payment result:", payResult.status);

  // ── Verify policy isolation ─────────────────────────────────────────────
  // The payments agent should NOT be able to swap.
  const deniedSwap = await paymentsWallet.execute({
    type: "swap",
    chain: "solana",
    params: {
      fromToken: "SOL",
      toToken: "USDC",
      amount: "1.0",
    },
    metadata: { agentId: "payments-agent" },
  });
  console.log("Payments agent swap attempt:", deniedSwap.status);
  // Expected: "denied" (no swap programs in the payments allowlist)
}
```

---

## Step 5: Build a Supervisor

The supervisor reads audit logs from both agents through the shared store. It does not execute transactions -- it only monitors.

```typescript
async function supervisorReport() {
  console.log("\n═══ Supervisor Report ═══\n");

  // Read each agent's recent transaction history.
  // The key prefix separates the logs: "trade:audit:log" vs "pay:audit:log"
  const tradingHistory = await tradingWallet.getTransactionHistory(20);
  const paymentsHistory = await paymentsWallet.getTransactionHistory(20);

  console.log(`Trading agent: ${tradingHistory.length} recent transactions`);
  for (const tx of tradingHistory) {
    console.log(`  [${tx.status}] ${tx.summary}`);
  }

  console.log(`Payments agent: ${paymentsHistory.length} recent transactions`);
  for (const tx of paymentsHistory) {
    console.log(`  [${tx.status}] ${tx.summary}`);
  }

  // ── Spending summary ──────────────────────────────────────────────────
  // Read raw spending counters from the store.
  // The key format is: "<prefix>spending:daily:SOL"
  const tradingSpent = await store.get("trade:spending:daily:SOL");
  const paymentsSpent = await store.get("pay:spending:daily:SOL");

  console.log("\nDaily spending:");
  console.log(`  Trading agent:  ${tradingSpent ?? "0"} SOL / 10 SOL limit`);
  console.log(`  Payments agent: ${paymentsSpent ?? "0"} SOL / 2 SOL limit`);

  // ── Anomaly detection ─────────────────────────────────────────────────
  // Flag agents that have been denied multiple times (possible misbehavior).
  const tradingDenials = tradingHistory.filter((tx) => tx.status === "denied");
  const paymentsDenials = paymentsHistory.filter((tx) => tx.status === "denied");

  if (tradingDenials.length > 3) {
    console.warn(
      `⚠ Trading agent has ${tradingDenials.length} denials -- investigate`,
    );
  }
  if (paymentsDenials.length > 3) {
    console.warn(
      `⚠ Payments agent has ${paymentsDenials.length} denials -- investigate`,
    );
  }
}
```

---

## Step 6: Graceful Shutdown

Close the shared store when the process exits:

```typescript
async function shutdown() {
  console.log("Shutting down...");
  store.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Run everything.
main()
  .then(() => supervisorReport())
  .catch(console.error);
```

---

## Key Prefix Strategy

The `storePrefix` parameter on `AgentWallet` namespaces all store keys for that wallet. Here is how it works:

| Without prefix | With prefix `trade:` | With prefix `pay:` |
|---|---|---|
| `spending:daily:SOL` | `trade:spending:daily:SOL` | `pay:spending:daily:SOL` |
| `ratelimit:minute` | `trade:ratelimit:minute` | `pay:ratelimit:minute` |
| `audit:log` | `trade:audit:log` | `pay:audit:log` |
| `circuit:state` | `trade:circuit:state` | `pay:circuit:state` |

This means:
- Each agent's spending counters are **independent** -- the trading agent spending 5 SOL does not affect the payments agent's daily limit
- Each agent's audit log is **separate** -- you can query each agent's history independently
- The supervisor can query **both** by reading from both prefixed keys

::: warning UNIQUE PREFIXES
Make sure each agent has a unique `storePrefix`. If two agents share the same prefix, their spending counters will be combined and their audit logs will be interleaved. This could allow one agent to exhaust another's spending limit.
:::

---

## Scaling Patterns

### Adding More Agents

The pattern is the same for any number of agents. Each one gets:

```typescript
const agentN = new AgentWallet({
  signer: new LocalSigner(keypairN),    // Unique signer (Dev-only; throws in production unless KOVA_ALLOW_LOCAL_SIGNER=1)
  chain,                                 // Shared chain adapter
  policy: new PolicyEngine(rulesN, store), // Unique policy
  store,                                 // Shared store
  logger: new AuditLogger(store),        // Shared store for logs
  storePrefix: "agent-n:",                 // Unique prefix
});
```

### Using Redis for Multi-Process Deployments

If your agents run in separate processes (e.g., separate Docker containers), replace `SqliteStore` with a Redis-backed store (see the [Custom Store Adapter](/tutorials/custom-store) tutorial). Redis provides shared state across processes:

```typescript
import { RedisStore } from "./redis-store";

// All processes connect to the same Redis instance.
const store = new RedisStore("redis://redis:6379");

// Agent 1 (Process A)
const wallet1 = new AgentWallet({ ..., store, storePrefix: "agent1:" });

// Agent 2 (Process B -- different container)
const wallet2 = new AgentWallet({ ..., store, storePrefix: "agent2:" });
```

### Centralized Monitoring Dashboard

Since all agents share a store, you can build a monitoring endpoint that reads all agent state:

```typescript
// Express/Fastify route for a monitoring dashboard.
app.get("/agents/status", async (req, res) => {
  const agents = ["trade:", "pay:", "ops:"];
  const status = [];

  for (const prefix of agents) {
    const dailySpent = await store.get(`${prefix}spending:daily:SOL`);
    const recentLogs = await store.get(`${prefix}audit:log`);

    status.push({
      agent: prefix.replace(":", ""),
      dailySpentSOL: parseFloat(dailySpent ?? "0"),
      // Add more metrics as needed
    });
  }

  res.json({ agents: status, timestamp: new Date().toISOString() });
});
```

---

## Common Mistakes

| Mistake | What happens | Fix |
|---------|-------------|-----|
| Same `storePrefix` for two agents | Spending counters collide -- one agent can exhaust the other's limit | Use unique prefixes per agent |
| Forgetting `storePrefix` entirely | All agents share the default (empty) prefix -- same as above | Always set `storePrefix` when running multiple agents |
| Creating separate `SolanaAdapter` instances | Wastes RPC connections, may hit rate limits faster | Share a single adapter instance |
| Using `MemoryStore` with multiple agents | State is lost on restart, limits reset | Use `SqliteStore` or a custom persistent store |

---

## See Also

- [Your First Agent Wallet](/tutorials/first-wallet) -- single-agent setup
- [Custom Store Adapter](/tutorials/custom-store) -- build a Redis store for multi-process deployments
- [Production Deployment](/tutorials/production) -- hardening, monitoring, and shutdown patterns
- [Policy Cookbook](/tutorials/policy-cookbook) -- policy configurations for different agent personas
- [Audit Logging](/guide/audit-logging) -- understanding the tamper-evident log system
