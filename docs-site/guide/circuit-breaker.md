# Circuit Breaker

The circuit breaker prevents runaway agent behavior by blocking all transactions after a threshold of consecutive policy denials. If an agent keeps attempting actions that violate policy, the circuit breaker trips and forces a cooldown period before any new transactions can be submitted.

## Purpose

Without a circuit breaker, a malfunctioning or adversarial agent could flood the wallet with denied transactions indefinitely. Even though the policy engine correctly blocks each one, the repeated attempts waste resources, generate noise in the audit log, and may indicate a compromised agent.

The circuit breaker adds a hard stop: after N consecutive denials, all transactions are blocked for a cooldown period. This gives operators time to investigate and prevents the agent from consuming unbounded compute and store operations.

## Configuration

The `CircuitBreakerConfig` interface controls the breaker's behavior:

```typescript
// Configuration for the transaction circuit breaker.
// These settings determine how quickly the breaker trips and how long
// it stays open before auto-resetting.
interface CircuitBreakerConfig {
  /** Number of consecutive denials before circuit opens. Must be >= 1. Default: 5 */
  // If the agent receives this many DENY decisions in a row (without any
  // ALLOW in between), the circuit opens and blocks all further transactions.
  // Lower values are more aggressive (trip faster), higher values are more lenient.
  threshold: number;
  /** Cooldown period in milliseconds. Must be >= 0. Default: 300_000 (5 min) */
  // How long the circuit stays open (blocking all transactions) before
  // automatically resetting to closed. This gives operators time to investigate.
  cooldownMs: number;
}
```

| Parameter | Default | Description |
|---|---|---|
| `threshold` | `5` | Number of consecutive `DENY` decisions before the circuit opens |
| `cooldownMs` | `300000` (5 min) | How long the circuit stays open before auto-resetting |

## State Machine

The circuit breaker has two states:

```
              threshold reached
  Closed ────────────────────────> Open
  (normal)                         (blocking)
     ^                                |
     |      cooldown expires          |
     +────────────────────────────────+
```

**Closed (normal operation):** Transactions flow through the policy engine normally. The breaker tracks consecutive denials.

**Open (blocking):** All transactions are immediately rejected with a `CIRCUIT_BREAKER_OPEN` error code. No policy evaluation occurs. After the cooldown expires, the breaker automatically resets to Closed.

## How Tracking Works

After each policy evaluation, the wallet records the outcome with the circuit breaker:

| Outcome | Effect |
|---|---|
| `ALLOW` | Resets the denial counter to 0. A successful transaction proves the agent is behaving correctly. |
| `DENY` | Increments the denial counter. If the counter reaches the threshold, the circuit opens and the cooldown timer starts. |
| `PENDING` | No-op. A pending approval is neither a success nor a failure -- the agent is waiting for a human. |

```typescript
// Internal wallet flow (simplified) -- shows how the circuit breaker
// integrates into the AgentWallet's transaction execution pipeline.

// First, evaluate the transaction intent against all policy rules.
const evaluationResult = await this.policy.evaluate(intent);
// Extract the aggregate decision (ALLOW, DENY, or PENDING).
const decision = evaluationResult.decision;

// If a circuit breaker is configured, record the policy outcome.
if (this.circuitBreaker) {
  await this.circuitBreaker.recordOutcome(decision.decision);
  // "ALLOW" → resets the consecutive denial counter to 0
  // "DENY"  → increments the counter; if counter >= threshold, opens the circuit
  // "PENDING" → no change to the counter (waiting for human approval)
}
```

## Store Keys

The circuit breaker persists its state using two store keys:

| Key | Value | Description |
|---|---|---|
| `circuit:denial_count` | `"0"`, `"1"`, `"2"`, ... | Current consecutive denial count |
| `circuit:cooldown_until` | `"1700000300000"` | Unix timestamp (ms) when the cooldown expires |

This means the circuit breaker state survives process restarts (as long as the store is persistent). If you use `MemoryStore`, the state is lost on restart and the breaker resets.

## Configuring via AgentWallet

The simplest way to configure the circuit breaker is through the `AgentWallet` constructor:

```typescript
// Import all the components needed to set up a wallet with a custom circuit breaker.
import {
  AgentWallet,        // The main wallet class
  PolicyEngine,       // Evaluates policy rules against transaction intents
  SpendingLimitRule,  // Policy rule that caps how much the agent can spend
  MemoryStore,        // In-memory persistence (use SqliteStore in production)
  LocalSigner,        // In-memory signer for development
  SolanaAdapter,      // Solana blockchain adapter
} from "kova";

// Create a shared store for the SDK to persist state.
const store = new MemoryStore();
// Create a signer from the wallet's private key.
const signer = new LocalSigner({ privateKey: process.env.WALLET_PRIVATE_KEY! });
// Create a Solana adapter connected to the configured RPC endpoint.
const chain = new SolanaAdapter({ rpcUrl: process.env.SOLANA_RPC_URL! });

// Define the policy rules -- here, a per-transaction spending limit of 10 SOL.
const rules = [
  new SpendingLimitRule({
    perTransaction: { amount: "10", token: "SOL" },
  }),
];
// Create the policy engine with the rules and the shared store.
const engine = new PolicyEngine(rules, store);

// Custom circuit breaker: trip after 3 consecutive denials, with a 60-second cooldown.
// This is more aggressive than the default (5 denials, 5-minute cooldown),
// meaning the wallet locks faster but also recovers faster.
const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  circuitBreaker: { threshold: 3, cooldownMs: 60_000 }, // Custom circuit breaker config
});
```

If you omit the `circuitBreaker` option, the default configuration is used (`threshold: 5`, `cooldownMs: 300000`).

## Disabling the Circuit Breaker

You can disable the circuit breaker by passing `false`:

```typescript
// Disable the circuit breaker entirely by passing false.
// Without a circuit breaker, the agent can attempt unlimited denied
// transactions without being blocked. Only do this if you have
// alternative safeguards in place (e.g., external rate limiting).
const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  circuitBreaker: false, // No circuit breaker -- agent is never auto-blocked
});
```

::: danger
Disabling the circuit breaker removes the safety net against runaway agents. Without it, an agent can attempt unlimited denied transactions. Only disable this if you have an alternative mechanism (e.g., external rate limiting at the API layer) to prevent abuse.
:::

## Internal Management

The `CircuitBreaker` class is managed internally by `AgentWallet` and is not directly exported. Configure it via the `circuitBreaker` option in `AgentWalletConfig`:

```typescript
// The circuit breaker is configured as part of the AgentWallet constructor.
// You do not instantiate CircuitBreaker directly -- the wallet creates it
// internally based on this configuration.
const wallet = new AgentWallet({
  signer,
  chain,
  policy: engine,
  store,
  circuitBreaker: { threshold: 3, cooldownMs: 60_000 },
});
```

The circuit breaker state is visible through `wallet_get_policy`:

```typescript
// Use the wallet_get_policy tool call to inspect the circuit breaker status.
// This is useful for agents to check if the circuit breaker is currently tripped
// before attempting a transaction.
const result = await wallet.handleToolCall("wallet_get_policy", {});
// result.data.circuitBreaker contains the current state:
// {
//   threshold: 3,         -- Configured threshold
//   cooldownMs: 60000,    -- Configured cooldown duration
//   isOpen: false          -- Whether the breaker is currently tripped
// }
```

::: info
The circuit breaker resets automatically after the cooldown period expires. There is no public `reset()` method -- this prevents agents from bypassing the safety mechanism.
:::
## What the Agent Sees

When the circuit breaker is open, `wallet.handleToolCall()` returns a denial:

```typescript
// This is the response the AI agent receives when the circuit breaker is open.
// The transaction is never evaluated by the policy engine -- it is immediately
// rejected by the circuit breaker check in the execution pipeline.
{
  success: false,   // Indicates the tool call did not succeed
  data: {
    status: "denied",  // The transaction was denied (not "failed" -- it never ran)
    // The summary includes the remaining cooldown time so the agent knows when to retry.
    summary: "Denied by circuit breaker: Circuit breaker open: 45s cooldown remaining after 3 consecutive denials",
    intentId: "...",           // The intent ID of the blocked transaction
    timestamp: 1700000000000,  // When the denial occurred
    error: {
      code: "CIRCUIT_BREAKER_OPEN",  // Specific error code for circuit breaker blocks
      message: "Circuit breaker open: 45s cooldown remaining after 3 consecutive denials"
    }
  },
  // Top-level error string for easy access by the AI agent.
  error: "Circuit breaker open: 45s cooldown remaining after 3 consecutive denials"
}
```

The agent receives the remaining cooldown time so it can reason about when to retry. A well-prompted agent should recognize this error and wait rather than continuing to retry.

::: tip
Include guidance in your system prompt for how the agent should handle circuit breaker errors. For example: "If you receive a CIRCUIT_BREAKER_OPEN error, stop attempting transactions and inform the user that the wallet is temporarily locked due to too many denied requests."
:::

## The `wallet_get_policy` Introspection

When a circuit breaker is configured, `wallet_get_policy` includes its status in the policy summary:

```typescript
// Query the wallet's policy configuration including circuit breaker status.
// This is exposed as a tool call so AI agents can inspect the wallet's
// current state and make informed decisions about whether to attempt transactions.
const result = await wallet.handleToolCall("wallet_get_policy", {});
// result.data includes:
// {
//   ...                    -- Other policy information (rules, spending limits, etc.)
//   circuitBreaker: {
//     threshold: 3,        -- How many consecutive denials before the circuit opens
//     cooldownMs: 60000,   -- How long (ms) the circuit stays open before auto-reset
//     isOpen: false         -- false = circuit is closed (normal), true = blocking all transactions
//   }
// }
```

This allows agents to check whether the circuit breaker is active before attempting a transaction.

## Difference from Audit Circuit Breaker

kova has **two** circuit breakers that serve different purposes:

| | Transaction Circuit Breaker | Audit Circuit Breaker |
|---|---|---|
| **Class** | `CircuitBreaker` | Built into `AuditLogger` |
| **Trigger** | Consecutive policy denials | Consecutive audit write failures |
| **Purpose** | Stop runaway agent behavior | Protect audit trail integrity |
| **Default threshold** | 5 consecutive denials | 3 consecutive failures |
| **Cooldown** | Configurable (`cooldownMs`) | None -- stays open until `resetFailureCount()` |
| **Auto-reset** | Yes, after cooldown expires | No -- requires manual reset |
| **Error code** | `CIRCUIT_BREAKER_OPEN` | `STORE_ERROR` |
| **Can disable** | Yes (`circuitBreaker: false`) | No (always active) |
| **Checked** | After audit check, before policy | Before circuit breaker, before policy |

::: warning
The audit circuit breaker takes priority. If audit logging is down, transactions are blocked regardless of the transaction circuit breaker state. The execution order is: audit check, then transaction circuit breaker check, then policy evaluation.
:::

Both breakers appear in the wallet's execution pipeline:

```
intent → validate → normalize → AUDIT CHECK → CIRCUIT BREAKER → policy → build → sign → broadcast → log → result
```

For more on the audit circuit breaker, see [Audit Logging](./audit-logging.md).
